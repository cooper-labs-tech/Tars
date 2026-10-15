import { describe, it, expect } from 'vitest';
import { factsOf, restPendingOf, sleepRefusal, waitsOnItself, SLEEP_AFTER_MS, type SleepFacts } from '../../../electron/services/agent-sleep';
import { agents } from '../../../electron/core/agent-manager';
import { enqueueRequest } from '../../../electron/core/task-requests';
import type { AgentStatus } from '../../../electron/types';
import type { Proc } from '../../../electron/services/stall-watch';

/**
 * Which agent is put to sleep: JeanBrasse's choices 5 and 6 of 2026-10-05, "an agent
 * with no turn for 30 minutes is put to sleep and woken on its own
 * conversation when it is needed; orchestrators are never put to sleep"
 * (RD-RAM.md, 2.1: 265 to 600 MB given back per agent).
 *
 * Asleep, its CLI and everything under it are ended. So the rule is about what
 * would be lost, and it refuses on any doubt.
 *
 * How it fails, written before the code:
 * 1. An orchestrator is put to sleep.
 * 2. An agent is put to sleep before 30 minutes without a turn: its status, its
 *    last turn or the last work handed to it is more recent, or the time is
 *    not known.
 * 3. An agent at work, in a dialog, in error, stopped, already asleep, with no
 *    CLI, or whose launch is on its way is put to sleep.
 * 4. An agent with something alive under its CLI other than its MCP servers (a
 *    background task, a dev server, a live caffeinate), or whose process table
 *    cannot be read, is put to sleep: what runs dies with it.
 * 5. An agent something is owed to (a held note or room message, a kanban
 *    note, an open question to the user), or that is owed news (work it handed
 *    out, background it left for its requester), is put to sleep: what is held
 *    is bound to its session and dropped with it.
 * 6. An agent whose field holds a draft, a queued write or a pause in typing is
 *    put to sleep: the draft is lost.
 * 7. An agent whose conversation cannot be resumed (no transcript, a CLI Tars
 *    cannot resume) is put to sleep: woken, it would start a new conversation.
 * 16. (QA's gate of #322) An agent waiting on its own timer (a ScheduleWakeup of
 *    /loop, a CronCreate) or on a background agent its CLI runs in-process is put
 *    to sleep: no process shows either, and both die with the CLI, silently. What
 *    its last Stop hook counted decides; a Stop hook that counted nothing (an
 *    older claude) leaves it to the transcript's background work; a count that
 *    is not one is not taken.
 * 17. (PR A, written with its code and shown to bite by a mutant) A requester whose request is still out at a
 *     worker, queued or written, is not owed anything, and is put to sleep before the answer comes.
 * 18. (PR D, written with its code and shown to bite by a mutant) A chat's runner put to sleep to free a slot,
 *     or because its chat was settled (`anyAge`), is held to the 30 minutes, so no slot is ever freed; or
 *     `anyAge` lets through what the other rules refuse.
 */

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const CLI = 4100;
const procs = (...extra: Proc[]): Proc[] => [
  { pid: CLI, ppid: 1, stat: 'S', age: 3000, command: '/usr/local/bin/claude --resume x' },
  { pid: 4101, ppid: CLI, stat: 'S', age: 3000, command: 'node /Applications/Tars.app/mcp-orchestrator/dist/bundle.js' },
  { pid: 4102, ppid: CLI, stat: 'Z', age: 2000, command: '(caffeinate)' },
  ...extra,
];

function facts(over: Partial<SleepFacts> = {}, agent: Partial<SleepFacts['agent']> = {}): SleepFacts {
  return {
    agent: { status: 'idle', statusSince: ago(40), lastTurnStartedAt: ago(42), workHandedAt: ago(43), ...agent },
    orchestrator: false,
    now: NOW,
    cliRunning: true,
    starting: false,
    resumable: true,
    owed: false,
    owes: false,
    pending: false,
    fieldInUse: false,
    procs: procs(),
    terminalPid: CLI,
    ...over,
  };
}

