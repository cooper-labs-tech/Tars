import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { ownerWords } from '../owner-words';
import { twoZones } from '../../utils/two-zones';
import { performDispatch } from './agent-routes';
import type { AgentStatus } from '../../types';

/**
 * The owner's words, relayed under Tars's mark (2.0.6, option e; services/owner-words.ts, SECURITY.md §8).
 *
 * GET /api/owner-words, what owner_words calls: the owner's words addressed to the caller's project, for an agent
 * with an orchestrator's powers there.
 * POST /api/owner-words/:id/relay { to }, what relay_owner_words calls: Tars types its record of those words into
 * `to`, an orchestrator of any project, under the sender line only it writes. The caller names the words by id and
 * nothing else: it never hands Tars a text.
 *
 * Asked by an agent, as itself: the shared token names nobody, and whether the words are the caller's to relay is
 * read from who it is.
 */
function callerOf(req: RouteRequest, sendJson: SendJson): AgentStatus | undefined {
  const caller = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!caller) {
    sendJson({ error: "The owner's words are read and relayed by an agent, with its own token: the shared token names nobody.", code: 'owner_words_need_identity' }, 403);
  }
  return caller;
}

const party = (agent: AgentStatus) => ({ id: agent.id, projectPath: agent.projectPath, orchestrator: hasOrchestratorPowers(agent) });

export function registerOwnerWordsRoutes(app: RouteApp, ctx: RouteContext): void {
  app.get('/api/owner-words', (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    if (!hasOrchestratorPowers(caller) || !caller.projectPath) {
      sendJson({ error: "Only an orchestrator of the project the owner wrote to reads the owner's words.", code: 'owner_words_not_yours' }, 403);
      return;
    }
    sendJson({
      words: ownerWords.listFor(caller.projectPath).map((w) => ({
        id: w.id, at: new Date(w.at).toISOString(), when: twoZones(w.at), via: w.via, text: w.text,
      })),
    });
  });

  app.post(/^\/api\/owner-words\/([^/]+)\/relay$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const { to } = (req.body ?? {}) as { to?: unknown };
    const target = typeof to === 'string' ? agents.get(to) : undefined;
    if (!target) {
      sendJson({ error: 'to names no agent of the fleet.', code: 'owner_words_no_receiver' }, 404);
      return;
    }
    const relay = ownerWords.relay(req.params.id, { by: party(caller), to: party(target) });
    if (!('ok' in relay)) {
      sendJson({ error: relay.error, code: relay.code }, relay.status);
      return;
    }
    const { words } = relay;
    await performDispatch(target, {
      message: words.text, from: 'Tars',
      sender: { kind: 'owner-relay', wordsId: words.id, at: words.at, via: words.via, by: { id: caller.id, name: caller.name } },
      // Information, as Tars's own word: it waits for the receiver's rest, and is no task of the caller's.
      information: true,
    }, ctx, (data, status) => {
      if (status && status >= 300) {
        ownerWords.undelivered(words.id, target.id);
        sendJson(data, status);
        return;
      }
      sendJson({ ...(data as object), relayed: true, wordsId: words.id, to: { id: target.id, name: target.name } });
    });
  });
}
