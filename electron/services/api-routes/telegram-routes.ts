import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { isSafeTelegramPath } from './utils';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { isSuperAgent } from '../../utils';
import { redactSecrets } from '../../utils/redact-secrets';
import { relaySend } from '../hermes-relay';

/**
 * With the relay on (services/hermes-relay.ts), send_telegram is the one way left to write to the user, and goes
 * through their Hermes: from a project's orchestrator only (JeanBrasse's rule of 2026-10-01), under its project, so that
 * the user's reply reaches it, with its secrets masked and in plain text. The chat it names is not read: the relay
 * writes to one person. A file goes nowhere: the relay carries text.
 */
async function sendThroughRelay(req: RouteRequest, sendJson: SendJson, message: string): Promise<void> {
  const caller = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!caller || !isSuperAgent(caller)) {
    sendJson({ error: 'Only a project\'s orchestrator writes to the user. Tell your orchestrator: it decides what reaches them.' }, 403);
    return;
  }
  const text = `${caller.name || caller.id}:\n${redactSecrets(message)}`;
  const result = await relaySend({ text, kind: 'report', ref: `message:${randomUUID()}`, projectPath: caller.projectPath });
  if (result.state === 'sent') sendJson({ success: true });
  else if (result.state === 'queued') sendJson({ success: true, queued: true, note: result.reason }, 202);
  else sendJson({ error: result.reason }, 503);
}

const relayOn = (ctx: RouteContext) => ctx.getAppSettings().hermesRelayEnabled === true;
const textOnly = (sendJson: SendJson) =>
  sendJson({ error: 'The relay to the user\'s Telegram through Hermes carries text only: no photo, video or document goes out.' }, 410);

/**
 * The chats a send may go to: the ones JeanBrasse authorized, as the settings say
 * now. Read live, never from the snapshot the server was started with: a chat
 * removed in Settings kept receiving until the next launch (the audit's lead
 * #20). The same set mcp-telegram's own send accepts.
 */
function authorizedChats(ctx: RouteContext): Set<string> {
  const settings = ctx.getAppSettings();
  return new Set([settings.telegramChatId, ...(settings.telegramAuthorizedChatIds ?? [])].filter(Boolean).map(String));
}

/** Where a send goes when its caller names no chat. */
function defaultChat(ctx: RouteContext): string | undefined {
  const settings = ctx.getAppSettings();
  return settings.telegramChatId || settings.telegramAuthorizedChatIds?.[0];
}

export function registerTelegramRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/telegram/send
  app.post('/api/telegram/send', async (req, sendJson) => {
    const { message, chat_id } = req.body as { message: string; chat_id?: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    if (relayOn(ctx)) {
      await sendThroughRelay(req, sendJson, message);
      return;
    }

    const telegramBot = ctx.getTelegramBot();
    const targetChatId = chat_id ? String(chat_id) : defaultChat(ctx);
    if (!telegramBot || !targetChatId) {
      sendJson({ error: 'Telegram not configured or no chat ID. Set a default chat in Settings > Telegram.' }, 400);
      return;
    }
    // Only a chat JeanBrasse authorized. The chat_id comes from a model (send_telegram
    // in every agent), and a prompt-injected one could name any chat that had
    // started the bot.
    if (!authorizedChats(ctx).has(targetChatId)) {
      sendJson({ error: 'That chat is not one of the chats authorized in Settings > Telegram.' }, 403);
      return;
    }

    try {
      await telegramBot.sendMessage(targetChatId, `\u{1F451} ${message}`, { parse_mode: 'Markdown' });
      sendJson({ success: true });
    } catch {
      try {
        await telegramBot.sendMessage(targetChatId, `\u{1F451} ${message}`);
        sendJson({ success: true });
      } catch (err2) {
        sendJson({ error: `Failed to send: ${err2}` }, 500);
      }
    }
  });

  // POST /api/telegram/send-photo
  app.post('/api/telegram/send-photo', async (req, sendJson) => {
    if (relayOn(ctx)) {
      textOnly(sendJson);
      return;
    }
    const { photo_path, caption } = req.body as { photo_path: string; caption?: string };
    if (!photo_path) {
      sendJson({ error: 'photo_path is required' }, 400);
      return;
    }
    if (!isSafeTelegramPath(photo_path)) {
      sendJson({ error: 'Access denied: path not allowed' }, 403);
      return;
    }

    const telegramBot = ctx.getTelegramBot();
    const targetChatId = defaultChat(ctx);
    if (!telegramBot || !targetChatId) {
      sendJson({ error: 'Telegram not configured or no chat ID' }, 400);
      return;
    }

    try {
      if (!fs.existsSync(photo_path)) {
        sendJson({ error: `File not found: ${photo_path}` }, 400);
        return;
      }

      await telegramBot.sendPhoto(
        targetChatId,
        photo_path,
        { caption: caption ? `\u{1F451} ${caption}` : undefined, parse_mode: 'Markdown' }
      );
      sendJson({ success: true });
    } catch (err) {
      sendJson({ error: `Failed to send photo: ${err}` }, 500);
    }
  });

  // POST /api/telegram/send-video
  app.post('/api/telegram/send-video', async (req, sendJson) => {
    if (relayOn(ctx)) {
      textOnly(sendJson);
      return;
    }
    const { video_path, caption } = req.body as { video_path: string; caption?: string };
    if (!video_path) {
      sendJson({ error: 'video_path is required' }, 400);
      return;
    }
    if (!isSafeTelegramPath(video_path)) {
      sendJson({ error: 'Access denied: path not allowed' }, 403);
      return;
    }

    const telegramBot = ctx.getTelegramBot();
    const targetChatId = defaultChat(ctx);
    if (!telegramBot || !targetChatId) {
      sendJson({ error: 'Telegram not configured or no chat ID' }, 400);
      return;
    }

    try {
      if (!fs.existsSync(video_path)) {
        sendJson({ error: `File not found: ${video_path}` }, 400);
        return;
      }

      await telegramBot.sendVideo(
        targetChatId,
        video_path,
        { caption: caption ? `\u{1F451} ${caption}` : undefined, parse_mode: 'Markdown' }
      );
      sendJson({ success: true });
    } catch (err) {
      sendJson({ error: `Failed to send video: ${err}` }, 500);
    }
  });

  // POST /api/telegram/send-document
  app.post('/api/telegram/send-document', async (req, sendJson) => {
    if (relayOn(ctx)) {
      textOnly(sendJson);
      return;
    }
    const { document_path, caption } = req.body as { document_path: string; caption?: string };
    if (!document_path) {
      sendJson({ error: 'document_path is required' }, 400);
      return;
    }
    if (!isSafeTelegramPath(document_path)) {
      sendJson({ error: 'Access denied: path not allowed' }, 403);
      return;
    }

    const telegramBot = ctx.getTelegramBot();
    const targetChatId = defaultChat(ctx);
    if (!telegramBot || !targetChatId) {
      sendJson({ error: 'Telegram not configured or no chat ID' }, 400);
      return;
    }

    try {
      if (!fs.existsSync(document_path)) {
        sendJson({ error: `File not found: ${document_path}` }, 400);
        return;
      }

      await telegramBot.sendDocument(
        targetChatId,
        document_path,
        { caption: caption ? `\u{1F451} ${caption}` : undefined, parse_mode: 'Markdown' }
      );
      sendJson({ success: true });
    } catch (err) {
      sendJson({ error: `Failed to send document: ${err}` }, 500);
    }
  });
}
