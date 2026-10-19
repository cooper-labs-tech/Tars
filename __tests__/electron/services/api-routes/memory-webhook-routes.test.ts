import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Both route modules resolve paths from os.homedir() at import time.
const h = vi.hoisted(() => ({
  home: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `dorothy-memroutes-test-${process.pid}`),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => h.home };
});

vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
}));

vi.mock('../../../../electron/core/pty-manager', () => ({
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => '/mock/app') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { registerMemoryRoutes } from '../../../../electron/services/api-routes/memory-routes';
import { registerWebhookRoutes } from '../../../../electron/services/api-routes/webhook-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { DEFAULT_GATEWAY, setGatewayProjects } from '../../../../electron/services/hermes-gateways';
import { RouteApp, RouteContext, RouteRequest, RouteHandler, SendJson } from '../../../../electron/services/api-routes/types';
import { AgentStatus } from '../../../../electron/types';

// ── Harness ──────────────────────────────────────────────────────────────────

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

function findHandler(app: RouteApp, method: string, pathname: string): RouteHandler {
  const def = app.routes.find(r => r.method === method && r.pattern === pathname);
  if (!def) throw new Error(`no route ${method} ${pathname}`);
  return def.handler;
}

async function call(handler: RouteHandler, req: Partial<RouteRequest>): Promise<{ data: unknown; status: number }> {
  let result: { data: unknown; status: number } = { data: undefined, status: 0 };
  const sendJson: SendJson = (data, status = 200) => { result = { data, status }; };
  // The webhook opens to Hermes alone, which the server's door decides from
  // the secret: a call here stands for one the door has already let through,
  // with the default gateway's secret. api-who-may-drive-an-agent.test.ts and
  // hermes-gateway-webhook.test.ts hold the door and the refusals.
  const withRaw = { raw: { headers: {} }, hermes: true, hermesGateway: DEFAULT_GATEWAY, ...req } as RouteRequest;
  await handler(withRaw, sendJson, {} as RouteContext);
  return result;
}

function makeAgent(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'agent-1',
    status: 'idle',
    projectPath: '/test/project',
    skills: [],
    output: [],
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

const PROJECT = '/Users/test/my_app';
// Current CLI encoding: every non-alphanumeric → '-'
const ENCODED = '-Users-test-my-app';

let app: RouteApp;

beforeEach(() => {
  fs.rmSync(h.home, { recursive: true, force: true });
  fs.mkdirSync(h.home, { recursive: true });
  (agents as Map<string, AgentStatus>).clear();
  app = makeRouteApp();
  // The routes read app settings to know which memory backends to consult.
  registerMemoryRoutes(app, { getAppSettings: () => ({}) } as unknown as RouteContext);
  registerWebhookRoutes(app, {} as RouteContext);
});

afterAll(() => {
  fs.rmSync(h.home, { recursive: true, force: true });
});

// ── Memory routes ────────────────────────────────────────────────────────────

describe('GET /api/memory/context', () => {
  it('returns MEMORY.md content for the project (strict encoding)', async () => {
    const memDir = path.join(h.home, '.claude', 'projects', ENCODED, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Index\n- key fact');

    const handler = findHandler(app, 'GET', '/api/memory/context');
    const { data } = await call(handler, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent(PROJECT)}`) });
    expect((data as { context: string }).context).toContain('key fact');
    expect((data as { context: string }).context).toContain('Project memory');
  });

  it('falls back to legacy dot-preserving encodings', async () => {
    // Legacy scheme: only '/' replaced — dots survive
    const legacyDir = path.join(h.home, '.claude', 'projects', '-Users-test-docs.site', 'memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'MEMORY.md'), 'legacy memory');

    const handler = findHandler(app, 'GET', '/api/memory/context');
    const { data } = await call(handler, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent('/Users/test/docs.site')}`) });
    expect((data as { context: string }).context).toContain('legacy memory');
  });

  it('includes recent observations and returns empty context when nothing exists', async () => {
    const handler = findHandler(app, 'GET', '/api/memory/context');

    const empty = await call(handler, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent(PROJECT)}`) });
    expect((empty.data as { context: string }).context).toBe('');

    // Store an observation, then re-read
    const remember = findHandler(app, 'POST', '/api/memory/remember');
    await call(remember, { body: { agent_id: 'a1', project_path: PROJECT, content: 'Edited src/index.ts', type: 'file_edit' } });

    const withObs = await call(handler, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent(PROJECT)}`) });
    expect((withObs.data as { context: string }).context).toContain('Edited src/index.ts');
    expect((withObs.data as { context: string }).context).toContain('Recent activity');
  });

  it('truncates oversized MEMORY.md', async () => {
    const memDir = path.join(h.home, '.claude', 'projects', ENCODED, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), 'x'.repeat(10000));

    const handler = findHandler(app, 'GET', '/api/memory/context');
    const { data } = await call(handler, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent(PROJECT)}`) });
    const ctx = (data as { context: string }).context;
    expect(ctx.length).toBeLessThan(7000);
    expect(ctx).toContain('truncated');
  });
});

describe('POST /api/memory/remember', () => {
  it('appends observations to the per-project ledger and caps content length', async () => {
    const handler = findHandler(app, 'POST', '/api/memory/remember');
    const { data } = await call(handler, { body: { agent_id: 'a1', project_path: PROJECT, content: 'y'.repeat(900), type: 'command' } });
    expect(data).toMatchObject({ success: true });

    const ledger = path.join(h.home, '.dorothy', 'observations', `${ENCODED}.jsonl`);
    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.content).toHaveLength(500);
    expect(rec.agentId).toBe('a1');
  });

  it('rejects missing content or project_path', async () => {
    const handler = findHandler(app, 'POST', '/api/memory/remember');
    expect((await call(handler, { body: { project_path: PROJECT } })).status).toBe(400);
    expect((await call(handler, { body: { content: 'x' } })).status).toBe(400);
  });

  it('content with quotes and newlines survives round-trip into context', async () => {
    const nasty = 'Ran command: git commit -m "fix: \\"quoted\\"" \n(second line)';
    const remember = findHandler(app, 'POST', '/api/memory/remember');
    await call(remember, { body: { agent_id: 'a1', project_path: PROJECT, content: nasty, type: 'command' } });

    const context = findHandler(app, 'GET', '/api/memory/context');
    const { data } = await call(context, { url: new URL(`http://x/api/memory/context?project_path=${encodeURIComponent(PROJECT)}`) });
    expect((data as { context: string }).context).toContain('git commit -m');
  });
});

