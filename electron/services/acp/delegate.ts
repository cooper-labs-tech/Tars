import * as path from 'path';
import { AcpSession, endProcessTreesNow, type TurnResult } from './client';
import { acpLaunchFor, loadAcpRegistry } from './registry';
import { getMcpOrchestratorPath, getMcpMemoryPath } from '../mcp-orchestrator';
import { getProvider } from '../../providers';
import { safeEffort } from '../../providers/cli-provider';
import type { AgentStatus, AppSettings } from '../../types';
import * as fs from 'fs';
import { recordUsage } from '../usage-ledger';
import { mintRunToken, tarsInstanceId } from '../../core/agent-tokens';
import { buildFullPath } from '../../utils/path-builder';
import { cliPathDirs } from '../../utils/cli-path-dirs';
import { mcpNodeCommand } from '../../utils/mcp-node';
import { API_PORT } from '../../constants';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { accountEnvFor } from '../../core/account-env';
import { isQuitting } from '../../core/quit-state';
import { agentTmpEnvOrNone } from '../agent-tmp';
import { guideForPrompt } from '../agent-guide';

/**
 * Running a delegated task over ACP instead of typing it into a terminal.
 *
 * The difference that matters: this returns. The caller gets the agent's
 * answer, why the turn ended, which tools it used and what the turn cost,
 * for any CLI that speaks the protocol, not just for Claude.
 */

/**
 * A model asked for one run, and what came of it: `taken` when the agent took
 * it; `own`, the agent's saved model when it has one; `ranOn`, the model the
 * run is on, the asked one or else the agent's own. No `ranOn`: neither was
 * taken, and the run is on its CLI's default.
 */
export interface RunModel { asked: string; taken: boolean; own?: string; ranOn?: string }

export interface DelegationResult {
  ok: boolean;
  transport: 'acp';
  /**
   * Whether the task reached the agent. False only when the run could not
   * start at all, which is the one case where typing the task into the
   * agent's terminal instead does not run it twice.
   */
  started: boolean;
  /** `turn_limit` when the run was stopped at its time limit, mid-work. */
  stopReason?: string;
  text: string;
  toolCalls: string[];
  /**
   * What the turn left running when it ended, stopped with the agent: a run
   * is one turn, and nothing brings the agent back for it (backgroundOf, in
   * client.ts).
   */
  backgroundStopped?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
  costUSD?: number;
  error?: string;
  /** A model asked for this run only (delegate_task's `model`): what the run is on (RunModel). */
  model?: RunModel;
  /** `permission_escalation_denied`: held to a mode the agent does not offer, it did not run. */
  code?: string;
}

/** This Tars, for the child to call back on. The constant, not the live
 *  socket: the server retries the same port and never moves to another. */
function apiUrl(): string {
  return `http://127.0.0.1:${API_PORT}`;
}

/** Tools an orchestrator must not use itself, whatever CLI it runs. */
const ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook'];

function mcpServersFor(agent: AgentStatus, apiToken: string): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  // Handed over by name, since a CLI may start these servers with this list
  // and nothing else. The token is what the API takes the caller from; the id
  // alone would make every call from this run nobody's.
  const env = [
    { name: 'CLAUDE_AGENT_ID', value: agent.id },
    { name: 'CLAUDE_PROJECT_PATH', value: agent.projectPath },
    { name: 'CLAUDE_MGR_API_TOKEN', value: apiToken },
    // What the servers prove the port with before they send that token
    // (mcp-shared tokenToPresent). Codex hands a server this list and nothing
    // of its own environment (measured by QA on codex 0.148.0): without it,
    // every Tars tool of a Codex run went without a token, a 401.
    { name: 'TARS_INSTANCE_ID', value: tarsInstanceId() },
    // Which Tars to call back. These servers get the list below and nothing
    // else, and mcp-orchestrator falls back to 31415 without it.
    { name: 'CLAUDE_MGR_API_URL', value: apiUrl() },
  ];

  const servers: { name: string; command: string; args: string[]; env: typeof env }[] = [];
  for (const [name, serverPath] of [
    ['tars-memory', getMcpMemoryPath()],
    ['claude-mgr-orchestrator', getMcpOrchestratorPath()],
  ] as const) {
    if (fs.existsSync(serverPath)) {
      servers.push({ name, command: mcpNodeCommand(), args: [serverPath], env });
    }
  }
  return servers;
}

/**
 * The runs under way, by agent, so that stopping or deleting an agent stops its
 * delegated run too (the Audit's table on a3d7c125, #6): cancel() had no
 * caller, and a stopped agent's run went on working for up to its hour with
 * the agent's run token.
 */
