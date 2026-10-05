import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { hermesRequest } from './hermes-client';
import { usableHermesConnection } from './hermes-config';
import { resolveHermesBaseUrl, sessionToken } from '../types/hermes';
import { setReportChannel, type ReportChannel } from './event-reports';
import { projectWord as projectWordOf } from './orchestrator-routing';

/**
 * The relay to the user's Telegram through their Hermes (DESIGN-RELAIS-HERMES-V2.md, step 2; JeanBrasse's decisions of
 * 2026-10-01). Hermes is the only voice on that Telegram: Tars sends through the tars-relay plugin on the gateway it
 * already reaches (hermes-plugins/tars-relay), and the user's replies to those messages, and their "@project"
 * messages, come back from the plugin, which keeps them from Hermes's model.
 *
 * - A send goes out as written, plain text, to the one user the plugin's settings name on the server. Its message id
 *   is kept in Tars's own list (~/.tars-private, which no agent is handed): a reply counts only when it answers a
 *   message on that list, whatever ref the plugin hands back. The plugin cannot write that list; a dashboard token
 *   in the wrong hands can make the plugin send, never make Tars take the reply.
 * - Hermes down: the send waits in ~/.tars-private, its caller is told it has not gone, and it goes when Hermes
 *   answers, until its time is up. Nothing falls back to anything else.
 * - While the relay is on, every POLL_MS: the plugin's status, the projects, what waits, then the replies, each
 *   handed once to the handler of what it answers (a question, a report, a Sentry request) or to the "@project"
 *   handler, and acked. A reply to a message Tars did not send reaches nobody, and the user is told.
 * - Tars keeps the number of the last reply it took with the id of the plugin's store: a store made again (the plugin
 *   reinstalled, moved, cleaned) numbers from 1 again, and Tars starts over with it rather than skip its replies.
 * - The plugin keeps "@name" for Tars only for the projects Tars registered with it: the fleet's names that are one
 *   word, told again whenever they are not the ones the plugin lists. Any other "@word" is Hermes's.
 * - Off means off: nothing sent, polled or acked, and the event reports have no channel.
 */

export type RelayKind = 'question' | 'report' | 'sentry';

export interface RelayMessage {
  text: string;
  kind: RelayKind;
  /** What the message is, `<type>:<id>`: a reply to it goes to the handler of that type. */
  ref: string;
  /** The project it is about: a reply to it is that project's. */
  projectPath?: string;
  /** Until when it may still go, if Hermes is down when it is sent. An hour when not said. */
  expiresAt?: number;
}

export type RelaySendResult =
  | { state: 'sent'; messageId: string }
  | { state: 'queued'; reason: string }
  | { state: 'refused'; reason: string };

export type RelayState = 'off' | 'ready' | 'unreachable' | 'not-configured' | 'plugin-missing' | 'unauthorized' | 'no-connection';

export interface RelayStatus {
  enabled: boolean;
  state: RelayState;
  /** Sends waiting for Hermes. */
  waiting: number;
  lastError?: string;
  lastSentAt?: string;
  lastReplyAt?: string;
  checkedAt?: string;
}

/** A reply of the user's, to a message Tars sent. */
export interface RelayReply {
  seq: number;
  /** What it answers: the type and id of the message's ref. */
  refType: string;
  refId: string;
  ref: string;
  kind: RelayKind;
  projectPath: string;
  text: string;
  /** When Tars sent the message it answers, and when the user replied, in ms. */
  sentAt: number;
  at: number;
}

/** "@project text" from the user. */
export interface RelayProjectMessage {
  seq: number;
  project: string;
  text: string;
  at: number;
}

interface SentEntry { messageId: string; ref: string; kind: RelayKind; projectPath: string; at: number }
interface Waiting { id: string; message: RelayMessage; queuedAt: number; expiresAt: number }
interface PluginReply {
  seq: number; at: number; kind: 'reply' | 'project'; ref: string; project: string;
  message_id: string; reply_to_message_id: string; text: string;
}

const ROUTES = '/api/plugins/tars-relay';
export const POLL_MS = 5_000;
const SENT_KEPT_MS = 30 * 24 * 3_600_000;
const WAIT_BY_DEFAULT_MS = 3_600_000;
const TELEGRAM_MAX_UNITS = 4096;
/** A project's name as the plugin takes it after "@" (hermes-plugins/tars-relay, relay_core.py): one word, no
 * control character; at most MAX_PROJECTS of them. */
const PROJECT_WORD = /^[^\s@:,\x00-\x1f\x7f-\x9f]{1,64}$/u;
const MAX_PROJECTS = 500;
const FILES = {
  sent: () => privatePath('relay-sent.json'),
  waiting: () => privatePath('relay-outbox.json'),
  cursor: () => privatePath('relay-state.json'),
};

