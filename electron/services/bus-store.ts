import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BUS_FILE } from '../constants';
import { writeAtomicSync } from '../utils/secret-file';
import { isSuperAgent } from '../utils';
import { chatNameOf, namedChatOf } from '../core/chat-inbox';
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
 * The bus journal: rooms, threads, messages and deliveries.
 *
 * One JSON file under ~/.dorothy, written the way agents.json is (temp file
 * then rename, through the shared writeAtomicSync). No new service, no
 * database, no network: a room is a view over the fleet Tars already has, and
 * only the journal and the membership overrides are persisted.
 *
 * Rooms are derived rather than stored. There is one `global` room, whose
 * members are the orchestrators, and one room per project that has agents,
 * whose members are that project's agents. A room keeps its `projectPath`, so
 * its id is `project:<path>` verbatim: Claude Code's directory encoding
 * (slashes and dots to dashes) is lossy and two projects can collide in it,
 * and an id that cannot be read back is not worth the shortening.
 *
 * The global room is today's super chat and stays it: its messages are read
 * from the overseer's own conversation through an injected reader, never
 * copied into this journal. Two stores for one conversation would drift, and
 * the overseer's behaviour does not change in v1.
 *
 * What this file does NOT do is deliver. Recording that a message is `queued`
 * is not writing it into a session: the queue is agent-watch.ts, generalised
 * separately, and a delivery row says exactly what has happened and no more.
 */

const BUS_SCHEMA_VERSION = 1;

/** Bounds per anchor, from the contract: three rounds, ten agent messages. */
export const MAX_ROUNDS = 3;
export const MAX_AGENT_MESSAGES = 10;

