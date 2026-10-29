import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tars's own Telegram bot is gone (2.0.5; JeanBrasse's decision of 2026-10-01, "le bot Telegram de Tars est SUPPRIMÉ
 * (pas de secours), Hermes seule voix sur Telegram"; the DB brief remove-telegram-bot-2810.md):
 * services/telegram-retired.ts, run at each launch before the settings are read.
 *
 * How it fails, written before the code:
 * R1 the bot's token or its /auth token stays in ~/.tars-private/settings-secrets.json after the first 2.0.5 launch;
 * R2 the bot's fields (telegramEnabled, telegramBotToken, telegramChatId, telegramAuthToken,
 *    telegramAuthorizedChatIds, telegramRequireMention) stay in ~/.tars/app-settings.json, where something could read
 *    them again; or an older Tars's token left in app-settings.json itself stays there;
 * R3 the owner is not told: no `telegramBotRetired` when the bot had a token, was on, or had chats; or `hadToken` says
 *    otherwise than the files did;
 * R4 an install that never set the bot up (no file, or the defaults every save of 2.0.4 writes: off, empty, no chat)
 *    is told a bot was removed;
 * R5 run again, it writes again, or moves `at`;
 * R6 a file that does not parse throws at launch (Electron's error box) or is written over: it is left as it is;
 * R7 another secret of the file, or another setting, is lost or changed;
 * R8 a save that carries the bot's fields (a window of 2.0.4 still open) writes them back;
 * R9 the bot's log of what it sent (~/.tars-private/telegram-sent.json) stays.
 * R11 (the orchestrator's addition to #545) a save carrying `defaultProvider`, a setting nothing reads (its only use
 *    was the Settings row #547 removes), writes it back.
 * R10 (the Audit's L3 on #545) a later launch removes a token the first could not read (its file did not parse then):
 *    `telegramBotRetired.hadToken` stays false, and the window never says to revoke it; or `at` moves.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.5' },
}));

const tars = () => path.join(os.homedir(), '.tars');
const priv = () => path.join(os.homedir(), '.tars-private');
const settingsFile = () => path.join(tars(), 'app-settings.json');
const secretsFile = () => path.join(priv(), 'settings-secrets.json');
const sentLog = () => path.join(priv(), 'telegram-sent.json');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const BOT = ['telegramEnabled', 'telegramBotToken', 'telegramChatId', 'telegramAuthToken', 'telegramAuthorizedChatIds', 'telegramRequireMention'];

let retired: typeof import('../../../electron/services/telegram-retired');

