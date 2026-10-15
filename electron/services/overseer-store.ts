import * as fs from 'fs';
import { privatePath, OVERSEER_FILE, OVERSEER_LEGACY_FILE } from '../constants';
import { writeSecretFileSync, describeSecretFileError } from '../utils/secret-file';
import { isTemplateEcho } from './overseer-envelope';
import type { FleetSnapshot } from './overseer-fleet';

// ── Persistence ─────────────────────────────────────────────────────────
// Conversation + job id live in ~/.tars-private/overseer.json, written
// atomically at 0600.
//
// They lived in ~/.dorothy/overseer.json, which is the directory every agent
// is started with (`--add-dir ~/.dorothy`), at 0644: 146 KB and 344 messages
// of JeanBrasse's own conversation, reachable with an `ls` and a `cat`, no API call
// and no token. The file moves out on the first start that finds it, and
// nothing in the private directory is ever handed to a CLI. See PRIVATE_DIR
// for what that does and does not close.

export interface OverseerAction {
  actionId: string;
  agentId: string;
  agentName: string;
  projectPath: string;
  provider: string;
  model?: string;
  pane: string;
  text: string;
  /** ISO timestamp of the resolveTarget() call this action was built from -
   *  the UI shows "resolved Ns ago" from this so approving something stale
   *  is a visible choice, not a silent one. */
  resolvedAt: string;
}

/** A file already on the gateway, named by the message that sent it. */
export interface OverseerAttachment {
  name: string;
  path: string;
  isImage: boolean;
}

export interface OverseerMessage {
  id: string;
  role: 'user' | 'overseer';
  text: string;
  action: OverseerAction | null;
  isBriefing?: boolean;
  timestamp: string;
  /** Files sent with this message. Kept beside the text rather than inside it
   *  so the bubble can show a chip and the text stays what was typed. */
  attachments?: OverseerAttachment[];
  /**
   * Set on read when this reply looks like the format template rather than an
   * answer. Never stored: it is recomputed from the text every time, so a
   * later, better rule re-judges old messages instead of inheriting the
   * verdict of the rule that happened to be shipped when they arrived.
   */
  templateEcho?: boolean;
}

export interface OverseerState {
  jobId: string | null;
  messages: OverseerMessage[];
  previousSnapshot: FleetSnapshot | null;
  /** Agent ids already flagged as "running unusually long" for their current
   *  run, so watchTick doesn't re-flag the same agent every 5 minutes. */
  longRunningReported: string[];
  paused: boolean;
  settings: OverseerSettings;
}

/**
 * What the overseer runs on, and how often it looks.
 *
 * All three were constants. The watch interval was a fixed five minutes, which
 * is too eager for a fleet left running overnight and too slow when you are
 * watching a migration land; and the model was whatever the Hermes gateway
 * happened to have selected globally, which on a fresh install is a small fast
 * one. Reading a fleet and reasoning about what its agents are doing is the one
 * job here, so it is worth being able to point it at a better model.
 *
 * An empty model or provider means "whatever the gateway is set to", which is
 * the behaviour every existing install already has.
 */
export interface OverseerSettings {
  watchIntervalMs: number;
  /** Ids of the auto-action rules turned on. Empty by default: every proposal
   *  waits for JeanBrasse unless he has said in advance that this kind need not. */
  autoActions: string[];
  model: string;
  provider: string;
}

/** How often the watch looks at the fleet when nothing overrides it. */
export const DEFAULT_WATCH_INTERVAL_MS = 5 * 60 * 1000;

/** 1 minute floor, 6 hour ceiling. Below a minute the fleet cannot have changed
 *  meaningfully and every tick costs a Hermes run; above six hours the watch is
 *  not a watch. */
export const MIN_WATCH_INTERVAL_MS = 60 * 1000;
export const MAX_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function defaultSettings(): OverseerSettings {
  return { watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS, model: '', provider: '', autoActions: [] };
}

function defaultState(): OverseerState {
  return { jobId: null, messages: [], previousSnapshot: null, longRunningReported: [], paused: false, settings: defaultSettings() };
}

/**
 * Move the conversation out of the directory the agents are handed, once per
 * run of the app, before anything reads or writes it.
 *
 * It is JeanBrasse's data, so the order is: write the new file and read it back
 * whole, and only then let go of the old one. A migration that cannot finish
 * leaves the old file exactly as it was, and stateFile() below goes on reading
 * it, so the worst case is the state before this existed rather than an empty
 * chat.
 *
 * Both files at once means one of two things, and neither may lose a message:
 * a migration interrupted between the copy and the delete, or an older build
 * run afterwards, which would have started a fresh file in the old place and
 * written into it. The new file wins either way - adopting the older build's
 * file would hide the whole history behind the few lines it holds - and the
 * old one is moved into the private directory rather than deleted, so its
 * bytes survive out of the agents' way.
 */
let migrationAttempted = false;

export function migrateOverseerOutOfAgentReach(): void {
  migrateOutOfAgentReach();
}

