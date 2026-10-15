import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Who owns an agent while it works, and what the task-start watch does to it.
 *
 * The watch asks one question: has the task landed. It used to ask it by
 * emptying `currentSessionId` and seeing whether anything filled it back in.
 * Seven callers arm it and exactly one, spawnAgentSession, has just ended the
 * previous session; the other six reuse a pty whose session is alive and
 * working. For those six the agent was left with no owner at all while it
 * worked: the stale-session guard had nothing to compare against, so ownership
 * went to whichever session posted next, and everything the real session said
 * until then was dropped as unowned. If no prompt submit ever arrived, this
 * same watch then accused the agent of never having started.
 *
 * It asks directly now, and erases nothing that is alive. These hold the new
 * contract: the field is kept when the owner is live and cleared when it is
 * not, the three ways the watch can learn the task landed each work on their
 * own, and the accusation still falls when none of them does.
 *
 * The three are driven by setting the fields rather than through a hook on
 * purpose. A real registration sets an id AND a timestamp, so it satisfies two
 * exits at once: a test that only ever registers cannot say which one did the
 * work, and two of the three could be dead code without a single case turning
 * red. task-never-started.test.ts drives the hooks end to end beside this.
 */

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() })),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: vi.fn(),
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));
vi.mock('../../../electron/services/memory-hub', () => ({
  needsPromptInjection: () => false,
  assembleDigest: async () => '',
  wrapDigestForPrompt: (d: string) => d,
}));

import { agents, armTaskStartWatch } from '../../../electron/core/agent-manager';
import { registerHooksRoutes } from '../../../electron/services/api-routes/hooks-routes';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { sid } from '../../fixtures/session-id';

/** Comfortably past the ten minute grace period. */
const PAST_THE_GRACE = 700_000;

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
  ptyProcesses.clear();
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
    agentStatusEmitter: { emit: vi.fn(), on: vi.fn() } as never,
  } as RouteContext;
});

afterEach(() => {
  vi.useRealTimers();
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
 * Fake `Date` as well as the timers.
 *
 * The watch compares timestamps against the moment it armed, and with a real
 * clock a test cannot tell "after" from "in the same millisecond": the case
 * would pass or fail on how fast the machine ran it.
 */
async function withClock(run: (tick: (ms: number) => Promise<void>) => Promise<void> | void): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    await run((ms: number) => vi.advanceTimersByTimeAsync(ms));
  } finally {
    vi.useRealTimers();
  }
}

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

/** Post to /api/hooks/status and hand back what the route answered. */
function postStatus(app: RouteApp, body: Record<string, unknown>): Record<string, unknown> {
  const route = app.routes.find(r => r.pattern === '/api/hooks/status')!;
  let answer: Record<string, unknown> = {};
  route.handler({ body, params: {} } as RouteRequest, ((payload: Record<string, unknown>) => { answer = payload; }) as never);
  return answer;
}

/** An agent whose session is alive in the pty about to be armed. */
function live(): AgentStatus {
  const agent = putAgent({
    id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-live',
    currentSessionId: sid('session-live'), sessionPtyId: 'pty-live',
  });
  ptyProcesses.set('pty-live', { write: vi.fn(), kill: vi.fn() } as never);
  return agent;
}

describe('an agent whose session is alive when it is handed a task', () => {
  it('keeps its owner', async () => {
    const agent = live();

    await withClock(() => { armTaskStartWatch(agent, agent.ptyId, 'rebase onto main'); });

    // The six callers that reuse a live pty are the Agents page, Telegram
    // twice, Slack twice and the board. This is the field they were emptying.
    expect(agent.currentSessionId).toBe(sid('session-live'));
  });

  it('accepts what that session reports, and still refuses another one', async () => {
    const agent = live();
    const app = hooksApp();

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(1_000);

      // The live session says it is waiting on JeanBrasse. With the owner emptied
      // this was unowned and thrown away, so the screen kept saying running.
      expect(postStatus(app, {
        agent_id: 'a1', session_id: sid('session-live'), status: 'waiting', waiting_reason: 'idle',
      })).toMatchObject({ success: true });
      expect(agent.status).toBe('waiting');

      // And keeping the owner is what makes the guard able to refuse: with the
      // field emptied, this post would have been adopted as the new owner.
      expect(postStatus(app, {
        agent_id: 'a1', session_id: sid('someone-else'), status: 'running',
      })).toMatchObject({ stale: true });
      expect(agent.currentSessionId).toBe(sid('session-live'));
    });
  });
});

/**
 * The three exits, each on its own.
 *
 * Any one of them means the task landed. Each case below arranges exactly one
 * and leaves the other two unsatisfied, so a case that goes green names the
 * exit that carried it.
 */
