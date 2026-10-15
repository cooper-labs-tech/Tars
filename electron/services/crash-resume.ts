import * as fs from 'fs';
import type { PreviousRun } from './run-state';
import { envelopeValue } from '../utils/envelope-value';

/**
 * After Tars stopped abruptly, the agents that were working are resumed with a
 * note, and the agents at rest stay asleep until something needs them
 * (RD-REDEMARRAGE.md, 2.2; approved by JeanBrasse on 2026-10-05).
 *
 * Nothing is replayed: an agent is started on its own conversation (the launch
 * resumes its session) with the note as its first prompt, and its last request
 * is not sent again. Claude Code marks a tool call the crash cut as of unknown
 * outcome by itself, measured on 2.1.286; the note says why, what went with
 * Tars, and to check before redoing anything.
 */

export type TurnCut =
  | { kind: 'tool'; tool: string }
  | { kind: 'no-reply' }
  | { kind: 'recorded' }
  | { kind: 'unknown' };

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string };

/**
 * How the transcript's last turn ended: a tool call with no result, a prompt
 * or a tool result with no reply after it, or a reply written last. The last
 * line may be half written, as a crash leaves it: it is skipped.
 */
export function turnCutOf(file: string | undefined): TurnCut {
  if (!file) return { kind: 'unknown' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { kind: 'unknown' };
  }
  const open = new Map<string, string>();
  let last: 'prompt' | 'result' | 'tool' | 'reply' | null = null;
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(text);
    } catch {
      continue;
    }
    const content = entry.message?.content;
    const blocks: Block[] = Array.isArray(content) ? content as Block[] : [];
    if (entry.type === 'user') {
      const results = blocks.filter((b) => b?.type === 'tool_result');
      for (const r of results) if (r.tool_use_id) open.delete(r.tool_use_id);
      last = results.length > 0 ? 'result' : (typeof content === 'string' || blocks.length > 0 ? 'prompt' : last);
    } else if (entry.type === 'assistant') {
      const uses = blocks.filter((b) => b?.type === 'tool_use' && typeof b.id === 'string');
      for (const u of uses) open.set(u.id!, typeof u.name === 'string' ? u.name : 'a tool');
      last = uses.length > 0 ? 'tool' : 'reply';
    }
  }
  if (open.size > 0) return { kind: 'tool', tool: [...open.values()].at(-1)! };
  if (last === 'prompt' || last === 'result') return { kind: 'no-reply' };
  if (last) return { kind: 'recorded' };
  return { kind: 'unknown' };
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** One line, in Tars's words: never the task's own. */
export function resumeNote(input: {
  stoppedAt: number;
  cut: TurnCut;
  tmpDir?: string;
  delegations: Array<{ name: string; resumed: boolean }>;
}): string {
  const cut = input.cut.kind === 'tool'
    ? `Your last turn was cut while ${envelopeValue(input.cut.tool)} was running: its outcome is unknown.`
    : input.cut.kind === 'no-reply'
      ? 'Your last turn was cut before its reply was written.'
      : input.cut.kind === 'recorded'
        ? 'Your last reply was written, but Tars did not see your turn end.'
        : 'Tars could not read how your last turn ended.';
  const parts = [
    `[Tars] Tars stopped abruptly at ${clock(input.stoppedAt)} (it was not quit) and has started again, resuming your conversation.`,
    cut,
    'Nothing of that turn is sent again.',
    'Background tasks you had running were stopped with Tars.',
    input.tmpDir ? `Your temporary folder is intact: ${input.tmpDir}.` : '',
    'Before you go on, check where things stand (git status, the files, the PRs, the board), and do not redo a step without checking whether it already took effect.',
  ];
  if (input.delegations.length > 0) {
    const list = input.delegations.map((d) => `${envelopeValue(d.name)} (${d.resumed ? 'resumed too' : 'at rest'})`).join(', ');
    parts.push(`You had handed work to ${list}: ask each with get_agent where it stands before you hand anything again.`);
  }
  return parts.filter(Boolean).join(' ');
}

export interface ResumeAgent {
  id: string;
  name?: string;
  status: string;
  ptyId?: string;
  projectPath: string;
  pathMissing?: boolean;
  requestedBy?: { agentId: string; ptyId: string; backgroundLeft?: string[] };
}

