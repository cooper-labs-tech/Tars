import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  noteSessionRegistered: vi.fn(),
  noteTurnStarted: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents, saveAgents } from '../../../../electron/core/agent-manager';
import { RouteApp, RouteContext, RouteRequest, SendJson } from '../../../../electron/services/api-routes/types';
import { AgentStatus, AppSettings } from '../../../../electron/types';
import { agentStatusEmitter } from '../../../../electron/services/agent-events';
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

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

function makeReq(body: Record<string, unknown>): RouteRequest {
  return { body, params: {} } as RouteRequest;
}

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();
  vi.mocked(saveAgents).mockClear();
  const appSettings = { notifyOnWaiting: true } as AppSettings;
  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
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
  };
});

describe('hooks-routes', () => {
  function getHandler(app: RouteApp, pattern: string) {
    return app.routes.find(r => r.pattern === pattern)!.handler;
  }

  describe('POST /api/hooks/output', () => {
    it('captures output on agent', async () => {
      const agent = makeAgent();
      agents.set('agent-1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/output');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'agent-1', output: 'hello world' }), sendJson, ctx);

      expect(agent.lastCleanOutput).toBe('hello world');
      expect(saveAgents).toHaveBeenCalled();
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('returns 400 when agent_id or output missing', async () => {
      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/output');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'agent-1' }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'agent_id and output are required' }, 400);
    });

    it('finds agent by session_id fallback', async () => {
      const agent = makeAgent({ id: 'a2', currentSessionId: sid('sess-1') });
      agents.set('a2', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/output');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'unknown', session_id: sid('sess-1'), output: 'hi' }), sendJson, ctx);
      expect(agent.lastCleanOutput).toBe('hi');
    });

    it('ignores output posted by a stale session', async () => {
      const agent = makeAgent({ id: 'a1', currentSessionId: sid('live-sess'), lastCleanOutput: 'current task output' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/output');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'a1', session_id: sid('old-sess'), output: 'stale output' }), sendJson, ctx);

      expect(agent.lastCleanOutput).toBe('current task output');
      expect(sendJson).toHaveBeenCalledWith({ success: false, stale: true });
    });
  });

  describe('POST /api/hooks/status', () => {
    it('transitions agent status and emits events', async () => {
      const agent = makeAgent({ id: 'a1', status: 'idle' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      const sendJson = vi.fn();
      // The bus is a module singleton now, so the spy would otherwise
      // carry calls made by the tests above it.
      const emitSpy = vi.spyOn(agentStatusEmitter, 'emit');
      emitSpy.mockClear();
      await handler(makeReq({ agent_id: 'a1', session_id: sid('sess'), status: 'running' }), sendJson, ctx);

      expect(agent.status).toBe('running');
      expect(agent.currentSessionId).toBe(sid('sess'));
      expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agent, 'running');
      expect(emitSpy).toHaveBeenCalledWith('status:a1');
      expect(sendJson).toHaveBeenCalledWith({ success: true, agent: { id: 'a1', status: 'running' } });
    });

    it('returns 400 when agent_id or status missing', async () => {
      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'a1' }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'agent_id and status are required' }, 400);
    });

    it('returns not found for unknown agent', async () => {
      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'nope', session_id: sid('sess-x'), status: 'running' }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ success: false, message: 'Agent not found' });
    });

    it('SessionStart registration (source present) records session WITHOUT changing status', async () => {
      // The bug: a freshly dispatched agent is 'running'; the booting claude's
      // SessionStart posted 'idle' which resolved the orchestrator's /wait
      // long-poll instantly → "completed (idle). No clean output captured".
      const agent = makeAgent({ id: 'a1', status: 'running', currentSessionId: undefined });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      const sendJson = vi.fn();
      // The bus is a module singleton now, so the spy would otherwise
      // carry calls made by the tests above it.
      const emitSpy = vi.spyOn(agentStatusEmitter, 'emit');
      emitSpy.mockClear();
      await handler(makeReq({ agent_id: 'a1', session_id: sid('fresh-sess'), status: 'idle', source: 'startup' }), sendJson, ctx);

      expect(agent.status).toBe('running');
      expect(agent.currentSessionId).toBe(sid('fresh-sess'));
      // No status event, which would answer a /wait for a change that did not
      // happen. The fleet change agent-watch flushes on is not one (#134).
      expect(emitSpy.mock.calls.map(c => String(c[0])).filter(name => name.startsWith('status:'))).toEqual([]);
      expect(emitSpy.mock.calls.map(c => String(c[0]))).toEqual(['fleet-change']);
      expect(sendJson).toHaveBeenCalledWith({ success: true, registered: true, agent: { id: 'a1', status: 'running' } });
    });

    it('ignores status posts from a stale session', async () => {
      // Hooks of a killed PTY still in flight must not flip the live task's status.
      const agent = makeAgent({ id: 'a1', status: 'running', currentSessionId: sid('live-sess') });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      const sendJson = vi.fn();
      // The bus is a module singleton now, so the spy would otherwise
      // carry calls made by the tests above it.
      const emitSpy = vi.spyOn(agentStatusEmitter, 'emit');
      emitSpy.mockClear();
      await handler(makeReq({ agent_id: 'a1', session_id: sid('old-sess'), status: 'idle' }), sendJson, ctx);

      expect(agent.status).toBe('running');
      expect(emitSpy).not.toHaveBeenCalled();
      expect(sendJson).toHaveBeenCalledWith({ success: false, stale: true, agent: { id: 'a1', status: 'running' } });
    });

    it('applies idle from the registered session and keeps currentSessionId', async () => {
      const agent = makeAgent({ id: 'a1', status: 'running', currentSessionId: sid('live-sess') });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      await handler(makeReq({ agent_id: 'a1', session_id: sid('live-sess'), status: 'idle' }), vi.fn(), ctx);

      expect(agent.status).toBe('idle');
      // The one-shot claude process is still alive at its prompt; its later
      // hooks must keep matching the guard.
      expect(agent.currentSessionId).toBe(sid('live-sess'));
    });

    it('stores waiting_reason on waiting and clears it on running', async () => {
      const agent = makeAgent({ id: 'a1', status: 'running', currentSessionId: sid('sess') });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      await handler(makeReq({ agent_id: 'a1', session_id: sid('sess'), status: 'waiting', waiting_reason: 'permission' }), vi.fn(), ctx);
      expect(agent.status).toBe('waiting');
      expect(agent.waitingReason).toBe('permission');

      await handler(makeReq({ agent_id: 'a1', session_id: sid('sess'), status: 'running' }), vi.fn(), ctx);
      expect(agent.status).toBe('running');
      expect(agent.waitingReason).toBeUndefined();
    });

    it('adopts the first session when none is registered (SessionStart was lost)', async () => {
      const agent = makeAgent({ id: 'a1', status: 'running', currentSessionId: undefined });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/status');

      await handler(makeReq({ agent_id: 'a1', session_id: sid('sess-x'), status: 'idle' }), vi.fn(), ctx);

      expect(agent.status).toBe('idle');
      expect(agent.currentSessionId).toBe(sid('sess-x'));
    });

    it('never adopts a tombstoned (killed) session during the dispatch window', async () => {
      // The dispatch-window race: /dispatch killed the previous PTY and
      // cleared currentSessionId; the killed session's Stop hook is still in
      // flight. Its posts must NOT be adopted — otherwise the previous task's
      // "idle" resolves the new task's /wait with the OLD output.
      const agent = makeAgent({
        id: 'a1',
        status: 'running',
        currentSessionId: undefined,
        lastKilledSessionId: sid('dead-sess'),
      });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const statusHandler = getHandler(app, '/api/hooks/status');
      const outputHandler = getHandler(app, '/api/hooks/output');

      const sendJson = vi.fn();
      await statusHandler(makeReq({ agent_id: 'a1', session_id: sid('dead-sess'), status: 'idle' }), sendJson, ctx);
      expect(agent.status).toBe('running');
      expect(agent.currentSessionId).toBeUndefined();
      expect(sendJson.mock.calls[0][0]).toMatchObject({ success: false, stale: true });

      await outputHandler(makeReq({ agent_id: 'a1', session_id: sid('dead-sess'), output: 'old task output' }), vi.fn(), ctx);
      expect(agent.lastCleanOutput).toBeUndefined();

      // A SessionStart from the killed session must not register either.
      await statusHandler(makeReq({ agent_id: 'a1', session_id: sid('dead-sess'), status: 'idle', source: 'startup' }), vi.fn(), ctx);
      expect(agent.currentSessionId).toBeUndefined();

      // The genuinely fresh session still registers and drives status.
      await statusHandler(makeReq({ agent_id: 'a1', session_id: sid('fresh-sess'), status: 'idle', source: 'startup' }), vi.fn(), ctx);
      expect(agent.currentSessionId).toBe(sid('fresh-sess'));
      await statusHandler(makeReq({ agent_id: 'a1', session_id: sid('fresh-sess'), status: 'idle' }), vi.fn(), ctx);
      expect(agent.status).toBe('idle');
    });
  });

  describe('POST /api/hooks/notification', () => {
    it('sends permission_prompt notification', async () => {
      const agent = makeAgent({ id: 'a1', name: 'MyAgent' });
      agents.set('a1', agent);

      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/notification');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'a1', session_id: sid('sess'), type: 'permission_prompt', title: 'Test', message: 'help' }), sendJson, ctx);

      expect(ctx.sendNotificationCallback).toHaveBeenCalledWith('MyAgent needs permission', 'help', 'a1', expect.objectContaining({ notifyOnWaiting: true }));
      expect(sendJson).toHaveBeenCalledWith({ success: true });
    });

    it('returns 400 when agent_id or type missing', async () => {
      const app = makeRouteApp();
      registerHooksRoutes(app, ctx);
      const handler = getHandler(app, '/api/hooks/notification');

      const sendJson = vi.fn();
      await handler(makeReq({ agent_id: 'a1' }), sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'agent_id and type are required' }, 400);
    });
  });
});
