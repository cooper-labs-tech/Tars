import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveTestHome } from '../setup/test-home';

/**
 * The bundled MCP servers send the agent's token only to the Tars that started
 * its CLI, as the hooks do (tars-hook.sh; the Audit's Info on #370).
 *
 * mcp-orchestrator, mcp-memory (mcp-shared's apiRequest), mcp-kanban and
 * mcp-vault presented CLAUDE_MGR_API_TOKEN to CLAUDE_MGR_API_URL with no check.
 * A CLI that outlives a quit keeps its MCP servers, and whatever then holds the
 * port got the token with their next call.
 *
 * How it fails, written before the code:
 * 1. A port that does not prove it knows the CLI's TARS_INSTANCE_ID gets the
 *    agent's token, from any of the four servers.
 * 2. It gets the shared token from ~/.dorothy/api-token instead.
 * 3. Over-correction: the Tars that started the CLI no longer gets the token.
 * 4. A proof kept for the server's life (the Audit's M1 on #376): a server
 *    proves itself at its first tool call, so a CLI that outlived a quit,
 *    whose servers had all called Tars before it, handed its token to the
 *    squatter with its next call. The port proves itself before every call.
 * 5. A CLI Tars did not start (no token in its environment) presents the
 *    shared token. It did until 2.0.4, when the secrets left ~/.dorothy for
 *    ~/.tars-private, which nothing handed to an agent reads: it presents
 *    none, from wherever the file is, and Tars answers 401.
 * 6. A token with no TARS_INSTANCE_ID beside it is sent unproven.
 * 7. (The Audit's Low on #376's delta) The proof waits less than the call it
 *    guards: a Tars whose main thread is held past that answers the challenge
 *    late, the call leaves with no token and gets a 401 once Tars is back,
 *    where it used to wait. A port that never answers gets nothing however
 *    long the wait, so the proof waits as long as its call.
 *
 * Added on 2026-10-18 for a task queued in Tars's memory and lost with a
 * restart (2.0.4, one task at a time), before the code:
 * 8. A call refused because the port proved another instance (the token
 *    withheld) is refused like any other: nothing tells its caller that the
 *    Tars that started its CLI is gone, so delegate_task, waiting on a task
 *    the restart dropped, retries for 90 s and says Tars could not be reached.
 * 9. Over-correction: a refusal by the Tars that started the CLI, or a port
 *    that answers nothing, reads as another Tars.
 */

