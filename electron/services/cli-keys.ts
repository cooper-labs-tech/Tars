import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppSettings, CliApiKey, CliKeyId, CliKeyState } from '../types';

/**
 * An API key per CLI (2.0.4): kept in ~/.tars/app-settings.json only, and
 * handed to that CLI's agents only, through their terminal's environment (the
 * provider's getPtyEnvVars, which every launch and an ACP run read), under the
 * variable that CLI reads. Never in an argument, where ps shows it; never in
 * the CLI's own files; never back to the window, which only learns whether a
 * key is set and under which variable it goes.
 */

interface CliKeySpec {
  id: CliKeyId;
  label: string;
  /** Tars's provider for this CLI, or null while there is none yet. */
  provider: string | null;
  /** The variable its agents get the key under, when the CLI reads one variable; null: the user names it. */
  envVar: string | null;
  /** The variable is the CLI's own and cannot be changed (codex: Tars's provider names it). */
  fixed?: boolean;
  /** Variables to offer when the user names one. */
  choices: string[];
  /** How its key was measured, or where the variable comes from. */
  measured: string;
  /** What the CLI does with no key from Tars. */
  withoutKey: string;
}

const PROVIDER_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY'];

export const CLI_KEYS: readonly CliKeySpec[] = [
  {
    id: 'codex', label: 'Codex', provider: 'codex', envVar: 'CODEX_API_KEY', fixed: true, choices: [],
    measured: 'codex-cli 0.163 (18/10): codex exec reads CODEX_API_KEY and never OPENAI_API_KEY; its interactive session reads no key from its environment and shows its sign-in screen, unless its model provider names the variable. With a key, Tars starts it with a provider of its own whose env_key is CODEX_API_KEY (`-c model_provider=tars-key`, the name only), and that key wins over the ChatGPT login. Nothing is written into ~/.codex.',
    withoutKey: 'Its own login, `codex login`: ChatGPT, or a key it stored in ~/.codex/auth.json. With none, its sign-in screen in the agent\'s terminal.',
  },
  {
    id: 'qwen-code', label: 'Qwen Code', provider: 'qwen-code', envVar: 'OPENAI_API_KEY', choices: PROVIDER_VARS,
    measured: 'Qwen Code 0.25.2 (18/10): each model of modelProviders in ~/.qwen/settings.json names the variable its key is read from (envKey: DEEPSEEK_API_KEY here), which is the one used; a key in the agent\'s environment wins over the one its settings\' env holds (measured with a wrong key: 401). OPENAI_API_KEY when its model names none.',
    withoutKey: 'The key its settings.json env, or the shell, holds for that variable. With none, every request is refused (401).',
  },
  {
    id: 'gemini', label: 'Gemini CLI', provider: 'gemini', envVar: 'GEMINI_API_KEY', choices: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    measured: 'Not installed here: from Gemini CLI\'s documentation (GEMINI_API_KEY; GOOGLE_API_KEY with Vertex AI). Unmeasured.',
    withoutKey: 'Its own sign-in, a Google account kept in ~/.gemini. With none, its sign-in prompt in the agent\'s terminal.',
  },
  {
    id: 'opencode', label: 'OpenCode', provider: 'opencode', envVar: null, choices: PROVIDER_VARS,
    measured: 'Not installed here: opencode reads each model provider\'s own variable (its documentation), so the key goes under the one of the provider its model uses, which you name. Unmeasured.',
    withoutKey: 'The keys `opencode auth login` stored, or the shell\'s.',
  },
  {
    id: 'pi', label: 'Pi', provider: 'pi', envVar: null, choices: PROVIDER_VARS,
    measured: 'Not installed here: Pi reads each model provider\'s own variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY...), which you name. Unmeasured.',
    withoutKey: 'The keys its own settings or the shell hold; with none, its requests are refused.',
  },
  {
    id: 'grok', label: 'Grok CLI', provider: 'grok', envVar: 'GROK_API_KEY', choices: ['GROK_API_KEY', 'XAI_API_KEY'],
    measured: 'Not installed here: from grok-cli\'s documentation (GROK_API_KEY). Unmeasured.',
    withoutKey: 'The key in ~/.grok/user-settings.json, or it asks for one in the agent\'s terminal.',
  },
  {
    id: 'amp', label: 'Amp', provider: 'amp', envVar: 'AMP_API_KEY', fixed: true, choices: [],
    measured: 'amp --help documents AMP_API_KEY, which Tars already passed before 2.0.4 (ampApiKey).',
    withoutKey: 'Its device login flow in the agent\'s terminal, which an agent working alone cannot complete.',
  },
  {
    id: 'omp', label: 'oh-my-pi', provider: null, envVar: null, choices: PROVIDER_VARS,
    measured: 'Not a CLI of Tars\'s yet: its variable is the one you name until its provider is added and measured. Never its --api-key, which ps would show.',
    withoutKey: 'Unknown until its provider is added.',
  },
  {
    id: 'cline', label: 'Cline CLI', provider: null, envVar: null, choices: PROVIDER_VARS,
    measured: 'Not a CLI of Tars\'s yet: its documentation names ANTHROPIC_API_KEY and OPENAI_API_KEY; the one you name until its provider is added and measured.',
    withoutKey: 'Its own login, `cline auth`, kept in the system keychain. Unmeasured.',
  },
  {
    id: 'kilo', label: 'Kilo CLI', provider: 'kilo', envVar: null, choices: PROVIDER_VARS,
    measured: 'A build of opencode (7.8.27): which variable it reads for a model provider\'s key is not measured here, so the key goes under the one you name.',
    withoutKey: 'Its own Kilo Gateway, on its free models: what Kilo 7.8.27 started on with no config of the user\'s (measured 20/11).',
  },
];

