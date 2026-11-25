import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An API key per CLI (2.0.4, the maintainer's request of 18/10: every CLI
 * works in Tars, not only the API providers that ride on the claude binary).
 * Kept in ~/.tars/app-settings.json only, and handed to that CLI's agents
 * only, through their PTY environment (which their ACP runs take as well),
 * under the variable that CLI reads.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  K1. An agent of a CLI with a key does not get it, or gets it under a
 *      variable its CLI does not read (codex reads CODEX_API_KEY, measured on
 *      0.163; OPENAI_API_KEY is not read by it at all).
 *  K2. Another CLI's agent gets it: a codex key in a gemini agent, or in a
 *      claude agent, whose own provider key is ANTHROPIC_API_KEY.
 *  K3. A CLI with no key gets a variable anyway (empty, or the last one set),
 *      or codex is launched with a provider of Tars's while it has no key, so
 *      its own login (ChatGPT here) is no longer used.
 *  K4. Codex with a key: its interactive session ignores CODEX_API_KEY
 *      (measured: only `codex exec` reads it; the TUI shows its sign-in
 *      screen), so the key never reaches it; or the key itself is written in
 *      the command line, where ps shows it, or in Codex's own config files.
 *  K5. Qwen Code: the key goes under a variable its model does not read. The
 *      variable is the envKey its model's entry names in ~/.qwen/settings.json
 *      modelProviders (DEEPSEEK_API_KEY here), unless the user chose one; a
 *      settings file that is missing or unreadable breaks the launch.
 *  K6. A CLI with no single variable (opencode, pi, and the ones to come)
 *      gets the key under a guessed name, instead of the one the user chose.
 *  K7. A key or a variable name that is not one is stored: a line break
 *      (another variable smuggled in), a control character, an empty name,
 *      a name Tars itself sets (CLAUDE_MGR_API_TOKEN, DOROTHY_*, TARS_*), or
 *      one that changes how a process runs (PATH, NODE_OPTIONS, DYLD_*); or a
 *      CLI Tars does not know.
 *  K8. The key reaches the window: the list of CLI keys carries it, or
 *      app:getSettings returns it; or app:saveSettings, which the window calls
 *      with whatever it holds, erases a key or writes one.
 *  K9. Amp's key of before (ampApiKey) is no longer read, or wins over the
 *      one set since.
 *  K10. (the Audit's L3 on #459) A variable chosen for a CLI whose variable is
 *      its own (codex, amp) is stored, or changes where its key goes.
 *  K11. (QA's measure of 25/11, then mine) Grok's key goes under a variable
 *      grok never reads. grok 1.0.92, isolated against a loopback stand-in of
 *      xAI's API, sends XAI_API_KEY as its key (`Authorization: Bearer`),
 *      takes GROK_CODE_XAI_API_KEY too (its older name, which XAI_API_KEY
 *      wins over), and never reads GROK_API_KEY: with that one alone it sends
 *      nothing and says it is not signed in. Tars's default and first choice
 *      was GROK_API_KEY. Failing ways: the key goes under GROK_API_KEY; an
 *      install that stored GROK_API_KEY as grok's variable (the old default
 *      picked, or the first choice of the list) still gets it there after the
 *      update; a variable can still be chosen, so another name grok does not
 *      read can be picked; the window is told GROK_API_KEY.
 */

import { CLI_KEYS, keyEnvFor, keyVariableOf, cliKeyStates, withCliKey, withoutCliKeys, keepCliKeys, codexKeyConfig, qwenEnvKey } from '../../../electron/services/cli-keys';
import { getProvider } from '../../../electron/providers';
import type { AppSettings } from '../../../electron/types';

const KEY = 'sk-test-0123456789abcdef';
const settings = (over: Partial<AppSettings> = {}) => ({ ...over }) as AppSettings;
let home: string;

function qwenSettings(content: unknown) {
  fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-keys-'));
});

