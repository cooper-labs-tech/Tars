import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import * as path from 'path';
import { encodeProjectDirName, transcriptPath, transcriptRoots } from '../utils/resume-session';
import { QWEN_PROVIDER_ID, qwenTranscriptPath } from './qwen-code';

/**
 * The answer delegate_task returns for a task typed into an agent's permanent
 * terminal (2.0.4): the agent's report for that task (reportOf), read from the
 * transcript Claude Code keeps (~/.claude/projects/<project>/<session>.jsonl),
 * in full. The hooks' copy of it (lastCleanOutput) is cut at 4000 bytes.
 *
 * Claude Code writes one record per content block, every block of one message
 * under the same message id: the final message is the last assistant message
 * with text in the task's time, and its text is all of its text blocks, in
 * order. A subagent's records (isSidechain) and Tars's injected context
 * (isMeta) are not the agent's answer.
 */

/** Slack after the end the ledger heard of: the Stop's post is made after the CLI wrote the record. */
const END_SLACK_MS = 2_000;
/** What an answer keeps: a million characters, far past any final message, under the API's 4 MB body. */
export const ANSWER_MAX = 1_000_000;

type Window = { since: number; until: number };

/**
 * A task's answer from the messages the agent wrote in it, in order: its report, the longest of them (the later of
 * two as long), and every message after it, a blank line between (the DB brief fix-answer-per-task-2810.md). The last
 * message alone was the answer until 2.0.5, and a memory note or a closing line written after the report replaced it:
 * the asker read "Saving the durable lessons to memory" where the report was (1212's orchestrator, 28/10). What comes
 * before the report (narration) stays out. Past ANSWER_MAX characters, cut, and the cut said. One rule for every CLI
 * Tars reads an answer from: Claude Code's and Qwen Code's transcripts here, codex's and pi's session logs.
 */
export function reportOf(messages: readonly string[]): string | null {
  const said = messages.filter((m) => m.trim());
  if (!said.length) return null;
  let at = 0;
  for (let i = 1; i < said.length; i++) if (Array.from(said[i]).length >= Array.from(said[at]).length) at = i;
  const whole = Array.from(said.slice(at).join('\n\n'));
  return whole.length <= ANSWER_MAX ? whole.join('') : `${whole.slice(0, ANSWER_MAX).join('')}\n[cut at ${ANSWER_MAX} of ${whole.length} characters]`;
}

/**
 * How a turn's records say it ended, as Claude Code writes them: every record of a message carries that message's
 * stop reason once it is whole (measured on 2.1.326: `tool_use` on each record of a message that calls a tool,
 * `end_turn` on each of the last one's), and the turn's end writes `stop_hook_summary` and `turn_duration`.
 */
const FINAL_STOPS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal']);
const TURN_END_MARKS = new Set(['stop_hook_summary', 'turn_duration']);

