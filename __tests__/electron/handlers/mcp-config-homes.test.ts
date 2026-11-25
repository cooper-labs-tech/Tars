import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Settings > MCP and the homes codex, gemini and grok read (the Audit's L2 on #645 at 85bc5c575): the page listed and
 * wrote ~/.codex/config.toml, ~/.gemini/settings.json and ~/.grok/config.toml whatever CODEX_HOME, GEMINI_CLI_HOME or
 * GROK_HOME names, so a server added there never reached an agent, and Tars's own were not listed.
 *
 * Every way it can fail, written before the code (25/11):
 *  H1. A server added for gemini lands in ~/.gemini/settings.json while GEMINI_CLI_HOME names another home.
 *  H2. A server added for grok lands in ~/.grok/config.toml while GROK_HOME names another.
 *  H3. A server added for codex lands in ~/.codex/config.toml while CODEX_HOME names another.
 *  H4. The list reads the plain file, not the one the CLI reads.
 */

type Handler = (event: unknown, params: Record<string, unknown>) => Promise<{ success?: boolean; error?: string; servers?: Array<{ name: string }> }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } } }));

import { registerMcpConfigHandlers } from '../../../electron/handlers/mcp-config-handlers';

const server = { name: 'docs', command: 'node', args: ['docs.js'], env: {} };
const saved = { ...process.env };
let root: string;

beforeEach(() => {
  handlers.clear();
  registerMcpConfigHandlers();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-homes-')));
  process.env.GEMINI_CLI_HOME = path.join(root, 'gemini-home');
  process.env.GROK_HOME = path.join(root, 'grok-home');
  process.env.CODEX_HOME = path.join(root, 'codex-home');
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Settings > MCP writes and lists the file each CLI reads", () => {
  it.each([
    ['gemini', () => path.join(root, 'gemini-home', '.gemini', 'settings.json'), () => path.join(os.homedir(), '.gemini', 'settings.json')],
    ['grok', () => path.join(root, 'grok-home', 'config.toml'), () => path.join(os.homedir(), '.grok', 'config.toml')],
    ['codex', () => path.join(root, 'codex-home', 'config.toml'), () => path.join(os.homedir(), '.codex', 'config.toml')],
  ])('H1 to H4. %s: the server goes into the home its variable names, and is listed from there', async (provider, file, plain) => {
    const before = fs.existsSync(plain()) ? fs.readFileSync(plain(), 'utf8') : null;
    expect((await handlers.get('mcp:update')!({}, { provider, ...server })).success).toBe(true);
    expect(fs.existsSync(file())).toBe(true);
    expect(fs.readFileSync(file(), 'utf8')).toContain('docs');
    expect(fs.existsSync(plain()) ? fs.readFileSync(plain(), 'utf8') : null).toBe(before);
    const listed = await handlers.get('mcp:list')!({}, { provider });
    expect((listed.servers ?? []).map((s) => s.name)).toContain('docs');
  });
});
