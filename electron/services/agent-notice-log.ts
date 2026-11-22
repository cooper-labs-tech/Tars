import * as crypto from 'crypto';
import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENT_NOTICE_KINDS, type AgentNotice, type AgentNoticeKind } from '../core/agent-notices';

/**
 * Tars's notices about each agent, as the window reads them (2.0.7; the Frontend's frames "Agent notices (2.0.7)", draft
 * #623). Every line core/agent-notices.ts writes into an agent's kept output, and every session hooks-routes.ts refuses,
 * is kept here with its kind and told to every window as it is written (agent:notice): while the agent has a terminal,
 * Logs and its panel read that terminal's screen, which those lines never reach.
 *
 * - Kept across a restart of Tars in ~/.tars-private/agent-notices.json, Tars's own file, which no agent is handed
 *   (the Audit's L1 on #624), written whole at each change (a new file renamed over the old one), at 0600. An agent
 *   running as the same user could still edit it, so it is read as such a file: only the fleet's agents' notices, an
 *   entry of another shape or of an unknown kind left out, a line cut to one line of at most NOTICE_LINE_MAX
 *   characters, and nothing from a file that does not parse or is over NOTICE_FILE_MAX bytes. Tars's own writes keep
 *   it under that bound, the oldest notices (every agent's) dropped first.
 * - At most NOTICE_CAP_PER_AGENT per agent, the oldest dropped; removed with the agent (core/agent-remove.ts).
 * - At most one session-refused notice per agent every REFUSED_NOTICE_EVERY_MS: anything holding the agent's token can
 *   post a refused registration as often as it likes (the Audit's M1 on #624); the kept output still says each.
 * - Marked seen by a window (markSeen), which every window is told (agent:notice-seen), so another one updates.
 */

export const NOTICE_CAP_PER_AGENT = 50;
export const NOTICE_LINE_MAX = 1_000;
export const NOTICE_FILE_MAX = 1024 * 1024;
export const REFUSED_NOTICE_EVERY_MS = 60_000;
const VERSION = 1;

export const AGENT_NOTICES_FILE = (): string => privatePath('agent-notices.json');

/** A line as a notice keeps it: one line, no control character, at most NOTICE_LINE_MAX characters. */
function oneLine(line: string): string {
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTICE_LINE_MAX);
}

function noticeFrom(raw: unknown): AgentNotice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 64) return undefined;
  if (typeof r.agentId !== 'string' || !r.agentId || r.agentId.length > 128) return undefined;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return undefined;
  if (typeof r.line !== 'string') return undefined;
  if (typeof r.kind !== 'string' || !(AGENT_NOTICE_KINDS as readonly string[]).includes(r.kind)) return undefined;
  if (r.seenAt !== undefined && (typeof r.seenAt !== 'number' || !Number.isFinite(r.seenAt))) return undefined;
  const line = oneLine(r.line);
  if (!line) return undefined;
  return { id: r.id, agentId: r.agentId, at: r.at, line, kind: r.kind as AgentNoticeKind, ...(r.seenAt !== undefined ? { seenAt: r.seenAt as number } : {}) };
}

/** Oldest first, each agent's cut to its cap: what the file holds and the log keeps. */
function capped(notices: AgentNotice[]): AgentNotice[] {
  const kept: AgentNotice[] = [];
  const count = new Map<string, number>();
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i];
    const c = count.get(n.agentId) ?? 0;
    if (c >= NOTICE_CAP_PER_AGENT) continue;
    count.set(n.agentId, c + 1);
    kept.push(n);
  }
  return kept.reverse();
}

const fileOf = (notices: AgentNotice[]) => `${JSON.stringify({ version: VERSION, notices })}\n`;

/** The newest notices whose file fits in `max` bytes: the oldest, every agent's, dropped first. */
function fitted(notices: AgentNotice[], max: number): AgentNotice[] {
  const sizes = notices.map((n) => Buffer.byteLength(JSON.stringify(n)) + 1);
  let total = Buffer.byteLength(fileOf([])) + sizes.reduce((a, b) => a + b, 0);
  let from = 0;
  while (total > max && from < notices.length) total -= sizes[from++];
  return from ? notices.slice(from) : notices;
}

