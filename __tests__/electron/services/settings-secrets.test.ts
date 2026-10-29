import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The secrets leave ~/.tars (2.0.4, the maintainer's decision of 18/10):
 * ~/.tars is every agent's --add-dir, so every key in app-settings.json
 * was every agent's to read. They go to ~/.tars-private/settings-secrets.json,
 * which no agent is handed; app-settings.json keeps the rest.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  P1. A secret field stays in app-settings.json after a save, or a non-secret
 *      setting is lost from it, or the private file is not 0600 in a 0700 folder.
 *  P2. A load does not find a key again: the in-memory settings lack what the
 *      private file holds, or app-settings.json's (an older Tars's) wins over a
 *      key set since, or the reverse.
 *  P3. The migration loses a key: one in app-settings.json or only in a backup
 *      of it (app-settings.json.*.bak, .tmp) never reaches the private file.
 *  P4. A copy keeps a key: a backup or a temp file still holds one after the
 *      migration; or the migration deletes a file it did not make.
 *  P5. Stopped halfway (the private file written, app-settings.json not yet
 *      stripped; or the reverse cannot happen), the next launch does not finish
 *      it, or finishing it loses or duplicates a key; run twice, it changes
 *      anything.
 *  P6. A private file that cannot be read (broken JSON) is written over, and its
 *      keys are lost.
 *  P7. api-token, hermes-connection.json and hermes-session.json stay in
 *      ~/.tars, or are lost on the way.
 *  P8. The window gets a secret back (withoutSecrets), or a save from the window,
 *      which holds none, erases one; an empty field from an old page clears a key.
 *  P9. The inventory misses a credential of AppSettings: a field named like a
 *      key, a token, a secret or a password that is not a secret field.
 * P10. (Added before its code, 2026-10-18.) The pages written before 2.0.4 test
 *      a key for truth (the Telegram test button, a provider's "set" state):
 *      with the field gone they read every key as unset. A set secret reaches
 *      the window as a mask, never as itself, and the mask sent back by a save
 *      keeps the key; secretsSet says which are set; secrets:set clears one.
 *      The Sentry token too, which keeps its own private file (sentry-token.ts)
 *      and which app:getSettings still handed the page.
 * Added before their code after the Audit's gate of 06a46bcb (2026-10-19):
 * P11. An old anthropicApiKey, which a Tars before #460 saved from Claude
 *      Code's panel, stays in app-settings.json: it is no field of AppSettings
 *      any more, so the inventory never names it.
 * P12. (M1, the Audit's probe PA) A private folder Tars cannot write (EACCES)
 *      or a full disk (ENOSPC) throws out of the migration, at module load:
 *      Tars stops on Electron's error box at its first 2.0.4 launch. Or the
 *      copies are erased before the keys are written, and a key a backup alone
 *      held is lost (the Audit's mutant S1).
 * P13. (The Audit's probe PB, its mutant S2) A save over a private file that
 *      cannot be read writes over it, instead of setting it aside.
 * (The Telegram bot's token, its switch and its authorized chats, which these
 * cases used as samples, went with Tars's own Telegram bot in 2.0.5: Discord's
 * token and Slack's switch stand in for them.)
 */

import {
  SECRET_FIELDS, migrateSecrets, loadSettingsWithSecrets, saveSettingsSplit, withoutSecrets, keepSecrets, secretStates,
  SECRETS_FILE, readSecrets, settingsForWindow, setSecret, SECRET_MASK,
} from '../../../electron/services/settings-secrets';
import { DATA_DIR, PRIVATE_DIR, APP_SETTINGS_FILE } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';

const KEYS = { deepSeekApiKey: 'ds-secret-111', discordBotToken: '123:dc-secret-222', memoryHonchoApiKey: 'honcho-333', xApiSecret: 'x-444' };
const settingsJson = () => JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf8'));
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const holding = (dir: string, needle: string): string[] => {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...holding(p, needle));
    else if (fs.readFileSync(p).toString('latin1').includes(needle)) out.push(path.relative(DATA_DIR, p));
  }
  return out;
};

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(PRIVATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

describe('the secrets, in ~/.tars-private', () => {
  it('P9. every credential field of AppSettings is a secret field', () => {
    const typesFile = fs.readFileSync(path.resolve('electron/types/index.ts'), 'utf8');
    const body = typesFile.slice(typesFile.indexOf('export interface AppSettings {'));
    const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s+([a-zA-Z0-9]+)\??:/gm)].map((m) => m[1]);
    const credentialLike = fields.filter((f) => /(Key|Token|Secret|Password)$|cliApiKeys/.test(f));
    // The Sentry token keeps its own private file (services/sentry-token.ts).
    expect(credentialLike.filter((f) => f !== 'sentryAuthToken' && !SECRET_FIELDS.includes(f as never))).toEqual([]);
  });

  it('P1. a save keeps no secret in app-settings.json, every other setting, and the private file 0600 in 0700', () => {
    saveSettingsSplit({ ...KEYS, slackEnabled: true, terminalFontSize: 14, cliApiKeys: { codex: { key: 'cx-555' } } } as unknown as AppSettings);
    const plain = settingsJson();
    for (const k of [...Object.keys(KEYS), 'cliApiKeys']) expect(plain, k).not.toHaveProperty(k);
    expect(plain).toMatchObject({ slackEnabled: true, terminalFontSize: 14 });
    expect(readSecrets()).toMatchObject({ ...KEYS, cliApiKeys: { codex: { key: 'cx-555' } } });
    if (process.platform !== 'win32') {
      expect(mode(SECRETS_FILE)).toBe(0o600);
      expect(mode(PRIVATE_DIR)).toBe(0o700);
    }
    expect(holding(DATA_DIR, 'ds-secret-111')).toEqual([]);
  });

  it('P2. a load finds every key again; a key set since wins over an older file\'s', () => {
    saveSettingsSplit({ ...KEYS, slackEnabled: true } as unknown as AppSettings);
    expect(loadSettingsWithSecrets()).toMatchObject({ ...KEYS, slackEnabled: true });
  });

  it('P3, P4. the migration moves every key, the backups\' too, and leaves no copy holding one', () => {
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ ...KEYS, slackEnabled: true, ampApiKey: 'amp-666' }));
    fs.writeFileSync(`${APP_SETTINGS_FILE}.avant-node-22.bak`, JSON.stringify({ openRouterApiKey: 'or-777', deepSeekApiKey: 'ds-old-000' }));
    fs.writeFileSync(`${APP_SETTINGS_FILE}.tmp`, '{"slackBotToken": "xoxb-888", "half');
    fs.writeFileSync(path.join(DATA_DIR, 'notes.txt'), 'mine');
    const r = migrateSecrets();
    expect(r.copiesRemoved).toBe(2);
    expect(readSecrets()).toMatchObject({ ...KEYS, ampApiKey: 'amp-666', openRouterApiKey: 'or-777' });
    // The live file's key wins over a backup's older one.
    expect(readSecrets().deepSeekApiKey).toBe('ds-secret-111');
    for (const v of [...Object.values(KEYS), 'amp-666', 'or-777', 'ds-old-000', 'xoxb-888']) expect(holding(DATA_DIR, v), v).toEqual([]);
    expect(settingsJson()).toMatchObject({ slackEnabled: true });
    expect(fs.readFileSync(path.join(DATA_DIR, 'notes.txt'), 'utf8')).toBe('mine');
  });

  it('P5. stopped halfway, the next launch finishes it; run again, it changes nothing', () => {
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ ...KEYS }));
    // As if the private file had been written and the strip had not happened.
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify({ deepSeekApiKey: 'ds-secret-111' }), { mode: 0o600 });
    migrateSecrets();
    expect(readSecrets()).toMatchObject(KEYS);
    const before = { s: fs.readFileSync(SECRETS_FILE, 'utf8'), p: fs.readFileSync(APP_SETTINGS_FILE, 'utf8') };
    expect(migrateSecrets()).toMatchObject({ moved: 0, copiesRemoved: 0 });
    expect({ s: fs.readFileSync(SECRETS_FILE, 'utf8'), p: fs.readFileSync(APP_SETTINGS_FILE, 'utf8') }).toEqual(before);
  });

  it('P6. a private file that cannot be read is never written over', () => {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SECRETS_FILE, '{ broken', { mode: 0o600 });
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ ...KEYS }));
    migrateSecrets();
    expect(fs.readFileSync(SECRETS_FILE, 'utf8')).toBe('{ broken');
    // Nor is the live key taken away from where it was.
    expect(settingsJson()).toMatchObject(KEYS);
  });

  it('P7. api-token and the Hermes files move to the private folder, whole', () => {
    fs.writeFileSync(path.join(DATA_DIR, 'api-token'), 'shared-token-999');
    fs.writeFileSync(path.join(DATA_DIR, 'hermes-connection.json'), '{"token":"hermes-tok-1"}');
    fs.writeFileSync(path.join(DATA_DIR, 'hermes-session.json'), '{"cookie":"hermes-ck-2"}');
    migrateSecrets();
    expect(fs.readFileSync(path.join(PRIVATE_DIR, 'api-token'), 'utf8')).toBe('shared-token-999');
    expect(fs.readFileSync(path.join(PRIVATE_DIR, 'hermes-connection.json'), 'utf8')).toBe('{"token":"hermes-tok-1"}');
    expect(fs.readFileSync(path.join(PRIVATE_DIR, 'hermes-session.json'), 'utf8')).toBe('{"cookie":"hermes-ck-2"}');
    for (const f of ['api-token', 'hermes-connection.json', 'hermes-session.json']) expect(fs.existsSync(path.join(DATA_DIR, f)), f).toBe(false);
    // A private one already there is never replaced by an older copy.
    fs.writeFileSync(path.join(DATA_DIR, 'api-token'), 'older-token');
    migrateSecrets();
    expect(fs.readFileSync(path.join(PRIVATE_DIR, 'api-token'), 'utf8')).toBe('shared-token-999');
    expect(fs.existsSync(path.join(DATA_DIR, 'api-token'))).toBe(false);
  });

  it('P8. the window gets no secret, only whether each is set; its save neither erases nor clears one', () => {
    const current = { ...KEYS, slackEnabled: true } as unknown as AppSettings;
    expect(JSON.stringify(withoutSecrets(current))).not.toMatch(/secret|dc-secret|honcho-333|x-444/);
    expect(secretStates(current)).toMatchObject({ deepSeekApiKey: true, discordBotToken: true, slackBotToken: false });
    const saved = keepSecrets(current, { ...withoutSecrets(current), deepSeekApiKey: '', slackEnabled: false } as Partial<AppSettings>);
    expect(saved).toMatchObject({ ...KEYS, slackEnabled: false });
    // A new key typed in a page still reaches it.
    expect(keepSecrets(current, { openRouterApiKey: 'or-new' } as Partial<AppSettings>).openRouterApiKey).toBe('or-new');
  });

  it('P10. the window gets a mask for a set secret, its save of the mask keeps the key, secrets:set clears one', () => {
    const current = { ...KEYS, slackEnabled: true, cliApiKeys: { codex: { key: 'cx-1' } } } as unknown as AppSettings;
    const shown = settingsForWindow(current) as unknown as Record<string, unknown>;
    expect(JSON.stringify(shown)).not.toMatch(/ds-secret-111|dc-secret-222|honcho-333|x-444|cx-1/);
    expect(shown.deepSeekApiKey).toBe(SECRET_MASK);
    expect(shown.slackBotToken).toBe('');
    expect(shown).not.toHaveProperty('cliApiKeys');
    expect(shown.secretsSet).toMatchObject({ deepSeekApiKey: true, slackBotToken: false });
    expect(keepSecrets(current, shown as Partial<AppSettings>)).toMatchObject(KEYS);
    const cleared = setSecret(current, 'deepSeekApiKey', null);
    expect(cleared.ok && cleared.settings.deepSeekApiKey).toBe('');
    expect(setSecret(current, 'cliApiKeys', 'x').ok).toBe(false);
    expect(setSecret(current, 'slackEnabled', 'x').ok).toBe(false);
    const sentry = { ...current, sentryAuthToken: 'sntrys-e2e-1' } as AppSettings;
    const sentryShown = settingsForWindow(sentry) as unknown as Record<string, unknown>;
    expect(sentryShown.sentryAuthToken).toBe(SECRET_MASK);
    expect((sentryShown.secretsSet as Record<string, boolean>).sentryAuthToken).toBe(true);
    expect(keepSecrets(sentry, sentryShown as Partial<AppSettings>).sentryAuthToken).toBe('sntrys-e2e-1');
    const sentryCleared = setSecret(sentry, 'sentryAuthToken', null);
    expect(sentryCleared.ok && sentryCleared.settings.sentryAuthToken).toBe('');
  });
});

