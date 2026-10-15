import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';

/**
 * An agent that came up and never took its task.
 *
 * JeanBrasse watched one sit at a Claude Code banner with an empty prompt, marked
 * `running`, for hours. The process was alive, it had a pty, it had a session
 * id. It simply had no task, and every surface that could have said so was
 * reporting that it was working. That is what made it expensive: a stuck agent
 * and a thinking agent look identical from outside, so nobody looks.
 *
 * These drive the real dispatch and assert on the agent record the whole app
 * reads, rather than on a helper being called.
 */

const mockPtys: { onData: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const inst = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
    mockPtys.push(inst);
    return inst;
  }),
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `pty-${++uuidCounter}`) }));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: vi.fn(),
}));

// agent-manager is the real module now: armTaskStartWatch lives in it, so
// mocking it away would mock away the thing under test. Only the pieces that
// reach outside the process are stubbed.
vi.mock('../../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));

/** Every IPC broadcast the main process made, which is what the windows see. */
const broadcasts: { channel: string; payload: unknown }[] = [];

vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import * as pty from 'node-pty';
import { performDispatch } from '../../../../electron/services/api-routes/agent-routes';
import { resetLaunches } from '../../../../electron/core/agent-launch';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
import { agents, armTaskStartWatch } from '../../../../electron/core/agent-manager';
import { scheduleTick } from '../../../../electron/utils/agents-tick';
import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { RouteApp, RouteRequest } from '../../../../electron/services/api-routes/types';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import { AgentStatus, AppSettings } from '../../../../electron/types';
import { sid } from '../../../fixtures/session-id';

// The launch these hold is darwin and linux's: a line typed into the shell, or
// `bash -l -c`. On a Windows host they read it as linux; the win32 launch (the
// CLI as the terminal's process) is held by launch-call-sites.test.ts and
// agent-terminal-win32.test.ts.
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });


/** Comfortably past the ten minute grace period, plus the tick's own delay. */
const PAST_THE_GRACE = 700_000;

let ctx: RouteContext;
let emitted: string[];

beforeEach(() => {
  // A launch marked by one test holds the agent in the next (core/agent-launch.ts).
  resetLaunches();
  agents.clear();
  ptyProcesses.clear();
  mockPtys.length = 0;
  uuidCounter = 0;
  emitted = [];
  broadcasts.length = 0;
  vi.mocked(pty.spawn).mockClear();

  // emitAgentStatus publishes on the shared bus in services/agent-events, which
  // is what the Agents page, /wait and the orchestrator all listen to. The
  // route context carries a different emitter, so listening to that one would
  // assert nothing.
  agentStatusEmitter.removeAllListeners('fleet-change');
  agentStatusEmitter.on('fleet-change', (id: string) => emitted.push(id));

  const emitter = new EventEmitter();

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'new-pty-id'),
    agentStatusEmitter: emitter,
  } as RouteContext;
});

afterEach(() => {
  vi.useRealTimers();
  agentStatusEmitter.removeAllListeners('fleet-change');
});

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    status: 'idle',
    projectPath: process.cwd(),
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

/**
 * The card the Agents page is holding for an agent: the last agents:tick
 * payload actually broadcast, read the way the window reads it. Asserting on
 * this rather than on scheduleTick having been called is the difference
 * between proving the screen changed and proving a function ran.
 */
function lastCard(id: string): { id: string; displayStatus: string } | undefined {
  const ticks = broadcasts.filter(b => b.channel === 'agents:tick');
  if (ticks.length === 0) return undefined;
  return (ticks[ticks.length - 1].payload as { id: string; displayStatus: string }[])
    .find(a => a.id === id);
}

/** Dispatch, then let the grace period pass without touching real time. */
async function dispatchThenWait(agent: AgentStatus, message: string, after?: () => void): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await performDispatch(agent, { message }, ctx, vi.fn());
    after?.();
    await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
  } finally {
    vi.useRealTimers();
  }
}

