import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName, transcriptRoots } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { joinSessions, transcriptItems, type ChatItem } from './chat-transcript';
import { isSessionId, type Chat, sessionFoldersToRead } from './chats';
import type { AgentStatus } from '../types';

/**
 * A chat's conversation for the window (ORCHESTRATOR-PER-CHAT.md v2.2, 4.5):
 * `chat:history` reads it from its runner's transcripts, across the chat's
 * sessions, and `chat:events` follows it afterwards, "snapshot at N, then
 * events after N".
 *
 * - **seq** is one counter, in memory, reset per app run: `chat:history`
 *   answers the seq it is a snapshot at, and every event carries the next. A
 *   window that misses one (a gap, a reload) asks again from its last seq.
 *   The transcripts and chats.json are the durable state.
 * - **Items are numbered** by their place in the chat (`n`), the same in an
 *   answer and in an event, so the window can tell what it already shows.
 * - **Followed live**, once a window has asked for its history, while the
 *   runner's CLI holds a terminal and the new interface is on: each second
 *   its files are looked at again, only what they gained is read
 *   (readTranscript), and the items the windows were not told of since their
 *   first snapshot (noteChatSnapshot) are sent as `item` events.
 */

export type NumberedItem = ChatItem & { n: number };

export type ChatEvent =
  | { type: 'item'; chatId: string; item: NumberedItem }
  | { type: 'meta'; chatId: string; chat: unknown }
  | { type: 'deleted'; chatId: string }
  /** Items the window was told of that are no longer in the chat: a session's transcript disappeared (Claude Code's cleanup, a delete). */
  | { type: 'removed'; chatId: string; itemIds: string[] }
  | { type: 'state'; chatId: string; runner: { id: string; status: AgentStatus['status']; live: boolean } | null };

let seq = 0;

export function chatSeq(): number {
  return seq;
}

/** Sent to every window, with the next seq. */
export function publishChatEvent(event: ChatEvent): number {
  seq += 1;
  broadcastToAllWindows('chat:events', { seq, ...event });
  return seq;
}

/** The Claude Code folders a chat's transcripts can be in: the default one, and each account's (`~/.claude-accounts/<id>`). */
function configDirs(homeDir: string): string[] {
  const dirs = [path.join(homeDir, '.claude')];
  const accounts = path.join(homeDir, '.claude-accounts');
  try {
    for (const name of fs.readdirSync(accounts)) dirs.push(path.join(accounts, name));
  } catch { /* no other account */ }
  return dirs;
}

