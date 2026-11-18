import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CLIProvider } from '../providers/cli-provider';
import { updateSharedJsonSync } from '../utils/shared-file';
import { runsBundle } from './mcp-roles';

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
 * The servers Tars, or Dorothy before it, shipped and no longer does, by name, and the directory their bundle shipped
 * in (`<resources>/<dir>/dist/bundle.js`): mcp-telegram since 2.0.5, Dorothy's world server before Tars.
 */
const RETIRED_MCP: Readonly<Record<string, string>> = { [TELEGRAM_MCP]: 'mcp-telegram', 'dorothy-world': 'mcp-world' };

/**
 * Takes each retired server out of every CLI it is registered in, at every start (2.0.7; an orchestrator's report of
 * 19/11: every session started with claude-mgr-telegram and dorothy-world failing, CONNECTION_CLOSED). Recognised by
 * its bundle's last parts, either separator, wherever the install that registered it lives (Tars moved, Dorothy, a dev
 * build; the Audit's L1 on #545); a server of the owner's named like it, running anything else, stays.
 *
 * Claude Code's user scope (`~/.claude.json`), which every claude session loads, is cleaned here, by the shared file
 * writer, with no claude CLI to run: 2.0.5 asked claude's provider whether the server was registered, and that answers
 * no for an entry of the user scope by design (one there is taken out by registering it again, which Tars no longer
 * does for these), so it never went. Every CLI's own config (claude's `--mcp-config` file, codex's, gemini's...) goes
 * through its provider, as before.
 */
export async function retireOldMcpServers(providers: CLIProvider[], home: string = os.homedir()): Promise<void> {
  // Imported here, not at the top: mcp-orchestrator reads this module's list.
  const { getMcpTelegramPath } = await import('./mcp-orchestrator');
  const userScope = path.join(home, '.claude.json');
  if (fs.existsSync(userScope)) {
    try {
      const outcome = updateSharedJsonSync<{ mcpServers?: Record<string, unknown> }>(userScope, (current) => {
        const servers = current?.mcpServers;
        if (!servers || typeof servers !== 'object') return undefined;
        const gone = Object.entries(RETIRED_MCP).filter(([name, dir]) => Object.prototype.hasOwnProperty.call(servers, name) && runsBundle(servers[name], dir));
        if (!gone.length) return undefined;
        const kept = { ...servers };
        for (const [name] of gone) delete kept[name];
        return { ...current, mcpServers: kept };
      });
      if (outcome === 'written') console.log('[mcp] servers Tars no longer ships taken out of Claude Code\'s user scope');
      else if (outcome === 'unreadable' || outcome === 'busy' || outcome === 'refused') console.warn(`[mcp] ~/.claude.json left as it is (${outcome}): the servers Tars no longer ships stay there`);
    } catch (err) {
      console.warn('[mcp] ~/.claude.json could not be cleaned of the servers Tars no longer ships:', err instanceof Error ? err.message : err);
    }
  }
  for (const [name, dir] of Object.entries(RETIRED_MCP)) {
    const paths = [...(name === TELEGRAM_MCP ? [getMcpTelegramPath()] : []), `${dir}/dist/bundle.js`, `${dir}\\dist\\bundle.js`];
    for (const provider of providers) {
      try {
        if (paths.some((p) => provider.isMcpServerRegistered(name, p))) await provider.removeMcpServer(name);
      } catch (err) {
        console.error(`[${provider.id}] could not take ${name} out:`, err instanceof Error ? err.message : err);
      }
    }
  }
}