/**
 * Silence is first class.
 *
 * An agent with nothing to add says so in one of these, and that is not a
 * message: it is never stored, never shown, never delivered and never counted
 * against the bounds. Recognised at publication so an agent cannot spend a
 * thread's budget saying nothing. The list is Hermes's, which is where the
 * mechanism is from.
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
 * Where the global room's messages come from.
 *
 * Injected rather than imported, so this module stays a leaf: the overseer
 * service imports the fleet and the journal would then import it back, which
 * is a require cycle that types cannot see and that fails at runtime.
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
 * The journal of the account this process runs as, whatever HOME says.
 *
 * `os.userInfo()` reads the password database and ignores the environment,
 * while `os.homedir()` honours HOME. That difference is the whole point: a
 * test that redirects HOME to a temp directory is redirected, and a test that
 * redirects nothing is not, and only the second one is dangerous.
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
 * The journal is written once per turn of the event loop, not once per row.
 *
 * Every mutator in this file wrote the whole journal, and the delivery fan-out
 * calls two of them once per target: one append, one delivery row per member,
 * one more when each row is marked delivered. Measured on 2026-09-18 through
 * bus:postMessage itself, in a room of six, on a journal the size of a month
 * of the super chat (343 messages, 2058 delivery rows, 628 KB): 13 rewrites of
 * the whole file for the first message and 7 to 8 for each one after it, 11.4
 * ms a message. At ten times that journal (6.3 MB), 83 ms a message and 160 at
 * worst, all of it on the main thread, and 615 MB rewritten over 12 messages.
 * One write a message instead: 1.7 ms and 11.5 ms.
 *
 * So the write, and only the write, is deferred to the end of the current
 * synchronous run. `state` still changes before the mutator returns, so
 * nothing that reads the journal can see a stale one - every reader here reads
 * memory - and no timer, socket or IPC callback runs between a mutation and
 * its write, because a microtask runs before any of them. What can happen in
 * between is the app being told to quit, which is why flushBus exists and why
 * before-quit calls it.
 *
 * Nothing about the journal's shape, its atomicity or its mode changes, and
 * nothing is purged: the same bytes, written a seventh to a thirteenth as often.
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

  // And that guard alone does not hold, which was worth finding out before the
  // QA wrote against it: loadBus sets `loaded` even when there is no file, so
  // any test that actually exercises a path flips it and the next write lands
  // on the real journal. This is the one that holds. A test may write a journal
  // it redirected; it may not write the one belonging to the account.
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
  // A chat's runner is a conversation, not a member of its project's room
  // (ORCHESTRATOR-PER-CHAT.md, 4.6): what crosses the room reaches Main.
  return all.filter(a => a.projectPath === projectPath && a.kind !== 'chat').map(a => a.id);
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
    // Enough for the conversation list to sort itself and show a line, read
    // from the journal already in memory. Unread counts are not here: they
    // need a per-viewer read marker, which is state this file does not keep.
    // The global room has neither, because its history lives in the overseer's
    // own conversation and reading it on every room listing would put a file
    // read on a path that runs on every publication.
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
 * A machine line in a room: something Tars did, written where the conversation
 * is so the page can draw it in place.
 *
 * Its own entry point rather than appendMessage, whose job is anchors: a human
 * message opens one, and an agent message that finds none open would open one
 * too. A system line must do neither. It attaches to the thread it is about,
 * including a closed one, and counts against no bound.
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
 * The room's members as the page needs them, reachability included.
 *
 * hasEndOfTurn is read from the provider's hook configuration here, the same
 * read the delivery path makes, so the renderer stops keeping its own copy of
 * which five CLIs cannot be reached. A copy of a derived value goes stale the
 * day a provider gains hooks, and it would go stale silently.
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
 * Who has already spoken in the round now in progress.
 *
 * Derived from the journal rather than stored on the thread: the contract
 * fixes what a thread carries, and a round is a reading of the messages, not
 * another field to keep in step with them. A round ends when an agent that has
 * already spoken in it speaks again, which is the rotation: everyone gets one
 * turn before anyone gets a second.
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
 * Add a human message to a room.
 *
 * A human message closes the anchor in flight and opens a new one, which is
 * the contract's rule: the turn already running finishes, and the discussion
 * starts again at round one from what JeanBrasse just said. Nothing here cancels a
 * turn.
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
 * An agent publishes into a room, with every bound applied here.
 *
 * Server side on purpose: an agent that writes faster must not be able to get
 * around the bounds, so the tool is a caller of this and never a second
 * implementation of it. Refusals are returned with a reason rather than
 * swallowed, because a message that quietly never appears is the silent
 * failure this app has already had once.
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
  // A chat's runner is no member (what crosses the room reaches Main), but the
  // chat speaks there, as itself, in its own project's room (4.6, PR F).
  const poster = agents.get(input.agentId);
  const runsAChatHere = !!poster && room.kind === 'project' && poster.projectPath === room.projectPath && !!chatNameOf(poster);
  if (!room.memberIds.includes(input.agentId) && !runsAChatHere) {
    return { published: false, reason: 'not_a_member', detail: 'Only the agents of this room can post in it.' };
  }

  // The latest anchor, open or not. Asking for the open one made the three
  // refusals below unreachable: a thread that had just been stopped by hand
  // answered `no_open_thread`, so an agent JeanBrasse had deliberately silenced was
  // told no conversation had ever existed. Every other refusal here is true;
  // that one lied, and the page renders these reasons to a human.
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
    // A turn after the first is earned by being named, and named *since you
    // last spoke*: a mention from before your own message is one you have
    // already answered.
    //
    // This is also the only thing that ends a round. currentRound advances
    // when an agent that has already been heard speaks again, so refusing
    // that message, which is what this guard used to do, left the round
    // stuck at one forever: MAX_ROUNDS was unreachable, and in a room of
    // fewer than ten agents a thread never reached `bounded` at all. It
    // simply refused everyone, with no state the interface could show.
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
  // An agent that runs a chat speaks in the room as that chat (PR F), once its
  // project has several: JeanBrasse's answer to it goes back to it by its id. With
  // only Main, the orchestrator posts under its own name, as in 1.9.7.
  const chat = agent ? namedChatOf(agent) : undefined;
  const { message, thread: updated } = appendMessage({
    roomId: input.roomId,
    authorKind: 'agent',
    authorId: input.agentId,
    authorName: chat
      ? `the orchestrator of ${path.basename(chat.projectPath) || chat.projectPath}, chat #${chat.number} "${chat.title}"`
      : agent?.name || input.agentId,
    text: input.text,
    mentions: input.mentions,
  });
  return { published: true, message, thread: updated };
}

/* ── Deliveries ────────────────────────────────────────────────────────── */

