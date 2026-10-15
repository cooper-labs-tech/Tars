import * as fs from 'fs';
import { privatePath } from '../constants';
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
}

interface RunRecord {
  version: 1;
  pid: number;
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
      pid: Number(parsed.pid) || 0,
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

/**
 * Reads how the last run ended, then opens this one. Null when it ended
 * cleanly, when there was none, or when its record cannot be read: only a
 * record that is known to be open means a crash.
 */
export function beginRun(opts: Options = {}): PreviousRun | null {
  const file = opts.file ?? RUN_STATE_FILE;
  const now = (opts.now ?? Date.now)();
  const previous = read(file);
  current = { version: 1, pid: opts.pid ?? process.pid, startedAt: now, lastWriteAt: now, cleanExit: false, resumed: [], working: [] };
  write(opts);
  if (!previous || previous.cleanExit) return null;
  return {
    startedAt: previous.startedAt,
    lastWriteAt: previous.lastWriteAt,
    working: previous.working,
    resumedAndCrashedAgain: previous.resumed.length > 0 && previous.lastWriteAt - previous.startedAt < RESUME_LOOP_MS,
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