interface Run { session: AcpSession; done: Promise<void>; stoppedWhy?: string }
const runs = new Map<string, Set<Run>>();
/** How long a run asked to cancel gets to end its turn before its processes are ended. */
const CANCEL_GRACE_MS = 1_500;

/**
 * Stop every delegated run of this agent: asked to cancel over the protocol
 * first, then ended with every process it started (AcpSession.stop). Its caller
 * is answered that the run was stopped, and why. Returns how many were stopped.
 */
export async function stopAcpRuns(agentId: string, why: string): Promise<number> {
  const live = [...(runs.get(agentId) ?? [])];
  await Promise.all(live.map(async run => {
    run.stoppedWhy = why;
    await run.session.cancel();
    await Promise.race([run.done, new Promise(resolve => setTimeout(resolve, CANCEL_GRACE_MS))]);
    run.session.stop();
  }));
  if (live.length) console.log(`[acp] stopped ${live.length} delegated run(s) of ${agentId}: ${why}`);
  return live.length;
}

/**
 * End every delegated run before Tars exits, whatever it is doing. Called from
 * before-quit. The runs are asked to cancel, which is best effort, since the
 * message may not leave before the process does. Then their processes, and
 * every command their CLIs started, are ended while the quit waits: SIGTERM,
 * at most a second, SIGKILL. Measured on #197 before this: a run that still
 * answered ended by itself 2.4 s after the quit, and a wedged one was whole
 * 14 s later, reparented to launchd. Returns how many runs were ended.
 */
/** The agents with a delegated run under way: the temporary folders' retention leaves theirs alone. */
export function agentsRunningOverAcp(): string[] {
  return [...runs].filter(([, set]) => set.size > 0).map(([id]) => id);
}

export function endAcpRunsOnQuit(): number {
  const live = [...runs.values()].flatMap(set => [...set]).filter(run => run.session.isRunning);
  const roots: number[] = [];
  for (const run of live) {
    run.stoppedWhy = 'Tars quit';
    void run.session.cancel();
    const pid = run.session.releaseForQuit();
    if (pid !== undefined) roots.push(pid);
  }
  endProcessTreesNow(roots);
  if (live.length) console.log(`[acp] ended ${live.length} delegated run(s) on quit`);
  return live.length;
}

export function canDelegateOverAcp(agent: AgentStatus): boolean {
  return !!acpLaunchFor(agent.provider ?? 'claude');
}

/**
 * Runs one task to completion. The session lives for the task and is torn
 * down after: a delegated task is a unit of work, not a conversation.
 */
