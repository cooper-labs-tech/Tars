import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where a claude agent finds Tars's shared MCP servers (2.0.5, lot 3 item G, the second step): Tars writes each one
 * into the config file claude agents are started with (--mcp-config ~/.claude/mcp.json, and a worker's own role file,
 * mcp-worker.json, where there is one) as an HTTP server on the local API, /api/mcp/<server>, whose header names the
 * token by the variable claude expands from its own environment, `Bearer ${CLAUDE_MGR_API_TOKEN}` (measured on
 * 2.1.312, in an --mcp-config file). The CLIs that cannot do that keep their per-agent copies.
 *
 * How it fails, written before the code (28/10):
 * G1. A token is written into a file: the header holds the variable's name and nothing else.
 * G2. A server that is not shared (telegram, Tasmania) or one the owner added is changed or removed.
 * G3. A config Tars cannot parse is replaced, or the files are written again at every start when nothing changed.
 * G4. A role file keeps a per-agent copy of a shared server beside the shared one.
 * G5. A shared entry points at another Tars's port (a sandbox, an e2e run): it names this Tars's API.
 * And from the Audit's gate of #541:
 * G6. (M3) The entries go into ~/.claude.json, the user scope every claude session loads whatever its --mcp-config
 *     says: a worker gets x back (the owner's decision of 28/10 keeps telegram and x from workers), and the owner's
 *     own claude sessions warn of a missing variable. They go into the role files only, a worker's without the
 *     orchestrator-only servers, and Tars's own per-agent copies of the shared servers leave ~/.claude.json.
 * G7. (L1) A shared server that gives up after its start keeps its entries: every claude agent then gets 503 on it.
 *     Its entries go (dropSharedMcpEntries), only Tars's own.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

import { SHARED_MCP_SERVERS, ORCHESTRATOR_ONLY_MCP, sharedMcpEntry, writeSharedMcpEntries, dropSharedMcpEntries, ensureSharedMcp, stopSharedMcp } from '../../../electron/services/mcp-shared';

let dir: string;
let files: { claudeJson: string; mcpDir: string };
const API = 'http://127.0.0.1:31415';
const bundle = (name: string) => `/Applications/Tars.app/Contents/Resources/${name}/dist/bundle.js`;
const stdio = (name: string) => ({ type: 'stdio', command: '/Users/x/.tars/bin/tars-mcp-node', args: [bundle(name.replace('claude-mgr-', 'mcp-').replace('tars-', 'mcp-').replace('dorothy-', 'mcp-'))], env: {} });
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const role = (n: string) => path.join(files.mcpDir, n);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-register-'));
  files = { claudeJson: path.join(dir, '.claude.json'), mcpDir: path.join(dir, '.claude') };
  fs.mkdirSync(files.mcpDir);
  fs.writeFileSync(files.claudeJson, JSON.stringify({
    numStartups: 3,
    mcpServers: {
      ...Object.fromEntries(['claude-mgr-orchestrator', 'claude-mgr-kanban', 'dorothy-x', 'claude-mgr-telegram'].map(n => [n, stdio(n)])),
      mine: { type: 'stdio', command: 'my-server', args: [] },
      'claude-mgr-vault': { type: 'stdio', command: 'node', args: ['/my/own/vault.js'] },
      tasmania: { type: 'stdio', command: 'node', args: ['/t/index.js'] },
    },
  }, null, 2));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('the shared servers in claude\'s config', () => {
  it('G1, G5, G6. each shared server is an HTTP entry in mcp.json, on this Tars\'s API, its header naming the variable', () => {
    expect([...SHARED_MCP_SERVERS].sort()).toEqual(['claude-mgr-kanban', 'claude-mgr-orchestrator', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x', 'tars-memory']);
    vi.stubEnv('CLAUDE_MGR_API_TOKEN', 'a-real-token-0123456789');
    expect(writeSharedMcpEntries(API, files)).toBe('written');
    const servers = read(role('mcp.json')).mcpServers;
    for (const name of SHARED_MCP_SERVERS) {
      expect(servers[name], name).toEqual({ type: 'http', url: `${API}/api/mcp/${name}`, headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } });
      expect(sharedMcpEntry(API, name)).toEqual(servers[name]);
    }
    for (const f of [files.claudeJson, role('mcp.json')]) expect(fs.readFileSync(f, 'utf8')).not.toContain('a-real-token');
    expect(writeSharedMcpEntries('http://127.0.0.1:31498', files)).toBe('written');
    expect(read(role('mcp.json')).mcpServers['claude-mgr-kanban'].url).toBe('http://127.0.0.1:31498/api/mcp/claude-mgr-kanban');
  });

  it('G6. ~/.claude.json gets no shared entry, and loses Tars\'s own copies of the shared servers', () => {
    writeSharedMcpEntries(API, files);
    const user = read(files.claudeJson).mcpServers;
    for (const name of SHARED_MCP_SERVERS) expect(user[name]?.type, name).not.toBe('http');
    expect(user['claude-mgr-orchestrator']).toBeUndefined();
    expect(user['claude-mgr-kanban']).toBeUndefined();
    expect(user['dorothy-x']).toBeUndefined();
    // Not Tars's bundle: the owner's own server under the same name stays.
    expect(user['claude-mgr-vault']).toEqual({ type: 'stdio', command: 'node', args: ['/my/own/vault.js'] });
  });

  it('G6. a worker\'s role file gets the shared servers but the orchestrator-only ones', () => {
    expect([...ORCHESTRATOR_ONLY_MCP].sort()).toEqual(['claude-mgr-telegram', 'dorothy-x']);
    fs.writeFileSync(role('mcp-worker.json'), JSON.stringify({ mcpServers: { 'claude-mgr-orchestrator': stdio('claude-mgr-orchestrator') } }));
    writeSharedMcpEntries(API, files);
    const worker = read(role('mcp-worker.json')).mcpServers;
    expect(worker['dorothy-x']).toBeUndefined();
    expect(worker['claude-mgr-orchestrator']).toEqual(sharedMcpEntry(API, 'claude-mgr-orchestrator'));
    expect(read(role('mcp.json')).mcpServers['dorothy-x']).toEqual(sharedMcpEntry(API, 'dorothy-x'));
  });

  it('G2. telegram, Tasmania and the owner\'s own servers are left as they were, and the rest of the file too', () => {
    fs.writeFileSync(role('mcp.json'), JSON.stringify({ mcpServers: { 'claude-mgr-telegram': stdio('claude-mgr-telegram'), mine: { type: 'stdio', command: 'x', args: [] } } }));
    writeSharedMcpEntries(API, files);
    const after = read(files.claudeJson);
    expect(after.numStartups).toBe(3);
    expect(after.mcpServers['claude-mgr-telegram']).toEqual(stdio('claude-mgr-telegram'));
    expect(after.mcpServers.mine).toEqual({ type: 'stdio', command: 'my-server', args: [] });
    expect(after.mcpServers.tasmania).toEqual({ type: 'stdio', command: 'node', args: ['/t/index.js'] });
    const m = read(role('mcp.json')).mcpServers;
    expect(m['claude-mgr-telegram']).toEqual(stdio('claude-mgr-telegram'));
    expect(m.mine).toEqual({ type: 'stdio', command: 'x', args: [] });
  });

  it('G3. a config it cannot parse is left alone, and nothing is written when nothing changed', () => {
    writeSharedMcpEntries(API, files);
    const before = fs.statSync(role('mcp.json')).mtimeMs;
    expect(writeSharedMcpEntries(API, files)).toBe('unchanged');
    expect(fs.statSync(role('mcp.json')).mtimeMs).toBe(before);
    fs.writeFileSync(role('mcp.json'), '{ not json');
    expect(writeSharedMcpEntries(API, files)).toBe('unreadable');
    expect(fs.readFileSync(role('mcp.json'), 'utf8')).toBe('{ not json');
  });

  it('G4, G7. a shared server that gives up has its HTTP entries dropped from every role file, only Tars\'s own', () => {
    fs.writeFileSync(role('mcp-worker.json'), JSON.stringify({ mcpServers: {} }));
    writeSharedMcpEntries(API, files);
    const m = read(role('mcp.json'));
    m.mcpServers['someone-else'] = { type: 'http', url: 'https://example.com/mcp' };
    fs.writeFileSync(role('mcp.json'), JSON.stringify(m));
    dropSharedMcpEntries(['claude-mgr-kanban'], files);
    for (const f of ['mcp.json', 'mcp-worker.json']) {
      expect(read(role(f)).mcpServers['claude-mgr-kanban'], f).toBeUndefined();
      expect(read(role(f)).mcpServers['claude-mgr-orchestrator'], f).toEqual(sharedMcpEntry(API, 'claude-mgr-orchestrator'));
    }
    expect(read(role('mcp.json')).mcpServers['someone-else']).toEqual({ type: 'http', url: 'https://example.com/mcp' });
  });

  it('G7. a server that ends five times in a minute after its start is given up, and the registration is told', async () => {
    const script = path.join(dir, 'dies.cjs');
    fs.writeFileSync(script, "process.stdout.write('listening 1\\n'); setTimeout(() => process.exit(3), 50);\n");
    const gaveUp: string[] = [];
    try {
      const running = await ensureSharedMcp({ 'claude-mgr-kanban': script }, { apiUrl: API, instanceId: 'x' }, name => { gaveUp.push(name); });
      expect(running).toEqual(['claude-mgr-kanban']);
      await vi.waitFor(() => expect(gaveUp).toEqual(['claude-mgr-kanban']), { timeout: 25_000 });
    } finally {
      stopSharedMcp();
    }
  }, 30_000);
});

