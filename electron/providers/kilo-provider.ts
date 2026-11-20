import * as os from 'os';
import * as path from 'path';
import type { ProviderModel } from './cli-provider';
import { OpencodeBuildProvider } from './opencode-provider';

/**
 * Kilo CLI, the binary `kilo` (Kilo-Org/kilocode), a build of opencode. Measured on 7.8.27 (20/11/2026) in throwaway
 * homes, with what it shares with opencode in OpencodeBuildProvider:
 * - opencode's flags (`--model`, `--auto`, `--session`, `--fork`, `--prompt`, its --help) and its TUI: it draws
 *   opencode's bottom bar, and took a key written the moment that bar appeared, 64 to 106 ms later, three fresh starts
 *   out of three, whether its terminal answered its queries or not;
 * - its sessions in opencode's schema, in its own database, `$XDG_DATA_HOME/kilo/kilo.db` (services/opencode-sessions.ts);
 * - its own config, never opencode's: an inline config only in KILO_CONFIG_CONTENT (given OPENCODE_CONFIG_CONTENT, it
 *   ran on its own Kilo Gateway, services/endpoint-harness.ts), and its MCP servers from `$XDG_CONFIG_HOME/kilo`
 *   (`kilo mcp list` read kilo.json, kilo.jsonc, opencode.json and config.json there, and nothing in opencode's folder).
 * How it takes a note typed mid-turn is not measured, so it says nothing of it (noteDuringTurn).
 */
export class KiloProvider extends OpencodeBuildProvider {
  readonly id = 'kilo' as const;
  readonly displayName = 'Kilo';
  readonly binaryName = 'kilo';
  readonly configDir = path.join(os.homedir(), '.config', 'kilo');
  protected readonly config = { folder: 'kilo', mcpFile: 'kilo.json' };
  /** Measured on 7.8.27 (20/11): it switches a server of kilo.json off for the run, and ignores one it does not define. */
  protected readonly roleSwitchVar = 'KILO_CONFIG_CONTENT';

  /** Its own default (the Kilo Gateway's, without a provider of the user's), or a `provider/model` the user names. */
  getModels(): ProviderModel[] {
    return [{ id: 'default', name: 'Default', description: 'Use configured default' }];
  }
}
