import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

/**
 * /auth takes a limited number of wrong tokens (the Audit's gate of #176).
 *
 * Any chat that finds the bot can send `/auth <token>`, and every one was
 * compared, however many came before. The token is 128 random bits when Tars
 * generates it, so this is less about guessing that one than about a token set
 * by hand, and about a bot that answers a stranger for ever.
 *
 * How this can fail, written before the code:
 * 1. a chat guesses without end: its sixth wrong token in fifteen minutes is
 *    still compared;
 * 2. the limit slows only the misses: a refused chat whose guess is right is
 *    enrolled all the same;
 * 3. the refusal tells a right guess from a wrong one, so it is an oracle;
 * 4. the limit never lifts: a chat that mistyped is shut out until a restart;
 * 5. one chat's misses shut out another, JeanBrasse's own included;
 * 6. misses spread over many chats escape a limit kept per chat;
 * 7. what is not a guess counts as one: `/auth` with no token, or /auth while
 *    Settings holds no auth token.
 * 8. (gate of #200) the lock-out has no way out that anyone is told of: twenty
 *    misses from anywhere shut out every new chat, JeanBrasse's too, and the refusal
 *    names neither the time it lifts nor the one thing that lifts it sooner,
 *    turning Telegram off and on in Settings, which restarts the bot.
 *
 * The bot and its handlers are the real ones; the Telegram client is a recorder
 * of the handlers the bot registers and of what it sends. Only Date is faked,
 * to move the clock past the window.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-telegram-auth-${process.pid}-${Date.now()}`),
}));
const bot = vi.hoisted(() => ({
  texts: [] as Array<{ pattern: RegExp; handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown }>,
  sent: [] as Array<{ chatId: string; text: string }>,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 1, process: 'bash', write: vi.fn(), kill: vi.fn(), resize: vi.fn(), onData: vi.fn(), onExit: vi.fn() })) }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('@slack/bolt', () => ({ App: class {}, LogLevel: { INFO: 'info' } }));
vi.mock('node-telegram-bot-api', () => ({
  default: class {
    on() {}
    onText(pattern: RegExp, handler: (msg: Record<string, unknown>, match: RegExpExecArray | null) => unknown) {
      bot.texts.push({ pattern, handler });
    }
    getMe() { return Promise.resolve({ username: 'tars_test_bot' }); }
    sendMessage(chatId: unknown, text: string) { bot.sent.push({ chatId: String(chatId), text }); return Promise.resolve({}); }
    stopPolling() { return Promise.resolve(); }
  },
}));

import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { initTelegramBotService, initTelegramBot, stopTelegramBot } from '../../../electron/services/telegram-bot';
import type { AppSettings } from '../../../electron/types';

const TOKEN = 'the-right-token';
let live: AppSettings;
const saved: AppSettings[] = [];

/** Every handler whose pattern matches, as node-telegram-bot-api calls them. */
async function send(chatId: string, text: string) {
  for (const { pattern, handler } of bot.texts) {
    const match = pattern.exec(text);
    if (match) await handler({ chat: { id: Number(chatId), type: 'private' }, text }, match);
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}
const lastReply = (chatId: string) => bot.sent.filter(m => m.chatId === chatId).at(-1)?.text ?? '';
const enrolled = (chatId: string) => (live.telegramAuthorizedChatIds ?? []).includes(chatId);
const INVALID = /Invalid token/;
const REFUSED = /Too many attempts/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpHome, { recursive: true });
  agents.clear();
  ptyProcesses.clear();
  bot.texts.length = 0;
  bot.sent.length = 0;
  saved.length = 0;
  live = {
    telegramEnabled: true, telegramBotToken: 'test-bot-token', telegramAuthToken: TOKEN,
    telegramAuthorizedChatIds: ['42'], telegramChatId: '42',
  } as AppSettings;
  initTelegramBotService(agents, ptyProcesses, () => live, null, () => undefined, () => {}, async () => null,
    vi.fn(async () => 'pty'), s => { saved.push(s); });
  initTelegramBot();
});

afterEach(() => {
  stopTelegramBot();
  vi.useRealTimers();
});

const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

