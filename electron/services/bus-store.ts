import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BUS_FILE } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';
import { isSuperAgent } from '../utils';
import { agents } from '../core/agent-manager';
import { getProvider } from '../providers';
import type {
  AgentStatus,
  BusAttachment,
  BusDelivery,
  BusDeliveryReason,
  BusMember,
  BusMembersChanged,
  BusMessage,
  BusRoom,
  BusRoomPending,
  BusRoomSnapshot,
  BusSystemKind,
  BusThread,
} from '../types';

/**
 * The bus journal: rooms, threads, messages and deliveries, in one JSON file
 * under ~/.dorothy written as agents.json is (temp file, then rename).
 *
 * Rooms are derived, not stored: `global` for the orchestrators, and one per
 * project that has agents, its id `project:<path>` verbatim (Claude Code's
 * directory encoding is lossy, and two projects can collide in it). Only the
 * journal and the membership overrides are persisted. The global room is the
 * super chat, read from the overseer's own conversation through an injected
 * reader and never copied here: two stores for one conversation would drift.
 *
 * Nothing here delivers: a delivery row says what happened and no more, and
 * the queue is agent-watch.ts.
 */

const BUS_SCHEMA_VERSION = 1;

/** Bounds per anchor, from the contract: three rounds, ten agent messages. */
export const MAX_ROUNDS = 3;
export const MAX_AGENT_MESSAGES = 10;

/**
 * Silence is first class: an agent with nothing to add says one of these (the
 * list is Hermes's), which is never stored, shown, delivered or counted against
 * the bounds, so saying nothing spends none of a thread's budget.
 */
export const SILENCE_MARKERS = ['(pass)', '[SILENT]', 'SILENT', 'NO_REPLY', 'NO REPLY'];

export function isSilence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return SILENCE_MARKERS.some(marker => trimmed.toUpperCase() === marker.toUpperCase());
}

export const GLOBAL_ROOM_ID = 'global';
export const projectRoomId = (projectPath: string) => `project:${projectPath}`;

type BusFile = {
  version: number;
  savedAt: string;
  /** Members set by hand through bus:setMembers, per room. Absent means the
   *  room follows the fleet: orchestrators for global, the project's agents
   *  for a project room. */
  memberOverrides: Record<string, string[]>;
  threads: BusThread[];
  messages: BusMessage[];
  deliveries: BusDelivery[];
};

let state: BusFile = emptyFile();
let loaded = false;

/**
 * Where the global room's messages come from. Injected so this module stays a
 * leaf: importing the overseer makes a require cycle that fails at runtime.
 */
type GlobalHistoryReader = () => BusMessage[];
let readGlobalHistory: GlobalHistoryReader | undefined;

export function setGlobalHistoryReader(reader: GlobalHistoryReader | undefined): void {
  readGlobalHistory = reader;
}

function emptyFile(): BusFile {
  return {
    version: BUS_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    memberOverrides: {},
    threads: [],
    messages: [],
    deliveries: [],
  };
}

export function loadBus(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(BUS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(BUS_FILE, 'utf-8')) as Partial<BusFile>;
    state = {
      ...emptyFile(),
      ...parsed,
      memberOverrides: parsed.memberOverrides ?? {},
      threads: parsed.threads ?? [],
      messages: parsed.messages ?? [],
      deliveries: parsed.deliveries ?? [],
    };
  } catch (err) {
    // A journal that cannot be read is not a reason to refuse to start: the
    // app keeps working and the next write replaces it.
    console.error('[bus] could not read the journal, starting empty:', err);
    state = emptyFile();
  }
}

/**
 * The journal of the account this process runs as, whatever HOME says:
 * `os.userInfo()` ignores the environment where `os.homedir()` honours HOME,
 * which tells a test that redirected HOME from one that redirected nothing.
 */
function realAccountJournal(): string | undefined {
  try {
    return path.join(os.userInfo().homedir, '.dorothy', 'bus.json');
  } catch {
    return undefined;
  }
}

function inTestProcess(): boolean {
  return !!process.env.VITEST || process.env.NODE_ENV === 'test';
}

