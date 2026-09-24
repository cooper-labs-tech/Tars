import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';
import { ptyProcesses } from '../core/pty-manager';
import { dialogShown } from '../core/agent-launch';
import { lastInterruptAt } from './agent-truth';
import { deliverBusMessages, queueBusMessage, releaseBusMessagesNow, type QueuedBusMessage } from './agent-watch';
import { forgetStaged, stagedFor, withAttachmentPaths } from './bus-files';
import {
  appendMessage,
  appendSystemMessage,
  canInterrupt,
  cancelQueuedDeliveries,
  deliveriesOf,
  getMessage,
  getThread,
  hasEndOfTurn,
  listRooms,
  markDelivered,
  markDropped,
  markHeld,
  notSentFor,
  recordDelivery,
} from './bus-store';
import type { BusDelivery, BusDeliveryReason, BusMembersChanged, BusMessage, BusRoom, BusSystemKind, BusThread } from '../types';

/**
 * What happens to a message once it has been published: one implementation for
 * both doors (the Chat page over IPC, an agent's room_post over the API), since
 * two fan-outs would disagree about who got what, and a delivery row is the
 * only proof the interface may show.
 */

/** A message as a target's queue holds it: its text, then the files it sends
 *  named by their absolute paths, since an agent cannot read a file it is
 *  only told about. */
function queuedOf(message: BusMessage): QueuedBusMessage {
  return {
    messageId: message.id,
    roomId: message.roomId,
    threadId: message.threadId,
    authorKind: message.authorKind,
    authorName: message.authorName,
    text: withAttachmentPaths(message.text, message.attachments),
  };
}

/** Who a message is for: the agents it names, or every member of the room when
 *  it names nobody. Never its own author. */
export function targetsOf(message: BusMessage, room: BusRoom): string[] {
  const named = message.mentions.length > 0 ? message.mentions : room.memberIds;
  return named.filter(id => id !== message.authorId);
}

/**
 * Queue a published message for each target, and record what happened. A
 * reachable target goes into Tars's one queue, `delivered` only once the
 * message reaches its terminal; one that cannot be reached (amp, codex, grok,
 * opencode and pi never leave `running`) is recorded `not_sent` with its reason
 * and waits for a human. Silence is never read as an end of turn.
 */
export function fanOutDeliveries(message: BusMessage, room: BusRoom): BusDelivery[] {
  const deliveries: BusDelivery[] = [];
  for (const targetAgentId of targetsOf(message, room)) {
    const target = agents.get(targetAgentId);
    if (!target) continue;
    const reachable = hasEndOfTurn(target);
    const queued = reachable && queueBusMessage(targetAgentId, queuedOf(message));
    deliveries.push(recordDelivery({
      messageId: message.id,
      targetAgentId,
      state: queued ? 'queued' : 'not_sent',
      reasonCode: queued ? undefined : reachable ? 'no_live_session' : 'no_end_of_turn',
      reason: queued
        ? undefined
        : reachable
          ? 'no live session to deliver into yet'
          : `${target.provider ?? 'this provider'} stays running until its process exits, so nothing can be delivered to it at rest`,
      queuedAt: new Date().toISOString(),
      refusedAt: queued ? undefined : new Date().toISOString(),
    }));
    // Only now, with the row in the journal. Handing the message over is what
    // marks the row delivered, so an agent at rest, which takes it at once,
    // has to have a row to mark.
    if (queued) deliverBusMessages(targetAgentId);
  }
  return deliveries;
}

/**
 * A machine line, written into the room and pushed like any other message:
 * both doors need it, and the page renders it in place.
 */
export function announceSystem(
  roomId: string,
  threadId: string,
  systemKind: BusSystemKind,
  text: string,
  systemData?: BusMembersChanged,
): BusMessage {
  const message = appendSystemMessage({ roomId, threadId, systemKind, text, systemData });
  broadcastToAllWindows('bus:message', message);
  return message;
}

/** Push a message, its thread, and its deliveries to every window. */
export function broadcastPublication(message: BusMessage, thread: BusThread, deliveries: BusDelivery[]): void {
  broadcastToAllWindows('bus:message', message);
  broadcastToAllWindows('bus:thread', thread);
  for (const delivery of deliveries) broadcastToAllWindows('bus:delivery', delivery);
}

/**
 * Send what was never sent, because a human said to. `not_sent` has no way out
 * on its own (no end of turn, so no safe moment, and the queue will not guess
 * one), so a person's decision is its door: the held messages go in, oldest
 * first, into a session whose state Tars does not know.
 */