describe('after the Audit\'s gate of 06a46bcb', () => {
  it('P11. moves an old anthropicApiKey out of app-settings.json too', () => {
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ anthropicApiKey: 'sk-ant-old-111', slackEnabled: true }));
    migrateSecrets();
    expect(settingsJson()).not.toHaveProperty('anthropicApiKey');
    expect(settingsJson().slackEnabled).toBe(true);
    expect(readSecrets().anthropicApiKey).toBe('sk-ant-old-111');
    // Loaded back with the others, it never reaches the window, and a save keeps it where it is.
    expect(JSON.stringify(settingsForWindow(loadSettingsWithSecrets()))).not.toContain('sk-ant-old-111');
    saveSettingsSplit(loadSettingsWithSecrets() as AppSettings);
    expect(settingsJson()).not.toHaveProperty('anthropicApiKey');
    expect(readSecrets().anthropicApiKey).toBe('sk-ant-old-111');
  });

  it('P12. a private folder it cannot write: nothing thrown, nothing lost, the key a backup alone holds kept', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify({ slackEnabled: true }));
    fs.writeFileSync(`${APP_SETTINGS_FILE}.bak`, JSON.stringify({ deepSeekApiKey: 'ds-only-in-bak' }));
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(PRIVATE_DIR, 0o500);
    let threw: unknown = null;
    try { migrateSecrets(); } catch (err) { threw = err; } finally { fs.chmodSync(PRIVATE_DIR, 0o700); }
    expect(threw, 'migrateSecrets threw out of the load').toBeNull();
    expect(fs.existsSync(`${APP_SETTINGS_FILE}.bak`), 'the backup holding the only key').toBe(true);
    // The next start, with a folder it can write, finishes it.
    migrateSecrets();
    expect(readSecrets().deepSeekApiKey).toBe('ds-only-in-bak');
    expect(fs.existsSync(`${APP_SETTINGS_FILE}.bak`)).toBe(false);
  });

  it('P13. a save over a private file that cannot be read sets it aside, never writes over it', () => {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(PRIVATE_DIR, 'settings-secrets.json'), '{ broken', { mode: 0o600 });
    saveSettingsSplit({ slackEnabled: true } as unknown as AppSettings);
    const aside = fs.readdirSync(PRIVATE_DIR).filter(n => n.startsWith('settings-secrets.json.unreadable-'));
    expect(aside.length).toBe(1);
    expect(fs.readFileSync(path.join(PRIVATE_DIR, aside[0]), 'utf8')).toBe('{ broken');
  });
});
