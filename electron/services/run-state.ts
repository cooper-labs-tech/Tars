import * as fs from 'fs';
import * as os from 'os';
import { privatePath } from '../constants';
import { processExists } from '../platform/process-exists';
import { processStartOf, windowsProcessCreatedAt } from '../platform/process-start';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * Whether the last run of Tars ended abruptly, and who was working when it did
 * (RD-REDEMARRAGE.md, 2.2; approved by JeanBrasse on 2026-10-05).
 *
 * agents.json cannot say: it saves a working agent as idle, and a crash leaves
 * it as the last save had it. So a run marks its start here, keeps the state of
 * the agents that work as it changes, and marks a clean end at the quit. A
 * record still open at the next launch is a run that ended abruptly: a crash,
 * a kill, a power cut or a reboot that did not quit Tars.
 *
 * In ~/.tars-private (0600), which no agent is handed: in ~/.dorothy, a record
 * any agent wrote made Tars start, at the next launch, whatever agents it
 * named, at-rest ones of any project included (the Audit's gate of #310).
 *
 * An open record is also what a Tars that still runs leaves: the
 * single-instance lock, where it is held, is per profile
 * (core/desktop-lifecycle.ts), so a second Tars can start on the same home
 * (the Audit's M1 on #418). The record's run ended unless the process under
 * its pid is the one that wrote it: alive, the machine not rebooted since, and
 * started when the record says (a crashed Tars's pid can be taken by any
 * process of the user, the Audit's Low on that fix). Otherwise this is the
 * second Tars: it reads no previous run, so it reports no abrupt end and
 * resumes nobody, and it leaves the record to the first.
 *
 * On Windows, where reading this run's own start would hold the first window
 * back (platform/process-start.ts), the same is judged by when the process
 * under the pid was created: the Tars held its pid from its creation to its
 * end, so it was created before its record was opened, and a process that
 * took the pid after (2.0.4; until then win32 took any live pid for a reused
 * one, and a second Tars on another profile read a false abrupt end).
 */

export const RUN_STATE_FILE = privatePath('run-state.json');

export interface WorkingRecord {
  agentId: string;
  status: 'running' | 'waiting';
  waitingReason?: string;
  sessionId?: string;
  task?: string;
  turnStartedAt?: string;
}

export interface PreviousRun {
  /** Epoch ms. */
  startedAt: number;
  /** The last moment it was heard of: where it stopped, as near as can be told. */
  lastWriteAt: number;
  working: WorkingRecord[];
  /** It resumed agents and stopped again within two minutes: not a reason to resume them again. */
  resumedAndCrashedAgain: boolean;
  /** The version of Tars that ran, `2.0.2`; null for a record written before 2.0.3. */
  version: string | null;
}

interface RunRecord {
  version: 1;
  /** The app's version, for the report of an abrupt end (services/health/abrupt-end.ts). */
  appVersion?: string;
  pid: number;
  /** When that pid's process started, as the OS says it: what tells it from a process that took its pid. */
  processStart?: string;
  startedAt: number;
  lastWriteAt: number;
  cleanExit: boolean;
  resumed: string[];
  working: WorkingRecord[];
}

interface Options {
  file?: string;
  now?: () => number;
  pid?: number;
  /** The app's version, recorded with the run. */
  appVersion?: string;
  /** Whether a process of this user runs under a pid (platform/process-exists.ts). */
  isAlive?: (pid: number) => boolean;
  /** When the machine last booted, epoch ms. */
  bootedAt?: number;
  /** When the process under a pid started (platform/process-start.ts). */
  startOf?: (pid: number) => string | null;
  /** When the process under a pid was created, epoch ms: win32 (platform/process-start.ts). */
  createdAt?: (pid: number) => number | null;
  platform?: NodeJS.Platform;
}

/** Within this long of its start, a run that resumed agents and stopped is a loop, not a crash to recover from. */
const RESUME_LOOP_MS = 120_000;
const TASK_MAX = 200;

/** Working, for a restart: in a turn, or stopped mid-turn at a permission prompt or a question. */
export function isWorking(agent: { status: string; waitingReason?: string }): boolean {
  if (agent.status === 'running') return true;
  return agent.status === 'waiting' && agent.waitingReason !== 'idle';
}

let current: RunRecord | null = null;

function write(opts: Options): void {
  if (!current) return;
  current.lastWriteAt = (opts.now ?? Date.now)();
  try {
    writeSecretFileSync(opts.file ?? RUN_STATE_FILE, JSON.stringify(current));
  } catch (err) {
    console.warn('[run-state] could not write the run record:', (err as Error).message);
  }
}

function read(file: string): RunRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RunRecord> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.startedAt !== 'number' || typeof parsed.lastWriteAt !== 'number') return null;
    return {
      version: 1,
      ...(typeof parsed.appVersion === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/.test(parsed.appVersion) ? { appVersion: parsed.appVersion } : {}),
      pid: Number(parsed.pid) || 0,
      ...(typeof parsed.processStart === 'string' && parsed.processStart.length <= 64 ? { processStart: parsed.processStart } : {}),
      startedAt: parsed.startedAt,
      lastWriteAt: parsed.lastWriteAt,
      cleanExit: parsed.cleanExit === true,
      resumed: Array.isArray(parsed.resumed) ? parsed.resumed.filter((id): id is string => typeof id === 'string') : [],
      working: Array.isArray(parsed.working)
        ? parsed.working.filter((w): w is WorkingRecord => !!w && typeof w.agentId === 'string' && (w.status === 'running' || w.status === 'waiting'))
        : [],
    };
  } catch {
    return null;
  }
}

