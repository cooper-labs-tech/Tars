import * as fs from 'fs';
import { agents, saveAgents } from './agent-manager';
import { ptyProcesses, fieldInUse } from './pty-manager';
import { killPty } from './pty-kill';
import { cliRunningIn } from './agent-pty';
import { sessionStarting, dialogOpen, cliLaunchedAt } from './agent-launch';
import { pendingRestarts } from './agent-restart';
import { updateAgent, type AgentUpdate } from './agent-update';
import { hasEndOfTurn, hasClaudeHooks } from './end-of-turn';
import { oneTaskQueue, terminalTurnOf } from './one-task';
import { hasOrchestratorPowers } from './agent-role';
import { holdsFor } from '../services/agent-watch';
import { pendingBackgroundWork } from '../services/agent-truth';
import { recordChange, updateChange, changeById, listChanges, queuedChanges, keptProblem, type AgentChange, type ChangeBy } from '../services/agent-changes';
import { isValidProvider } from '../providers';
import { broadcastToAllWindows } from '../utils/broadcast';
import { newConversationOnNextStart } from '../utils/resume-session';
import { getProvider } from '../providers';
import { scheduleTick } from '../utils/agents-tick';
import type { AgentStatus } from '../types';

/**
 * An agent's settings changed by another agent (2.0.7, the owner's word of 19/11: "je veux aussi que ses agents (et
 * donc n'importe quel agent) puisse changer le harness d'un autre agent, changer le modèle, le niveau de difficulté,
 * la clé api pour l'inférence"), without ever cutting what it is doing.
 *
 * Who may is the route's (agent-routes.ts, mayUpdate): the inference settings (RETUNE_FIELDS) any agent with an
 * identity of its own changes on any agent, of any project, orchestrators included; the rest keeps the orchestrator's
 * rule. This module is when, and the record of it.
 *
 * Applied or queued. A change of what the agent's CLI runs (WAITS_FOR_REST) is applied at once when the agent is
 * free, and otherwise held, the record untouched, until it is (busyReason): a turn Tars can see, a delegated run in
 * hand, a permission question, a field somebody types in, what Tars owes its session, work its last turn left running
 * in the background, a launch under way. Applied, it goes through the window's own path (core/agent-update.ts): a
 * claude-binary CLI is restarted on it then, on its conversation (core/agent-restart.ts); the idle terminal of a CLI
 * that reports its turns otherwise (codex, pi) is ended, and its next task starts it on the new values; a new
 * provider, CLI path or worktree ends the idle terminal, as the window's save does. A CLI that tells Tars nothing of
 * its turns (opencode, amp, grok) is never ended under it: a new model or effort is written at once and taken at its
 * next start, and a change that needs a new terminal waits until its CLI has ended.
 *
 * Every change is logged (services/agent-changes.ts) with who asked, the values before and after, when it was asked,
 * its state, and when it took effect; a revert sets the `before` again from that log. Tars announces each to the
 * window (`agent:retuned`) and keeps the last on the agent (`lastRetune`), and tells the target project's
 * orchestrator when the caller is of another project (the `tell` the routes hand in).
 */

/** What any agent changes on any agent: the harness, the model, the effort, and the endpoint and traces once taken. */
export const RETUNE_FIELDS = ['provider', 'model', 'localModel', 'effort', 'traces', 'endpointId'] as const;

/** What the agent's CLI runs on: a change of these waits for the agent to be free. */
const WAITS_FOR_REST = new Set(['provider', 'model', 'localModel', 'effort', 'permissionMode', 'cliPath', 'secondaryProjectPath', 'worktree', 'traces', 'endpointId']);

/** What needs a new terminal: never applied under a CLI Tars cannot see at rest. */
const ENDS_TERMINAL = new Set(['provider', 'cliPath', 'worktree', 'endpointId', 'traces']);

/** An update as the route checked it, a worktree given as the folder it names (or null for the project's own). */
export type RetuneAsk = Omit<AgentUpdate, 'id' | 'worktree'> & {
  worktree?: { worktreePath: string; branchName: string } | null;
  traces?: boolean;
  endpointId?: string | null;
};

export type RetuneOutcome =
  | { state: 'applied' | 'queued'; change: AgentChange; waitingFor?: string; updated?: Extract<Awaited<ReturnType<typeof updateAgent>>, { success: true }> }
  | { state: 'refused'; status: number; error: string; code?: string };