describe('the rule', () => {
  it('puts to sleep an agent at rest for 30 minutes and more, with nothing at stake', () => {
    expect(SLEEP_AFTER_MS).toBe(30 * 60_000);
    expect(sleepRefusal(facts())).toBeNull();
    expect(sleepRefusal(facts({}, { status: 'completed' }))).toBeNull();
    expect(sleepRefusal(facts({}, { status: 'waiting', waitingReason: 'idle' }))).toBeNull();
    // Exactly 30 minutes is 30 minutes without a turn.
    expect(sleepRefusal(facts({}, { statusSince: ago(30), lastTurnStartedAt: ago(30), workHandedAt: ago(30) }))).toBeNull();
  });

  it('1. never puts an orchestrator to sleep', () => {
    expect(sleepRefusal(facts({ orchestrator: true }))).toBe('orchestrator');
  });

  it('2. waits for 30 minutes since its status, its last turn and the last work handed to it, and refuses an unknown time', () => {
    expect(sleepRefusal(facts({}, { statusSince: ago(29) }))).toBe('recent');
    expect(sleepRefusal(facts({}, { lastTurnStartedAt: ago(10) }))).toBe('recent');
    expect(sleepRefusal(facts({}, { workHandedAt: ago(5) }))).toBe('recent');
    expect(sleepRefusal(facts({}, { statusSince: undefined }))).toBe('recent');
    expect(sleepRefusal(facts({}, { statusSince: 'not a time' }))).toBe('recent');
  });

  it('18. anyAge: every rule but the 30 minutes', () => {
    expect(sleepRefusal(facts({}, { statusSince: ago(1), lastTurnStartedAt: ago(1), workHandedAt: ago(1) }), { anyAge: true })).toBeNull();
    expect(sleepRefusal(facts({}, { statusSince: undefined }), { anyAge: true })).toBeNull();
    expect(sleepRefusal(facts({}, { statusSince: ago(1) }))).toBe('recent');
    expect(sleepRefusal(facts({ orchestrator: true }), { anyAge: true })).toBe('orchestrator');
    expect(sleepRefusal(facts({}, { status: 'running' }), { anyAge: true })).toBe('not-at-rest');
    expect(sleepRefusal(facts({ owes: true }), { anyAge: true })).toBe('owes');
    expect(sleepRefusal(facts({ fieldInUse: true }), { anyAge: true })).toBe('field');
    expect(sleepRefusal(facts({ resumable: false }), { anyAge: true })).toBe('not-resumable');
  });

  it('3. leaves alone an agent at work, in a dialog, in error, stopped, asleep, without a CLI, or starting', () => {
    for (const status of ['running', 'error', 'stopped', 'asleep'] as const) {
      expect(sleepRefusal(facts({}, { status })), status).toBe('not-at-rest');
    }
    expect(sleepRefusal(facts({}, { status: 'waiting', waitingReason: 'permission' }))).toBe('not-at-rest');
    expect(sleepRefusal(facts({}, { status: 'waiting' }))).toBe('not-at-rest');
    expect(sleepRefusal(facts({ cliRunning: false }))).toBe('no-cli');
    expect(sleepRefusal(facts({ starting: true }))).toBe('starting');
  });

  it('4. leaves alone an agent with something alive under its CLI, or when the process table says nothing', () => {
    const background = { pid: 4103, ppid: CLI, stat: 'S', age: 2500, command: '/bin/zsh -c npm run dev' };
    expect(sleepRefusal(facts({ procs: procs(background) }))).toBe('busy');
    // Deeper down, under a shell of its own.
    const shell = { pid: 4104, ppid: CLI, stat: 'S', age: 2500, command: '/bin/bash -c source snapshot && make' };
    const make = { pid: 4105, ppid: 4104, stat: 'S', age: 2500, command: 'make' };
    expect(sleepRefusal(facts({ procs: procs(shell, make) }))).toBe('busy');
    // A caffeinate renewed: its event loop is in a turn (stall-watch.ts, signOfLife).
    const caffeinate = { pid: 4106, ppid: CLI, stat: 'S', age: 40, command: 'caffeinate -i -t 300' };
    expect(sleepRefusal(facts({ procs: procs(caffeinate) }))).toBe('busy');
    expect(sleepRefusal(facts({ procs: undefined }))).toBe('no-process-table');
    expect(sleepRefusal(facts({ terminalPid: undefined }))).toBe('no-process-table');
    // The terminal's process is not in the table: nothing can be said of what runs there.
    expect(sleepRefusal(facts({ terminalPid: 9999 }))).toBe('no-process-table');
  });

  it('4. finds the CLI under the shell that started it, as a terminal opened from a window has it', () => {
    const shell = { pid: 4000, ppid: 1, stat: 'S', age: 3100, command: '/bin/bash -l' };
    const tree = procs().map(p => (p.pid === CLI ? { ...p, ppid: 4000 } : p));
    expect(sleepRefusal(facts({ procs: [shell, ...tree], terminalPid: 4000 }))).toBeNull();
  });

  it('5. leaves alone an agent something is owed to, or that is owed news', () => {
    expect(sleepRefusal(facts({ owed: true }))).toBe('owed');
    expect(sleepRefusal(facts({ owes: true }))).toBe('owes');
  });

  it('6. leaves alone an agent whose field is in use', () => {
    expect(sleepRefusal(facts({ fieldInUse: true }))).toBe('field');
  });

  it('7. leaves alone an agent whose conversation cannot be resumed', () => {
    expect(sleepRefusal(facts({ resumable: false }))).toBe('not-resumable');
  });
});

