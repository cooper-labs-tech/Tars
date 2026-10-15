import { v4 as uuidv4 } from 'uuid';
import { usableHermesConnection } from './hermes-config';
import {
  LiveSession,
  askLiveSession,
  createLiveSession,
  liveTransportAvailable,
} from './hermes-session';
import {
  probeHermes,
  createHermesCron,
  updateHermesCron,
  hermesCronAction,
  fetchHermesCronRuns,
  fetchHermesSessionMessages,
} from './hermes-client';
import { HermesConnection } from '../types/hermes';
import { loadState, rememberHermesSessions, saveState, type OverseerAttachment, type OverseerMessage, type OverseerState } from './overseer-store';
import { buildFleetSnapshot } from './overseer-fleet';
import { composeTurn } from './overseer-prompt';
import { finishTurn } from './overseer-gate';

// ── Talking to Hermes ────────────────────────────────────────────────────

const OVERSEER_JOB_NAME = 'tars-overseer';

const RUN_POLL_INTERVAL_MS = 3000;
// The probed gateway round-trips a triggered job in about 30s; give it double.
const RUN_POLL_TIMEOUT_MS = 60_000;

async function ensureOverseerJob(
  conn: HermesConnection,
  state: OverseerState,
): Promise<{ jobId: string } | { error: string; needsSignIn?: boolean }> {
  if (state.jobId) {
    // Trust the stored id until a call against it proves it gone (askOverseer
    // recreates on a "not found" PUT) - checking on every turn would cost a
    // round trip for the common case where nothing changed.
    return { jobId: state.jobId };
  }
  // The schedule only has to be syntactically valid, not meaningful: Tars
  // never lets the gateway's own scheduler fire this job, it always drives
  // it by hand (PUT prompt, then POST /trigger - see askOverseer). It MUST
  // be a real cron expression, not an ISO date string: verified against the
  // live gateway that a plain date is treated as one-shot and the job is
  // marked "completed" and deleted (404s on the next GET) the moment it is
  // triggered - even manually - which forced a brand new job to be created
  // on every single turn. "0 3 1 1 *" (once a year, Jan 1st 03:00) keeps the
  // job "scheduled" indefinitely after a manual trigger, confirmed live, so
  // the standing job this function's caller relies on actually stands.
  const created = await createHermesCron(conn, {
    name: OVERSEER_JOB_NAME,
    schedule: '0 3 1 1 *',
    prompt: '(idle - Tars overwrites this prompt before every trigger)',
    model: state.settings.model || undefined,
    provider: state.settings.provider || undefined,
  });
  if (!created.success) return { error: created.error, needsSignIn: created.needsSignIn };
  const jobId = typeof created.job?.id === 'string' ? created.job.id : '';
  if (!jobId) return { error: 'Hermes created the job but returned no id.' };
  state.jobId = jobId;
  saveState(state);
  return { jobId };
}

/** A run id looks like cron_{jobId}_{YYYYMMDD}_{HHMMSS}; recover the instant
 *  it was created so a fresh trigger can be matched against stale runs. */