/** The fields an ask names, in a stable order. */
export function askedFields(ask: Record<string, unknown>): string[] {
  return Object.keys(ask).filter((k) => ask[k] !== undefined).sort();
}

export function isRetuneOnly(fields: readonly string[]): boolean {
  return fields.length > 0 && fields.every((f) => (RETUNE_FIELDS as readonly string[]).includes(f));
}

/** An agent's value of a field, as the log keeps it. */
function valueOf(agent: AgentStatus, field: string): unknown {
  if (field === 'worktree') return agent.worktreePath ? { worktreePath: agent.worktreePath, branchName: agent.branchName ?? '' } : null;
  const value = (agent as unknown as Record<string, unknown>)[field];
  return value === undefined ? null : value;
}

function snapshot(agent: AgentStatus, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, valueOf(agent, f)]));
}

const ptyOf = (agent: AgentStatus) => (agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);

/**
 * Why a change of what the agent's CLI runs cannot be applied now, or null when it can. `endsTerminal`: the change
 * needs a new terminal, which a CLI Tars cannot see at rest never gets under it.
 */
export function busyReason(agent: AgentStatus, endsTerminal: boolean): string | null {
  const pty = ptyOf(agent);
  const cliUp = cliRunningIn(pty);
  if (!cliUp) return agent.status !== 'stopped' && sessionStarting(agent) ? 'launch' : null;
  if (oneTaskQueue.busyRun(agent.id)) return 'task';
  if (!hasEndOfTurn(agent)) return endsTerminal ? 'its CLI ends' : null;
  if (terminalTurnOf(agent, true)) return dialogOpen(agent) ? 'permission' : 'turn';
  if (holdsFor(agent.id)) return 'note';
  const inUse = pty ? fieldInUse(pty) : null;
  if (inUse) return inUse.reason;
  if (pendingRestarts().some((r) => r.agentId === agent.id)) return 'launch';
  if (hasClaudeHooks(agent)) {
    const since = cliLaunchedAt(pty) ?? (agent.sessionRegisteredAt ? Date.parse(agent.sessionRegisteredAt) : undefined);
    if (since !== undefined && pendingBackgroundWork(agent, since).length > 0) return 'background';
  }
  return null;
}

/** What it waits for, as the answer and the log say it. */
export const WAITING_TEXT: Record<string, string> = {
  launch: 'its CLI, starting, is up',
  task: 'the delegated run it holds ends',
  turn: 'its turn ends',
  permission: 'its permission question is answered and its turn ends',
  note: 'what Tars owes it has been typed in',
  background: 'the work it left running in the background has reported back',
  'its CLI ends': 'its CLI ends: it tells Tars nothing of its turns, so Tars never ends it under them (stop_agent ends it)',
  'next start': 'its next start: its CLI tells Tars nothing of its turns, so the running one keeps its values',
  draft: 'its field is empty: something is typed in it and not sent',
  typing: 'nobody has typed in it for five seconds',
  queued: 'the messages waiting for its field have gone in',
  writing: 'the message just typed into it has started',
  'earlier change': 'the change queued before it is applied',
};

/**
 * Changes held for an agent, oldest first: what Tars applies once the agent is free. Every writer replaces the array,
 * and settle reads it live at each step, by change id: an apply awaits, and meanwhile a revert may cancel a change
 * further in line or a new one may join it (the Audit's M1 on #595). The change being applied stays first in line
 * until it is done, so a change asked meanwhile queues behind it, and its revert waits for it.
 */
const held = new Map<string, Array<{ changeId: string; ask: RetuneAsk }>>();
/** The change being applied now, per agent: never cancelled under its apply. */
const inFlight = new Map<string, string>();
/**
 * Agents a change is being applied to directly, not from the queue: a second change asked meanwhile queues behind it
 * rather than apply over it (the re-audit's I1 on #595), and settle waits for it.
 */
const applyingNow = new Set<string>();

/** What the routes hand in: telling the target project's orchestrator, and its chats' runners taking its settings. */
interface RetuneDeps {
  tell?: (target: AgentStatus, change: AgentChange) => void;
  restartRunnersOf?: (leadId: string, changed: string[]) => void;
}
let deps: RetuneDeps = {};
export function setRetuneDeps(next: RetuneDeps): void {
  deps = { ...deps, ...next };
}

