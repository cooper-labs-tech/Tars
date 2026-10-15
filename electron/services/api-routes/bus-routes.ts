import { agents } from '../../core/agent-manager';
import { RouteApp, RouteRequest, SendJson } from './types';
import { callerId as resolveCallerId } from './utils';
import {
  getRoomSnapshot,
  listRooms,
  projectRoomId,
  publishAgentMessage,
} from '../bus-store';
import { broadcastPublication, fanOutDeliveries } from '../bus-delivery';

/**
 * The bus for agents, over the local API.
 *
 * The Chat page reaches the bus over IPC; an agent reaches it through its MCP
 * server, which speaks HTTP to this server with a bearer token and its own
 * identity headers. Both end in the same store, and every bound lives there:
 * an agent that writes faster cannot get around the three rounds, the ten
 * messages, the silence markers or the rotation, because this route applies
 * none of them itself and refuses whatever the store refuses.
 *
 * Authenticated like everything else under /api: the two exempt routes are
 * /api/local-file and /api/health, and this is not one of them. It was four
 * until /api/kanban/complete was removed, unauthenticated and uncalled, and
 * three until the hooks took the agent's own token: a comment that still says
 * more is how someone reopens that hole believing it was already open.
 */

/**
 * The agent behind this call: the one whose token it presents, minted when
 * that agent's process was started.
 *
 * Refused when there is none, and refused here, before any room is looked at.
 * That order is what keeps the shared token out of every room: it has no agent
 * behind it, so it never reaches resolveRoom, and in particular never the
 * global room, which is JeanBrasse's conversation with the super chat. A name in a
 * header does not count, since any agent can read the shared token and write
 * any name beside it.
 *
 * A call that presents a token and claims to be somebody else never reaches
 * here either: resolveCaller refuses it at the door.
 */
function callingAgent(req: RouteRequest, sendJson: SendJson): { id: string; projectPath: string } | undefined {
  const callerId = resolveCallerId(req);
  if (!callerId) {
    sendJson({
      error: 'This call has no agent identity, so it cannot be placed in a room. '
        + 'An agent is known by the token Tars gives its process when it starts it, not by a name: '
        + 'restart the agent from Tars.',
    }, 403);
    return undefined;
  }
  const agent = agents.get(callerId);
  if (!agent) {
    sendJson({ error: 'The calling agent is not one Tars knows about.' }, 404);
    return undefined;
  }
  return { id: agent.id, projectPath: agent.projectPath };
}

/**
 * Which room this call is about: the one asked for, or the caller's own
 * project room. An agent may only speak in a room of its own project, which is
 * the same scoping the delegation routes apply.
 */
function resolveRoom(
  caller: { id: string; projectPath: string },
  asked: string | undefined,
  sendJson: SendJson,
): string | undefined {
  const roomId = asked && asked.trim() ? asked.trim() : projectRoomId(caller.projectPath);
  const room = listRooms().find(r => r.id === roomId);
  if (!room) {
    sendJson({ error: `No room "${roomId}". Rooms are the global one and one per project.` }, 404);
    return undefined;
  }
  if (room.kind === 'project' && room.projectPath !== caller.projectPath) {
    sendJson({
      error: `That room belongs to ${room.projectPath}, and you are an agent of ${caller.projectPath}.`,
    }, 403);
    return undefined;
  }
  if (room.kind === 'global') {
    // Not a room of the bus at all. Its snapshot is not a bus journal: the
    // handlers wire it to getOverseerHistory(), which is JeanBrasse's own
    // conversation with the super chat. An agent has no business reading it
    // and cannot post to it, so neither door opens.
    sendJson({ error: 'The global room is the super chat, and is not open to agents.' }, 403);
    return undefined;
  }
  return room.id;
}

export function registerBusRoutes(app: RouteApp): void {
  // POST /api/bus/post: an agent publishes into its room.
  app.post('/api/bus/post', async (req, sendJson) => {
    const caller = callingAgent(req, sendJson);
    if (!caller) return;

    const { room: asked, text, mentions } = req.body as {
      room?: string;
      text?: string;
      mentions?: string[];
    };
    if (!text || !text.trim()) {
      sendJson({ error: 'text is required' }, 400);
      return;
    }

    const roomId = resolveRoom(caller, asked, sendJson);
    if (!roomId) return;

    const result = publishAgentMessage({
      roomId,
      agentId: caller.id,
      text,
      mentions: Array.isArray(mentions) ? mentions : undefined,
    });

    if (!result.published) {
      // Refused out loud, with the reason, rather than dropped into a queue
      // that would never move: a message that quietly never appears is the
      // silent failure this app has already had once.
      sendJson({ success: false, refused: result.reason, message: result.detail }, 200);
      return;
    }

    const roomNow = listRooms().find(r => r.id === roomId)!;
    const deliveries = fanOutDeliveries(result.message, roomNow);
    broadcastPublication(result.message, result.thread, deliveries);

    sendJson({
      success: true,
      messageId: result.message.id,
      threadId: result.thread.id,
      threadState: result.thread.state,
      round: result.thread.round,
      agentMessageCount: result.thread.agentMessageCount,
      deliveries,
    });
  });

  // GET /api/bus/read: catch up on the thread before answering.
  app.get('/api/bus/read', async (req, sendJson) => {
    const caller = callingAgent(req, sendJson);
    if (!caller) return;

    // The same resolver as the write door, rather than a second copy of its
    // rules. The copy that used to live here asked only whether a *project*
    // room belonged to the caller, so `global`, which is not a project room,
    // fell through every check: any agent could read JeanBrasse's private
    // conversation with the super chat, up to a thousand messages, under its
    // own legitimate identity. Two copies of one rule is how one of them
    // drifts; there is one now.
    const roomId = resolveRoom(caller, req.url.searchParams.get('room') ?? undefined, sendJson);
    if (!roomId) return;

    const limitParam = Number(req.url.searchParams.get('limit'));
    const snapshot = getRoomSnapshot(roomId, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50,
    });
    if (!snapshot) {
      sendJson({ error: 'Room not found' }, 404);
      return;
    }
    sendJson({ success: true, ...snapshot });
  });
}
