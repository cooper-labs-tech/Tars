import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { agents } from '../core/agent-manager';
import { AgentStatus } from '../types';
import { API_PORT } from '../constants';
import { internalToken } from '../core/agent-tokens';
import { findAutoRule } from './overseer-auto';
import { isSameThingSaidAgain, isTemplateEcho, parseEnvelope } from './overseer-envelope';
import { loadState, saveState, type OverseerAction, type OverseerMessage, type OverseerState } from './overseer-store';
import type { AskOverseerResult } from './overseer-turn';

// ── The write gate ───────────────────────────────────────────────────────
// See the header of overseer.ts. Every function below resolves against the LIVE
// `agents` map at call time - never against a snapshot the model was shown,
// which may already be stale by the time an answer or an approval arrives.

export interface ResolvedTarget {
  agent: AgentStatus;
  agentName: string;
  projectPath: string;
  provider: string;
  model?: string;
  pane: string;
}

export function resolveTarget(agentId: string): { ok: true; target: ResolvedTarget } | { ok: false; error: string } {
  if (!agentId) return { ok: false, error: 'No agent id given.' };
  const agent = agents.get(agentId);
  if (!agent) {
    return { ok: false, error: `No agent with id "${agentId}" in the current fleet. It may have been removed or renamed.` };
  }
  return {
    ok: true,
    target: {
      agent,
      agentName: agent.name || agent.id,
      projectPath: agent.worktreePath || agent.projectPath,
      provider: agent.provider || 'claude',
      model: agent.model,
      pane: agent.ptyId ? `live pane (${agent.ptyId.slice(0, 8)})` : 'no live pane, a fresh session will start',
    },
  };
}

/**
 * POST to the local API's /dispatch route rather than writing to the PTY
 * directly. That route is what performDispatch() in agent-routes.ts already
 * implements (message a live session, or spawn one via spawnAgentSession if
 * none is live) - the one path an API-driven session is started, per the
 * backend spawn rule. Going through it here means sendToAgent gets that
 * behavior for free instead of a second copy of it.
 *
 * It presents Tars's own pass, not `~/.dorothy/api-token`. The shared file is
 * readable by every agent, so while the super chat authenticated with it the
 * routes that drive an agent could not refuse it: refusing the file would have
 * taken JeanBrasse's chat down with whoever else had read it. The pass is minted in
 * memory and written nowhere, so the refusal costs the super chat nothing. A
 * dedicated file elsewhere would only have moved the credential: any path
 * under $HOME is readable by the same agents.
 */
