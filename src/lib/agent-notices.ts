import type { AgentNotice, FleetEntry, LogLine } from '@/types/electron';

/**
 * Tars's notices about an agent, as the panel and Logs draw them (2.0.7). Frame: `Agent notices (2.0.7) · in its panel
 * and in Logs`.
 *
 * Main writes each notice into the agent's kept output as `[Tars] <line>` and keeps it, with its time and kind, in the
 * notice log the window reads (agent.notices). Logs reads a stopped agent from that kept output, replayed, where the
 * line sits at its place in time; a running agent from its terminal's screen, which never shows it.
 *
 * Anything can print `[Tars] `: the agent, its tools, a copy of a notice. So a line is drawn as Tars's only when it
 * claims a notice Tars kept, and never when it comes from a screen (the Audit's M1 on #626): every other line stays the
 * agent's, as printed. A notice no line holds goes in a group of its own, by time, above the lines: a screen carries no
 * time, so the notices are not set among its lines, nor drawn as its first ones (the Audit's L1).
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

/** "Tars · HH:MM". */
export function noticeWho(notice: AgentNotice): string {
  return `Tars · ${noticeTime(notice.at)}`;
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
  | { kind: 'notice'; notice: AgentNotice };

/**
 * An agent's tail with its notices: `group`, the notices no line holds, oldest first, drawn above the lines as Tars's
 * notices by time; `rows`, the lines, where a replayed `[Tars] ` line that claims a kept notice is that notice. With
 * `screen` (the lines are a running terminal's screen), no line is Tars's.
 */
export function tailWithNotices(
  lines: readonly string[],
  notices: readonly AgentNotice[],
  screen: boolean,
): { group: AgentNotice[]; rows: TailRow[] } {
  const ordered = oldestFirst(notices);
  const used = new Set<string>();
  const rows: TailRow[] = lines.map(line => {
    const text = screen ? undefined : tarsText(line);
    const notice = text === undefined ? undefined : claim(text, ordered, used);
    return notice ? { kind: 'notice', notice } : { kind: 'line', line };
  });
  return { group: ordered.filter(n => !used.has(n.id)), rows };
}

export interface ResultRow {
  key: string;
  agentId: string;
  agentName: string;
  branch?: string;
  projectPath: string;
  line: string;
  /** The notice Tars kept that this row is, or false: a line of the agent's, as printed. */
  tars: false | { notice: AgentNotice };
}

/**
 * A search's hits with the notices it matches: a replayed `[Tars] ` hit that claims a kept notice is that notice, and
 * an agent's matching notices no hit holds go before its first hit; an agent of the fleet with matching notices and no
 * hit gets them after every hit. The hits of an agent in `screens` (read from its running terminal's screen) are never
 * Tars's. Only the fleet's agents: a removed agent's notices go with it.
 */
export function resultsWithNotices(
  results: readonly LogLine[],
  notices: readonly AgentNotice[],
  fleet: readonly FleetEntry[],
  matches: (line: string) => boolean,
  screens: ReadonlySet<string>,
): ResultRow[] {
  const known = new Map(fleet.map(a => [a.agentId, a]));
  const byAgent = new Map<string, AgentNotice[]>();
  for (const n of oldestFirst(notices)) {
    if (!known.has(n.agentId) || !matches(n.line)) continue;
    byAgent.set(n.agentId, [...(byAgent.get(n.agentId) ?? []), n]);
  }
  const used = new Set<string>();
  const hits: ResultRow[] = results.map((r, i) => {
    const text = screens.has(r.agentId) ? undefined : tarsText(r.line);
    const notice = text === undefined ? undefined : claim(text, byAgent.get(r.agentId) ?? [], used);
    return {
      key: `${r.agentId}-${r.position}-${i}`,
      agentId: r.agentId,
      agentName: r.agentName,
      branch: r.branch,
      projectPath: r.projectPath,
      line: notice ? notice.line : r.line,
      tars: notice ? { notice } : false,
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
