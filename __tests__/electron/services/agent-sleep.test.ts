import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkSleep, factsOf, restPendingOf, sleepRefusal, sleepTiming, waitsOnItself, SLEEP_AFTER_MS, type SleepFacts } from '../../../electron/services/agent-sleep';
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
 * 19. (2.0.4, before its code) A codex agent never put to sleep though codex resumes its session (`codex resume`,
 *     measured on 0.163), or put to sleep when its rollout is gone, so that woken it would start anew.
 * 20. (2.0.4, before its code, seen in the e2e of the resume) A codex agent's CLI never found under its terminal:
 *     only a claude process was looked for, so every pass said `no-process-table`. Or a claude agent's terminal
 *     taken to run a claude because a codex runs there.
 * 21. (the DB brief of 28/10, before its code) Why the pass left an agent awake is computed and thrown away: nothing
 *     the window or the Audit can read says why an agent at rest for an hour never slept. checkSleep keeps the last
 *     reason on each agent that has a terminal (`sleepHeld`: the reason and when it was read), orchestrators and
 *     agents at work included, and an agent put to sleep keeps none.
 * 22. (the same, before its code) The delay cannot be shortened for an E2E run, so no E2E can watch the real pass put
 *     an agent to sleep: DOROTHY_SLEEP_AFTER_MS, under DOROTHY_E2E only and 2 s at least, or 30 minutes; the pass
 *     then runs four times per delay, never less than every 500 ms and never more than every minute.
 * 23. (2.0.5, before its code) An agent is put to sleep while something it started runs outside its terminal's
 *     tree, found by its birth tag (core/born-processes.ts): a dev server started with nohup, its parent gone. The
 *     sleep ends the tree only, and that one would outlive it with no session to answer for it. Or one inside
 *     the tree (its MCP servers, which carry the tag too) counts as outside.
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

describe("a codex agent's terminal (2.0.4)", () => {
  const SHELL = 5100;
  const codexProcs = (codex: string): Proc[] => [
    { pid: SHELL, ppid: 1, stat: 'S', age: 3000, command: '/bin/bash -l' },
    { pid: 5101, ppid: SHELL, stat: 'S', age: 2900, command: `${codex} resume --model gpt-6-luna 01a14fb7-9e95-7c81-8980-2b82c8316805` },
    { pid: 5102, ppid: 5101, stat: 'S', age: 2900, command: 'node /Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js' },
  ];

  it('20. finds its codex under the shell, the binary or node running it, and only for a codex agent', () => {
    expect(sleepRefusal(facts({ binary: 'codex', procs: codexProcs('/Users/u/.local/bin/codex'), terminalPid: SHELL }))).toBeNull();
    expect(sleepRefusal(facts({ binary: 'codex', procs: codexProcs('node /tmp/home/bin/codex'), terminalPid: SHELL }))).toBeNull();
    expect(sleepRefusal(facts({ procs: codexProcs('/Users/u/.local/bin/codex'), terminalPid: SHELL }))).toBe('no-process-table');
  });
});

