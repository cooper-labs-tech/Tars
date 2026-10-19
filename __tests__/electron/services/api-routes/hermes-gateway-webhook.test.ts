import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What a Hermes gateway's message may do (the Audit's NOW-3, R4.1 to R4.3, 2.0.4).
 *
 * Measured on ce9c0084, before this file: `POST /api/webhooks/hermes` took a `permission_mode` that won over the
 * agent's own (webhook-routes.ts:105, agent-routes.ts:260), so whoever held the webhook secret (a gateway, or anyone
 * on the tailnet who read its config) started any agent of any project in bypass; and its 404 listed every agent,
 * with its project and status.
 *
 * The ways it fails:
 * 1. A gateway's message raising an agent's mode: bypass or auto asked for an agent in normal. It may only lower it,
 *    or keep it (plan < normal < auto < bypass, core/permission-ceiling.ts): a raise is refused, 403, nothing is
 *    typed and no session starts. A lower mode is the session's when one starts.
 * 2. A mode that is none of Tars's taken as some mode, or passed on.
 * 3. A gateway reaching an agent of a project the user did not allow it, by its id, its name, a project path or a
 *    dry run: 404, as if there were none, and nothing typed. A gateway reaches no project until the user allows one.
 * 4. A refusal naming what it refused: the 404 listed every agent (id, name, project, status), the 409 listed the
 *    agents a name matched. No refusal names an agent, a project or a mode the agent is in.
 * 5. A gateway's secret opening another gateway's route: the default's on a gateway's route, a gateway's on the
 *    default's, a gateway's on a route of a gateway that does not exist (403), or on any other route (401).
 * 6. The same raise through /dispatch and /start, by an agent with a token of its own (R4.1: "the same holds for
 *    /dispatch and /start callers"): refused there too, before any session starts.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gw-hook-'));
const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gw-hook-private-'));
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(picked));
    });
  });
}

vi.mock('../../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../electron/constants')>();
  return {
    ...actual,
    get API_PORT() { return port; },
    DATA_DIR: tmp,
    dataPath: (...segments: string[]) => path.join(tmp, ...segments),
    AGENTS_FILE: path.join(tmp, 'agents.json'),
    APP_SETTINGS_FILE: path.join(tmp, 'app-settings.json'),
    KANBAN_FILE: path.join(tmp, 'kanban-tasks.json'),
    TELEGRAM_DOWNLOADS_DIR: path.join(tmp, 'telegram-downloads'),
    VAULT_DIR: path.join(tmp, 'vault'),
    VAULT_DB_FILE: path.join(tmp, 'vault.db'),
    API_TOKEN_FILE: path.join(tmp, 'api-token'),
    BUS_FILE: path.join(tmp, 'bus.json'),
    HERMES_WEBHOOK_SECRET_FILE: path.join(privateTmp, 'hermes-webhook-secret'),
    HERMES_WEBHOOK_SECRET_LEGACY_FILE: path.join(tmp, 'hermes-webhook-secret'),
    HERMES_GATEWAYS_FILE: path.join(privateTmp, 'hermes-gateways.json'),
  };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import * as pty from 'node-pty';
import type { AgentStatus } from '../../../../electron/types';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform === 'win32') Object.defineProperty(process, 'platform', { ...hostPlatform, value: 'linux' });
});
afterAll(() => { Object.defineProperty(process, 'platform', hostPlatform); });

let api: typeof import('../../../../electron/services/api-server');
let agents: typeof import('../../../../electron/core/agent-manager')['agents'];
let ptyProcesses: typeof import('../../../../electron/core/pty-manager')['ptyProcesses'];
let spawnAgentPty: typeof import('../../../../electron/core/agent-pty')['spawnAgentPty'];
let tokens: typeof import('../../../../electron/core/agent-tokens');
let gateways: typeof import('../../../../electron/services/hermes-gateways');

const ALPHA = '/projects/alpha';
const BETA = '/projects/beta';
const WREN = { id: 'aaaa1111-0000-4000-8000-0000000000a1', name: 'Wren', projectPath: ALPHA, permissionMode: 'normal' as const };
const BEA = { id: 'bbbb2222-0000-4000-8000-0000000000b2', name: 'Bea', projectPath: ALPHA, permissionMode: 'bypass' as const };
const OLGA = { id: 'cccc3333-0000-4000-8000-0000000000c3', name: 'Olga', projectPath: BETA, permissionMode: 'normal' as const };
const LEAD = { id: 'dddd4444-0000-4000-8000-0000000000d4', name: 'Lead', projectPath: ALPHA, permissionMode: 'normal' as const, role: 'orchestrator' as const };
const TWINS = [
  { id: 'eeee5555-0000-4000-8000-0000000000e1', name: 'Twin', projectPath: ALPHA, permissionMode: 'normal' as const },
  { id: 'eeee5555-0000-4000-8000-0000000000e2', name: 'Twin', projectPath: ALPHA, permissionMode: 'normal' as const },
];
/** What no refusal may name: every agent's id and name, every project, the modes they are in. */
const NAMES = [WREN, BEA, OLGA, LEAD, ...TWINS].flatMap(a => [a.id, a.name, a.projectPath]);

