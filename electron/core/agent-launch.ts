import { hasClaudeHooks } from './end-of-turn';
import type { AgentPermissionMode, AgentProvider } from '../types';
import { ptyProcesses, type MessageSender } from './pty-manager';
import { cliRunningIn } from './agent-pty';
import { dialogOnScreen } from './terminal-mirror';
import { lastInterruptAt } from '../services/agent-truth';

/**
 * The launch of an agent's CLI in its terminal, reachable without a renderer.
 *
 * Every start from a window (the Dashboard, autostart, the Agents and Projects
 * pages, templates, team deployment) goes through the `agent:start` handler.
 * Starts from the main process itself used to build their own command: the
 * Kanban automation, which typed a bare `claude --dangerously-skip-permissions`
 * with no model, no effort and no MCP configuration, so its agents ran on
 * whatever the CLI defaulted to (it went with the old local board, 06/10); and
 * the restart that applies a changed model or effort, which did not exist. The
 * handler registers its launch here and the restart calls it, so there is one
 * way an agent's CLI is typed into its terminal.
 */
export interface AgentLaunchOptions {
  /** A model chosen for this launch alone, over the agent's own. */
  model?: string;
  provider?: AgentProvider;
  localModel?: string;
  /** Over the agent's own, for this launch alone. */
  permissionMode?: AgentPermissionMode;
  /**
   * Which conversation to pick up. Absent: the usual rule, the last session
   * once per app run (utils/resume-session.ts). A session id: that session,
   * continued under a new id, which is what a restart does. Null: none.
   */
  resumeSessionId?: string | null;
  /**
   * The prompt is a message of a chat (services/chat-runners.ts): the CLI's
   * first turn, never kept as the agent's saved prompt, which is its brief
   * (the agent's form, a template, a team's brief) and its role in its
   * bootstrap.
   */
  message?: boolean;
  /** Who sent that message: a retype of the launch's task types it under them, never as Tars (the Audit's L2 on #569). */
  sender?: MessageSender;
}

export type AgentLaunchResult =
  | { success: true }
  | { success: false; cliRunning?: boolean; error: string };

export type AgentLauncher = (
  agentId: string,
  prompt: string,
  options?: AgentLaunchOptions,
) => Promise<AgentLaunchResult>;

let launcher: AgentLauncher | null = null;

/** Called once, by the handler that owns the launch. */
export function registerAgentLauncher(fn: AgentLauncher): void {
  launcher = fn;
}

/**
 * Whether a chat's runner may start now: a slot within the RAM's limit, taken
 * (services/chat-runners.ts sets it), or why not. Every start of a runner goes
 * through it, whoever starts it: a send in its chat, a wake by news, a
 * restart, a worker's message to it (the Audit's M5). An agent that runs no
 * chat passes at once.
 */
export type SlotGate = (agentId: string) => Promise<{ ok: true; release: () => void } | { ok: false; error: string }>;
let slotGate: SlotGate | undefined;

export function setSlotGate(gate: SlotGate | undefined): void {
  slotGate = gate;
}

/** The slot an agent's start takes, or why it may not start now. */
export function takeSlot(agentId: string): ReturnType<SlotGate> {
  return slotGate ? slotGate(agentId) : Promise.resolve({ ok: true, release: () => undefined });
}

/** Launch an agent's CLI the way `agent:start` does. */
export async function launchAgent(agentId: string, prompt: string, options?: AgentLaunchOptions): Promise<AgentLaunchResult> {
  if (!launcher) throw new Error('No agent launcher registered: the IPC handlers are not set up yet');
  const slot = await takeSlot(agentId);
  if (!slot.ok) return { success: false, error: slot.error };
  try {
    return await launcher(agentId, prompt, options);
  } finally {
    slot.release();
  }
}

/**
 * How long a launch counts as starting: from the moment one begins until its
 * CLI takes the terminal. A warm start takes about 1.4 s (measured before
 * SessionStart); past this, whatever was typed is not coming up.
 */
export const CLI_BOOT_MS = 15_000;

/**
 * How long a launch whose CLI runs still counts as starting, its session or
 * its task not begun. Past CLI_BOOT_MS a CLI that never ran is given up, but
 * one that runs is booting slowly: at a load average of 120 to 300, 5 of 18
 * launches took longer than 15 s, and a sender released then typed into a
 * claude not yet taking keys, answered "message", and the text was lost (the
 * Database Engineer, re-gate of #134). SessionStart itself took 77 s once with
 * the network down. Past this, it is not coming up.
 */
export const CLI_UP_MS = 180_000;