describe('what its CLI holds in-process', () => {
  it('16. leaves alone an agent waiting on its own timer or background agent', () => {
    expect(sleepRefusal(facts({ pending: true }))).toBe('pending');
  });

  it('16. takes the last Stop hook\'s count, and the transcript only when the hook counted nothing', () => {
    let asked = 0;
    const transcript = (pending: string[]) => () => { asked++; return pending; };
    expect(waitsOnItself({ crons: 1, background: 0 }, transcript([]))).toBe(true);
    expect(waitsOnItself({ crons: 0, background: 2 }, transcript([]))).toBe(true);
    expect(waitsOnItself({ crons: 0, background: 0 }, transcript(['task-1']))).toBe(false);
    expect(asked).toBe(0);
    expect(waitsOnItself(undefined, transcript(['task-1']))).toBe(true);
    expect(waitsOnItself(undefined, transcript([]))).toBe(false);
    expect(asked).toBe(2);
  });

  it('16. reads a count from the hook only when it is one', () => {
    expect(restPendingOf({ crons: 1, background: 0 })).toEqual({ crons: 1, background: 0 });
    for (const bad of [undefined, null, 'x', {}, { crons: -1, background: 0 }, { crons: 1.5, background: 0 }, { crons: '1', background: 0 }, { crons: 1 }]) {
      expect(restPendingOf(bad), JSON.stringify(bad)).toBeUndefined();
    }
    // A count is a count: a forged huge one is still "something waits", not a crash.
    expect(restPendingOf({ crons: 1e12, background: 0 })).toEqual({ crons: 1e12, background: 0 });
  });
});

describe('a request still out at a worker', () => {
  it('17. keeps its requester owed, whether it is queued or written', () => {
    agents.clear();
    const orch = { id: 'orch', name: 'Orchestrator', status: 'idle', projectPath: '/p', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
    const worker = { id: 'w', name: 'Worker', status: 'running', projectPath: '/p', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
    agents.set('orch', orch);
    agents.set('w', worker);
    expect(factsOf(orch, [], Date.now()).owes).toBe(false);
    enqueueRequest(worker, 'orch');
    expect(factsOf(orch, [], Date.now()).owes).toBe(true);
    agents.clear();
  });
});

