import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { parseCap, isProjectOrchestrator } from '../core/project-cap';
import { RESTART_PAUSE } from './agent-queues';
import { parseSchedule, scheduleLine, windowAt, type ScheduleSpec } from './fleet-schedule';
import { powerWarnings, type PowerReading, type PowerWarningKind } from './power-state';
import type { ScheduledWindow } from './keep-awake';
import type { KeepAwakeMode } from '../types';

export { RESTART_PAUSE };

/**
 * A project's hours and its cap, run by Tars (2.0.7): long work kept to a window of the day, and no more of its workers
 * at work at once than its inference endpoint serves.
 *
 * The hours act on the project's workers. Its orchestrator and its chats' runners lead the project and are left out, as
 * the cap leaves them out: an orchestrator never sleeps, and what the owner or another project sends it does not wait
 * for the next window (the Audit's M1 on #593).
 *
 * The hours (services/fleet-schedule.ts): a window every day.
 * - At its start, the queues the last stop paused go again (and those a restart of Tars paused, at any moment of the
 *   window: a night's work never waits for a person), so the agents start as their work comes; with `start-agents`,
 *   each worker of the project at rest is started as well (never one somebody else stopped, never one whose queue
 *   holds work, which starts it, never one whose CLI is up).
 * - At its stop, every worker's queue is paused, so work handed during the day waits for the next window, never
 *   refused and never lost, and every worker is stopped: at once when at rest, and once its turn ends when at work
 *   (never in the middle of a turn, a task being handed, a dialog or background work). A CLI that never says its turn
 *   ended (amp, grok, opencode, pi) is left running, its queue paused, and the window says why. A stop still waiting
 *   on a turn when the next window begins is given up. A queue somebody else paused keeps that pause and its reason,
 *   and the next start does not resume it.
 * - Tars down at a start or a stop: the window opens or closes at its first look after, and says it was late.
 * - While a window is open, the computer is kept awake (services/keep-awake.ts) and its power read, each warning said
 *   once a window (services/power-state.ts); a sleep of the computer is recorded with its wake.
 *
 * The cap (core/project-cap.ts): the most workers of the project at work at once.
 *
 * Who sets them (governRight): the window, Tars's own pass (the owner's super chat), and the project's own
 * orchestrator. Another project's orchestrator is refused here: the owner's grants between projects (2.0.7, a PR of
 * their own) plug into governRight once both are in.
 *
 * Kept in ~/.tars-private (0600), not ~/.tars: every agent is handed ~/.tars, and a worker could otherwise write its
 * project a cap of 64 or move its hours.
 */

export const FLEET_FILE = () => privatePath('fleet-operations.json');

const VERSION = 1;
/** How far past its start (or stop) a window opened (or closed) before it is said late. */
const LATE_MS = 5 * 60_000;

export interface FleetAgent {
  id: string;
  name: string;
  projectPath: string;
  status: string;
  /** A turn, a task being handed, a dialog, background work: a stop now would cut it. */
  atWork: boolean;
  /** Whether its CLI tells Tars its turn ended (core/end-of-turn.ts, hasEndOfTurn). */
  endOfTurn: boolean;
  /** A CLI runs in its terminal. */
  cliUp: boolean;
  /** It leads the project (core/agent-role.ts hasOrchestratorPowers: its orchestrator, a chat's runner): out of the hours. */
  leads?: boolean;
  /** Items in its queue. */
  queued: number;
  stoppedBy?: string;
  stoppedAt?: string;
}

export interface FleetDeps {
  file: string;
  now(): number;
  agents(): FleetAgent[];
  queue: { pausedOf(id: string): { why: string } | undefined; pause(id: string, why: string): void; resume(id: string): void };
  /** Stops the agent; resolves with the stoppedAt it recorded, or undefined when it did not stop it. */
  stop(id: string, reason: string): Promise<string | undefined>;
  start(id: string): Promise<{ ok: boolean; error?: string }>;
  power(): Promise<PowerReading>;
  keepAwake(): { mode: KeepAwakeMode; refused?: true };
  /** Told after every change: the window is told, and the keep-awake synced. */
  changed(): void;
}

