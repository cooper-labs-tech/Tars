import { agents, saveAgents } from './agent-manager';
import { ptyProcesses, fieldInUse, onFieldChange, type FieldInUse } from './pty-manager';
import { cliRunningIn } from './agent-pty';
import { killPty } from './pty-kill';
import { launchAgent, CLI_BOOT_MS, dialogOpen, noteCliLaunched, cliLaunchedAt } from './agent-launch';
import { getProvider } from '../providers';
import { agentStatusEmitter } from '../services/agent-events';
import { holdsFor } from '../services/agent-watch';
import { pendingBackgroundWork } from '../services/agent-truth';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { hasOrchestratorPowers } from './agent-role';
import type { AgentStatus } from '../types';

/**
 * A changed model or effort applies without anybody relaunching by hand.
 *
 * A CLI reads its model, its effort and its other flags once, when it starts.
 * Saving new ones in the Agents page changed the record and nothing else: the
 * CLI in the terminal went on as it was, until JeanBrasse relaunched every session
 * himself. So when a setting the CLI only reads at launch changes, the agent's
 * CLI is restarted on it, through the same launch every window uses
 * (core/agent-launch.ts, which is `agent:start`), continuing its conversation.
 *
 * When, is what this module is about. Never in the middle of something:
 * - a turn in progress (`running`, or waiting on a permission answer) ends
 *   first, and its end is what brings this back here;
 * - a field somebody has typed in and not sent, or typed in during the last
 *   five seconds, or that Tars is typing a message into, or holds messages
 *   for: killing the terminal would throw that away (see fieldInUse);
 * - a note or a room message agent-watch owes the agent: those belong to the
 *   session they were owed to and would be dropped with it;
 * - work the session left running in the background when its turn ended (a
 *   Bash command, a Monitor, an asynchronous Agent): it reports back as a turn
 *   of its own, and killing the CLI kills it (see pendingBackgroundWork).
 * Otherwise at once. An agent with no CLI running has nothing to restart: its
 * next launch reads the new values like any launch does.
 *
 * Only the CLIs on the claude binary. Their turns are known to end (the Stop
 * and StopFailure hooks) and their field is the one the draft model was
 * measured on. Codex, Gemini, Grok, OpenCode, Pi and Amp report neither, so
 * restarting one could cut a turn or a draft nobody can see: they take the new
 * values at their next launch. The thirteen providers that point the claude
 * binary at another vendor are among those restarted, and pick their
 * conversation up the same way (resumeFlags, in providers/cli-provider.ts):
 * until they did, a changed setting silently started them on a new one.
 */

/**
 * What a CLI reads when it starts and never again, as it reaches the command
 * line or the environment. Skills are not here: they only ever preface a
 * task, and a restart has none. Neither are the provider, the CLI path, the
 * project and the worktree, which already end the terminal when they change.
 */
export interface LaunchSettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** --disallowed-tools and the orchestrator instructions. */
  orchestrator: boolean;
  secondaryProjectPath?: string;
  obsidianVaultPaths: string[];
  /** The model of the local provider, which is ANTHROPIC_MODEL in its terminal. */
  localModel?: string;
  /** The Claude account the agent is pinned to, which is CLAUDE_CONFIG_DIR in its terminal. */
  claudeAccount?: string;
}

export function launchSettings(agent: AgentStatus): LaunchSettings {
  return {
    model: agent.model && agent.model !== 'default' ? agent.model : undefined,
    effort: agent.effort || undefined,
    permissionMode: agent.permissionMode,
    // The orchestrator's powers: its project's orchestrator, which the toggle
    // makes, or a chat's runner (core/agent-role.ts).
    orchestrator: hasOrchestratorPowers(agent),
    secondaryProjectPath: agent.secondaryProjectPath || undefined,
    obsidianVaultPaths: [...(agent.obsidianVaultPaths ?? [])],
    localModel: agent.localModel || undefined,
    claudeAccount: agent.claudeAccountPin || undefined,
  };
}

/**
 * What each terminal's CLI was launched with, noted by the launch that typed
 * it. A restart that waited on a turn, while the agent was stopped and started
 * again, or started by an orchestrator on the new values, has nothing left to
 * apply, and without this it fired anyway the next time the agent was free.
 * Keyed by the terminal, so a new one never inherits it.
 */
const launchedWith = new WeakMap<object, { settings: string }>();

