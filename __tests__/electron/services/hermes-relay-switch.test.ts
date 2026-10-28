import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Turning the relay on (JeanBrasse's decisions 2 and 6 of 2026-10-01, DESIGN-RELAIS-HERMES-V2.md, traps 1 and 2 of its
 * section 9): Hermes becomes the only voice on the user's Telegram. Tars's own bot is not kept as a fallback, and
 * mcp-telegram, which sends with that bot's token straight to Telegram whatever Tars's switch says, leaves every CLI.
 *
 * How this can fail, written before the code:
 * 1. With the relay on, the Tars bot's token stays in the settings, or the bot stays on: two voices, and a fallback
 *    JeanBrasse refused.
 * 2. With the relay on, mcp-telegram stays registered in a CLI's MCP config: an agent could still write to Telegram
 *    with the bot's token, past the relay and its rules.
 * 3. The start of Tars registers mcp-telegram again while the relay is on.
 * 4. With the relay off, anything of this is done: the bot keeps its token, mcp-telegram stays.
 *    Replaced in 2.0.5 by 5 (the bot's removal, the DB brief remove-telegram-bot-2810.md, written before the code):
 * 5. With the relay off as on, mcp-telegram is registered in a CLI, or stays in one a 2.0.4 registered it in: it sends
 *    with a bot that no longer exists, past the relay.
 * Added with the Audit's Lows on #545, before the code:
 * 6. (L1) mcp-telegram registered by another install (Tars moved, Dorothy, a dev build, Tars on Windows) stays in a
 *    CLI, because only this install's exact path is recognised; or a server of the owner's named like it, running
 *    something else, is taken out.
 * 7. (L2) The start does not take it out with the relay off (setupMcpOrchestrator).
 *
 * The real switch functions and the real Gemini provider, whose MCP config is a file when its CLI is not installed
 * (~/.gemini/settings.json), under a throwaway HOME.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => path.join(os.homedir(), 'app'), isPackaged: false, getVersion: () => '1.9.2' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

const geminiSettings = () => path.join(os.homedir(), '.gemini', 'settings.json');
// Where a packaged Tars keeps its bundled MCP servers, as Electron sets it.
(process as { resourcesPath?: string }).resourcesPath = path.join(os.homedir(), 'Tars.app', 'Contents', 'Resources');
type Switch = typeof import('../../../electron/services/hermes-relay-switch');
let sw: Switch;

beforeEach(async () => {
  fs.rmSync(path.join(os.homedir(), '.gemini'), { recursive: true, force: true });
  vi.resetModules();
  sw = await import('../../../electron/services/hermes-relay-switch');
});

async function geminiWithTelegram() {
  const { getMcpTelegramPath } = await import('../../../electron/services/mcp-orchestrator');
  fs.mkdirSync(path.dirname(geminiSettings()), { recursive: true });
  fs.writeFileSync(geminiSettings(), JSON.stringify({ mcpServers: {
    'claude-mgr-telegram': { command: 'node', args: [getMcpTelegramPath()] },
    'claude-mgr-orchestrator': { command: 'node', args: ['/x/mcp-orchestrator/dist/bundle.js'] },
  } }));
  const { getProvider } = await import('../../../electron/providers');
  return getProvider('gemini');
}

describe('the relay turned on', () => {
  it('2. takes mcp-telegram out of every CLI, and leaves Tars\'s other servers', async () => {
    const gemini = await geminiWithTelegram();

    await sw.retireTelegramMcp([gemini]);

    const servers = JSON.parse(fs.readFileSync(geminiSettings(), 'utf-8')).mcpServers;
    expect(Object.keys(servers)).toEqual(['claude-mgr-orchestrator']);
  });

  it('3. the start does not register mcp-telegram again', () => {
    expect(sw.bundledMcpServers()).not.toContain('claude-mgr-telegram');
    expect(sw.bundledMcpServers()).toContain('claude-mgr-orchestrator');
  });
});

describe('the relay off (2.0.5: no bot)', () => {
  it('5. never registers mcp-telegram, and takes it out of a CLI a 2.0.4 registered it in', async () => {
    expect(sw.bundledMcpServers()).not.toContain('claude-mgr-telegram');
    expect(sw.bundledMcpServers()).not.toContain('claude-mgr-telegram');
    expect(sw.bundledMcpServers()).toContain('claude-mgr-orchestrator');
    const gemini = await geminiWithTelegram();
    await sw.retireTelegramMcp([gemini]);
    expect(Object.keys(JSON.parse(fs.readFileSync(geminiSettings(), 'utf-8')).mcpServers)).toEqual(['claude-mgr-orchestrator']);
  });
});

describe('another install\'s mcp-telegram (the Audit\'s L1 and L2 on #545)', () => {
  const withGeminiServer = async (command: string, args: string[]) => {
    fs.mkdirSync(path.dirname(geminiSettings()), { recursive: true });
    fs.writeFileSync(geminiSettings(), JSON.stringify({ mcpServers: {
      'claude-mgr-telegram': { command, args },
      'claude-mgr-orchestrator': { command: 'node', args: ['/x/mcp-orchestrator/dist/bundle.js'] },
    } }));
    const { getProvider } = await import('../../../electron/providers');
    return getProvider('gemini');
  };
  const servers = () => Object.keys(JSON.parse(fs.readFileSync(geminiSettings(), 'utf-8')).mcpServers);

  it('6. is recognised by its bundle\'s last parts, wherever that install lives, and the owner\'s own server is not', async () => {
    for (const bundle of [
      '/Applications/Dorothy.app/Contents/Resources/mcp-telegram/dist/bundle.js',
      '/Users/someone/dev/tars/mcp-telegram/dist/bundle.js',
      'C:\\Users\\someone\\AppData\\Local\\Programs\\Tars\\resources\\mcp-telegram\\dist\\bundle.js',
    ]) {
      const gemini = await withGeminiServer('/opt/tars-mcp-node', [bundle]);
      await sw.retireTelegramMcp([gemini]);
      expect(servers(), bundle).toEqual(['claude-mgr-orchestrator']);
    }
    const gemini = await withGeminiServer('node', ['/Users/someone/my-telegram/server.js']);
    await sw.retireTelegramMcp([gemini]);
    expect(servers()).toEqual(['claude-mgr-telegram', 'claude-mgr-orchestrator']);
  });

  it('6. a CLI whose config is read as text (codex) recognises it the same way', async () => {
    const { getProvider } = await import('../../../electron/providers');
    const codex = getProvider('codex');
    const toml = path.join(codex.configDir as string, 'config.toml');
    fs.mkdirSync(path.dirname(toml), { recursive: true });
    fs.writeFileSync(toml, '[mcp_servers.claude-mgr-telegram]\ncommand = "/opt/tars-mcp-node"\nargs = ["/Applications/Dorothy.app/Contents/Resources/mcp-telegram/dist/bundle.js"]\n');
    expect(codex.isMcpServerRegistered('claude-mgr-telegram', 'mcp-telegram/dist/bundle.js')).toBe(true);
    fs.writeFileSync(toml, '[mcp_servers.claude-mgr-telegram]\ncommand = "node"\nargs = ["/Users/someone/my-telegram/server.js"]\n');
    expect(codex.isMcpServerRegistered('claude-mgr-telegram', 'mcp-telegram/dist/bundle.js')).toBe(false);
    fs.rmSync(toml);
  });

  it('7. every start takes it out, the relay off', async () => {
    await withGeminiServer('/opt/tars-mcp-node', ['/Applications/Dorothy.app/Contents/Resources/mcp-telegram/dist/bundle.js']);
    const { setupMcpOrchestrator } = await import('../../../electron/services/mcp-orchestrator');
    await setupMcpOrchestrator({ hermesRelayEnabled: false } as never);
    expect(servers()).toEqual(['claude-mgr-orchestrator']);
  });
});
