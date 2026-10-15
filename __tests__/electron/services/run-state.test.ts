import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUN_STATE_FILE, beginRun, endRun, isWorking, recordResumed, recordRun } from '../../../electron/services/run-state';
import { PRIVATE_DIR } from '../../../electron/constants';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * Whether the last run of Tars ended abruptly, and who was working when it did (RD-REDEMARRAGE.md, 2.2; JeanBrasse's yes
 * of 2026-10-05). agents.json cannot say: it saves a working agent as idle, and a crash leaves it as the last save
 * had it. So a run marks its start, keeps the working agents' state as it changes, and marks a clean end.
 *
 * How it can fail, written before the code:
 * 1. A clean quit reads as a crash at the next launch (agents resumed after a normal quit), or a crash as clean
 *    (nobody resumed).
 * 2. The first launch ever reads as a crash, or a damaged record stops the launch or reads as one with garbage in it.
 * 3. Who was working is lost: the record keeps only idle agents, or keeps one that came to rest since; an agent
 *    mid-turn at a permission prompt or a question is not counted, or one waiting for its next prompt is.
 * 4. The crashed run's record is overwritten at launch before it is read, so a second launch reads the first as clean.
 * 5. A run that crashed again soon after resuming agents is resumed again, and again: a loop.
 * 6. The record carries more than it needs: a task's text past 200 characters.
 * 7. (the Audit's gate of #310) The record sits where an agent can write it (~/.dorothy, in every agent's --add-dir):
 *    a record an agent wrote makes Tars start, at the next launch, whatever agents it names, at-rest ones included.
 */

let file: string;
let clock: number;
const T0 = Date.UTC(2026, 9, 5, 1, 0, 0);
const opts = () => ({ file, now: () => clock, pid: 4242 });
const agent = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, status, currentSessionId: `sess-${id}`, currentTask: `task of ${id}`, lastTurnStartedAt: '2026-10-05T00:59:00.000Z', ...extra });

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-run-state-')), 'run-state.json');
  clock = T0;
});

afterEach(() => {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe('the run record', () => {
  it('7. lives in ~/.tars-private, which no agent is handed, readable by its owner alone', () => {
    expect(RUN_STATE_FILE).toBe(path.join(PRIVATE_DIR, 'run-state.json'));
    beginRun(opts());
    if (hasPosixModes()) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('1. a clean quit is not a crash, and a run that never ended is one, with when it was last heard of', () => {
    expect(beginRun(opts()), '2. the first launch ever').toBeNull();
    recordRun([agent('w', 'running')], opts());
    endRun(opts());

    clock += 60_000;
    expect(beginRun(opts())).toBeNull();
    clock += 5_000;
    recordRun([agent('w', 'running')], opts());
    clock += 5_000;

    clock += 3_600_000;
    const crashed = beginRun(opts());
    expect(crashed).toMatchObject({ startedAt: T0 + 60_000, lastWriteAt: T0 + 65_000 });
    expect(crashed!.working.map((w) => w.agentId)).toEqual(['w']);
  });

  it('2. a damaged record is neither a crash nor a stop', () => {
    fs.writeFileSync(file, '{"version":1,"pid":');
    expect(beginRun(opts())).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, cleanExit: false, startedAt: T0 });
  });

  it('3. keeps the working agents as they are now: running, or mid-turn at a prompt; not at rest', () => {
    expect([
      isWorking({ status: 'running' }), isWorking({ status: 'waiting', waitingReason: 'permission' }),
      isWorking({ status: 'waiting', waitingReason: 'question' }), isWorking({ status: 'waiting', waitingReason: 'idle' }),
      isWorking({ status: 'idle' }), isWorking({ status: 'stopped' }), isWorking({ status: 'error' }), isWorking({ status: 'completed' }),
    ]).toEqual([true, true, true, false, false, false, false, false]);

    beginRun(opts());
    recordRun([agent('a', 'running'), agent('b', 'waiting', { waitingReason: 'permission' }), agent('c', 'idle')], opts());
    recordRun([agent('a', 'idle'), agent('b', 'waiting', { waitingReason: 'permission' }), agent('c', 'idle')], opts());

    const crashed = beginRun(opts());
    expect(crashed!.working).toEqual([
      { agentId: 'b', status: 'waiting', waitingReason: 'permission', sessionId: 'sess-b', task: 'task of b', turnStartedAt: '2026-10-05T00:59:00.000Z' },
    ]);
  });

  it('4. a crash stays a crash for the launch after the one that read it, until that launch ends cleanly', () => {
    beginRun(opts());
    recordRun([agent('w', 'running')], opts());

    clock += 1_000;
    const first = beginRun(opts());
    clock += 1_000;
    const second = beginRun(opts());

    expect(first!.working.map((w) => w.agentId)).toEqual(['w']);
    expect(second, 'the launch that read the crash did not end cleanly either').not.toBeNull();
    expect(second!.working, 'and nobody worked in it').toEqual([]);
  });

  it('5. a run that resumed agents and crashed within two minutes is not a reason to resume them again', () => {
    beginRun(opts());
    recordRun([agent('w', 'running')], opts());
    clock += 10_000;
    beginRun(opts());
    recordResumed(['w'], opts());
    recordRun([agent('w', 'running')], opts());
    clock += 30_000;
    recordRun([agent('w', 'running')], opts());

    clock += 60_000;
    expect(beginRun(opts())).toMatchObject({ resumedAndCrashedAgain: true });

    beginRun(opts());
    recordResumed(['w'], opts());
    clock += 5 * 60_000;
    recordRun([agent('w', 'running')], opts());
    expect(beginRun(opts())).toMatchObject({ resumedAndCrashedAgain: false });
  });

  it("6. a task's text is cut to 200 characters", () => {
    beginRun(opts());
    recordRun([agent('w', 'running', { currentTask: 'y'.repeat(500) })], opts());
    expect(beginRun(opts())!.working[0].task).toHaveLength(200);
  });
});
