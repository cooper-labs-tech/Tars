import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFleetOperations, governRight, RESTART_PAUSE, type FleetAgent, type FleetDeps,
} from '../../../electron/services/fleet-operations';
import type { PowerReading } from '../../../electron/services/power-state';

/**
 * A project's hours and its cap, run by Tars (services/fleet-operations.ts, 2.0.7, for an orchestrator running another
 * project's agents in a nightly window on an OpenAI-compatible endpoint): at the start, the queues the last stop paused go again
 * (and the agents are started, when asked); at the stop, every queue is paused and every agent stopped once its turn
 * has ended, never in the middle of one. Kept in ~/.tars-private, so a restart of Tars finds it, and the window reads
 * what is scheduled and what the last window did.
 *
 * How it fails, written before the code:
 * 1. A schedule or a cap set is not read back by a new engine on the same file (a restart of Tars); a file of another
 *    shape is read as schedules, or throws.
 * 2. At its start the window does not open; the queues the last stop paused are not resumed; a queue paused by the
 *    owner (or anyone else) is resumed.
 * 3. A queue paused by a restart of Tars ('Tars restarted') is not resumed when the window opens, so a night's work
 *    waits for a person; or one is resumed outside the window.
 * 4. start-agents: an agent at rest with no CLI is not started; one the owner stopped is started; one with work in
 *    its queue is started beside that work (two launches); one with its CLI up is started again.
 * 5. Two ticks inside the same window open it twice (resume or start twice), and so does a new engine inside it.
 * 6. At its stop: a queue is left unpaused (a task handed at 06:00 would start); a queue paused by someone else gets
 *    the schedule's reason (and would be resumed at the next start); an agent at rest is not stopped; an agent at
 *    work is stopped, its turn cut.
 * 7. The agent at work is not stopped once its turn ends, or its pending stop is lost by a restart of Tars.
 * 8. A CLI that never says its turn ended is stopped (its work cut), or nothing says why it was left running.
 * 9. The next window begins while a stop still waits on a turn, and the stop goes on to cut the next night's work.
 * 10. Tars down at the start and up inside the window opens it without saying it was late; down at the stop and up
 *     after it does not close it.
 * 11. A warning is said twice in one window, or not said in the next; the power is read while no window is open.
 * 12. A sleep of the computer during an open window is not recorded, with its wake.
 * 13. Clearing a schedule while its window is open stops agents, or leaves the window open.
 * 14. A worker, a chat's runner, another project's orchestrator, or a caller with no identity sets a project's hours
 *     or cap; the project's orchestrator, or Tars, is refused.
 */

const P = '/projects/project-a';
const NIGHT = { start: '18:00', stop: '04:00', timeZone: 'UTC' as const, onStart: 'resume-queues' as const };

interface World {
  now: number;
  agents: FleetAgent[];
  pauses: Map<string, { why: string }>;
  started: string[];
  stops: Array<{ id: string; reason: string }>;
  power: PowerReading;
  powerReads: number;
  mode: 'while-working' | 'always' | 'never';
  changed: number;
}

let dir: string;
let file: string;
let world: World;

const agent = (id: string, more: Partial<FleetAgent> = {}): FleetAgent => ({
  id, name: id.toUpperCase(), projectPath: P, status: 'idle', atWork: false, endOfTurn: true, cliUp: true, queued: 0, ...more,
});
const find = (id: string) => world.agents.find((a) => a.id === id)!;

function deps(): FleetDeps {
  let n = 0;
  return {
    file,
    now: () => world.now,
    agents: () => world.agents,
    queue: {
      pausedOf: (id) => world.pauses.get(id),
      pause: (id, why) => { world.pauses.set(id, { why }); },
      resume: (id) => { world.pauses.delete(id); },
    },
    stop: async (id, reason) => {
      const a = find(id);
      if (a.status === 'stopped') return undefined;
      world.stops.push({ id, reason });
      a.status = 'stopped';
      a.cliUp = false;
      a.stoppedBy = 'Tars';
      a.stoppedAt = `stopped-${++n}`;
      return a.stoppedAt;
    },
    start: async (id) => {
      world.started.push(id);
      const a = find(id);
      a.status = 'idle';
      a.cliUp = true;
      a.stoppedBy = undefined;
      a.stoppedAt = undefined;
      return { ok: true };
    },
    power: async () => { world.powerReads++; return world.power; },
    keepAwake: () => ({ mode: world.mode }),
    changed: () => { world.changed++; },
  };
}