/**
 * The longest a sender answering an HTTP caller waits on a launch: the MCP
 * tools give up on a call after 30 s (mcp-orchestrator/src/utils/api.ts), and
 * an answer sent after that reaches nobody.
 */
export const SENDER_WAIT_MS = 20_000;

/**
 * Launches under way, by agent: when each began, and whether it carries a
 * task for the CLI to start on. One per agent, the latest.
 */
const launchesUnderWay = new Map<string, { since: number; withTask: boolean }>();

/**
 * Told when a launch begins or is abandoned, so the page can say `starting`
 * (AgentStatus.launching) without a status change to carry it: a restart keeps
 * `idle`. agents-tick listens, and watches the window until it closes by
 * itself (sessionStarting drops a launch that came up or timed out).
 */
let launchListener: (() => void) | undefined;

export function setLaunchListener(fn: (() => void) | undefined): void {
  launchListener = fn;
}

/** The agents with a launch under way, as far as this map knows. */
export function launchesPending(): string[] {
  return [...launchesUnderWay.keys()];
}

/**
 * A launch into an agent's terminal has begun: a start from a window, a
 * restart, a bot's cold start. Until its CLI runs there, the terminal is a
 * shell that is about to hand over, and anything that would start a session
 * over it must wait instead (see sessionStarting). Returns the launch, for
 * launchAbandoned.
 */
export function launchBegins(agentId: string, opts: { withTask?: boolean } = {}): object {
  const launch = { since: Date.now(), withTask: !!opts.withTask };
  launchesUnderWay.set(agentId, launch);
  launchListener?.();
  return launch;
}

/** That launch failed or was refused: nothing is coming up. */
export function launchAbandoned(agentId: string, launch: object): void {
  if (launchesUnderWay.get(agentId) !== launch) return;
  launchesUnderWay.delete(agentId);
  launchListener?.();
}

/**
 * Whether an agent's session is on its way: a launch began less than
 * CLI_BOOT_MS ago and no CLI runs in its terminal yet.
 *
 * Measured by the Audit on 2026-09-23 (re-gate of #120 and #126): from a
 * restart's kill to the new CLI's exec there is about 0.6 s in which the
 * terminal is a bare shell, or none at all, and cliRunningIn rightly says no
 * CLI. A /dispatch landing there started a session over the launch, without
 * --resume (spent once per run), and the conversation was lost; landing just
 * after the launch was typed, the CLI it killed had already started, and its
 * late SessionStart took the agent from the live session, which then ended in
 * error while its CLI answered.
 */
export function sessionStarting(agent: StartingAgent): boolean {
  const launch = launchesUnderWay.get(agent.id);
  if (!launch) return false;
  const elapsed = Date.now() - launch.since;
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  // Past CLI_BOOT_MS, only a CLI that runs is still starting: see CLI_UP_MS.
  const booting = elapsed < CLI_BOOT_MS || (elapsed < CLI_UP_MS && !!terminal && cliRunningIn(terminal));
  if (!booting || sessionUp(agent, launch)) {
    launchesUnderWay.delete(agent.id);
    return false;
  }
  return true;
}

/**
 * When the CLI now running in each terminal was launched, noted by every
 * launch (`noteLaunch`). Keyed by the terminal, so a new one never inherits it,
 * and moved by a new CLI typed into the same terminal.
 *
 * What background work is counted from. A job started before this moment was
 * started by a CLI that is gone, and is not running whatever the transcript
 * copied from it says. A session's registration is no substitute: claude sends
 * a SessionStart at every compaction too, in the same process and session, and
 * a job started before the compaction is still running after it.
 */
const cliLaunchedAtByTerminal = new WeakMap<object, number>();

export function noteCliLaunched(ptyProcess: object): void {
  cliLaunchedAtByTerminal.set(ptyProcess, Date.now());
}

export function cliLaunchedAt(ptyProcess: object | undefined): number | undefined {
  return ptyProcess ? cliLaunchedAtByTerminal.get(ptyProcess) : undefined;
}

type StartingAgent = {
  id: string; ptyId?: string; provider?: AgentProvider; sessionRegisteredAt?: string; lastTurnStartedAt?: string;
};

/**
 * Up, for a CLI on the claude binary, once a session has registered since the
 * launch began (its SessionStart), not once the process has exec'd: measured
 * in a sandbox on 2026-09-23, a message typed the moment claude 2.1.280
 * exec'd landed in its field and the Enter after it was lost, the CLI not yet
 * taking keys. The other CLIs send no SessionStart; for them the exec is all
 * there is to go on.
 *
 * A launch that carries a task is up once that task's turn has begun (its
 * UserPromptSubmit), not at its SessionStart: in between, claude submits the
 * prompt it was started with from its own field, and a message typed there in
 * that moment was lost (measured in the app, /start then /dispatch at 0.3 s,
 * once in five after the SessionStart wait). Typed once the turn runs, claude
 * queues it and takes it after the turn.
 */
