import { ipcMain } from 'electron';
import { agents } from '../core/agent-manager';
import { getOverseerHistory } from '../services/overseer';
import { setBusDeliveredHook, setBusDroppedHook, setBusHeldHook } from '../services/agent-watch';
import {
  announceDelivered,
  announceDropped,
  announceHeld,
  announceSystem,
  broadcastPublication,
  closeAndAnnounce,
  fanOutDeliveries,
  releaseNotSent,
  sendNow,
} from '../services/bus-delivery';
import { forgetStaged, stagedFor, stageFiles } from '../services/bus-files';
import {
  appendMessage,
  closeThread,
  getRoomSnapshot,
  latestThreadOf,
  listRooms,
  loadBus,
  setGlobalHistoryReader,
  setMembers,
  GLOBAL_ROOM_ID,
} from '../services/bus-store';
import type { BusMessage } from '../types';

/**
 * The bus over IPC: the calls below and three pushes, exactly the contract.
 *
 * The renderer never polls: a message, a delivery or a thread change is pushed
 * on the channel of that name, the same way every other live update in the app
 * reaches the window. Nothing else is pushed, and there is no sixth call: a
 * room's deliveries come back with its snapshot.
 *
 * What a message does once published is not decided here. That lives in
 * bus-delivery, because an agent's room_post arrives over the API instead and
 * has to do exactly the same thing: two copies of the fan-out would be two
 * opinions about who got what, and a delivery row is the only thing the
 * interface may show as proof.
 */
