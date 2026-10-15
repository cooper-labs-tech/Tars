import { agents } from '../core/agent-manager';
import { ptyProcesses } from '../core/pty-manager';
import { terminalText, replayText, panelSizeOf } from '../core/terminal-mirror';
import { stripAnsi } from '../utils/ansi';
import { spellingsOf, transcriptPath } from '../utils/resume-session';
import { readAgentTranscript, MAX_PAGE, type TranscriptMessage } from './agent-transcript';
import * as fs from 'fs';
import type { AgentStatus } from '../types';

/**
 * Searching across the whole fleet.
 *
 * Every agent's output lived only in its own terminal, so answering "which
 * agent hit this error" meant opening 29 terminals and scrolling. This reads
 * the retained buffers in one pass.
 *
 * Each agent is read as a terminal shows it, never as its raw stream split on
 * line breaks: Claude Code draws with cursor moves and carriage returns, and
 * the stream with its codes stripped read as one run of glued words (JeanBrasse,
 * 2026-10-01). A running agent is read from its terminal's mirror, the screen
 * it shows now; one that is not, from its kept output replayed headless.
 *
 * A Claude agent is read from its transcript first. Tars runs Claude Code full
 * screen, on the alternate screen, which keeps no history and is discarded at
 * /exit: a stopped agent replayed to its launch lines, a running one to its
 * visible rows (the Audit's gate of #274). Its terminal's lines follow, so a
 * search still finds what only the screen showed (a banner, an error, a dialog).
 */

export interface LogLine {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  status: string;
  line: string;
  /** Index within that agent's retained output, newest last. */
  position: number;
}

export interface LogSearchResult {
  lines: LogLine[];
  scannedAgents: number;
  truncated: boolean;
}

const MAX_RESULTS = 500;

/** The size a replay is made at when no panel has shown the agent: the size its terminal is spawned at. */
const REPLAY_SIZE = { cols: 120, rows: 40 };

/**
 * The last replay of each agent's kept output. Kept output only changes at its
 * ends (a chunk pushed, the oldest dropped), so it is the same output while
 * its count and the chunks at both ends are the same strings.
 */
const replays = new Map<string, { first?: string; last?: string; count: number; cols: number; rows: number; lines: string[] }>();

function replayed(agent: AgentStatus): string[] | undefined {
  const output = agent.output;
  const size = panelSizeOf(agent.id) ?? REPLAY_SIZE;
  const first = output[0];
  const last = output[output.length - 1];
  const kept = replays.get(agent.id);
  if (kept && kept.count === output.length && kept.first === first && kept.last === last
    && kept.cols === size.cols && kept.rows === size.rows) {
    return kept.lines;
  }
  const lines = replayText(output, size);
  if (lines) replays.set(agent.id, { first, last, count: output.length, ...size, lines });
  return lines;
}

/** Without xterm-headless: the stream with its codes stripped, as before, rather than nothing. */
function stripped(agent: AgentStatus): string[] {
  // Chunks split mid-line, so join before splitting.
  return stripAnsi(agent.output.join(''))
    .split('\n')
    .map(line => line.replace(/\r/g, '').trimEnd())
    .filter(line => line.trim().length > 0);
}

/** The last transcript read of each agent, kept while its file is the same size and date. */
const transcripts = new Map<string, { sessionId: string; stamp: string; lines: string[] }>();

/** The session whose conversation is the agent's: the one it runs, else the last one it ran. */
function sessionOf(agent: AgentStatus): string | undefined {
  return agent.currentSessionId ?? agent.resumableSessionId ?? agent.lastKilledSessionId;
}

function transcriptStamp(agent: AgentStatus, sessionId: string): string | undefined {
  for (const root of [agent.worktreePath, agent.projectPath]) {
    if (!root) continue;
    for (const spelling of spellingsOf(root)) {
      try {
        const stat = fs.statSync(transcriptPath(spelling, sessionId));
        return `${stat.size}:${stat.mtimeMs}`;
      } catch { /* not this spelling */ }
    }
  }
  return undefined;
}

/** A message as Claude Code draws it: ❯ what was typed, ⏺ the answer and each tool call, ⎿ a tool's answer. */
function messageLines(message: TranscriptMessage): string[] {
  const mark = message.toolResult ? '  ⎿ ' : message.role === 'user' ? '❯ ' : '⏺ ';
  const lines = message.text.split('\n')
    .map((line, i) => `${i === 0 ? mark : '  '}${line}`.trimEnd())
    .filter(line => line.trim() && line.trim() !== mark.trim());
  for (const call of message.toolCalls ?? []) lines.push(`⏺ ${call.name}(${call.summary})`);
  return lines;
}

