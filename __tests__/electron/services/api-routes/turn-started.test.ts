import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * A turn beginning, which is the only thing that proves the task was taken.
 *
 * Tars marks an agent `running` at spawn and stops watching as soon as the
 * SessionStart hook registers the session: "it registered, so it took its
 * task". That happens in about a second even when the CLI started with no
 * prompt at all, which is why the whole of the lost dispatch was invisible
 * from inside the app.
 *
 * The signal that actually says a task landed is UserPromptSubmit. It cannot
 * be read as `status: running` alone, because post-tool-use.sh posts that too,
 * several times a turn, and it arrives while the agent is already running: a
 * status route that only reacts to a change of status sees nothing at all.
 *
 * These drive the real route and assert on the agent record.
 */

// agent-manager is the real module here, deliberately. The route records the
// turn by calling noteTurnStarted, which lives in it, so mocking the module
// away would mock away the thing under test: the first version of this file
// did exactly that and failed on its own mock rather than on the behaviour.
// Only what reaches outside the process is stubbed, the way
// task-never-started.test.ts does it. saveAgents is inert in a suite: it
// returns early until loadAgents has run, which no test does.
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn() })),
}));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-1') }));
vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';
import { sid } from '../../../fixtures/session-id';

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

function putAgent(over: Partial<AgentStatus> = {}): AgentStatus {
  const agent = {
    id: 'a1',
    status: 'running',
    projectPath: '/test',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...over,
  } as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
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
});

/** Post to /api/hooks/status the way the shell hooks do. */
function post(body: Record<string, unknown>): void {
  const app = makeRouteApp();
  registerHooksRoutes(app, ctx);
  const route = app.routes.find(r => r.pattern === '/api/hooks/status');
  if (!route) throw new Error('/api/hooks/status is not registered');
  route.handler({ body, params: {} } as RouteRequest, vi.fn());
}

describe('the post that says a turn began', () => {
  it('is recorded even though the agent was already running', async () => {
    // The agent has been `running` since the spawn, so nothing about its
    // status changes here. That is exactly the case the old route had no
    // answer for: it only ever acted on a transition.
    const agent = putAgent({ status: 'running', currentSessionId: sid('live-sess') });

    post({
      agent_id: 'a1',
      session_id: sid('live-sess'),
      status: 'running',
      event: 'UserPromptSubmit',
      current_task: 'rebase onto main',
    });

    expect(agent.lastTurnStartedAt, 'a turn from the live session must be recorded').toBeTruthy();
    expect(agent.status).toBe('running');
  });

  it('is refused from a session that no longer owns the agent', async () => {
    const agent = putAgent({ status: 'running', currentSessionId: sid('live-sess') });

    post({ agent_id: 'a1', session_id: sid('old-sess'), status: 'running', event: 'UserPromptSubmit' });

    // A killed PTY's hooks outlive the kill. One of them claiming a turn would
    // cancel the redelivery for a task that never arrived.
    expect(agent.lastTurnStartedAt).toBeFalsy();
  });

  it('is refused from the session that was killed, even before a new one registers', async () => {
    const agent = putAgent({ status: 'running', currentSessionId: undefined, lastKilledSessionId: sid('dead-sess') });

    post({ agent_id: 'a1', session_id: sid('dead-sess'), status: 'running', event: 'UserPromptSubmit' });

    expect(agent.lastTurnStartedAt).toBeFalsy();
    expect(agent.currentSessionId).toBeUndefined();
  });

  it('is not what post-tool-use.sh sends, which is a status and not a turn', async () => {
    // post-tool-use.sh posts `running` several times a turn. Reading that as a
    // turn beginning would make the watch cancel itself on any tool call of any
    // previous work, which is how the current watch is already blind.
    const agent = putAgent({ status: 'running', currentSessionId: sid('live-sess') });

    post({ agent_id: 'a1', session_id: sid('live-sess'), status: 'running' });

    expect(agent.lastTurnStartedAt).toBeFalsy();
  });
});
