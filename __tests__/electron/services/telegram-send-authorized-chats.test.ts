import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the app's own Telegram routes send, and to whom (the audit's lead #20).
 *
 * `send_telegram` from mcp-orchestrator, which every agent has, forwards a
 * model-chosen `chat_id` to POST /api/telegram/send, and the route sent to it:
 * a prompt-injected agent could have JeanBrasse's bot post to any chat that had
 * started it. mcp-telegram's own send refuses anything but the authorized
 * chats; the route now does the same. And every send read its default chat
 * from the settings as they were at startup, so a chat removed in Settings
 * kept receiving until the next launch: the routes read the live settings.
 *
 * The routes are the real ones; the bot is a recorder, the settings a getter.
 */

type Handler = (req: { body: Record<string, unknown> }, sendJson: (data: unknown, status?: number) => void) => Promise<void> | void;
const handlers = new Map<string, Handler>();
const sent: Array<{ kind: string; chatId: string }> = [];
const bot = {
  sendMessage: vi.fn(async (chatId: string) => { sent.push({ kind: 'message', chatId: String(chatId) }); }),
  sendPhoto: vi.fn(async (chatId: string) => { sent.push({ kind: 'photo', chatId: String(chatId) }); }),
  sendVideo: vi.fn(async (chatId: string) => { sent.push({ kind: 'video', chatId: String(chatId) }); }),
  sendDocument: vi.fn(async (chatId: string) => { sent.push({ kind: 'document', chatId: String(chatId) }); }),
};

import { registerTelegramRoutes } from '../../../electron/services/api-routes/telegram-routes';
import type { AppSettings } from '../../../electron/types';

const startup = { telegramChatId: '42', telegramAuthorizedChatIds: ['42'] } as AppSettings;
let live: AppSettings;

async function post(route: string, body: Record<string, unknown>) {
  let answer: { data: Record<string, unknown>; status: number } = { data: {}, status: 0 };
  await handlers.get(route)!({ body }, (data, status = 200) => { answer = { data: data as Record<string, unknown>, status }; });
  return answer;
}

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  live = { ...startup, telegramAuthorizedChatIds: [...startup.telegramAuthorizedChatIds!] };
  registerTelegramRoutes(
    { post: (route: string, handler: Handler) => handlers.set(route, handler), get: () => {} } as never,
    { appSettings: startup, getAppSettings: () => live, getTelegramBot: () => bot } as never,
  );
});

describe('POST /api/telegram/send', () => {
  it('refuses a chat that is not one JeanBrasse authorized, and sends nothing', async () => {
    const { status } = await post('/api/telegram/send', { message: 'the build log', chat_id: '999' });

    expect(status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('still sends to an authorized chat, named or by default', async () => {
    expect((await post('/api/telegram/send', { message: 'done', chat_id: '42' })).status).toBe(200);
    expect((await post('/api/telegram/send', { message: 'done' })).status).toBe(200);
    expect(sent).toEqual([{ kind: 'message', chatId: '42' }, { kind: 'message', chatId: '42' }]);
  });

  it('stops sending to a chat removed in Settings, without a restart', async () => {
    // app:saveSettings replaces main's object; the routes held the old one.
    live = { ...live, telegramChatId: '', telegramAuthorizedChatIds: [] };

    expect((await post('/api/telegram/send', { message: 'more output' })).status).toBeGreaterThanOrEqual(400);
    expect((await post('/api/telegram/send', { message: 'more output', chat_id: '42' })).status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe('the file sends', () => {
  it('go to the default chat the settings name now, not the one they named at startup', async () => {
    live = { ...live, telegramChatId: '77', telegramAuthorizedChatIds: ['77'] };
    const doc = path.join(os.homedir(), 'Documents', 'report.pdf');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, 'a report');

    const { status } = await post('/api/telegram/send-document', { document_path: doc });

    expect(status).toBe(200);
    expect(sent).toEqual([{ kind: 'document', chatId: '77' }]);
  });
});
