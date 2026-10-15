import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in of Telegram's Bot API on the loopback, as node-telegram-bot-api speaks to it: getMe, a long-polled
 * getUpdates, sendMessage. Tars's bot is pointed at it with DOROTHY_TELEGRAM_API_URL (read under DOROTHY_E2E only).
 * Shared by the E2E specs that drive Tars's own Telegram bot.
 */

export const OWNER_ID = 555;
export const BOT_TOKEN = '123456:E2E-STAND-IN';

/** Telegram's Bot API, as node-telegram-bot-api speaks to it: getMe, a long-polled getUpdates, sendMessage. */
export async function startFakeTelegram() {
  let nextUpdate = 1;
  let nextIncoming = 100;
  let nextSent = 900;
  const updates: Array<{ update_id: number; message: Record<string, unknown> }> = [];
  const sent: Array<{ chat_id: string; text: string; message_id: number }> = [];
  const ok = (res: http.ServerResponse, result: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const [, bot, method] = url.pathname.split('/');
      if (bot !== `bot${BOT_TOKEN}`) { res.writeHead(401); res.end('{"ok":false}'); return; }
      let body: Record<string, string> = {};
      try { body = String(req.headers['content-type']).includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)); } catch { /* none */ }
      if (method === 'getMe') return ok(res, { id: 1, is_bot: true, first_name: 'Tars', username: 'tars_e2e_bot' });
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        for (let i = 0; i < 10 && !updates.some((u) => u.update_id >= offset); i += 1) await new Promise((r) => setTimeout(r, 100));
        return ok(res, updates.filter((u) => u.update_id >= offset));
      }
      if (method === 'sendMessage') {
        const message_id = nextSent++;
        sent.push({ chat_id: String(body.chat_id), text: String(body.text), message_id });
        return ok(res, { message_id, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: String(body.text) });
      }
      return ok(res, true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sent,
    /** JeanBrasse writes in his private chat with the bot, replying to one of its messages or not. */
    write(text: string, replyTo?: number) {
      const chat = { id: OWNER_ID, type: 'private' };
      updates.push({
        update_id: nextUpdate++,
        message: {
          message_id: nextIncoming++, date: Math.floor(Date.now() / 1000), chat, from: { id: OWNER_ID, is_bot: false, first_name: 'JeanBrasse' }, text,
          ...(replyTo ? { reply_to_message: { message_id: replyTo, date: Math.floor(Date.now() / 1000), chat, text: '...' } } : {}),
        },
      });
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