describe('a session that never begins its task', () => {
  it('stops being reported as working', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing');

    // Nothing registered a session, so nothing ever started.
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never began the task/i);
  });

  it('tells the caller, through the bus /wait and the orchestrator listen on', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing');

    expect(emitted).toContain('a1');
  });

  it('tells the Agents page, which is the screen JeanBrasse was looking at', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing');

    // The card reads agents:tick and nothing else: no polling, no other
    // channel. Marking the record without this left it saying "working",
    // which is the whole of what he could see.
    const ticks = broadcasts.filter(b => b.channel === 'agents:tick');
    expect(ticks.length).toBeGreaterThan(0);
    const card = (ticks[ticks.length - 1].payload as { id: string; displayStatus: string }[])
      .find(a => a.id === 'a1');
    expect(card).toBeDefined();
    expect(card?.displayStatus).toBe('error');
  });

  it('wakes the long poll that /wait is parked on', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });
    const perAgent: string[] = [];
    agentStatusEmitter.on('status:a1', () => perAgent.push('a1'));

    try {
      await dispatchThenWait(agent, 'do the thing');
    } finally {
      agentStatusEmitter.removeAllListeners('status:a1');
    }

    // `fleet-change` is what the fleet watchers read; `status:<id>` is the
    // channel the /wait long poll parks on, and an orchestrator sitting in
    // wait_for_agent hangs until its own timeout without it. emitAgentStatus
    // sends both, and this pins the half that unblocks the caller.
    expect(perAgent).toContain('a1');
  });

  it('stops the card saying working, read on both sides of the change', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await performDispatch(agent, { message: 'do the thing' }, ctx, vi.fn());
      // The "before" is a real broadcast taken while the agent is still
      // inside its grace period, not an assumption about what the window
      // held. Without it, asserting only the end state would pass just as
      // well against a card that had never said anything else.
      scheduleTick();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(lastCard('a1')?.displayStatus).toBe('working');

      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
      expect(lastCard('a1')?.displayStatus).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('only fires because the spawn cleared the previous session id', async () => {
    const agent = putAgent({
      id: 'a1',
      name: 'Frontend',
      currentSessionId: sid('session-from-the-last-task'),
    });

    await dispatchThenWait(agent, 'do the thing');

    // spawnAgentSession sets currentSessionId back to undefined before arming.
    // That clearing is load-bearing: reading the previous task's registration
    // as this one's would leave the check permanently silent for any agent
    // that has already run once.
    expect(agent.status).toBe('error');
  });

  it('is still reported as working while the grace period runs', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await performDispatch(agent, { message: 'do the thing' }, ctx, vi.fn());
    // Measured: a start against a socket that accepts and never answers had
    // still not registered after 400 seconds, and was perfectly healthy.
    await vi.advanceTimersByTimeAsync(400_000);
    vi.useRealTimers();

    expect(agent.status).toBe('running');
  });
});

describe('a session that does begin its task', () => {
  it('is left alone', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing', () => {
      // What the SessionStart hook does when the CLI actually starts.
      agent.currentSessionId = sid('session-abc');
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('is left alone when it has already moved on by itself', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing', () => {
      agent.status = 'waiting';
      agent.waitingReason = 'asked a question';
    });

    expect(agent.status).toBe('waiting');
  });

  it('is left alone when a newer dispatch has replaced it', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing', () => {
      // A second dispatch took over: this check is not about that session.
      agent.ptyId = 'pty-999';
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('is left alone when the process has already exited', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });

    await dispatchThenWait(agent, 'do the thing', () => {
      // onExit owns that outcome and knows the exit code.
      ptyProcesses.clear();
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });
});

describe('a CLI that does not register sessions at all', () => {
  // These five have their own binary and their own lifecycle. They never set
  // currentSessionId through Claude Code's SessionStart hook, so an absent
  // session id says nothing about whether they took their task. Being wrong
  // in this direction costs a missed report; being wrong in the other marks a
  // working agent broken.
  //
  // Each case asserts the session was actually spawned first. Without that a
  // provider whose command builder refused would take the same route out as
  // one that was deliberately left alone, and the exemption would look proven
  // by a dispatch that never happened.
  it.each(['codex', 'gemini', 'grok', 'opencode', 'pi'])(
    'never accuses %s of a fault this cannot see',
    async (provider) => {
      const agent = putAgent({ id: 'a1', name: provider, provider: provider as never });

      await dispatchThenWait(agent, 'do the thing');

      expect(vi.mocked(pty.spawn)).toHaveBeenCalled();
      expect(agent.status).toBe('running');
      expect(agent.error).toBeUndefined();
    },
  );
});

