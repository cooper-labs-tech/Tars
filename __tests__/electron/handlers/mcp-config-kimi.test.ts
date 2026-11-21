import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Settings > MCP's handlers (mcp:list, mcp:update, mcp:delete) for Kimi Code, whose servers live in `mcp.json` of its
 * home, `$KIMI_CODE_HOME` else `~/.kimi-code`, under `mcpServers` (kimi-code-provider.ts, measured on 2.6.3).
 *
 * Who reaches them: only the window's IPC (preload.ts `mcp.*`); no route and no MCP tool calls them. The window's
 * Settings > MCP passes 'claude' alone today, so the provider names any other caller of the IPC would pass.
 *
 * How it fails, written before the code (the #614 Audit's Info 7, found by the Frontend, 20/11):
 * 1. mcp:list for kimi-code answers nothing (no case), and mcp:update or mcp:delete throws "Unknown provider".
 * 2. A server written somewhere kimi never reads (`~/.kimi-code` while KIMI_CODE_HOME says otherwise), or its file
 *    rewritten so that the user's other servers, or Tars's, are lost.
 * 3. Tars's own servers listed as the user's, to be edited or deleted from the window.
 */

type Handler = (event: unknown, params: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; servers?: unknown[] }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } } }));

import { registerMcpConfigHandlers } from '../../../electron/handlers/mcp-config-handlers';

let root: string;
const kimiHome = () => path.join(root, 'kimi-home');
const mcpJson = () => path.join(kimiHome(), 'mcp.json');

beforeAll(() => registerMcpConfigHandlers());
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-mcp-kimi-')));
  vi.stubEnv('KIMI_CODE_HOME', kimiHome());
  fs.mkdirSync(kimiHome(), { recursive: true });
  fs.writeFileSync(mcpJson(), JSON.stringify({
    mcpServers: {
      'my-db': { command: 'node', args: ['/srv/db.js'], env: { DB_URL: 'postgres://x' } },
      'claude-mgr-orchestrator': { command: '/opt/node', args: ['/res/mcp-orchestrator/dist/bundle.js'] },
    },
  }, null, 2));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = () => JSON.parse(fs.readFileSync(mcpJson(), 'utf8'));

describe('Settings > MCP for Kimi Code', () => {
  it("1, 3: lists the user's own servers from kimi's mcp.json, never Tars's", async () => {
    const listed = await handlers.get('mcp:list')!({}, { provider: 'kimi-code' });
    expect(listed.error).toBeUndefined();
    expect(listed.servers).toEqual([{ name: 'my-db', command: 'node', args: ['/srv/db.js'], env: { DB_URL: 'postgres://x' } }]);
  });

  it("1, 2: adds and deletes a server in the mcp.json of KIMI_CODE_HOME, and leaves the rest as it was", async () => {
    expect(await handlers.get('mcp:update')!({}, { provider: 'kimi-code', name: 'docs', command: 'node', args: ['docs.js'], env: {} })).toEqual({ success: true });
    expect(read().mcpServers.docs).toEqual({ command: 'node', args: ['docs.js'] });
    expect(read().mcpServers['my-db']).toBeDefined();
    expect(read().mcpServers['claude-mgr-orchestrator']).toBeDefined();
    expect(fs.existsSync(path.join(os.homedir(), '.kimi-code', 'mcp.json'))).toBe(false);
    expect(await handlers.get('mcp:delete')!({}, { provider: 'kimi-code', name: 'docs' })).toEqual({ success: true });
    expect(read().mcpServers.docs).toBeUndefined();
    expect(read().mcpServers['my-db']).toBeDefined();
  });
});