interface Stamp { setBy: string; setAt: string }
export type StoredSchedule = ScheduleSpec & Stamp;
export interface StoredCap extends Stamp { cap: number }

export interface WindowRecord {
  /** The window's planned start and stop, ISO. */
  start: string;
  end: string;
  openedAt: string;
  late?: string;
  /** Agents whose queue went again at the start (or after a restart of Tars inside the window). */
  resumed: string[];
  /** Agents started at the start (start-agents). */
  started: string[];
  startFailed: Array<{ agent: string; why: string }>;
  closedAt?: string;
  closedLate?: string;
  /** Why the window ended other than at its stop. */
  ended?: 'cleared';
  stopped: Array<{ id: string; agent: string; at: string; stoppedAt?: string; afterTurn?: true }>;
  /** Agents at work at the stop: stopped once their turn ends. */
  stopping: Array<{ id: string; agent: string }>;
  leftRunning: Array<{ agent: string; why: string }>;
  /** Ids whose queue the stop paused, and the reason it gave: the next start resumes only those, still so paused. */
  paused: string[];
  pauseWhy?: string;
  stopReason?: string;
  warnings: Array<{ kind: PowerWarningKind; at: string; text: string }>;
  slept: Array<{ at: string; wokeAt?: string }>;
}

interface Store {
  schedules: Record<string, StoredSchedule>;
  caps: Record<string, StoredCap>;
  windows: Record<string, WindowRecord>;
}

export interface FleetProjectView {
  projectPath: string;
  schedule?: StoredSchedule & { line: string; next: { open: boolean; start: string; end: string } };
  cap?: StoredCap;
  /** The window open now, or the last one. */
  window?: WindowRecord;
}

const iso = (t: number) => new Date(t).toISOString();
const isStamp = (v: unknown): v is Stamp => !!v && typeof (v as Stamp).setBy === 'string' && typeof (v as Stamp).setAt === 'string';
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

/** The file as it was written, or an empty store: an unreadable file is said once, never thrown. */
function readStore(file: string): Store {
  const empty: Store = { schedules: {}, caps: {}, windows: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; schedules?: unknown; caps?: unknown; windows?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION) throw new Error('not a version 1 file');
    const store = empty;
    for (const [project, entry] of Object.entries((parsed.schedules ?? {}) as Record<string, unknown>)) {
      const spec = parseSchedule(entry);
      if (spec.ok && isStamp(entry)) store.schedules[project] = { ...spec.schedule, setBy: entry.setBy, setAt: entry.setAt };
    }
    for (const [project, entry] of Object.entries((parsed.caps ?? {}) as Record<string, unknown>)) {
      const cap = parseCap((entry as StoredCap | undefined)?.cap);
      if (cap.ok && cap.cap !== null && isStamp(entry)) store.caps[project] = { cap: cap.cap, setBy: entry.setBy, setAt: entry.setAt };
    }
    for (const [project, entry] of Object.entries((parsed.windows ?? {}) as Record<string, unknown>)) {
      const w = entry as Partial<WindowRecord> | undefined;
      if (!w || typeof w.start !== 'string' || typeof w.end !== 'string' || typeof w.openedAt !== 'string') continue;
      store.windows[project] = {
        ...w, start: w.start, end: w.end, openedAt: w.openedAt,
        resumed: list(w.resumed), started: list(w.started), startFailed: list(w.startFailed), stopped: list(w.stopped),
        stopping: list(w.stopping), leftRunning: list(w.leftRunning), paused: list(w.paused), warnings: list(w.warnings), slept: list(w.slept),
      };
    }
    return store;
  } catch (err) {
    console.warn(`[fleet] ${file} is not a file Tars can read (${err instanceof Error ? err.message : err}): no hours and no cap read from it`);
    return empty;
  }
}