const INSTANCE = crypto.randomBytes(16).toString('hex');
const TOKEN = 'token-of-a1s-terminal';
const SHARED = 'the-shared-token';
let mode: 'tars' | 'squatter' = 'tars';
/** How long the server takes to answer the challenge: a Tars whose main thread is held. */
let healthDelayMs = 0;
const received: Array<{ path: string; authorization?: string }> = [];
let server: http.Server;
let url: string;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-proof-'));
let restoreHome: () => void;
let saved: Record<string, string | undefined>;
const ENV = ['CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH'];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    received.push({ path: u.pathname, authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      // As Tars answers a route that takes a token: 401 without one; and a refusal whatever is presented.
      if ((u.pathname === '/api/needs-token' && !req.headers.authorization) || u.pathname === '/api/refused') {
        res.writeHead(u.pathname === '/api/refused' ? 403 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: u.pathname === '/api/refused' ? 'Refused.' : 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (u.pathname === '/api/health') {
        const instance = mode === 'tars' ? INSTANCE : 'someone-else';
        const answer = JSON.stringify({ ok: true, proof: crypto.createHash('sha256').update(`${instance}:${u.searchParams.get('challenge') ?? ''}`).digest('hex') });
        setTimeout(() => res.end(answer), healthDelayMs);
        return;
      }
      res.end(JSON.stringify({ success: true, agents: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const dir of ['.tars', '.tars-private']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, 'api-token'), SHARED);
  }
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  received.length = 0;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  restoreHome = moveTestHome(home);
});
afterEach(() => {
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.resetModules();
});

/** The four servers' clients, loaded afresh: each reads its environment when it loads. */
async function clients(env: Record<string, string | undefined>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { CLAUDE_MGR_API_URL: url, CLAUDE_AGENT_ID: 'a1' }, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  vi.resetModules();
  const shared = await import('../../mcp-shared/src/tars-api');
  const kanban = await import('../../mcp-kanban/src/api');
  const vault = await import('../../mcp-vault/src/utils/api');
  return [
    ['mcp-orchestrator and mcp-memory', () => shared.apiRequest('/api/agents')],
    ['mcp-kanban', () => kanban.apiRequest('GET', '/api/kanban/tasks')],
    ['mcp-vault', () => vault.apiRequest('GET', '/api/vault/documents')],
  ] as const;
}
const calls = () => received.filter((r) => r.path !== '/api/health');

describe("the MCP servers' calls to Tars", () => {
  it('1, 2. a port that does not prove the instance gets neither the token nor the shared one', async () => {
    mode = 'squatter';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE })) {
      received.length = 0;
      await call().catch(() => undefined);
      expect(calls().map((r) => r.authorization), name).toEqual([undefined]);
    }
  });

  it('3. the Tars that started the CLI gets the token, at every call', async () => {
    mode = 'tars';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE })) {
      received.length = 0;
      await call();
      await call();
      expect(calls().map((r) => r.authorization), name).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    }
  });

  it('4. a squatter that took the port after a proof gets no token', async () => {
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE })) {
      mode = 'tars';
      received.length = 0;
      await call();
      mode = 'squatter';
      await call().catch(() => undefined);
      expect(calls().map((r) => r.authorization), name).toEqual([`Bearer ${TOKEN}`, undefined]);
    }
  });

  it('5. a CLI Tars did not start presents no token, the shared one neither, wherever its file is', async () => {
    mode = 'squatter';
    const [[, orchestrator], , [, vault]] = await clients({ CLAUDE_MGR_API_TOKEN: undefined, TARS_INSTANCE_ID: undefined });
    await orchestrator().catch(() => undefined);
    await vault().catch(() => undefined);
    expect(calls().map((r) => r.authorization)).toEqual([undefined, undefined]);
    expect(received.some((r) => r.path === '/api/health')).toBe(false);
  });

  it('7. a Tars that answers the challenge after 6 s still gets the token', async () => {
    mode = 'tars';
    healthDelayMs = 6_000;
    try {
      const all = await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE });
      received.length = 0;
      await Promise.all(all.map(([, call]) => call()));
      expect(calls().map((r) => r.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    } finally {
      healthDelayMs = 0;
    }
  }, 30_000);

  it('6. a token with no instance id beside it is not sent', async () => {
    mode = 'tars';
    for (const [name, call] of await clients({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: undefined })) {
      received.length = 0;
      await call().catch(() => undefined);
      expect(calls().map((r) => r.authorization), name).toEqual([undefined]);
    }
  });
});

describe('a call the token was withheld from, because another Tars holds the port', () => {
  type Refusal = Error & { status?: number; anotherTars?: boolean };
  async function refusal(env: Record<string, string | undefined>, endpoint: string): Promise<Refusal> {
    await clients(env);
    const { apiRequest } = await import('../../mcp-shared/src/tars-api');
    return apiRequest(endpoint).then(() => { throw new Error(`answered: ${endpoint}`); }, (err: Refusal) => err);
  }

  it('8. says so on its refusal: the Tars that started the CLI is not the one that answered', async () => {
    mode = 'squatter';
    const err = await refusal({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE }, '/api/needs-token');
    expect(calls().map((r) => r.authorization)).toEqual([undefined]);
    expect(err.status).toBe(401);
    expect(err.anotherTars).toBe(true);
  });

  it("9. a refusal by the CLI's own Tars, or a port that answers nothing, does not", async () => {
    mode = 'tars';
    const own = await refusal({ CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE }, '/api/refused');
    expect(own.status).toBe(403);
    expect(own.anotherTars).toBeUndefined();

    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const nobody = `http://127.0.0.1:${(closed.address() as { port: number }).port}`;
    await new Promise<void>((r) => closed.close(() => r()));
    const down = await refusal({ CLAUDE_MGR_API_URL: nobody, CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE }, '/api/needs-token');
    expect(down.status).toBeUndefined();
    expect(down.anotherTars).toBeUndefined();
  });
});