describe('/auth, guessed', () => {
  it('stops comparing a chat\'s tokens after five misses, the right one included, and says the same to both', async () => {
    for (let i = 1; i <= 5; i++) {
      await send('99', `/auth wrong-${i}`);
      expect(lastReply('99'), `miss ${i}`).toMatch(INVALID);
    }

    await send('99', '/auth wrong-6');
    const toAMiss = lastReply('99');
    await send('99', `/auth ${TOKEN}`);
    const toTheToken = lastReply('99');

    expect(toAMiss).toMatch(REFUSED);
    expect(toTheToken, 'the refusal told the right token from a wrong one').toBe(toAMiss);
    expect(enrolled('99'), 'a refused chat was enrolled').toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('says how long to wait, and lets the chat try again once its first miss is fifteen minutes old', async () => {
    for (let i = 1; i <= 5; i++) {
      await send('99', `/auth wrong-${i}`);
      minutes(1);
    }
    // The first miss was five minutes ago: ten more to go.
    await send('99', `/auth ${TOKEN}`);
    expect(lastReply('99')).toMatch(REFUSED);
    // At the minute the first miss is fifteen minutes old, on the clock of the Mac Tars runs on.
    expect(lastReply('99')).toContain(`Try again at ${clock(Date.now() + 10 * 60_000)}`);

    minutes(10);
    await send('99', `/auth ${TOKEN}`);
    expect(enrolled('99'), 'the limit never lifted').toBe(true);
  });

  it('lets another chat in while one is refused', async () => {
    for (let i = 1; i <= 6; i++) await send('99', `/auth wrong-${i}`);
    expect(lastReply('99')).toMatch(REFUSED);

    await send('7', `/auth ${TOKEN}`);
    expect(enrolled('7'), 'one chat\'s misses shut out another').toBe(true);
  });

  it('refuses every chat once twenty misses came from all of them together', async () => {
    for (let chat = 100; chat < 120; chat++) {
      await send(String(chat), '/auth wrong');
      expect(lastReply(String(chat))).toMatch(INVALID);
    }

    await send('200', `/auth ${TOKEN}`);
    expect(lastReply('200')).toMatch(REFUSED);
    expect(enrolled('200'), 'misses spread over chats escaped the limit').toBe(false);

    minutes(15);
    await send('200', `/auth ${TOKEN}`);
    expect(enrolled('200')).toBe(true);
  });

  it('8. names the way out of a lock-out, and turning Telegram off and on in Settings is one', async () => {
    for (let chat = 100; chat < 120; chat++) await send(String(chat), '/auth wrong');
    await send('200', `/auth ${TOKEN}`);

    expect(lastReply('200')).toMatch(REFUSED);
    expect(lastReply('200')).toContain(`Try again at ${clock(Date.now() + 15 * 60_000)}`);
    expect(lastReply('200')).toMatch(/turn Telegram off and on in Tars's Settings/);

    // What the Settings toggle does: app:saveSettings stops the bot and starts it again.
    stopTelegramBot();
    initTelegramBot();
    await send('200', `/auth ${TOKEN}`);
    expect(enrolled('200'), 'the toggle did not clear the count').toBe(true);
  });

  it('counts only guesses: no token given, or no auth token in Settings, is no miss', async () => {
    for (let i = 0; i < 6; i++) await send('99', '/auth    ');
    live = { ...live, telegramAuthToken: '' };
    for (let i = 0; i < 6; i++) await send('99', '/auth something');
    expect(lastReply('99')).toMatch(/No authentication token configured/);
    live = { ...live, telegramAuthToken: TOKEN };

    await send('99', `/auth ${TOKEN}`);
    expect(enrolled('99'), 'what was not a guess counted as one').toBe(true);
  });
});

describe('QA, re-check of #203: the minute the refusal names', () => {
  // Each of these was seen to pass on the PR and to turn red on a mutant the
  // tests above let through: the lift rounded down, or to the nearest minute;
  // the newest miss taken for the oldest; the seconds kept. Dubai keeps UTC+4
  // all year, so the minutes below are the same on any machine, and the one
  // for the Mac's clock against UTC holds on the UTC runner CI uses as well.
  let zone: string | undefined;
  beforeEach(() => { zone = process.env.TZ; process.env.TZ = 'Asia/Dubai'; });
  afterEach(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  it('rounds the lift up to the next minute, past midnight, from the chat\'s oldest miss, and lets the chat in at that minute', async () => {
    at('2026-09-24T19:44:10Z'); // 23:44:10 in Dubai
    await send('99', '/auth wrong');
    at('2026-09-24T19:50:00Z');
    for (let i = 0; i < 4; i++) await send('99', '/auth wrong');

    at('2026-09-24T19:55:00Z');
    await send('99', `/auth ${TOKEN}`);
    // The first miss is fifteen minutes old at 23:59:10: the next whole minute is 00:00.
    expect(lastReply('99')).toContain("Try again at 00:00, or turn Telegram off and on in Tars's Settings.");

    at('2026-09-24T19:59:09Z');
    await send('99', `/auth ${TOKEN}`);
    expect(lastReply('99')).toMatch(REFUSED);

    at('2026-09-24T20:00:00Z'); // 00:00 in Dubai, the minute it named
    await send('99', `/auth ${TOKEN}`);
    expect(enrolled('99'), 'refused at the minute the refusal named').toBe(true);
  });

  it('names the lift of the oldest of all the misses when the count of all chats is full', async () => {
    at('2026-09-25T08:00:30Z'); // 12:00:30 in Dubai
    await send('100', '/auth wrong');
    at('2026-09-25T08:05:00Z');
    for (let chat = 101; chat < 120; chat++) await send(String(chat), '/auth wrong');

    at('2026-09-25T08:06:00Z');
    await send('200', `/auth ${TOKEN}`);
    expect(lastReply('200')).toContain('Try again at 12:16, or turn');
  });
});
