/**
 * The Overseer: a Hermes agent that watches every Tars agent in every
 * project, reports on what they're doing, challenges questionable choices,
 * and can propose - but never itself perform - a message to one agent.
 *
 * Why this lives in the main process rather than as an ACP delegate like
 * everything else in electron/services/acp/: the overseer isn't a Tars agent
 * with a PTY, it's a *client* of Hermes' own cron/session machinery (see the
 * probe notes at the top of the task this file was built from). There is no
 * REST "ask a question" route on the gateway, only cron jobs that can be
 * triggered and polled, so askOverseer(), in overseer-turn.ts, drives that machinery by hand:
 * PUT a fresh prompt into a standing job, POST /trigger, poll for the run it
 * created, read the run's session transcript back.
 *
 * ── The envelope ──────────────────────────────────────────────────────────
 * The overseer is asked to reply with exactly one JSON object so Tars can act
 * on it without parsing prose:
 *   { "say": string, "action": null | { "kind": "message_agent", "agent_id": string, "text": string } }
 * "say" is what reaches the chat. "action" is a PROPOSAL, never a command:
 * see the write gate below for why naming an id is as far as the model's
 * authority goes.
 *
 * ── The write gate ───────────────────────────────────────────────────────
 * The single most important safety property this feature has is "never
 * writes to the wrong CLI". That is enforced structurally, not by trusting
 * the model:
 *   1. The overseer may only NAME an agent by an id that was present in the
 *      fleet snapshot it was just given (composeTurn's instructions say so,
 *      but the enforcement is step 2, not the model's compliance).
 *   2. resolveTarget() looks that id up in the LIVE agents map - taken NOW,
 *      not from the snapshot the model saw, which may be stale by the time
 *      the answer comes back - and only a real, currently-known agent
 *      resolves to a target at all.
 *   3. sendToAgent() calls resolveTarget() again, and confirmPendingAction()
 *      calls it a third time immediately before writing, because JeanBrasse's
 *      approval can land minutes after the proposal and the fleet can have
 *      changed in between.
 *   4. Nothing is written until confirmPendingAction() is called with
 *      approve:true - which only happens when JeanBrasse presses send in the UI.
 * The model never picks the destination. It names an id, Tars resolves it
 * (repeatedly, at the point that matters), and JeanBrasse confirms. That is what
 * makes writing to the wrong CLI impossible rather than merely unlikely.
 */

// The parts, each in its own file beside this one. Everything outside the
// overseer imports from here and nowhere else.
export {
  DEFAULT_WATCH_INTERVAL_MS,
  MIN_WATCH_INTERVAL_MS,
  MAX_WATCH_INTERVAL_MS,
  migrateOverseerOutOfAgentReach,
  getOverseerHistory,
  clearOverseerHistory,
} from './overseer-store';
export type { OverseerAction, OverseerAttachment, OverseerMessage, OverseerSettings } from './overseer-store';
export { buildFleetSnapshot } from './overseer-fleet';
export type { FleetSnapshot } from './overseer-fleet';
export { isSameThingSaidAgain, isTemplateEcho, parseEnvelope } from './overseer-envelope';
export type { ParsedEnvelope } from './overseer-envelope';
export { composeTurn } from './overseer-prompt';
export { resolveTarget, sendToAgent, confirmPendingAction } from './overseer-gate';
export type { ResolvedTarget } from './overseer-gate';
export {
  isOverseerBusy,
  askOverseer,
  resetLiveSession,
  pauseOverseerWatch,
  resumeOverseerWatch,
  isOverseerWatchPaused,
} from './overseer-turn';
export type { AskOverseerResult } from './overseer-turn';
export {
  watchTick,
  getLastWatchFailure,
  startOverseerWatch,
  getOverseerSettings,
  applyOverseerModel,
  setOverseerSettings,
  stopOverseerWatch,
} from './overseer-watch';
export type { WatchFailure } from './overseer-watch';
