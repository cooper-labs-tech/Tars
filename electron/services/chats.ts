import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { describeSecretFileError, writeAtomicSync } from '../utils/secret-file';
import { twoZones } from '../utils/two-zones';
import type { TaskRequest } from '../core/task-requests';

/**
 * The chats of each project (ORCHESTRATOR-PER-CHAT.md v2.2, 4.1 and 4.6; PR C
 * of 2.0.0): one record per chat, in `~/.tars/chats.json`.
 *
 * A chat is a conversation with the project's orchestrator on one topic. Its
 * record says which project it belongs to (the path as Tars saved it, the
 * Brain lesson of #346), its number in that project (#1 is Main, then 2,
 * 3...; never handed out again after a delete, so an old Telegram reply to
 * "#3" cannot reach a newer chat), its title and who gave it, the agent that
 * runs its conversation and every session that conversation went through,
 * and how the user filed it: pinned, snoozed, settled, the project's inbox.
 * The conversation itself is not copied here: it is in the runner's
 * transcripts, one per session.
 *
 * The migration makes each project's orchestrator's conversation its chat
 * #1, "Main", bound to the orchestrator, the project's inbox. It runs for a
 * project once: the counter of the project's numbers says it ran, so a launch
 * that finds nothing to make writes nothing, and a Main the user deleted
 * does not come back. A project whose orchestrator is set later gets its
 * Main then.
 *
 * Every write is atomic and goes only when something changed, the whole file
 * in one order, so the same chats are the same bytes. A file that is not the
 * chats' (not JSON, not this shape) is set aside under a name of its own,
 * never written over, and reported; a record that does not hold is dropped
 * the same way, the file as it was kept beside it. A file written by a newer
 * Tars, or one that cannot be read, is left as it is and nothing is changed
 * until it can be: the store says why. A field this version does not know is
 * not kept: a later Tars that adds one writes version 2.
 *
 * Who runs a chat other than Main (its runner, PR D) and what a chat says
 * (PR E) are not here; nor is anything the window shows of a chat beyond its
 * record (handlers/chat-handlers.ts).
 */

export const CHATS_VERSION = 1;
export const MAIN_TITLE = 'Main';
export const NEW_CHAT_TITLE = 'New chat';
/** A title is one line of at most this many characters: it heads every Telegram line of its chat. */
export const TITLE_MAX = 80;

export interface Chat {
  id: string;
  /** The project's path as Tars saved it (its orchestrator's `projectPath`). */
  projectPath: string;
  /** Fixed within its project: 1 is Main, then 2, 3...; never reused after a delete. */
  number: number;
  title: string;
  /** 'auto': "New chat" until the first message names it (PR E); 'user': named, never replaced. */
  titleSource: 'user' | 'auto';
  /** The agent that runs its conversation: Main's is the orchestrator; null until a chat's first send (PR D). */
  runnerId: string | null;
  /** Every session the runner's conversation went through, oldest first. */
  sessionIds: string[];
  /**
   * The folder each session's CLI ran in, by session id, recorded when the
   * session was taken: Main follows a new orchestrator, and a session the
   * former one ran in its own worktree is found there (GATE-PR371-DELTA5).
   * As Tars saved it, then its real path when that differs: Claude Code files
   * a transcript under the real one, which cannot be read once the folder is
   * gone (GATE-PR391, L2). Inside the project; absent for a session from before.
   */
  sessionFolders?: Record<string, string[]>;
  pinned: boolean;
  /** Hidden from the active chats until then (ISO), or until something arrives for it. */
  snoozedUntil: string | null;
  /** Done (ISO): listed under Settled. */
  settledAt: string | null;
  /** The project's chat that the bots, Hermes and Tars's notes post to: exactly one per project with chats. */
  inbox: boolean;
  createdAt: string;
  updatedAt: string;
  /** The conversation's latest sign of life known here: created, or a new session. */
  lastActivityAt: string;
}

export type ChatErrorCode =
  | 'not_found' | 'invalid_request' | 'invalid_title' | 'invalid_until' | 'no_orchestrator'
  | 'inbox' | 'chat_has_work' | 'write_failed' | 'chats_unavailable'
  /** The project's orchestrator runs a CLI whose conversations Tars cannot resume (PR D: chats work with claude). */
  | 'provider_unsupported'
  /** A chat that already has its runner, Main's being the orchestrator. */
  | 'runner_set';