const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ops-'));
  file = path.join(dir, 'fleet-operations.json');
  world = {
    now: at('2026-11-19T11:00:00Z'), agents: [agent('a'), agent('b')], pauses: new Map(), started: [], stops: [],
    power: { battery: false, lidClosed: false, externalDisplay: false }, powerReads: 0, mode: 'while-working', changed: 0,
  };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store', () => {
  it('1. reads back a schedule and a cap after a restart, and ignores a file of another shape', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'Lead A');
    ops.setCap(P, 4, 'you');
    const again = createFleetOperations(deps());
    expect(again.view(P).schedule).toMatchObject({ ...NIGHT, setBy: 'Lead A', line: 'every day from 18:00 to 04:00 UTC' });
    expect(again.capOf(P)).toBe(4);
    expect(again.view(P).cap).toMatchObject({ cap: 4, setBy: 'you' });
    again.setCap(P, null, 'you');
    expect(createFleetOperations(deps()).capOf(P)).toBeUndefined();
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe(process.platform === 'win32' ? expect.any(String) : '600');

    fs.writeFileSync(file, JSON.stringify({ version: 1, schedules: { [P]: { start: 'soon' } }, caps: { [P]: 'many' } }));
    const odd = createFleetOperations(deps());
    expect(odd.view(P).schedule).toBeUndefined();
    expect(odd.capOf(P)).toBeUndefined();
    fs.writeFileSync(file, '{ not json');
    expect(() => createFleetOperations(deps())).not.toThrow();
  });
});