/** The last MAX_PAGE messages of the agent's Claude Code transcript, as lines, or none. */
async function transcriptLines(agent: AgentStatus): Promise<string[]> {
  const sessionId = sessionOf(agent);
  if (!sessionId) return [];
  const stamp = transcriptStamp(agent, sessionId);
  if (!stamp) return [];
  const kept = transcripts.get(agent.id);
  if (kept && kept.sessionId === sessionId && kept.stamp === stamp) return kept.lines;
  const read = await readAgentTranscript({ sessionId, projectPath: agent.projectPath, worktreePath: agent.worktreePath, limit: MAX_PAGE });
  const lines = read.available ? read.messages.flatMap(messageLines) : [];
  transcripts.set(agent.id, { sessionId, stamp, lines });
  return lines;
}

/** What is kept of agents that are gone: nothing (the Audit's Low, gate of #274). */
function forgetRemoved(): void {
  for (const cache of [replays, transcripts]) {
    for (const id of cache.keys()) if (!agents.has(id)) cache.delete(id);
  }
}

/** The agents whose lines are kept, for the tests. */
export function cachedAgentIds(): string[] {
  return [...new Set([...replays.keys(), ...transcripts.keys()])];
}

async function agentLines(agentId: string): Promise<{ line: string; position: number }[]> {
  const agent = agents.get(agentId);
  if (!agent) return [];
  const live = agent.ptyId ? terminalText(ptyProcesses.get(agent.ptyId)) : undefined;
  const terminal = live ?? replayed(agent) ?? stripped(agent);
  const lines = [...await transcriptLines(agent), ...terminal];
  return lines.map((line, position) => ({ line, position }));
}

/**
 * Case-insensitive substring, or a regex when the query is /…/ delimited.
 * A bad regex falls back to a literal search rather than throwing at the user.
 */
function matcher(query: string): (line: string) => boolean {
  const asRegex = query.match(/^\/(.*)\/([gimsu]*)$/);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2].replace('g', ''));
      return line => re.test(line);
    } catch {
      // fall through to literal
    }
  }
  const needle = query.toLowerCase();
  return line => line.toLowerCase().includes(needle);
}

export async function searchLogs(opts: {
  query: string;
  agentIds?: string[];
  projectPath?: string;
  limit?: number;
}): Promise<LogSearchResult> {
  forgetRemoved();
  const limit = Math.min(opts.limit ?? 200, MAX_RESULTS);
  const matches = matcher(opts.query);
  const lines: LogLine[] = [];
  let scanned = 0;

  const candidates = opts.agentIds?.length
    ? opts.agentIds.map(id => agents.get(id)).filter(Boolean)
    : Array.from(agents.values());

  for (const agent of candidates) {
    if (!agent) continue;
    if (opts.projectPath && agent.projectPath !== opts.projectPath) continue;
    scanned++;

    for (const entry of await agentLines(agent.id)) {
      if (!matches(entry.line)) continue;
      lines.push({
        agentId: agent.id,
        agentName: agent.name || agent.id,
        projectPath: agent.projectPath,
        branch: agent.branchName,
        status: agent.status,
        line: entry.line.slice(0, 600),
        position: entry.position,
      });
      if (lines.length >= limit) {
        return { lines, scannedAgents: scanned, truncated: true };
      }
    }
  }

  return { lines, scannedAgents: scanned, truncated: false };
}

/** The tail of one agent's output, for reading around a hit. */
export async function agentTail(agentId: string, lineCount = 200): Promise<{ lines: string[]; agentName: string } | null> {
  forgetRemoved();
  const agent = agents.get(agentId);
  if (!agent) return null;
  const all = (await agentLines(agentId)).map(e => e.line);
  return { lines: all.slice(-lineCount), agentName: agent.name || agent.id };
}

/** Fleet overview: who is running, who errored, who has been quiet. */
export function fleetSummary(): {
  agentId: string;
  agentName: string;
  projectPath: string;
  branch?: string;
  provider?: string;
  status: string;
  lastActivity?: string;
  lines: number;
}[] {
  return Array.from(agents.values())
    .map(agent => ({
      agentId: agent.id,
      agentName: agent.name || agent.id,
      projectPath: agent.projectPath,
      branch: agent.branchName,
      provider: agent.provider,
      status: agent.status,
      lastActivity: agent.lastActivity,
      lines: agent.output.length,
    }))
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}
