import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where a claude agent finds Tars's shared MCP servers (2.0.5, lot 3 item G, the second step): Tars writes each one
 * into Claude Code's own config as an HTTP server on the local API, /api/mcp/<server>, whose header names the token
 * by the variable claude expands from its own environment, `Bearer ${CLAUDE_MGR_API_TOKEN}` (measured on 2.1.312).
 * The CLIs that cannot do that keep their per-agent copies, registered as before.
 *
 * How it fails, written before the code (28/10):
 * G1. A token is written into the file: ~/.claude.json is in every agent's reach, and so is ~/.claude/mcp.json. The
 *     header holds the variable's name and nothing else.
 * G2. A server that is not shared (telegram, Tasmania) or one the owner added is changed or removed.
 * G3. A config Tars cannot parse is replaced, or the files are written again at every start when nothing changed.
 * G4. ~/.claude/mcp.json, which every claude agent is started with (--mcp-config), keeps a per-agent copy of a shared
 *     server beside the shared one, or is created when there was none.
 * G5. A shared entry points at another Tars's port (a sandbox, an e2e run): it names this Tars's API.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

import { SHARED_MCP_SERVERS, sharedMcpEntry, writeSharedMcpEntries } from '../../../electron/services/mcp-shared';

let dir: string;
let claudeJson: string;
let mcpJson: string;
const API = 'http://127.0.0.1:31415';
const stdio = (name: string) => ({ type: 'stdio', command: '/Users/x/.tars/bin/tars-mcp-node', args: [`/Applications/Tars.app/Contents/Resources/${name}/dist/bundle.js`], env: {} });
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-register-'));
  claudeJson = path.join(dir, '.claude.json');
  mcpJson = path.join(dir, 'mcp.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    numStartups: 3,
    mcpServers: {
      ...Object.fromEntries(['claude-mgr-orchestrator', 'claude-mgr-kanban', 'claude-mgr-telegram'].map(n => [n, stdio(n)])),
      mine: { type: 'stdio', command: 'my-server', args: [] },
      tasmania: { type: 'stdio', command: 'node', args: ['/t/index.js'] },
    },
  }, null, 2));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the shared servers in claude\'s config', () => {
  it('G1, G5. each shared server is an HTTP entry on this Tars\'s API, its header naming the variable, never a token', () => {
    expect([...SHARED_MCP_SERVERS].sort()).toEqual(['claude-mgr-kanban', 'claude-mgr-orchestrator', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x', 'tars-memory']);
    vi.stubEnv('CLAUDE_MGR_API_TOKEN', 'a-real-token-0123456789');
    expect(writeSharedMcpEntries(API, { claudeJson, mcpJson })).toBe('written');
    vi.unstubAllEnvs();
    const servers = read(claudeJson).mcpServers;
    for (const name of SHARED_MCP_SERVERS) {
      expect(servers[name], name).toEqual({ type: 'http', url: `${API}/api/mcp/${name}`, headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } });
      expect(sharedMcpEntry(API, name)).toEqual(servers[name]);
    }
    expect(fs.readFileSync(claudeJson, 'utf8')).not.toContain('a-real-token');
    expect(writeSharedMcpEntries('http://127.0.0.1:31498', { claudeJson, mcpJson })).toBe('written');
    expect(read(claudeJson).mcpServers['claude-mgr-kanban'].url).toBe('http://127.0.0.1:31498/api/mcp/claude-mgr-kanban');
  });

  it('G2. telegram, Tasmania and the owner\'s own servers are left as they were, and the rest of the file too', () => {
    writeSharedMcpEntries(API, { claudeJson, mcpJson });
    const after = read(claudeJson);
    expect(after.numStartups).toBe(3);
    expect(after.mcpServers['claude-mgr-telegram']).toEqual(stdio('claude-mgr-telegram'));
    expect(after.mcpServers.mine).toEqual({ type: 'stdio', command: 'my-server', args: [] });
    expect(after.mcpServers.tasmania).toEqual({ type: 'stdio', command: 'node', args: ['/t/index.js'] });
  });

  it('G3. a config it cannot parse is left alone, and nothing is written when nothing changed', () => {
    writeSharedMcpEntries(API, { claudeJson, mcpJson });
    const before = fs.statSync(claudeJson).mtimeMs;
    expect(writeSharedMcpEntries(API, { claudeJson, mcpJson })).toBe('unchanged');
    expect(fs.statSync(claudeJson).mtimeMs).toBe(before);
    fs.writeFileSync(claudeJson, '{ not json');
    expect(writeSharedMcpEntries(API, { claudeJson, mcpJson })).toBe('unreadable');
    expect(fs.readFileSync(claudeJson, 'utf8')).toBe('{ not json');
  });

  it('G4. mcp.json, when there is one, takes the shared entries in place of its copies; none is made when there was none', () => {
    writeSharedMcpEntries(API, { claudeJson, mcpJson });
    expect(fs.existsSync(mcpJson)).toBe(false);
    fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { 'claude-mgr-orchestrator': stdio('claude-mgr-orchestrator'), 'claude-mgr-telegram': stdio('claude-mgr-telegram') } }));
    writeSharedMcpEntries(API, { claudeJson, mcpJson });
    const m = read(mcpJson).mcpServers;
    expect(m['claude-mgr-orchestrator']).toEqual(sharedMcpEntry(API, 'claude-mgr-orchestrator'));
    expect(m['claude-mgr-telegram']).toEqual(stdio('claude-mgr-telegram'));
    expect(Object.keys(m).sort()).toEqual(['claude-mgr-orchestrator', 'claude-mgr-telegram']);
  });
});