function announce(agent: AgentStatus, change: AgentChange): void {
  // What the caller named (`asked`), beside what the change touched (`fields`): a provider change also clears the
  // model and CLI path it was not given, which the window keeps out of its line (#604's Audit, L1).
  const asked = change.asked ?? change.fields;
  // A revert names the change it takes back, so the window shows it as an undo, with no undo of its own (#604's QA, F4).
  const revertOf = change.revertOf ? { revertOf: change.revertOf } : {};
  agent.lastRetune = {
    changeId: change.id, by: change.by, fields: change.fields, asked, state: change.state, askedAt: change.askedAt,
    ...(change.effectiveAt ? { effectiveAt: change.effectiveAt } : {}), ...revertOf,
  };
  saveAgents();
  broadcastToAllWindows('agent:retuned', {
    changeId: change.id, agentId: change.agentId, agentName: change.agentName, projectPath: change.projectPath, by: change.by,
    fields: change.fields, asked, before: change.before, after: change.after, state: change.state, askedAt: change.askedAt,
    ...(change.effectiveAt ? { effectiveAt: change.effectiveAt } : {}), ...(change.waitingFor ? { waitingFor: change.waitingFor } : {}),
    ...revertOf,
  });
  scheduleTick();
}

function endIdleTerminal(agent: AgentStatus): void {
  const pty = ptyOf(agent);
  if (pty) {
    try {
      killPty(pty);
    } catch (err) {
      console.warn(`[retune] ${agent.name || agent.id}: its idle terminal did not close cleanly:`, err);
    }
  }
  if (agent.ptyId) ptyProcesses.delete(agent.ptyId);
  if (agent.currentSessionId) agent.lastKilledSessionId = agent.currentSessionId;
  agent.currentSessionId = undefined;
  agent.ptyId = undefined;
  agent.ptyCwd = undefined;
  agent.status = 'idle';
  agent.currentTask = undefined;
}

/**
 * Apply now, through the window's own path. The agent is free (or its change needs it not to be: a name). Returns the
 * update's result, and whether the change took effect now or waits for the CLI's next start.
 */
async function applyNow(agent: AgentStatus, ask: RetuneAsk): Promise<{ ok: true; updated: Extract<Awaited<ReturnType<typeof updateAgent>>, { success: true }>; nextStart: boolean } | { ok: false; error: string }> {
  // The endpoint and the traces reach the record through feat/traces-native's own fields: none here yet.
  const { worktree, ...rest } = ask;
  delete (rest as { traces?: unknown }).traces;
  delete (rest as { endpointId?: unknown }).endpointId;
  const cliWasUp = cliRunningIn(ptyOf(agent));
  const binaryBefore = getProvider(agent.provider).binaryName;
  const updated = await updateAgent({ id: agent.id, ...rest, ...(worktree !== undefined ? { worktreeAt: worktree } : {}) } as AgentUpdate);
  if (!updated.success) return { ok: false, error: updated.error };
  // No CLI continues another one's conversation: the next start of a new binary opens a new one.
  if (getProvider(agent.provider).binaryName !== binaryBefore) newConversationOnNextStart(agent.id);
  // A CLI that reports its turns but is no claude: Tars cannot restart it on its conversation, so its idle terminal
  // ends and its next task starts it on the new values. One that reports nothing keeps running until its next start.
  let nextStart = false;
  const stillUp = cliRunningIn(ptyOf(agent));
  if (cliWasUp && stillUp && updated.changedAtLaunch.length > 0 && !hasClaudeHooks(agent)) {
    if (hasEndOfTurn(agent)) {
      endIdleTerminal(agent);
      saveAgents();
    } else {
      nextStart = true;
    }
  }
  if (hasOrchestratorPowers(agent) && agent.kind !== 'chat') deps.restartRunnersOf?.(agent.id, updated.changedAtLaunch);
  return { ok: true, updated, nextStart };
}

/**
 * Change an agent's settings now or once it is free, and log it. The route has checked who may and every value; the
 * caller is named in `by`.
 */
