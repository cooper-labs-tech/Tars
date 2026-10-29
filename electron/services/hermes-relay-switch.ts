import type { CLIProvider } from '../providers/cli-provider';

/**
 * Hermes is the only voice on the user's Telegram (JeanBrasse's decisions 2 of 2026-10-01, and traps 1 and 2 of
 * section 9 of DESIGN-RELAIS-HERMES-V2.md). Until 2.0.5 that held only while the relay was on; since Tars's own bot
 * went (services/telegram-retired.ts), it holds always:
 *
 * - mcp-telegram is never registered: it sent with the bot's token straight to Telegram, past the relay and its rules.
 * - Where a 2.0.4 registered it, every start takes it out of the CLI (mcp-orchestrator.ts). The one way left to write
 *   to the user is the orchestrator's send_telegram, which goes through the relay, or says how to turn it on.
 */

const TELEGRAM_MCP = 'claude-mgr-telegram';

/** The servers Tars bundles, in the order it registers them. */
export function bundledMcpServers(): string[] {
  return ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x'];
}

/**
 * Takes mcp-telegram out of every CLI it is registered in: by this install's path, or by its bundle's last parts
 * (`mcp-telegram/dist/bundle.js`, either separator), as another install registered it: Tars moved, Dorothy, a dev
 * build (the Audit's L1 on #545). A server of the owner's named like it, running anything else, stays.
 */
export async function retireTelegramMcp(providers: CLIProvider[]): Promise<void> {
  // Imported here, not at the top: mcp-orchestrator reads this module's list.
  const { getMcpTelegramPath } = await import('./mcp-orchestrator');
  const paths = [getMcpTelegramPath(), 'mcp-telegram/dist/bundle.js', 'mcp-telegram\\dist\\bundle.js'];
  for (const provider of providers) {
    try {
      if (paths.some((p) => provider.isMcpServerRegistered(TELEGRAM_MCP, p))) await provider.removeMcpServer(TELEGRAM_MCP);
    } catch (err) {
      console.error(`[${provider.id}] could not take mcp-telegram out:`, err instanceof Error ? err.message : err);
    }
  }
}
