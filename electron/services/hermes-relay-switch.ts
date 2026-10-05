import type { AppSettings } from '../types';
import type { CLIProvider } from '../providers/cli-provider';

/**
 * What turning the relay on changes besides the relay (JeanBrasse's decision 2 of 2026-10-01, and traps 1 and 2 of section 9
 * of DESIGN-RELAIS-HERMES-V2.md): Hermes becomes the only voice on the user's Telegram.
 *
 * - Tars's own bot is not kept as a fallback: its token is erased from the settings and the bot is off.
 * - mcp-telegram leaves every CLI: it sends with that token straight to Telegram, whatever Tars's switches say, so an
 *   agent could write to the user past the relay and its rules. Its tools are gone with it; the one way left to write
 *   to the user is the orchestrator's send_telegram, which goes through the relay.
 * - With the relay off, nothing of this happens.
 */

const TELEGRAM_MCP = 'claude-mgr-telegram';

/** The servers Tars bundles, in the order it registers them, as these settings want them. */
export function bundledMcpServersFor(settings: Partial<AppSettings> | undefined): string[] {
  const all = ['claude-mgr-orchestrator', 'tars-memory', TELEGRAM_MCP, 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x'];
  return settings?.hermesRelayEnabled === true ? all.filter(name => name !== TELEGRAM_MCP) : all;
}

/** The settings once the relay is on: the bot off, its token gone. Unchanged with the relay off. */
export function settingsForRelay(settings: AppSettings): AppSettings {
  if (settings.hermesRelayEnabled !== true) return settings;
  if (!settings.telegramEnabled && !settings.telegramBotToken) return settings;
  return { ...settings, telegramEnabled: false, telegramBotToken: '' };
}

/** Takes mcp-telegram out of every CLI it is registered in. */
export async function retireTelegramMcp(providers: CLIProvider[]): Promise<void> {
  // Imported here, not at the top: mcp-orchestrator reads this module's list.
  const { getMcpTelegramPath } = await import('./mcp-orchestrator');
  const telegramPath = getMcpTelegramPath();
  for (const provider of providers) {
    try {
      if (provider.isMcpServerRegistered(TELEGRAM_MCP, telegramPath)) await provider.removeMcpServer(TELEGRAM_MCP);
    } catch (err) {
      console.error(`[${provider.id}] could not take mcp-telegram out:`, err instanceof Error ? err.message : err);
    }
  }
}
