import type { CliKeyId } from '@/types/electron';

/**
 * The command-line agents Tars runs, one list for every page that names them:
 * Settings > Providers, Settings > CLI Paths and New agent (2.0.4, the
 * maintainer's request of 18/10). Pages kept their own lists, and they drifted:
 * Grok was in CLI Paths and not in Providers, and Qwen Code was listed under
 * `qwen-code` where its command is `qwen`.
 */
export interface CliDef {
  id: string;
  name: string;
  /** The command a terminal runs. */
  command: string;
  /** Tars's provider for it (src/lib/providers.ts), null until Tars drives it. */
  provider: string | null;
  /** Its key in Settings (the cliKeys of PR 459), null for Claude Code, which signs in with its account. */
  keyId: CliKeyId | null;
  /** Its field in Settings > CLI Paths, null when it has none yet. */
  pathKey: string | null;
  /** Listed so the user knows it is planned; Tars does not drive it yet. */
  soon?: true;
}

export const CLIS: readonly CliDef[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', provider: 'claude', keyId: null, pathKey: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex', provider: 'codex', keyId: 'codex', pathKey: 'codex' },
  { id: 'qwen-code', name: 'Qwen Code', command: 'qwen', provider: 'qwen-code', keyId: 'qwen-code', pathKey: 'qwencode' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', provider: 'gemini', keyId: 'gemini', pathKey: 'gemini' },
  { id: 'grok', name: 'Grok CLI', command: 'grok', provider: 'grok', keyId: 'grok', pathKey: 'grok' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', provider: 'opencode', keyId: 'opencode', pathKey: 'opencode' },
  { id: 'pi', name: 'Pi', command: 'pi', provider: 'pi', keyId: 'pi', pathKey: 'pi' },
  { id: 'amp', name: 'Amp', command: 'amp', provider: 'amp', keyId: 'amp', pathKey: 'amp' },
  // 2.0.7 (#620): Cline, driven by Tars, one name everywhere (main's displayName); its key is set here like any CLI's.
  { id: 'cline', name: 'Cline', command: 'cline', provider: 'cline', keyId: 'cline', pathKey: 'cline' },
  { id: 'omp', name: 'oh-my-pi', command: 'omp', provider: null, keyId: 'omp', pathKey: null, soon: true },
  { id: 'kilo', name: 'Kilo CLI', command: 'kilo', provider: null, keyId: 'kilo', pathKey: null, soon: true },
];

export function cliById(id: string): CliDef | undefined {
  return CLIS.find((c) => c.id === id);
}

export function cliForProvider(provider: string): CliDef | undefined {
  return CLIS.find((c) => c.provider === provider);
}