export async function retune(agentId: string, ask: RetuneAsk, by: ChangeBy, opts: { batchId?: string; revertOf?: string; asked?: string[] } = {}): Promise<RetuneOutcome> {
  const agent = agents.get(agentId);
  if (!agent) return { state: 'refused', status: 404, error: 'Agent not found' };
  const fields = askedFields(ask as Record<string, unknown>);
  if (fields.length === 0) return { state: 'refused', status: 400, error: 'Nothing to change: name a setting.' };
  const base = {
    agentId: agent.id, agentName: agent.name || agent.id, projectPath: agent.projectPath, by, fields,
    before: snapshot(agent, fields), after: Object.fromEntries(fields.map((f) => [f, (ask as Record<string, unknown>)[f] ?? null])),
    askedAt: new Date().toISOString(), ...(opts.batchId ? { batchId: opts.batchId } : {}), ...(opts.revertOf ? { revertOf: opts.revertOf } : {}),
    // What the caller named, which a revert is judged by: a provider change also clears the model and CLI path it
    // was not given, which are logged, and are no setting the caller asked for (the Audit's M2 on #595).
    asked: [...(opts.asked ?? fields)].sort(),
  };
  // A value the log does not keep is refused before anything is written (the Audit's L5 on #595).
  const unkept = keptProblem(base.before) ?? keptProblem(base.after);
  if (unkept) return { state: 'refused', status: 400, error: `Not changed: ${unkept}.` };
  const waits = fields.some((f) => WAITS_FOR_REST.has(f));
  const endsTerminal = fields.some((f) => ENDS_TERMINAL.has(f));
  const ahead = held.get(agent.id)?.length || applyingNow.has(agent.id) ? 'earlier change' : null;
  const busy = ahead ?? (waits ? busyReason(agent, endsTerminal) : null);
  if (busy) {
    const change = recordChange({ ...base, state: 'queued', waitingFor: busy, how: `Queued: applied once ${WAITING_TEXT[busy] ?? busy}. A running turn is never cut.` });
    held.set(agent.id, [...(held.get(agent.id) ?? []), { changeId: change.id, ask }]);
    announce(agent, change);
    deps.tell?.(agent, change);
    ensureWatch();
    return { state: 'queued', change, waitingFor: busy };
  }
  applyingNow.add(agent.id);
  let applied: Awaited<ReturnType<typeof applyNow>>;
  try {
    applied = await applyNow(agent, ask);
  } finally {
    applyingNow.delete(agent.id);
    // What queued behind it meanwhile goes in once it is done.
    if (held.get(agent.id)?.length) ensureWatch();
  }
  if (!applied.ok) return { state: 'refused', status: 400, error: applied.error };
  const now = new Date().toISOString();
  const change = applied.nextStart
    ? recordChange({ ...base, state: 'queued', waitingFor: 'next start', how: `Written; taken at ${WAITING_TEXT['next start']}.` })
    : recordChange({ ...base, state: 'applied', effectiveAt: now });
  if (applied.nextStart) ensureWatch();
  announce(agent, change);
  deps.tell?.(agent, change);
  return { state: change.state === 'applied' ? 'applied' : 'queued', change, ...(applied.nextStart ? { waitingFor: 'next start' } : {}), updated: applied.updated };
}

/** A queued change's agent is free, or has started its CLI again: apply it, or mark it taken. */
async function settle(agentId: string): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) {
    for (const item of held.get(agentId) ?? []) updateChange(item.changeId, { state: 'failed', error: 'the agent was removed before it was free', waitingFor: undefined });
    held.delete(agentId);
    return;
  }
  for (;;) {
    // A change applied directly is under way: what waits goes in after it.
    if (applyingNow.has(agentId)) return;
    // The live line, at each step: what a revert took out, or a new change put in, while the last apply awaited.
    const head = held.get(agentId)?.[0];
    if (!head) {
      held.delete(agentId);
      return;
    }
    const fields = askedFields(head.ask as Record<string, unknown>);
    const busy = busyReason(agent, fields.some((f) => ENDS_TERMINAL.has(f)));
    if (busy) {
      const entry = changeById(head.changeId);
      if (entry && entry.waitingFor !== busy) updateChange(head.changeId, { waitingFor: busy });
      return;
    }
    inFlight.set(agentId, head.changeId);
    let applied: Awaited<ReturnType<typeof applyNow>>;
    try {
      applied = await applyNow(agent, head.ask);
    } finally {
      inFlight.delete(agentId);
      const rest = (held.get(agentId) ?? []).filter((h) => h.changeId !== head.changeId);
      if (rest.length) held.set(agentId, rest);
      else held.delete(agentId);
    }
    const now = new Date().toISOString();
    const change = applied.ok
      ? (applied.nextStart
        ? updateChange(head.changeId, { waitingFor: 'next start', how: `Written; taken at ${WAITING_TEXT['next start']}.` })
        : updateChange(head.changeId, { state: 'applied', effectiveAt: now, waitingFor: undefined }))
      : updateChange(head.changeId, { state: 'failed', error: applied.error, waitingFor: undefined });
    if (change) announce(agent, change);
  }
}

