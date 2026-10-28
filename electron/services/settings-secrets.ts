import * as fs from 'fs';
import * as path from 'path';
import { APP_SETTINGS_FILE, DATA_DIR, privatePath } from '../constants';
import type { AppSettings } from '../types';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';

/**
 * The settings' secrets, apart from the rest: in ~/.tars-private, which no
 * agent is handed, where app-settings.json is in ~/.tars, in every agent's
 * --add-dir (the maintainer's decision of 2026-10-18). Until 2.0.4 every key of
 * the app sat in that one file, one `cat` away from any agent.
 *
 * The app holds its settings in memory whole, as before: the bots, the
 * providers and the memory backends read them where they did. What changes is
 * what is written where (saveSettingsSplit), what a process outside the app
 * reads (loadSettingsWithSecrets, through readAppSettingsFromDisk), and what
 * the window is handed (withoutSecrets: never a secret, only whether each is
 * set). The Sentry token keeps the private file it already had
 * (sentry-token.ts), and the Hermes dashboard token its own (hermes-config.ts).
 */
export const SECRETS_FILE = privatePath('settings-secrets.json');

/** Every credential AppSettings carries. A field named like a key, a token, a secret or a password must be here. */
export const SECRET_FIELDS = [
  'slackBotToken', 'slackAppToken', 'slackSigningSecret',
  'discordBotToken',
  'jiraApiToken', 'socialDataApiKey',
  'xApiKey', 'xApiSecret', 'xAccessToken', 'xAccessTokenSecret',
  'ampApiKey', 'cliApiKeys',
  'openRouterApiKey', 'deepSeekApiKey', 'mimoApiKey', 'moonshotApiKey', 'qwenApiKey', 'zhipuApiKey',
  'minimaxApiKey', 'nvidiaApiKey', 'nousPortalApiKey', 'veniceApiKey', 'ollamaCloudApiKey', 'customOpenAIApiKey',
  'hermesGatewayToken', 'memoryGbrainAuthToken', 'memoryHonchoApiKey',
] as const satisfies readonly (keyof AppSettings)[];

export type SecretField = typeof SECRET_FIELDS[number];

/**
 * Keys an older Tars saved that are no field of AppSettings any more, so the
 * inventory above never names them: Claude Code's panel kept an
 * anthropicApiKey until #460, which Tars never used. Moved out of
 * app-settings.json with the others, and kept in the private file, never
 * read (the Audit's re-check of #460).
 */
const LEGACY_SECRET_FIELDS = ['anthropicApiKey'] as const;
type LegacySecrets = Partial<Record<typeof LEGACY_SECRET_FIELDS[number], string>>;
type Secrets = Partial<Pick<AppSettings, SecretField>> & LegacySecrets;
const MOVED_FIELDS: readonly string[] = [...SECRET_FIELDS, ...LEGACY_SECRET_FIELDS];

/**
 * The ones the window sets and clears through secrets:set, and is shown as a
 * mask: the CLIs' keys go through cliKeys:set instead. The Sentry token keeps
 * its own private file (sentry-token.ts) and is one of them.
 */
export const WINDOW_SET_FIELDS = [...SECRET_FIELDS.filter((f) => f !== 'cliApiKeys' && f !== 'ampApiKey'), 'sentryAuthToken'] as const;
type WindowField = typeof WINDOW_SET_FIELDS[number];

/** A field the move takes out of app-settings.json: a secret, or a legacy one. */
const isSecretField = (f: string): boolean => MOVED_FIELDS.includes(f);

