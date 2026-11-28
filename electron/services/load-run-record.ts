import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { LoadHarness, LoadSplit, LoadWindowParams, PlannedArrival, RefusedLine } from './load-pool';

/**
 * A load window's run record (trace feature C3, 27/11): `~/.tars/load-runs/<run>/run.json`, beside the snapshot of
 * the pool as approved (`tasks.snapshot.jsonl`, its sha256 in the record). The run reads its tasks from the snapshot,
 * never from the live pool. The record keeps the window as approved, the arrivals planned from its seed and, as the
 * window runs, each arrival's actual time, task, harness, agent and session or why it was blocked, the load agents and
 * worktrees it used (cleanup works from them, never from a name pattern), and the reason it stopped.
 */

export const LOAD_STOP_REASONS = ['window_end', 'switch', 'disk_floor', 'error'] as const;
export type LoadStopReason = typeof LOAD_STOP_REASONS[number];
/** Why an arrival could not start: recorded and dropped, never queued. */
export const LOAD_BLOCK_REASONS = ['max_concurrent', 'busy_cap', 'heavy_slot', 'no_harness'] as const;
export type LoadBlockReason = typeof LOAD_BLOCK_REASONS[number];

export interface LoadRunTask {
  taskId: string;
  line: number;
  project: string;
  split: LoadSplit;
  train_ok: boolean;
  harnesses: LoadHarness[] | null;
  time_cap_min: number;
}

export interface LoadArrival {
  n: number;
  taskId: string;
  plannedAt: number;
  actualAt?: number;
  /** Why it did not start, when it did not. */
  blocked?: LoadBlockReason;
  /** What blocked it, in a line ("Load 2 was at work"), never a name of a person. */
  blockedDetail?: string;
  agentId?: string;
  harness?: LoadHarness;
  traceId?: string;
  endedAt?: number;
  /** How its session ended: done, at_cap (stopped at its time cap), stopped (the window stopped), error. */
  end?: 'done' | 'at_cap' | 'stopped' | 'error';
  /** Why it ended, in a line, when the end alone does not say it ("setup line 2 exited 1"); never a command's text. */
  endDetail?: string;
  /** What it does now, while it runs: its setup, its session, its test. */
  phase?: 'setup' | 'session' | 'test';
  /** Its setup lines' outcome, when it has any. */
  setup?: LoadSetupResult;
  /** Its session's own time, from its launch to its end: never the slot's wait, nor its setup's or its test's time. */
  sessionMs?: number;
  /** What its session changed in its worktree, from after its setup to its end (its setup's files and ignored ones not). */
  diffStat?: { files: number; insertions: number; deletions: number };
  /** Its test_cmd's outcome, once run; the time it waited for the heavy-run slot, apart from its session's. */
  test?: LoadTestResult;
}

/**
 * A task's test: passed, failed (with its exit code, or at its cap), or not run with why: `none` (no test_cmd),
 * `heavy_slot` (the slot not free within the task's cap), `stopped` (the window stopped): never a failure.
 */
export interface LoadTestResult { result: 'passed' | 'failed' | 'not_run'; reason?: string; exitCode?: number; atCap?: boolean; passed?: number; failed?: number; slotWaitMs?: number; durationMs?: number }

/** A task's setup: its lines passed, or the line that failed (its exit code) or reached the 10-minute cap, or a stop. */
export interface LoadSetupResult { result: 'passed' | 'failed' | 'at_cap' | 'stopped'; lines: number; line?: number; exitCode?: number; durationMs: number }

export interface LoadRunAgent { agentId: string; name: string; project: string; harness: LoadHarness; created: boolean }

export interface LoadRunRecord {
  version: 1;
  runId: string;
  pool: string;
  poolDir: string;
  /** When the pool's tasks.jsonl was written. */
  writtenAt: number;
  snapshotSha256: string;
  approvedAt: number;
  approvedBy: 'owner';
  window: LoadWindowParams;
  endsAt: number;
  tasks: LoadRunTask[];
  refused: RefusedLine[];
  refusedProjects: Array<{ path: string; reason: string; tasks: number }>;
  planned: Array<PlannedArrival & { plannedAt: number }>;
  arrivals: LoadArrival[];
  agents: LoadRunAgent[];
  /** Each worktree a task ran in, as made: what cleanup removes, and nothing else. */
  worktrees: Array<{ project: string; path: string; branch: string; taskId: string; removedAt?: number }>;
  stop?: { reason: LoadStopReason; at: number; detail?: string };
}

export const SNAPSHOT_FILE = 'tasks.snapshot.jsonl';
const RECORD_FILE = 'run.json';
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** A run's id: its approval's UTC date and time, and four hex digits (`20261127-140612-a1b2`): safe in a branch name. */
export function newRunId(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;
}

function writeRecord(dir: string, record: LoadRunRecord): void {
  const file = path.join(dir, RECORD_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** A new run: its folder, the snapshot's bytes as approved (written once), and its record. Throws when it cannot. */
export function createRun(runsDir: string, record: LoadRunRecord, snapshot: Buffer): void {
  if (!RUN_ID.test(record.runId)) throw new Error(`not a run id: ${record.runId}`);
  const dir = path.join(runsDir, record.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), snapshot, { flag: 'wx' });
  writeRecord(dir, record);
}

/** A run's record, or undefined. */
export function readRun(runsDir: string, runId: string): LoadRunRecord | undefined {
  if (!RUN_ID.test(runId)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, RECORD_FILE), 'utf8')) as LoadRunRecord;
  } catch {
    return undefined;
  }
}

/** The snapshot's bytes, as approved. */
export function readSnapshot(runsDir: string, runId: string): Buffer | undefined {
  if (!RUN_ID.test(runId)) return undefined;
  try { return fs.readFileSync(path.join(runsDir, runId, SNAPSHOT_FILE)); } catch { return undefined; }
}

/** Every run's record, newest approval first. */
export function listRuns(runsDir: string): LoadRunRecord[] {
  let names: string[];
  try { names = fs.readdirSync(runsDir); } catch { return []; }
  return names.filter(n => RUN_ID.test(n)).map(n => readRun(runsDir, n)).filter((r): r is LoadRunRecord => !!r)
    .sort((a, b) => b.approvedAt - a.approvedAt);
}

/** A run's record changed and written back whole. Undefined when there is no such run. */
export function updateRun(runsDir: string, runId: string, change: (r: LoadRunRecord) => LoadRunRecord): LoadRunRecord | undefined {
  const current = readRun(runsDir, runId);
  if (!current) return undefined;
  const next = change(current);
  writeRecord(path.join(runsDir, runId), next);
  return next;
}