describe('a CLI that re-points the claude binary', () => {
  it('is watched like claude, because it registers like claude', async () => {
    // The thirteen alternative providers run the same binary against another
    // vendor's base url, so they go through the same SessionStart hook and
    // the same registration. Exempting them would leave most of the fleet in
    // exactly the silence this was written to end.
    ctx.getAppSettings = () => ({ openRouterApiKey: 'test-key' } as AppSettings);
    const agent = putAgent({ id: 'a1', name: 'Kimi', provider: 'openrouter' as never });

    await dispatchThenWait(agent, 'do the thing');

    expect(vi.mocked(pty.spawn)).toHaveBeenCalled();
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never began the task/i);
  });
});


/**
 * The three ways to start an agent that never touch the API.
 *
 * The check used to live beside spawnAgentSession, so an agent started from
 * the Agents page, from Telegram or from Slack was never watched at all while
 * being exactly as able to come up with no task. It lives on the agent now,
 * and each of those paths arms it the same way, so this drives the shared
 * mechanism the way they do.
 */
describe('an agent started outside the API', () => {
  function armed(over: Partial<AgentStatus> = {}): AgentStatus {
    const agent = putAgent({ id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-hand', ...over });
    ptyProcesses.set('pty-hand', { write: vi.fn(), kill: vi.fn() } as never);
    return agent;
  }

  async function letTheGracePass(fn: () => void): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fn();
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }
  }

  it('is watched too, and its card is corrected', async () => {
    const agent = armed();

    await letTheGracePass(() => armTaskStartWatch(agent, agent.ptyId));

    expect(agent.status).toBe('error');
    const ticks = broadcasts.filter(b => b.channel === 'agents:tick');
    const card = (ticks[ticks.length - 1].payload as { id: string; displayStatus: string }[])
      .find(a => a.id === 'a1');
    expect(card?.displayStatus).toBe('error');
  });

  it('corrects the card of an agent nobody asked for', async () => {
    // The gap that made this worth checking: with no requester there is no
    // orchestrator to notify, so no note is typed into a parent terminal, so
    // nothing else in the app schedules a tick. If the watch did not push one
    // itself this card would sit on "working" until the window remounted.
    const agent = armed({ requestedBy: undefined });
    expect(agent.requestedBy).toBeUndefined();
    expect([...agents.values()].some(a => a.role === 'orchestrator')).toBe(false);

    await letTheGracePass(() => armTaskStartWatch(agent, agent.ptyId));

    expect(lastCard('a1')?.displayStatus).toBe('error');
  });

  it('accuses once when one start armed the same pty twice', async () => {
    const agent = armed();

    await letTheGracePass(() => {
      armTaskStartWatch(agent, agent.ptyId);
      armTaskStartWatch(agent, agent.ptyId);
    });

    // Two timers, one verdict: the second finds the status already moved and
    // returns. A caller parked on /wait must not be woken twice for one
    // failure, and the fleet must not see it happen twice either.
    expect(agent.status).toBe('error');
    expect(emitted.filter(id => id === 'a1')).toHaveLength(1);
  });

  it('is left alone when it did begin its task', async () => {
    const agent = armed();

    await letTheGracePass(() => {
      armTaskStartWatch(agent, agent.ptyId);
      agent.currentSessionId = sid('session-abc');
    });

    expect(agent.status).toBe('running');
  });

  it('is not watched at all when it has no session yet to watch', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend', status: 'running' });

    await letTheGracePass(() => armTaskStartWatch(agent, undefined));

    expect(agent.status).toBe('running');
  });
});

