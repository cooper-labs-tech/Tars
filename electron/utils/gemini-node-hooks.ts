import * as path from 'path';
import { updateSharedJsoncSync, type SharedJsonOutcome } from './shared-file';
import { mergeNodeHooks, legacyShCommand, type HookTable } from './hook-command';

/**
 * GeminiProvider.configureHooks on win32: the Node runner, on Gemini's own
 * event names, and the agent token let through Gemini's environment redaction.
 * A file of its own so the provider keeps a one-call early return.
 *
 * - `BeforeAgent`, where the .sh wiring says `UserPromptSubmit`, which Gemini
 *   CLI does not fire (https://geminicli.com/docs/hooks/). The old entry is
 *   removed. The .sh wiring on darwin and linux does the same
 *   (GeminiProvider.configureHooks).
 * - The token. Gemini runs a hook with `sanitizeEnvironment(process.env)`
 *   (packages/core/src/hooks/hookRunner.ts). Redaction is off by default, but
 *   once a user turns on `security.environmentVariableRedaction.enabled`,
 *   every name matching /TOKEN/ is dropped unless listed in
 *   `security.environmentVariableRedaction.allowed`
 *   (packages/core/src/services/environmentSanitization.ts; the keys the CLI
 *   reads, google-gemini/gemini-cli#29007, the docs' flat
 *   `security.allowedEnvironmentVariables` does not exist). Without it every
 *   hook post is refused (403). A per-hook `env` cannot carry it: this file
 *   is shared by every agent and the token is per terminal. allowAgentToken,
 *   below, which the .sh wiring calls too: Gemini redacts on every platform.
 * - Written through updateSharedJsoncSync, as on macOS and Linux: read as
 *   gemini reads it, with its comments, which stay; a file gemini could not
 *   read either is left as it is rather than replaced by the hooks alone.
 *   Returns what became of it, for the provider to say (GeminiProvider).
 */
export function configureGeminiNodeHooks(configDir: string, hooksDir: string): SharedJsonOutcome {
  const settingsPath = path.join(configDir, 'settings.json');
  const specs = [
    { type: 'AfterTool', file: 'post-tool-use.sh', matcher: '*' },
    { type: 'AfterAgent', file: 'on-stop.sh', matcher: undefined },
    { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
    { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
    { type: 'Notification', file: 'notification.sh', matcher: '*' },
    { type: 'BeforeAgent', file: 'user-prompt-submit.sh', matcher: undefined, formerTypes: ['UserPromptSubmit'] },
  ].map(({ file, ...rest }) => ({
    ...rest, event: `gemini/${file.replace(/\.sh$/, '')}`, isLegacy: legacyShCommand(`gemini/${file}`, configDir, hooksDir),
  }));

  type Settings = { hooks?: HookTable; security?: Record<string, unknown>; [key: string]: unknown };
  const outcome = updateSharedJsoncSync<Settings>(settingsPath, current => {
    const settings: Settings = current ?? {};
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    let updated = mergeNodeHooks(settings.hooks, specs, hooksDir, 10000);
    if (allowAgentToken(settings)) updated = true;
    return updated ? settings : undefined;
  }, { createMode: 0o644 });

  if (outcome === 'written') console.log('Gemini hooks configured/updated in', settingsPath);
  else if (outcome === 'unchanged') console.log('Gemini hooks already configured');
  return outcome;
}

/**
 * The agent token let through Gemini's environment redaction (see above):
 * added to `security.environmentVariableRedaction.allowed`, the user's own
 * entries and `enabled` kept. On every platform: Gemini redacts on macOS and Linux
 * as on Windows. Returns whether it changed the settings.
 */
export function allowAgentToken(settings: { security?: Record<string, unknown>; [key: string]: unknown }): boolean {
  const TOKEN_VAR = 'CLAUDE_MGR_API_TOKEN';
  const security = (settings.security && typeof settings.security === 'object') ? settings.security : {};
  const redaction = (security.environmentVariableRedaction && typeof security.environmentVariableRedaction === 'object')
    ? security.environmentVariableRedaction as { allowed?: unknown; [key: string]: unknown }
    : {};
  const allowed = Array.isArray(redaction.allowed) ? redaction.allowed : [];
  if (allowed.includes(TOKEN_VAR)) return false;
  settings.security = { ...security, environmentVariableRedaction: { ...redaction, allowed: [...allowed, TOKEN_VAR] } };
  return true;
}
