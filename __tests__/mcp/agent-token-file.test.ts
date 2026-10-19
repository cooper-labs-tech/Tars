import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { moveTestHome } from '../setup/test-home';

/**
 * The MCP servers of a delegated run read their agent's token from a file (2.0.4).
 *
 * A run over ACP hands its servers a list of variables, and the claude adapter writes that list into the
 * `--mcp-config` JSON of the claude it starts: the run's token, in that list, could be read by any process on the
 * machine (`ps`, measured 17/10 on claude-agent-acp 0.93.0). The list now carries the path of a file only its owner
 * reads (services/acp/delegate.ts), and the servers read the token there. The ways it fails:
 *
 * 1. A server handed the file and no token in its environment presents another token: the shared one, on which a
 *    call names no agent, so the run could neither speak in its room nor delegate in turn, or none.
 * 2. The file read with its line end: a token that names nobody.
 * 3. A terminal's token, in the environment, overridden by a file.
 * 4. A path to nothing taken for a token, or a crash of the server: it presents what a session started before
 *    tokens existed presents.
 *
 * The transports are replaced and nothing else: the port's proof (http.request) is answered as the Tars that started
 * the CLI answers it, and the call itself (fetch) is kept, so that these read the headers it would have sent. The
 * client is pointed at a port where nothing listens, so that no Tars, not even the one the suite runs inside, ever
 * receives these tokens.
 */

const INSTANCE = 'instance-of-the-tars-that-started-this-cli';
const sent: Array<{ headers: Record<string, string> }> = [];

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    request: vi.fn((options: { path?: string; headers: Record<string, string> }, onResponse: (res: EventEmitter) => void) => {
      const health = (options.path ?? '').startsWith('/api/health?challenge=');
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void; destroy: () => void; setTimeout: () => void };
      req.write = () => {};
      req.destroy = () => {};
      req.setTimeout = () => {};
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-token-file-'));
const tokenFile = path.join(home, 'run', 'token');
const VARS = ['CLAUDE_MGR_API_TOKEN', 'CLAUDE_MGR_API_TOKEN_FILE', 'CLAUDE_MGR_API_URL', 'TARS_INSTANCE_ID'] as const;
let saved: Record<string, string | undefined>;
let restoreHome: () => void;

beforeEach(() => {
  sent.length = 0;
  saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  delete process.env.CLAUDE_MGR_API_TOKEN;
  delete process.env.CLAUDE_MGR_API_TOKEN_FILE;
  process.env.TARS_INSTANCE_ID = INSTANCE;
  process.env.CLAUDE_MGR_API_URL = 'http://127.0.0.1:9';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    sent.push({ headers: init.headers });
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), 'the-shared-token-from-the-file');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, 'the-token-minted-for-this-run\n', { mode: 0o600 });
  restoreHome = moveTestHome(home);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreHome();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Loaded afresh each time: the client reads its environment, and the file, when it loads. */
async function presented(): Promise<string | undefined> {
  vi.resetModules();
  const { apiRequest } = await import('../../mcp-shared/src/tars-api');
  await apiRequest('/api/agents');
  expect(sent).toHaveLength(1);
  return sent[0].headers.Authorization;
}

describe("a delegated run's MCP server", () => {
  it('presents the token of the file it is handed, line end and all removed', async () => {
    process.env.CLAUDE_MGR_API_TOKEN_FILE = tokenFile;
    expect(await presented()).toBe('Bearer the-token-minted-for-this-run');
  });

  it('prefers the token of its environment, a terminal\'s, to a file', async () => {
    process.env.CLAUDE_MGR_API_TOKEN = 'the-token-minted-for-this-terminal';
    process.env.CLAUDE_MGR_API_TOKEN_FILE = tokenFile;
    expect(await presented()).toBe('Bearer the-token-minted-for-this-terminal');
  });

  it('takes no path to nothing for a token, and presents what a session without one does', async () => {
    process.env.CLAUDE_MGR_API_TOKEN_FILE = path.join(home, 'run', 'gone');
    expect(await presented()).toBe('Bearer the-shared-token-from-the-file');
  });
});
