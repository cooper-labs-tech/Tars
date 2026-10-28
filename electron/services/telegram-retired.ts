import * as fs from 'fs';
import { APP_SETTINGS_FILE, privatePath } from '../constants';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';

/**
 * Tars's own Telegram bot is gone (2.0.5; JeanBrasse's decision of 2026-10-01, "le bot Telegram de Tars est SUPPRIMÉ
 * (pas de secours), Hermes seule voix sur Telegram"; the DB brief remove-telegram-bot-2810.md). Telegram goes through
 * the relay to the user's Hermes only (hermes-relay.ts): send_telegram, ask_user, the event reports, the Sentry
 * go-ahead.
 *
 * What a 2.0.4 left of the bot goes at the next launch, before the settings are read (main.ts loadAppSettings): its
 * six fields in ~/.tars/app-settings.json, its token and its /auth token in ~/.tars-private/settings-secrets.json
 * (or in app-settings.json, where an older Tars kept them), and its log of what it sent. When the bot had been set
 * up (a token, the switch on, a chat), `telegramBotRetired` says so once, so that the window can tell the owner the
 * token may be revoked with BotFather. A file that does not parse is left as it is; nothing here throws.
 */

export const TELEGRAM_BOT_FIELDS = [
  'telegramEnabled', 'telegramBotToken', 'telegramChatId', 'telegramAuthToken', 'telegramAuthorizedChatIds', 'telegramRequireMention',
] as const;

const SECRETS_FILE = () => privatePath('settings-secrets.json');
const SENT_LOG = () => privatePath('telegram-sent.json');

/**
 * Settings nothing reads any more, which a save drops whatever a window still sends: the bot's, and
 * `defaultProvider`, whose only use was the Settings row #547 removes (read nowhere already on 2.0.4).
 */
const RETIRED_SETTINGS: readonly string[] = [...TELEGRAM_BOT_FIELDS, 'defaultProvider'];

/** The settings without the retired ones: what a save writes, whatever a window still sends. */
export function withoutRetiredSettings<T extends object>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const f of RETIRED_SETTINGS) delete out[f];
  return out as T;
}

/** The settings without the bot's fields alone: what the launch's clean-up writes. */
function withoutTelegramBot<T extends object>(settings: T): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const f of TELEGRAM_BOT_FIELDS) delete out[f];
  return out as T;
}

const filled = (v: unknown) => (typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) ? v.length > 0 : v === true);

/** The file as an object, `undefined` when there is none, null when it does not parse (said once). */
function readObject(file: string): Record<string, unknown> | null | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    console.warn(`[telegram] ${file} cannot be read (${describeSecretFileError(err)}): the old bot's settings stay in it for now`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* said below */ }
  console.warn(`[telegram] ${file} does not parse: the old bot's settings stay in it for now`);
  return null;
}

const holdsBot = (o: Record<string, unknown>) => TELEGRAM_BOT_FIELDS.some((f) => f in o);

/** Runs at each launch; writes only what still holds something of the bot. */
export function retireTelegramBot(now: Date = new Date()): { retired: boolean; hadToken: boolean } {
  try {
    const settings = readObject(APP_SETTINGS_FILE);
    const secrets = readObject(SECRETS_FILE());
    const found = [settings, secrets].filter((o): o is Record<string, unknown> => !!o && holdsBot(o));
    const hadToken = found.some((o) => filled(o.telegramBotToken));
    const setUp = hadToken || found.some((o) => filled(o.telegramEnabled) || filled(o.telegramChatId) || filled(o.telegramAuthorizedChatIds) || filled(o.telegramAuthToken));

    // The token first: a stop between the two writes leaves no token, only fields that read as nothing.
    if (secrets && holdsBot(secrets)) writeSecretFileSync(SECRETS_FILE(), `${JSON.stringify(withoutTelegramBot(secrets), null, 2)}\n`);
    const told = settings?.telegramBotRetired as { at?: unknown; hadToken?: unknown } | undefined;
    const tell = setUp && !!settings && !told;
    // A token a later launch found, which the first could not read (its file did not parse then): the owner is told to
    // revoke it after all, the first date kept (the Audit's L3 on #545).
    const tokenSince = hadToken && !!settings && !!told && told.hadToken !== true;
    if (settings && (holdsBot(settings) || tell || tokenSince)) {
      const kept = withoutTelegramBot(settings);
      if (tell) kept.telegramBotRetired = { at: now.toISOString(), hadToken };
      if (tokenSince) kept.telegramBotRetired = { ...told, hadToken: true };
      writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(kept, null, 2));
    }
    try { fs.rmSync(SENT_LOG(), { force: true }); } catch { /* the next launch tries again */ }
    if (found.length) {
      console.log(`[telegram] Tars's own Telegram bot is gone: its settings${hadToken ? ' and its token' : ''} removed. Telegram goes through Hermes (Settings, Hermes).`);
    }
    return { retired: tell || tokenSince, hadToken: (tell || tokenSince) && hadToken };
  } catch (err) {
    console.error(`[telegram] the old bot's settings could not all be removed (${describeSecretFileError(err)}): the next launch tries again`);
    return { retired: false, hadToken: false };
  }
}