describe('a key per CLI, in its agents\' environment', () => {
  it('K1. each CLI\'s agents get its key under the variable it reads', () => {
    let s = settings();
    for (const [cli, key] of [['codex', 'k-codex'], ['gemini', 'k-gemini'], ['grok', 'k-grok'], ['amp', 'k-amp']] as const) {
      const r = withCliKey(s, cli, { key });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) s = r.settings;
    }
    expect(getProvider('codex').getPtyEnvVars('a', '/p', [], s)).toMatchObject({ CODEX_API_KEY: 'k-codex' });
    expect(getProvider('gemini').getPtyEnvVars('a', '/p', [], s)).toMatchObject({ GEMINI_API_KEY: 'k-gemini' });
    expect(getProvider('grok').getPtyEnvVars('a', '/p', [], s)).toMatchObject({ XAI_API_KEY: 'k-grok' });
    expect(getProvider('amp').getPtyEnvVars('a', '/p', [], s)).toMatchObject({ AMP_API_KEY: 'k-amp' });
    expect(getProvider('codex').getPtyEnvVars('a', '/p', [], s).OPENAI_API_KEY).toBeUndefined();
  });

  it('K2. no other CLI\'s agent gets it', () => {
    const r = withCliKey(settings(), 'codex', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    for (const provider of ['gemini', 'grok', 'amp', 'opencode', 'pi', 'claude'] as const) {
      const env = getProvider(provider).getPtyEnvVars('a', '/p', [], r.settings);
      expect(Object.values(env), provider).not.toContain(KEY);
    }
  });

  it('K3. a CLI with no key gets no variable, and codex keeps its own login', () => {
    for (const provider of ['codex', 'gemini', 'grok', 'amp', 'opencode', 'pi'] as const) {
      const env = getProvider(provider).getPtyEnvVars('a', '/p', [], settings());
      expect(Object.keys(env).filter((k) => /_(API_KEY|KEY|TOKEN)$/.test(k)), provider).toEqual([]);
    }
    expect(codexKeyConfig(settings())).toEqual([]);
    const cmd = getProvider('codex').buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'hi', appSettings: settings() } as never);
    expect(cmd).not.toContain('model_provider');
  });

  it('K4. codex with a key: its session is pointed at the variable, by name only, never the key', () => {
    const r = withCliKey(settings(), 'codex', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    const cmd = getProvider('codex').buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'hi', appSettings: r.settings } as never);
    expect(cmd).toContain('model_provider=');
    expect(cmd).toContain('env_key="CODEX_API_KEY"');
    expect(cmd).not.toContain(KEY);
    expect(codexKeyConfig(r.settings).join(' ')).not.toContain(KEY);
  });

  it('K5. qwen code: its model\'s envKey, the user\'s choice first, and a missing or broken settings file breaks nothing', () => {
    qwenSettings({ model: { name: 'deepseek-v4-pro' }, modelProviders: { openai: [
      { id: 'deepseek-v4-pro', envKey: 'DEEPSEEK_API_KEY' }, { id: 'kimi', envKey: 'MOONSHOT_API_KEY' },
    ] } });
    expect(qwenEnvKey(undefined, home)).toBe('DEEPSEEK_API_KEY');
    expect(qwenEnvKey('kimi', home)).toBe('MOONSHOT_API_KEY');
    const r = withCliKey(settings(), 'qwen-code', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    expect(keyEnvFor('qwen-code', r.settings, { homeDir: home })).toEqual({ DEEPSEEK_API_KEY: KEY });
    expect(keyEnvFor('qwen-code', r.settings, { homeDir: home, model: 'kimi' })).toEqual({ MOONSHOT_API_KEY: KEY });
    expect(keyVariableOf('qwen-code', r.settings, { homeDir: home })).toEqual({ name: 'DEEPSEEK_API_KEY', from: 'cli-config' });
    const chosen = withCliKey(r.settings, 'qwen-code', { envVar: 'OPENAI_API_KEY' });
    if (!chosen.ok) throw new Error(chosen.error);
    expect(keyEnvFor('qwen-code', chosen.settings, { homeDir: home })).toEqual({ OPENAI_API_KEY: KEY });
    qwenSettings('{ not json');
    expect(qwenEnvKey(undefined, home)).toBeUndefined();
    expect(keyEnvFor('qwen-code', r.settings, { homeDir: home })).toEqual({ OPENAI_API_KEY: KEY });
    fs.rmSync(path.join(home, '.qwen'), { recursive: true });
    expect(keyEnvFor('qwen-code', r.settings, { homeDir: home })).toEqual({ OPENAI_API_KEY: KEY });
  });

  it('K6. a CLI with no single variable gets the key only under the name the user chose', () => {
    const r = withCliKey(settings(), 'opencode', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    expect(getProvider('opencode').getPtyEnvVars('a', '/p', [], r.settings)).not.toHaveProperty('OPENAI_API_KEY');
    expect(keyVariableOf('opencode', r.settings)).toEqual({ name: null, from: 'none' });
    const named = withCliKey(r.settings, 'opencode', { envVar: 'OPENROUTER_API_KEY' });
    if (!named.ok) throw new Error(named.error);
    expect(getProvider('opencode').getPtyEnvVars('a', '/p', [], named.settings)).toMatchObject({ OPENROUTER_API_KEY: KEY });
    const pi = withCliKey(settings(), 'pi', { key: KEY, envVar: 'ANTHROPIC_API_KEY' });
    if (!pi.ok) throw new Error(pi.error);
    expect(getProvider('pi').getPtyEnvVars('a', '/p', [], pi.settings)).toMatchObject({ ANTHROPIC_API_KEY: KEY });
  });

  it('K7. what is no key, no variable name, or no CLI of Tars\'s is refused, and nothing is stored', () => {
    for (const key of ['a\nb', 'a\rb', 'a\u0000b', 'a\u001bb', ' ', 'x'.repeat(4097)]) {
      expect(withCliKey(settings(), 'codex', { key }), JSON.stringify(key)).toMatchObject({ ok: false });
    }
    for (const envVar of ['', 'lower_api_key', 'PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'HOME', 'CLAUDE_MGR_API_TOKEN', 'DOROTHY_TOKEN', 'TARS_KEY', 'A B_KEY', 'MY_VAR', 'X'.repeat(80) + '_KEY']) {
      expect(withCliKey(settings(), 'opencode', { key: KEY, envVar }), envVar).toMatchObject({ ok: false });
    }
    expect(withCliKey(settings(), 'nope' as never, { key: KEY })).toMatchObject({ ok: false });
    expect(withCliKey(settings(), 'claude' as never, { key: KEY })).toMatchObject({ ok: false });
  });

  it('K8. the window never gets a key, and saving the settings it holds neither erases nor writes one', () => {
    const r = withCliKey(settings({ ampApiKey: 'old-amp' }), 'codex', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    const states = cliKeyStates(r.settings, { homeDir: home });
    expect(JSON.stringify(states)).not.toContain(KEY);
    expect(JSON.stringify(states)).not.toContain('old-amp');
    expect(states.find((c) => c.id === 'codex')).toMatchObject({ hasKey: true, envVar: 'CODEX_API_KEY' });
    expect(states.map((c) => c.id).sort()).toEqual(CLI_KEYS.map((c) => c.id).sort());
    expect(JSON.stringify(withoutCliKeys(r.settings))).not.toContain(KEY);
    expect(JSON.stringify(withoutCliKeys(r.settings))).not.toContain('old-amp');
    // The window saves what it holds: no keys, or keys it made up.
    const saved = keepCliKeys(r.settings, { ...withoutCliKeys(r.settings), theme: 'light', cliApiKeys: { codex: { key: 'from-window' } }, ampApiKey: 'w' } as Partial<AppSettings>);
    expect(saved.cliApiKeys?.codex?.key).toBe(KEY);
    expect(saved.ampApiKey).toBe('old-amp');
    expect((saved as Record<string, unknown>).theme).toBe('light');
  });

  it('K9. amp\'s key of before is still read, and one set since wins; clearing it clears both', () => {
    const old = settings({ ampApiKey: 'old-amp' });
    expect(getProvider('amp').getPtyEnvVars('a', '/p', [], old)).toMatchObject({ AMP_API_KEY: 'old-amp' });
    const r = withCliKey(old, 'amp', { key: 'new-amp' });
    if (!r.ok) throw new Error(r.error);
    expect(getProvider('amp').getPtyEnvVars('a', '/p', [], r.settings)).toMatchObject({ AMP_API_KEY: 'new-amp' });
    const cleared = withCliKey(r.settings, 'amp', { key: null });
    if (!cleared.ok) throw new Error(cleared.error);
    expect(getProvider('amp').getPtyEnvVars('a', '/p', [], cleared.settings).AMP_API_KEY).toBeUndefined();
  });

  it('K10. the variable of codex and amp is theirs: a change is refused, and the key still goes there', () => {
    for (const cli of ['codex', 'amp'] as const) {
      const r = withCliKey(settings(), cli, { key: KEY });
      if (!r.ok) throw new Error(r.error);
      const changed = withCliKey(r.settings, cli, { envVar: 'OPENAI_API_KEY' });
      expect(changed, cli).toMatchObject({ ok: false });
      if (!changed.ok) expect(changed.error).toContain(cli === 'codex' ? 'CODEX_API_KEY' : 'AMP_API_KEY');
      expect(keyVariableOf(cli, r.settings).name).toBe(cli === 'codex' ? 'CODEX_API_KEY' : 'AMP_API_KEY');
      // One written by hand in the file is not read either.
      const forged = { ...r.settings, cliApiKeys: { [cli]: { key: KEY, envVar: 'OPENAI_API_KEY' } } } as AppSettings;
      expect(keyEnvFor(cli, forged)).toEqual({ [cli === 'codex' ? 'CODEX_API_KEY' : 'AMP_API_KEY']: KEY });
    }
  });

  it('K11. grok\'s key goes under XAI_API_KEY, the one grok reads, whatever name an install stored before', () => {
    const r = withCliKey(settings(), 'grok', { key: KEY });
    if (!r.ok) throw new Error(r.error);
    expect(getProvider('grok').getPtyEnvVars('a', '/p', [], r.settings)).toMatchObject({ XAI_API_KEY: KEY });
    expect(getProvider('grok').getPtyEnvVars('a', '/p', [], r.settings).GROK_API_KEY).toBeUndefined();
    // An install of before: GROK_API_KEY stored as grok's variable, the old default picked or the list's first choice.
    for (const stored of ['GROK_API_KEY', 'OPENAI_API_KEY']) {
      const old = { cliApiKeys: { grok: { key: KEY, envVar: stored } } } as unknown as AppSettings;
      expect(keyEnvFor('grok', old), stored).toEqual({ XAI_API_KEY: KEY });
      expect(keyVariableOf('grok', old), stored).toEqual({ name: 'XAI_API_KEY', from: 'default' });
    }
    // No other name can be chosen: grok reads XAI_API_KEY, or its older GROK_CODE_XAI_API_KEY, which XAI_API_KEY wins over.
    const changed = withCliKey(r.settings, 'grok', { envVar: 'GROK_API_KEY' });
    expect(changed).toMatchObject({ ok: false });
    if (!changed.ok) expect(changed.error).toContain('XAI_API_KEY');
    // The window is told the variable grok reads, fixed, with nothing to choose from.
    expect(cliKeyStates(r.settings).find((c) => c.id === 'grok')).toMatchObject({ envVar: 'XAI_API_KEY', envVarFrom: 'default', envVarFixed: true, envVarChoices: [], hasKey: true });
  });
});