const STATE_WORDS: Record<RelayState, string> = {
  off: 'The relay to the user\'s Telegram through Hermes is off in Tars (Settings, Hermes).',
  ready: 'ready',
  unreachable: 'Hermes did not answer.',
  'not-configured': 'The tars-relay plugin on the Hermes server has no user id in its settings.',
  'plugin-missing': 'The tars-relay plugin is not installed on the Hermes server.',
  unauthorized: 'Hermes refused the dashboard token.',
  'no-connection': 'No Hermes connection is saved in Settings, Hermes.',
};

let enabled: () => boolean = () => false;
let timer: NodeJS.Timeout | undefined;
let ticking = false;
let channelOn = false;
const status: RelayStatus = { enabled: false, state: 'off', waiting: 0 };
const replyHandlers = new Map<string, (reply: RelayReply, now: number) => void | Promise<void>>();
let projectHandler: ((message: RelayProjectMessage, now: number) => void | Promise<void>) | null = null;
let projectsOf: () => string[] = () => [];
let registrationRefused = '';
const statusListeners = new Set<(status: RelayStatus) => void>();

function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function write(file: string, value: unknown): void {
  try {
    writeSecretFileSync(file, JSON.stringify(value));
  } catch (err) {
    console.error(`[relay] could not record ${file}:`, err instanceof Error ? err.message : err);
  }
}

/** The project as the one word the plugin takes. */
function projectWord(projectPath: string | undefined): string {
  return projectPath ? projectWordOf(projectPath) : '';
}

function setStatus(change: Partial<RelayStatus>): void {
  const before = JSON.stringify(status);
  Object.assign(status, change, { enabled: enabled(), waiting: read<Waiting[]>(FILES.waiting(), []).length });
  if (JSON.stringify(status) !== before) for (const listener of statusListeners) listener({ ...status });
}

/** The relay as the Settings page shows it. */
export function relayStatus(): RelayStatus {
  return { ...status, enabled: enabled(), waiting: read<Waiting[]>(FILES.waiting(), []).length };
}

