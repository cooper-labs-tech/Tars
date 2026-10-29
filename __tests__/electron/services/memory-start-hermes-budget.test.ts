import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * The memory an agent is given as its session starts, when Hermes does not answer.
 *
 * The block injected at session start holds the project's own memory, the recent activity on it and Hermes's memory
 * files. It waited up to 4000 ms for Hermes, and the SessionStart hook's curl gives up after 3 s
 * (hooks/session-start.sh). So with a Hermes that accepts the connection and never answers (the ssh tunnel up, the
 * server silent) the agent started with no memory at all, its own project's included: 4005 ms, measured by the Audit
 * on main (DESIGN-HERMES-HUB.md, banc-hermes-hub/digest-hermes-down.test.ts). A CLI without the hook, which gets the
 * block in its prompt, waited up to 3000 ms for Hermes before its terminal was even opened.
 *
 * How this can fail, written before the code:
 * 1. a Hermes that accepts the connection and never answers holds the block past the hook's 3 s;
 * 2. the project's own memory is missing when Hermes stalls, or refuses the connection;
 * 3. the wait is cut so short that a Hermes answering in a few hundred milliseconds is left out;
 * 4. the hook's route, /api/memory/context, answers after the hook's 3 s when Hermes stalls;
 * 5. a start that puts the block in the prompt (a CLI without the hook) waits on a stalled Hermes longer than the
 *    session start's budget;
 * 6. a Hermes that answers one of its two memory files in time and never the other loses both, as the Audit measured
 *    at the gate of #271 (MEMORY.md answered in 100 ms, USER.md never, nothing of Hermes in the block): what came in
 *    time is kept, whichever file it is.
 *
 * Hermes is a real socket: one that accepts and never answers, a port that refuses, and an HTTP server that answers
 * its memory files after 300 ms. The block is the real assembleDigest; the route and the start are the real ones,
 * mounted as agent-routes-race.test.ts mounts them, with the terminal a mock that records when it was opened.
 */

/** Under the hook's 3 s (curl --max-time 3), with the room a loaded machine needs. */
const WITHIN_THE_HOOK_MS = 2500;

const hermesNow = vi.hoisted(() => ({ conn: null as null | Record<string, unknown> }));
vi.mock('../../../electron/services/hermes-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-config')>()),
  usableHermesConnection: () => hermesNow.conn,
}));

const spawned = vi.hoisted(() => [] as Array<{ at: number; file: string }>);
vi.mock('node-pty', () => ({
  spawn: vi.fn((file: string) => {
    spawned.push({ at: Date.now(), file });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), process: file, pid: 4242 };
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
}));
vi.mock('../../../electron/utils/path-builder', async () => {
  if (process.platform !== 'win32') return { buildFullPath: vi.fn(() => '/usr/bin') };
  // On Windows the direct launch (D2) resolves codex to a file on this PATH
  // before it opens the terminal: a stand-in codex.exe, never run (pty.spawn
  // is mocked).
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-'));
  fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  return { buildFullPath: vi.fn(() => dir) };
});

import { assembleDigest } from '../../../electron/services/memory-hub';
import { registerMemoryRoutes } from '../../../electron/services/api-routes/memory-routes';
import { performDispatch } from '../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../electron/core/agent-manager';
import type { RouteApp, RouteContext, RouteRequest } from '../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../electron/types';

const LOCAL_FACT = 'local fact that must reach the agent';
const HERMES_FACT = 'hermes fact answered in time';
let project: string;
const conns: Record<'stalled' | 'refused' | 'answering' | 'memoryOnly' | 'userOnly', Record<string, unknown>> = {} as never;
const held: net.Socket[] = [];
const blackHole = net.createServer((s) => { held.push(s); });
const answering = http.createServer((req, res) => {
  setTimeout(() => {
    if (req.url?.includes(encodeURIComponent('MEMORY.md'))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data_url: `data:text/markdown;base64,${Buffer.from(`- ${HERMES_FACT}\n`).toString('base64')}` }));
    } else {
      res.writeHead(404); res.end();
    }
  }, 300);
});

/** Hermes answering one memory file after 100 ms and holding the request for the other open: the gate's case. */
const HALF_FACT = 'hermes fact from the one file that answered';
const stalledReplies: http.ServerResponse[] = [];
const answersOnly = (name: 'MEMORY.md' | 'USER.md') => http.createServer((req, res) => {
  if (!req.url?.includes(encodeURIComponent(name))) { stalledReplies.push(res); return; }
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data_url: `data:text/markdown;base64,${Buffer.from(`- ${HALF_FACT} (${name})\n`).toString('base64')}` }));
  }, 100);
});
const memoryOnly = answersOnly('MEMORY.md');
const userOnly = answersOnly('USER.md');

const listen = (s: net.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));
const conn = (port: number) => ({ mode: 'local', localPort: port, authMode: 'token', token: 'not-a-real-token' });