function postLocalDispatch(agentId: string, message: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const token = internalToken();
    const payload = JSON.stringify({ message });
    const req = http.request({
      host: '127.0.0.1',
      port: API_PORT,
      path: `/api/agents/${encodeURIComponent(agentId)}/dispatch`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
      // As the MCP tools: /dispatch holds a message up to SENDER_WAIT_MS (20 s)
      // on a launch still starting, and says so. At 15 s this gave up first,
      // and JeanBrasse read "timeout" for a message typed a moment later.
      timeout: 30_000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

export async function sendToAgent(agentId: string, text: string): Promise<{ success: boolean; error?: string; mode?: string }> {
  const resolved = resolveTarget(agentId);
  if (!resolved.ok) return { success: false, error: resolved.error };
  try {
    const { status, body } = await postLocalDispatch(agentId, text);
    if (status >= 300) {
      const err = (body && typeof body === 'object' && 'error' in body) ? String((body as { error: unknown }).error) : `HTTP ${status}`;
      return { success: false, error: err };
    }
    const mode = (body && typeof body === 'object' && 'mode' in body) ? String((body as { mode: unknown }).mode) : undefined;
    return { success: true, mode };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** actionIds already resolved (sent or cancelled), so a double-click on the
 *  UI's send button can't dispatch the same proposal twice. Memory-only and
 *  capped: this is a double-submit guard, not an audit log. */
const consumedActionIds = new Set<string>();
function markConsumed(id: string): void {
  consumedActionIds.add(id);
  if (consumedActionIds.size > 500) {
    const oldest = consumedActionIds.values().next().value;
    if (oldest) consumedActionIds.delete(oldest);
  }
}

/**
 * Send a proposal the caller has already established is legitimate.
 *
 * Private on purpose. The only in-process caller is finishTurn's
 * pre-authorised path, which builds the action two statements earlier from an
 * envelope that has already been through isTemplateEcho and resolveTarget, so
 * there is nothing left for a lookup to tell it. Everything arriving from
 * outside this module goes through confirmPendingAction instead.
 */
async function dispatchApprovedAction(
  action: OverseerAction,
): Promise<{ success: boolean; error?: string; mode?: string }> {
  if (consumedActionIds.has(action.actionId)) {
    return { success: false, error: 'This action was already resolved.' };
  }
  markConsumed(action.actionId);
  // Re-resolve now, immediately before writing: the fleet may have changed
  // since the overseer proposed this (agent finished, was removed, moved
  // project) in the minutes it can take JeanBrasse to read and approve it.
  return sendToAgent(action.agentId, action.text);
}

/**
 * The user's decision on a proposed action. Nothing is written to any CLI
 * until this is called with approve:true - which only happens when JeanBrasse
 * presses send in the approval panel.
 *
 * The action arrives as an object handed over IPC, and it used to be taken at
 * its word: whatever it named was dispatched. So an action still attached to
 * a reply that was the format template, of which there are some sitting on
 * disk from before that was refused, would be sent if anything ever offered
 * it. The renderer has since stopped offering them, but a check that lives
 * only in the renderer is not a check: the write happens here, so the
 * invariant belongs here. The action must be one this conversation actually
 * carries, on a message that reads as a real answer.
 */
export async function confirmPendingAction(
  action: OverseerAction,
  approve: boolean,
): Promise<{ success: boolean; error?: string; mode?: string }> {
  if (!action || !action.actionId || !action.agentId || !action.text) {
    return { success: false, error: 'Malformed action.' };
  }

  const carrier = loadState().messages.find(m => m.action?.actionId === action.actionId);
  const authentic = carrier?.action ?? null;
  if (!carrier || !authentic) {
    return { success: false, error: 'That proposal is not in the conversation, so it cannot be sent.' };
  }
  if (isTemplateEcho(carrier.text)) {
    return {
      success: false,
      error: 'That proposal came from a reply that was the format template rather than an answer, so it will not be sent.',
    };
  }

  if (consumedActionIds.has(authentic.actionId)) {
    return { success: false, error: 'This action was already resolved.' };
  }
  if (!approve) {
    markConsumed(authentic.actionId);
    return { success: true };
  }

  // `authentic`, never the caller's `action`. Only the id was ever checked
  // against the conversation, so dispatching the object that carried it meant
  // an id that passed could still deliver a target and a body that had never
  // been proposed or seen. What is sent is what the overseer actually wrote
  // and what JeanBrasse was actually shown; the argument is a claim about which
  // proposal is meant, not the proposal itself.
  return dispatchApprovedAction(authentic);
}

/**
 * How long the same check-in has to stay quiet before it is news again.
 *
 * Six times the default watch interval. A repeat that is only the timer coming
 * round again is refused; one that is still true half an hour later is saying
 * something the first one could not, which is that it has not moved.
 */
const REPEAT_QUIET_MS = 30 * 60 * 1000;

/**
 * What JeanBrasse reads when Hermes answers with the format template.
 *
 * Never nothing. A guard that refuses a bad answer and leaves the thread empty
 * has not protected anybody: before, he got a wrong answer and could see it was
 * wrong; after, he got an error toast and a blank page and could not tell
 * whether Chat was broken, the gateway was down, or nothing had happened.
 *
 * Worded without the template in it, on purpose. A message containing the
 * template verbatim reads as an echo to the very rule above, and the thread
 * folds flagged messages away, so the one line written to stop the page being
 * empty would be the one line the page hides. It says what happened, why it
 * usually happens, and the one thing that actually fixes it.
 */
const TEMPLATE_ECHO_NOTICE = [
  'Hermes replied with the empty reply format instead of an answer, so there is nothing it observed to pass on.',
  '',
  'That almost always means the model the gateway is currently running is not following the reply format. Picking a stronger model for Chat, from the model control in the header, is what fixes it. Asking again is worth one try in case it was a one-off.',
].join('\n');

/**
 * What happens to a reply once it exists, whichever transport produced it.
 *
 * Extracted so the live conversation and the cron fallback cannot drift: the
 * envelope parsing, the target re-resolution, the auto-action gate and the
 * history write are the parts that must behave identically no matter how the
 * words arrived.
 */
export async function finishTurn(
  state: OverseerState,
  replyText: string,
  opts: { isBriefing?: boolean },
): Promise<AskOverseerResult> {
  const envelope = parseEnvelope(replyText);

  // Refused before anything else happens, and above all before it is written:
  // a placeholder in the history is what turns one bad turn into every turn.
  // Nothing is persisted, so the next turn is already the retry, composed
  // from a prompt this reply never entered.
  // Said already, recently, and to nobody who asked.
  //
  // Three conditions, because the rule had only the first and refused things
  // it should not have. Repeating an observation is not automatically a fault:
  // "that agent is STILL blocked" an hour later is the thing JeanBrasse wants most,
  // and it was being turned into an error.
  //
  // The clock is what separates the two. The repeats that ran for a day came
  // round with the watch timer, a median of two and a half minutes apart, so a
  // quiet window several times longer than the default check-in leaves all of
  // them refused while letting a genuinely persistent one through. Measured on
  // the conversation this exists to fix: four gaps out of a hundred and eighty
  // four are longer than this window.
  //
  // And only a check-in nobody asked for. When JeanBrasse asks a question, the same
  // answer as last time is an answer, and refusing it hands him an error
  // instead, which is the very thing he could not get past. His turn always
  // gets through; what stops it being the stale one is the fold in
  // serializeHistory, which means the model was never shown the repetition.
  const previous = [...state.messages].reverse().find(m => m.role === 'overseer');
  if (opts.isBriefing && previous && isSameThingSaidAgain(envelope.say, previous.text)) {
    const age = Date.now() - Date.parse(previous.timestamp);
    // An unreadable timestamp falls back to refusing, which is what this did
    // before there was a clock at all. It only ever applies to a check-in.
    if (!Number.isFinite(age) || age < REPEAT_QUIET_MS) {
      console.warn('[overseer] discarded a check-in that repeated the previous one:', envelope.say.slice(0, 120));
      return {
        ok: false,
        reason: 'error',
        error: 'Hermes checked in with the same thing it had just said, so Tars discarded it rather than recording it again.',
      };
    }
  }

  // A reply that is the template carries no observation, so there is nothing
  // to report from it. What happens next depends entirely on whether anybody
  // is waiting for an answer.
  const echoed = isTemplateEcho(envelope.say);
  if (echoed && opts.isBriefing) {
    // Nobody asked. Silence is the right outcome and the chat stays clean.
    console.warn('[overseer] dropped a check-in that echoed the format template:', envelope.say.slice(0, 120));
    return {
      ok: false,
      reason: 'error',
      error: 'Hermes checked in with the reply template instead of an answer, so Tars dropped it.',
    };
  }
  if (echoed) {
    // JeanBrasse asked, so JeanBrasse gets something. Refusing here is what turned a
    // visibly wrong answer into no answer at all: an error toast and an empty
    // thread, which is the failure this codebase has spent three days
    // removing from everywhere else.
    //
    // The text below is deliberately not a copy of what came back. A message
    // holding the template verbatim would be flagged as an echo itself, and
    // the thread folds flagged messages away, so the one message written to
    // stop the page being empty would be the one message the page hides.
    console.warn('[overseer] answering with a notice: the reply echoed the format template');
  }

  let action: OverseerAction | null = null;
  if (!echoed && envelope.action) {
    const resolved = resolveTarget(envelope.action.agentId);
    // If the id doesn't resolve, the proposal is silently dropped from the
    // structured side - envelope.say still reaches JeanBrasse as the overseer's
    // words, but there is nothing left to approve or send.
    if (resolved.ok) {
      action = {
        actionId: uuidv4(),
        agentId: envelope.action.agentId,
        agentName: resolved.target.agentName,
        projectPath: resolved.target.projectPath,
        provider: resolved.target.provider,
        model: resolved.target.model,
        pane: resolved.target.pane,
        text: envelope.action.text,
        resolvedAt: new Date().toISOString(),
      };
    }
  }

  // Pre-authorised? Decided here, against the live fleet, and sent through
  // the same gate JeanBrasse's own approval goes through: a rule is an approval
  // given in advance, not a way around the gate.
  let autoNote = '';
  if (action) {
    const rule = findAutoRule(state.settings.autoActions, { agentId: action.agentId });
    if (rule) {
      const sent = await dispatchApprovedAction(action);
      autoNote = sent.success
        ? `\n\n_Sent automatically to ${action.agentName}: ${rule.label.toLowerCase()}._`
        : `\n\n_Tried to send this automatically and could not: ${sent.error ?? 'unknown error'}._`;
      // Consumed either way, so the panel cannot offer to send it again.
      action = null;
    }
  }

  const overseerMsg: OverseerMessage = {
    id: uuidv4(),
    role: 'overseer',
    text: echoed ? TEMPLATE_ECHO_NOTICE : envelope.say + autoNote,
    action,
    isBriefing: opts.isBriefing,
    timestamp: new Date().toISOString(),
  };

  // The user's turn is already in `state.messages`, pushed before the round
  // trip. A briefing has no user turn at all: it was not asked for.
  state.messages.push(overseerMsg);
  // Bound the persisted history so overseer.json doesn't grow forever.
  if (state.messages.length > 400) state.messages = state.messages.slice(-400);
  saveState(state);

  return { ok: true, message: overseerMsg };
}
