import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Settings > MCP and Qwen Code (the Audit's L3 on #461). The handler wrote a
 * server added for Qwen Code into ~/.qwen-code/mcp.json, a file qwen never
 * reads (it reads ~/.qwen/settings.json, and Tars's agents a settings file of
 * Tars's, services/qwen-code.ts). No page asks for it (McpSection manages
 * claude's), so the entry goes, and saying so replaces a silent success.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  M1. A server added for Qwen Code (`qwencode`, or `qwen-code`, its provider's
 *      id) is written to ~/.qwen-code/mcp.json and reported saved, where no
 *      qwen will ever start it.
 *  M2. It is reported saved anywhere else either, or a delete reports success,
 *      or a list reads that file as qwen's.
 *  M3. The other CLIs lose their entries (claude still writes ~/.claude/mcp.json).
 */

type Handler = (event: unknown, params: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; servers?: unknown[] }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } } }));

import { registerMcpConfigHandlers } from '../../../electron/handlers/mcp-config-handlers';

const server = { name: 'docs', command: 'node', args: ['docs.js'], env: {} };
const qwenCodeDir = () => path.join(os.homedir(), '.qwen-code');

beforeAll(() => registerMcpConfigHandlers());
beforeEach(() => {
  fs.rmSync(qwenCodeDir(), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.claude', 'mcp.json'), { force: true });
});

describe('Settings > MCP for Qwen Code', () => {
  it.each(['qwencode', 'qwen-code'])('M1, M2. %s: nothing written, nothing said to be saved', async (provider) => {
    const saved = await handlers.get('mcp:update')!({}, { provider, ...server });
    expect(saved.success).toBe(false);
    expect(saved.error).toMatch(/Qwen Code/);
    expect(fs.existsSync(qwenCodeDir())).toBe(false);
    expect((await handlers.get('mcp:delete')!({}, { provider, name: 'docs' })).success).toBe(false);
    const listed = await handlers.get('mcp:list')!({}, { provider });
    expect(listed.servers).toEqual([]);
    expect(listed.error).toMatch(/Qwen Code/);
  });

  it('M3. claude keeps its entry', async () => {
    expect((await handlers.get('mcp:update')!({}, { provider: 'claude', ...server })).success).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'mcp.json'), 'utf8')).mcpServers.docs).toMatchObject({ command: 'node' });
  });
});