describe('a window', () => {
  it('2 and 6. at the stop, every queue is paused and every agent at rest stopped; at the start, only those queues go again', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    // The owner's own pause on c, set before anything.
    world.agents.push(agent('c'));
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    expect(ops.view(P).window).toMatchObject({ start: '2026-11-19T18:00:00.000Z', end: '2026-11-20T04:00:00.000Z' });
    expect(ops.view(P).window?.closedAt).toBeUndefined();
    world.pauses.set('c', { why: 'paused by you: reviewing' });

    world.now = at('2026-11-20T04:00:00Z');
    await ops.tick();
    const closed = ops.view(P).window!;
    expect(closed.closedAt).toBe('2026-11-20T04:00:00.000Z');
    expect(world.pauses.get('a')?.why).toMatch(/outside its project's hours/);
    expect(world.pauses.get('b')?.why).toMatch(/outside its project's hours/);
    expect(world.pauses.get('c')?.why).toBe('paused by you: reviewing');
    expect(world.stops.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
    expect(world.stops[0].reason).toMatch(/the end of its project's hours/);
    expect(closed.stopped.map((s) => s.agent).sort()).toEqual(['A', 'B', 'C']);

    world.now = at('2026-11-20T18:00:00Z');
    await ops.tick();
    expect(world.pauses.has('a')).toBe(false);
    expect(world.pauses.has('b')).toBe(false);
    expect(world.pauses.get('c')?.why).toBe('paused by you: reviewing');
    expect(ops.view(P).window?.resumed.sort()).toEqual(['A', 'B']);
    // resume-queues starts nobody: their work does.
    expect(world.started).toEqual([]);
  });

  it("3. a queue paused by a restart of Tars goes again when the window opens, never outside it", async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    world.pauses.set('a', { why: RESTART_PAUSE });
    await ops.tick();
    expect(world.pauses.get('a')?.why).toBe(RESTART_PAUSE);
    world.now = at('2026-11-19T18:00:30Z');
    await ops.tick();
    expect(world.pauses.has('a')).toBe(false);
    // A restart inside the window pauses it again: the next engine resumes it.
    world.pauses.set('a', { why: RESTART_PAUSE });
    world.now = at('2026-11-19T22:00:00Z');
    await createFleetOperations(deps()).tick();
    expect(world.pauses.has('a')).toBe(false);
  });

  it('4. start-agents starts the agents at rest, never one the owner stopped, one with work queued, or one already up', async () => {
    world.agents = [
      agent('rest', { cliUp: false, status: 'asleep' }),
      agent('owners', { cliUp: false, status: 'stopped', stoppedBy: 'you', stoppedAt: 'x' }),
      agent('work', { cliUp: false, queued: 1 }),
      agent('up', { cliUp: true }),
    ];
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, { ...NIGHT, onStart: 'start-agents' }, 'you');
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    expect(world.started).toEqual(['rest']);
    expect(ops.view(P).window?.started).toEqual(['REST']);

    // The schedule's own stop is undone at the next start.
    world.now = at('2026-11-20T04:00:00Z');
    await ops.tick();
    expect(find('up').status).toBe('stopped');
    world.started = [];
    world.agents.find((a) => a.id === 'work')!.queued = 0;
    world.now = at('2026-11-20T18:00:00Z');
    await ops.tick();
    expect(world.started.sort()).toEqual(['rest', 'up', 'work']);
    expect(find('owners').status).toBe('stopped');
  });

  it('5. a window is opened once, across ticks and across a restart', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, { ...NIGHT, onStart: 'start-agents' }, 'you');
    world.agents = [agent('a', { cliUp: false })];
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    world.agents[0].cliUp = false;
    world.now = at('2026-11-19T18:30:00Z');
    await ops.tick();
    world.now = at('2026-11-19T19:00:00Z');
    await createFleetOperations(deps()).tick();
    expect(world.started).toEqual(['a']);
  });

  it('6 and 7. an agent at work is stopped only once its turn has ended, even across a restart', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    find('a').atWork = true;
    world.now = at('2026-11-20T04:00:00Z');
    await ops.tick();
    expect(world.stops.map((s) => s.id)).toEqual(['b']);
    expect(ops.view(P).window?.stopping).toEqual([{ id: 'a', agent: 'A' }]);
    expect(world.pauses.get('a')?.why).toMatch(/outside its project's hours/);

    world.now = at('2026-11-20T04:10:00Z');
    await ops.tick();
    expect(world.stops.map((s) => s.id)).toEqual(['b']);

    // Tars restarts while the turn goes on; the turn ends after.
    const after = createFleetOperations(deps());
    find('a').atWork = false;
    world.now = at('2026-11-20T04:20:00Z');
    await after.tick();
    expect(world.stops.map((s) => s.id)).toEqual(['b', 'a']);
    expect(after.view(P).window?.stopping).toEqual([]);
    expect(after.view(P).window?.stopped.find((s) => s.id === 'a')).toMatchObject({ agent: 'A', afterTurn: true });
  });

  it('8. a CLI that never says its turn ended is left running, its queue paused, and why is said', async () => {
    world.agents = [agent('pi', { endOfTurn: false, cliUp: true, status: 'running' })];
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    world.now = at('2026-11-20T04:00:00Z');
    await ops.tick();
    expect(world.stops).toEqual([]);
    expect(world.pauses.get('pi')?.why).toMatch(/outside its project's hours/);
    expect(ops.view(P).window?.leftRunning).toEqual([{ agent: 'PI', why: expect.stringMatching(/does not tell Tars when its turn ends/) }]);
  });

  it('9. a stop still waiting on a turn when the next window begins is given up', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, { start: '18:00', stop: '19:00', timeZone: 'UTC', onStart: 'resume-queues' }, 'you');
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    find('a').atWork = true;
    world.now = at('2026-11-19T19:00:00Z');
    await ops.tick();
    const first = ops.view(P).window!;
    expect(first.stopping).toHaveLength(1);
    world.now = at('2026-11-20T18:00:00Z');
    await ops.tick();
    find('a').atWork = false;
    world.now = at('2026-11-20T18:05:00Z');
    await ops.tick();
    expect(world.stops.map((s) => s.id)).toEqual(['b']);
    expect(ops.view(P).window?.closedAt).toBeUndefined();
  });

  it('10. a window opened late, or closed late, says so', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    world.now = at('2026-11-19T20:13:00Z');
    await ops.tick();
    expect(ops.view(P).window).toMatchObject({ openedAt: '2026-11-19T20:13:00.000Z', late: expect.stringMatching(/after its start/) });
    world.now = at('2026-11-20T07:00:00Z');
    await createFleetOperations(deps()).tick();
    const closed = createFleetOperations(deps()).view(P).window!;
    expect(closed).toMatchObject({ closedAt: '2026-11-20T07:00:00.000Z', closedLate: expect.stringMatching(/after its stop/) });
    expect(world.stops.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('11. each warning is said once a window, again in the next, and the power is read only in a window', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, { start: '18:00', stop: '19:00', timeZone: 'UTC', onStart: 'resume-queues' }, 'you');
    await ops.tick();
    expect(world.powerReads).toBe(0);
    world.power = { battery: true, lidClosed: 'unknown', externalDisplay: 'unknown' };
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    world.now = at('2026-11-19T18:30:00Z');
    await ops.tick();
    expect(ops.view(P).window?.warnings.map((w) => w.kind)).toEqual(['battery', 'unknown-lid']);
    world.now = at('2026-11-19T20:00:00Z');
    const reads = world.powerReads;
    await ops.tick();
    expect(world.powerReads).toBe(reads);
    world.now = at('2026-11-20T18:00:00Z');
    await ops.tick();
    expect(ops.view(P).window?.warnings.map((w) => w.kind)).toEqual(['battery', 'unknown-lid']);
  });

  it('12. a sleep of the computer during a window is recorded with its wake', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    ops.noteSuspend();
    expect(ops.view(P).window).toBeUndefined();
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    world.now = at('2026-11-20T01:13:00Z');
    ops.noteSuspend();
    world.now = at('2026-11-20T01:40:00Z');
    ops.noteResume();
    expect(ops.view(P).window?.slept).toEqual([{ at: '2026-11-20T01:13:00.000Z', wokeAt: '2026-11-20T01:40:00.000Z' }]);
  });

  it('13. clearing a schedule during its window ends the window and stops nobody', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    ops.clearSchedule(P, 'you');
    await ops.tick();
    expect(ops.view(P).schedule).toBeUndefined();
    expect(ops.view(P).window).toMatchObject({ closedAt: '2026-11-19T18:00:00.000Z', ended: 'cleared' });
    expect(ops.openWindows()).toEqual([]);
    expect(world.stops).toEqual([]);
    expect(world.pauses.size).toBe(0);
  });

  it('keeps the computer awake for the open windows only', async () => {
    const ops = createFleetOperations(deps());
    ops.setSchedule(P, NIGHT, 'you');
    await ops.tick();
    expect(ops.openWindows()).toEqual([]);
    world.now = at('2026-11-19T18:00:00Z');
    await ops.tick();
    expect(ops.openWindows()).toEqual([{ projectPath: P, until: '2026-11-20T04:00:00.000Z' }]);
  });
});

describe('governRight', () => {
  const member = (role: string, projectPath = P, kind?: string) => ({ kind: 'agent' as const, agent: { id: 'x', role, projectPath, ...(kind ? { kind } : {}) } });

  it("14. only the project's orchestrator, Tars and the window set a project's hours and cap", () => {
    expect(governRight({ kind: 'tars' }, P)).toEqual({ ok: true });
    expect(governRight(member('orchestrator'), P)).toEqual({ ok: true });
    expect(governRight(member('worker'), P)).toMatchObject({ ok: false });
    expect(governRight(member('orchestrator', P, 'chat'), P)).toMatchObject({ ok: false });
    expect(governRight(member('orchestrator', '/projects/project-b'), P)).toMatchObject({ ok: false });
    expect(governRight(undefined, P)).toMatchObject({ ok: false });
  });
});