beforeEach(async () => {
  for (const d of [tars(), priv()]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(tars(), { recursive: true });
  fs.mkdirSync(priv(), { recursive: true, mode: 0o700 });
  vi.resetModules();
  retired = await import('../../../electron/services/telegram-retired');
});

function owner(settings: Record<string, unknown>, secrets: Record<string, unknown>) {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  fs.writeFileSync(secretsFile(), JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

describe('the first launch of 2.0.5', () => {
  it('R1, R2, R3, R7, R9: the token and the fields go, the owner is told, the rest stays', () => {
    // What the maintainer's Mac holds today: the bot on, his chat, its token in the private file.
    owner(
      { theme: 'dark', hermesRelayEnabled: false, telegramEnabled: true, telegramChatId: '42', telegramAuthorizedChatIds: ['42'], telegramRequireMention: false },
      { telegramBotToken: '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr', telegramAuthToken: 'e2e-auth', slackBotToken: 'xoxb-1' },
    );
    fs.writeFileSync(sentLog(), '{}');

    const at = new Date('2026-10-28T15:00:00Z');
    expect(retired.retireTelegramBot(at)).toEqual({ retired: true, hadToken: true });

    const settings = read(settingsFile());
    for (const f of BOT) expect(settings, f).not.toHaveProperty(f);
    expect(settings).toMatchObject({ theme: 'dark', hermesRelayEnabled: false, telegramBotRetired: { at: at.toISOString(), hadToken: true } });
    expect(read(secretsFile())).toEqual({ slackBotToken: 'xoxb-1' });
    if (process.platform !== 'win32') expect(fs.statSync(secretsFile()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(sentLog())).toBe(false);
  });

  it('R2, R3: an older Tars\'s token left in app-settings.json goes too, and counts as a token', () => {
    owner({ telegramEnabled: false, telegramBotToken: '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr' }, {});
    expect(retired.retireTelegramBot()).toEqual({ retired: true, hadToken: true });
    expect(read(settingsFile())).not.toHaveProperty('telegramBotToken');
  });

  it('R3: a bot that was on with chats but no token is told, without a token to revoke', () => {
    owner({ telegramEnabled: true, telegramAuthorizedChatIds: ['42'] }, {});
    expect(retired.retireTelegramBot()).toEqual({ retired: true, hadToken: false });
    expect(read(settingsFile()).telegramBotRetired).toMatchObject({ hadToken: false });
  });

  it('R4: the defaults of 2.0.4, or nothing at all, are dropped without a word', () => {
    owner({ theme: 'light', telegramEnabled: false, telegramChatId: '', telegramAuthorizedChatIds: [], telegramRequireMention: false }, { telegramBotToken: '', telegramAuthToken: '' });
    expect(retired.retireTelegramBot()).toEqual({ retired: false, hadToken: false });
    const settings = read(settingsFile());
    for (const f of BOT) expect(settings, f).not.toHaveProperty(f);
    expect(settings).not.toHaveProperty('telegramBotRetired');
    expect(read(secretsFile())).toEqual({});

    fs.rmSync(settingsFile());
    fs.rmSync(secretsFile());
    expect(retired.retireTelegramBot()).toEqual({ retired: false, hadToken: false });
    expect(fs.existsSync(settingsFile())).toBe(false);
    expect(fs.existsSync(secretsFile())).toBe(false);
  });

  it('R5: run again, it writes nothing and keeps the first date', () => {
    owner({ telegramEnabled: true, telegramChatId: '42' }, { telegramBotToken: '1:x' });
    retired.retireTelegramBot(new Date('2026-10-28T15:00:00Z'));
    const before = [fs.readFileSync(settingsFile(), 'utf8'), fs.readFileSync(secretsFile(), 'utf8')];
    const mtime = fs.statSync(settingsFile()).mtimeMs;
    expect(retired.retireTelegramBot(new Date('2026-11-02T09:00:00Z'))).toEqual({ retired: false, hadToken: false });
    expect([fs.readFileSync(settingsFile(), 'utf8'), fs.readFileSync(secretsFile(), 'utf8')]).toEqual(before);
    expect(fs.statSync(settingsFile()).mtimeMs).toBe(mtime);
    expect(read(settingsFile()).telegramBotRetired).toEqual({ at: '2026-10-28T15:00:00.000Z', hadToken: true });
  });

  it('R6: a file that does not parse throws nothing and is left as it is', () => {
    fs.writeFileSync(settingsFile(), '{ not json');
    fs.writeFileSync(secretsFile(), '[ also not', { mode: 0o600 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => retired.retireTelegramBot()).not.toThrow();
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe('{ not json');
    expect(fs.readFileSync(secretsFile(), 'utf8')).toBe('[ also not');
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('a token found by a later launch (the Audit\'s L3 on #545)', () => {
  it('R10: hadToken turns true, the first date kept', () => {
    owner({ telegramEnabled: true, telegramChatId: '42' }, {});
    fs.writeFileSync(secretsFile(), '{ not json yet', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(retired.retireTelegramBot(new Date('2026-10-28T15:00:00Z'))).toEqual({ retired: true, hadToken: false });
    warn.mockRestore();
    fs.writeFileSync(secretsFile(), JSON.stringify({ telegramBotToken: '1:x', slackBotToken: 'xoxb-1' }), { mode: 0o600 });
    expect(retired.retireTelegramBot(new Date('2026-11-02T09:00:00Z'))).toEqual({ retired: true, hadToken: true });
    expect(read(settingsFile()).telegramBotRetired).toEqual({ at: '2026-10-28T15:00:00.000Z', hadToken: true });
    expect(read(secretsFile())).toEqual({ slackBotToken: 'xoxb-1' });
  });
});

describe('a dead setting a save still carries (the orchestrator\'s addition to #545)', () => {
  it('R11: defaultProvider is dropped, the rest kept', () => {
    expect(retired.withoutRetiredSettings({ theme: 'dark', defaultProvider: 'codex', telegramEnabled: true })).toEqual({ theme: 'dark' });
  });
});

describe('a save after it', () => {
  it('R8: the bot\'s fields a save carries are dropped, the rest kept', () => {
    const saved = retired.withoutRetiredSettings({ theme: 'dark', telegramEnabled: true, telegramBotToken: '1:x', telegramChatId: '42', telegramAuthToken: 'a', telegramAuthorizedChatIds: ['42'], telegramRequireMention: true, telegramBotRetired: { at: 'x', hadToken: true } });
    expect(saved).toEqual({ theme: 'dark', telegramBotRetired: { at: 'x', hadToken: true } });
  });
});