/** Reads lines one by one, keeping the task's messages in order, each message's text blocks joined. */
function answerReader(window: Window) {
  let id: string | null = null;
  let parts: string[] = [];
  const messages: string[] = [];
  /** Whether the last record read says the turn is over ('ended'), goes on ('open'), or says nothing. */
  let end: 'ended' | 'open' | 'unknown' = 'unknown';
  let sawStops = false;
  return {
    line(line: string): void {
      if (!line.includes('"assistant"') && !line.includes('"stop_hook_summary"') && !line.includes('"turn_duration"')) return;
      let rec: { type?: unknown; subtype?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; uuid?: unknown; message?: { id?: unknown; content?: unknown; parts?: unknown; stop_reason?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (rec.isSidechain === true) return;
      const at = Date.parse(String(rec.timestamp ?? ''));
      if (!Number.isFinite(at) || at < window.since || at > window.until) return;
      if (rec.type === 'system' && TURN_END_MARKS.has(String(rec.subtype))) {
        end = 'ended';
        return;
      }
      if (rec.type !== 'assistant' || rec.isMeta === true) return;
      const stop = rec.message?.stop_reason;
      if (typeof stop === 'string') {
        sawStops = true;
        end = FINAL_STOPS.has(stop) ? 'ended' : 'open';
      } else if (sawStops) {
        end = 'open';
      }
      const content = Array.isArray(rec.message?.content) ? rec.message.content as Array<{ type?: unknown; text?: unknown }> : [];
      // Qwen Code writes `parts` (Gemini's shape), a part of thinking marked `thought`.
      const qwenParts = Array.isArray(rec.message?.parts) ? rec.message.parts as Array<{ text?: unknown; thought?: unknown }> : [];
      const texts = [
        ...content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text as string),
        ...qwenParts.filter((b) => b && b.thought !== true && typeof b.text === 'string' && b.text.trim()).map((b) => b.text as string),
      ];
      if (!texts.length) return;
      const messageId = typeof rec.message?.id === 'string' ? rec.message.id : typeof rec.uuid === 'string' ? rec.uuid : null;
      if (messageId === null || messageId !== id) {
        if (parts.length) messages.push(parts.join('\n\n'));
        id = messageId;
        parts = [];
      }
      parts.push(...texts);
    },
    answer(): string | null {
      return reportOf(parts.length ? [...messages, parts.join('\n\n')] : messages);
    },
    /** The last message the turn wrote, its text blocks joined, or null. */
    lastMessage(): string | null {
      return parts.length ? parts.join('\n\n') : messages.at(-1) ?? null;
    },
    /** What the records read say of the turn's end. */
    end(): 'ended' | 'open' | 'unknown' {
      return end;
    },
  };
}

/** The final answer in these transcript lines, between `since` and `until` (epoch ms), or null. */
export function finalAnswerOf(lines: Iterable<string>, window: Window): string | null {
  const reader = answerReader(window);
  for (const line of lines) reader.line(line);
  return reader.answer();
}

type TurnRead = { answer: string | null; last: string | null; end: 'ended' | 'open' | 'unknown' };

/** One transcript, streamed: only the answer is kept, never a line of it. */
async function readInFile(file: string, window: Window): Promise<TurnRead | null> {
  if (!fs.existsSync(file)) return null;
  const reader = answerReader(window);
  const input = fs.createReadStream(file, { encoding: 'utf-8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) reader.line(line);
  } catch {
    /* what was read stands */
  } finally {
    lines.close();
    input.destroy();
  }
  return { answer: reader.answer(), last: reader.lastMessage(), end: reader.end() };
}

/**
 * The final answer of a terminal task, from its sessions' transcripts, the
 * latest session that answered first; null when none is there to read (a CLI
 * that writes no such transcript, a session never written). `configDir` is
 * the CLAUDE_CONFIG_DIR its CLI ran with (a Claude account after the first),
 * which keeps its transcripts under projects/ instead of ~/.claude.
 */
export type AnswerTask = {
  sessionIds: string[]; projectPath: string | null; worktreePath: string | null; startedAt: number; endedAt: number | null;
  configDir?: string; provider?: string | null;
};

/** The task's turn, read from its sessions' transcripts, the latest session that answered first; null when none is there. */
async function readTurn(task: AnswerTask, homeDir: string): Promise<TurnRead | null> {
  const window = { since: task.startedAt, until: (task.endedAt ?? Date.now()) + END_SLACK_MS };
  const roots = transcriptRoots(task.worktreePath ?? undefined, task.projectPath ?? undefined);
  for (const sessionId of [...task.sessionIds].reverse()) {
    for (const root of roots) {
      const files = task.provider === QWEN_PROVIDER_ID ? [qwenTranscriptPath(root, sessionId, homeDir)] : [
        ...(task.configDir ? [path.join(task.configDir, 'projects', encodeProjectDirName(root), `${sessionId}.jsonl`)] : []),
        transcriptPath(root, sessionId, homeDir),
      ];
      for (const file of files) {
        const read = await readInFile(file, window);
        if (read && read.answer !== null) return read;
      }
    }
  }
  return null;
}

export async function readFinalAnswer(task: AnswerTask, homeDir = os.homedir()): Promise<string | null> {
  return (await readTurn(task, homeDir))?.answer ?? null;
}

/** How long a turn's answer is waited for once its end was heard: past the 634 ms the slowest of 27 measured took. */
export const ANSWER_SETTLE_MS = 3_000;
const ANSWER_STEP_MS = 100;

/** Text as compared with the hooks' copy of a message: its spaces folded. */
const folded = (text: string) => text.replace(/\s+/g, ' ').trim();
/** How much of the hooks' copy is compared: its start, which a cut copy (4000 bytes, a character cut) keeps. */
const SAID_COMPARED = 200;

/**
 * A turn's answer, once the transcript holds the turn's end (2.0.7). Claude Code writes its last message to the
 * transcript after its Stop: read at once, a turn's report was not on disk yet, and its narration was kept as the
 * answer (27 of 496 delegated tasks of three weeks on the owner's Mac, read 31 to 634 ms after the end). So a task
 * that completed is read again, every 100 ms, until its last message is the one the CLI said it ended on
 * (`lastSaid`, the Stop hook's or the state mod's copy, posted before the idle that ended it), or, with no such copy,
 * until its last record carries a final stop reason or a turn's end; at most `settleMs`, then what is there. A
 * transcript that writes no stop reason at all (Qwen Code, an older CLI) is read once, as before; so is a task that
 * stopped or failed, whose end will never be written.
 */
export async function readTurnAnswer(
  task: AnswerTask & { outcome?: string },
  opts: { lastSaid?: string; settleMs?: number; stepMs?: number; homeDir?: string } = {},
): Promise<string | null> {
  const homeDir = opts.homeDir ?? os.homedir();
  const until = Date.now() + (opts.settleMs ?? ANSWER_SETTLE_MS);
  const said = opts.lastSaid ? folded(opts.lastSaid).slice(0, SAID_COMPARED) : '';
  for (;;) {
    const read = await readTurn(task, homeDir);
    const whole = task.outcome !== 'completed'
      || (said ? !!read?.last && folded(read.last).startsWith(said) : !read || read.end !== 'open');
    if (whole || Date.now() >= until) return read?.answer ?? null;
    await new Promise((r) => setTimeout(r, opts.stepMs ?? ANSWER_STEP_MS));
  }
}
