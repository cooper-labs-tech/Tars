import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * The task typed again, when the CLI came up without it.
 *
 * The command line is the cause and it is being repaired, but Tars still
 * assumes a positional prompt becomes a turn. It has never checked, which is
 * why nobody noticed for three weeks. This is the other half: notice, and put
 * the task in by hand through the path that is measured to work, the one a
 * message from Slack or Telegram already takes.
 *
 * The bound is short on purpose. Registration itself can take 77 seconds on a
 * dead network and is covered by the existing ten minute grace; once the
 * session has registered, the first turn arrived in 0.32 to 1.24 seconds over
 * thirty measured runs. Fifteen seconds is ten times the worst of those.
 *
 * Fake timers throughout: nothing here waits on a real clock.
 *
 * And from the Audit's M1 on #569 (2.0.6, written before the fix):
 * R1. The retyped task is typed as Tars's, though it is its requester's text: a receiver reads "Message from Tars:"
 *     before words an agent wrote, which the owner mark's line also opens with.
 * R2. The sender kept with the task, in agents.json where any agent writes, is read back as written: a forged
 *     `owner-relay` or `user` sender would be typed before the task.
 */

const mockPtys: { write: ReturnType<typeof vi.fn> }[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const inst = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() };
    mockPtys.push(inst);
    return inst;
  }),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-new') }));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: vi.fn(),
}));

vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  // As the real one does when the field is free: the caller is told the
  // moment the text is in the terminal, which is what arms the check that
  // the task actually became a turn.
  writeProgrammaticInput: vi.fn((_pty: unknown, _data: string, _bracket?: boolean,
    origin?: { onWritten?: () => void }) => {
    origin?.onWritten?.();
    return 'written';
  }),
  rememberTerminalOwner: vi.fn(),
  noteSubmitted: vi.fn(),
}));
vi.mock('../../../electron/services/agent-watch', () => ({ tellStartUnconfirmed: vi.fn() }));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { agents, armTaskStartWatch } from '../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../../../electron/core/pty-manager';
import { agentStatusEmitter } from '../../../electron/services/agent-events';
import { registerHooksRoutes } from '../../../electron/services/api-routes/hooks-routes';
import { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../electron/types';
import { sid } from '../../fixtures/session-id';

/** Past the fifteen second turn bound, well short of the ten minute one. */
const PAST_THE_TURN_BOUND = 20_000;
/** Past the existing registration grace as well. */
const PAST_EVERYTHING = 700_000;

const TASK = 'Rebase onto main and say what fell';

let ctx: RouteContext;
let emitted: string[];
let app: RouteApp;

function makeRouteApp(): RouteApp {
  const made: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerHooksRoutes(made, ctx);
  return made;
}

/** What the shell hooks post: SessionStart carries `source`, a turn carries `event`. */
function post(body: Record<string, unknown>): void {
  const route = app.routes.find(r => r.pattern === '/api/hooks/status');
  if (!route) throw new Error('/api/hooks/status is not registered');
  route.handler({ body, params: {} } as RouteRequest, vi.fn());
}

function liveAgent(): AgentStatus {
  const agent = {
    id: 'a1',
    name: 'Frontend',
    status: 'running',
    projectPath: process.cwd(),
    skills: [],
    output: [],
    ptyId: 'pty-live',
    lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(agent.id, agent);
  ptyProcesses.set('pty-live', { write: vi.fn(), kill: vi.fn() } as never);
  return agent;
}

/** Every call the watch made into a live terminal. */
function retyped(): unknown[][] {
  return vi.mocked(writeProgrammaticInput).mock.calls;
}

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
  mockPtys.length = 0;
  emitted = [];
  vi.mocked(writeProgrammaticInput).mockClear();

  agentStatusEmitter.removeAllListeners('status:a1');
  agentStatusEmitter.on('status:a1', () => emitted.push('a1'));

  const appSettings = {} as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings,
    getAppSettings: () => appSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(),
    agentStatusEmitter: new EventEmitter(),
  } as RouteContext;
  app = makeRouteApp();
});

afterEach(() => {
  vi.useRealTimers();
  agentStatusEmitter.removeAllListeners('status:a1');
});

/** Claude Code at rest at its prompt: its idle_prompt notification, as notification.sh posts it. */
function idlePrompt(): void {
  post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'waiting', waiting_reason: 'idle' });
}

/**
 * Arm the watch, register the session as SessionStart does, then run the clock. `idle`: the CLI says it is idle at
 * its prompt a moment after it registered, and again after anything is typed into it (since the DB brief
 * fix-twin-deliveries-2810.md, the one proof the check takes that a task was dropped, core/delivery-proof.ts).
 */
