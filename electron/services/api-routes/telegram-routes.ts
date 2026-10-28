import { randomUUID } from 'crypto';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { redactSecrets } from '../../utils/redact-secrets';
import { relaySend } from '../hermes-relay';
import { chatTag } from '../chat-addressing';
import { namedChatRunBy } from '../chat-runners';

/**
 * send_telegram (mcp-orchestrator) posts here, and the user's Telegram is reached through their Hermes only: Tars's
 * own bot is gone since 2.0.5 (JeanBrasse's decision of 2026-10-01, "pas de secours"; services/telegram-retired.ts).
 * From a project's orchestrator only (JeanBrasse's rule of 2026-10-01), or a chat's runner, which has its powers
 * (core/agent-role.ts), under its project, so that the user's reply reaches it, with its secrets masked and in plain
 * text. The chat it names is not read: the relay writes to one person. With the relay off, nothing goes out, and the
 * answer says where to turn it on. The relay carries text: no photo, video or document has a route.
 */
async function sendThroughRelay(req: RouteRequest, sendJson: SendJson, message: string): Promise<void> {
  const caller = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!caller || !hasOrchestratorPowers(caller)) {
    sendJson({ error: 'Only a project\'s orchestrator writes to the user. Tell your orchestrator: it decides what reaches them.' }, 403);
    return;
  }
  // Headed by the chat it comes from, so the user sees which, and a reply to
  // it goes back there (PR F); an agent that runs no chat, by its name.
  const chat = namedChatRunBy(caller);
  const text = `${chat ? chatTag(chat) : `${caller.name || caller.id}:`}\n${redactSecrets(message)}`;
  const result = await relaySend({ text, kind: 'report', ref: `message:${randomUUID()}`, projectPath: caller.projectPath, chatId: chat?.id });
  if (result.state === 'sent') sendJson({ success: true });
  else if (result.state === 'queued') sendJson({ success: true, queued: true, note: result.reason }, 202);
  else sendJson({ error: result.reason }, 503);
}

/** What send_telegram answers with the relay off: the one way to Telegram, and where to turn it on. */
export const TELEGRAM_THROUGH_HERMES = 'Telegram goes through Hermes: turn on Telegram through Hermes in Settings, Hermes, Connection.';

export function registerTelegramRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/telegram/send
  app.post('/api/telegram/send', async (req, sendJson) => {
    const { message } = req.body as { message: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    if (ctx.getAppSettings().hermesRelayEnabled !== true) {
      sendJson({ error: 'telegram_through_hermes', reason: TELEGRAM_THROUGH_HERMES }, 409);
      return;
    }
    await sendThroughRelay(req, sendJson, message);
  });
}
