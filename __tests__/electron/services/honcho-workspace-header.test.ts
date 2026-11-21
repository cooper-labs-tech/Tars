import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Binding Honcho's workspace, and not stepping on the client's own session.
 *
 * Honcho refuses any tool call whose workspace it cannot infer, and offers no
 * way to find one: workspace_id is absent from all 31 tool schemas, so an agent
 * reads it as optional and omits it, and list_workspaces answers 502. The
 * header is the only clean binding, and it goes to two places - the
 * ~/.claude.json entry the CLIs read, and the direct calls the Brain page
 * makes. Empty setting means no header at all, which has to leave the config
 * byte for byte as it was.
 *
 * ~/.claude.json here is a temp directory. The real one is 92KB of the user's
 * own MCP servers and this suite must never go near it.
 */

const { TMP_HOME } = vi.hoisted(() => {
  const base = process.getBuiltinModule('node:os').tmpdir();
  return { TMP_HOME: process.getBuiltinModule('node:path').join(base, `tars-honcho-home-${process.pid}-${Date.now()}`) };
});

vi.mock('os', async importOriginal => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => TMP_HOME,
  default: { ...(await importOriginal<typeof import('os')>()), homedir: () => TMP_HOME },
}));

vi.mock('electron', () => ({
  app: { getPath: () => TMP_HOME, getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { setupMemoryBackends } from '../../../electron/services/mcp-orchestrator';
import { listMcpTools, clearMcpSessions } from '../../../electron/services/mcp-http-client';
import type { AppSettings } from '../../../electron/types';

const CONFIG = path.join(TMP_HOME, '.claude.json');

/** Only the memory fields matter; the rest of AppSettings is not read here. */
function settings(over: Partial<AppSettings> = {}): AppSettings {
  return {
    memoryGbrainEnabled: true,
    memoryGbrainMcpUrl: 'https://gbrain.example/mcp',
    memoryGbrainAuthToken: 'gbrain-token',
    memoryHonchoEnabled: true,
    memoryHonchoMcpUrl: 'https://honcho.example/mcp',
    memoryHonchoApiKey: 'honcho-key',
    ...over,
  } as unknown as AppSettings;
}

function readConfig(): { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> } {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
}

beforeAll(() => fs.mkdirSync(TMP_HOME, { recursive: true }));
afterAll(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

beforeEach(() => fs.writeFileSync(CONFIG, JSON.stringify({ mcpServers: {} }, null, 2)));

describe('the workspace header in ~/.claude.json', () => {
  it('is written when a workspace is configured', () => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>));

    expect(readConfig().mcpServers.honcho.headers).toMatchObject({
      'X-Honcho-Workspace-ID': 'ws-42',
    });
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only whitespace', '   '],
  ])('is absent when the setting is %s, leaving the entry as it was', (_label, value) => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: value } as Partial<AppSettings>));

    const honcho = readConfig().mcpServers.honcho;
    expect(honcho.headers ?? {}).not.toHaveProperty('X-Honcho-Workspace-ID');
    // The bearer token is still there: absent workspace must not cost the auth.
    expect(honcho.headers).toMatchObject({ Authorization: 'Bearer honcho-key' });
  });

  it('is trimmed rather than sent with the spaces around it', () => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: '  ws-42  ' } as Partial<AppSettings>));

    expect(readConfig().mcpServers.honcho.headers?.['X-Honcho-Workspace-ID']).toBe('ws-42');
  });

  it.each([
    ['with a workspace', 'ws-42'],
    ['without one', ''],
  ])('leaves gbrain alone %s, which needs nothing of the sort', (_label, ws) => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: ws } as Partial<AppSettings>));

    const gbrain = readConfig().mcpServers.gbrain;
    expect(gbrain).toEqual({
      type: 'http',
      url: 'https://gbrain.example/mcp',
      headers: { Authorization: 'Bearer gbrain-token' },
    });
  });
});