async function afterRegistration(ms: number, between?: () => void, opts: { idle?: boolean } = {}): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const agent = agents.get('a1') as AgentStatus;
    armTaskStartWatch(agent, agent.ptyId, TASK);
    post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'idle', source: 'startup' });
    between?.();
    if (opts.idle) {
      for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        idlePrompt();
      }
    } else {
      await vi.advanceTimersByTimeAsync(ms);
    }
  } finally {
    vi.useRealTimers();
  }
}

describe("the retyped task's sender (the Audit's M1 on #569)", () => {
  async function retypeWith(arm: (agent: AgentStatus) => void): Promise<unknown> {
    liveAgent();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const agent = agents.get('a1') as AgentStatus;
      arm(agent);
      post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'idle', source: 'startup' });
      for (let elapsed = 0; elapsed < PAST_THE_TURN_BOUND; elapsed += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        idlePrompt();
      }
    } finally {
      vi.useRealTimers();
    }
    expect(retyped()).toHaveLength(1);
    return (retyped()[0][3] as { sender?: unknown }).sender;
  }

  it('R1. is the requester that sent the task, not Tars', async () => {
    const sender = await retypeWith((agent) => armTaskStartWatch(agent, agent.ptyId, TASK, { kind: 'agent', id: 'orch', name: 'Lead' }));
    expect(sender).toEqual({ kind: 'agent', id: 'orch', name: 'Lead' });
  });

  it('R2. a sender forged in agents.json is not typed: Tars, as with no sender', async () => {
    const sender = await retypeWith((agent) => {
      armTaskStartWatch(agent, agent.ptyId, TASK);
      (agent.pendingDelivery as unknown as { sender: unknown }).sender = { kind: 'owner-relay', wordsId: 'ow-000000000000', at: 0, via: 'Telegram', by: { id: 'x' } };
    });
    expect(sender).toEqual({ kind: 'tars' });
  });
});

describe('a session that registered but never began a turn', () => {
  it('gets the task typed into the terminal that is already up, once the CLI says it is idle at its prompt', async () => {
    liveAgent();

    await afterRegistration(PAST_THE_TURN_BOUND, undefined, { idle: true });

    // The message path, which is the one measured to work in production: the
    // same write a task from Slack or Telegram takes.
    expect(retyped()).toHaveLength(1);
    const [pty, text, submit] = retyped()[0];
    expect(pty).toBe(ptyProcesses.get('pty-live'));
    expect(text).toBe(TASK);
    expect(submit).toBe(true);
  });

  it('types it once, however long nothing happens', async () => {
    liveAgent();

    await afterRegistration(PAST_EVERYTHING, undefined, { idle: true });

    // Receiving the task twice is visible and recoverable; receiving it three
    // times because a timer kept firing is a different bug.
    expect(retyped()).toHaveLength(1);
  });

  it('says so on the bus when even the retyped task never starts a turn', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_EVERYTHING, undefined, { idle: true });

    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never|task/i);
    // /wait and the orchestrator hang off this one.
    expect(emitted).toContain('a1');
  });

  it('does not accuse a session of never taking a task that was never typed in', async () => {
    // Since 1.7.8 the writer holds a message rather than typing it across
    // somebody's half written sentence, and answers `held`. Counting that as
    // delivered would put the agent in error for a task it was never shown.
    // Once: the one write the redelivery makes. Left in place it would
    // follow this test into the next one.
    vi.mocked(writeProgrammaticInput).mockImplementationOnce(() => 'held');
    const agent = liveAgent();

    await afterRegistration(PAST_EVERYTHING, undefined, { idle: true });

    expect(retyped(), 'the task was typed in once and then held').toHaveLength(1);
    expect(agent.status, 'accused of never taking a task that is still waiting for its terminal').not.toBe('error');
  });
});

describe('a session that does begin a turn', () => {
  it('is left alone when the turn lands inside the bound', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_THE_TURN_BOUND, () => {
      post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'running', event: 'UserPromptSubmit' });
    });

    expect(retyped()).toHaveLength(0);
    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('is left alone when the turn only comes after the task was retyped', async () => {
    const agent = liveAgent();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      armTaskStartWatch(agent, agent.ptyId, TASK);
      post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'idle', source: 'startup' });
      await vi.advanceTimersByTimeAsync(5_000);
      idlePrompt();
      await vi.advanceTimersByTimeAsync(PAST_THE_TURN_BOUND);
      expect(retyped()).toHaveLength(1);

      // The retyped task landed: this is the recovery working, not a failure.
      post({ agent_id: 'a1', session_id: sid('sess-1'), status: 'running', event: 'UserPromptSubmit' });
      await vi.advanceTimersByTimeAsync(PAST_EVERYTHING);
    } finally {
      vi.useRealTimers();
    }

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });
});