export interface ChatError {
  error: ChatErrorCode;
  /** A sentence the window can show as it is. */
  reason: string;
  /** For `chat_has_work`: the work the chat's runner has out. */
  tasks?: WorkItem[];
}

/** A request a chat's runner has out at another agent (core/task-requests.ts). */
export interface WorkItem {
  workerId: string;
  workerName: string | null;
  /** The request's id, as Tars typed it in the sender line; null for a link an older Tars left. */
  ref: string | null;
  /** Queued behind the worker's turn, or typed into its terminal (its work in hand, or about to be). */
  state: 'queued' | 'delivered';
  queuedAt: string | null;
}

export interface ChatsProblem {
  /**
   * corrupt: the file was not the chats', set aside, and a new one started;
   * repaired: records that did not hold were dropped (or put right), the file as it was set aside;
   * newer: written by a newer Tars, left as it is, nothing changed;
   * unreadable: could not be read, left as it is, nothing changed;
   * write_failed: what the migration made could not be written.
   */
  kind: 'corrupt' | 'repaired' | 'newer' | 'unreadable' | 'write_failed';
  detail: string;
  /** Where the file as it was is kept. */
  file?: string;
  /** Records dropped (repaired). */
  dropped?: number;
  at: string;
}

/** What the migration reads of a project's orchestrator. */
export interface OrchestratorFacts {
  id: string;
  projectPath: string;
  createdAt?: string;
  lastActivity?: string;
  resumableSessionId?: string;
  /** False when its CLI's conversations cannot be resumed (a provider other than claude): no chat but Main. */
  resumable?: boolean;
}

export interface ChatStore {
  problem(): ChatsProblem | null;
  /** Every chat, by project then number, as copies; `seq` moves at each change written. */
  list(): { seq: number; chats: Chat[] };
  get(chatId: unknown): Chat | undefined;
  /** The migration: Main for each project with an orchestrator that never had chats. Returns what it made. */
  ensureMains(orchestrators: OrchestratorFacts[]): Chat[];
  /**
   * Main follows the project's orchestrator, the persistent one: a Main whose runner is not it any more is
   * rebound to it, its sessions kept as history and the orchestrator's conversation added last. Returns what it
   * rebound; writes nothing when nothing moved.
   */
  followOrchestrators(orchestrators: OrchestratorFacts[]): MainRebound[];
  create(input: { projectPath?: unknown; title?: unknown }, orchestrators: OrchestratorFacts[]): Chat | ChatError;
  rename(chatId: unknown, title: unknown): Chat | ChatError;
  pin(chatId: unknown, pinned: unknown): Chat | ChatError;
  snooze(chatId: unknown, until: unknown): Chat | ChatError;
  settle(chatId: unknown, settled: unknown): Chat | ChatError;
  setInbox(chatId: unknown): Chat | ChatError;
  /** Why the chat may not be deleted now (the inbox, work its runner has out), or null. Writes nothing. */
  removalRefusal(chatId: unknown, workOut: (chat: Chat) => WorkItem[]): ChatError | null;
  /** Refused for the inbox, or while `workOut` names work the chat's runner has out. */
  remove(chatId: unknown, workOut: (chat: Chat) => WorkItem[]): { success: true } | ChatError;
  /** The runner a chat's first send made (PR D). Main's is the orchestrator, set by the migration. */
  setRunner(chatId: unknown, runnerId: unknown): Chat | ChatError;
  /** The chat an agent runs, Main's included. */
  chatOfRunner(agentId: string): Chat | undefined;
  /** A session the agent registered: added to each chat it runs that lacks it. Returns whether anything changed. */
  noteSession(runnerId: string, sessionId: unknown, folder?: unknown): boolean;
}