function putAgent(a: { id: string; name: string; projectPath: string; permissionMode: string; role?: string }): AgentStatus {
  const agent = {
    ...a, status: 'idle', provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString(),
  } as AgentStatus;
  agents.set(a.id, agent);
  return agent;
}

/** A terminal that records what is typed into it, a live claude in front. */
function liveTerminal(agent: AgentStatus): { written: string[] } {
  const written: string[] = [];
  agent.ptyId = `pty-${agent.id}`;
  agent.status = 'running';
  agent.ptyCwd = agent.projectPath;
  const terminal = { write: (d: string) => { written.push(d); }, process: '2.1.280', onExit: () => ({ dispose() {} }) };
  vi.mocked(pty.spawn).mockReturnValueOnce(terminal as never);
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: agent.projectPath, cols: 80, rows: 24, env: {} });
  ptyProcesses.set(agent.ptyId, terminal as never);
  return { written };
}

/** What a session started now is spawned as: its terminal, and the line it runs. */
function nextSpawn(): { spawned: () => string[] } {
  vi.mocked(pty.spawn).mockImplementation((() => ({
    pid: 4242, process: 'bash', write: () => {}, resize: () => {}, kill: () => {},
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  })) as never);
  return { spawned: () => vi.mocked(pty.spawn).mock.calls.map(c => JSON.stringify(c[1])) };
}