/** A change written and taken at the CLI's next start: taken once a CLI was launched after it was asked. */
function settleNextStarts(): void {
  for (const change of queuedChanges()) {
    if (change.waitingFor !== 'next start') continue;
    const agent = agents.get(change.agentId);
    if (!agent) {
      updateChange(change.id, { state: 'failed', error: 'the agent was removed before its next start', waitingFor: undefined });
      continue;
    }
    const pty = ptyOf(agent);
    const launched = cliRunningIn(pty) ? cliLaunchedAt(pty) : undefined;
    if (launched !== undefined && launched >= Date.parse(change.askedAt)) {
      const done = updateChange(change.id, { state: 'applied', effectiveAt: new Date(launched).toISOString(), waitingFor: undefined });
      if (done) announce(agent, done);
    }
  }
}

let watch: NodeJS.Timeout | null = null;
let settling = false;

/** Look at what waits, every second while anything does. */
export async function checkQueued(): Promise<void> {
  if (settling) return;
  settling = true;
  try {
    for (const agentId of [...held.keys()]) await settle(agentId);
    settleNextStarts();
  } finally {
    settling = false;
  }
  if (held.size === 0 && !queuedChanges().some((c) => c.waitingFor === 'next start') && watch) {
    clearInterval(watch);
    watch = null;
  }
}

function ensureWatch(): void {
  if (watch) return;
  watch = setInterval(() => { void checkQueued(); }, 1000);
  watch.unref?.();
}

/**
 * Tars's start (main.ts), right after the agents are loaded and before any is launched: a change still held when Tars
 * quit is applied now, no CLI running yet; one written and waiting for its CLI's next start waits for it.
 */
export async function resumeQueuedChanges(): Promise<void> {
  for (const change of queuedChanges()) {
    if (change.waitingFor === 'next start') {
      ensureWatch();
      continue;
    }
    const ask = Object.fromEntries(change.fields.map((f) => [f, change.after[f]])) as RetuneAsk;
    // Checked again, as the file is no witness (the Audit's L4 on #595): a provider Tars knows, a worktree still there.
    const wt = ask.worktree as { worktreePath?: string } | null | undefined;
    const why = !agents.has(change.agentId) ? 'the agent was removed while Tars was down'
      : ask.provider !== undefined && (typeof ask.provider !== 'string' || !isValidProvider(ask.provider)) ? `the provider ${JSON.stringify(ask.provider)} is no provider Tars knows`
        : wt && (!wt.worktreePath || !fs.existsSync(wt.worktreePath)) ? 'its worktree is gone'
          : null;
    if (why) {
      updateChange(change.id, { state: 'failed', error: `${why}, so it was not applied at the start`, waitingFor: undefined });
      continue;
    }
    held.set(change.agentId, [...(held.get(change.agentId) ?? []), { changeId: change.id, ask }]);
  }
  await checkQueued();
}

export type RevertSelector = { changeId?: string; batchId?: string; agentId?: string };

/**
 * The changes a revert sets back: one by its id, every change of a batch, or the agent's last one that is not
 * cancelled or failed. Newest first, so a batch is undone in the order it was done, backwards.
 */
export function changesToRevert(sel: RevertSelector): AgentChange[] {
  if (sel.changeId) {
    const one = changeById(sel.changeId);
    return one ? [one] : [];
  }
  if (sel.batchId) return listChanges({ batchId: sel.batchId, limit: 500 });
  if (sel.agentId) {
    const last = listChanges({ agentId: sel.agentId, limit: 500 }).find((c) => c.state === 'applied' || c.state === 'queued');
    return last ? [last] : [];
  }
  return [];
}

/**
 * What a revert of `change` asks: a queued change is cancelled, and nothing is asked; an applied one asks its
 * `before` back for each field still at its `after`, and names the fields another change has moved since, which it
 * leaves alone.
 */