export async function delegateOverAcp(opts: {
  agent: AgentStatus;
  task: string;
  appSettings: AppSettings;
  timeoutMs?: number;
  /**
   * The mode the run takes, when its asker holds it to a narrower one than the
   * agent's own (core/permission-ceiling.ts). Absent: the agent's own.
   */
  permissionMode?: 'plan' | 'normal' | 'auto' | 'bypass';
  /**
   * A model for this run only, in place of the agent's own: the agent's saved
   * model is not changed. Absent: the agent's own.
   */
  model?: string;
  /** Called once the run has started, before its turn: the moment it is a task (task-ledger.ts acpStarted). */
  onStarted?: (run: { model?: RunModel }) => void;
  onEvent?: (event: { type: string; payload: unknown }) => void;
}): Promise<DelegationResult> {
  const { agent, task, appSettings, onEvent } = opts;
  // A run started while the quit ends the others would outlive Tars.
  if (isQuitting()) {
    return { ok: false, transport: 'acp', started: false, text: '', toolCalls: [], error: 'Tars is quitting: no new delegated run is started.' };
  }

  await loadAcpRegistry().catch(() => undefined);
  const launch = acpLaunchFor(agent.provider ?? 'claude');
  if (!launch) {
    return { ok: false, transport: 'acp', started: false, text: '', toolCalls: [], error: 'provider has no ACP mode' };
  }

  const cwd = agent.worktreePath || agent.projectPath;
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, transport: 'acp', started: false, text: '', toolCalls: [], error: `working directory is missing: ${cwd}` };
  }

  const provider = getProvider(agent.provider ?? 'claude');
  // This run's own token. spawnAgentPty, which gives a terminal its token, is
  // not on this path, and without one the run's MCP servers would fall back to
  // the shared token, on which a call has no agent behind it: no room on the
  // bus, no delegation onward. Its own rather than the terminal's, so that
  // neither can cut the other off, and revoked when the run is over.
  const { token: apiToken, revoke } = mintRunToken(agent.id);
  // The Claude account this run bills, the one its agent's terminal would
  // start on. Measured: the adapter's own claude (2.1.232) honours
  // CLAUDE_CONFIG_DIR, keychain naming included (the Audit's N9).
  const account = accountEnvFor(agent.id, cwd, 'delegation');
  const session = new AcpSession(launch, {
    cwd,
    env: {
      // The PATH every other launch of the main process gets, the folders set
      // in Settings > CLI Paths first. Without it the launch had the app's own,
      // and an app opened from the Dock has launchd's, where npx is not: the
      // "spawn npx ENOENT" of 2026-09-18. The agent inherits it too, which is
      // how npx finds node and the agent finds its MCP servers' node.
      PATH: buildFullPath(cliPathDirs(appSettings.cliPaths)),
      ...provider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills ?? [], appSettings),
      CLAUDE_AGENT_ID: agent.id,
      CLAUDE_PROJECT_PATH: agent.projectPath,
      CLAUDE_MGR_API_TOKEN: apiToken,
      // What its hooks check the port with before they send that token (#11).
      TARS_INSTANCE_ID: tarsInstanceId(),
      // Which Tars this run answers to, as spawnAgentPty gives every terminal
      // (agent-pty.ts). It was missing here, so the hooks of an ACP run posted
      // to 31415 whatever port this Tars was on: three posts from a sandbox on
      // 31493 reached the live app and were refused as `Agent not found`.
      // Nothing was written, but the port stopped being the boundary it is
      // everywhere else.
      CLAUDE_MGR_API_URL: apiUrl(),
      // Its agent's own temporary folder, as its terminal gets (services/agent-tmp.ts).
      ...agentTmpEnvOrNone(agent.id),
      ...account?.set,
    },
    unsetEnv: account?.unset,
    mcpServers: mcpServersFor(agent, apiToken),
    permissionMode: opts.permissionMode ?? (agent.permissionMode === 'bypass' ? 'bypass'
      : agent.permissionMode === 'auto' ? 'auto' : agent.permissionMode === 'plan' ? 'plan' : 'normal'),
    // An orchestrator delegates; it does not edit. Enforced here by the
    // protocol rather than by a flag only one CLI understands. The
    // orchestrator's powers, as every launch reads them: its project's
    // orchestrator, or a chat's runner (core/agent-role.ts).
    denyTools: hasOrchestratorPowers(agent) ? ORCHESTRATOR_DENY : undefined,
  });

  if (onEvent) {
    session.on('text', chunk => onEvent({ type: 'text', payload: chunk }));
    session.on('tool', tool => onEvent({ type: 'tool', payload: tool }));
    session.on('plan', plan => onEvent({ type: 'plan', payload: plan }));
    session.on('permission', p => onEvent({ type: 'permission', payload: p }));
  }

  let settle!: () => void;
  const run: Run = { session, done: new Promise<void>(resolve => { settle = resolve; }) };
  const own = runs.get(agent.id) ?? new Set<Run>();
  own.add(run);
  runs.set(agent.id, own);

  // Held to plan and out of it (client.ts, 'breach'): the run is cut at once,
  // its processes ended before the edit leaving plan was for (the Audit's B1
  // on #364), and its asker answered permission_escalation_denied.
  let breach: string | undefined;
  session.on('breach', (mode: string) => {
    if (breach) return;
    breach = mode;
    run.stoppedWhy = `it left plan mode (to ${mode}), and its asker holds it to plan`;
    console.warn(`[acp] ${agent.name || agent.id}: a run held to plan left it for ${mode}: cut`);
    void session.cancel();
    session.stop();
  });
  const escaped = () => (breach ? { ok: false, code: 'permission_escalation_denied', stopReason: 'permission_escalation_denied' } : {});

  let started = false;
  let runModel: RunModel | undefined;
  // The model the session took, asked or the agent's own. None: the CLI's
  // default, which Tars cannot name, and under which no turn is filed.
  let ranOn: string | undefined;
  try {
    await session.start();
    // The agent's own model and effort. A launch in a terminal puts them on the
    // command line; this one has none, so the session is configured once open,
    // through the options the agent offers, model first because the effort
    // levels on offer depend on the model. Without this every delegation ran
    // on the adapter's default model and effort, whatever the agent was set to.
    // A model asked for this run alone comes first. Refused, the agent's own
    // is set instead: left there, the run went on the adapter's default while
    // its caller was told the agent's own (the Audit's M2 on #447). Said back
    // as it happened: asked, taken or not, and the model the run is on.
    const asked = opts.model?.trim() && opts.model.trim() !== 'default' ? opts.model.trim() : undefined;
    const own = agent.model && agent.model !== 'default' ? agent.model : undefined;
    for (const model of asked && asked !== own ? [asked, own] : [asked ?? own]) {
      if (!model) continue;
      if (await session.setConfigOption('model', model)) { ranOn = model; break; }
      console.warn(`[acp] ${agent.name || agent.id}: this run is not on ${model}, the agent did not take it`);
    }
    if (asked) runModel = { asked, taken: ranOn === asked, ...(own ? { own } : {}), ...(ranOn ? { ranOn } : {}) };
    const effort = safeEffort(agent.effort);
    if (effort && !(await session.setConfigOption('effort', effort))) {
      console.warn(`[acp] ${agent.name || agent.id}: this run is not at ${effort} effort, the agent did not take it`);
    }
    started = true;
    try {
      opts.onStarted?.({ ...(runModel ? { model: runModel } : {}) });
    } catch (err) {
      console.warn('[acp] the start of a run was not recorded:', (err as Error).message);
    }
    let turn: TurnResult;
    try {
      // How Tars works, for its role, and its project's folder (services/agent-guide.ts),
      // once: a claude run has it from its bootstrap, since the adapter loads the
      // user's settings and Tars's SessionStart hook runs (measured on the 0.70.0
      // it pins: the hook fires at session/new); a run of another CLI has no
      // such hook, and gets it here.
      const guide = guideForPrompt(agent, provider.configDir);
      turn = await session.prompt(guide ? `${guide}\n\n${task}` : task, opts.timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/session\/prompt timed out/.test(message)) throw err;
      // Stopped at its limit, mid-work: the stop below kills whatever command
      // was running (QA and Database of the Parallel project, 2026-09-23, at
      // exactly 3600 s). What it said and did by then is all there is.
      const partial = session.partialTurn();
      const seconds = Math.round((opts.timeoutMs ?? 0) / 1000);
      return {
        ok: false,
        transport: 'acp',
        started: true,
        ...(runModel ? { model: runModel } : {}),
        stopReason: 'turn_limit',
        text: partial.text,
        toolCalls: partial.toolCalls.map(t => t.title),
        backgroundStopped: partial.background.length ? partial.background : undefined,
        error: `stopped at the run's limit of ${seconds} s while the agent was still working; `
          + 'what it said and did before the limit is above, and nothing after it was reported',
      };
    }

    // Every provider reports its tokens over ACP, which is the only place
    // non-Claude usage can be captured at all.
    if (turn.usage || turn.costUSD != null) {
      recordUsage({
        agentId: agent.id,
        provider: agent.provider ?? 'claude',
        model: ranOn,
        inputTokens: turn.usage?.inputTokens ?? 0,
        outputTokens: turn.usage?.outputTokens ?? 0,
        cachedReadTokens: turn.usage?.cachedReadTokens,
        cachedWriteTokens: turn.usage?.cachedWriteTokens,
        costUSD: turn.costUSD,
        transport: 'acp',
      });
    }

    return {
      ok: turn.stopReason === 'end_turn',
      transport: 'acp',
      started: true,
      ...(runModel ? { model: runModel } : {}),
      stopReason: turn.stopReason,
      text: turn.text,
      toolCalls: turn.toolCalls.map(t => t.title),
      backgroundStopped: turn.background.length ? turn.background : undefined,
      usage: turn.usage,
      costUSD: turn.costUSD,
      ...(run.stoppedWhy ? { error: `the run was stopped: ${run.stoppedWhy}` } : {}),
      ...escaped(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      transport: 'acp',
      started,
      text: run.stoppedWhy ? session.partialTurn().text : '',
      toolCalls: run.stoppedWhy ? session.partialTurn().toolCalls.map(t => t.title) : [],
      // Said as what happened, not as the crash it looks like from inside.
      error: run.stoppedWhy ? `the run was stopped: ${run.stoppedWhy}` : message,
      ...(/^permission_escalation_denied/.test(message) ? { code: 'permission_escalation_denied' } : {}),
      ...escaped(),
    };
  } finally {
    own.delete(run);
    if (own.size === 0 && runs.get(agent.id) === own) runs.delete(agent.id);
    settle();
    session.stop();
    revoke();
  }
}

/** Where the ACP launch commands are cached, for diagnostics. */
export function acpCachePath(dataDir: string): string {
  return path.join(dataDir, 'acp-registry.json');
}