const REASONS = {
  not_found: 'No chat has this id.',
  invalid_request: 'This change needs a yes or a no.',
  invalid_title: `A chat's title is one line of 1 to ${TITLE_MAX} characters.`,
  invalid_until: 'A snooze ends at a time still to come.',
  no_orchestrator: "This project has no orchestrator: set one on the Agents page, and its conversation becomes the chat Main.",
  inbox: "This chat is the project's inbox, where the bots, Hermes and Tars's notes arrive: make another chat the inbox first.",
  chat_has_work: 'This chat has work out at the team: wait for it to end, or cancel it, before deleting the chat.',
  provider_unsupported: "This project's orchestrator runs a CLI whose conversations Tars cannot resume: chats other than Main work with claude for now.",
  runner_set: 'This chat already has the agent that runs its conversation.',
} as const;

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CHAT_ID = /^[A-Za-z0-9-]{1,64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
/** The bidi controls (#186's class): they reorder what a reader sees. */
const UNSEEN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && SESSION_ID.test(v);
const fail = (error: Exclude<ChatErrorCode, 'write_failed' | 'chats_unavailable' | 'chat_has_work'>): ChatError => ({ error, reason: REASONS[error] });
const copy = (chat: Chat): Chat => ({
  ...chat, sessionIds: [...chat.sessionIds],
  ...(chat.sessionFolders ? { sessionFolders: Object.fromEntries(Object.entries(chat.sessionFolders).map(([k, v]) => [k, [...v]])) } : {}),
});

/** A folder's real path, or undefined when it cannot be read. */
function realOf(folder: string): string | undefined {
  try {
    return fs.realpathSync(folder);
  } catch {
    return undefined;
  }
}

/**
 * A folder a session's CLI may have run in: the project's own, or one inside
 * it (its worktrees), under the spelling Tars saved or the project's real one.
 * chats.json is agents' to write, and the folder chooses which transcripts a
 * chat shows.
 */
/** An absolute folder, normalised (no "." or ".." in it), of a sane length. */
function isWellFormedFolder(folder: unknown): folder is string {
  return typeof folder === 'string' && folder.length <= 4096 && !folder.includes('\0') && path.isAbsolute(folder) && path.resolve(folder) === folder;
}

export function isSessionFolder(folder: unknown, projectPath: string, projectReal = realOf(projectPath)): folder is string {
  if (!isWellFormedFolder(folder)) return false;
  const inside = (root: string) => folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  return inside(projectPath) || (!!projectReal && inside(projectReal));
}

/**
 * The recorded spellings of a session's folder a reader may use: only while
 * the project's real path reads, and each inside the project. A spelling kept
 * unchecked while a linked project's target was away is never read
 * (GATE-PR391-DELTA2, probe PC): the record keeps it, unrepaired, for the next
 * load that can check it.
 */
export function sessionFoldersToRead(chat: Pick<Chat, 'projectPath' | 'sessionFolders'>, sessionId: string): string[] {
  const recorded = chat.sessionFolders?.[sessionId];
  if (!recorded?.length) return [];
  const projectReal = realOf(chat.projectPath);
  if (!projectReal) return [];
  return recorded.filter((f) => isSessionFolder(f, chat.projectPath, projectReal));
}

/** The spellings to record for a folder: as given, then its real path when it differs, each inside the project. */
function spellingsOf(folder: unknown, projectPath: string): string[] {
  if (!isSessionFolder(folder, projectPath)) return [];
  const real = realOf(folder);
  return real && real !== folder && isSessionFolder(real, projectPath) ? [folder, real] : [folder];
}

/** One line of at most TITLE_MAX characters, or null: breaks become spaces, control and bidi characters go. */
export function titleOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(/\s+/gu, ' ').replace(UNSEEN, '').replace(/ {2,}/g, ' ').trim();
  const length = Array.from(flat).length;
  return length >= 1 && length <= TITLE_MAX ? flat : null;
}

interface State {
  numbers: Record<string, number>;
  chats: Chat[];
}

const byProjectThenNumber = (a: Chat, b: Chat): number =>
  (a.projectPath < b.projectPath ? -1 : a.projectPath > b.projectPath ? 1 : a.number - b.number);

/** The file's text: the same chats are always the same bytes. */
function serialize(state: State): string {
  const numbers: Record<string, number> = {};
  for (const key of Object.keys(state.numbers).sort()) numbers[key] = state.numbers[key];
  const chats = [...state.chats].sort(byProjectThenNumber).map((c) => ({
    id: c.id, projectPath: c.projectPath, number: c.number, title: c.title, titleSource: c.titleSource,
    runnerId: c.runnerId, sessionIds: c.sessionIds,
    ...(c.sessionFolders && Object.keys(c.sessionFolders).length
      ? { sessionFolders: Object.fromEntries(Object.keys(c.sessionFolders).sort().map((k) => [k, c.sessionFolders![k]])) }
      : {}),
    pinned: c.pinned, snoozedUntil: c.snoozedUntil, settledAt: c.settledAt,
    inbox: c.inbox, createdAt: c.createdAt, updatedAt: c.updatedAt, lastActivityAt: c.lastActivityAt,
  }));
  return JSON.stringify({ version: CHATS_VERSION, numbers, chats }, null, 2) + '\n';
}