beforeAll(async () => {
  conns.stalled = conn(await listen(blackHole));
  conns.answering = conn(await listen(answering));
  conns.memoryOnly = conn(await listen(memoryOnly));
  conns.userOnly = conn(await listen(userOnly));
  const closed = net.createServer();
  const port = await listen(closed);
  await new Promise<void>((r) => closed.close(() => r()));
  conns.refused = conn(port);
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-start-memory-')));
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `- ${LOCAL_FACT}\n`);
});

afterAll(() => {
  held.forEach((s) => s.destroy());
  blackHole.close();
  answering.close();
  stalledReplies.forEach((res) => res.destroy());
  memoryOnly.close();
  userOnly.close();
  fs.rmSync(project, { recursive: true, force: true });
});

beforeEach(() => {
  spawned.length = 0;
  agents.clear();
});

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  const value = await work();
  return { ms: Date.now() - t0, value };
}

const digestWith = (hermes: Record<string, unknown>) =>
  timed(() => assembleDigest({ projectPath: project, settings: {} as never, hermes: hermes as never }));

describe('the block a session starts with', () => {
  it('1, 2. a Hermes that accepts and never answers: the block comes back within the hook\'s 3 s, with the project\'s memory', async () => {
    const { ms, value } = await digestWith(conns.stalled);

    expect(ms, 'the block waited past the hook').toBeLessThan(WITHIN_THE_HOOK_MS);
    expect(value).toContain(LOCAL_FACT);
  }, 15000);

  it('2. a Hermes that refuses the connection: the block comes back at once, with the project\'s memory', async () => {
    const { ms, value } = await digestWith(conns.refused);

    expect(ms).toBeLessThan(1000);
    expect(value).toContain(LOCAL_FACT);
  }, 15000);

  it('6. a Hermes that answers MEMORY.md and never USER.md: MEMORY.md is in the block, within the hook\'s 3 s', async () => {
    const { ms, value } = await digestWith(conns.memoryOnly);

    expect(ms, 'the block waited past the hook').toBeLessThan(WITHIN_THE_HOOK_MS);
    expect(value).toContain(`${HALF_FACT} (MEMORY.md)`);
    expect(value).toContain(LOCAL_FACT);
  }, 15000);

  it('6. a Hermes that answers USER.md and never MEMORY.md: USER.md is in the block', async () => {
    const { ms, value } = await digestWith(conns.userOnly);

    expect(ms, 'the block waited past the hook').toBeLessThan(WITHIN_THE_HOOK_MS);
    expect(value).toContain(`${HALF_FACT} (USER.md)`);
  }, 15000);

  it('3. a Hermes that answers in 300 ms is in the block, after the project\'s memory', async () => {
    const { value } = await digestWith(conns.answering);

    expect(value).toContain(HERMES_FACT);
    expect(value.indexOf(LOCAL_FACT)).toBeLessThan(value.indexOf(HERMES_FACT));
  }, 15000);
});

function routeApp(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

function context(): RouteContext {
  return {
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never,
    appSettings: {} as AppSettings,
    getAppSettings: () => ({} as AppSettings),
    getTelegramBot: () => null,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'pty-id'),
    agentStatusEmitter: new EventEmitter(),
  } as never;
}

describe('where the block goes out, with a Hermes that accepts and never answers', () => {
  it('4. the hook\'s route answers within the hook\'s 3 s, with the project\'s memory', async () => {
    hermesNow.conn = conns.stalled;
    const app = routeApp();
    registerMemoryRoutes(app, context());
    const route = app.routes.find((r) => r.method === 'GET' && r.pattern === '/api/memory/context');
    expect(route, 'no /api/memory/context route').toBeDefined();
    const answers: unknown[] = [];
    const url = new URL(`http://127.0.0.1/api/memory/context?project_path=${encodeURIComponent(project)}`);

    const req = { method: 'GET', pathname: url.pathname, url, body: {} } as unknown as RouteRequest;
    const ctx = context();
    const { ms } = await timed(async () => route!.handler(req, (body: unknown) => { answers.push(body); }, ctx));

    expect(ms, 'the route answered after the hook gave up').toBeLessThan(WITHIN_THE_HOOK_MS);
    expect(JSON.stringify(answers[0])).toContain(LOCAL_FACT);
  }, 15000);

  it('5. a CLI without the hook has its terminal opened within the session start\'s budget', async () => {
    hermesNow.conn = conns.stalled;
    const agent = {
      id: 'codex-1', name: 'Codex Worker', status: 'idle', provider: 'codex', projectPath: project,
      skills: [], output: [], lastActivity: new Date().toISOString(),
    } as unknown as AgentStatus;
    agents.set(agent.id, agent);

    const t0 = Date.now();
    void performDispatch(agent, { message: 'the task' }, context(), vi.fn());
    for (let i = 0; i < 160 && spawned.length === 0; i++) await new Promise((r) => setTimeout(r, 50));

    expect(spawned, 'the terminal was never opened').toHaveLength(1);
    expect(spawned[0].at - t0, 'the start waited on Hermes past the budget').toBeLessThan(WITHIN_THE_HOOK_MS);
  }, 15000);
});