/** At most `max` bytes of `file`, or undefined when it holds more: an agent's file is never parsed whole. */
function readBounded(file: string, max: number): string | undefined {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    let read = 0;
    let got: number;
    do {
      got = fs.readSync(fd, buf, read, buf.length - read, null);
      read += got;
    } while (got > 0 && read < buf.length);
    return read > max ? undefined : buf.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function read(file: string, isAgent: (id: string) => boolean, max: number): AgentNotice[] {
  let raw: string | undefined;
  try {
    raw = readBounded(file, max);
  } catch {
    return [];
  }
  if (raw === undefined) {
    console.warn(`[agent-notices] ${file} is larger than ${Math.round(max / 1024 / 1024)} MB, the most Tars writes: none read from it`);
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; notices?: unknown };
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.notices)) throw new Error('not a version 1 file');
    const notices = parsed.notices.map(noticeFrom).filter((n): n is AgentNotice => !!n && isAgent(n.agentId));
    // In the order they were written; a file edited by hand by their time, the order kept between equal times.
    return capped(notices.map((n, i) => ({ n, i })).sort((a, b) => a.n.at - b.n.at || a.i - b.i).map(({ n }) => n));
  } catch (err) {
    console.warn(`[agent-notices] ${file} is not a file of notices (${err instanceof Error ? err.message : err}): none read from it`);
    return [];
  }
}

export interface NoticeLog {
  /**
   * Keep a notice of `agentId` and tell every window (agent:notice). Undefined for a refusal within
   * REFUSED_NOTICE_EVERY_MS of that agent's last one: neither kept nor told.
   */
  record(agentId: string, line: string, kind: AgentNoticeKind): AgentNotice | undefined;
  /** Newest first: `agentId`'s, or every agent's. */
  list(agentId?: string): AgentNotice[];
  /** Mark `agentId`'s notices seen (all of them not seen yet, with no `ids`), told once (agent:notice-seen). The ids marked. */
  markSeen(agentId: string, ids?: string[]): string[];
  /** Drop `agentId`'s notices (the agent was removed). How many went. */
  forget(agentId: string): number;
}

export function createNoticeLog(o: {
  file: string;
  emit: (channel: string, payload: unknown) => void;
  /** Whether the fleet holds this agent: a notice of any other read back from the file is left out. */
  isAgent: (agentId: string) => boolean;
  now?: () => number;
  maxFileBytes?: number;
}): NoticeLog {
  const now = o.now ?? (() => Date.now());
  const max = o.maxFileBytes ?? NOTICE_FILE_MAX;
  let notices = read(o.file, o.isAgent, max);
  const save = () => {
    notices = fitted(notices, max);
    try {
      writeSecretFileSync(o.file, fileOf(notices));
    } catch (err) {
      console.warn(`[agent-notices] could not write ${o.file}:`, err instanceof Error ? err.message : err);
    }
  };
  const lastRefusalAt = (agentId: string): number | undefined => {
    for (let i = notices.length - 1; i >= 0; i--) {
      if (notices[i].agentId === agentId && notices[i].kind === 'session-refused') return notices[i].at;
    }
    return undefined;
  };
  return {
    record(agentId, line, kind) {
      const at = now();
      if (kind === 'session-refused') {
        const last = lastRefusalAt(agentId);
        if (last !== undefined && at - last < REFUSED_NOTICE_EVERY_MS) return undefined;
      }
      const notice: AgentNotice = { id: crypto.randomUUID(), agentId, at, line: oneLine(line), kind };
      notices = capped([...notices, notice]);
      save();
      o.emit('agent:notice', { ...notice });
      return { ...notice };
    },
    list(agentId) {
      return notices.filter((n) => agentId === undefined || n.agentId === agentId).map((n) => ({ ...n })).reverse();
    },
    markSeen(agentId, ids) {
      const asked = ids ? new Set(ids) : undefined;
      const seenAt = now();
      const marked: string[] = [];
      notices = notices.map((n) => {
        if (n.agentId !== agentId || n.seenAt !== undefined || (asked && !asked.has(n.id))) return n;
        marked.push(n.id);
        return { ...n, seenAt };
      });
      if (marked.length === 0) return [];
      save();
      o.emit('agent:notice-seen', { agentId, ids: marked, seenAt });
      return marked;
    },
    forget(agentId) {
      const before = notices.length;
      notices = notices.filter((n) => n.agentId !== agentId);
      const gone = before - notices.length;
      if (gone) save();
      return gone;
    },
  };
}

/** The fleet, as core/agent-manager.ts holds it: set there, since this module is below it. */
let fleetHolds: (agentId: string) => boolean = () => true;
export function setNoticeFleet(isAgent: (agentId: string) => boolean): void {
  fleetHolds = isAgent;
}

let current: NoticeLog | undefined;
/**
 * The one for the process: made at the first call, from ~/.tars-private/agent-notices.json, telling every window. main
 * loads the fleet before anything can call it (the window, the IPC handlers and the API server start after loadAgents).
 */
export function noticeLog(): NoticeLog {
  current ??= createNoticeLog({ file: AGENT_NOTICES_FILE(), emit: broadcastToAllWindows, isAgent: (id) => fleetHolds(id) });
  return current;
}