/** Whether the run of an open record is still going: its Tars runs, here, now. */
function stillRuns(previous: RunRecord, opts: Options, now: number): boolean {
  const own = opts.pid ?? process.pid;
  const windows = (opts.platform ?? process.platform) === 'win32';
  if (previous.pid <= 0 || previous.pid === own || (!windows && !previous.processStart)) return false;
  const bootedAt = opts.bootedAt ?? now - os.uptime() * 1000;
  if (bootedAt > previous.lastWriteAt) return false;
  if (!(opts.isAlive ?? processExists)(previous.pid)) return false;
  if (windows) {
    const created = (opts.createdAt ?? windowsProcessCreatedAt)(previous.pid);
    if (created === null) {
      console.warn(`[run-state] pid ${previous.pid} is alive and when it was created could not be read: taken for another Tars`);
      return true;
    }
    return created <= previous.startedAt;
  }
  const start = (opts.startOf ?? processStartOf)(previous.pid);
  if (start === null) {
    console.warn(`[run-state] pid ${previous.pid} is alive and when it started could not be read: taken for another Tars`);
    return true;
  }
  return start === previous.processStart;
}

/**
 * Reads how the last run ended, then opens this one. Null when it ended
 * cleanly, when there was none, or when its record cannot be read: only a
 * record that is known to be open means a crash. Null too when its Tars still
 * runs: then this run keeps no record (see above).
 */
export function beginRun(opts: Options = {}): PreviousRun | null {
  const file = opts.file ?? RUN_STATE_FILE;
  const now = (opts.now ?? Date.now)();
  const previous = read(file);
  if (previous && !previous.cleanExit && stillRuns(previous, opts, now)) {
    console.warn(`[run-state] another Tars (pid ${previous.pid}) runs on this home: no abrupt end read, nothing resumed, its record left to it`);
    current = null;
    return null;
  }
  current = {
    version: 1, ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    pid: opts.pid ?? process.pid, startedAt: now, lastWriteAt: now, cleanExit: false, resumed: [], working: [],
  };
  const ownStart = (opts.platform ?? process.platform) === 'win32' ? null : (opts.startOf ?? processStartOf)(current.pid);
  if (ownStart) current.processStart = ownStart;
  write(opts);
  if (!previous || previous.cleanExit) return null;
  return {
    startedAt: previous.startedAt,
    lastWriteAt: previous.lastWriteAt,
    working: previous.working,
    resumedAndCrashedAgain: previous.resumed.length > 0 && previous.lastWriteAt - previous.startedAt < RESUME_LOOP_MS,
    version: previous.appVersion ?? null,
  };
}

/** The agents as they are now: only the working ones are kept. */
export function recordRun(
  agents: Iterable<{ id: string; status: string; waitingReason?: string; currentSessionId?: string; currentTask?: string; lastTurnStartedAt?: string }>,
  opts: Options = {},
): void {
  if (!current) return;
  current.working = [...agents].filter(isWorking).map((a) => ({
    agentId: a.id,
    status: a.status as 'running' | 'waiting',
    ...(a.waitingReason ? { waitingReason: a.waitingReason } : {}),
    ...(a.currentSessionId ? { sessionId: a.currentSessionId } : {}),
    ...(a.currentTask ? { task: Array.from(a.currentTask).slice(0, TASK_MAX).join('') } : {}),
    ...(a.lastTurnStartedAt ? { turnStartedAt: a.lastTurnStartedAt } : {}),
  }));
  write(opts);
}

/** The agents this run resumed after a crash. */
export function recordResumed(ids: string[], opts: Options = {}): void {
  if (!current) return;
  current.resumed = [...new Set([...current.resumed, ...ids])];
  write(opts);
}

/** A clean end: the next launch resumes nobody. */
export function endRun(opts: Options = {}): void {
  if (!current) return;
  current.cleanExit = true;
  write(opts);
}
