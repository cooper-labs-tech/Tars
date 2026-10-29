import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { chatNameOf, leadOf } from '../../core/chat-inbox';
import { ownerWords, relayedBody, type OwnerWords, type OwnerWordsParty } from '../owner-words';
import { twoZones } from '../../utils/two-zones';
import { performDispatch } from './agent-routes';
import type { AgentStatus } from '../../types';

/**
 * The owner's words, relayed under Tars's mark (2.0.6, option e; services/owner-words.ts, SECURITY.md §8).
 *
 * GET /api/owner-words, what owner_words calls: the owner's words the caller could have received (the project's
 * orchestrator: its project's; a chat's runner: its chat's, or every chat's of the project when the chats read each
 * other), and the words relayed to the caller, which it can check a mark's id against.
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

function partyOf(agent: AgentStatus, ctx: RouteContext): OwnerWordsParty {
  return {
    id: agent.id, name: agent.name, projectPath: agent.projectPath, orchestrator: hasOrchestratorPowers(agent),
    projectOrchestrator: !!agent.projectPath && leadOf(agent.projectPath, agents.values())?.id === agent.id,
    chatId: chatNameOf(agent)?.id, readsAllChats: ctx.getAppSettings().chatsReadEachOther === true,
  };
}

const shown = (w: OwnerWords) => ({
  id: w.id, at: new Date(w.at).toISOString(), when: twoZones(w.at), via: w.via, ...(w.about ? { about: w.about } : {}), text: relayedBody(w),
});

export function registerOwnerWordsRoutes(app: RouteApp, ctx: RouteContext): void {
  app.get('/api/owner-words', (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    if (!hasOrchestratorPowers(caller) || !caller.projectPath) {
      sendJson({ error: "Only an orchestrator, or a chat's runner, reads the owner's words.", code: 'owner_words_not_yours' }, 403);
      return;
    }
    sendJson({
      words: ownerWords.listFor(partyOf(caller, ctx)).map(shown),
      relayedToYou: ownerWords.relayedTo(caller.id).map((w) => ({ ...shown(w), by: w.by, relayedAt: new Date(w.relayedAt).toISOString() })),
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
    const relay = ownerWords.relay(req.params.id, { by: partyOf(caller, ctx), to: partyOf(target, ctx) });
    if (!('ok' in relay)) {
      sendJson({ error: relay.error, code: relay.code }, relay.status);
      return;
    }
    const { words } = relay;
    await performDispatch(target, {
      message: relayedBody(words), from: 'Tars',
      sender: {
        kind: 'owner-relay', wordsId: words.id, at: words.at, via: words.via, by: { id: caller.id, name: caller.name },
        ...(words.about ? { about: words.about } : {}),
      },
      // Information, as Tars's own word: it waits for the receiver's rest, and is no task of the caller's.
      information: true,
      // Held, then given up (its terminal ended with it held): the receiver is freed (the Audit's I10 on #569).
      onDropped: () => ownerWords.undelivered(words.id, target.id),
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