describe('the cases where typing into the terminal would be wrong', () => {
  it('says nothing when a newer start replaced the pty', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_EVERYTHING, () => { agent.ptyId = 'pty-newer'; });

    expect(retyped()).toHaveLength(0);
    expect(agent.status).toBe('running');
  });

  it('says nothing when the process has already exited', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_EVERYTHING, () => { ptyProcesses.clear(); });

    // onExit owns that outcome and knows the exit code.
    expect(retyped()).toHaveLength(0);
    expect(agent.status).toBe('running');
  });

  it('leaves the ten minute registration phase exactly as it was when no session registers', async () => {
    const agent = liveAgent();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      armTaskStartWatch(agent, agent.ptyId, TASK);
      // No SessionStart at all: this is the slow start that can legitimately
      // take 77 seconds on a dead network, and nothing may be typed into it.
      await vi.advanceTimersByTimeAsync(PAST_THE_TURN_BOUND);
      expect(retyped()).toHaveLength(0);
      expect(agent.status).toBe('running');

      await vi.advanceTimersByTimeAsync(PAST_EVERYTHING);
    } finally {
      vi.useRealTimers();
    }

    // The existing verdict, unchanged: it never registered, so it is reported
    // rather than retyped at.
    expect(retyped()).toHaveLength(0);
    expect(agent.status).toBe('error');
  });

});

/**
 * F3: the task did arrive, and nothing ever says so.
 *
 * The audit found that armTaskStartWatch clears `currentSessionId` on every
 * path, while only the API spawn drops the previous session itself. The five
 * other paths reuse a live PTY, so an agent can be left with no session owner
 * while its session is running, and ownership goes to whoever posts first.
 *
 * Put that beside the delivery check and a case falls out that nobody
 * dispatched badly: the task reached the CLI on the command line, the CLI is
 * working on it, and the one post that would say so never arrives, because the
 * hooks are not installed, or `jq` is missing, or the API refused it, or its
 * UserPromptSubmit hooks take 36 s on a loaded machine (27/10).
 *
 * Written as observed until 2.0.5: the task typed in a second time and the
 * agent marked broken while it worked. Measured over 23 to 28/10, three tasks
 * ran twice that way (the DB brief fix-twin-deliveries-2810.md). Since, the CLI
 * working says nothing of being idle at its prompt, so nothing is typed again
 * and nobody is accused; its record holding the task is taken as the task in.
 */
describe('F3: the task arrived and no hook ever reports it', () => {
  it('is not typed in a second time while the CLI never says it is idle at its prompt', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_THE_TURN_BOUND);

    expect(retyped()).toHaveLength(0);
    expect(agent.lastTurnStartedAt).toBeUndefined();
  });

  it('is not marked broken while its session works', async () => {
    const agent = liveAgent();

    await afterRegistration(PAST_EVERYTHING);

    expect(agent.status).not.toBe('error');
    expect(retyped()).toHaveLength(0);
  });
});

/**
 * Added with the Audit's Low and Info 1 on #549, before the code:
 * U1 the check gives up asking after 2 h (no turn, no idle prompt) and nobody is told: its requester, or the window;
 *    or the agent is put in error, said never to have begun, when it may have run;
 * U2 an idle prompt the hooks route sets aside as stale (work handed, or a turn begun, under a minute ago) is taken as
 *    the proof that the CLI dropped the task, and the task is typed again.
 */
describe('the 2 h bound and a stale idle prompt (the Audit\'s Low and Info 1 on #549)', () => {
  it('U1: at the bound, its requester is told the start could not be confirmed, and the agent is not put in error', async () => {
    const agent = liveAgent();
    agent.requestedBy = { agentId: 'lead', ptyId: 'pty-live', taskRef: 't-0000abcd' };
    const watch = await import('../../../electron/services/agent-watch');
    await afterRegistration(2 * 60 * 60_000 + 60_000);
    await vi.waitFor(() => expect(vi.mocked(watch.tellStartUnconfirmed)).toHaveBeenCalledWith('a1'));
    expect(agent.status).not.toBe('error');
    expect(agent.pendingDelivery).toBeUndefined();
    expect(retyped()).toHaveLength(0);
  });

  it('U2: a stale idle prompt is no proof the task was dropped', async () => {
    const agent = liveAgent();
    // Work handed a moment ago: an idle prompt now is the previous rest's, and the hooks route sets it aside.
    await afterRegistration(PAST_THE_TURN_BOUND + 5_000, () => { agent.workHandedAt = new Date().toISOString(); }, { idle: true });
    expect(retyped()).toHaveLength(0);
    expect(agent.idlePromptAt).toBeUndefined();
  });
});