/** A record as the file holds it, or null when it does not hold. A title is put on one line (`fixed`). */
function chatOf(raw: unknown): { chat: Chat; fixed: boolean } | null {
  if (!isObject(raw)) return null;
  const { id, projectPath, number, title, titleSource, runnerId, sessionIds, sessionFolders, pinned, snoozedUntil, settledAt, inbox, createdAt, updatedAt, lastActivityAt } = raw;
  if (typeof id !== 'string' || !CHAT_ID.test(id)) return null;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || projectPath.includes('\0') || projectPath.length > 4096) return null;
  if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > 1_000_000) return null;
  const flat = titleOf(title);
  if (flat === null) return null;
  if (titleSource !== 'user' && titleSource !== 'auto') return null;
  if (runnerId !== null && (typeof runnerId !== 'string' || !AGENT_ID.test(runnerId))) return null;
  if (!Array.isArray(sessionIds) || !sessionIds.every(isSessionId)) return null;
  if (typeof pinned !== 'boolean' || typeof inbox !== 'boolean') return null;
  if (snoozedUntil !== null && !isTime(snoozedUntil)) return null;
  if (settledAt !== null && !isTime(settledAt)) return null;
  if (!isTime(createdAt) || !isTime(updatedAt) || !isTime(lastActivityAt)) return null;
  const sessions = [...new Set(sessionIds as string[])];
  // The folders of the sessions it holds, each inside its project; what does not hold is dropped, the chat kept.
  const folders: Record<string, string[]> = {};
  let foldersFixed = sessionFolders !== undefined && !isObject(sessionFolders);
  if (isObject(sessionFolders)) {
    const projectReal = realOf(projectPath);
    // A project whose real path cannot be read now (a link whose target is
    // away): a spelling that is not under the saved path cannot be checked, and
    // is kept as recorded, to be checked at the next load that can read it.
    // Dropped, the repair would write its loss for good (GATE-PR391-DELTA, L1).
    const holds = (f: unknown): f is string => isSessionFolder(f, projectPath, projectReal)
      || (projectReal === undefined && isWellFormedFolder(f));
    for (const [sessionId, spellings] of Object.entries(sessionFolders)) {
      const kept = Array.isArray(spellings) ? [...new Set(spellings.filter(holds))].slice(0, 2) as string[] : [];
      if (sessions.includes(sessionId) && kept.length) folders[sessionId] = kept;
      if (!sessions.includes(sessionId) || !Array.isArray(spellings) || kept.length !== spellings.length) foldersFixed = true;
    }
  }
  return {
    chat: {
      id, projectPath, number: number as number, title: flat, titleSource, runnerId: runnerId as string | null, sessionIds: sessions,
      ...(Object.keys(folders).length ? { sessionFolders: folders } : {}),
      pinned, snoozedUntil: snoozedUntil as string | null, settledAt: settledAt as string | null, inbox, createdAt, updatedAt, lastActivityAt,
    },
    fixed: flat !== title || sessions.length !== sessionIds.length || foldersFixed,
  };
}

/** The records of a version-1 file that hold, with the repairs that keep the rules: numbers never reused, one inbox per project. */
function stateOf(file: Record<string, unknown>): { state: State; dropped: number; repaired: boolean } {
  const numbers: Record<string, number> = {};
  let repaired = false;
  for (const [project, last] of Object.entries(isObject(file.numbers) ? file.numbers : {})) {
    if (path.isAbsolute(project) && Number.isInteger(last) && (last as number) >= 1) numbers[project] = last as number;
    else repaired = true;
  }
  const chats: Chat[] = [];
  const ids = new Set<string>();
  const taken = new Set<string>();
  let dropped = 0;
  for (const raw of file.chats as unknown[]) {
    const read = chatOf(raw);
    const key = read ? `${read.chat.projectPath}\0${read.chat.number}` : '';
    if (!read || ids.has(read.chat.id) || taken.has(key)) {
      dropped += 1;
      continue;
    }
    if (read.fixed) repaired = true;
    ids.add(read.chat.id);
    taken.add(key);
    chats.push(read.chat);
  }
  for (const project of new Set(chats.map((c) => c.projectPath))) {
    const own = chats.filter((c) => c.projectPath === project).sort(byProjectThenNumber);
    // A counter below a number in use would hand that number out again.
    const highest = own[own.length - 1].number;
    if ((numbers[project] ?? 0) < highest) {
      numbers[project] = highest;
      repaired = true;
    }
    // Exactly one inbox: the lowest-numbered one kept, or the lowest-numbered chat made it.
    const inbox = own.find((c) => c.inbox) ?? own[0];
    for (const c of own) {
      const should = c === inbox;
      if (c.inbox !== should) {
        c.inbox = should;
        repaired = true;
      }
    }
  }
  return { state: { numbers, chats }, dropped, repaired };
}