/**
 * Called by every launch, once it has typed the CLI into `ptyProcess`, with
 * the settings it read when it built the command. Read again here, they were
 * the record half a second later: agent:start waits that long for a new shell
 * before typing, and a change saved in between was typed with the old values
 * and noted as launched on the new ones. The restart it asked for then found
 * nothing to do. Measured by the QA on #123: a role taken back and given again
 * 100 ms apart left an orchestrator by role whose CLI could edit and had no
 * instructions, and a model changed twice left the record on one model and the
 * CLI on the other.
 */
export function noteLaunch(ptyProcess: object | undefined, settings: LaunchSettings): void {
  if (!ptyProcess) return;
  launchedWith.set(ptyProcess, { settings: JSON.stringify(settings) });
  noteCliLaunched(ptyProcess);
}

/** The names of the settings that differ, in a stable order. */
export function changedLaunchSettings(before: LaunchSettings, after: LaunchSettings): string[] {
  return (Object.keys(after) as (keyof LaunchSettings)[])
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/**
 * What a restart is waiting on: the turn, a permission answer, a note owed to
 * the agent, work left running in the background, its field (FieldInUse), or
 * its CLI, which is still starting from the last restart (`launch`).
 */
export type RestartWait = 'turn' | 'permission' | 'note' | 'background' | 'launch' | FieldInUse;

/** What became of a change, for the log and for whoever asked. */
export type RestartOutcome =
  | { action: 'restarted' }
  | { action: 'next-launch'; why: string }
  | { action: 'waiting'; for: RestartWait };

interface Pending {
  settings: Set<string>;
  /**
   * Restart even though the CLI already runs on the record's settings: a move
   * to another Claude account (services/claude-accounts/switching.ts), whose
   * account is chosen by the launch, not saved on the record.
   */
  always?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** The last thing logged, so a wait is said once and not on every key. */
  said?: string;
  /** What it waits on, once decide() has looked. */
  waitingFor?: RestartWait;
}

const pending = new Map<string, Pending>();

/**
 * A restart waiting to apply, as a window shows it: which settings, and what
 * it waits on. Without it every wait looked like "I changed the effort and it
 * answered on the old one", which is the report the restart exists to answer.
 */
export interface PendingRestart {
  agentId: string;
  settings: string[];
  waitingFor: RestartWait;
}

/** What each agent's windows were last told, so a push goes out on a change and not on every key. */
const shown = new Map<string, string>();

/**
 * Push `agent:restart-pending` when what a window should show for this agent
 * changed: `pending` is null once the restart happened or has nothing to do.
 */
function show(agentId: string): void {
  const entry = pending.get(agentId);
  const now = entry?.waitingFor ? { settings: [...entry.settings], waitingFor: entry.waitingFor } : null;
  const key = now ? JSON.stringify(now) : undefined;
  if (shown.get(agentId) === key) return;
  if (key) shown.set(agentId, key);
  else shown.delete(agentId);
  broadcastToAllWindows('agent:restart-pending', { agentId, pending: now });
}
const restarting = new Set<string>();

/**
 * When each agent was last restarted here. Its new CLI is typed into a fresh
 * shell half a second after the terminal opens, so for a moment the terminal
 * runs no CLI yet; a change saved in that moment is waited on, not handed to a
 * next launch that already happened.
 */
const restartedAt = new Map<string, number>();

/**
 * How long after an event this looks again. Long enough for whatever the
 * event itself set off to have started: agent-watch hands over what it held at
 * the same status change that ends a turn, and a restart must see that write
 * before deciding the field is free. Short enough that nobody waits on it.
 */
const SETTLE_MS = 250;

let stopListening: (() => void) | null = null;

function listen(): void {
  if (stopListening) return;
  const onFleetChange = (agentId: string) => {
    if (pending.has(agentId)) lookAgain(agentId, SETTLE_MS);
  };
  agentStatusEmitter.on('fleet-change', onFleetChange);
  const stopField = onFieldChange(ptyProcess => {
    for (const agentId of pending.keys()) {
      const ptyId = agents.get(agentId)?.ptyId;
      if (ptyId && ptyProcesses.get(ptyId) === ptyProcess) lookAgain(agentId, SETTLE_MS);
    }
  });
  stopListening = () => {
    agentStatusEmitter.off('fleet-change', onFleetChange);
    stopField();
  };
}

function lookAgain(agentId: string, delay: number): void {
  const entry = pending.get(agentId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void settle(agentId);
  }, delay);
  // A restart that is still waiting must never keep the app from quitting.
  entry.timer.unref?.();
}

