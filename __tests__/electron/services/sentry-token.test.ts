import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SENTRY_TOKEN_FILE, sentryTokenOutOf, settingsToSave } from '../../../electron/services/sentry-token';
import { APP_SETTINGS_FILE, DATA_DIR } from '../../../electron/constants';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The Sentry token, out of agents' reach (the Audit's #242 and #292 gates): it reads JeanBrasse's Sentry organisation, user
 * reports included, and ~/.dorothy, where app-settings.json lives, is in every agent's --add-dir. It is kept in
 * ~/.tars-private, as the Hermes token is since 1.9.2, and the settings in memory still carry it, so the triage and
 * the Settings page read it where they did.
 *
 * How it can fail, written before the code:
 * 1. A save writes the token into app-settings.json again.
 * 2. A token saved before (in app-settings.json) stays there after the first start, or is lost on its way out.
 * 3. A token left in app-settings.json by an older Tars that ran since does not win over the one in ~/.tars-private:
 *    the older Tars wrote it last.
 * 4. The private file is readable by anybody but its owner.
 * 5. A token cleared in Settings stays in the private file, and comes back at the next start.
 * 6. The settings the app holds lack the token once it moved, so the triage stops.
 * 7. The other settings are lost or changed on the way.
 */

function writeSaved(settings: Record<string, unknown>) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(settings));
}
const saved = () => JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8')) as Record<string, unknown>;

beforeEach(() => {
  fs.rmSync(SENTRY_TOKEN_FILE, { force: true });
  fs.rmSync(APP_SETTINGS_FILE, { force: true });
});

describe('the Sentry token', () => {
  it('lives in ~/.tars-private, not in ~/.dorothy', () => {
    expect(SENTRY_TOKEN_FILE).toBe(path.join(os.homedir(), '.tars-private', 'sentry-token'));
  });

  it('1, 4, 7. a save keeps it out of app-settings.json and in a file of its owner alone', () => {
    const toSave = settingsToSave({ sentryAuthToken: 'sntryu_one', telegramChatId: '42', errorReportsEnabled: true });

    expect(toSave).toEqual({ telegramChatId: '42', errorReportsEnabled: true });
    expect(fs.readFileSync(SENTRY_TOKEN_FILE, 'utf-8')).toBe('sntryu_one');
    if (hasPosixModes()) expect(fs.statSync(SENTRY_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });

  it('2, 6, 7. one saved before moves out at the first start, and the settings in memory still carry it', () => {
    writeSaved({ sentryAuthToken: 'sntryu_old', telegramChatId: '42' });

    const loaded = sentryTokenOutOf(saved());

    expect(loaded).toEqual({ sentryAuthToken: 'sntryu_old', telegramChatId: '42' });
    expect(saved()).toEqual({ telegramChatId: '42' });
    expect(fs.readFileSync(SENTRY_TOKEN_FILE, 'utf-8')).toBe('sntryu_old');
    if (hasPosixModes()) expect(fs.statSync(SENTRY_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });

  it('3. one an older Tars wrote into app-settings.json since wins', () => {
    settingsToSave({ sentryAuthToken: 'sntryu_private' });
    writeSaved({ sentryAuthToken: 'sntryu_written_since' });

    expect(sentryTokenOutOf(saved()).sentryAuthToken).toBe('sntryu_written_since');
    expect(fs.readFileSync(SENTRY_TOKEN_FILE, 'utf-8')).toBe('sntryu_written_since');
    expect(saved()).toEqual({});
  });

  it('6. a start with no token in app-settings.json reads the private one', () => {
    settingsToSave({ sentryAuthToken: 'sntryu_private' });
    writeSaved({ telegramChatId: '42' });

    expect(sentryTokenOutOf(saved())).toEqual({ telegramChatId: '42', sentryAuthToken: 'sntryu_private' });
  });

  it('5. cleared, it is gone from the private file, and does not come back', () => {
    settingsToSave({ sentryAuthToken: 'sntryu_one' });
    writeSaved(settingsToSave({ sentryAuthToken: '  ' }));

    expect(fs.existsSync(SENTRY_TOKEN_FILE)).toBe(false);
    expect(sentryTokenOutOf(saved()).sentryAuthToken).toBe('');
  });

  it('2. an empty token left in app-settings.json removes nothing it should keep, and leaves the file', () => {
    settingsToSave({ sentryAuthToken: 'sntryu_private' });
    writeSaved({ sentryAuthToken: '', telegramChatId: '42' });

    expect(sentryTokenOutOf(saved()).sentryAuthToken).toBe('sntryu_private');
    expect(saved()).toEqual({ telegramChatId: '42' });
  });
});