function call(method: string, pathname: string, headers: Record<string, string>, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: payload ? { ...headers, 'content-type': 'application/json' } : headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const namesNothing = (body: unknown) => {
  const text = JSON.stringify(body);
  return NAMES.filter(n => text.includes(n));
};

beforeAll(async () => {
  port = await freePort();
  api = await import('../../../../electron/services/api-server');
  ({ agents } = await import('../../../../electron/core/agent-manager'));
  ({ ptyProcesses } = await import('../../../../electron/core/pty-manager'));
  ({ spawnAgentPty } = await import('../../../../electron/core/agent-pty'));
  tokens = await import('../../../../electron/core/agent-tokens');
  gateways = await import('../../../../electron/services/hermes-gateways');
  api.startApiServer(
    null, { notificationsEnabled: false } as never, () => null, () => null, null, null,
    () => {}, () => {}, async () => 'pty', () => ({ notificationsEnabled: false } as never),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never listened: ${api.getApiServerState().phase}`)), 5000);
    const check = () => {
      if (api.getApiServerState().phase !== 'listening') return;
      clearTimeout(timer);
      api.apiServerEmitter.off('state', check);
      resolve();
    };
    api.apiServerEmitter.on('state', check);
    check();
  });
}, 120_000);

afterAll(() => {
  api.stopApiServer();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(privateTmp, { recursive: true, force: true });
});

let vps = '';
let vpsSecret = '';
let defaultSecret = '';

beforeEach(() => {
  vi.mocked(pty.spawn).mockReset();
  agents.clear();
  ptyProcesses.clear();
  for (const a of [WREN, BEA, OLGA, LEAD, ...TWINS]) putAgent(a);
  for (const f of fs.readdirSync(privateTmp)) fs.rmSync(path.join(privateTmp, f), { recursive: true, force: true });
  vps = gateways.addGateway('VPS').id;
  gateways.setGatewayProjects(vps, [ALPHA]);
  vpsSecret = gateways.gatewaySecret(vps);
  defaultSecret = gateways.gatewaySecret(gateways.DEFAULT_GATEWAY);
});

const hook = (secret: string, body: Record<string, unknown>, gateway: string = vps) =>
  call('POST', gateway === 'default' ? '/api/webhooks/hermes' : `/api/webhooks/hermes/${gateway}`, bearer(secret), body);

describe("a gateway's message and an agent's mode", () => {
  it('1. never raises it: bypass or auto for an agent in normal is refused, and nothing is typed', async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    for (const permission_mode of ['bypass', 'auto']) {
      const { status, body } = await hook(vpsSecret, { agent_id: WREN.id, message: `raise to ${permission_mode}`, permission_mode });
      expect(status, JSON.stringify(body)).toBe(403);
      expect(namesNothing(body)).toEqual([]);
      expect(JSON.stringify(body)).not.toContain('normal');
    }
    expect(wren.written).toEqual([]);
  });

  it('1. keeps it or lowers it: the same mode goes in; plan for an agent in bypass starts its session in plan', async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    const same = await hook(vpsSecret, { agent_id: WREN.id, message: 'at its own mode', permission_mode: 'normal' });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(wren.written.join('')).toContain('at its own mode');

    const { spawned } = nextSpawn();
    const lower = await hook(vpsSecret, { agent_id: BEA.id, message: 'look, do not touch', permission_mode: 'plan' });
    expect(lower.status, JSON.stringify(lower.body)).toBe(200);
    const lines = spawned().join('\n');
    expect(lines).toContain('--permission-mode plan');
    expect(lines).not.toContain('--dangerously-skip-permissions');
  });

  it('2. a mode that is none of Tars\'s is refused', async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    const { status, body } = await hook(vpsSecret, { agent_id: WREN.id, message: 'x', permission_mode: 'yolo' });
    expect(status).toBe(400);
    expect(namesNothing(body)).toEqual([]);
    expect(wren.written).toEqual([]);
  });
});

describe('what a gateway reaches', () => {
  it('3, 4. an agent of a project it was not allowed: 404 by id, by name, by project path and in a dry run, naming nothing', async () => {
    const olga = liveTerminal(agents.get(OLGA.id)!);
    for (const asked of [
      { agent_id: OLGA.id, message: 'by id' },
      { agent_name: 'Olga', message: 'by name' },
      { agent_name: 'Olga', project_path: BETA, message: 'by project' },
      { agent_name: 'Wren', project_path: BETA, message: 'a name it reaches, in a project it does not' },
      { agent_id: OLGA.id, message: 'dry', dry_run: true },
    ]) {
      const { status, body } = await hook(vpsSecret, asked);
      expect(status, JSON.stringify(asked)).toBe(404);
      expect(namesNothing(body), JSON.stringify(asked)).toEqual([]);
      expect(body.agents, 'the 404 lists agents').toBeUndefined();
    }
    expect(olga.written).toEqual([]);
  });

  it('3. the default gateway reaches no project until the user allows one', async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    const { status, body } = await hook(defaultSecret, { agent_id: WREN.id, message: 'from the old setup' }, 'default');
    expect(status).toBe(404);
    expect(namesNothing(body)).toEqual([]);
    expect(wren.written).toEqual([]);

    gateways.setGatewayProjects(gateways.DEFAULT_GATEWAY, [ALPHA]);
    const allowed = await hook(defaultSecret, { agent_id: WREN.id, message: 'allowed now' }, 'default');
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(wren.written.join('')).toContain('allowed now');
  });

  it('4. a name two agents share: 409, listing neither', async () => {
    const { status, body } = await hook(vpsSecret, { agent_name: 'twin', message: 'which one' });
    expect(status).toBe(409);
    expect(body.matches).toBeUndefined();
    expect(namesNothing(body)).toEqual([]);
  });

  it('a dry run answers for an agent it reaches', async () => {
    const { status, body } = await hook(vpsSecret, { agent_name: 'wren', message: 'check', dry_run: true });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true, dry_run: true, agent: { id: WREN.id, name: 'Wren', projectPath: ALPHA } });
  });
});

describe("a gateway's secret", () => {
  it("5. opens its own route only: the default's on a gateway's, a gateway's on the default's or on a gateway that is not, 403; elsewhere, 401", async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    gateways.setGatewayProjects(gateways.DEFAULT_GATEWAY, [ALPHA]);
    const crossed = [
      await hook(defaultSecret, { agent_id: WREN.id, message: 'default on vps' }, vps),
      await hook(vpsSecret, { agent_id: WREN.id, message: 'vps on default' }, 'default'),
      await hook(vpsSecret, { agent_id: WREN.id, message: 'vps on nobody' }, 'gw-ffffff'),
    ];
    for (const { status, body } of crossed) {
      expect(status, JSON.stringify(body)).toBe(403);
      expect(namesNothing(body)).toEqual([]);
    }
    const elsewhere = await call('POST', `/api/agents/${WREN.id}/dispatch`, bearer(vpsSecret), { message: 'not a webhook' });
    expect(elsewhere.status).toBe(401);
    expect(wren.written).toEqual([]);
  });

  it('a rotated secret opens nothing, and the new one does', async () => {
    const wren = liveTerminal(agents.get(WREN.id)!);
    const fresh = gateways.rotateGatewaySecret(vps);
    expect((await hook(vpsSecret, { agent_id: WREN.id, message: 'old secret' })).status).toBe(401);
    const ok = await hook(fresh, { agent_id: WREN.id, message: 'new secret' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(wren.written.join('')).toContain('new secret');
    expect(wren.written.join('')).not.toContain('old secret');
  });
});

describe('the same ceiling for an agent that starts or dispatches to another (R4.1)', () => {
  it('6. /start and /dispatch with a mode wider than the agent\'s own are refused before any session starts', async () => {
    const lead = tokens.mintAgentToken(LEAD.id);
    const { spawned } = nextSpawn();
    const start = await call('POST', `/api/agents/${WREN.id}/start`, bearer(lead), { prompt: 'go', permissionMode: 'bypass' });
    const dispatch = await call('POST', `/api/agents/${WREN.id}/dispatch`, bearer(lead), { message: 'go', permissionMode: 'bypass' });
    for (const answer of [start, dispatch]) expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    expect(spawned()).toEqual([]);

    const narrower = await call('POST', `/api/agents/${BEA.id}/start`, bearer(lead), { prompt: 'go', permissionMode: 'normal' });
    expect(narrower.status, JSON.stringify(narrower.body)).toBe(200);
    expect(spawned().join('\n')).toContain('--permission-mode default');
  });
});
