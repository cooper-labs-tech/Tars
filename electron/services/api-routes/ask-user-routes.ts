import { RouteApp, RouteContext } from './types';
import { askUser, startUserQuestions, MAX_QUESTION, MAX_CONTEXT } from '../user-questions';

/**
 * POST /api/user/ask, what the ask_user tool calls: an agent asks the user a
 * question on their Telegram, and their answer is typed into its terminal
 * (services/user-questions.ts).
 *
 * Asked by an agent, as itself: the shared token names nobody, and a question
 * from nobody would be answered into no terminal. From its terminal: a
 * delegated run's token names its agent too, but the run is one turn, over
 * ACP, with no terminal their answer could be typed into.
 */
export function registerAskUserRoutes(app: RouteApp, _ctx: RouteContext): void {
  startUserQuestions();
  app.post('/api/user/ask', async (req, sendJson) => {
    if (!req.callerAgentId) {
      sendJson({ error: 'Asking the user takes an agent\'s own token: the shared token names nobody their answer could go to.' }, 403);
      return;
    }
    if (!req.callerTerminal) {
      sendJson({ error: 'The user is asked from an agent\'s terminal session: a delegated run has no terminal their answer could be typed into.' }, 403);
      return;
    }
    const { question, context } = req.body as { question?: unknown; context?: unknown };
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION) {
      sendJson({ error: `question is required, 1 to ${MAX_QUESTION} characters.` }, 400);
      return;
    }
    if (context !== undefined && context !== null && (typeof context !== 'string' || context.length > MAX_CONTEXT)) {
      sendJson({ error: `context is text, at most ${MAX_CONTEXT} characters.` }, 400);
      return;
    }
    const result = await askUser({ agentId: req.callerAgentId, question, context: typeof context === 'string' ? context : undefined });
    if (result.ok) sendJson({ success: true, id: result.id, expiresAt: result.expiresAt });
    else sendJson({ error: result.error }, result.status);
  });
}
