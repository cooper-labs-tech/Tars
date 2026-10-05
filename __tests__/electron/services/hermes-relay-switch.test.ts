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
 *
 * The real switch functions and the real Gemini provider, whose MCP config is a file when its CLI is not installed
 * (~/.gemini/settings.json), under a throwaway HOME.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => path.join(os.homedir(), 'app'), isPackaged: false, getVersion: () => '1.9.2' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

import type { AppSettings } from '../../../electron/types';

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
  it('1. erases the Tars bot\'s token and turns the bot off', () => {
    const settings = { hermesRelayEnabled: true, telegramEnabled: true, telegramBotToken: '123:abc', telegramChatId: '42' } as AppSettings;

    const after = sw.settingsForRelay(settings);

    expect(after).toMatchObject({ hermesRelayEnabled: true, telegramEnabled: false, telegramBotToken: '' });
  });

  it('2. takes mcp-telegram out of every CLI, and leaves Tars\'s other servers', async () => {
    const gemini = await geminiWithTelegram();

    await sw.retireTelegramMcp([gemini]);

    const servers = JSON.parse(fs.readFileSync(geminiSettings(), 'utf-8')).mcpServers;
    expect(Object.keys(servers)).toEqual(['claude-mgr-orchestrator']);
  });

  it('3. the start does not register mcp-telegram again', () => {
    expect(sw.bundledMcpServersFor({ hermesRelayEnabled: true } as AppSettings)).not.toContain('claude-mgr-telegram');
    expect(sw.bundledMcpServersFor({ hermesRelayEnabled: true } as AppSettings)).toContain('claude-mgr-orchestrator');
  });
});

describe('the relay off', () => {
  it('4. changes nothing: the bot keeps its token, and mcp-telegram is registered as before', () => {
    const settings = { hermesRelayEnabled: false, telegramEnabled: true, telegramBotToken: '123:abc' } as AppSettings;

    expect(sw.settingsForRelay(settings)).toEqual(settings);
    expect(sw.bundledMcpServersFor(settings)).toContain('claude-mgr-telegram');
  });
});
