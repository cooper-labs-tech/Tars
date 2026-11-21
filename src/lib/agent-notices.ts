import type { AgentNotice, FleetEntry, LogLine } from '@/types/electron';

/**
 * Tars's notices about an agent, as the panel and Logs draw them (2.0.7). Frame: `Agent notices (2.0.7) · in its panel
 * and in Logs`.
 *
 * Main writes each notice into the agent's kept output as `[Tars] <line>` and keeps it, with its time and kind, in the
 * notice log the window reads (agent.notices). Logs reads a stopped agent from that kept output, replayed, where the
 * line sits at its place in time; a running agent from its terminal's screen, which never shows it. So a `[Tars] ` line
 * Logs returns is drawn as the notice it is, and a notice no line holds is placed before the lines: neither a screen nor
 * a replay carries a time, and what a notice says (a session refused, a conversation that starts over) came before what
 * the screen shows of it.
 */

export const TARS_LINE_PREFIX = '[Tars] ';

/** A refused session is an error, a conversation that starts over a wait, anything else plain. */
export function noticeTone(kind: AgentNotice['kind']): 'error' | 'waiting' | 'idle' {
  if (kind === 'session-refused') return 'error';
  if (kind === 'conversation-restart') return 'waiting';
  return 'idle';
}

/** HH:MM, on the 24-hour clock, in the window's own time zone. */
export function noticeTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Tars · HH:MM", or "Tars" for a `[Tars] ` line no kept notice matches. */
export function noticeWho(notice: AgentNotice | undefined): string {
  return notice ? `Tars · ${noticeTime(notice.at)}` : 'Tars';
}

/**
 * Logs' own rule, as main's search applies it (electron/services/log-search.ts, matcher): a case-insensitive
 * substring, or a regex when the query is /…/ delimited; a bad regex is searched as text.
 */
export function logMatcher(query: string): (line: string) => boolean {
  const asRegex = query.match(/^\/(.*)\/([gimsu]*)$/);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1], asRegex[2].replace('g', ''));
      return line => re.test(line);
    } catch {
      // searched as text below
    }
  }
  const needle = query.toLowerCase();
  return line => line.toLowerCase().includes(needle);
}

/** Oldest first: the order Logs reads in, top to bottom. */
function oldestFirst(notices: readonly AgentNotice[]): AgentNotice[] {
  return [...notices].sort((a, b) => a.at - b.at);
}

/**
 * The notice a `[Tars] ` line is, among those not matched yet, oldest first: the same line written twice is two
 * notices. Logs cuts a search hit at 600 characters, so a cut line matches the notice it begins.
 */
function claim(text: string, notices: readonly AgentNotice[], used: Set<string>): AgentNotice | undefined {
  const found = notices.find(n => !used.has(n.id) && (n.line === text || (text.length > 0 && n.line.startsWith(text) && text.length >= 590)));
  if (found) used.add(found.id);
  return found;
}

const tarsText = (line: string): string | undefined =>
  line.startsWith(TARS_LINE_PREFIX) ? line.slice(TARS_LINE_PREFIX.length).trim() : undefined;

export type TailRow =
  | { kind: 'line'; line: string }
  | { kind: 'notice'; notice: AgentNotice | undefined; text: string };

/** An agent's tail with its notices: its `[Tars] ` lines as notices, and the notices it does not hold before it. */
export function tailWithNotices(lines: readonly string[], notices: readonly AgentNotice[]): TailRow[] {
  const ordered = oldestFirst(notices);
  const used = new Set<string>();
  const rows: TailRow[] = lines.map(line => {
    const text = tarsText(line);
    return text === undefined ? { kind: 'line', line } : { kind: 'notice', notice: claim(text, ordered, used), text };
  });
  const before: TailRow[] = ordered.filter(n => !used.has(n.id)).map(n => ({ kind: 'notice', notice: n, text: n.line }));
  return [...before, ...rows];
}

export interface ResultRow {
  key: string;
  agentId: string;
  agentName: string;
  branch?: string;
  projectPath: string;
  line: string;
  /** Tars's line: the notice it is, undefined when no kept notice matches it. */
  tars: false | { notice: AgentNotice | undefined };
}

/**
 * A search's hits with the notices it matches: an agent's `[Tars] ` hits drawn as its notices, and its matching
 * notices no hit holds placed before its first hit; an agent of the fleet with matching notices and no hit gets
 * them after every hit. Only the fleet's agents: a removed agent's notices go with it.
 */
export function resultsWithNotices(
  results: readonly LogLine[],
  notices: readonly AgentNotice[],
  fleet: readonly FleetEntry[],
  matches: (line: string) => boolean,
): ResultRow[] {
  const known = new Map(fleet.map(a => [a.agentId, a]));
  const byAgent = new Map<string, AgentNotice[]>();
  for (const n of oldestFirst(notices)) {
    if (!known.has(n.agentId) || !matches(n.line)) continue;
    byAgent.set(n.agentId, [...(byAgent.get(n.agentId) ?? []), n]);
  }
  const used = new Set<string>();
  const hits: ResultRow[] = results.map((r, i) => {
    const text = tarsText(r.line);
    return {
      key: `${r.agentId}-${r.position}-${i}`,
      agentId: r.agentId,
      agentName: r.agentName,
      branch: r.branch,
      projectPath: r.projectPath,
      line: text ?? r.line,
      tars: text === undefined ? false : { notice: claim(text, byAgent.get(r.agentId) ?? [], used) },
    };
  });
  const noticeRow = (n: AgentNotice): ResultRow => {
    const a = known.get(n.agentId)!;
    return { key: `notice-${n.id}`, agentId: n.agentId, agentName: a.agentName, branch: a.branch, projectPath: a.projectPath, line: n.line, tars: { notice: n } };
  };
  const unheld = (agentId: string) => (byAgent.get(agentId) ?? []).filter(n => !used.has(n.id));
  const rows: ResultRow[] = [];
  const placed = new Set<string>();
  for (const hit of hits) {
    if (!placed.has(hit.agentId)) {
      placed.add(hit.agentId);
      rows.push(...unheld(hit.agentId).map(noticeRow));
    }
    rows.push(hit);
  }
  for (const agentId of byAgent.keys()) {
    if (!placed.has(agentId)) rows.push(...unheld(agentId).map(noticeRow));
  }
  return rows;
}