export function createFleetOperations(deps: FleetDeps) {
  const store = readStore(deps.file);

  const save = () => {
    try {
      writeSecretFileSync(deps.file, `${JSON.stringify({ version: VERSION, ...store }, null, 2)}\n`);
    } catch (err) {
      console.warn('[fleet] the hours and caps could not be kept:', err instanceof Error ? err.message : err);
    }
  };
  const done = () => {
    save();
    try { deps.changed(); } catch (err) { console.warn('[fleet] a listener failed:', err); }
  };
  // The project's agents the hours act on: its workers. Its orchestrator and its chats' runners lead the project and
  // are left out, as the cap leaves them out: an orchestrator never sleeps, and what the owner or another project
  // sends it must not wait for the next window (the Audit's M1 on #593).
  const teamOf = (project: string) => deps.agents().filter((a) => a.projectPath === project && !a.leads);
  const isOpen = (rec: WindowRecord | undefined): rec is WindowRecord => !!rec && !rec.closedAt;

  const stopOne = async (a: FleetAgent, rec: WindowRecord, afterTurn: boolean, now: number) => {
    let stoppedAt: string | undefined;
    try {
      stoppedAt = await deps.stop(a.id, rec.stopReason ?? "the end of its project's hours");
    } catch (err) {
      console.warn(`[fleet] ${a.name} was not stopped:`, err);
    }
    if (stoppedAt) rec.stopped.push({ id: a.id, agent: a.name, at: iso(now), stoppedAt, ...(afterTurn ? { afterTurn: true as const } : {}) });
  };

  const openWindow = async (project: string, s: ScheduleSpec, w: { start: number; end: number }, now: number) => {
    const prev = store.windows[project];
    if (prev?.stopping.length) {
      prev.leftRunning.push(...prev.stopping.map((x) => ({ agent: x.agent, why: 'its turn was still going when the next window began' })));
      prev.stopping = [];
    }
    const rec: WindowRecord = {
      start: iso(w.start), end: iso(w.end), openedAt: iso(now),
      ...(now - w.start > LATE_MS ? { late: `opened at ${iso(now)}, after its start: Tars was not running then, or the computer slept` } : {}),
      resumed: [], started: [], startFailed: [], stopped: [], stopping: [], leftRunning: [], paused: [], warnings: [], slept: [],
    };
    store.windows[project] = rec;
    const team = teamOf(project);
    for (const a of team) {
      const pause = deps.queue.pausedOf(a.id);
      if (pause && prev?.pauseWhy && prev.paused.includes(a.id) && pause.why === prev.pauseWhy) {
        deps.queue.resume(a.id);
        rec.resumed.push(a.name);
      }
    }
    if (s.onStart === 'start-agents') {
      for (const a of team) {
        if (a.cliUp || a.queued > 0) continue;
        if (a.status === 'stopped' && !prev?.stopped.some((x) => x.id === a.id && x.stoppedAt !== undefined && x.stoppedAt === a.stoppedAt)) continue;
        let r: { ok: boolean; error?: string };
        try { r = await deps.start(a.id); } catch (err) { r = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
        if (r.ok) rec.started.push(a.name);
        else rec.startFailed.push({ agent: a.name, why: r.error ?? 'it did not start' });
      }
    }
    console.log(`[fleet] ${project}: its hours began (${scheduleLine(s)}); queues resumed: ${rec.resumed.length}, agents started: ${rec.started.length}`);
  };

  const closeWindow = async (project: string, s: ScheduleSpec, rec: WindowRecord, now: number) => {
    rec.closedAt = iso(now);
    if (now - Date.parse(rec.end) > LATE_MS) rec.closedLate = `closed at ${iso(now)}, after its stop: Tars was not running then, or the computer slept`;
    rec.pauseWhy = `outside its project's hours (${scheduleLine(s)}): it goes in when they begin`;
    rec.stopReason = `the end of its project's hours (${scheduleLine(s)})`;
    for (const a of teamOf(project)) {
      if (!deps.queue.pausedOf(a.id)) {
        deps.queue.pause(a.id, rec.pauseWhy);
        rec.paused.push(a.id);
      }
      if (a.status === 'stopped') continue;
      if (!a.endOfTurn && a.cliUp) {
        rec.leftRunning.push({ agent: a.name, why: 'its CLI does not tell Tars when its turn ends: its queue is paused, and it was left running so that no work of its is cut' });
        continue;
      }
      if (a.atWork) rec.stopping.push({ id: a.id, agent: a.name });
      else await stopOne(a, rec, false, now);
    }
    console.log(`[fleet] ${project}: its hours ended; stopped ${rec.stopped.length}, waiting on ${rec.stopping.length} turn(s), left running ${rec.leftRunning.length}`);
  };

  /** The stops that waited on a turn: done once it ended. True when any moved. */
  const stopPending = async (rec: WindowRecord, now: number): Promise<boolean> => {
    const keep: WindowRecord['stopping'] = [];
    const before = rec.stopping.length;
    for (const x of rec.stopping) {
      const a = deps.agents().find((y) => y.id === x.id);
      if (!a || a.status === 'stopped') continue;
      if (a.atWork) { keep.push(x); continue; }
      await stopOne(a, rec, true, now);
    }
    rec.stopping = keep;
    return keep.length !== before;
  };

  /** Queues a restart of Tars paused, inside an open window: they go again. True when any did. */
  const resumeAfterRestart = (project: string, rec: WindowRecord): boolean => {
    let moved = false;
    for (const a of teamOf(project)) {
      if (deps.queue.pausedOf(a.id)?.why !== RESTART_PAUSE) continue;
      deps.queue.resume(a.id);
      if (!rec.resumed.includes(a.name)) rec.resumed.push(a.name);
      moved = true;
    }
    return moved;
  };

  const warn = async (open: WindowRecord[], now: number): Promise<boolean> => {
    if (!open.length) return false;
    let reading: PowerReading;
    try { reading = await deps.power(); } catch { reading = { battery: 'unknown', lidClosed: 'unknown', externalDisplay: 'unknown' }; }
    const said = powerWarnings(reading, deps.keepAwake());
    let moved = false;
    for (const rec of open) {
      for (const w of said) {
        if (rec.warnings.some((x) => x.kind === w.kind)) continue;
        rec.warnings.push({ kind: w.kind, at: iso(now), text: w.text });
        console.warn(`[fleet] ${w.text}`);
        moved = true;
      }
    }
    return moved;
  };

  let running: Promise<void> | undefined;
  let again = false;

  const tickOnce = async () => {
    const now = deps.now();
    let moved = false;
    for (const project of new Set([...Object.keys(store.schedules), ...Object.keys(store.windows)])) {
      const s = store.schedules[project];
      let rec: WindowRecord | undefined = store.windows[project];
      if (s) {
        const w = windowAt(s, now);
        if (w.open) {
          if (isOpen(rec) && Date.parse(rec.end) <= w.start) {
            // Left open across a whole stop Tars never saw: that window is over, and nobody is stopped for it now.
            rec.closedAt = iso(now);
            rec.closedLate = 'Tars was not running at its stop, and the next window had begun: nobody was stopped for it';
            rec = undefined;
          }
          if (!isOpen(rec)) {
            await openWindow(project, s, w, now);
            moved = true;
          } else if (rec.start !== iso(w.start) || rec.end !== iso(w.end)) {
            // The hours changed while the window was open, and it is still open on the new ones.
            rec.start = iso(w.start);
            rec.end = iso(w.end);
            moved = true;
          }
        } else if (isOpen(rec)) {
          await closeWindow(project, s, rec, now);
          moved = true;
        }
      }
      rec = store.windows[project];
      if (rec?.closedAt && rec.stopping.length && await stopPending(rec, now)) moved = true;
      if (isOpen(rec) && resumeAfterRestart(project, rec)) moved = true;
    }
    if (await warn(Object.values(store.windows).filter(isOpen), now)) moved = true;
    if (moved) done();
  };

  /** One look at every project: open, close, stop what waited on its turn, warn. Never two at once. */
  const tick = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await tickOnce();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  const view = (projectPath: string): FleetProjectView => {
    const s = store.schedules[projectPath];
    const next = s ? windowAt(s, deps.now()) : undefined;
    return {
      projectPath,
      ...(s ? { schedule: { ...s, line: scheduleLine(s), next: { open: next!.open, start: iso(next!.start), end: iso(next!.end) } } } : {}),
      ...(store.caps[projectPath] ? { cap: store.caps[projectPath] } : {}),
      ...(store.windows[projectPath] ? { window: store.windows[projectPath] } : {}),
    };
  };

  return {
    setSchedule(projectPath: string, spec: ScheduleSpec, by: string): FleetProjectView {
      store.schedules[projectPath] = { ...spec, setBy: by, setAt: iso(deps.now()) };
      done();
      return view(projectPath);
    },
    /** The window open now, if any, ends with it: nobody stopped, no queue paused (whoever clears it wants the agents left alone). */
    clearSchedule(projectPath: string, by: string): FleetProjectView {
      delete store.schedules[projectPath];
      const rec = store.windows[projectPath];
      if (isOpen(rec)) {
        rec.closedAt = iso(deps.now());
        rec.ended = 'cleared';
      }
      if (rec?.stopping.length) {
        rec.leftRunning.push(...rec.stopping.map((x) => ({ agent: x.agent, why: `the hours were cleared by ${by} before its turn ended` })));
        rec.stopping = [];
      }
      console.log(`[fleet] ${projectPath}: its hours cleared by ${by}`);
      done();
      return view(projectPath);
    },
    setCap(projectPath: string, cap: number | null, by: string): FleetProjectView {
      if (cap === null) delete store.caps[projectPath];
      else store.caps[projectPath] = { cap, setBy: by, setAt: iso(deps.now()) };
      console.log(`[fleet] ${projectPath}: cap ${cap === null ? 'removed' : `set to ${cap}`} by ${by}`);
      done();
      return view(projectPath);
    },
    capOf(projectPath: string): number | undefined {
      return store.caps[projectPath]?.cap;
    },
    view,
    views(): FleetProjectView[] {
      const projects = new Set([...Object.keys(store.schedules), ...Object.keys(store.caps), ...Object.keys(store.windows)]);
      return [...projects].sort().map(view);
    },
    openWindows(): ScheduledWindow[] {
      return Object.entries(store.windows).filter(([, rec]) => isOpen(rec)).map(([projectPath, rec]) => ({ projectPath, until: rec.end }));
    },
    tick,
    /** The computer goes to sleep: said on every open window. */
    noteSuspend(): void {
      const open = Object.values(store.windows).filter(isOpen);
      if (!open.length) return;
      for (const rec of open) rec.slept.push({ at: iso(deps.now()) });
      done();
    },
    /** It woke: the sleep each window recorded ends now, a window closed meanwhile included. */
    noteResume(): void {
      let moved = false;
      for (const rec of Object.values(store.windows)) {
        const last = rec.slept.at(-1);
        if (last && !last.wokeAt) {
          last.wokeAt = iso(deps.now());
          moved = true;
        }
      }
      if (moved) done();
    },
  };
}

export type FleetOperations = ReturnType<typeof createFleetOperations>;

let current: FleetOperations | undefined;
/** The one for the process, set by main.ts at launch: the routes, the window and the cap read it. */
export function setFleetOperations(ops: FleetOperations | undefined): void {
  current = ops;
}
export function fleetOperations(): FleetOperations | undefined {
  return current;
}

export type GovernCaller = { kind: 'tars' } | { kind: 'agent'; agent: { id: string; role?: string; kind?: string; projectPath: string } };

/**
 * Who sets a project's hours and cap: Tars's own pass (the owner's super chat) and the project's own orchestrator; the
 * window reaches them over IPC with nobody's right to check. Never a worker, a chat's runner, another project's
 * orchestrator (allowCrossProject is a guard against mistakes, not a right: SECURITY.md), or a caller with no identity.
 * The owner's grants between projects (Settings) are the one way another project's orchestrator ever will: they plug in
 * here once both changes are in.
 */
export function governRight(caller: GovernCaller | undefined, projectPath: string): { ok: true } | { ok: false; reason: string } {
  if (caller?.kind === 'tars') return { ok: true };
  if (caller?.kind === 'agent' && isProjectOrchestrator(caller.agent) && caller.agent.projectPath === projectPath) return { ok: true };
  return {
    ok: false,
    reason: "Only the project's own orchestrator, and the owner in the window, set a project's hours and its cap.",
  };
}