/**
 * The journal is written once per turn of the event loop, not once per row: a
 * message's fan-out rewrote the whole file 7 to 13 times (measured 2026-09-18
 * in a room of six on a month-sized journal, 628 KB: 11.4 ms a message; at
 * 6.3 MB, 83 to 160 ms on the main thread). One write a message: 1.7 and
 * 11.5 ms.
 *
 * Only the write is deferred, to the end of the current synchronous run:
 * `state` changes before each mutator returns, every reader reads memory, and
 * no timer, socket or IPC callback runs before a microtask. Quitting can, so
 * before-quit calls flushBus. The bytes, their atomicity and mode are the same.
 */
let writeQueued = false;

function scheduleSaveBus(): void {
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(() => {
    if (!writeQueued) return;
    writeQueued = false;
    writeBusNow();
  });
}

/** Put a deferred write on disk now, rather than at the end of the run that
 *  will not happen: app shutdown. Safe to call when nothing is pending. */
export function flushBus(): void {
  if (!writeQueued) return;
  writeQueued = false;
  writeBusNow();
}

function writeBusNow(): void {
  // Never write a journal that was never read.
  if (!loaded) return;

  // Nor from a test onto the account's own journal: loadBus sets `loaded` even
  // with no file, so the guard above alone let a test write the real one.
  if (inTestProcess() && BUS_FILE === realAccountJournal()) {
    console.warn('[bus] refusing to write the account journal from a test process: redirect BUS_FILE');
    return;
  }
  try {
    state.savedAt = new Date().toISOString();
    writeAtomicSync(BUS_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[bus] could not write the journal:', err);
  }
}

/* ── Rooms ─────────────────────────────────────────────────────────────── */

function memberIdsFor(roomId: string, kind: 'global' | 'project', projectPath?: string): string[] {
  const override = state.memberOverrides[roomId];
  if (override) return override.filter(id => agents.has(id));
  const all = Array.from(agents.values());
  if (kind === 'global') return all.filter(isSuperAgent).map(a => a.id);
  return all.filter(a => a.projectPath === projectPath).map(a => a.id);
}

export function listRooms(): BusRoom[] {
  loadBus();
  const createdAt = state.savedAt;
  const pendingByRoom = pendingCounts();
  const none = (): BusRoomPending => ({ queued: 0, held: 0, notSent: 0 });
  const rooms: BusRoom[] = [{
    id: GLOBAL_ROOM_ID,
    kind: 'global',
    title: 'All projects',
    memberIds: memberIdsFor(GLOBAL_ROOM_ID, 'global'),
    createdAt,
    pending: none(),
  }];

  const projectPaths = Array.from(new Set(
    Array.from(agents.values()).map(a => a.projectPath).filter((p): p is string => !!p),
  )).sort();

  for (const projectPath of projectPaths) {
    const id = projectRoomId(projectPath);
    // From the journal in memory, enough to sort the list and show a line. No
    // unread counts (they need a per-viewer marker this file does not keep); the
    // global room has neither, its history being the overseer's file.
    const last = [...state.messages].reverse().find(m => m.roomId === id);
    rooms.push({
      id,
      kind: 'project',
      projectPath,
      title: projectPath.split('/').filter(Boolean).pop() || projectPath,
      memberIds: memberIdsFor(id, 'project', projectPath),
      createdAt,
      lastMessageAt: last?.createdAt,
      lastMessagePreview: last ? `${last.authorName}: ${last.text.slice(0, 120)}` : undefined,
      pending: pendingByRoom.get(id) ?? none(),
    });
  }
  return rooms;
}

/**
 * What is still waiting in each room, by delivery state: one pass over the
 * journal already in memory, so the conversation list can show every room's
 * counts without a getRoom each. `delivered` and `dropped` are over.
 */
function pendingCounts(): Map<string, BusRoomPending> {
  const roomOf = new Map(state.messages.map(m => [m.id, m.roomId]));
  const counts = new Map<string, BusRoomPending>();
  for (const delivery of state.deliveries) {
    const key = delivery.state === 'queued' ? 'queued'
      : delivery.state === 'held' ? 'held'
        : delivery.state === 'not_sent' ? 'notSent'
          : undefined;
    const roomId = key && roomOf.get(delivery.messageId);
    if (!key || !roomId) continue;
    let count = counts.get(roomId);
    if (!count) { count = { queued: 0, held: 0, notSent: 0 }; counts.set(roomId, count); }
    count[key] += 1;
  }
  return counts;
}

export function getRoom(roomId: string): BusRoom | undefined {
  return listRooms().find(r => r.id === roomId);
}

/**
 * A machine line in a room: something Tars did, where the conversation is. Not
 * appendMessage, which opens anchors: a system line opens none, attaches to
 * the thread it is about (closed or not), and counts against no bound.
 */
export function appendSystemMessage(input: {
  roomId: string;
  threadId: string;
  systemKind: BusSystemKind;
  text: string;
  systemData?: BusMembersChanged;
}): BusMessage {
  loadBus();
  const message: BusMessage = {
    id: uuidv4(),
    roomId: input.roomId,
    threadId: input.threadId,
    authorKind: 'system',
    authorId: 'system',
    authorName: 'Tars',
    text: input.text,
    mentions: [],
    systemKind: input.systemKind,
    ...(input.systemData ? { systemData: input.systemData } : {}),
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  scheduleSaveBus();
  return message;
}

/**
 * The room's members as the page needs them, reachability read from each
 * provider's hook configuration as delivery reads it: a copy in the renderer
 * would go stale, silently, the day a provider gains hooks.
 */
function membersOf(room: BusRoom): BusMember[] {
  return room.memberIds.map(id => {
    const agent = agents.get(id);
    return {
      id,
      name: agent?.name || id,
      provider: agent?.provider,
      hasEndOfTurn: agent ? hasEndOfTurn(agent) : false,
      canInterrupt: agent ? canInterrupt(agent) : false,
    };
  });
}

export function getRoomSnapshot(roomId: string, opts?: { limit?: number; before?: string }): BusRoomSnapshot | undefined {
  const room = getRoom(roomId);
  if (!room) return undefined;

  // The global room is the super chat, read from where it already lives.
  if (room.kind === 'global') {
    const history = readGlobalHistory ? readGlobalHistory() : [];
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
    return { room, members: membersOf(room), threads: [], messages: history.slice(-limit), deliveries: [] };
  }

  let messages = state.messages.filter(m => m.roomId === roomId);
  if (opts?.before) {
    const cut = state.messages.find(m => m.id === opts.before)?.createdAt;
    if (cut) messages = messages.filter(m => m.createdAt < cut);
  }
  // Newest last, which is the order the Chat page renders in; the window is
  // taken from the end so a limit gives the most recent conversation.
  const limit = Math.max(1, Math.min(opts?.limit ?? 200, 1000));
  messages = messages.slice(-limit);

  const messageIds = new Set(messages.map(m => m.id));
  const threadIds = new Set(messages.map(m => m.threadId));
  return {
    room,
    members: membersOf(room),
    threads: state.threads.filter(t => threadIds.has(t.id)),
    messages,
    deliveries: state.deliveries.filter(d => messageIds.has(d.messageId)),
  };
}

/* ── Threads and messages ──────────────────────────────────────────────── */

export function openThread(roomId: string, anchorMessageId: string): BusThread {
  const thread: BusThread = {
    id: uuidv4(),
    roomId,
    anchorMessageId,
    state: 'open',
    round: 1,
    agentMessageCount: 0,
    openedAt: new Date().toISOString(),
  };
  state.threads.push(thread);
  return thread;
}

export function openThreadOf(roomId: string): BusThread | undefined {
  return [...state.threads].reverse().find(t => t.roomId === roomId && t.state === 'open');
}

export function getThread(threadId: string): BusThread | undefined {
  return state.threads.find(t => t.id === threadId);
}

/** The room's most recent anchor, open or not. What openThreadOf deliberately
 *  will not return, and what you need to tell "stopped" from "never was". */
export function latestThreadOf(roomId: string): BusThread | undefined {
  return [...state.threads].reverse().find(t => t.roomId === roomId);
}

export function messagesOfThread(threadId: string): BusMessage[] {
  return state.messages.filter(m => m.threadId === threadId);
}

export function closeThread(threadId: string, next: BusThread['state']): BusThread | undefined {
  const thread = getThread(threadId);
  if (!thread || thread.state !== 'open') return thread;
  thread.state = next;
  scheduleSaveBus();
  return thread;
}

/**
 * Who has spoken in the round in progress, read from the journal rather than
 * kept on the thread: a round ends when an agent already heard in it speaks
 * again, so everyone gets one turn before anyone gets a second.
 */
function currentRound(threadId: string): { round: number; heard: Set<string> } {
  let round = 1;
  let heard = new Set<string>();
  for (const message of messagesOfThread(threadId)) {
    if (message.authorKind !== 'agent') continue;
    if (heard.has(message.authorId)) {
      round += 1;
      heard = new Set<string>();
    }
    heard.add(message.authorId);
  }
  return { round, heard };
}

/**
 * Add a message to a room. A human one closes the anchor in flight and opens a
 * new one at round one; the turn already running finishes, since nothing here
 * cancels a turn.
 */
export function appendMessage(input: {
  roomId: string;
  authorKind: BusMessage['authorKind'];
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
  attachments?: BusAttachment[];
}): { message: BusMessage; thread: BusThread; supersededThreadId?: string } {
  loadBus();
  const now = new Date().toISOString();
  const messageId = uuidv4();

  let supersededThreadId: string | undefined;
  let thread = openThreadOf(input.roomId);
  if (input.authorKind === 'human') {
    if (thread) {
      thread.state = 'superseded';
      supersededThreadId = thread.id;
    }
    thread = openThread(input.roomId, messageId);
  } else if (!thread) {
    thread = openThread(input.roomId, messageId);
  }

  const message: BusMessage = {
    id: messageId,
    roomId: input.roomId,
    threadId: thread.id,
    authorKind: input.authorKind,
    authorId: input.authorId,
    authorName: input.authorName,
    text: input.text,
    mentions: input.mentions ?? [],
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    createdAt: now,
  };
  state.messages.push(message);

  if (input.authorKind === 'agent') {
    thread.agentMessageCount += 1;
    const { round } = currentRound(thread.id);
    thread.round = round;
    if (thread.agentMessageCount >= MAX_AGENT_MESSAGES || round > MAX_ROUNDS) {
      thread.state = 'bounded';
    }
  }

  scheduleSaveBus();
  return { message, thread, supersededThreadId };
}

export type PublishRefusal =
  | 'silence'
  | 'no_open_thread'
  | 'thread_stopped'
  | 'thread_bounded'
  | 'thread_superseded'
  | 'not_a_member'
  | 'self_reply'
  | 'not_your_turn';

/**
 * An agent publishes into a room, every bound applied here, server side, so an
 * agent that writes faster cannot get around them; the tool only calls this.
 * Refusals come back with a reason: a message that quietly never appears is a
 * failure this app has had once.
 */
export function publishAgentMessage(input: {
  roomId: string;
  agentId: string;
  text: string;
  mentions?: string[];
}): { published: true; message: BusMessage; thread: BusThread } | { published: false; reason: PublishRefusal; detail: string } {
  loadBus();

  if (isSilence(input.text)) {
    return { published: false, reason: 'silence', detail: 'Nothing to add: not published, and not counted against the thread.' };
  }

  const room = getRoom(input.roomId);
  if (!room) return { published: false, reason: 'no_open_thread', detail: 'That room does not exist.' };
  if (!room.memberIds.includes(input.agentId)) {
    return { published: false, reason: 'not_a_member', detail: 'Only the agents of this room can post in it.' };
  }

  // The latest anchor, open or not: asking for the open one made the refusals
  // below unreachable, and told an agent JeanBrasse had stopped that no thread existed.
  const thread = latestThreadOf(input.roomId);
  if (!thread) {
    return {
      published: false,
      reason: 'no_open_thread',
      detail: 'No thread is open here. A thread opens on a human message, not on an agent one.',
    };
  }
  if (thread.state === 'stopped') return { published: false, reason: 'thread_stopped', detail: 'This thread was stopped.' };
  if (thread.state === 'bounded') {
    return { published: false, reason: 'thread_bounded', detail: 'This thread reached its bounds. Only a human message reopens it.' };
  }
  if (thread.state === 'superseded') {
    return { published: false, reason: 'thread_superseded', detail: 'A newer message replaced this thread.' };
  }

  const priors = messagesOfThread(thread.id);
  const last = priors[priors.length - 1];
  if (last && last.authorKind === 'agent' && last.authorId === input.agentId) {
    return { published: false, reason: 'self_reply', detail: 'No replying to your own message.' };
  }

  const { round, heard } = currentRound(thread.id);
  if (round > 1 || heard.size > 0) {
    // A turn after the first is earned by being named since you last spoke. This
    // is also what ends a round (currentRound advances when a heard agent speaks
    // again): refusing that message kept the round at one for ever, and a thread
    // never reached `bounded`.
    const mineAt = priors.map(m => m.authorId).lastIndexOf(input.agentId);
    const since = priors.slice(mineAt + 1);
    const namedSince = since.some(m => m.authorId !== input.agentId && m.mentions.includes(input.agentId));
    if (!namedSince) {
      return {
        published: false,
        reason: 'not_your_turn',
        detail: heard.has(input.agentId)
          ? 'You have spoken in this round. Another agent has to name you before you speak again.'
          : 'After the first round, only an agent another one mentioned speaks.',
      };
    }
  }

  const agent = agents.get(input.agentId);
  const { message, thread: updated } = appendMessage({
    roomId: input.roomId,
    authorKind: 'agent',
    authorId: input.agentId,
    authorName: agent?.name || input.agentId,
    text: input.text,
    mentions: input.mentions,
  });
  return { published: true, message, thread: updated };
}

/* ── Deliveries ────────────────────────────────────────────────────────── */

/**
 * Whether the provider reports an end of turn. amp, codex, grok, opencode and
 * pi have no native hooks: their status changes only on exit, and a queue
 * waiting for them to rest would never drain. Read from the provider's hook
 * configuration, so a provider that gains hooks stops being an exception then.
 */
export function hasEndOfTurn(agent: AgentStatus): boolean {
  try {
    return getProvider(agent.provider).getHookConfig().supportsNativeHooks;
  } catch {
    return false;
  }
}

/**
 * Whether Tars can interrupt this agent's turn: a claude-binary CLI, where Esc
 * stops a turn and the transcript records it (`[Request interrupted by user]`),
 * which is how bus:sendNow knows it took. Elsewhere an Esc would be a guess.
 */
export function canInterrupt(agent: AgentStatus): boolean {
  try {
    return getProvider(agent.provider).binaryName === 'claude' && hasEndOfTurn(agent);
  } catch {
    return false;
  }
}

export function recordDelivery(delivery: BusDelivery): BusDelivery {
  state.deliveries.push(delivery);
  scheduleSaveBus();
  return delivery;
}

export function deliveriesOf(messageId: string): BusDelivery[] {
  return state.deliveries.filter(d => d.messageId === messageId);
}

export function getMessage(messageId: string): BusMessage | undefined {
  return state.messages.find(m => m.id === messageId);
}

/** What is being held for an agent, oldest first: the order a human releasing
 *  a queue expects to see it arrive in. */
export function notSentFor(targetAgentId: string): BusDelivery[] {
  loadBus();
  return state.deliveries
    .filter(d => d.targetAgentId === targetAgentId && d.state === 'not_sent')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** A message reached a terminal: the only place a delivery becomes `delivered`,
 *  from `queued`, `held`, or `not_sent` (a held message released by hand). */
export function markDelivered(targetAgentId: string, messageId: string): BusDelivery | undefined {
  const delivery = state.deliveries.find(
    d => d.messageId === messageId && d.targetAgentId === targetAgentId
      && (d.state === 'queued' || d.state === 'held' || d.state === 'not_sent'),
  );
  if (!delivery) return undefined;
  delivery.state = 'delivered';
  delivery.deliveredAt = new Date().toISOString();
  // A released message keeps no trace of why it was held: a row cannot say
  // delivered and undeliverable at once.
  delivery.reasonCode = undefined;
  delivery.reason = undefined;
  delivery.refusedAt = undefined;
  delivery.heldAt = undefined;
  scheduleSaveBus();
  return delivery;
}

/**
 * A message its terminal took that waits behind somebody's draft (Tars never
 * types across one): from `queued`, or `not_sent` released by hand, which takes
 * it off the not-sent list so a second press sends nothing twice. It turns
 * `delivered` when it goes in, or `dropped` if the terminal exits first.
 */
export function markHeld(targetAgentId: string, messageId: string): BusDelivery | undefined {
  const delivery = state.deliveries.find(
    d => d.messageId === messageId && d.targetAgentId === targetAgentId
      && (d.state === 'queued' || d.state === 'not_sent'),
  );
  if (!delivery) return undefined;
  delivery.state = 'held';
  delivery.reasonCode = 'draft';
  delivery.reason = 'somebody has something typed in that terminal\'s field: it goes in once that is sent or cleared';
  delivery.heldAt = new Date().toISOString();
  delivery.refusedAt = undefined;
  scheduleSaveBus();
  return delivery;
}

/** Drop every delivery still queued for a thread, with its reason (what Stop
 *  means for messages not yet out). A `held` one is left: its terminal has it,
 *  and types it once the field is free. */
export function cancelQueuedDeliveries(
  threadId: string,
  reasonCode: BusDeliveryReason,
  reason: string,
): BusDelivery[] {
  const ids = new Set(messagesOfThread(threadId).map(m => m.id));
  const cancelled: BusDelivery[] = [];
  const now = new Date().toISOString();
  for (const delivery of state.deliveries) {
    if (delivery.state !== 'queued' || !ids.has(delivery.messageId)) continue;
    delivery.state = 'dropped';
    delivery.reasonCode = reasonCode;
    delivery.reason = reason;
    delivery.refusedAt = now;
    cancelled.push(delivery);
  }
  if (cancelled.length) scheduleSaveBus();
  return cancelled;
}

/** One queued delivery will never leave (its session is gone), and says so: a
 *  row reading `queued` for ever is what the contract rules out. */
export function markDropped(
  targetAgentId: string,
  messageId: string,
  reasonCode: BusDeliveryReason,
  reason: string,
): BusDelivery | undefined {
  const delivery = state.deliveries.find(
    d => d.messageId === messageId && d.targetAgentId === targetAgentId
      && (d.state === 'queued' || d.state === 'held'),
  );
  if (!delivery) return undefined;
  delivery.state = 'dropped';
  delivery.reasonCode = reasonCode;
  delivery.reason = reason;
  delivery.refusedAt = new Date().toISOString();
  scheduleSaveBus();
  return delivery;
}

export function setMembers(
  roomId: string,
  memberIds: string[],
): { room: BusRoom; superseded?: BusThread } | undefined {
  loadBus();
  const room = getRoom(roomId);
  if (!room) return undefined;
  state.memberOverrides[roomId] = Array.from(new Set(memberIds));
  // A membership change closes the anchor in flight rather than editing a live
  // thread (the journal stays replayable), and hands it back to be pushed.
  const open = openThreadOf(roomId);
  if (open) open.state = 'superseded';
  scheduleSaveBus();
  const updated = getRoom(roomId);
  return updated ? { room: updated, superseded: open } : undefined;
}

/** Test seam: the journal is process state, and a test that drives several
 *  fleets through one module needs it empty between runs. */
export function resetBusStore(): void {
  state = emptyFile();
  loaded = false;
  readGlobalHistory = undefined;
}
