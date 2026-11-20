import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { moveTestHome } from '../setup/test-home';

const INSTANCE = 'instance-of-the-tars-that-started-this-cli';

/**
 * mcp-vault presents the agent's own token when it has one.
 *
 * The transport is replaced and nothing else: the real client builds the
 * request, and these read where it would have gone and the headers it would
 * have sent. Nothing reaches a Tars, not even the one the suite may be running
 * inside.
 */

const sent: Array<{ hostname?: string; port?: number; headers: Record<string, string> }> = [];

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    request: vi.fn((options: { hostname?: string; port?: number; path?: string; headers: Record<string, string> }, onResponse: (res: EventEmitter) => void) => {
      // The Tars this agent's CLI was started by, proving it before the token goes out (tars-api.ts).
      const health = (options.path ?? '').startsWith('/api/health?challenge=');
      if (!health) sent.push({ hostname: options.hostname, port: options.port, headers: options.headers ?? {} });
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        onResponse(res);
        const challenge = health ? new URL(options.path!, 'http://x').searchParams.get('challenge') : null;
        res.emit('data', health ? JSON.stringify({ proof: createHash('sha256').update(`${INSTANCE}:${challenge}`).digest('hex') }) : '{}');
        res.emit('end');
      };
      return req;
    }),
  };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vault-token-'));
let saved: Record<string, string | undefined>;
let restoreHome: () => void;

beforeEach(() => {
  sent.length = 0;
  saved = { CLAUDE_MGR_API_TOKEN: process.env.CLAUDE_MGR_API_TOKEN, CLAUDE_MGR_API_URL: process.env.CLAUDE_MGR_API_URL, TARS_INSTANCE_ID: process.env.TARS_INSTANCE_ID };
  delete process.env.CLAUDE_MGR_API_TOKEN;
  process.env.TARS_INSTANCE_ID = INSTANCE;
  // The shared file an agent without a token of its own fell back to until
  // 2.0.4, where it was and where it is since.
  for (const dir of ['.tars', '.tars-private']) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, dir, 'api-token'), 'the-shared-token-from-the-file');
  }
  restoreHome = moveTestHome(home);
});

afterEach(() => {
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Loaded afresh each time: the client reads its environment when it loads. */
async function vaultClient() {
  vi.resetModules();
  return import('../../mcp-vault/src/utils/api');
}

describe('the vault client', () => {
  it("presents the agent's own token rather than the machine's shared one", async () => {
    process.env.CLAUDE_MGR_API_TOKEN = 'the-token-minted-for-this-agent';
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent).toHaveLength(1);
    expect(sent[0].headers.Authorization).toBe('Bearer the-token-minted-for-this-agent');
  });

  it('presents no token for a session started without one (2.0.4: the shared token is out of the agents\' reach)', async () => {
    delete process.env.CLAUDE_MGR_API_TOKEN;
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents').catch(() => undefined);

    expect(sent[0].headers.Authorization).toBeUndefined();
  });
});

describe('which Tars the vault client calls', () => {
  // It called 127.0.0.1:31415 whatever the environment said, so the agents of a
  // sandbox or of the e2e suite sent their documents to the Tars on this
  // machine. mcp-orchestrator and mcp-memory read CLAUDE_MGR_API_URL.
  it('the one CLAUDE_MGR_API_URL names', async () => {
    process.env.CLAUDE_MGR_API_URL = 'http://127.0.0.1:31499';
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent[0]).toMatchObject({ hostname: '127.0.0.1', port: 31499 });
  });

  it('31415 on this machine when nothing names one', async () => {
    delete process.env.CLAUDE_MGR_API_URL;
    const { apiRequest } = await vaultClient();

    await apiRequest('GET', '/api/vault/documents');

    expect(sent[0]).toMatchObject({ hostname: '127.0.0.1', port: 31415 });
  });
});
