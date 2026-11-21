/**
 * The hook route hands turn endings to the account switching
 * (services/claude-accounts/switching.ts), DESIGN-COMPTES-CLAUDE.md B4.
 *
 * What goes wrong if it is wrong, first:
 * - a StopFailure for a usage limit never reaches the switching: nothing moves;
 * - its message lost on the way: a plan limit cannot be told from a 429 (N4);
 * - the "agent error" notification sent for a limit Tars is already moving the
 *   agent away from, and not sent when it is not;
 * - another failure (authentication, a server error) handed over as a limit;
 * - the end of a turn (Stop, `idle`) not handed over: no move at rest;
 * - a stale session's post handed over: an old CLI's limit moving the new one.
 */
import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({
  limits: [] as { agentId: string; message: string | undefined }[],
  turnsEnded: [] as string[],
  moving: true,
}));

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  noteSessionRegistered: vi.fn(),
  noteTurnStarted: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }));
vi.mock('../../../../electron/services/claude-accounts/switching', () => ({
  onUsageLimit: (agent: { id: string }, message: string | undefined) => {
    h.limits.push({ agentId: agent.id, message });
    return h.moving;
  },
  onTurnEnded: (agent: { id: string }) => {
    h.turnsEnded.push(agent.id);
    return false;
  },
}));

import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { agents } from '../../../../electron/core/agent-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';
import { sid } from '../../../fixtures/session-id';

const LIMIT = "You've hit your session limit · resets 11:59pm (Asia/Tbilisi)";
let ctx: RouteContext;
let status: (body: Record<string, unknown>) => Promise<void>;

beforeEach(() => {
  agents.clear();
  h.limits.length = 0;
  h.turnsEnded.length = 0;
  h.moving = true;
  const appSettings = {} as AppSettings;
  ctx = {
    mainWindow: null as never,
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
  } as unknown as RouteContext;
  const routes: { pattern: string; handler: (...a: unknown[]) => unknown }[] = [];
  const app = { post: (pattern: string, handler: (...a: unknown[]) => unknown) => { routes.push({ pattern, handler }); }, get() {}, put() {}, delete() {}, add() {}, routes: [] } as unknown as RouteApp;
  registerHooksRoutes(app, ctx);
  const handler = routes.find(r => r.pattern === '/api/hooks/status')!.handler;
  status = async body => { await handler({ body, params: {} } as RouteRequest, vi.fn(), ctx); };
});

function running(): AgentStatus {
  const agent = { id: 'a1', status: 'running', projectPath: '/p', skills: [], output: [], lastActivity: '', currentSessionId: sid('s1') } as unknown as AgentStatus;
  agents.set(agent.id, agent);
  return agent;
}

const failure = (kind: string, message = LIMIT) => ({ agent_id: 'a1', session_id: sid('s1'), status: 'error', event: 'StopFailure', error_kind: kind, error_message: message });

describe('a usage limit', () => {
  it('is handed to the switching with its message, and sends no notification when a move is planned', async () => {
    running();
    await status(failure('rate_limit'));
    expect(h.limits).toEqual([{ agentId: 'a1', message: LIMIT }]);
    expect(ctx.handleStatusChangeNotificationCallback).not.toHaveBeenCalled();
    expect(agents.get('a1')!.status).toBe('error');
  });

  it('is notified as before when no move is planned', async () => {
    h.moving = false;
    running();
    await status(failure('rate_limit'));
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalledWith(agents.get('a1'), 'error');
  });

  it('is the only failure handed over', async () => {
    running();
    await status(failure('authentication_failed', 'Please run /login'));
    expect(h.limits).toEqual([]);
    expect(ctx.handleStatusChangeNotificationCallback).toHaveBeenCalled();
  });

  it('is not taken from a stale session', async () => {
    running();
    await status({ ...failure('rate_limit'), session_id: sid('old') });
    expect(h.limits).toEqual([]);
  });
});

describe('the end of a turn', () => {
  it('is handed to the switching when the agent goes idle', async () => {
    running();
    await status({ agent_id: 'a1', session_id: sid('s1'), status: 'idle' });
    expect(h.turnsEnded).toEqual(['a1']);
  });

  it('is not a running post', async () => {
    running();
    agents.get('a1')!.status = 'waiting';
    await status({ agent_id: 'a1', session_id: sid('s1'), status: 'running', event: 'UserPromptSubmit' });
    expect(h.turnsEnded).toEqual([]);
  });
});
