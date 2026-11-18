import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * The change log of agents' settings (2.0.7, the owner's word of 19/11): every change asked of an agent's settings,
 * by an agent, by Tars's own pass or by the window, with who asked, which agent, its values before and after, when it
 * was asked, whether it was applied at once or queued behind the agent's turn, and when it took effect. Read by the
 * route GET /api/agent-changes and the MCP tool agent_changes; read by a revert (core/agent-retune.ts), which sets the
 * `before` again; read at Tars's start for the changes still queued when it quit.
 *
 * Kept in ~/.tars-private/agent-changes.jsonl, 0600, which no agent is handed: an agent that could write it would
 * rewrite the history of what it did. One line appended per change and per update of one (a batch of a hundred
 * agents writes a hundred lines, never the whole log a hundred times), the file rewritten from what Tars holds once it
 * has twice as many lines as entries. The last CHANGES_KEPT entries, the oldest dropped first. It holds settings and
 * references only (an endpoint by its id, never its key): `before` and `after` take short strings, numbers, booleans,
 * null, a list of short strings (the skills), and a worktree as its path and branch, and refuse anything else.
 */

export const CHANGES_FILE = privatePath('agent-changes.jsonl');
export let CHANGES_KEPT = 2000;

/** Who asked: an agent of the fleet (as it was when it asked), Tars's own pass (the super chat), or the window. */
export type ChangeBy =
  | { kind: 'agent'; id: string; name: string; projectPath: string }
  | { kind: 'tars' }
  | { kind: 'window' };

export type ChangeState = 'applied' | 'queued' | 'cancelled' | 'failed';

export interface AgentChange {
  /** chg- and 8 hex. */
  id: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  by: ChangeBy;
  /** The settings asked for, in the order the record keeps them. */
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  askedAt: string;
  state: ChangeState;
  /** When the agent's CLI took it: at once, at the end of its turn, at its next start. */
  effectiveAt?: string;
  /** While queued: what it waits for. */
  waitingFor?: string;
  /** When and how it applies, as the answer said it. */
  how?: string;
  /** A failed change: why. */
  error?: string;
  /** One call over several agents. */
  batchId?: string;
  /** The change this one sets back. */
  revertOf?: string;
}

export interface ChangeFilter {
  agentId?: string;
  projectPath?: string;
  batchId?: string;
  limit?: number;
}

const MAX_TEXT = 300;

let entries: AgentChange[] = [];
/** Lines in the file now: past twice CHANGES_KEPT, it is rewritten from `entries`. */
let lines = 0;

/** A value the log keeps, or throws: a setting, never a payload. */
function keptValue(value: unknown, field: string): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw new Error(`${field}: a value of ${value.length} characters is no setting`);
    return value;
  }
  if (value === undefined) return null;
  // A list of short strings: the skills.
  if (Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === 'string' && v.length <= MAX_TEXT)) return [...value];
  if (field === 'worktree' && typeof value === 'object' && !Array.isArray(value)) {
    const { worktreePath, branchName } = value as Record<string, unknown>;
    if (typeof worktreePath === 'string' && typeof branchName === 'string' && worktreePath.length <= 4096 && branchName.length <= MAX_TEXT) {
      return { worktreePath, branchName };
    }
  }
  throw new Error(`${field}: a value of type ${Array.isArray(value) ? 'array' : typeof value} is no setting the log keeps`);
}

function keptValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([field, value]) => [field, keptValue(value, field)]));
}

type Line = { change: AgentChange } | { update: { id: string; set: Record<string, unknown>; unset: string[] } };

function compact(): void {
  writeSecretFileSync(CHANGES_FILE, entries.map((e) => `${JSON.stringify({ change: e })}\n`).join(''));
  lines = entries.length;
}