function migrateOutOfAgentReach(): void {
  if (migrationAttempted) return;
  migrationAttempted = true;
  try {
    if (!fs.existsSync(OVERSEER_LEGACY_FILE)) return;

    if (fs.existsSync(OVERSEER_FILE)) {
      const aside = privatePath(`overseer.superseded-${Date.now()}.json`);
      fs.mkdirSync(privatePath(), { recursive: true, mode: 0o700 });
      fs.renameSync(OVERSEER_LEGACY_FILE, aside);
      console.log(`[overseer] an older conversation file was still in the data directory; kept at ${aside}`);
      return;
    }

    const raw = fs.readFileSync(OVERSEER_LEGACY_FILE, 'utf-8');
    // A file that does not parse is not the state, and copying it would only
    // move the problem. Left where it is for loadState to fail over.
    JSON.parse(raw);
    // Makes the private directory too, at 0700, as every save does.
    writeSecretFileSync(OVERSEER_FILE, raw);
    if (fs.readFileSync(OVERSEER_FILE, 'utf-8') !== raw) {
      // Never delete against a copy that did not land. The half-written file
      // goes, the original stays, and the next start tries again.
      fs.rmSync(OVERSEER_FILE, { force: true });
      console.error('[overseer] the conversation did not copy across; left where it was');
      return;
    }
    fs.unlinkSync(OVERSEER_LEGACY_FILE);
    console.log('[overseer] conversation moved out of the directory the agents are handed');
  } catch (err) {
    console.error(`[overseer] could not move the conversation out of the data directory: ${describeSecretFileError(err)}`);
  }
}

/** The private file, or the old one when the migration could not be made. */
function stateFile(): string {
  if (fs.existsSync(OVERSEER_FILE)) return OVERSEER_FILE;
  return fs.existsSync(OVERSEER_LEGACY_FILE) ? OVERSEER_LEGACY_FILE : OVERSEER_FILE;
}

export function loadState(): OverseerState {
  migrateOutOfAgentReach();
  try {
    const file = stateFile();
    if (!fs.existsSync(file)) return defaultState();
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Spreading `raw` over the defaults is a shallow merge, so a state file
    // written before settings existed - or one holding only some of them -
    // would otherwise arrive with `settings` undefined and crash the callers.
    return {
      ...defaultState(),
      ...raw,
      settings: { ...defaultSettings(), ...(raw?.settings ?? {}) },
    };
  } catch (err) {
    // Never `err` itself: Node quotes the input in a JSON.parse message, and
    // the input here is JeanBrasse's conversation.
    console.error(`[overseer] could not read the conversation (${describeSecretFileError(err)}), starting fresh`);
    return defaultState();
  }
}

export function saveState(state: OverseerState): void {
  migrateOutOfAgentReach();
  const body = JSON.stringify(state, null, 2);
  try {
    writeSecretFileSync(OVERSEER_FILE, body);
  } catch (err) {
    // The private directory could not be written. Losing what JeanBrasse just said
    // would be the worse failure, so it goes back to the old place and says
    // so; the next start finds it there and migrates it again.
    console.error(`[overseer] could not write the private conversation file (${describeSecretFileError(err)}); falling back to the data directory`);
    try {
      writeSecretFileSync(OVERSEER_LEGACY_FILE, body);
      migrationAttempted = false;
    } catch (fallbackErr) {
      console.error(`[overseer] could not persist the conversation at all: ${describeSecretFileError(fallbackErr)}`);
    }
  }
}

/**
 * The conversation, with the replies that look like the format template
 * flagged rather than removed.
 *
 * This used to drop them from disk on load, which was wrong twice over: the
 * loop is already broken by serializeHistory refusing to quote an echo back
 * to the model, so deleting bought nothing, and a heuristic that writes to
 * disk turns each of its own mistakes into permanent data loss. It flags
 * instead. The interface can hide a flagged message; nothing can lose one.
 */
export function getOverseerHistory(): OverseerMessage[] {
  return loadState().messages.map(m => (
    m.role === 'overseer' && isTemplateEcho(m.text) ? { ...m, templateEcho: true } : m
  ));
}

/**
 * Throw the conversation away and start a fresh one.
 *
 * The load-time purge handles the one failure that has actually happened, but
 * it only knows that shape. The conversation is the model's own context, so
 * anything that gets stuck in it stays stuck until something can empty it,
 * and without this the only way out of the next such loop would be another
 * release. Settings, the standing job and the fleet baseline are kept: this
 * clears what was said, not how the overseer is set up.
 */
export function clearOverseerHistory(): { cleared: number } {
  const state = loadState();
  const cleared = state.messages.length;
  if (cleared === 0) return { cleared: 0 };
  state.messages = [];
  saveState(state);
  return { cleared };
}

/* ── The super chat's own Hermes sessions ────────────────────────────────── */

/**
 * Every Hermes session the super chat has opened, so that what searches
 * Hermes for an agent can leave them out: that conversation is JeanBrasse's, kept in
 * this private directory and never handed to an agent (SECURITY.md §5), and
 * each of its turns is a Hermes session that memory_search returned with the
 * rest (the Audit's table on a3d7c125, #13).
 *
 * A file of its own, beside the conversation, and not a field of the state: a
 * turn loads the state when it starts and saves it when it ends, so an id
 * written in between would be lost. The runs of its cron job are left out by
 * their name (`cron_<jobId>_...`), and recorded here too, in case the job is
 * ever replaced.
 */
const HERMES_SESSIONS_FILE = privatePath('overseer-hermes-sessions.json');
const MAX_REMEMBERED_SESSIONS = 5000;

function readHermesSessions(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(HERMES_SESSIONS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberHermesSessions(...ids: Array<string | null | undefined>): void {
  const known = readHermesSessions();
  const fresh = ids.filter((id): id is string => !!id && !known.includes(id));
  if (fresh.length === 0) return;
  try {
    writeSecretFileSync(HERMES_SESSIONS_FILE, JSON.stringify([...known, ...fresh].slice(-MAX_REMEMBERED_SESSIONS)));
  } catch (err) {
    console.error(`[overseer] could not record its Hermes session (${describeSecretFileError(err)})`);
  }
}

/** Whether this Hermes session is one of the super chat's. */
export function isOverseerHermesSession(sessionId: string): boolean {
  const jobId = loadState().jobId;
  if (jobId && sessionId.startsWith(`cron_${jobId}_`)) return true;
  return readHermesSessions().includes(sessionId);
}