export function revertAskOf(change: AgentChange): { cancel: true } | { ask: Record<string, unknown>; movedSince: string[] } | { nothing: string } {
  if (inFlight.get(change.agentId) === change.id) return { nothing: 'it is being applied at this moment: take it back once it is' };
  if (change.state === 'queued' && held.get(change.agentId)?.some((h) => h.changeId === change.id)) return { cancel: true };
  if (change.state !== 'applied' && change.state !== 'queued') return { nothing: `it was ${change.state}` };
  const agent = agents.get(change.agentId);
  if (!agent) return { nothing: 'the agent was removed' };
  const ask: Record<string, unknown> = {};
  const movedSince: string[] = [];
  for (const field of change.fields) {
    if (JSON.stringify(valueOf(agent, field)) !== JSON.stringify(change.after[field])) {
      movedSince.push(field);
      continue;
    }
    // No provider on the record is claude's, which a request names.
    ask[field] = field === 'provider' && change.before[field] === null ? 'claude' : change.before[field];
  }
  return { ask, movedSince };
}

/** A queued change taken back before it was applied. */
export function cancelQueued(change: AgentChange): AgentChange | undefined {
  if (inFlight.get(change.agentId) === change.id) return undefined;
  const line = held.get(change.agentId) ?? [];
  const rest = line.filter((h) => h.changeId !== change.id);
  if (rest.length === line.length) return undefined;
  if (rest.length) held.set(change.agentId, rest);
  else held.delete(change.agentId);
  const done = updateChange(change.id, { state: 'cancelled', waitingFor: undefined });
  const agent = agents.get(change.agentId);
  if (done && agent) announce(agent, done);
  return done;
}

/**
 * The window's undo of a change (agent.revertChange, 2.0.7): one change by its id, or an agent's last, set back
 * through this engine as revert_agent_change sets it back, filed under the window, the owner's own. A change still
 * queued is cancelled; an applied one asks its `before` back for the settings still at its `after`, applied or queued
 * as any change, and names those another change moved since; a worktree that is gone is left alone. Nothing to undo
 * is said, nothing written.
 */
export async function revertAsWindow(sel: { changeId?: unknown; agentId?: unknown }):
  Promise<{ ok: true; state: 'cancelled' | 'applied' | 'queued'; revertChangeId?: string; leftAlone?: string[] } | { ok: false; error: string }> {
  const named = [sel?.changeId, sel?.agentId].filter((v) => v !== undefined);
  if (named.length !== 1 || typeof named[0] !== 'string' || !named[0]) return { ok: false, error: 'Name one change (changeId) or one agent (agentId).' };
  const found = changesToRevert(sel.changeId !== undefined ? { changeId: sel.changeId as string } : { agentId: sel.agentId as string });
  if (found.length === 0) return { ok: false, error: sel.changeId !== undefined ? 'No such change in the log.' : 'This agent has no change to undo.' };
  const change = found[0];
  const plan = revertAskOf(change);
  if ('nothing' in plan) return { ok: false, error: `Nothing to undo: ${plan.nothing}.` };
  if ('cancel' in plan) {
    cancelQueued(change);
    return { ok: true, state: 'cancelled' };
  }
  const ask: Record<string, unknown> = { ...plan.ask };
  const leftAlone = [...plan.movedSince];
  const wt = ask.worktree as { worktreePath?: string } | null | undefined;
  if (wt && (!wt.worktreePath || !fs.existsSync(wt.worktreePath))) {
    delete ask.worktree;
    leftAlone.push('worktree');
  }
  if (Object.keys(ask).length === 0) {
    return { ok: false, error: `Nothing to undo: ${leftAlone.includes('worktree') && !plan.movedSince.includes('worktree') ? 'the worktree it was in is gone' : `${leftAlone.join(', ')} moved since, by another change`}.` };
  }
  const done = await retune(change.agentId, ask as RetuneAsk, { kind: 'window' }, { revertOf: change.id, asked: change.asked ?? change.fields });
  if (done.state === 'refused') return { ok: false, error: done.error };
  return { ok: true, state: done.state, revertChangeId: done.change.id, ...(leftAlone.length ? { leftAlone } : {}) };
}

/** The changes held for an agent, for its record and the answer. */
export function heldFor(agentId: string): string[] {
  return (held.get(agentId) ?? []).map((h) => h.changeId);
}

/** Test seam. */
export function resetRetune(): void {
  held.clear();
  inFlight.clear();
  applyingNow.clear();
  if (watch) clearInterval(watch);
  watch = null;
  settling = false;
  deps = {};
}
