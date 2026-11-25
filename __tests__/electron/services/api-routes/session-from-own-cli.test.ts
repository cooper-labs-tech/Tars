import '../../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What the hooks route does with a CLI that is not the agent's terminal's (the
 * Audit's L3 and L4 on #380).
 *
 * How it fails, written before the code:
 * 1. (L4) An agent whose own SessionStart was lost or refused has no owner,
 *    and the registration fallback adopts the first session posting a status:
 *    a nested claude's, whose hooks carry the agent's id and token. It must
 *    adopt only a post whose CLI is the terminal's (X-Tars-Cli-Pid, sent with
 *    every hook post), and, as everywhere, any post that names no CLI.
 * 2. (L3) A refused registration is one console line: a wrong refusal reads as
 *    an agent stuck in its last status, with nothing for a person to find. It
 *    is written into the agent's kept output, which Logs shows.
 * 3. (L5, GATE-PR380-DELTA) Not adopted, a nested CLI's posts still go on to
 *    the turn, the ledger and the status: its UserPromptSubmit and its Stop
 *    set the agent running, then idle, though the agent's own CLI is in
 *    another state. Refused at once or after the process table answers, such
 *    a post must answer stale and change nothing; the terminal's own CLI,
 *    once the table says so, must still drive the status. On every route its
 *    hooks post to: its Stop's answer became the agent's last output, its
 *    Stop and its task-completed ended the agent's work, its notification
 *    raised an alert in the agent's name.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/Users/test', getAppPath: () => process.cwd() }, BrowserWindow: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn(), rememberTerminalOwner: vi.fn(), noteSubmitted: vi.fn() }));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { agents } from '../../../../electron/core/agent-manager';
import { registerHooksRoutes } from '../../../../electron/services/api-routes/hooks-routes';
import { ptyProcesses } from '../../../../electron/core/pty-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus } from '../../../../electron/types';
import { sid } from '../../../fixtures/session-id';

const TERMINAL = 4242;
/** A pid no process has: its parent cannot be read, so it is not the terminal's child. */
const NESTED = 3_999_999;

function app(): RouteApp {
  const routes: Array<{ method: string; pattern: string | RegExp; handler: (req: RouteRequest, send: unknown) => unknown }> = [];
  const add = (method: string) => (pattern: string | RegExp, handler: (req: RouteRequest, send: unknown) => unknown) => { routes.push({ method, pattern, handler }); };
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'), patch: add('PATCH') } as unknown as RouteApp;
}
const ctx = {
  mainWindow: null, appSettings: {}, getAppSettings: () => ({}), getTelegramBot: () => null, getSlackApp: () => null,
  slackResponseChannel: null, slackResponseThreadTs: null, handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
  initAgentPtyCallback: vi.fn(async () => 'x'), agentStatusEmitter: { emit: vi.fn(), on: vi.fn() },
} as unknown as RouteContext;

function post(a: RouteApp, body: Record<string, unknown>, cliPid?: number, to = '/api/hooks/status'): Record<string, unknown> {
  const route = (a as unknown as { routes: Array<{ pattern: unknown; handler: (req: RouteRequest, send: unknown) => unknown }> }).routes.find((r) => r.pattern === to)!;
  // Filled when the route answers, which may be after it awaits the process table.
  const answer: Record<string, unknown> = {};
  const raw = { headers: cliPid === undefined ? {} : { 'x-tars-cli-pid': String(cliPid) } };
  void route.handler({ body, params: {}, raw } as unknown as RouteRequest, ((payload: Record<string, unknown>) => { Object.assign(answer, payload); }) as never);
  return answer;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  const a = { id: 'a1', name: 'Worker', status: 'running', ptyId: 'pty-a1', output: [], projectPath: '/p', skills: [], ...over } as AgentStatus;
  agents.set(a.id, a);
  ptyProcesses.set('pty-a1', { pid: TERMINAL, write: vi.fn(), kill: vi.fn() } as never);
  return a;
}

beforeEach(() => { agents.clear(); ptyProcesses.clear(); });

describe('an agent nobody owns, and the first status posted for it', () => {
  it("1. is not adopted by a CLI that is not its terminal's", async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'running', event: 'UserPromptSubmit' }, NESTED);
    await settle();
    expect(a.currentSessionId).toBeUndefined();
    expect(a.resumableSessionId).toBeUndefined();
  });

  it("1. is adopted by its terminal's own CLI", async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('own'), status: 'running', event: 'UserPromptSubmit' }, TERMINAL);
    await settle();
    expect(a.currentSessionId).toBe(sid('own'));
  });

  it('1. is adopted, as before, by a post that names no CLI', async () => {
    const a = agent();
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('gemini'), status: 'running' });
    await settle();
    expect(a.currentSessionId).toBe(sid('gemini'));
  });
});

describe('a registration refused', () => {
  it('2. is said in the agent\'s kept output, which Logs shows', async () => {
    const a = agent({ currentSessionId: sid('own'), resumableSessionId: sid('own') });
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'idle', source: 'startup', cli_pid: String(NESTED) });
    await settle();
    expect(a.currentSessionId).toBe(sid('own'));
    expect(a.output.join('')).toMatch(/\[Tars\].*refused.*not this terminal's/i);
  });
});

describe('a post from a CLI that is not the terminal\'s, for an agent nobody owns', () => {
  it('3. answers stale, and leaves the status as it was', async () => {
    const a = agent({ status: 'waiting' });
    const routes = app(); registerHooksRoutes(routes, ctx);
    const prompt = post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'running', event: 'UserPromptSubmit', current_task: 'nested work' }, NESTED);
    await settle();
    expect(a.status, 'a nested turn set the agent running').toBe('waiting');
    expect(a.currentTask).toBeUndefined();
    expect(prompt).toMatchObject({ stale: true });
    const stop = post(routes, { agent_id: 'a1', session_id: sid('nested'), status: 'idle' }, NESTED);
    await settle();
    expect(a.status, 'a nested Stop set the agent idle').toBe('waiting');
    expect(stop).toMatchObject({ stale: true });
  });

  it("3. lets the terminal's own CLI drive the status once known", async () => {
    const a = agent({ status: 'idle' });
    const routes = app(); registerHooksRoutes(routes, ctx);
    post(routes, { agent_id: 'a1', session_id: sid('own'), status: 'running', event: 'UserPromptSubmit' }, TERMINAL);
    await settle();
    expect(a.currentSessionId).toBe(sid('own'));
    expect(a.status).toBe('running');
  });
});

describe('the other routes a nested CLI\'s hooks post to, for an agent nobody owns', () => {
  it('3. leave the last output, the status and the alerts as they were', async () => {
    const a = agent({ status: 'running', lastCleanOutput: 'its own answer' });
    const routes = app(); registerHooksRoutes(routes, ctx);
    const said = post(routes, { agent_id: 'a1', session_id: sid('nested'), hook: 'Stop', output: 'ok' }, NESTED, '/api/hooks/output');
    const done = post(routes, { agent_id: 'a1', session_id: sid('nested') }, NESTED, '/api/hooks/task-completed');
    const stopped = post(routes, { agent_id: 'a1', session_id: sid('nested'), hook: 'Stop' }, NESTED, '/api/hooks/agent-stopped');
    const alert = post(routes, { agent_id: 'a1', session_id: sid('nested'), type: 'permission_prompt', message: 'nested asks' }, NESTED, '/api/hooks/notification');
    await settle();
    expect(a.lastCleanOutput).toBe('its own answer');
    expect(a.status).toBe('running');
    for (const answer of [said, done, stopped, alert]) expect(answer).toMatchObject({ stale: true });
  });
});