/** A session's transcript, where its CLI ran: the project, or the runner's worktree, under any spelling and any account. */
function sessionFile(sessionId: string, cwds: Array<string | undefined>, homeDir: string): string | null {
  for (const dir of configDirs(homeDir)) {
    for (const root of transcriptRoots(...cwds)) {
      const file = path.join(dir, 'projects', encodeProjectDirName(root), `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/**
 * The chat's sessions in order: its record's, then its runner's own when the
 * mirror has not caught up. The runner's come from agents.json, which an agent
 * can write: an id that is not one never reaches a path (the gate of #371, L1).
 */
function sessionsOf(chat: Chat, runner: AgentStatus | undefined): string[] {
  const ids = [...chat.sessionIds];
  for (const id of [runner?.resumableSessionId, runner?.currentSessionId]) {
    if (isSessionId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** How much a read takes at once before it lets the main thread run. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * What is known of one transcript file: how far it was read (to the end of
 * its last whole line), how many lines that was, and their items. A file that
 * grows is read from there on; one that shrank or was replaced (another
 * inode), from its start.
 */
interface FileState { ino: number; offset: number; lines: number; items: ChatItem[] }
const files = new Map<string, FileState>();
const reading = new Map<string, Promise<ChatItem[] | null>>();

/** What a read did, for the bench and the tests: bytes read, and how many slices. */
export interface ReadStats { bytes: number; slices: number }

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A transcript's items, reading only what it gained since the last read; null
 * when the file does not exist.
 *
 * The follower used to read every file of a live chat whole and parse it again,
 * synchronously, every second it changed: 4.7 s of the main thread per second
 * for a 159 MB transcript (the gate of #371, B1). Now a tick costs what was
 * appended, and a first read (a 100 MB history) goes by slices of a megabyte,
 * read asynchronously, with the main thread free between them. A line still
 * being written waits for its end; one read call at a time per file.
 */
export function readTranscript(file: string, sessionId: string, opts: { nameOf?: (agentId: string) => string | undefined; chunkBytes?: number; stats?: ReadStats } = {}): Promise<ChatItem[] | null> {
  const running = reading.get(file);
  if (running) return running;
  const read = readGained(file, sessionId, opts).finally(() => reading.delete(file));
  reading.set(file, read);
  return read;
}

async function readGained(file: string, sessionId: string, opts: { nameOf?: (agentId: string) => string | undefined; chunkBytes?: number; stats?: ReadStats }): Promise<ChatItem[] | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    files.delete(file);
    return null;
  }
  let state = files.get(file);
  if (!state || state.ino !== st.ino || st.size < state.offset) {
    state = { ino: st.ino, offset: 0, lines: 0, items: [] };
    files.set(file, state);
  }
  if (st.size === state.offset) return state.items;
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return state.items;
  }
  try {
    // Bytes read but not yet a whole line: a line longer than a chunk, or one being written.
    let pending = Buffer.alloc(0);
    let position = state.offset;
    while (position < st.size) {
      const buffer = Buffer.alloc(Math.min(chunk, st.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (opts.stats) { opts.stats.bytes += bytesRead; opts.stats.slices += 1; }
      pending = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      // A newline byte is never inside a character of several bytes: the text up to the last one is whole.
      const end = pending.lastIndexOf(0x0a);
      if (end === -1) continue;
      const text = pending.toString('utf8', 0, end + 1);
      for (const item of transcriptItems(text, sessionId, { nameOf: opts.nameOf, firstLine: state.lines })) state.items.push(item);
      state.lines += countLines(text);
      state.offset += end + 1;
      pending = pending.subarray(end + 1);
      if (position < st.size) await yieldToLoop();
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return state.items;
}

function countLines(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1;
  return count;
}

/** The numbered items last made for each chat, and what they were made from. */
const numbered = new Map<string, { key: string; items: NumberedItem[] }>();

/**
 * A chat's items across its sessions, numbered. Each transcript is read by
 * what it gained (readTranscript). A session whose file does not exist yet is
 * empty while it may still be written (the chat's newest, or the runner's
 * own): Claude Code creates the file lazily (the gate of #371, M1).
 */
export async function readChatItems(chat: Chat, deps: {
  runner?: AgentStatus;
  nameOf?: (agentId: string) => string | undefined;
  homeDir?: string;
}): Promise<NumberedItem[]> {
  const homeDir = deps.homeDir ?? os.homedir();
  const ids = sessionsOf(chat, deps.runner);
  const live = new Set([ids[ids.length - 1], deps.runner?.currentSessionId, deps.runner?.resumableSessionId]);
  const sessions: Array<{ sessionId: string; items: ChatItem[] | null; mayBeWritten: boolean }> = [];
  const key: string[] = [];
  for (const sessionId of ids) {
    // Where it ran first, as recorded when it was taken: a former runner's worktree (GATE-PR371-DELTA5).
    const file = sessionFile(sessionId, [...sessionFoldersToRead(chat, sessionId), deps.runner?.worktreePath, chat.projectPath], homeDir);
    const items = file ? await readTranscript(file, sessionId, { nameOf: deps.nameOf }) : null;
    sessions.push({ sessionId, items, mayBeWritten: live.has(sessionId) });
    key.push(`${file ?? '-'}:${items?.length ?? -1}:${items?.[items.length - 1]?.id ?? ''}:${live.has(sessionId)}`);
  }
  const joined = key.join('|');
  const hit = numbered.get(chat.id);
  if (hit && hit.key === joined) return hit.items;
  const items = joinSessions(sessions).map((item, n) => ({ ...item, n }));
  numbered.set(chat.id, { key: joined, items });
  return items;
}

/** `chat:history`: the items before `before` (all when absent), the last `limit` of them, oldest first. */
export function historyOf(items: NumberedItem[], query: { before?: unknown; limit?: unknown }): { seq: number; total: number; items: NumberedItem[] } {
  const before = typeof query.before === 'number' && Number.isInteger(query.before) && query.before >= 0 ? query.before : items.length;
  const limit = typeof query.limit === 'number' && Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, 1_000) : 500;
  const upTo = items.filter((i) => i.n < before);
  return { seq, total: items.length, items: upTo.slice(-limit) };
}

/**
 * The chats a window follows, and the ids of the items it was told of, by
 * snapshot or by event: the follower sends the others. A chat is followed
 * from its first chat:history answer, so a line written before its runner is
 * first seen live is still sent, and a chat no window asked for is not read.
 * By id, not by count: an item that came in before the last one told is sent
 * too, where counting by position never sent it (the gate of #371, M1). And
 * with the place each was told at: that late item moves every item after it
 * one place on, so an item whose place changed is sent again, the same id
 * replacing the one the window holds (the gate of #371, delta 2).
 */
const told = new Map<string, Map<string, number>>();

/** A chat:history answer is a snapshot: what it held needs no event. */
export function noteChatSnapshot(chatId: string, items: NumberedItem[]): void {
  if (!told.has(chatId)) told.set(chatId, new Map(items.map((i) => [i.id, i.n])));
}

/** Test seam: what this module knows of the files and the windows. */
export function resetChatHistory(): void {
  files.clear();
  reading.clear();
  numbered.clear();
  told.clear();
}

/**
 * Following the chats a window follows, while their runner's CLI is live: the
 * items each gained, and a runner whose state changed, as events. Always on
 * since 2.1.0, where every window shows chats; until then it waited on the
 * new interface's switch. One tick at a time. Returns what stops it, and a
 * tick to run now.
 */
export function followChats(deps: {
  chats: () => Chat[];
  runnerOf: (chat: Chat) => AgentStatus | undefined;
  isLive: (agent: AgentStatus) => boolean;
  nameOf: (agentId: string) => string | undefined;
  homeDir?: string;
  everyMs?: number;
}): { stop: () => void; tick: () => Promise<void> } {
  const states = new Map<string, string>();
  let running: Promise<void> | null = null;
  const once = async () => {
    for (const chat of deps.chats()) {
      const runner = deps.runnerOf(chat);
      const state = runner ? `${runner.id}:${runner.status}:${deps.isLive(runner)}` : 'none';
      if (states.has(chat.id) && states.get(chat.id) !== state) {
        publishChatEvent({ type: 'state', chatId: chat.id, runner: runner ? { id: runner.id, status: runner.status, live: deps.isLive(runner) } : null });
      }
      states.set(chat.id, state);
      const shown = told.get(chat.id);
      if (!shown || !runner || !deps.isLive(runner)) continue;
      let items: NumberedItem[];
      try {
        items = await readChatItems(chat, { runner, nameOf: deps.nameOf, homeDir: deps.homeDir });
      } catch (err) {
        console.warn(`[chats] could not read chat ${chat.id}:`, (err as Error).message);
        continue;
      }
      // What the window was told of and the chat no longer holds: a session's
      // transcript disappeared, and its "gone" line took its items' place.
      // Declared once, before the items that moved back are sent again.
      const now = new Set(items.map((i) => i.id));
      const vanished = [...shown.keys()].filter((id) => !now.has(id));
      if (vanished.length) {
        for (const id of vanished) shown.delete(id);
        publishChatEvent({ type: 'removed', chatId: chat.id, itemIds: vanished });
      }
      for (const item of items) {
        if (shown.get(item.id) === item.n) continue;
        shown.set(item.id, item.n);
        publishChatEvent({ type: 'item', chatId: chat.id, item });
      }
    }
  };
  const tick = (): Promise<void> => {
    if (!running) running = once().finally(() => { running = null; });
    return running;
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, deps.everyMs ?? 1_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/** What `agent:queue` answers: the work in hand, and the requests waiting behind it. */
export interface QueueView {
  agentId: string;
  current: QueueEntry | null;
  queue: QueueEntry[];
}

export interface QueueEntry {
  ref: string | null;
  requesterAgentId: string;
  requesterName: string;
  state: 'queued' | 'delivered';
  queuedAt: string | null;
  /** The chat it was asked from: none until the chats have their own runners (PR D). */
  chatId: null;
}

export function queueOf(agent: AgentStatus, nameOf: (agentId: string) => string | undefined): QueueView {
  const entry = (r: { ref?: string; requesterAgentId: string; state?: 'queued' | 'delivered'; queuedAt?: string }): QueueEntry => ({
    ref: r.ref ?? null, requesterAgentId: r.requesterAgentId, requesterName: nameOf(r.requesterAgentId) ?? r.requesterAgentId,
    state: r.state ?? 'delivered', queuedAt: r.queuedAt ?? null, chatId: null,
  });
  const held = agent.requestedBy;
  const queue = agent.taskQueue ?? [];
  const inHand = held ? queue.find((r) => r.ref === held.taskRef) : undefined;
  return {
    agentId: agent.id,
    current: held ? entry(inHand ?? { ref: held.taskRef, requesterAgentId: held.agentId }) : null,
    queue: queue.filter((r) => r !== inHand).map(entry),
  };
}