export interface ResumeDeps {
  agent: (id: string) => ResumeAgent | undefined;
  /** Every agent of the fleet, to find who had handed work to whom. */
  fleet?: () => Iterable<ResumeAgent>;
  cliRunning: (agent: ResumeAgent) => boolean;
  /** Starts the agent's CLI on its own conversation, with the note as its first prompt. */
  launch: (agentId: string, note: string) => Promise<{ success: boolean; error?: string }>;
  /** Types the note into a session already up (the Dashboard started it first). */
  typeNote: (agentId: string, note: string) => Promise<boolean>;
  /** Resolves once the launch's session is up, or false past the bound. */
  sessionUp: (agentId: string, ms: number) => Promise<boolean>;
  transcriptOf: (agent: ResumeAgent, sessionId?: string) => string | undefined;
  tmpDirOf: (agentId: string) => string | undefined;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface ResumeOutcome {
  agentId: string;
  how: 'launched' | 'typed' | 'skipped' | 'failed';
  why?: string;
}

/** How long one resume holds its slot waiting for its session. */
const SESSION_UP_MS = 180_000;

export async function resumeInterrupted(previous: PreviousRun, deps: ResumeDeps): Promise<ResumeOutcome[]> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (previous.resumedAndCrashedAgain) {
    log('[resume] Tars stopped again within two minutes of resuming its agents: nobody is resumed this time, to break the loop');
    return previous.working.map((w) => ({ agentId: w.agentId, how: 'skipped' as const, why: 'Tars stopped again right after resuming it' }));
  }

  const workingIds = new Set(previous.working.map((w) => w.agentId));
  const fleet = deps.fleet ? [...deps.fleet()] : previous.working.map((w) => deps.agent(w.agentId)).filter((a): a is ResumeAgent => !!a);
  const outcomes: ResumeOutcome[] = new Array(previous.working.length);

  const one = async (index: number): Promise<void> => {
    const record = previous.working[index];
    const agent = deps.agent(record.agentId);
    const skip = (why: string) => {
      log(`[resume] ${record.agentId}: not resumed, ${why}`);
      outcomes[index] = { agentId: record.agentId, how: 'skipped', why };
    };
    if (!agent) return skip('it was deleted since');
    if (agent.status === 'stopped') return skip('it was stopped since');
    if (agent.pathMissing) return skip('its folder is gone');

    const handedTo = fleet.filter((a) => a.requestedBy?.agentId === agent.id && a.id !== agent.id);
    const note = resumeNote({
      stoppedAt: previous.lastWriteAt,
      cut: turnCutOf(deps.transcriptOf(agent, record.sessionId)),
      tmpDir: deps.tmpDirOf(agent.id),
      delegations: handedTo.map((a) => ({ name: a.name || a.id, resumed: workingIds.has(a.id) })),
    });

    if (deps.cliRunning(agent)) {
      const up = await deps.sessionUp(agent.id, SESSION_UP_MS);
      const typed = up && await deps.typeNote(agent.id, note);
      outcomes[index] = typed ? { agentId: agent.id, how: 'typed' } : { agentId: agent.id, how: 'failed', why: 'its session did not take the note' };
      log(`[resume] ${agent.id}: already running again, ${typed ? 'the note typed in its session' : 'the note could not be typed'}`);
      return;
    }

    let result: { success: boolean; error?: string };
    try {
      result = await deps.launch(agent.id, note);
    } catch (err) {
      result = { success: false, error: (err as Error).message };
    }
    if (!result.success) {
      log(`[resume] ${agent.id}: could not be resumed: ${result.error ?? 'the launch failed'}`);
      outcomes[index] = { agentId: agent.id, how: 'failed', why: result.error ?? 'the launch failed' };
      return;
    }
    // The work it was handed is the work it resumes: bound to the terminal it
    // runs in now, its end reaches whoever handed it over (agent-watch).
    if (agent.requestedBy && agent.ptyId) agent.requestedBy = { ...agent.requestedBy, ptyId: agent.ptyId };
    log(`[resume] ${agent.id}: resumed with the note`);
    outcomes[index] = { agentId: agent.id, how: 'launched' };
    await deps.sessionUp(agent.id, SESSION_UP_MS);
  };

  let next = 0;
  const lane = async () => {
    while (next < previous.working.length) {
      const index = next++;
      await one(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 3, previous.working.length) }, lane));
  return outcomes;
}