/**
 * The stale session id, which is JeanBrasse's case exactly.
 *
 * The check reads "nothing registered since this session started" as
 * `currentSessionId` being unset. Only spawnAgentSession cleared it, so on
 * every other path an agent that had already registered once in this run kept
 * the old id and the check cancelled itself without a word. He starts his
 * agents from the Agents page and they run all day with ptys dying and coming
 * back, so the protection was armed everywhere and fired nowhere.
 */
describe('an agent relaunched after it had already run once', () => {
  function relaunched(): AgentStatus {
    const agent = putAgent({
      id: 'a1',
      name: 'Frontend',
      status: 'running',
      ptyId: 'pty-second',
      // Left over from the session that died. Nothing on this path clears it.
      currentSessionId: sid('session-from-the-first-run'),
    });
    ptyProcesses.set('pty-second', { write: vi.fn(), kill: vi.fn() } as never);
    return agent;
  }

  async function letTheGracePass(fn: () => void): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fn();
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }
  }

  it('is still watched, and is caught when its task never lands', async () => {
    const agent = relaunched();

    await letTheGracePass(() => armTaskStartWatch(agent, agent.ptyId));

    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never began the task/i);
  });

  it('clears the stale id as it arms, so the caller cannot forget to', () => {
    const agent = relaunched();

    armTaskStartWatch(agent, agent.ptyId);

    // The precondition belongs to the watch. A path added tomorrow inherits it
    // without knowing it exists.
    expect(agent.currentSessionId).toBeUndefined();
  });

  it('is left alone once the new session registers', async () => {
    const agent = relaunched();

    await letTheGracePass(() => {
      armTaskStartWatch(agent, agent.ptyId);
      // The SessionStart hook of the run that actually began.
      agent.currentSessionId = sid('session-from-the-second-run');
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('corrects the card, which is what he was looking at', async () => {
    const agent = relaunched();

    await letTheGracePass(() => armTaskStartWatch(agent, agent.ptyId));

    const ticks = broadcasts.filter(b => b.channel === 'agents:tick');
    const card = (ticks[ticks.length - 1].payload as { id: string; displayStatus: string }[])
      .find(a => a.id === 'a1');
    expect(card?.displayStatus).toBe('error');
  });
});

describe('the task that was dispatched', () => {
  it('reaches the CLI whole, well past four thousand characters', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend' });
    // Longer than JeanBrasse's lost order, with everything that makes shell quoting
    // go wrong: single quotes, double quotes, backticks, dollars, newlines.
    const chunk = 'Refactor `useMultiTerminal` so it does not re-measure. '
      + 'JeanBrasse\'s note: "keep it simple", cost is $0 and 100% of the win.\n';
    let task = '';
    while (task.length < 6000) task += chunk;

    await performDispatch(agent, { message: task }, ctx, vi.fn());

    const calls = vi.mocked(pty.spawn).mock.calls;
    const command = (calls[calls.length - 1][1] as string[])[2];

    // The command is handed to bash as one argv element, not typed into a
    // terminal, so no line discipline can shorten it. What matters is that the
    // whole task is in there and its quoting survived intact.
    expect(command.length).toBeGreaterThan(6000);
    expect(command).toContain("JeanBrasse'\\''s note");
    expect(command).toContain('$0 and 100%');
    // And the record the rest of the app reads carries the whole thing.
    expect(agent.currentTask).toBe(task);
  });
});


/**
 * Registration as it actually happens, rather than as a field assignment.
 *
 * Every other test here sets `currentSessionId` by hand, which proves the
 * guard reads it and nothing about how it comes to be set. That mattered less
 * while only spawnAgentSession cleared the id. Now the watch clears it itself
 * on all six paths, including the two that write into a pty that is already
 * alive, and on those no SessionStart will ever fire again: that session
 * announced itself long ago. The only thing that puts the id back is the
 * adoption fallback in hooks-routes, on the first status post that carries a
 * session id and no `source`.
 *
 * So the clearing and that fallback are now one mechanism held in two files.
 * If the fallback tightened, an agent working perfectly well after a Slack or
 * Telegram task would be marked broken ten minutes later, which is the exact
 * error this whole check calls the worse one. These drive the real route.
 */
describe('a session that registers for real', () => {
  function hooksApp(): RouteApp {
    const app: RouteApp = {
      routes: [],
      add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
      get(pattern, handler) { this.add('GET', pattern, handler); },
      post(pattern, handler) { this.add('POST', pattern, handler); },
      put(pattern, handler) { this.add('PUT', pattern, handler); },
      delete(pattern, handler) { this.add('DELETE', pattern, handler); },
    } as RouteApp;
    registerHooksRoutes(app, ctx);
    return app;
  }

  function postStatus(app: RouteApp, body: Record<string, unknown>): void {
    const route = app.routes.find(r => r.pattern === '/api/hooks/status')!;
    route.handler({ body, params: {} } as RouteRequest, vi.fn());
  }

  function relaunched(): AgentStatus {
    const agent = putAgent({
      id: 'a1',
      name: 'Frontend',
      status: 'running',
      ptyId: 'pty-live',
      currentSessionId: sid('session-from-the-first-run'),
    });
    ptyProcesses.set('pty-live', { write: vi.fn(), kill: vi.fn() } as never);
    return agent;
  }

  it('is left alone when the retried post is the one that lands', async () => {
    const agent = relaunched();
    const app = hooksApp();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      armTaskStartWatch(agent, agent.ptyId);
      // The first post from user-prompt-submit.sh never reached the API, so
      // the route sees nothing. A second later the hook sends it again, which
      // is the retry this branch added, and that one arrives.
      await vi.advanceTimersByTimeAsync(1_000);
      postStatus(app, {
        agent_id: 'a1',
        session_id: sid('session-live-1'),
        status: 'running',
        current_task: 'rebase onto main',
      });
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }

    // Ownership restored by adoption, and the agent is working, so it is not
    // accused. Without the retry that post existed once and could be lost for
    // good, and this agent would have been marked broken while working.
    expect(agent.currentSessionId).toBe(sid('session-live-1'));
    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('is accused only when no post arrives at all, which is the honest limit', async () => {
    const agent = relaunched();
    hooksApp();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      armTaskStartWatch(agent, agent.ptyId);
      // Both attempts lost. Nothing anywhere says the task landed, so the
      // check reports what it can see.
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }

    expect(agent.status).toBe('error');
  });

  it('is left alone when SessionStart registers it, on a fresh start', async () => {
    const agent = relaunched();
    const app = hooksApp();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      armTaskStartWatch(agent, agent.ptyId);
      // What hooks/session-start.sh sends: `source` is the field only it sets.
      postStatus(app, {
        agent_id: 'a1',
        session_id: sid('session-from-the-second-run'),
        status: 'idle',
        source: 'startup',
      });
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }

    expect(agent.currentSessionId).toBe(sid('session-from-the-second-run'));
    expect(agent.status).not.toBe('error');
  });

  it('is left alone when a prompt submit adopts it, which is the reused pty', async () => {
    const agent = relaunched();
    const app = hooksApp();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Slack and Telegram type into a pty whose claude is already up. Arming
      // wipes the id that session registered under, and it will never send
      // another SessionStart.
      armTaskStartWatch(agent, agent.ptyId);
      expect(agent.currentSessionId).toBeUndefined();

      // What hooks/user-prompt-submit.sh sends when the task lands: a session
      // id and no `source`. Adoption is what makes the agent owned again.
      postStatus(app, {
        agent_id: 'a1',
        session_id: sid('session-still-running'),
        status: 'running',
      });
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }

    expect(agent.currentSessionId).toBe(sid('session-still-running'));
    expect(agent.status).not.toBe('error');
    expect(agent.error).toBeUndefined();
  });

  it('is still caught when nothing reports at all', async () => {
    const agent = relaunched();
    hooksApp();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      armTaskStartWatch(agent, agent.ptyId);
      await vi.advanceTimersByTimeAsync(PAST_THE_GRACE);
    } finally {
      vi.useRealTimers();
    }

    // The same fixture, the same route registered, only the post missing.
    // Without this the two above would pass against a check that never fires.
    expect(agent.status).toBe('error');
  });
});