function say(agent: AgentStatus, entry: Pending | undefined, line: string): void {
  if (entry) {
    if (entry.said === line) return;
    entry.said = line;
  }
  console.log(`[restart] ${agent.name || agent.id}: ${line}`);
}

/**
 * An agent's launch settings changed: restart its CLI on them now, when what
 * it is doing ends, or not at all when nothing runs. Settings that change
 * again while a restart waits are simply added to it: the restart launches on
 * whatever the record says when it happens. `always` restarts even when the
 * CLI already runs on the record's settings (a move to another account), with
 * every wait above all the same.
 */
export function restartForSettings(agentId: string, changed: string[], opts: { always?: boolean } = {}): RestartOutcome {
  if (changed.length === 0) return { action: 'next-launch', why: 'nothing the CLI reads at launch changed' };
  let entry = pending.get(agentId);
  if (!entry) {
    entry = { settings: new Set() };
    pending.set(agentId, entry);
  }
  for (const setting of changed) entry.settings.add(setting);
  if (opts.always) entry.always = true;
  listen();
  return decide(agentId);
}

/**
 * Every restart waiting right now, for a window that opened after the wait
 * began: `agent:restart-pending` only reaches a window already listening. An
 * agent absent from the list has no restart waiting.
 */
export function pendingRestarts(): PendingRestart[] {
  return [...pending.entries()]
    .filter(([, entry]) => entry.waitingFor)
    .map(([agentId, entry]) => ({ agentId, settings: [...entry.settings], waitingFor: entry.waitingFor! }));
}

function drop(agentId: string): void {
  const entry = pending.get(agentId);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(agentId);
  show(agentId);
}

/**
 * An agent was deleted: the restart it waited for goes with it, and a window
 * that was shown the wait is told it is over. Nothing else would do it: a wait
 * on the turn has no timer, and no deletion sends the fleet change that makes
 * decide() look again, so the agent stayed in pendingRestarts() and its panel
 * went on waiting (QA's gate of #138). Called wherever an agent is deleted.
 */
export function forgetRestart(agentId: string): void {
  drop(agentId);
  restartedAt.delete(agentId);
}

function waitingOn(agentId: string, entry: Pending, reason: RestartWait): RestartOutcome {
  entry.waitingFor = reason;
  show(agentId);
  return { action: 'waiting', for: reason };
}

/** Look at the agent now: restart, wait, or let the next launch do it. */
function decide(agentId: string): RestartOutcome {
  const agent = agents.get(agentId);
  const entry = pending.get(agentId);
  if (!agent || !entry) {
    drop(agentId);
    return { action: 'next-launch', why: 'the agent is gone' };
  }
  const settings = [...entry.settings].join(', ');

  const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  const booting = restarting.has(agentId) || Date.now() - (restartedAt.get(agentId) ?? 0) < CLI_BOOT_MS;
  if (ptyProcess && booting && !cliRunningIn(ptyProcess)) {
    say(agent, entry, `${settings} changed while its CLI restarts: restarting again once it is up`);
    lookAgain(agentId, 1000);
    return waitingOn(agentId, entry, 'launch');
  }
  if (restarting.has(agentId)) {
    lookAgain(agentId, 1000);
    return waitingOn(agentId, entry, 'launch');
  }
  if (!ptyProcess || !cliRunningIn(ptyProcess)) {
    drop(agentId);
    say(agent, undefined, `${settings} changed with no CLI running: the next launch uses the new values`);
    return { action: 'next-launch', why: 'no CLI is running in its terminal' };
  }
  if (!entry.always && launchedWith.get(ptyProcess)?.settings === JSON.stringify(launchSettings(agent))) {
    drop(agentId);
    say(agent, undefined, `${settings} changed, and its CLI was launched on the values it has now: nothing to restart`);
    return { action: 'next-launch', why: 'its CLI already runs on these values' };
  }
  if (getProvider(agent.provider).binaryName !== 'claude') {
    drop(agentId);
    say(agent, undefined, `${settings} changed: its CLI does not say when a turn ends, so the new values wait for its next launch`);
    return { action: 'next-launch', why: 'its CLI does not report the end of a turn' };
  }

  const wait = (reason: RestartWait, line: string, retryInMs?: number): RestartOutcome => {
    say(agent, entry, `${settings} changed: restarting ${line}`);
    if (retryInMs !== undefined) lookAgain(agentId, retryInMs + 50);
    return waitingOn(agentId, entry, reason);
  };

  if (agent.status === 'running') return wait('turn', 'when its turn ends');
  if (dialogOpen(agent)) {
    return wait('permission', 'once its permission question is answered and the turn ends');
  }
  if (holdsFor(agentId)) return wait('note', 'once what is owed to it has been typed in');
  const inUse = fieldInUse(ptyProcess);
  if (inUse) {
    const line = inUse.reason === 'draft' ? 'once its field is empty: something is typed in it and not sent'
      : inUse.reason === 'typing' ? 'once nobody has typed in it for five seconds'
        : inUse.reason === 'queued' ? 'once the messages waiting for its field have gone in'
          : 'once the message just typed into it has started';
    return wait(inUse.reason, line, inUse.retryInMs);
  }
  // Last, because it reads the transcript. A turn that ended on work left
  // running in the background comes back by itself when that work reports,
  // as a turn of its own: its start and its end are what bring this back.
  const since = cliLaunchedAt(ptyProcess)
    ?? (agent.sessionRegisteredAt ? Date.parse(agent.sessionRegisteredAt) : undefined);
  const background = since !== undefined ? pendingBackgroundWork(agent, since) : [];
  if (background.length > 0) {
    return wait('background', `once the background work it started (${background.join(', ')}) has reported back`);
  }

  drop(agentId);
  say(agent, undefined, `${settings} changed: restarting its CLI now`);
  void restartNow(agent, 'settings');
  return { action: 'restarted' };
}

