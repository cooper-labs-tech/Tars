import { agents } from '../core/agent-manager';
import { stripAnsi } from '../utils/ansi';

/**
 * Searching across the whole fleet: every agent's retained buffer in one pass,
 * rather than 29 terminals opened and scrolled.
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

function agentLines(agentId: string): { line: string; position: number }[] {
  const agent = agents.get(agentId);
  if (!agent) return [];
  // Chunks split mid-line, so join before splitting.
  const text = stripAnsi(agent.output.join(''));
  return text
    .split('\n')
    .map((line, position) => ({ line: line.replace(/\r/g, '').trimEnd(), position }))
    .filter(entry => entry.line.trim().length > 0);
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

export function searchLogs(opts: {
  query: string;
  agentIds?: string[];
  projectPath?: string;
  limit?: number;
}): LogSearchResult {
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

    for (const entry of agentLines(agent.id)) {
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
export function agentTail(agentId: string, lineCount = 200): { lines: string[]; agentName: string } | null {
  const agent = agents.get(agentId);
  if (!agent) return null;
  const all = agentLines(agentId).map(e => e.line);
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