export function onRelayStatus(listener: (status: RelayStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function relayEnabled(): boolean {
  return enabled();
}

/** The handler of the replies to messages whose ref is `<type>:...`. */
export function onRelayReply(type: string, handler: (reply: RelayReply, now: number) => void | Promise<void>): void {
  replyHandlers.set(type, handler);
}

export function onRelayProjectMessage(handler: (message: RelayProjectMessage, now: number) => void | Promise<void>): void {
  projectHandler = handler;
}

/** The names of the projects "@name" may address: the routing's, read at every round. */
export function setRelayProjects(list: () => string[]): void {
  projectsOf = list;
}

/** Whether a message with this ref went out, as far as Tars's own list says. */
export function relayWasSent(ref: string): boolean {
  return read<SentEntry[]>(FILES.sent(), []).some(entry => entry.ref === ref);
}

type Answer = { status: number; body: unknown };

async function call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<Answer> {
  const conn = usableHermesConnection();
  if (!conn) throw Object.assign(new Error(STATE_WORDS['no-connection']), { relayState: 'no-connection' as RelayState });
  return hermesRequest(resolveHermesBaseUrl(conn), `${ROUTES}/${route}`, { method, body, token: sessionToken(conn), timeoutMs: 10_000 });
}

/** What an answer, or the lack of one, says about the relay. */
function stateOf(answer: Answer | null, err?: unknown): RelayState {
  if (!answer) return (err as { relayState?: RelayState } | undefined)?.relayState ?? 'unreachable';
  if (answer.status === 404) return 'plugin-missing';
  if (answer.status === 401 || answer.status === 403) return 'unauthorized';
  if (answer.status === 503) return 'not-configured';
  if (answer.status >= 500) return 'unreachable';
  return 'ready';
}

/** One attempt at the plugin's /send; what came back, and the message id when it went. */
async function trySend(message: RelayMessage, now: number): Promise<{ messageId?: string; state: RelayState; refused?: string }> {
  let answer: Answer | null = null;
  try {
    answer = await call('POST', 'send', { text: message.text, kind: message.kind, ref: message.ref, project: projectWord(message.projectPath) });
  } catch (err) {
    return { state: stateOf(null, err) };
  }
  if (answer.status === 400) {
    const detail = (answer.body as { detail?: unknown } | null)?.detail;
    return { state: 'ready', refused: `The tars-relay plugin refused the message: ${typeof detail === 'string' ? detail : 'HTTP 400'}` };
  }
  const messageId = (answer.body as { message_id?: unknown } | null)?.message_id;
  if (answer.status >= 300 || (typeof messageId !== 'string' && typeof messageId !== 'number')) {
    return { state: answer.status === 429 ? 'ready' : stateOf(answer) };
  }
  const sent = read<SentEntry[]>(FILES.sent(), []).filter(entry => entry.at > now - SENT_KEPT_MS);
  sent.push({ messageId: String(messageId), ref: message.ref, kind: message.kind, projectPath: message.projectPath ?? '', at: now });
  write(FILES.sent(), sent);
  return { messageId: String(messageId), state: 'ready' };
}

/**
 * Sends to the user through Hermes. A send Hermes cannot take now waits, and its caller is told it has not gone; one
 * the plugin refuses (too long, malformed) does not wait.
 */
export async function relaySend(message: RelayMessage, now: number = Date.now()): Promise<RelaySendResult> {
  if (!enabled()) return { state: 'refused', reason: STATE_WORDS.off };
  if (!message.text.trim()) return { state: 'refused', reason: 'Nothing to send.' };
  if (Buffer.byteLength(message.text, 'utf16le') / 2 > TELEGRAM_MAX_UNITS) {
    return { state: 'refused', reason: `Longer than Telegram takes (${TELEGRAM_MAX_UNITS} characters).` };
  }
  const attempt = await trySend(message, now);
  if (attempt.refused) return { state: 'refused', reason: attempt.refused };
  if (attempt.messageId) {
    setStatus({ state: 'ready', lastSentAt: new Date(now).toISOString(), lastError: undefined });
    return { state: 'sent', messageId: attempt.messageId };
  }
  const waiting = read<Waiting[]>(FILES.waiting(), []);
  waiting.push({ id: randomUUID(), message, queuedAt: now, expiresAt: message.expiresAt ?? now + WAIT_BY_DEFAULT_MS });
  write(FILES.waiting(), waiting);
  setStatus({ state: attempt.state, lastError: STATE_WORDS[attempt.state] });
  return { state: 'queued', reason: `${STATE_WORDS[attempt.state]} The message waits, and goes when Hermes takes it.` };
}

/** A word from Tars to the user, about something they wrote. A reply to it reaches nobody. */
export function tellUser(text: string, projectPath?: string, now: number = Date.now()): Promise<RelaySendResult> {
  return relaySend({ text, kind: 'report', ref: `notice:${randomUUID()}`, projectPath }, now);
}

/** The event reports' channel while the relay is on: each report a message of its project. */
export const relayReportChannel: ReportChannel = {
  async send(text: string, projectPath: string): Promise<boolean> {
    const result = await relaySend({ text, kind: 'report', ref: `report:${randomUUID()}`, projectPath });
    return result.state !== 'refused';
  },
};

/** The reports follow the switch: on, they go through the relay; off, they are dropped, not kept. */
function syncChannels(): void {
  const on = enabled();
  if (on === channelOn) return;
  channelOn = on;
  setReportChannel(on ? relayReportChannel : null);
}

/** The names the plugin may take: one word each, once each, sorted, at most MAX_PROJECTS. */
function projectWords(): string[] {
  return [...new Set(projectsOf().filter(name => PROJECT_WORD.test(name)))].sort().slice(0, MAX_PROJECTS);
}

/** Tells the plugin the projects "@name" may address when those it lists are not them, in any case. */
async function registerProjects(listed: unknown): Promise<void> {
  const words = projectWords();
  const folded = (names: string[]) => [...new Set(names.map(name => name.toLowerCase()))].sort().join('\n');
  if (Array.isArray(listed) && listed.every(name => typeof name === 'string') && folded(listed) === folded(words)) return;
  let refused = '';
  try {
    const answer = await call('POST', 'projects', { projects: words });
    if (answer.status !== 200) refused = `HTTP ${answer.status}`;
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  // Said once, not at every round: the next round tries again.
  if (refused && refused !== registrationRefused) console.warn(`[relay] the plugin did not take Tars's projects: ${refused}`);
  registrationRefused = refused;
}

async function flushWaiting(now: number): Promise<void> {
  let waiting = read<Waiting[]>(FILES.waiting(), []);
  const due = waiting.filter(w => w.expiresAt > now);
  if (due.length !== waiting.length) {
    waiting = due;
    write(FILES.waiting(), waiting);
  }
  for (const entry of [...waiting]) {
    const attempt = await trySend(entry.message, now);
    if (!attempt.messageId && !attempt.refused) break;
    waiting = waiting.filter(w => w.id !== entry.id);
    write(FILES.waiting(), waiting);
    if (attempt.messageId) setStatus({ lastSentAt: new Date(now).toISOString() });
  }
}

async function handle(reply: PluginReply, now: number): Promise<void> {
  const at = Math.round(Number(reply.at) * 1000) || now;
  if (reply.kind === 'project') {
    if (!projectHandler) {
      await tellUser('Tars takes no "@project" messages right now, so yours reached nobody.', undefined, now);
      return;
    }
    await projectHandler({ seq: reply.seq, project: reply.project, text: reply.text, at }, now);
    return;
  }
  // Tars's own list decides, never the ref the plugin hands back.
  const sent = read<SentEntry[]>(FILES.sent(), []).find(entry => entry.messageId === String(reply.reply_to_message_id) && entry.at > now - SENT_KEPT_MS);
  if (!sent) {
    await tellUser('Tars did not send the message you replied to, so your reply reached nobody.', undefined, now);
    return;
  }
  const split = sent.ref.indexOf(':');
  const refType = split < 0 ? sent.ref : sent.ref.slice(0, split);
  const handler = replyHandlers.get(refType);
  if (!handler) {
    await tellUser('Nothing waits for a reply to that message any more, so yours reached nobody.', sent.projectPath, now);
    return;
  }
  await handler({
    seq: reply.seq, refType, refId: split < 0 ? '' : sent.ref.slice(split + 1), ref: sent.ref, kind: sent.kind,
    projectPath: sent.projectPath, text: reply.text, sentAt: sent.at, at,
  }, now);
}

/**
 * The user's receipt for a message of theirs handed on (JeanBrasse's answer 24 of
 * 2026-10-05): one short line, never a reaction; when the message waits,
 * what for.
 */
export function receiptFor(name: string, heldBy?: 'dialog' | 'draft'): string {
  if (heldBy === 'dialog') return `Passed to ${name}: it waits for the permission or question its CLI shows to be answered.`;
  if (heldBy === 'draft') return `Passed to ${name}: it waits for what is typed in its terminal to be sent or cleared.`;
  return `Passed to ${name}.`;
}

/** One round: the plugin's status, the projects, what waits, the replies. Driven every POLL_MS; tests drive it. */
export async function relayTick(now: number = Date.now()): Promise<void> {
  syncChannels();
  if (!enabled()) {
    setStatus({ state: 'off', lastError: undefined });
    return;
  }
  if (ticking) return;
  ticking = true;
  try {
    let answer: Answer | null = null;
    try {
      answer = await call('GET', 'status');
    } catch (err) {
      setStatus({ state: stateOf(null, err), lastError: STATE_WORDS[stateOf(null, err)], checkedAt: new Date(now).toISOString() });
      return;
    }
    const state = stateOf(answer) === 'ready' && (answer.body as { configured?: unknown } | null)?.configured === false
      ? 'not-configured'
      : stateOf(answer);
    setStatus({ state, lastError: state === 'ready' ? undefined : STATE_WORDS[state], checkedAt: new Date(now).toISOString() });
    if (state !== 'ready') return;

    await registerProjects((answer.body as { projects?: unknown } | null)?.projects);
    await flushWaiting(now);

    // Every reply the plugin still holds: one taken before an ack was lost comes back, and is acked, not handed over.
    let replies: PluginReply[] = [];
    let storeId: string | undefined;
    try {
      const held = (await call('GET', 'replies?after=0')).body as { replies?: PluginReply[]; store_id?: unknown } | null;
      replies = (held?.replies ?? []).slice().sort((a, b) => a.seq - b.seq);
      storeId = typeof held?.store_id === 'string' && held.store_id ? held.store_id : undefined;
    } catch {
      return;
    }
    if (replies.length === 0) return;
    const position = read<{ cursor?: number; storeId?: string }>(FILES.cursor(), {});
    // Another store than the one the position was taken in: its numbers are its own, from 1.
    let cursor = storeId && position.storeId !== storeId ? 0 : position.cursor ?? 0;
    for (const reply of replies) {
      if (reply.seq <= cursor) continue;
      try {
        await handle(reply, now);
      } catch (err) {
        console.error('[relay] a reply could not be handled:', err instanceof Error ? err.message : err);
      }
      cursor = reply.seq;
      write(FILES.cursor(), { cursor, storeId: storeId ?? position.storeId });
      setStatus({ lastReplyAt: new Date(now).toISOString() });
    }
    try {
      await call('POST', 'ack', { through: replies[replies.length - 1].seq });
    } catch {
      // Acked at the next round: what is held again is not handed over twice.
    }
  } finally {
    ticking = false;
  }
}

/** Starts the relay's rounds, following `enabled` live. `pollMs` 0 starts none (tests drive relayTick). */
export function startHermesRelay(opts: { enabled: () => boolean; pollMs?: number }): void {
  stopHermesRelay();
  enabled = opts.enabled;
  syncChannels();
  setStatus({ state: enabled() ? status.state : 'off' });
  const every = opts.pollMs ?? POLL_MS;
  if (every > 0) {
    timer = setInterval(() => { void relayTick(); }, every);
    timer.unref?.();
  }
}

export function stopHermesRelay(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  enabled = () => false;
  syncChannels();
}