describe('the ways the watch learns the task landed', () => {
  it('a session that registered after it armed, and nothing else', async () => {
    const agent = live();

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(1_000);
      // Same owner as at arming, and no turn has begun: only the registration
      // stamp is newer than the moment this watch started.
      agent.sessionRegisteredAt = new Date().toISOString();
      await tick(PAST_THE_GRACE);
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('a turn that began after it armed, and nothing else', async () => {
    const agent = live();

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(1_000);
      // The dispatch typed into a session already live: no registration is
      // ever coming, and the turn is the only evidence there will be.
      agent.lastTurnStartedAt = new Date().toISOString();
      await tick(PAST_THE_GRACE);
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('a different owner than the one present when it armed, and nothing else', async () => {
    const agent = live();

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(1_000);
      // Neither stamp moves: the agent simply belongs to somebody else now.
      agent.currentSessionId = sid('session-that-took-over');
      await tick(PAST_THE_GRACE);
    });

    expect(agent.status).toBe('running');
    expect(agent.error).toBeUndefined();
  });

  it('and none of them: still running, still silent, so it is accused', async () => {
    const agent = live();

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(PAST_THE_GRACE);
    });

    // The owner was kept, which is the new behaviour, and the accusation still
    // falls: keeping the field was never meant to cancel the check, and a
    // watch that stops firing is the shape of bug it exists to catch.
    expect(agent.currentSessionId).toBe(sid('session-live'));
    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never began the task/i);
  });
});

describe('what registration records', () => {
  it('names the pty the session claimed the agent from', async () => {
    const agent = putAgent({ id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-live' });
    ptyProcesses.set('pty-live', { write: vi.fn(), kill: vi.fn() } as never);
    const app = hooksApp();

    // `source` is the field only the session-start hooks set.
    postStatus(app, { agent_id: 'a1', session_id: sid('session-1'), status: 'running', source: 'startup' });

    // Without this the agent cannot tell a live owner from one left over by a
    // pty that died: on the agent alone the two look identical.
    expect(agent.sessionPtyId).toBe('pty-live');
    expect(agent.currentSessionId).toBe(sid('session-1'));
    expect(agent.sessionRegisteredAt).toBeTruthy();
  });

  it('rewrites both fields together when a new session takes the same pty', async () => {
    const agent = putAgent({
      id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-live',
      currentSessionId: sid('session-1'), sessionPtyId: 'pty-live',
    });
    ptyProcesses.set('pty-live', { write: vi.fn(), kill: vi.fn() } as never);
    const app = hooksApp();

    postStatus(app, { agent_id: 'a1', session_id: sid('session-2'), status: 'running', source: 'startup' });

    // The pair has to move as one. Leaving the old pty id beside a new session
    // would read as live in one place and stale in the other.
    expect(agent.currentSessionId).toBe(sid('session-2'));
    expect(agent.sessionPtyId).toBe('pty-live');
  });
});

describe('an owner that is not alive', () => {
  it('is cleared when its id came from an older pty', async () => {
    const agent = putAgent({
      id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-second',
      // Registered from the pty that died. The session went with it.
      currentSessionId: sid('session-from-the-first-run'), sessionPtyId: 'pty-first',
    });
    ptyProcesses.set('pty-second', { write: vi.fn(), kill: vi.fn() } as never);

    await withClock(() => { armTaskStartWatch(agent, agent.ptyId, 'rebase onto main'); });

    // Cleared, and it has to be: the new session's own hooks would otherwise
    // be refused as coming from the wrong session, which is the exact failure
    // the ownership contract exists to prevent.
    expect(agent.currentSessionId).toBeUndefined();
  });

  it('is cleared for an agent read from an agents.json written before the field existed', async () => {
    const agent = putAgent({
      id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-second',
      currentSessionId: sid('session-from-the-first-run'),
    });
    ptyProcesses.set('pty-second', { write: vi.fn(), kill: vi.fn() } as never);

    await withClock(() => { armTaskStartWatch(agent, agent.ptyId, 'rebase onto main'); });

    // No sessionPtyId at all cannot be read as live: an unknown pty is the
    // case this record came from, and treating it as alive would hand the
    // agent to a session that is gone.
    expect(agent.sessionPtyId).toBeUndefined();
    expect(agent.currentSessionId).toBeUndefined();
  });

  it('is still accused when nothing lands, exactly as before', async () => {
    const agent = putAgent({
      id: 'a1', name: 'Frontend', status: 'running', ptyId: 'pty-second',
      currentSessionId: sid('session-from-the-first-run'), sessionPtyId: 'pty-first',
    });
    ptyProcesses.set('pty-second', { write: vi.fn(), kill: vi.fn() } as never);

    await withClock(async tick => {
      armTaskStartWatch(agent, agent.ptyId, 'rebase onto main');
      await tick(PAST_THE_GRACE);
    });

    expect(agent.status).toBe('error');
    expect(agent.error).toMatch(/never began the task/i);
  });
});