export function registerBusHandlers(): void {
  loadBus();

  // A queued message that actually reached a terminal is the only thing that
  // turns a delivery into `delivered`, and the Chat page hears about it the
  // moment it happens rather than inferring it from silence.
  setBusDeliveredHook(announceDelivered);

  // And the other half: a message the queue gives up on stops saying queued.
  // The session it was held for is gone, and its messages belong to it.
  setBusDroppedHook((targetAgentId, messageId, cause) => {
    if (cause === 'terminal_exited') {
      announceDropped(targetAgentId, messageId, 'no_live_session',
        'its terminal exited before the draft in its field was sent or cleared, so it never went in');
      return;
    }
    announceDropped(targetAgentId, messageId, 'session_replaced',
      'the session this was queued for is gone, so it was not handed to the one that replaced it');
  });

  // Taken by the terminal but waiting behind somebody's draft: `held`, not
  // `queued`, because only that person can end this wait.
  setBusHeldHook(announceHeld);

  // The global room is the super chat, and stays where it already lives: read
  // from the overseer's own conversation, never copied into the bus journal.
  // Injected here rather than imported by the store, which would close a
  // require cycle the types cannot see.
  setGlobalHistoryReader(() => getOverseerHistory().map((m): BusMessage => ({
    id: m.id,
    roomId: GLOBAL_ROOM_ID,
    threadId: GLOBAL_ROOM_ID,
    authorKind: m.role === 'user' ? 'human' : 'agent',
    authorId: m.role === 'user' ? 'human' : 'overseer',
    authorName: m.role === 'user' ? 'User' : 'Overseer',
    text: m.text,
    mentions: [],
    createdAt: m.timestamp,
  })));

  ipcMain.handle('bus:listRooms', async () => {
    try {
      return { rooms: listRooms() };
    } catch (err) {
      console.error('[bus] listRooms failed:', err);
      return { rooms: [], error: err instanceof Error ? err.message : 'Failed to list rooms' };
    }
  });

  ipcMain.handle('bus:getRoom', async (_event, roomId: string, params?: { limit?: number; before?: string }) => {
    try {
      const snapshot = getRoomSnapshot(roomId, params);
      if (!snapshot) return { success: false, error: 'Room not found' };
      return { success: true, ...snapshot };
    } catch (err) {
      console.error('[bus] getRoom failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to read room' };
    }
  });

  ipcMain.handle('bus:postMessage', async (_event, params: { roomId: string; text: string; mentions?: string[]; attachments?: string[] }) => {
    try {
      const text = (params?.text ?? '').trim();

      const room = listRooms().find(r => r.id === params?.roomId);
      if (!room) return { success: false, error: 'Room not found' };
      if (room.kind === 'global') {
        // The super chat has its own send, with its own model and its own
        // rules. Posting there through the bus would be a second way in.
        return { success: false, error: 'The global room is the super chat: send through overseer:send.' };
      }
      // Files staged for this room, by id: one nobody staged refuses the
      // message rather than send it without the file it talks about.
      const files = stagedFor(room.id, params.attachments);
      if ('error' in files) return { success: false, error: files.error };
      if (!text && !files.attachments.length) return { success: false, error: 'A message needs text' };

      const { message, thread, supersededThreadId } = appendMessage({
        roomId: params.roomId,
        authorKind: 'human',
        authorId: 'human',
        authorName: 'User',
        text,
        mentions: params.mentions,
        attachments: files.attachments,
      });
      forgetStaged(files.attachments);

      const deliveries = fanOutDeliveries(message, room);
      broadcastPublication(message, thread, deliveries);
      // The anchor this replaced takes its queued deliveries with it: a reply
      // to a thread nobody is in any more is not worth waking an agent for.
      if (supersededThreadId) closeAndAnnounce(supersededThreadId, 'thread_replaced', 'a newer message replaced this thread');

      return { success: true, messageId: message.id, threadId: thread.id, deliveries };
    } catch (err) {
      console.error('[bus] postMessage failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to post' };
    }
  });

  // Files for a room: the bytes the composer has, written where every agent
  // can read them, and handed back by id for the message to come.
  ipcMain.handle('bus:stageFiles', async (_event, params: { roomId: string; files: unknown }) => {
    try {
      const room = listRooms().find(r => r.id === params?.roomId);
      if (!room) return { success: false, attachments: [], error: 'Room not found' };
      if (room.kind === 'global') {
        return { success: false, attachments: [], error: 'The global room is the super chat: attach through overseer:attachData.' };
      }
      const { attachments, errors } = stageFiles(room.id, params.files);
      // Partial success is the honest answer, as for Hermes's attachments.
      return {
        success: attachments.length > 0 || errors.length === 0,
        attachments,
        ...(errors.length ? { error: errors.join(' ') } : {}),
      };
    } catch (err) {
      console.error('[bus] stageFiles failed:', err);
      return { success: false, attachments: [], error: err instanceof Error ? err.message : 'Failed to stage files' };
    }
  });

  // Send now: interrupt a busy agent's turn, then type the message.
  ipcMain.handle('bus:sendNow', async (_event, params: { roomId: string; agentId: string; text: string; attachments?: string[] }) => {
    try {
      return await sendNow(params ?? {});
    } catch (err) {
      console.error('[bus] sendNow failed:', err);
      return { success: false, interrupted: false, error: err instanceof Error ? err.message : 'Failed to send' };
    }
  });

  ipcMain.handle('bus:stopThread', async (_event, threadId: string) => {
    try {
      const thread = closeThread(threadId, 'stopped');
      if (!thread) return { success: false, error: 'Thread not found' };
      // Stop is a barrier: what had not gone out does not go out.
      closeAndAnnounce(thread.id, 'thread_stopped', 'the thread was stopped');
      // And say so in the room, where the conversation is: a thread that ends
      // by a human decision should read as one, not as a transcript that just
      // stops.
      announceSystem(thread.roomId, thread.id, 'thread_stopped', 'You stopped this conversation.');
      return { success: true, thread };
    } catch (err) {
      console.error('[bus] stopThread failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to stop thread' };
    }
  });

  // The way out of `not_sent`. A human decision, aimed at an agent Tars cannot
  // read the state of, so it is theirs to make and theirs alone: nothing here
  // is triggered by time, by silence, or by anything the agent did.
  ipcMain.handle('bus:releaseNotSent', async (_event, agentId: string) => {
    try {
      if (!agents.has(agentId)) return { success: false, error: 'Agent not found' };
      const { released, reason } = await releaseNotSent(agentId);
      if (reason) return { success: false, error: reason, deliveries: [] };
      return { success: true, deliveries: released };
    } catch (err) {
      console.error('[bus] releaseNotSent failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to release' };
    }
  });

  ipcMain.handle('bus:setMembers', async (_event, roomId: string, memberIds: string[]) => {
    try {
      const before = listRooms().find(r => r.id === roomId)?.memberIds ?? [];
      const result = setMembers(roomId, Array.isArray(memberIds) ? memberIds : []);
      if (!result) return { success: false, error: 'Room not found' };
      // Changing the members closes the anchor in flight, and that close is a
      // thread change like any other: it goes out on bus:thread so the Chat
      // page never has to infer it from a room that looks different.
      const dropped = result.superseded
        ? closeAndAnnounce(result.superseded.id, 'members_changed', 'the room members changed')
        : 0;

      // Name who joined and who left, on the anchor it concerns. A room with
      // no thread yet has nothing to draw this into, so nothing is written.
      // The ids, their names as of now and the count dropped go with it as
      // data, so the page never parses the sentence.
      const nameOf = (id: string) => agents.get(id)?.name || id;
      const after = result.room.memberIds;
      const added = after.filter(id => !before.includes(id));
      const removed = before.filter(id => !after.includes(id));
      const anchor = result.superseded ?? latestThreadOf(roomId);
      if (anchor && (added.length || removed.length)) {
        const said = [
          added.length ? `added ${added.map(nameOf).join(', ')}` : '',
          removed.length ? `removed ${removed.map(nameOf).join(', ')}` : '',
        ].filter(Boolean).join(' and ');
        const names = Object.fromEntries([...added, ...removed].map(id => [id, nameOf(id)]));
        announceSystem(roomId, anchor.id, 'members_changed', `You ${said}.`, { added, removed, names, dropped });
      }
      return { success: true, room: result.room };
    } catch (err) {
      console.error('[bus] setMembers failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to set members' };
    }
  });
}