function append(line: Line): void {
  if (!fs.existsSync(CHANGES_FILE)) writeSecretFileSync(CHANGES_FILE, '');
  fs.appendFileSync(CHANGES_FILE, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  lines += 1;
  if (lines > CHANGES_KEPT * 2) compact();
}

function applyUpdate(entry: AgentChange, set: Record<string, unknown>, unset: string[]): void {
  for (const [key, value] of Object.entries(set)) (entry as unknown as Record<string, unknown>)[key] = value;
  for (const key of unset) delete (entry as unknown as Record<string, unknown>)[key];
}

function isEntry(raw: unknown): raw is AgentChange {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.agentId === 'string' && typeof e.askedAt === 'string'
    && typeof e.state === 'string' && !!e.before && typeof e.before === 'object' && !!e.after && typeof e.after === 'object';
}

/** Tars's start (main.ts): what the file holds, or nothing. A malformed line is left out, the rest kept. */
export function loadChanges(): void {
  entries = [];
  lines = 0;
  let text = '';
  try {
    text = fs.readFileSync(CHANGES_FILE, 'utf-8');
  } catch {
    return;
  }
  const byId = new Map<string, AgentChange>();
  // A line that is no change nor update of one, or a last line cut short: the file is rewritten from what was read,
  // so that the next line appended is never glued to it.
  let sound = text === '' || text.endsWith('\n');
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    lines += 1;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      sound = false;
      continue;
    }
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      sound = false;
      continue;
    }
    const { change, update } = line as { change?: unknown; update?: { id?: unknown; set?: unknown; unset?: unknown } };
    if (isEntry(change)) {
      entries.push(change);
      byId.set(change.id, change);
    } else if (update && typeof update.id === 'string' && byId.has(update.id)) {
      const set = update.set && typeof update.set === 'object' && !Array.isArray(update.set) ? update.set as Record<string, unknown> : {};
      const unset = Array.isArray(update.unset) ? update.unset.filter((k): k is string => typeof k === 'string') : [];
      applyUpdate(byId.get(update.id)!, set, unset);
    } else {
      sound = false;
    }
  }
  entries = entries.slice(-CHANGES_KEPT);
  if (!sound) {
    try {
      compact();
    } catch (err) {
      console.warn(`[agent-changes] ${CHANGES_FILE} could not be rewritten:`, err);
    }
  }
}

/** A new entry, written at once. Throws, writing nothing, on a value the log does not keep. */
export function recordChange(change: Omit<AgentChange, 'id'>): AgentChange {
  const entry: AgentChange = {
    ...change,
    id: `chg-${randomBytes(4).toString('hex')}`,
    fields: [...change.fields],
    before: keptValues(change.before),
    after: keptValues(change.after),
  };
  while (entries.some((e) => e.id === entry.id)) entry.id = `chg-${randomBytes(4).toString('hex')}`;
  entries.push(entry);
  if (entries.length > CHANGES_KEPT) entries = entries.slice(-CHANGES_KEPT);
  append({ change: entry });
  return { ...entry };
}

/** The same entry changed: its state, when it took effect, why it failed. A key set to undefined is taken away. */
export function updateChange(id: string, patch: Partial<Pick<AgentChange, 'state' | 'effectiveAt' | 'waitingFor' | 'how' | 'error'>>): AgentChange | undefined {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return undefined;
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const unset = Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);
  applyUpdate(entry, set, unset);
  append({ update: { id, set, unset } });
  return { ...entry };
}

export function changeById(id: string): AgentChange | undefined {
  const entry = entries.find((e) => e.id === id);
  return entry ? { ...entry } : undefined;
}

/** Newest first, filtered, at most `limit` (1 to 500, 100 when not given). */
export function listChanges(filter: ChangeFilter): AgentChange[] {
  const asked = Number.isFinite(filter.limit) ? Math.trunc(filter.limit as number) : 100;
  const limit = Math.min(500, Math.max(1, asked));
  const out: AgentChange[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = entries[i];
    if (filter.agentId && e.agentId !== filter.agentId) continue;
    if (filter.projectPath && e.projectPath !== filter.projectPath) continue;
    if (filter.batchId && e.batchId !== filter.batchId) continue;
    out.push({ ...e });
  }
  return out;
}

/** The changes still queued, oldest first: Tars applies them when their agent is free. */
export function queuedChanges(): AgentChange[] {
  return entries.filter((e) => e.state === 'queued').map((e) => ({ ...e }));
}

/** Test seam. */
export function resetChanges(): void {
  entries = [];
  lines = 0;
  CHANGES_KEPT = 2000;
}

/** Test seam: a smaller log, so that its bound is reached in a few writes. */
export function keepAtMost(n: number): void {
  CHANGES_KEPT = n;
}
