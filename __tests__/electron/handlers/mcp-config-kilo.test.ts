import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Settings > MCP's handlers (mcp:list, mcp:update, mcp:delete) for Kilo, whose servers live in `kilo.json` of its own
 * config folder (`$XDG_CONFIG_HOME/kilo`), in opencode's schema: `mcp.<name>` is `{type: 'local', command: [program,
 * ...args], environment, enabled}` (kilo-provider.ts, measured on 7.8.27).
 *
 * Who reaches them: only the window's IPC (preload.ts `mcp.*`); no route and no MCP tool calls them. The window's
 * Settings > MCP passes 'claude' alone today, so the provider names any other caller of the IPC would pass.
 *
 * How it fails, written before the code (the #614 Audit's Info 7, found by the Frontend, 20/11):
 * 1. mcp:list for kilo answers nothing (no case), and mcp:update or mcp:delete throws "Unknown provider".
 * 2. A server written somewhere Kilo never reads (opencode's folder, `mcpServers`), or Kilo's file rewritten so that
 *    the user's other servers, or Tars's, are lost.
 * 3. Tars's own servers listed as the user's, to be edited or deleted from the window.
 */

type Handler = (event: unknown, params: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; servers?: unknown[] }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } } }));

import { registerMcpConfigHandlers } from '../../../electron/handlers/mcp-config-handlers';

let root: string;
const kiloJson = () => path.join(root, 'config', 'kilo', 'kilo.json');

beforeAll(() => registerMcpConfigHandlers());
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-mcp-kilo-')));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
  fs.mkdirSync(path.dirname(kiloJson()), { recursive: true });
  fs.writeFileSync(kiloJson(), JSON.stringify({
    $schema: 'https://kilo.ai/config.json',
    model: 'kilo/auto',
    mcp: {
      'my-db': { type: 'local', command: ['node', '/srv/db.js', '--ro'], environment: { DB_URL: 'postgres://x' }, enabled: true },
      'claude-mgr-orchestrator': { type: 'local', command: ['/opt/node', '/res/mcp-orchestrator/dist/bundle.js'], enabled: true },
    },
  }, null, 2));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const read = () => JSON.parse(fs.readFileSync(kiloJson(), 'utf8'));

describe('Settings > MCP for Kilo', () => {
  it("1, 3: lists the user's own servers from kilo.json, never Tars's", async () => {
    const listed = await handlers.get('mcp:list')!({}, { provider: 'kilo' });
    expect(listed.error).toBeUndefined();
    expect(listed.servers).toEqual([{ name: 'my-db', command: 'node', args: ['/srv/db.js', '--ro'], env: { DB_URL: 'postgres://x' } }]);
  });

  it("1, 2: adds and deletes a server in kilo.json, in Kilo's schema, and leaves the rest as it was", async () => {
    const saved = await handlers.get('mcp:update')!({}, { provider: 'kilo', name: 'docs', command: 'node', args: ['docs.js'], env: { TOKEN_FILE: '/x' } });
    expect(saved).toEqual({ success: true });
    const after = read();
    expect(after.mcp.docs).toEqual({ type: 'local', command: ['node', 'docs.js'], environment: { TOKEN_FILE: '/x' }, enabled: true });
    expect(after.mcp['my-db']).toBeDefined();
    expect(after.mcp['claude-mgr-orchestrator']).toBeDefined();
    expect(after.model).toBe('kilo/auto');
    expect(after.mcpServers).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'config', 'opencode'))).toBe(false);

    const deleted = await handlers.get('mcp:delete')!({}, { provider: 'kilo', name: 'docs' });
    expect(deleted).toEqual({ success: true });
    expect(read().mcp.docs).toBeUndefined();
    expect(read().mcp['my-db']).toBeDefined();
  });
});
