import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENT_NOTICE_KINDS, type AgentNotice, type AgentNoticeKind } from '../core/agent-notices';

/**
 * Tars's notices about each agent, as the window reads them (2.0.7; the Frontend's frames "Agent notices (2.0.7)", draft
 * #623). Every line core/agent-notices.ts writes into an agent's kept output, and every session hooks-routes.ts refuses,
 * is kept here with its kind and told to every window as it is written (agent:notice): while the agent has a terminal,
 * Logs and its panel read that terminal's screen, which those lines never reach.
 *
 * - Kept across a restart of Tars, in ~/.tars/agent-notices.json, written whole (a new file renamed over the old one).
 *   Not a secret: a sentence about an agent, its session's id at most. ~/.tars is every agent's folder, so the file is
 *   read as an agent may have written it: an entry of another shape or of an unknown kind is left out, a line is cut to
 *   one line of at most NOTICE_LINE_MAX characters, and no file that does not parse is read as notices.
 * - At most NOTICE_CAP_PER_AGENT per agent, the oldest dropped; removed with the agent (core/agent-remove.ts).
 * - Marked seen by a window (markSeen), which every window is told (agent:notice-seen), so another one updates.
 */

export const NOTICE_CAP_PER_AGENT = 50;
export const NOTICE_LINE_MAX = 1_000;
const VERSION = 1;

export const AGENT_NOTICES_FILE = (): string => path.join(DATA_DIR, 'agent-notices.json');

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

function read(file: string): AgentNotice[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; notices?: unknown };
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.notices)) throw new Error('not a version 1 file');
    const notices = parsed.notices.map(noticeFrom).filter((n): n is AgentNotice => !!n);
    // In the order they were written; a file edited by hand by their time, the order kept between equal times.
    return capped(notices.map((n, i) => ({ n, i })).sort((a, b) => a.n.at - b.n.at || a.i - b.i).map(({ n }) => n));
  } catch (err) {
    console.warn(`[agent-notices] ${file} is not a file of notices (${err instanceof Error ? err.message : err}): none read from it`);
    return [];
  }
}

export interface NoticeLog {
  /** Keep a notice of `agentId` and tell every window (agent:notice). */
  record(agentId: string, line: string, kind: AgentNoticeKind): AgentNotice;
  /** Newest first: `agentId`'s, or every agent's. */
  list(agentId?: string): AgentNotice[];
  /** Mark `agentId`'s notices seen (all of them not seen yet, with no `ids`), told once (agent:notice-seen). The ids marked. */
  markSeen(agentId: string, ids?: string[]): string[];
  /** Drop `agentId`'s notices (the agent was removed). How many went. */
  forget(agentId: string): number;
}

export function createNoticeLog(o: { file: string; emit: (channel: string, payload: unknown) => void; now?: () => number }): NoticeLog {
  const now = o.now ?? (() => Date.now());
  let notices = read(o.file);
  const save = () => {
    try {
      writeAtomicSync(o.file, `${JSON.stringify({ version: VERSION, notices }, null, 2)}\n`);
    } catch (err) {
      console.warn(`[agent-notices] could not write ${o.file}:`, err instanceof Error ? err.message : err);
    }
  };
  return {
    record(agentId, line, kind) {
      const notice: AgentNotice = { id: crypto.randomUUID(), agentId, at: now(), line: oneLine(line), kind };
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

let current: NoticeLog | undefined;
/** The one for the process: made at the first call, from ~/.tars/agent-notices.json, telling every window. */
export function noticeLog(): NoticeLog {
  current ??= createNoticeLog({ file: AGENT_NOTICES_FILE(), emit: broadcastToAllWindows });
  return current;
}