describe('a start that changes nothing', () => {
  /** Pin the file in the past; a rewrite is then visible as a newer mtime. */
  function freezeMtime(): number {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(CONFIG, past, past);
    return fs.statSync(CONFIG).mtimeMs;
  }

  it('does not rewrite ~/.claude.json when the config already matches', () => {
    const s = settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>);
    setupMemoryBackends(s);
    const frozen = freezeMtime();

    setupMemoryBackends(s);

    // Rewriting on every start churns a file the user also edits by hand, and
    // the comparison is a string compare that any reordering would defeat.
    expect(fs.statSync(CONFIG).mtimeMs).toBe(frozen);
  });

  it('does not rewrite it when both a token and a workspace header are set', () => {
    // The case the fixed build order exists for: two headers, so the same pair
    // serialised in another order would read as a change every time.
    const s = settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>);
    setupMemoryBackends(s);
    setupMemoryBackends(s);
    const frozen = freezeMtime();

    setupMemoryBackends(s);

    expect(fs.statSync(CONFIG).mtimeMs).toBe(frozen);
  });

  it('does rewrite it when the workspace actually changes', () => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>));
    freezeMtime();

    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: 'ws-43' } as Partial<AppSettings>));

    expect(readConfig().mcpServers.honcho.headers?.['X-Honcho-Workspace-ID']).toBe('ws-43');
  });

  it('does rewrite it when the workspace is removed', () => {
    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>));

    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: '' } as Partial<AppSettings>));

    expect(readConfig().mcpServers.honcho.headers ?? {}).not.toHaveProperty('X-Honcho-Workspace-ID');
  });

  it('leaves a config it cannot parse completely alone', () => {
    fs.writeFileSync(CONFIG, '{ this is not json');

    setupMemoryBackends(settings({ memoryHonchoWorkspaceId: 'ws-42' } as Partial<AppSettings>));

    expect(fs.readFileSync(CONFIG, 'utf-8')).toBe('{ this is not json');
  });
});

describe('the session id belongs to the client', () => {
  let server: http.Server;
  let url: string;
  let received: Array<Record<string, string | string[] | undefined>> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push({ ...req.headers });
      req.resume();
      req.on('end', () => {
        res.setHeader('mcp-session-id', 'session-from-the-server');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });

  afterAll(async () => { await new Promise<void>(done => server.close(() => done())); });

  beforeEach(() => { received = []; clearMcpSessions(); });
  afterEach(() => clearMcpSessions());

  it('sends the extra headers a server needs', async () => {
    await listMcpTools({ url, headers: { 'X-Honcho-Workspace-ID': 'ws-42' } });

    expect(received[0]['x-honcho-workspace-id']).toBe('ws-42');
  });

  it('does not let an endpoint header displace Mcp-Session-Id', async () => {
    // The first call establishes the session; the second carries an endpoint
    // header trying to set it. The session is this client's bookkeeping, and a
    // caller overwriting it would silently detach every later call from the
    // conversation the server opened.
    await listMcpTools({ url, headers: { 'X-Honcho-Workspace-ID': 'ws-42' } });

    const before = received.length;

    await listMcpTools({
      url,
      headers: { 'X-Honcho-Workspace-ID': 'ws-42', 'Mcp-Session-Id': 'not-the-clients' },
    });

    // The last request is the one under test. Indexing from the front lands on
    // the initialize handshake, which carries no competing header and would
    // pass whatever the ordering is: this assertion has to be made against a
    // request that actually tried to set the session.
    const sent = received.at(-1)!;
    expect(received.length).toBeGreaterThan(before);
    expect(sent['x-honcho-workspace-id']).toBe('ws-42');
    expect(sent['mcp-session-id']).toBe('session-from-the-server');
  });

  it('still lets a server correct the defaults, which is why they come first', async () => {
    await listMcpTools({ url, headers: { Accept: 'application/json' } });

    expect(received[0].accept).toBe('application/json');
  });

  it('sends no such header at all when the endpoint declares none', async () => {
    await listMcpTools({ url });

    expect(received[0]['x-honcho-workspace-id']).toBeUndefined();
  });
});