export function createChatStore(opts: {
  file: string;
  now?: () => number;
  newId?: () => string;
  realpath?: (p: string) => string;
}): ChatStore {
  const { file } = opts;
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const realpath = opts.realpath ?? ((p: string) => fs.realpathSync(p));
  const iso = (): string => new Date(now()).toISOString();

  let state: State = { numbers: {}, chats: [] };
  /** False while the file is a newer Tars's, or cannot be read: it must not be written over. */
  let writable = true;
  let problem: ChatsProblem | null = null;
  let seq = 0;

  const report = (p: Omit<ChatsProblem, 'at'>): void => {
    problem = { ...p, at: iso() };
    console.error(`[chats] ${p.detail}${p.file ? ` (kept as ${p.file})` : ''}`);
  };

  /** A name beside the file that nothing holds yet: a file set aside is never written over. */
  const asideName = (): string => {
    const stamp = iso().replace(/[:.]/g, '-');
    let name = `${file}.corrupt-${stamp}`;
    for (let n = 2; fs.existsSync(name); n += 1) name = `${file}.corrupt-${stamp}-${n}`;
    return name;
  };

  const load = (): void => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      writable = false;
      report({ kind: 'unreadable', detail: `chats.json could not be read (${describeSecretFileError(err)}): it is left as it is, and no chat can change until it can be read` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    // A newer Tars's file, whatever its shape: a version this one does not know is never set aside or written over.
    const version = isObject(parsed) ? parsed.version : undefined;
    if (Number.isInteger(version) && (version as number) > CHATS_VERSION) {
      writable = false;
      report({ kind: 'newer', detail: `chats.json was written by a newer Tars (version ${version as number}): it is left as it is, and no chat can change in this version` });
      return;
    }
    const shaped = isObject(parsed) && version === CHATS_VERSION && Array.isArray(parsed.chats) && isObject(parsed.numbers);
    if (!shaped) {
      try {
        const aside = asideName();
        fs.renameSync(file, aside);
        report({ kind: 'corrupt', file: aside, detail: 'chats.json was not a chats file: it was set aside, and the chats start again from each orchestrator' });
      } catch (err) {
        writable = false;
        report({ kind: 'corrupt', detail: `chats.json was not a chats file, and could not be set aside (${describeSecretFileError(err)}): it is left as it is, and no chat can change` });
      }
      return;
    }
    const read = stateOf(parsed as Record<string, unknown>);
    state = read.state;
    if (!read.dropped && !read.repaired) return;
    let aside: string | undefined;
    try {
      aside = asideName();
      fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      // Not kept aside: then not written over either.
      writable = false;
      report({ kind: 'repaired', dropped: read.dropped, detail: `chats.json held ${read.dropped} record(s) that do not hold, and could not be set aside (${describeSecretFileError(err)}): it is left as it is, and no chat can change` });
      return;
    }
    try {
      writeAtomicSync(file, serialize(state));
    } catch (err) {
      console.error(`[chats] chats.json could not be written again (${describeSecretFileError(err)})`);
    }
    report({ kind: 'repaired', file: aside, dropped: read.dropped, detail: read.dropped
      ? `chats.json held ${read.dropped} record(s) that do not hold: they were dropped, the file as it was set aside`
      : 'chats.json broke a rule of the chats (a number in use, one inbox per project): it was put right, the file as it was set aside' });
  };

  /** The next state written, then kept: the store and the file never differ. */
  const commit = (next: State): ChatError | null => {
    if (!writable) return unavailable();
    try {
      writeAtomicSync(file, serialize(next));
    } catch (err) {
      return { error: 'write_failed', reason: `The chats file could not be written (${describeSecretFileError(err)}): nothing was changed.` };
    }
    state = next;
    seq += 1;
    return null;
  };

  const unavailable = (): ChatError => ({
    error: 'chats_unavailable',
    reason: problem?.detail ? `${problem.detail[0].toUpperCase()}${problem.detail.slice(1)}.` : 'The chats file cannot be changed.',
  });
  const clone = (): State => ({ numbers: { ...state.numbers }, chats: state.chats.map(copy) });
  const find = (s: State, chatId: unknown): Chat | undefined => (typeof chatId === 'string' ? s.chats.find((c) => c.id === chatId) : undefined);

  /** Changes one chat of a copy of the state, and writes it when `change` changed something. */
  const update = (chatId: unknown, change: (chat: Chat, next: State) => ChatError | boolean): Chat | ChatError => {
    const next = clone();
    const chat = find(next, chatId);
    if (!chat) return fail('not_found');
    const changed = change(chat, next);
    if (typeof changed === 'object') return changed;
    if (!changed) return copy(find(state, chatId)!);
    if (!writable) return unavailable();
    chat.updatedAt = iso();
    return commit(next) ?? copy(chat);
  };

  const realOf = (p: string): string | null => {
    try {
      return realpath(p);
    } catch {
      return null;
    }
  };
  /** The orchestrator of the project this path names, under the spelling Tars saved or another one of the same folder. */
  const orchestratorOf = (projectPath: unknown, orchestrators: OrchestratorFacts[]): OrchestratorFacts | undefined => {
    if (typeof projectPath !== 'string' || !projectPath) return undefined;
    const exact = orchestrators.find((o) => o.projectPath === projectPath);
    if (exact) return exact;
    const real = realOf(projectPath);
    return real ? orchestrators.find((o) => !!o.projectPath && realOf(o.projectPath) === real) : undefined;
  };

  const store: ChatStore = {
    problem: () => (problem ? { ...problem } : null),

    list: () => ({ seq, chats: [...state.chats].sort(byProjectThenNumber).map(copy) }),

    get: (chatId) => {
      const chat = find(state, chatId);
      return chat ? copy(chat) : undefined;
    },

    ensureMains(orchestrators) {
      if (!writable) return [];
      const next = clone();
      const made: Chat[] = [];
      for (const o of orchestrators) {
        if (!o || typeof o.id !== 'string' || !AGENT_ID.test(o.id) || typeof o.projectPath !== 'string' || !path.isAbsolute(o.projectPath)) continue;
        const project = o.projectPath;
        // Its project had chats once: the migration ran for it, and a Main the user deleted stays deleted.
        if (next.numbers[project] !== undefined || next.chats.some((c) => c.projectPath === project)) continue;
        const at = iso();
        const createdAt = isTime(o.createdAt) ? o.createdAt : at;
        const main: Chat = {
          id: newId(), projectPath: project, number: 1, title: MAIN_TITLE, titleSource: 'user', runnerId: o.id,
          sessionIds: isSessionId(o.resumableSessionId) ? [o.resumableSessionId] : [],
          pinned: false, snoozedUntil: null, settledAt: null, inbox: true,
          createdAt, updatedAt: at, lastActivityAt: isTime(o.lastActivity) ? o.lastActivity : createdAt,
        };
        next.numbers[project] = 1;
        next.chats.push(main);
        made.push(main);
      }
      if (!made.length) return [];
      const failed = commit(next);
      if (failed) {
        report({ kind: 'write_failed', detail: `the chat Main of ${made.length} project(s) could not be written: ${failed.reason}` });
        return [];
      }
      return made.map(copy);
    },

    followOrchestrators(orchestrators) {
      if (!writable) return [];
      const next = clone();
      const moved: MainRebound[] = [];
      for (const chat of next.chats) {
        if (chat.number !== 1) continue;
        const lead = orchestratorOf(chat.projectPath, orchestrators.filter((o) => !!o && typeof o.id === 'string' && AGENT_ID.test(o.id)));
        if (!lead || lead.id === chat.runnerId) continue;
        moved.push({ chatId: chat.id, projectPath: chat.projectPath, from: chat.runnerId, to: lead.id });
        chat.runnerId = lead.id;
        if (isSessionId(lead.resumableSessionId) && !chat.sessionIds.includes(lead.resumableSessionId)) chat.sessionIds.push(lead.resumableSessionId);
        chat.updatedAt = iso();
      }
      if (!moved.length) return [];
      const failed = commit(next);
      if (failed) {
        report({ kind: 'write_failed', detail: `Main could not follow the orchestrator of ${moved.length} project(s): ${failed.reason}` });
        return [];
      }
      return moved;
    },

    create(input, orchestrators) {
      if (!writable) return unavailable();
      // The project's Main first, when its orchestrator came after the launch.
      store.ensureMains(orchestrators);
      const orchestrator = orchestratorOf(input.projectPath, orchestrators);
      if (!orchestrator) return fail('no_orchestrator');
      if (orchestrator.resumable === false) return fail('provider_unsupported');
      const named = input.title !== undefined && input.title !== null;
      const title = named ? titleOf(input.title) : NEW_CHAT_TITLE;
      if (title === null) return fail('invalid_title');
      const project = orchestrator.projectPath;
      const next = clone();
      const own = next.chats.filter((c) => c.projectPath === project);
      const number = Math.max(next.numbers[project] ?? 0, ...own.map((c) => c.number)) + 1;
      next.numbers[project] = number;
      const at = iso();
      const chat: Chat = {
        id: newId(), projectPath: project, number, title, titleSource: named ? 'user' : 'auto', runnerId: null, sessionIds: [],
        pinned: false, snoozedUntil: null, settledAt: null, inbox: !own.some((c) => c.inbox),
        createdAt: at, updatedAt: at, lastActivityAt: at,
      };
      next.chats.push(chat);
      return commit(next) ?? copy(chat);
    },

    rename: (chatId, raw) => update(chatId, (chat) => {
      const title = titleOf(raw);
      if (title === null) return fail('invalid_title');
      if (chat.title === title && chat.titleSource === 'user') return false;
      chat.title = title;
      chat.titleSource = 'user';
      return true;
    }),

    pin: (chatId, pinned) => update(chatId, (chat) => {
      if (typeof pinned !== 'boolean') return fail('invalid_request');
      if (chat.pinned === pinned) return false;
      chat.pinned = pinned;
      return true;
    }),

    snooze: (chatId, until) => update(chatId, (chat) => {
      let value: string | null = null;
      if (until !== null) {
        const at = typeof until === 'string' && until.length <= 64 ? Date.parse(until) : NaN;
        if (!Number.isFinite(at) || at <= now()) return fail('invalid_until');
        value = new Date(at).toISOString();
      }
      if (chat.snoozedUntil === value) return false;
      chat.snoozedUntil = value;
      return true;
    }),

    settle: (chatId, settled) => update(chatId, (chat) => {
      if (typeof settled !== 'boolean') return fail('invalid_request');
      if (settled === (chat.settledAt !== null)) return false;
      chat.settledAt = settled ? iso() : null;
      return true;
    }),

    setInbox: (chatId) => update(chatId, (chat, next) => {
      if (chat.inbox) return false;
      const at = iso();
      for (const other of next.chats) {
        if (other.projectPath === chat.projectPath && other.inbox) {
          other.inbox = false;
          other.updatedAt = at;
        }
      }
      chat.inbox = true;
      return true;
    }),

    removalRefusal(chatId, workOut) {
      const chat = find(state, chatId);
      if (!chat) return fail('not_found');
      if (chat.inbox) return fail('inbox');
      const tasks = workOut(copy(chat));
      if (tasks.length) return { error: 'chat_has_work', reason: REASONS.chat_has_work, tasks };
      return null;
    },

    remove(chatId, workOut) {
      const refused = store.removalRefusal(chatId, workOut);
      if (refused) return refused;
      const chat = find(state, chatId)!;
      const next = clone();
      next.chats = next.chats.filter((c) => c.id !== chat.id);
      return commit(next) ?? { success: true };
    },

    setRunner: (chatId, runnerId) => update(chatId, (chat) => {
      if (typeof runnerId !== 'string' || !AGENT_ID.test(runnerId)) return fail('invalid_request');
      if (chat.runnerId !== null) return fail('runner_set');
      chat.runnerId = runnerId;
      return true;
    }),

    chatOfRunner: (agentId) => {
      const chat = [...state.chats].sort(byProjectThenNumber).find((c) => c.runnerId === agentId);
      return chat ? copy(chat) : undefined;
    },

    noteSession(runnerId, sessionId, folder) {
      if (!writable || !isSessionId(sessionId)) return false;
      // What a chat of this runner lacks: the session, or the folder its CLI ran in, recorded once.
      const lacks = (c: Chat) => c.runnerId === runnerId
        && (!c.sessionIds.includes(sessionId) || (!c.sessionFolders?.[sessionId] && spellingsOf(folder, c.projectPath).length > 0));
      if (!state.chats.some(lacks)) return false;
      const next = clone();
      const at = iso();
      for (const chat of next.chats) {
        if (!lacks(chat)) continue;
        if (!chat.sessionIds.includes(sessionId)) {
          chat.sessionIds.push(sessionId);
          chat.lastActivityAt = at;
        }
        const spellings = spellingsOf(folder, chat.projectPath);
        if (!chat.sessionFolders?.[sessionId] && spellings.length) {
          chat.sessionFolders = { ...(chat.sessionFolders ?? {}), [sessionId]: spellings };
        }
        chat.updatedAt = at;
      }
      return commit(next) === null;
    },
  };

  load();
  return store;
}

/** A Main rebound to its project's orchestrator (followOrchestrators). */
export interface MainRebound {
  chatId: string;
  projectPath: string;
  from: string | null;
  to: string;
}

/** A member of the fleet, as the work a chat has out reads it (AgentStatus has these). */
export interface WorkFleetMember {
  id: string;
  name?: string;
  taskQueue?: TaskRequest[];
  requestedBy?: { agentId: string; taskRef?: string };
}

/**
 * The work a chat's runner has out at the team: every request it made that an
 * agent still holds, queued behind its turn or typed into its terminal
 * (core/task-requests.ts, PR A), and a link an older Tars left with no request
 * id. Work asked of the runner itself is not the chat's work out.
 */
export function workOutOf(runnerId: string | null | undefined, fleet: Iterable<WorkFleetMember>): WorkItem[] {
  if (!runnerId) return [];
  const out: WorkItem[] = [];
  for (const agent of fleet) {
    if (agent.id === runnerId) continue;
    const workerName = agent.name ?? null;
    for (const request of agent.taskQueue ?? []) {
      if (request.requesterAgentId !== runnerId) continue;
      out.push({ workerId: agent.id, workerName, ref: request.ref, state: request.state, queuedAt: request.queuedAt ?? null });
    }
    const link = agent.requestedBy;
    if (link?.agentId === runnerId && !link.taskRef) {
      out.push({ workerId: agent.id, workerName, ref: null, state: 'delivered', queuedAt: null });
    }
  }
  return out;
}

export interface ChatLimit {
  /** How many chats may have a live CLI at once, across every project, Main counted. */
  limit: number;
  ramGb: number;
  perChatGb: number;
  min: number;
  max: number;
  /** 'ram': this Mac's memory; 'override': the E2E's figure (TARS_CHAT_RAM_GB, read only when DOROTHY_E2E=1). */
  source: 'ram' | 'override';
}

const PER_CHAT_GB = 5;
const MIN_CHATS = 1;
const MAX_CHATS = 8;

/**
 * What a chat left asleep at a launch after an abrupt stop is told at its next launch: why, with that launch's time
 * UTC first, then the machine's own (utils/two-zones.ts, 2.0.6).
 */
export function launchLimitNote(limit: number, now: number): string {
  return `[Tars] Tars stopped abruptly while this chat was working, and it was not restarted at launch (${twoZones(now)}): `
    + `the limit is ${limit} chats working at once. Your conversation is as it was; pick up where it stopped.`;
}

/**
 * One chat per 5 GB of RAM, from 1 to 8 (JeanBrasse, 07/10; 4.2): a runner and its
 * MCP servers take 0.4 to 0.75 GB, and the rest of each 5 GB is left to the
 * workers it drives, macOS and Tars. 8 GB: 1, 16 GB: 3, 24 GB: 4, 32 GB: 6,
 * 64 GB and more: 8. A GB is 2^30 bytes, as os.totalmem() counts them.
 */
export function chatLimitOf(totalBytes: number, env: Record<string, string | undefined>): ChatLimit {
  const raw = env.DOROTHY_E2E === '1' ? env.TARS_CHAT_RAM_GB?.trim() : undefined;
  const override = raw ? Number(raw) : NaN;
  const overridden = Number.isFinite(override) && override > 0;
  const gb = overridden ? override : totalBytes / 2 ** 30;
  return {
    limit: Math.min(MAX_CHATS, Math.max(MIN_CHATS, Math.floor(gb / PER_CHAT_GB))),
    ramGb: Math.round(gb * 10) / 10,
    perChatGb: PER_CHAT_GB,
    min: MIN_CHATS,
    max: MAX_CHATS,
    source: overridden ? 'override' : 'ram',
  };
}
