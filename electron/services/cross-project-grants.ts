import * as fs from 'fs';
import * as path from 'path';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { hasOrchestratorPowers } from '../core/agent-role';
import type { AgentStatus } from '../types';

/**
 * The allowlist across projects (2.0.7, the owner's word of 19/11): an entry "caller project -> target project",
 * which only the owner grants, in the window, gives the caller project's orchestrator (and its chats' runners, which
 * have its powers), and the workers the entry names by id, the target project's orchestrator's powers over the target
 * project's agents: list them whole, hand them work, start, stop and message them, read their answers and wait on
 * them. One way: a grant from A to B opens nothing of A to B.
 *
 * Without an entry, an agent reaches another project's agents only as any agent does: it reads their settings and
 * status (never their tasks' content), retunes their inference (agent-retune.ts), leaves a note, and messages or hands
 * a task to that project's orchestrator, as projects' orchestrators talk to each other; it never hands its workers
 * work, starts, stops, creates or removes one. `allowCrossProject: true` no longer opens more than that.
 *
 * Kept as the owner's Chrome switch is (services/chrome-without-asking.ts, the Audit's M1 and L3 on #582):
 * ~/.tars-private/cross-project-grants.json, 0600, which no agent is handed (~/.tars, where app-settings.json is, is
 * in every agent's --add-dir, and a bypass agent writes there). Read once at Tars's start (main.ts, loadGrants), and
 * changed only by the window's channels (crossProject:set and crossProject:remove), which write the file and what Tars
 * holds together: a grant the owner sets holds at once, with no restart. Anything else that writes the file while Tars
 * runs, an agent's Bash among it, is taken at Tars's next start, never at once.
 *
 * `grantFor` is the one check, for every route that asks it, and for any later one (the schedules' check across
 * projects asks the same).
 */

export const GRANTS_FILE = privatePath('cross-project-grants.json');

export interface CrossProjectGrant {
  /** The caller's project: its orchestrator, its chats' runners and the workers named below act in `to`. */
  from: string;
  /** The project whose agents they act on, with its orchestrator's powers. */
  to: string;
  /** Workers of `from`, by agent id, given the same powers. A name grants nothing. */
  workers: string[];
  grantedAt: string;
}

/** What Tars holds: what the private file said at Tars's start, then what the window set. Nothing until it is read. */
let held: CrossProjectGrant[] = [];

/** A project path as the agents' records hold it: absolute, resolved, no trailing separator. */
function same(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

const isAbsoluteString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value);

/** One entry of the file, or null when it is anything else: a malformed entry grants nothing, the others still do. */
function entryOf(raw: unknown): CrossProjectGrant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { from, to, workers, grantedAt } = raw as Record<string, unknown>;
  if (!isAbsoluteString(from) || !isAbsoluteString(to) || same(from, to)) return null;
  if (!Array.isArray(workers) || workers.some((w) => typeof w !== 'string')) return null;
  return { from: path.resolve(from), to: path.resolve(to), workers: [...(workers as string[])], grantedAt: typeof grantedAt === 'string' ? grantedAt : '' };
}

function readGrants(): CrossProjectGrant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
  const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { grants?: unknown }).grants : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(entryOf).filter((g): g is CrossProjectGrant => g !== null);
}

/** Tars's start (main.ts), before any agent is loaded or reached: the one read of the private file in a run. */
export function loadGrants(): void {
  held = readGrants();
  if (held.length) console.log(`[cross-project] ${held.length} grant(s) read at the start: ${held.map((g) => `${g.from} -> ${g.to}`).join(', ')}`);
}

export function listGrants(): CrossProjectGrant[] {
  return held.map((g) => ({ ...g, workers: [...g.workers] }));
}

function save(next: CrossProjectGrant[]): string | null {
  try {
    writeSecretFileSync(GRANTS_FILE, `${JSON.stringify({ grants: next }, null, 2)}\n`);
  } catch (err) {
    return `${GRANTS_FILE} could not be written: ${err instanceof Error ? err.message : String(err)}`;
  }
  held = next;
  return null;
}

/** The window's grant, or its new workers for a pair already granted. Written, then held. */
export function setGrant(input: { from: unknown; to: unknown; workers?: unknown }): { ok: true; grant: CrossProjectGrant } | { ok: false; error: string } {
  const { from, to } = input ?? ({} as never);
  const workers = input?.workers ?? [];
  if (!isAbsoluteString(from) || !isAbsoluteString(to)) return { ok: false, error: 'The caller project and the target project are absolute paths.' };
  if (same(from, to)) return { ok: false, error: 'A project acts on its own agents without a grant: name another project.' };
  if (!Array.isArray(workers) || workers.some((w) => typeof w !== 'string' || !w.trim())) {
    return { ok: false, error: 'The workers are a list of agent ids of the caller project.' };
  }
  const grant: CrossProjectGrant = { from: path.resolve(from), to: path.resolve(to), workers: [...new Set(workers as string[])], grantedAt: new Date().toISOString() };
  const at = held.findIndex((g) => same(g.from, grant.from) && same(g.to, grant.to));
  const next = at === -1 ? [...held, grant] : held.map((g, i) => (i === at ? grant : g));
  const error = save(next);
  if (error) return { ok: false, error };
  console.log(`[cross-project] granted from the window: ${grant.from} -> ${grant.to}, workers ${grant.workers.join(', ') || 'none'}`);
  return { ok: true, grant: { ...grant, workers: [...grant.workers] } };
}

/** The window's withdrawal of one pair. */
export function removeGrant(input: { from: unknown; to: unknown }): { ok: true; removed: boolean } | { ok: false; error: string } {
  const { from, to } = input ?? ({} as never);
  if (!isAbsoluteString(from) || !isAbsoluteString(to)) return { ok: false, error: 'The caller project and the target project are absolute paths.' };
  const next = held.filter((g) => !(same(g.from, from) && same(g.to, to)));
  if (next.length === held.length) return { ok: true, removed: false };
  const error = save(next);
  if (error) return { ok: false, error };
  console.log(`[cross-project] withdrawn from the window: ${from} -> ${to}`);
  return { ok: true, removed: true };
}

/**
 * The grant that lets `caller` act on the agents of `targetProject` with that project's orchestrator's powers, or
 * undefined. The caller is an agent of the fleet as Tars knows it now: its project now is the one that counts. Its
 * own project needs no grant, and this answers undefined for it: the routes ask it only across projects.
 */
export function grantFor(
  caller: Pick<AgentStatus, 'id' | 'projectPath' | 'role' | 'kind'> | undefined,
  targetProject: string,
): CrossProjectGrant | undefined {
  if (!caller || typeof caller.projectPath !== 'string' || typeof targetProject !== 'string') return undefined;
  const grant = held.find((g) => same(g.from, caller.projectPath) && same(g.to, targetProject));
  if (!grant) return undefined;
  return hasOrchestratorPowers(caller) || grant.workers.includes(caller.id) ? grant : undefined;
}

/** The window's own channels. No API route reaches them, so no agent does. */
export function registerCrossProjectHandlers(ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void }): void {
  ipc.handle('crossProject:list', () => listGrants());
  ipc.handle('crossProject:set', (_event, input) => setGrant((input ?? {}) as { from: unknown; to: unknown; workers?: unknown }));
  ipc.handle('crossProject:remove', (_event, input) => removeGrant((input ?? {}) as { from: unknown; to: unknown }));
}

/** Test seam. */
export function resetGrants(): void {
  held = [];
}
