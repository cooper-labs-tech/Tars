import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
}));

vi.mock('../../../../electron/utils/kanban-generate', () => ({
  generateTaskFromPrompt: vi.fn(async (prompt: string) => ({
    title: `Generated: ${prompt}`,
    description: 'Auto-generated',
  })),
}));

import { registerKanbanRoutes } from '../../../../electron/services/api-routes/kanban-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import { AppSettings } from '../../../../electron/types';

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

let ctx: RouteContext;

beforeEach(() => {
  agents.clear();

  ctx = {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as any,
    appSettings: {} as AppSettings,
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(),
    agentStatusEmitter: {} as any,
  };
});

describe('kanban-routes', () => {
  function getHandler(app: RouteApp, pattern: string) {
    return app.routes.find(r => r.pattern === pattern)!.handler;
  }

  describe('POST /api/kanban/generate', () => {
    it('generates task from prompt', async () => {
      const app = makeRouteApp();
      registerKanbanRoutes(app, ctx);
      const handler = getHandler(app, '/api/kanban/generate');

      const sendJson = vi.fn();
      await handler({ body: { prompt: 'Fix bug', availableProjects: [] }, params: {} } as RouteRequest, sendJson, ctx);

      expect(sendJson).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        task: expect.objectContaining({ title: 'Generated: Fix bug' }),
      }));
    });

    it('returns 400 when prompt missing', async () => {
      const app = makeRouteApp();
      registerKanbanRoutes(app, ctx);
      const handler = getHandler(app, '/api/kanban/generate');

      const sendJson = vi.fn();
      await handler({ body: {}, params: {} } as RouteRequest, sendJson, ctx);
      expect(sendJson).toHaveBeenCalledWith({ error: 'prompt is required' }, 400);
    });
  });

});