function sessionUp(agent: StartingAgent, launch: { since: number; withTask: boolean }): boolean {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (!terminal || !cliRunningIn(terminal)) return false;
  if (!hasClaudeHooks(agent)) return true;
  const at = launch.withTask ? agent.lastTurnStartedAt : agent.sessionRegisteredAt;
  return !!at && Date.parse(at) >= launch.since;
}

/**
 * For a sender that launches an agent's CLI unless one already runs in its
 * terminal (the Telegram and Slack bots): the launch is marked the moment it is
 * known to be one, before its terminal is opened and its command typed, so no
 * other sender takes the bare shell in between for an idle terminal. Null when
 * a CLI is up there and the sender will type into it instead: marking that
 * would make every other sender wait on a launch that never happens.
 */
export function launchUnlessRunning(agent: StartingAgent): object | null {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  // A bot's launch always starts the CLI on the message it was sent.
  return terminal && cliRunningIn(terminal) ? null : launchBegins(agent.id, { withTask: true });
}

/**
 * Wait for a session on its way to be up, or for its launch to be given up
 * on, for `maxWaitMs` at most. True when there is nothing left to wait for;
 * false when it is still starting, and the caller must type nothing: typed
 * now, it would land in a claude that is not taking keys.
 */
export async function sessionStarted(agent: StartingAgent, maxWaitMs = Infinity): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (sessionStarting(agent)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return true;
}

/** Test seam. */
export function resetLaunches(): void {
  launchesUnderWay.clear();
}

/**
 * Why Tars may not type into an agent's CLI now, or null when it may. The one
 * definition every writer asks, so a new writer cannot forget a case:
 * - `dialog`: the CLI shows a dialog (the PermissionRequest hook said so:
 *   `waiting`, `permission`). A permission, an AskUserQuestion (which fires
 *   that hook in bypass too), an ExitPlanMode. Anything typed is read by the
 *   dialog, and its Enter answers it: measured by the Audit on 2026-09-24 with
 *   claude 2.1.280, a room post said Yes to "Do you want to proceed?" and
 *   "Yes, delete it" to "Delete the build folder?". Enforced by the writer
 *   itself (pty-manager.ts), at the moment it writes.
 * - `no_cli`: no CLI runs in the terminal, which is a shell.
 * - `launch`: a launch is on its way and its session is not up (sessionStarting).
 * - `turn`: a turn runs. A room message and a note wait for its end
 *   (agent-watch); /dispatch and /message type it as a queued steer.
 * Only `dialog` is refused by the writer: the others are each caller's own
 * decision, and they already make it.
 */
export type TypingRefusal = 'dialog' | 'no_cli' | 'launch' | 'turn';

export function dialogOpen(agent: {
  status?: string; waitingReason?: string; dialogSince?: string;
  currentSessionId?: string; projectPath?: string; worktreePath?: string;
}): boolean {
  if (agent.status !== 'waiting' || agent.waitingReason !== 'permission') return false;
  // Refused, with "No" or Esc: Claude Code sends no hook for it, and records
  // "[Request interrupted by user" in the transcript. An interrupt recorded
  // since the dialog opened closes it (the Audit's gate of #174: without this
  // the agent stayed deaf until JeanBrasse typed in it). Without a time the dialog
  // opened at, it stays open: the safe side.
  const since = agent.dialogSince ? Date.parse(agent.dialogSince) : NaN;
  if (!Number.isFinite(since)) return true;
  const interrupted = lastInterruptAt(agent);
  return interrupted === undefined || interrupted < since;
}

/**
 * A dialog the hook reported, or one on the screen whose hook has not arrived
 * yet (dialogOnScreen, terminal-mirror.ts). The screen only ever adds a
 * dialog: it never takes away one the hook reported.
 */
export function dialogShown(agent: Parameters<typeof dialogOpen>[0], ptyProcess: import('node-pty').IPty | undefined): boolean {
  return dialogOpen(agent) || dialogOnScreen(ptyProcess);
}

export function agentTakesTyping(
  agent: StartingAgent & { status?: string; waitingReason?: string },
  ptyProcess: import('node-pty').IPty | undefined,
): TypingRefusal | null {
  if (dialogShown(agent, ptyProcess)) return 'dialog';
  if (!ptyProcess || !cliRunningIn(ptyProcess)) return 'no_cli';
  if (sessionStarting(agent)) return 'launch';
  if (agent.status === 'running') return 'turn';
  return null;
}