export async function releaseNotSent(agentId: string): Promise<{ released: BusDelivery[]; reason?: string }> {
  const held = notSentFor(agentId);
  if (!held.length) return { released: [] };

  const queued: QueuedBusMessage[] = [];
  for (const delivery of held) {
    const message = getMessage(delivery.messageId);
    if (!message) continue;
    queued.push(queuedOf(message));
  }
  if (!queued.length) return { released: [] };

  // Each one is recorded the moment it is written rather than all of them at
  // the end. The held list was read before the first write, and the writes take
  // hundreds of milliseconds each: anything that reads the journal in between
  // should see what has already gone out, not the state this call started from.
  const released: BusDelivery[] = [];
  const { written, held: waiting, refused } = await releaseBusMessagesNow(agentId, queued, messageId => {
    const delivery = markDelivered(agentId, messageId);
    if (!delivery) return;
    released.push(delivery);
    broadcastToAllWindows('bus:delivery', delivery);
  });

  if (refused === 'already_releasing') {
    return { released: [], reason: 'These messages are already being sent. Wait for that to finish.' };
  }
  if (refused === 'no_terminal') {
    return { released: [], reason: 'That agent has no live terminal to write into.' };
  }
  // Taken, but not in yet: somebody is typing in that terminal, or has left
  // something in it that Tars cannot put back. Saying "no terminal" here, or
  // saying nothing, is the wrong answer to a person who just pressed send and
  // is owed one.
  if (!written.length && waiting?.length) {
    const target = agents.get(agentId);
    const dialog = !!target && dialogShown(target, target.ptyId ? ptyProcesses.get(target.ptyId) : undefined);
    return {
      released: [],
      reason: `${waiting.length} message${waiting.length > 1 ? 's are' : ' is'} waiting for that terminal: `
        + (dialog
          ? 'its CLI shows a dialog (a permission or a question). They go in once it is answered or refused.'
          : 'somebody is typing in it. They go in as soon as that field is free.'),
    };
  }
  if (!written.length) {
    return { released: [], reason: 'That agent has no live terminal to write into.' };
  }

  // Said in the room, on the anchor the last one belongs to: a human action
  // that writes into a terminal should leave a trace where the conversation is.
  const last = queued.find(q => q.messageId === written[written.length - 1]);
  if (last) {
    const name = agents.get(agentId)?.name || agentId;
    announceSystem(last.roomId, last.threadId, 'queue_released',
      `You sent ${written.length} held message${written.length > 1 ? 's' : ''} to ${name}.`);
  }
  return { released };
}

/**
 * An anchor closed (Stop, a newer human message, a member change): drop what
 * had not gone out, and say so. A reply nobody waits for is not worth waking an
 * agent for.
 */
export function closeAndAnnounce(threadId: string, reasonCode: BusDeliveryReason, reason: string): number {
  const dropped = cancelQueuedDeliveries(threadId, reasonCode, reason);
  for (const delivery of dropped) broadcastToAllWindows('bus:delivery', delivery);
  const thread = getThread(threadId);
  if (thread) broadcastToAllWindows('bus:thread', thread);
  return dropped.length;
}

/**
 * A queued message reached a terminal, as agent-watch reports the moment it
 * writes it: the only thing that makes a delivery `delivered`, and the Chat
 * page hears it at once.
 */
export function announceDelivered(targetAgentId: string, messageId: string): void {
  const delivered = markDelivered(targetAgentId, messageId);
  if (delivered) broadcastToAllWindows('bus:delivery', delivered);
}

/**
 * The queue could not keep what it held (agent-watch drops a recipient's queue
 * when its session is gone): the row stops saying `queued` and says why, and
 * the Chat page hears it.
 */
export function announceDropped(targetAgentId: string, messageId: string, reasonCode: BusDeliveryReason, reason: string): void {
  const dropped = markDropped(targetAgentId, messageId, reasonCode, reason);
  if (dropped) broadcastToAllWindows('bus:delivery', dropped);
}

/**
 * A message its terminal took waits for a person's draft (agent-watch hears it
 * from the terminal): the row says `held`, the draft its reason, since this
 * wait ends only when that person sends or clears their field.
 */
export function announceHeld(targetAgentId: string, messageId: string): void {
  const held = markHeld(targetAgentId, messageId);
  if (held) broadcastToAllWindows('bus:delivery', held);
}

/** How long send now waits for the interrupt to show in the transcript. */
export const INTERRUPT_CONFIRM_MS = 5_000;
/** An interrupt recorded this long before the Esc is still counted as its own:
 *  the two clocks are the same machine's, so this only absorbs rounding. */
const INTERRUPT_SLACK_MS = 100;

