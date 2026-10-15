import * as fs from 'fs';
import { APP_SETTINGS_FILE, privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * The Sentry token, apart from the rest of the settings: in ~/.tars-private,
 * which no agent is handed, where app-settings.json is in ~/.dorothy, in every
 * agent's --add-dir (the Audit's gates of #242 and #292). Read-only, it still
 * reads JeanBrasse's Sentry organisation, user reports included. The settings the app
 * holds in memory carry it as before, so the triage and the Settings page read
 * it where they did; only what is written to disk changes, as for the Hermes
 * token (hermes-config.ts).
 */
export const SENTRY_TOKEN_FILE = privatePath('sentry-token');

function readToken(): string {
  try {
    return fs.readFileSync(SENTRY_TOKEN_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

function writeToken(token: string): void {
  const value = token.trim();
  if (value) writeSecretFileSync(SENTRY_TOKEN_FILE, value);
  else fs.rmSync(SENTRY_TOKEN_FILE, { force: true });
}

/**
 * The settings as saved, with the token from ~/.tars-private. One saved in
 * app-settings.json before 1.9.3 moves out at the first read, and the file is
 * written again without it. A token found there wins: an older Tars that ran
 * since wrote it last. An empty one is only an older Tars's default.
 */
export function sentryTokenOutOf<T extends { sentryAuthToken?: unknown }>(saved: T): T & { sentryAuthToken: string } {
  if ('sentryAuthToken' in saved) {
    const { sentryAuthToken, ...rest } = saved;
    if (typeof sentryAuthToken === 'string' && sentryAuthToken.trim()) writeToken(sentryAuthToken);
    writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(rest, null, 2));
    return { ...rest, sentryAuthToken: readToken() } as T & { sentryAuthToken: string };
  }
  return { ...saved, sentryAuthToken: readToken() };
}

/**
 * What goes into app-settings.json: everything but the token, which goes to
 * ~/.tars-private, or away when cleared. Settings that do not carry the key
 * leave the token as it is.
 */
export function settingsToSave<T extends { sentryAuthToken?: unknown }>(settings: T): Omit<T, 'sentryAuthToken'> {
  const { sentryAuthToken, ...rest } = settings;
  if ('sentryAuthToken' in settings) writeToken(typeof sentryAuthToken === 'string' ? sentryAuthToken : '');
  return rest;
}