/** A value worth keeping: a non-empty string, or an object with something in it. */
function holds(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

function secretsOf(settings: Record<string, unknown>): Secrets {
  const out: Record<string, unknown> = {};
  for (const f of MOVED_FIELDS) if (holds(settings[f])) out[f] = settings[f];
  return out as Secrets;
}

/** The private file: what it holds, `{}` when there is none, null when it cannot be read. */
function readSecretsFile(): Secrets | null {
  let raw: string;
  try {
    raw = fs.readFileSync(SECRETS_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    console.error(`[secrets] ${SECRETS_FILE} cannot be read: ${describeSecretFileError(err)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return secretsOf(parsed);
  } catch (err) {
    console.error(`[secrets] ${SECRETS_FILE} cannot be read: ${describeSecretFileError(err)}`);
    return null;
  }
  console.error(`[secrets] ${SECRETS_FILE} holds no object`);
  return null;
}

/** What the private file holds, or nothing when it cannot be read. */
export function readSecrets(): Secrets {
  return readSecretsFile() ?? {};
}

/**
 * Written as JSON.stringify(_, null, 2) writes it, and nothing else.
 */
function writeSecrets(secrets: Secrets): void {
  writeSecretFileSync(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The settings without a secret field, empty ones included. */
export function withoutSecrets<T extends object>(settings: T): Omit<T, SecretField> {
  const out = { ...settings } as Record<string, unknown>;
  for (const f of MOVED_FIELDS) delete out[f];
  return out as Omit<T, SecretField>;
}

/** Whether each secret is set: what the window is told instead of the value. */
export function secretStates(settings: Partial<AppSettings> | undefined): Record<SecretField, boolean> {
  const out = {} as Record<SecretField, boolean>;
  for (const f of SECRET_FIELDS) out[f] = holds((settings as Record<string, unknown> | undefined)?.[f]);
  return out;
}

/**
 * What the window is shown in place of a secret that is set: never the value.
 * The pages written before 2.0.4 test a key for truth (the Telegram test
 * button, a provider's "set" state), and keep working on it; a save that sends
 * it back keeps the key (keepSecrets).
 */
export const SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

/**
 * The settings as the window gets them: each secret it sets as the mask when
 * set and '' when not, the CLIs' keys not at all (cliKeys:list says those),
 * and whether each is set.
 */
export function settingsForWindow<T extends Partial<AppSettings>>(settings: T): Omit<T, SecretField> & { secretsSet: Record<SecretField | WindowField, boolean> } {
  const states = { ...secretStates(settings), sentryAuthToken: holds(settings.sentryAuthToken) };
  const masked: Record<string, string> = {};
  for (const f of WINDOW_SET_FIELDS) masked[f] = states[f] ? SECRET_MASK : '';
  return { ...withoutSecrets(settings), ...masked, secretsSet: states } as Omit<T, SecretField> & { secretsSet: Record<SecretField | WindowField, boolean> };
}

/**
 * A save from the window, merged into the settings the app holds. The window
 * holds no secret, so a field it leaves out, sends empty, or sends back as the
 * mask it was shown, keeps the key; a key typed in a page reaches it.
 * Clearing one is secrets:set's (setSecret). The CLIs' keys only ever change
 * through cliKeys:set.
 */
export function keepSecrets(current: AppSettings, incoming: Partial<AppSettings>): AppSettings {
  // What app:getSettings added: never saved.
  const { secretsSet: _states, ...fields } = incoming as Partial<AppSettings> & { secretsSet?: unknown };
  void _states;
  const merged = { ...current, ...withoutSecrets(fields) } as AppSettings;
  const typed = incoming as Record<string, unknown>;
  for (const f of [...SECRET_FIELDS, 'sentryAuthToken'] as const) {
    const value = f !== 'cliApiKeys' && f !== 'ampApiKey' && typeof typed[f] === 'string' && holds(typed[f]) && typed[f] !== SECRET_MASK
      ? String(typed[f]).trim() : undefined;
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[f] = value;
    else if (f in current) (merged as unknown as Record<string, unknown>)[f] = (current as unknown as Record<string, unknown>)[f];
    else delete (merged as unknown as Record<string, unknown>)[f];
  }
  return merged;
}

/** One secret set (a string) or cleared (null or ''), for secrets:set. Refused for a field that is not one the window sets. */
export function setSecret(current: AppSettings, field: string, value: string | null): { ok: true; settings: AppSettings } | { ok: false; error: string } {
  if (!(WINDOW_SET_FIELDS as readonly string[]).includes(field)) return { ok: false, error: `${field} is not a secret Settings sets` };
  if (value !== null && typeof value !== 'string') return { ok: false, error: 'a secret is a string, or null to clear it' };
  const next = { ...current } as unknown as Record<string, unknown>;
  next[field] = value === null ? '' : value.trim();
  return { ok: true, settings: next as unknown as AppSettings };
}

/**
 * The settings as the app saves them: the secrets to the private file first,
 * then the rest to app-settings.json, so that a stop between the two leaves
 * every key where the next load finds it. A private file that cannot be read
 * is set aside in the private folder rather than written over: the app loaded
 * without its keys, and a save would otherwise lose them for good.
 */
export function saveSettingsSplit(settings: AppSettings): void {
  if (readSecretsFile() === null) setAside(SECRETS_FILE);
  writeSecrets(secretsOf(settings as unknown as Record<string, unknown>));
  writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(withoutSecrets(settings), null, 2));
}

function setAside(file: string): void {
  const aside = `${file}.unreadable-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
    console.error(`[secrets] ${path.basename(file)} could not be read and was kept as ${path.basename(aside)} in the private folder`);
  } catch (err) {
    console.error(`[secrets] ${path.basename(file)} could not be set aside: ${describeSecretFileError(err)}`);
  }
}

/**
 * The settings with their secrets, for a reader outside the settings the app
 * holds (readAppSettingsFromDisk). A key still in app-settings.json (an older
 * Tars wrote it since) wins, as the migration has it win.
 */
export function loadSettingsWithSecrets(): Partial<AppSettings> {
  const plain = readJson(APP_SETTINGS_FILE) ?? {};
  return { ...plain, ...readSecrets(), ...secretsOf(plain) } as Partial<AppSettings>;
}

/** The copies of app-settings.json beside it: backups, a temp file a write left. */
function settingsCopies(): string[] {
  const base = path.basename(APP_SETTINGS_FILE);
  try {
    return fs.readdirSync(DATA_DIR).filter((n) => n !== base && n.startsWith(`${base}.`)).map((n) => path.join(DATA_DIR, n));
  } catch {
    return [];
  }
}

/**
 * Remove a file that held a secret: its bytes written over with zeros, then
 * unlinked. A link is unlinked and what it names left alone. On a
 * copy-on-write filesystem (APFS, btrfs) the zeros land in new blocks and the
 * old ones are only freed: SECURITY.md says so.
 */
function erase(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size > 0) {
      const fd = fs.openSync(file, 'r+');
      try { fs.writeSync(fd, Buffer.alloc(stat.size), 0, stat.size, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (stat.isDirectory()) return false;
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    console.error(`[secrets] ${path.basename(file)} could not be erased: ${describeSecretFileError(err)}`);
    return false;
  }
}

/**
 * A credential file out of ~/.tars into the private folder, its contents
 * unchanged: copied, read back, and only then erased, as the webhook secret
 * moved (hermes-webhook-secret.ts). When the private one exists already it is
 * the file, and the old copy is only erased. When the copy cannot be made, the
 * old file stays where it is. True when there was one to move.
 */
export function moveOutOfAgentReach(legacy: string, target: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(legacy); } catch { return false; }
  if (!stat.isFile()) return erase(legacy);
  try {
    if (!fs.existsSync(target)) {
      const contents = fs.readFileSync(legacy, 'utf-8');
      writeSecretFileSync(target, contents);
      if (fs.readFileSync(target, 'utf-8') !== contents) {
        fs.rmSync(target, { force: true });
        console.error(`[secrets] ${path.basename(legacy)} did not copy across; it stays where it is`);
        return false;
      }
    }
  } catch (err) {
    console.error(`[secrets] ${path.basename(legacy)} could not move to the private folder: ${describeSecretFileError(err)}`);
    return false;
  }
  return erase(legacy);
}

/** The credential files that used to live in ~/.tars, and where they live now. */
export const MOVED_FILES: ReadonlyArray<readonly [string, string]> = [
  ['api-token', 'api-token'],
  ['hermes-connection.json', 'hermes-connection.json'],
  ['hermes-session.json', 'hermes-session.json'],
].map(([from, to]) => [path.join(DATA_DIR, from), privatePath(to)] as const);

/**
 * At load, before anything reads a key: every secret out of app-settings.json
 * and out of every copy of it, into the private file, and the credential files
 * out of ~/.tars.
 *
 * In this order, so that a stop anywhere loses nothing and the next load
 * finishes it: the keys of the live file, then of each copy (into the fields
 * still empty: the live file and the private one are newer than a backup), are
 * written to the private file first; then each copy is erased; then the live
 * file is written again without them. A key in the live file wins over the
 * private file's: an older Tars that ran since wrote it last. A live file that
 * does not parse is left as it is, and so is everything when the private file
 * cannot be read: nothing is written over a key the app cannot read. Run
 * again, it writes nothing.
 */
export function migrateSecrets(): { moved: number; copiesRemoved: number; filesMoved: number; failed?: true } {
  // Run at module load, before any window (main.ts): a throw here stops Tars
  // on Electron's error box (the Audit's M1 on #466). A step that cannot write
  // (a private folder Tars may not write, a full disk) leaves every key where
  // it was, the keys are read from there, and the next start goes on.
  let filesMoved = 0;
  try {
    for (const [legacy, target] of MOVED_FILES) if (moveOutOfAgentReach(legacy, target)) filesMoved++;
    if (filesMoved) console.log(`[secrets] out of ~/.tars: ${filesMoved} credential file(s) moved`);
    return { ...moveKeys(), filesMoved };
  } catch (err) {
    console.error(`[secrets] the keys could not all leave ~/.tars (${describeSecretFileError(err)}): they stay where they are, are read from there, and the next start tries again`);
    return { moved: 0, copiesRemoved: 0, filesMoved, failed: true };
  }
}

/** The keys of app-settings.json and of its copies, into the private file, in an order a stop at any step loses none of. */
function moveKeys(): { moved: number; copiesRemoved: number } {
  const current = readSecretsFile();
  if (current === null) return { moved: 0, copiesRemoved: 0 };
  const liveExists = fs.existsSync(APP_SETTINGS_FILE);
  const live = liveExists ? readJson(APP_SETTINGS_FILE) : {};
  if (live === null) {
    console.error(`[secrets] ${path.basename(APP_SETTINGS_FILE)} does not parse: its keys stay where they are until it does`);
    return { moved: 0, copiesRemoved: 0 };
  }

  const fromLive = secretsOf(live);
  const merged: Record<string, unknown> = { ...current, ...fromLive };
  const copies = settingsCopies();
  for (const copy of copies) {
    const saved = readJson(copy);
    if (!saved) continue;
    for (const [f, v] of Object.entries(secretsOf(saved))) if (!holds(merged[f])) merged[f] = v;
  }
  const moved = Object.keys(fromLive).length;
  // Written before any copy is erased: a write that fails leaves the key a backup alone holds in it.
  if (JSON.stringify(merged) !== JSON.stringify(current)) writeSecrets(merged as Secrets);
  // The copies before the live file: its write removes a temp file of its own
  // name without writing over it first.
  let copiesRemoved = 0;
  for (const copy of copies) if (erase(copy)) copiesRemoved++;
  if (liveExists && Object.keys(live).some(isSecretField)) {
    writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(withoutSecrets(live), null, 2));
  }
  if (moved || copiesRemoved) {
    console.log(`[secrets] out of ~/.tars: ${moved} key(s) of app-settings.json, ${copiesRemoved} copy(ies) of it erased`);
  }
  return { moved, copiesRemoved };
}