export interface SendNowResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  interrupted: boolean;
  deliveries?: BusDelivery[];
  error?: string;
}

/**
 * Send to one agent now, interrupting its turn if it is in one (#124, JeanBrasse's
 * choice B: messages queue by default, and this is the button that
 * interrupts). Recorded as a human message to that agent, like postMessage.
 * An agent at rest, or one Tars cannot interrupt, gets it as any message. A
 * busy interruptible one gets an Esc, and the message is typed once its
 * transcript records the interrupt (Claude Code sends no Stop for one, and a
 * message typed into a running turn is a queued steer, not "now"), through the
 * same writer, so a draft still holds it (`held`). No interrupt on record
 * within INTERRUPT_CONFIRM_MS leaves it queued for the turn's end, and the
 * answer says so; an Esc that took later ends the turn with no Stop, and the
 * message waits for the next rest Tars hears of (a minute on at the latest).
 */
export async function sendNow(params: {
  roomId?: unknown; agentId?: unknown; text?: unknown; attachments?: unknown;
}): Promise<SendNowResult> {
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  const room = listRooms().find(r => r.id === params.roomId);
  if (!room) return { success: false, interrupted: false, error: 'Room not found' };
  if (room.kind === 'global') {
    return { success: false, interrupted: false, error: 'The global room is the super chat: send through overseer:send.' };
  }
  const agentId = typeof params.agentId === 'string' ? params.agentId : '';
  const agent = agents.get(agentId);
  if (!agent || !room.memberIds.includes(agentId)) {
    return { success: false, interrupted: false, error: 'That agent is not a member of this room.' };
  }
  const files = stagedFor(room.id, params.attachments);
  if ('error' in files) return { success: false, interrupted: false, error: files.error };
  if (!text && !files.attachments.length) return { success: false, interrupted: false, error: 'A message needs text' };

  const { message, thread, supersededThreadId } = appendMessage({
    roomId: room.id, authorKind: 'human', authorId: 'human', authorName: 'JeanBrasse',
    text, mentions: [agentId], attachments: files.attachments,
  });
  forgetStaged(files.attachments);
  const closeSuperseded = () => {
    if (supersededThreadId) closeAndAnnounce(supersededThreadId, 'thread_replaced', 'a newer message replaced this thread');
  };

  const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  // Never an Esc into a dialog, whatever the status says: there it means No
  // (it rejected the tool use, in #174's proof), and the status can still read
  // running for a moment after the dialog is drawn. The message then goes as
  // any other, and the writer holds it until the dialog is gone.
  if (agent.status !== 'running' || !canInterrupt(agent) || !ptyProcess || dialogShown(agent, ptyProcess)) {
    const deliveries = fanOutDeliveries(message, room);
    broadcastPublication(message, thread, deliveries);
    closeSuperseded();
    return { success: true, messageId: message.id, threadId: thread.id, interrupted: false, deliveries };
  }

  const row = recordDelivery({ messageId: message.id, targetAgentId: agentId, state: 'queued', queuedAt: new Date().toISOString() });
  broadcastPublication(message, thread, [row]);
  closeSuperseded();

  const escAt = Date.now();
  try {
    ptyProcess.write('\x1b');
  } catch (err) {
    console.warn('[bus] send now could not write the interrupt:', err);
  }
  const interrupted = await interruptOnRecord(agent, escAt - INTERRUPT_SLACK_MS);
  const queued = queuedOf(message);

  if (interrupted) {
    const { refused } = await releaseBusMessagesNow(agentId, [queued], messageId => announceDelivered(agentId, messageId));
    if (!refused) {
      announceSystem(room.id, thread.id, 'turn_interrupted', `You interrupted ${agent.name || agentId}'s turn.`);
      return { success: true, messageId: message.id, threadId: thread.id, interrupted: true, deliveries: deliveriesOf(message.id) };
    }
  }
  // Not confirmed, or the terminal would not take it now: it waits for the
  // turn's end like any other message, and the row says queued.
  if (queueBusMessage(agentId, queued)) deliverBusMessages(agentId);
  else announceDropped(agentId, message.id, 'no_live_session', 'the agent already has as many messages waiting as it can hold');
  return { success: true, messageId: message.id, threadId: thread.id, interrupted: false, deliveries: deliveriesOf(message.id) };
}

/** Whether the transcript records an interrupt at or after `since`, within the bound. */
async function interruptOnRecord(agent: Parameters<typeof lastInterruptAt>[0], since: number): Promise<boolean> {
  const deadline = Date.now() + INTERRUPT_CONFIRM_MS;
  for (;;) {
    const at = lastInterruptAt(agent);
    if (at !== undefined && at >= since) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
