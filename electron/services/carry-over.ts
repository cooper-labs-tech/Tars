import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * What Tars owes its agents, carried across a restart (RD-REDEMARRAGE.md, 2.3;
 * approved by JeanBrasse on 2026-10-05): the note that an agent finished, held for
 * its requester while that one works (agent-watch.ts), and the kanban notes
 * held for an agent's rest (kanban-routes.ts). Both lived in memory only, and a
 * crash, a reboot or a quit lost them.
 *
 * Written a moment after each change, atomically, so a crash loses at most
 * that moment. Read once at launch, and each item goes, once, to the first
 * session of its recipient in the new run, at its first rest, said to be owed
 * from before the restart. The room messages need nothing here: the bus
 * journal keeps them, and bus-delivery.ts queues again what it left queued.
 *
 * In ~/.tars-private (0600), which no agent is handed, and read back strictly:
 * what it holds is typed in Tars's voice (the Audit's gate of #310). A sender
 * read back is never typed as one: a carried kanban note goes as from Tars,
 * its first sender named inside it as data (kanban-routes.ts).
 */

export const CARRY_OVER_FILE = privatePath('carry-over.json');

const NEWS_KINDS = ['outcome', 'wait', 'ended', 'stopped', 'stalled'];
const STATUSES = ['idle', 'running', 'completed', 'error', 'waiting', 'stopped', 'asleep'];
/** A wait's reason, as agent-watch records it, or a stall's minutes: a short word, never a sentence. */
const REASON = /^[A-Za-z0-9_-]{1,40}$/;
const BACKGROUND_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface CarriedNote {
  requesterId: string;
  childId: string;
  news: { kind: string; status: string; [key: string]: unknown };
  /** When it became owed, ISO. */
  at: string;
}

export interface CarriedKanban {
  agentId: string;
  item: { message: string; sender: { kind: string; [key: string]: unknown }; purpose: 'work' | 'note'; what: string };
  at: string;
}

export interface CarryOver {
  notes: CarriedNote[];
  kanban: CarriedKanban[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function noteOf(v: unknown): CarriedNote | null {
  if (!isObject(v) || typeof v.requesterId !== 'string' || typeof v.childId !== 'string' || typeof v.at !== 'string') return null;
  const news = v.news;
  if (!isObject(news) || !NEWS_KINDS.includes(news.kind as string) || !STATUSES.includes(news.status as string)) return null;
  if (news.reason !== undefined && !(typeof news.reason === 'string' && REASON.test(news.reason))) return null;
  if (news.background !== undefined && !(Array.isArray(news.background) && news.background.length <= 50
    && news.background.every((b) => typeof b === 'string' && BACKGROUND_ID.test(b)))) return null;
  if (news.handedAt !== undefined && typeof news.handedAt !== 'string') return null;
  // Only the fields agent-watch writes: nothing else rides along into a note.
  const kept: CarriedNote['news'] = { kind: news.kind as string, status: news.status as string };
  if (news.since !== undefined && typeof news.since !== 'string') return null;
  for (const key of ['reason', 'background', 'handedAt', 'since'] as const) if (news[key] !== undefined) kept[key] = news[key];
  return { requesterId: v.requesterId, childId: v.childId, news: kept, at: v.at };
}

function kanbanOf(v: unknown): CarriedKanban | null {
  if (!isObject(v) || typeof v.agentId !== 'string' || typeof v.at !== 'string' || !isObject(v.item)) return null;
  const { message, sender, purpose, what } = v.item;
  if (typeof message !== 'string' || typeof what !== 'string' || (purpose !== 'work' && purpose !== 'note')) return null;
  if (!isObject(sender) || typeof sender.kind !== 'string') return null;
  return { agentId: v.agentId, item: { message, sender: sender as CarriedKanban['item']['sender'], purpose, what }, at: v.at };
}

/** What the last run left owed: nothing when there is no file or it cannot be read, and only items of the right shape. */
export function readCarryOver(file = CARRY_OVER_FILE): CarryOver {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { notes: [], kanban: [] };
  }
  if (!isObject(parsed)) return { notes: [], kanban: [] };
  const list = <T>(v: unknown, of: (x: unknown) => T | null): T[] =>
    (Array.isArray(v) ? v.map(of).filter((x): x is T => x !== null) : []);
  return { notes: list(parsed.notes, noteOf), kanban: list(parsed.kanban, kanbanOf) };
}

/**
 * Keeps the file in step with what is owed: `changed` writes it a moment
 * later, once for any number of changes in between; `flush` writes it now.
 */
export function startCarryOver(
  sources: { notes: () => CarriedNote[]; kanban: () => CarriedKanban[] },
  file = CARRY_OVER_FILE,
  delayMs = 200,
): { changed: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      writeSecretFileSync(file, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), notes: sources.notes(), kanban: sources.kanban() }));
    } catch (err) {
      console.warn('[carry-over] could not write what is owed:', (err as Error).message);
    }
  };
  const changed = () => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  };
  return { changed, flush };
}

/** "before Tars restarted", with when it became owed, as a note says it. */
export function carriedSince(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return 'owed from before Tars restarted';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `owed since ${hh}:${mm}, before Tars restarted`;
}