/**
 * Providers whose interactive session never leaves `running`.
 *
 * amp, codex, grok, opencode and pi have no native hooks, so their status only
 * changes when the process exits: a queue that waits for them to be at rest
 * would never drain. Read from the provider's own hook configuration rather
 * than a list written out here, so a provider that gains hooks stops being an
 * exception on the day it gains them, not on the day someone remembers.
 */
export function hasEndOfTurn(agent: AgentStatus): boolean {
  try {
    return getProvider(agent.provider).getHookConfig().supportsNativeHooks;
  } catch {
    return false;
  }
}

/**
 * Whether Tars can interrupt this agent's turn: a CLI on the claude binary,
 * where Esc stops a running turn and the transcript records it
 * (`[Request interrupted by user]`), which is how bus:sendNow knows it took.
 * The other CLIs record no such thing Tars reads, so an Esc sent to one would
 * be a guess.
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

/** The deliveries still waiting for their agent: queued for a turn's end, or held behind a draft. */
export function waitingDeliveries(): BusDelivery[] {
  return state.deliveries.filter(d => d.state === 'queued' || d.state === 'held').map(d => ({ ...d }));
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

/** A message actually reached a terminal. The only place a delivery becomes
 *  `delivered`, so the interface can never show that on a guess.
 *
 *  `not_sent` is accepted as well as `queued`: a held message released by hand
 *  reaches the terminal the same way, and it would be a poor answer to write
 *  it in and go on calling it not sent. */
export function markDelivered(targetAgentId: string, messageId: string): BusDelivery | undefined {
  const delivery = state.deliveries.find(
    d => d.messageId === messageId && d.targetAgentId === targetAgentId
      && (d.state === 'queued' || d.state === 'held' || d.state === 'not_sent'),
  );
  if (!delivery) return undefined;
  delivery.state = 'delivered';
  delivery.deliveredAt = new Date().toISOString();
  // A released message keeps no trace of why it was once held: a row that says
  // delivered and, beside it, that this provider can never be delivered to, is
  // a row that contradicts itself on screen.
  delivery.reasonCode = undefined;
  delivery.reason = undefined;
  delivery.refusedAt = undefined;
  delivery.heldAt = undefined;
  scheduleSaveBus();
  return delivery;
}

/**
 * A message its target's terminal took, but that waits behind what somebody
 * has typed in that field: Tars never types across a draft. From `queued`, or
 * from `not_sent` when a person released it by hand into such a field, which
 * also takes it off the not-sent list so a second press sends nothing twice.
 * It turns `delivered` when it goes in, or `dropped` if the terminal exits
 * first; only the person at that keyboard ends the wait.
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

/** Mark every delivery still queued for a thread as dropped, with its reason:
 *  what Stop means for messages that had not gone out yet. A `held` one is
 *  left alone: its terminal has already taken it and will type it once the
 *  field is free, so calling it dropped would be the lie in the other
 *  direction. */
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

/**
 * One queued delivery will never leave, and says so.
 *
 * The queue drops what it is holding when the session it was held for is gone.
 * Without this the row would read `queued` for ever, which is the state the
 * contract exists to make impossible: a message that is not moving has to look
 * like a message that is not moving.
 */
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
  // Changing who is in the room closes the anchor in flight rather than
  // editing a live thread: that is what keeps the journal replayable. The
  // closed thread is handed back so the caller can push it, because a member
  // change that silently ended a thread would be exactly the invisible state
  // the contract asks the interface to show.
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