/**
 * Restart an agent's CLI because somebody asked, continuing its conversation:
 * the Dashboard's `restart` on a panel whose claude left fullscreen. The
 * window's own stop then start began a new conversation, since a start only
 * continues the last one once per app run.
 *
 * At once, whatever the agent is doing, as a stop would: the person asking is
 * the one who sees the turn or the draft it ends. A restart waiting on new
 * settings is done by this one, and nothing is left pending.
 */
export async function restartAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  const agent = agents.get(agentId);
  if (!agent) return { success: false, error: 'Agent not found' };
  if (restarting.has(agentId)) return { success: false, error: 'This agent is already restarting' };
  drop(agentId);
  console.log(`[restart] ${agent.name || agent.id}: restarting its CLI, as asked`);
  return restartNow(agent, 'asked');
}

async function settle(agentId: string): Promise<void> {
  if (!pending.has(agentId)) return;
  decide(agentId);
}

/**
 * End the terminal and launch again, on the conversation it had.
 *
 * The session being ended becomes the tombstone, so posts its hooks are still
 * making are refused. The same conversation is then continued under a new
 * session id (`--resume <id> --fork-session`, see agent:start): continued
 * under its own id it would be the tombstone, and every post of the restarted
 * session would be dropped as stale.
 */
async function restartNow(agent: AgentStatus, cause: 'settings' | 'asked'): Promise<{ success: boolean; error?: string }> {
  restarting.add(agent.id);
  restartedAt.set(agent.id, Date.now());
  try {
    const conversation = agent.resumableSessionId ?? null;
    if (agent.ptyId) {
      const old = ptyProcesses.get(agent.ptyId);
      ptyProcesses.delete(agent.ptyId);
      try {
        if (old) killPty(old);
      } catch (err) {
        console.warn(`[restart] ${agent.name || agent.id}: the old terminal did not close cleanly:`, err);
      }
    }
    if (agent.currentSessionId) agent.lastKilledSessionId = agent.currentSessionId;
    agent.currentSessionId = undefined;
    agent.ptyId = undefined;
    agent.ptyCwd = undefined;

    const result = await launchAgent(agent.id, '', { resumeSessionId: conversation });
    if (!result.success) throw new Error(result.error);
    return { success: true };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[restart] ${agent.name || agent.id}: the restart failed: ${why}`);
    agent.status = 'error';
    agent.error = cause === 'settings'
      ? `Tars restarted this agent to apply its new settings, and the restart failed: ${why}`
      : `The restart asked for did not start the agent again: ${why}`;
    agent.lastActivity = new Date().toISOString();
    saveAgents();
    broadcastToAllWindows('agent:status', {
      type: 'status', agentId: agent.id, status: 'error', timestamp: agent.lastActivity,
    });
    scheduleTick();
    return { success: false, error: why };
  } finally {
    restarting.delete(agent.id);
    // A change saved while this one ran is applied by another restart.
    if (pending.has(agent.id)) lookAgain(agent.id, SETTLE_MS);
  }
}

/** Test seam. */
export function resetAgentRestarts(): void {
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
  shown.clear();
  restarting.clear();
  restartedAt.clear();
  stopListening?.();
  stopListening = null;
}