const specOf = (id: CliKeyId) => CLI_KEYS.find((c) => c.id === id);

/** A key: no whitespace or control character anywhere (a line break would carry another variable), 4096 characters at most. */
const KEY_SHAPE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
/** A key variable's name, and none Tars sets itself or one that changes how a process runs. */
const VAR_SHAPE = /^[A-Z][A-Z0-9_]{0,59}_(API_KEY|KEY|TOKEN)$/;
const RESERVED = /^(CLAUDE_|DOROTHY_|TARS_|DYLD_|LD_|NODE_|NPM_|ELECTRON_)/;

export function validEnvVar(name: string): boolean {
  return VAR_SHAPE.test(name) && !RESERVED.test(name);
}

/**
 * The variable Qwen Code reads its model's key from: the envKey of that
 * model's entry in ~/.qwen/settings.json modelProviders (the model named, or
 * the one its settings select). Undefined when the file is missing, cannot be
 * read, or names none.
 */
export function qwenEnvKey(model?: string, homeDir = os.homedir()): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(homeDir, '.qwen', 'settings.json'), 'utf8')) as {
      model?: { name?: unknown }; modelProviders?: Record<string, Array<{ id?: unknown; envKey?: unknown }>>;
    };
    const wanted = model ?? (typeof s.model?.name === 'string' ? s.model.name : undefined);
    if (!wanted || !s.modelProviders || typeof s.modelProviders !== 'object') return undefined;
    for (const list of Object.values(s.modelProviders)) {
      if (!Array.isArray(list)) continue;
      const entry = list.find((m) => m && m.id === wanted);
      if (entry && typeof entry.envKey === 'string' && validEnvVar(entry.envKey)) return entry.envKey;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type Where = { model?: string; homeDir?: string };

function entryOf(settings: Partial<AppSettings> | undefined, id: CliKeyId): CliApiKey | undefined {
  return settings?.cliApiKeys?.[id];
}

/** The key Tars holds for a CLI: the one set in Settings, or amp's of before 2.0.4. */
function keyOf(settings: Partial<AppSettings> | undefined, id: CliKeyId): string | undefined {
  const key = entryOf(settings, id)?.key ?? (id === 'amp' ? settings?.ampApiKey : undefined);
  return key && KEY_SHAPE.test(key) ? key : undefined;
}

/** The variable a CLI's agents get its key under, and where that name comes from. */
export function keyVariableOf(id: CliKeyId, settings: Partial<AppSettings> | undefined, where: Where = {}): { name: string | null; from: CliKeyState['envVarFrom'] } {
  const spec = specOf(id);
  if (!spec) return { name: null, from: 'none' };
  const chosen = entryOf(settings, id)?.envVar;
  if (!spec.fixed && chosen && validEnvVar(chosen)) return { name: chosen, from: 'chosen' };
  if (id === 'qwen-code') {
    const own = qwenEnvKey(where.model, where.homeDir);
    if (own) return { name: own, from: 'cli-config' };
  }
  return spec.envVar ? { name: spec.envVar, from: 'default' } : { name: null, from: 'none' };
}

/** What a CLI's agent gets in its environment: its key under its variable, or nothing. */
export function keyEnvFor(id: CliKeyId, settings: Partial<AppSettings> | undefined, where: Where = {}): Record<string, string> {
  const key = keyOf(settings, id);
  const { name } = keyVariableOf(id, settings, where);
  return key && name ? { [name]: key } : {};
}

/**
 * Codex's interactive session reads no key from its environment (0.163): it
 * is pointed at CODEX_API_KEY by a model provider of Tars's, defined on its
 * command line by name only. Nothing when no key is set: Codex keeps its own
 * login.
 */
export function codexKeyConfig(settings: Partial<AppSettings> | undefined): string[] {
  if (!keyOf(settings, 'codex')) return [];
  return [
    '-c', 'model_provider=tars-key',
    '-c', 'model_providers.tars-key={name="OpenAI (key from Tars)", base_url="https://api.openai.com/v1", env_key="CODEX_API_KEY", wire_api="responses"}',
  ];
}

/** The CLI whose key an agent of this provider takes, or undefined (claude and the providers that run it take none of these). */
export function cliKeyOf(provider: string | undefined): CliKeyId | undefined {
  return CLI_KEYS.find((c) => c.provider === (provider ?? 'claude'))?.id;
}

/**
 * A print of the key environment an agent's terminal gets: its CLI's key
 * under its variable, or nothing. In memory only, to tell a shell spawned
 * with other keys (core/agent-manager.ts, killStalePty).
 */
export function keyPrintOf(agent: { provider?: string; model?: string }, settings: Partial<AppSettings> | undefined): string {
  const cli = cliKeyOf(agent.provider);
  const env = cli ? keyEnvFor(cli, settings, { model: agent.model }) : {};
  return createHash('sha256').update(JSON.stringify(Object.entries(env).sort())).digest('hex');
}

/** What the window may know of each CLI's key: whether one is set and where it goes, never the key. */
export function cliKeyStates(settings: Partial<AppSettings> | undefined, where: Where = {}): CliKeyState[] {
  return CLI_KEYS.map((spec) => {
    const variable = keyVariableOf(spec.id, settings, where);
    return {
      id: spec.id, label: spec.label, hasKey: !!keyOf(settings, spec.id),
      envVar: variable.name, envVarFrom: variable.from, envVarFixed: !!spec.fixed, envVarRequired: spec.envVar === null && spec.id !== 'qwen-code',
      envVarChoices: spec.choices, provider: spec.provider, measured: spec.measured, withoutKey: spec.withoutKey,
    };
  });
}

/**
 * The settings with a CLI's key or variable changed: `key` a new key, null or
 * '' to clear it; `envVar` the variable to use, null to go back to the CLI's
 * own. Refused, with why, for a CLI Tars does not know, a key or a name that
 * is not one, or a variable a CLI fixes.
 */
export function withCliKey(
  settings: AppSettings, id: CliKeyId, patch: { key?: string | null; envVar?: string | null },
): { ok: true; settings: AppSettings } | { ok: false; error: string } {
  const spec = specOf(id);
  if (!spec) return { ok: false, error: 'No CLI of Tars\'s takes a key under that name.' };
  const entry: CliApiKey = { ...(entryOf(settings, id) ?? { key: '' }) };
  if (typeof patch.key === 'string' && patch.key !== '') {
    if (!KEY_SHAPE.test(patch.key)) return { ok: false, error: 'A key has no space, line break or control character, and 4096 characters at most.' };
    entry.key = patch.key;
  } else if (patch.key === null || patch.key === '') {
    entry.key = '';
  }
  if (typeof patch.envVar === 'string') {
    if (spec.fixed) return { ok: false, error: `${spec.label} reads its key from ${spec.envVar}, which cannot be changed.` };
    if (!validEnvVar(patch.envVar)) return { ok: false, error: 'A key variable is in capitals, digits and underscores, ends with _API_KEY, _KEY or _TOKEN, and is none Tars sets itself.' };
    entry.envVar = patch.envVar;
  } else if (patch.envVar === null) {
    delete entry.envVar;
  }
  const keys = { ...(settings.cliApiKeys ?? {}) };
  if (entry.key || entry.envVar) keys[id] = entry; else delete keys[id];
  const next: AppSettings = { ...settings, cliApiKeys: keys };
  // Amp's key of before 2.0.4 goes with any change of amp's key.
  if (id === 'amp' && patch.key !== undefined) delete next.ampApiKey;
  return { ok: true, settings: next };
}

/** The settings as the window may read them: without any CLI's key. */
export function withoutCliKeys<T extends Partial<AppSettings>>(settings: T): T {
  const { cliApiKeys: _keys, ampApiKey: _amp, ...rest } = settings;
  void _keys; void _amp;
  return rest as T;
}

/** A save from the window, merged: it never writes or erases a CLI's key, which only cliKeys:set changes. */
export function keepCliKeys(current: AppSettings, incoming: Partial<AppSettings>): AppSettings {
  const merged = { ...current, ...withoutCliKeys(incoming) } as AppSettings;
  if (current.cliApiKeys) merged.cliApiKeys = current.cliApiKeys; else delete merged.cliApiKeys;
  if (current.ampApiKey !== undefined) merged.ampApiKey = current.ampApiKey; else delete merged.ampApiKey;
  return merged;
}
