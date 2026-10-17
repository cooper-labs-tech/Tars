import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 * And from the Audit's M1 on #418 (2026-10-15): macOS and Linux hold no single-instance lock, so a second Tars can run
 * on the same home (Linux: any second launch; macOS: open -n, another copy, a dev run on the real home).
 * 8. A Tars that still runs is read as one that ended abruptly: a false report, and its working agents resumed by the
 *    second Tars while the first still runs them.
 * 9. The second Tars takes the record over: the first's working agents, its clean quit or its crash are then lost.
 * 10. Over-correction: a crash before a reboot is missed because, after the reboot, another process took its pid.
 * 11. Over-correction: the record names this very process's pid (reused after a reboot) and reads as another Tars.
 * 12. Over-correction: a record with no pid reads as a running Tars, and its crash is never reported.
 * And from the Audit's Low on that fix: a live pid is not always a Tars.
 * 13. The crashed Tars's pid taken by a long-lived process of the user reads as another Tars: until that process ends,
 *     every launch keeps no record, resumes nothing and reports nothing. A live pid is another Tars only if the
 *     process under it started when the record's did.
 * 14. A record written before the start was kept (2.0.2) reads as another Tars whenever its pid lives.
 * 15. A live pid whose start cannot be read now is taken for a crash: the agents are resumed twice. Unknown stays
 *     "another Tars", and it is said.
 * 16. win32 reads a live pid as another Tars: the lock ends a second Tars before it reads the record, so there it is
 *     always a reused pid.
 * 17. The record does not keep when this run's process started, so the next launch cannot compare.
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

  describe('a second Tars on the same home', () => {
    const FIRST = 100;
    const SECOND = 200;
    const FIRST_START = 'darwin:Thu Oct  5 01:00:00 2026';
    const firstRecord = () => JSON.stringify({
      version: 1, appVersion: '2.0.3', pid: FIRST, processStart: FIRST_START, startedAt: T0, lastWriteAt: T0 + 30_000, cleanExit: false, resumed: [],
      working: [{ agentId: 'w', status: 'running', sessionId: 'sess-w' }],
    });
    /** The pids alive now, and when the process under each started. */
    const second = (alive: number[], bootedAt = T0 - 86_400_000, pid = SECOND, starts: Record<number, string | null> = { [FIRST]: FIRST_START, [SECOND]: 'darwin:Thu Oct  5 01:01:00 2026' }) =>
      ({ file, now: () => clock, pid, bootedAt, platform: 'darwin' as NodeJS.Platform, isAlive: (p: number) => alive.includes(p), startOf: (p: number) => (p in starts ? starts[p] : null) });

    it('8-9. while the first runs: no abrupt end, and its record stays its own', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 60_000;
      expect(beginRun(second([FIRST]))).toBeNull();
      recordRun([agent('x', 'running')], second([FIRST]));
      recordResumed(['x'], second([FIRST]));
      endRun(second([FIRST]));
      expect(fs.readFileSync(file, 'utf8')).toBe(firstRecord());
    });

    it('8. once the first is gone, its run ended abruptly', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 60_000;
      expect(beginRun(second([]))).toMatchObject({ startedAt: T0, lastWriteAt: T0 + 30_000, working: [{ agentId: 'w' }] });
    });

    it('10. a reboot since its last write: it ended, whoever holds its pid now', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 3_600_000;
      expect(beginRun(second([FIRST], T0 + 60_000))).toMatchObject({ startedAt: T0 });
    });

    it('11. its pid is this process: it ended', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 60_000;
      expect(beginRun(second([FIRST], undefined, FIRST))).toMatchObject({ startedAt: T0 });
    });

    it('13. its pid alive under a process that started later: it ended, and this run keeps its own record', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 3_600_000;
      expect(beginRun(second([FIRST], undefined, SECOND, { [FIRST]: 'darwin:Thu Oct  5 01:20:00 2026', [SECOND]: 'darwin:Thu Oct  5 02:00:00 2026' }))).toMatchObject({ startedAt: T0 });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: SECOND, startedAt: T0 + 3_600_000 });
    });

    it('14. a record that does not say when its process started: it ended, whether its pid\'s start can be read or not', () => {
      const old = firstRecord().replace(`"processStart":"${FIRST_START}",`, '');
      fs.writeFileSync(file, old);
      clock = T0 + 60_000;
      expect(beginRun(second([FIRST]))).toMatchObject({ startedAt: T0 });
      fs.writeFileSync(file, old);
      expect(beginRun(second([FIRST], undefined, SECOND, { [SECOND]: 'darwin:Thu Oct  5 01:01:00 2026' }))).toMatchObject({ startedAt: T0 });
    });

    it('15. a live pid whose start cannot be read now: another Tars, and it is said', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 60_000;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(beginRun(second([FIRST], undefined, SECOND, { [SECOND]: 'darwin:Thu Oct  5 01:01:00 2026' }))).toBeNull();
        expect(fs.readFileSync(file, 'utf8')).toBe(firstRecord());
        expect(warn.mock.calls.flat().join(' ')).toMatch(/could not be read/);
      } finally {
        warn.mockRestore();
      }
    });

    it('16. win32: a live pid is a reused one, never another Tars', () => {
      fs.writeFileSync(file, firstRecord());
      clock = T0 + 60_000;
      expect(beginRun({ ...second([FIRST]), platform: 'win32' as NodeJS.Platform })).toMatchObject({ startedAt: T0 });
    });

    it('17. the record keeps when this run\'s process started', () => {
      clock = T0;
      beginRun(second([], undefined, SECOND));
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ pid: SECOND, processStart: 'darwin:Thu Oct  5 01:01:00 2026' });
    });

    it('12. a record with no pid: it ended, and nobody is asked', () => {
      fs.writeFileSync(file, firstRecord().replace(`"pid":${FIRST}`, '"pid":0'));
      clock = T0 + 60_000;
      const asked: number[] = [];
      expect(beginRun({ ...second([]), isAlive: (p: number) => { asked.push(p); return true; } })).toMatchObject({ startedAt: T0 });
      expect(asked).toEqual([]);
    });
  });

  it("6. a task's text is cut to 200 characters", () => {
    beginRun(opts());
    recordRun([agent('w', 'running', { currentTask: 'y'.repeat(500) })], opts());
    expect(beginRun(opts())!.working[0].task).toHaveLength(200);
  });
});