describe('a codex agent (2.0.4)', () => {
  it('19. is resumable once codex has its rollout, and only then', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sleep-codex-'));
    vi.stubEnv('CODEX_HOME', codexHome);
    try {
      const id = '01a14fb7-9e95-7c81-8980-2b82c8316805';
      const agent = { id: 'cx', name: 'Cody', provider: 'codex', status: 'idle', projectPath: '/p', skills: [], output: [], lastActivity: '', resumableSessionId: id } as unknown as AgentStatus;
      expect(factsOf(agent, [], Date.now()).resumable).toBe(false);
      const dir = path.join(codexHome, 'sessions', '2026', '10', '15');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-2026-10-15T09-00-00-${id}.jsonl`), '{}\n');
      expect(factsOf(agent, [], Date.now()).resumable).toBe(true);
      expect(factsOf({ ...agent, provider: 'gemini' } as AgentStatus, [], Date.now()).resumable).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});


describe('why an agent stays awake (the DB brief of 28/10)', () => {
  it('21. keeps the last reason on every agent with a terminal, and none once asleep', async () => {
    const base = { character: 'robot', projectPath: '/p', skills: [], output: [], lastActivity: '', provider: 'claude' };
    const fleet = {
      lead: { ...base, id: 'lead', name: 'Lead', role: 'orchestrator', status: 'idle', ptyId: 'p-lead' },
      busy: { ...base, id: 'busy', name: 'Busy', role: 'worker', status: 'running', ptyId: 'p-busy' },
      gone: { ...base, id: 'gone', name: 'Gone', role: 'worker', status: 'idle', ptyId: 'p-gone' },
      none: { ...base, id: 'none', name: 'None', role: 'worker', status: 'idle' },
    } as unknown as Record<string, AgentStatus>;
    for (const a of Object.values(fleet)) agents.set(a.id, a);
    try {
      const outcomes = await checkSleep(NOW, { procs: async () => [] });
      expect(Object.fromEntries(outcomes.map((o) => [o.agentId, o.why]))).toEqual({ lead: 'orchestrator', busy: 'not-at-rest', gone: 'no-cli' });
      expect(agents.get('lead')!.sleepHeld).toEqual({ why: 'orchestrator', at: new Date(NOW).toISOString() });
      expect(agents.get('busy')!.sleepHeld?.why).toBe('not-at-rest');
      expect(agents.get('gone')!.sleepHeld?.why).toBe('no-cli');
      // No terminal: the pass has nothing to say of it.
      expect(agents.get('none')!.sleepHeld).toBeUndefined();
    } finally {
      for (const id of Object.keys(fleet)) agents.delete(id);
    }
  });

  it('22. the delay and the pass shortened under DOROTHY_E2E only', () => {
    expect(sleepTiming({})).toEqual({ afterMs: 30 * 60_000, everyMs: 60_000 });
    expect(sleepTiming({ DOROTHY_SLEEP_AFTER_MS: '6000' })).toEqual({ afterMs: 30 * 60_000, everyMs: 60_000 });
    expect(sleepTiming({ DOROTHY_E2E: '1', DOROTHY_SLEEP_AFTER_MS: '6000' })).toEqual({ afterMs: 6_000, everyMs: 1_500 });
    expect(sleepTiming({ DOROTHY_E2E: '1', DOROTHY_SLEEP_AFTER_MS: '2000' })).toEqual({ afterMs: 2_000, everyMs: 500 });
    for (const bad of ['1999', 'soon', '', '-5']) {
      expect(sleepTiming({ DOROTHY_E2E: '1', DOROTHY_SLEEP_AFTER_MS: bad }), bad).toEqual({ afterMs: 30 * 60_000, everyMs: 60_000 });
    }
  });
});

describe('what it started outside its terminal (2.0.5)', () => {
  it('23. leaves alone an agent with a tagged process outside its terminal\'s tree, and counts none inside it', () => {
    expect(sleepRefusal(facts({ bornOutside: [7001] }))).toBe('detached');
    expect(sleepRefusal(facts({ bornOutside: [] }))).toBeNull();
    // Unknown (Windows): the other rules decide, as before.
    expect(sleepRefusal(facts({ bornOutside: undefined }))).toBeNull();
  });

  it('23. outside means not under its terminal: its CLI and MCP servers are inside, an orphan is not', async () => {
    const { bornOutsideOf } = await import('../../../electron/services/agent-sleep');
    const born = [
      { pid: CLI, ppid: 1, agentId: 'a', command: 'claude' },
      { pid: 4101, ppid: CLI, agentId: 'a', command: 'node bundle.js' },
      { pid: 7001, ppid: 1, agentId: 'a', command: 'node next dev' },
      { pid: 7002, ppid: 1, agentId: 'b', command: 'node next dev' },
    ];
    expect(bornOutsideOf('a', CLI, procs(), born)).toEqual([7001]);
    expect(bornOutsideOf('a', CLI, procs(), undefined)).toBeUndefined();
  });
});