function runCreatedAtMs(runId: string): number | null {
  const m = runId.match(/_(\d{8})_(\d{6})$/);
  if (!m) return null;
  const [, ymd, hms] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type AskOverseerResult =
  | { ok: true; message: OverseerMessage }
  | { ok: false; reason: 'not_configured' | 'gateway_unreachable' | 'needs_sign_in' | 'run_timeout' | 'busy' | 'error'; error: string };

let turnInFlight = false;
/** Set by pause, read by the poll loop, cleared by resume and by every new
 *  turn. A turn already running gives up at its next poll. */
let abortTurn = false;

export function isOverseerBusy(): boolean {
  return turnInFlight;
}

/**
 * One full turn: compose the prompt, push it to Hermes, poll for the run it
 * creates, and read the answer back. Handles every failure mode called out
 * in the task this was built from: gateway down, not signed in, the job
 * missing (recreated once), a run that never appears (times out, says so),
 * and a reply that isn't valid JSON (falls back to prose, no action).
 */
/**
 * The message as the model should read it: what was typed, with any attached
 * files named above it by their path on the gateway.
 *
 * Paths rather than contents. The gateway's agent has file tools, so it can
 * open what it needs, more than once, without a megabyte of base64 having to
 * survive the prompt.
 */
function withAttachmentPaths(text: string, attachments: OverseerAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return text;
  const lines = attachments.map(a => `- ${a.path}${a.isImage ? ' (image)' : ''}`);
  return `Files attached to this message, on your filesystem:\n${lines.join('\n')}\n\n${text}`;
}

export async function askOverseer(
  userMessage: string,
  opts: { isBriefing?: boolean; attachments?: OverseerAttachment[] } = {},
): Promise<AskOverseerResult> {
  if (turnInFlight) {
    return { ok: false, reason: 'busy', error: 'The overseer is already handling another turn; try again in a moment.' };
  }
  turnInFlight = true;
  abortTurn = false;
  try {
    const conn = usableHermesConnection();
    if (!conn) {
      return { ok: false, reason: 'not_configured', error: 'Hermes is not configured. Set it up in Settings → Hermes.' };
    }

    const probe = await probeHermes(conn);
    if (!probe.reachable) {
      return { ok: false, reason: 'gateway_unreachable', error: probe.error || 'The Hermes gateway is not reachable.' };
    }
    if (probe.authRequired && !probe.signedIn) {
      return { ok: false, reason: 'needs_sign_in', error: 'Sign in to Hermes in Settings to use the overseer.' };
    }

    const state = loadState();

    // Recorded before the round trip, not after it. It used to be pushed with
    // the reply, thirty seconds later, so anything that read the history in
    // between - another window, or this page after you navigated away and
    // back - saw a conversation that did not contain what you had just sent.
    if (!opts.isBriefing) {
      state.messages.push({
        id: uuidv4(),
        role: 'user',
        text: userMessage,
        action: null,
        timestamp: new Date().toISOString(),
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      });
      saveState(state);
    }

    const snapshot = await buildFleetSnapshot();
    const prompt = composeTurn(
      snapshot,
      state.messages,
      withAttachmentPaths(userMessage, opts.attachments),
      opts,
    );

    // The live conversation first. It is what the gateway's own dashboard
    // uses, it answers in about nine seconds rather than thirty, and it does
    // not need a cron job to exist at all. Everything below it is the fallback
    // for a gateway that will not open a socket.
    const liveReply = await askViaLiveSession(conn, prompt);
    if (liveReply.aborted) {
      return { ok: false, reason: 'error', error: 'Stopped: you paused the overseer while it was answering.' };
    }
    if (liveReply.text !== null) {
      return finishTurn(state, liveReply.text, opts);
    }

    // Only now is a cron job worth creating: an install that never falls back
    // never grows one.
    let jobResult = await ensureOverseerJob(conn, state);
    if ('error' in jobResult) {
      return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
    }
    let jobId = jobResult.jobId;

    // Sent on every turn rather than only at creation: the job is long-lived
    // and a model chosen in the Chat header has to reach a job that already
    // exists, which is every case after the first turn.
    const runOn = {
      ...(state.settings.model ? { model: state.settings.model } : {}),
      ...(state.settings.provider ? { provider: state.settings.provider } : {}),
    };
    let update = await updateHermesCron(conn, jobId, { prompt, ...runOn });
    if (!update.success && /not found|no such job|404/i.test(update.error || '')) {
      // The job was deleted out from under us (by hand, or gateway-side):
      // forget the stale id and create a replacement, once.
      state.jobId = null;
      jobResult = await ensureOverseerJob(conn, state);
      if ('error' in jobResult) {
        return { ok: false, reason: jobResult.needsSignIn ? 'needs_sign_in' : 'error', error: jobResult.error };
      }
      jobId = jobResult.jobId;
      update = await updateHermesCron(conn, jobId, { prompt, ...runOn });
    }
    if (!update.success) {
      return { ok: false, reason: update.needsSignIn ? 'needs_sign_in' : 'error', error: update.error || 'Could not send the prompt to Hermes.' };
    }

    const triggeredAt = Date.now();
    const trigger = await hermesCronAction(conn, 'trigger', jobId);
    if (!trigger.success) {
      return { ok: false, reason: 'error', error: trigger.error || 'Could not trigger the overseer job.' };
    }

    // The run record appears in /runs the instant the job is triggered - well
    // before the model has actually replied, since generation (confirmed
    // against the real gateway: several seconds with reasoning effort "high")
    // happens after that. So finding a "fresh" run is not the same as the run
    // having an answer yet: keep polling the transcript itself, not just the
    // run's existence, until either an assistant message shows up or the
    // deadline passes.
    let runId: string | null = null;
    let assistantMsg: { role: string; content: string } | undefined;
    const deadline = triggeredAt + RUN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
      if (abortTurn) {
        return { ok: false, reason: 'error', error: 'Stopped: you paused the overseer while it was answering.' };
      }

      if (!runId) {
        const runs = await fetchHermesCronRuns(conn, jobId, { limit: 3 });
        if (runs.success) {
          // 15s of slack for clock skew between this machine and the gateway.
          const fresh = runs.runs.find(r => {
            const createdAt = runCreatedAtMs(r.id);
            return createdAt !== null && createdAt >= triggeredAt - 15_000;
          });
          if (fresh) {
            runId = fresh.id;
            rememberHermesSessions(runId);
          }
        }
        if (!runId) continue;
      }

      const transcript = await fetchHermesSessionMessages(conn, runId);
      if (!transcript.success) {
        if (transcript.needsSignIn) {
          return { ok: false, reason: 'needs_sign_in', error: transcript.error };
        }
        // Transient read failure - keep polling rather than failing the
        // whole turn on one bad response.
        continue;
      }
      assistantMsg = [...transcript.messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
      if (assistantMsg) break;
    }
    if (!runId) {
      return { ok: false, reason: 'run_timeout', error: 'The overseer did not answer in time: no run appeared for this trigger.' };
    }
    if (!assistantMsg) {
      return { ok: false, reason: 'run_timeout', error: 'The overseer run did not answer in time.' };
    }

    return finishTurn(state, assistantMsg.content, opts);
  } finally {
    turnInFlight = false;
  }
}

/* ── The live conversation ───────────────────────────────────────────────── */

/** Held between turns, so the conversation is one session rather than a new
 *  one per message. Dropped whenever a turn fails against it, so the next turn
 *  reconnects instead of retrying a socket the gateway has forgotten. */
let liveSession: LiveSession | null = null;
let liveControl: WebSocket | null = null;

/** Set once the gateway has refused to open a socket, so an install that
 *  genuinely has no live transport does not pay for the attempt on every
 *  single turn. Cleared whenever the connection settings change. */
let liveUnavailable = false;

export function resetLiveSession(): void {
  try { liveControl?.close(); } catch { /* already gone */ }
  liveSession = null;
  liveControl = null;
  liveUnavailable = false;
}

/**
 * Ask over the live conversation, or report that it could not be used.
 *
 * `text: null` is not a failure, it is "fall back to the cron": the caller
 * carries on down the old path. Only an abort is distinguished, because a
 * paused overseer must not then be asked the same question again by the
 * fallback.
 */
async function askViaLiveSession(
  conn: HermesConnection,
  prompt: string,
): Promise<{ text: string | null; aborted: boolean }> {
  if (liveUnavailable || !liveTransportAvailable()) return { text: null, aborted: false };

  try {
    if (!liveSession) {
      const opened = await createLiveSession(conn);
      liveSession = opened.session;
      liveControl = opened.control;
      // Its turns are JeanBrasse's conversation: memory_search leaves them out.
      rememberHermesSessions(opened.session.sessionId, opened.session.storedSessionId);
    }
  } catch (err) {
    console.error('[overseer] no live session, falling back to the cron transport:', err);
    liveUnavailable = true;
    return { text: null, aborted: false };
  }

  const result = await askLiveSession(conn, liveSession, prompt, {
    signal: { get aborted() { return abortTurn; } },
  });

  if (result.ok) return { text: result.envelope, aborted: false };
  if (result.error === 'aborted') return { text: null, aborted: true };

  // The session is suspect now: drop it so the next turn opens a fresh one.
  console.error('[overseer] live turn failed, falling back to the cron transport:', result.error);
  try { liveControl?.close(); } catch { /* already gone */ }
  liveSession = null;
  liveControl = null;
  return { text: null, aborted: false };
}

/**
 * Pause the watch, and give up on any turn already running.
 *
 * Pausing used to set a flag the next tick would read, which did nothing at
 * all to a reply already in flight: Hermes kept working and the answer landed
 * in the chat minutes after you had asked it to stop. Worse when the turn was
 * wedged, since pause was the obvious thing to press and the only thing that
 * did not help.
 *
 * The poll loop checks this on every pass, so the turn ends at the next poll
 * rather than at its timeout. The Hermes run itself is already triggered and
 * will finish on the gateway; what stops is Tars waiting for it and posting
 * the result.
 */
export function pauseOverseerWatch(): void {
  const state = loadState();
  state.paused = true;
  saveState(state);
  abortTurn = true;
}

export function resumeOverseerWatch(): void {
  const state = loadState();
  state.paused = false;
  saveState(state);
  abortTurn = false;
}

export function isOverseerWatchPaused(): boolean {
  return loadState().paused;
}