// ── Hermes webhook ───────────────────────────────────────────────────────────

describe('POST /api/webhooks/hermes', () => {
  // What the default gateway reaches, as the user allows it in Settings since 2.0.4: nothing until then.
  beforeEach(() => { setGatewayProjects(DEFAULT_GATEWAY, ['/test/project', '/p/one', '/p/two']); });

  it('resolves by exact id and by case-insensitive name, dry_run dispatches nothing', async () => {
    (agents as Map<string, AgentStatus>).set('a1', makeAgent({ id: 'a1', name: 'QA — myapp' }));
    const handler = findHandler(app, 'POST', '/api/webhooks/hermes');

    const byId = await call(handler, { body: { agent_id: 'a1', message: 'go', dry_run: true } });
    expect(byId.data).toMatchObject({ success: true, dry_run: true, agent: { id: 'a1' } });

    const byName = await call(handler, { body: { agent_name: 'qa — MYAPP', message: 'go', dry_run: true } });
    expect(byName.data).toMatchObject({ success: true, agent: { id: 'a1' } });
  });

  it('404s naming no agent when the agent is unknown, 400s without message', async () => {
    // Until 2.0.4 the 404 carried the roster: every agent, its project and status (the Audit's NOW-3).
    (agents as Map<string, AgentStatus>).set('a1', makeAgent({ id: 'a1', name: 'QA' }));
    const handler = findHandler(app, 'POST', '/api/webhooks/hermes');

    const notFound = await call(handler, { body: { agent_name: 'ghost', message: 'go' } });
    expect(notFound.status).toBe(404);
    expect((notFound.data as { agents?: unknown[] }).agents).toBeUndefined();
    for (const named of ['a1', 'QA', '/test/project']) expect(JSON.stringify(notFound.data)).not.toContain(named);

    expect((await call(handler, { body: { agent_id: 'a1' } })).status).toBe(400);
  });

  it('409s on ambiguous names, listing neither, and disambiguates via project_path', async () => {
    (agents as Map<string, AgentStatus>).set('a1', makeAgent({ id: 'a1', name: 'QA', projectPath: '/p/one' }));
    (agents as Map<string, AgentStatus>).set('a2', makeAgent({ id: 'a2', name: 'QA', projectPath: '/p/two' }));
    const handler = findHandler(app, 'POST', '/api/webhooks/hermes');

    const ambiguous = await call(handler, { body: { agent_name: 'QA', message: 'go', dry_run: true } });
    expect(ambiguous.status).toBe(409);
    expect((ambiguous.data as { matches?: unknown[] }).matches).toBeUndefined();
    for (const named of ['a1', 'a2', '/p/one', '/p/two']) expect(JSON.stringify(ambiguous.data)).not.toContain(named);

    const scoped = await call(handler, { body: { agent_name: 'QA', project_path: '/p/two', message: 'go', dry_run: true } });
    expect(scoped.data).toMatchObject({ success: true, agent: { id: 'a2' } });
  });
});
