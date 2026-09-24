import * as path from 'path';
import { AcpSession, endProcessTreesNow, type TurnResult } from './client';
import { acpLaunchFor, loadAcpRegistry } from './registry';
import { getMcpOrchestratorPath, getMcpMemoryPath } from '../mcp-orchestrator';
import { getProvider } from '../../providers';
import { safeEffort } from '../../providers/cli-provider';
import type { AgentStatus, AppSettings } from '../../types';
import * as fs from 'fs';
import { recordUsage } from '../usage-ledger';
import { mintRunToken } from '../../core/agent-tokens';
import { buildFullPath } from '../../utils/path-builder';
import { cliPathDirs } from '../../utils/cli-path-dirs';
import { API_PORT } from '../../constants';
import { isSuperAgent } from '../../utils';

/**
 * A delegated task run over ACP rather than typed into a terminal: it returns
 * the agent's answer, why the turn ended, the tools it used and what it cost,
 * for any CLI that speaks the protocol.
 */

export interface DelegationResult {
  ok: boolean;
  transport: 'acp';
  /**
   * Whether the task reached the agent. False only when the run never started,
   * the one case where typing it into the terminal instead cannot run it twice.
   */
  started: boolean;
  /** `turn_limit` when the run was stopped at its time limit, mid-work. */
  stopReason?: string;
  text: string;
  toolCalls: string[];
  /** What the turn left running, stopped with the agent: a run is one turn (backgroundOf, client.ts). */
  backgroundStopped?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costUSD?: number;
  error?: string;
}

/** This Tars, for the child to call back on. The constant, not the live
 *  socket: the server retries the same port and never moves to another. */
function apiUrl(): string {
  return `http://127.0.0.1:${API_PORT}`;
}

/** Tools an orchestrator must not use itself, whatever CLI it runs. */
const ORCHESTRATOR_DENY = ['write', 'edit', 'create file', 'multiedit', 'notebook'];

function mcpServersFor(agent: AgentStatus, apiToken: string): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  // By name, since a CLI may start these servers with this list and nothing
  // else. The API takes the caller from the token; the id alone names nobody.
  const env = [
    { name: 'CLAUDE_AGENT_ID', value: agent.id },
    { name: 'CLAUDE_PROJECT_PATH', value: agent.projectPath },
    { name: 'CLAUDE_MGR_API_TOKEN', value: apiToken },
    // Which Tars to call back: mcp-orchestrator falls back to 31415 without it.
    { name: 'CLAUDE_MGR_API_URL', value: apiUrl() },
  ];

  const servers: { name: string; command: string; args: string[]; env: typeof env }[] = [];
  for (const [name, serverPath] of [
    ['tars-memory', getMcpMemoryPath()],
    ['claude-mgr-orchestrator', getMcpOrchestratorPath()],
  ] as const) {
    if (fs.existsSync(serverPath)) {
      servers.push({ name, command: 'node', args: [serverPath], env });
    }
  }
  return servers;
}

/**
 * The runs under way, by agent, so that stopping or deleting an agent stops its
 * delegated runs too (the Audit's table on a3d7c125, #6: one went on for up to
 * its hour with the agent's run token).
 */
interface Run { session: AcpSession; done: Promise<void>; stoppedWhy?: string }
const runs = new Map<string, Set<Run>>();
/** How long a run asked to cancel gets to end its turn before its processes are ended. */
const CANCEL_GRACE_MS = 1_500;

/**
 * Stops every delegated run of this agent: a cancel over the protocol, then
 * AcpSession.stop. Its caller is told the run was stopped, and why. Returns the count.
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
 * Ends every delegated run before Tars exits (before-quit): a best-effort cancel,
 * then their process trees while the quit waits, SIGTERM, at most a second,
 * SIGKILL. Before it (#197), a run still answering ended 2.4 s after the quit,
 * and a wedged one was whole 14 s later, reparented to launchd. Returns the count.
 */
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
  onEvent?: (event: { type: string; payload: unknown }) => void;
}): Promise<DelegationResult> {
  const { agent, task, appSettings, onEvent } = opts;

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
  // This run's own token: spawnAgentPty is not on this path, and on the shared
  // token its MCP calls would have no agent behind them (no bus room, no
  // delegation onward). Not the terminal's, so neither cuts the other off.
  const { token: apiToken, revoke } = mintRunToken(agent.id);
  const session = new AcpSession(launch, {
    cwd,
    env: {
      // The PATH of every other launch, Settings > CLI Paths first: an app opened
      // from the Dock has launchd's, without npx ("spawn npx ENOENT", 2026-09-18).
      // The agent inherits it, so npx and the MCP servers find node.
      PATH: buildFullPath(cliPathDirs(appSettings.cliPaths)),
      ...provider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills ?? [], appSettings),
      CLAUDE_AGENT_ID: agent.id,
      CLAUDE_PROJECT_PATH: agent.projectPath,
      CLAUDE_MGR_API_TOKEN: apiToken,
      // Which Tars this run answers to, as every terminal gets (agent-pty.ts).
      // Without it an ACP run's hooks posted to 31415: a sandbox on 31493 reached
      // the live app, refused as `Agent not found`, the port no longer a boundary.
      CLAUDE_MGR_API_URL: apiUrl(),
    },
    mcpServers: mcpServersFor(agent, apiToken),
    permissionMode: agent.permissionMode === 'bypass' ? 'bypass'
      : agent.permissionMode === 'auto' ? 'auto' : 'normal',
    // An orchestrator delegates, it does not edit: enforced by the protocol, on
    // the role every launch reads (core/agent-role.ts).
    denyTools: isSuperAgent(agent) ? ORCHESTRATOR_DENY : undefined,
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

  let started = false;
  try {
    await session.start();
    // The agent's own model and effort, set once the session is open (no command
    // line here), model first since the efforts on offer depend on it. Without
    // this every delegation ran on the adapter's defaults.
    const model = agent.model && agent.model !== 'default' ? agent.model : undefined;
    if (model && !(await session.setConfigOption('model', model))) {
      console.warn(`[acp] ${agent.name || agent.id}: this run is not on ${model}, the agent did not take it`);
    }
    const effort = safeEffort(agent.effort);
    if (effort && !(await session.setConfigOption('effort', effort))) {
      console.warn(`[acp] ${agent.name || agent.id}: this run is not at ${effort} effort, the agent did not take it`);
    }
    started = true;
    let turn: TurnResult;
    try {
      turn = await session.prompt(task, opts.timeoutMs);
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
        model: agent.model,
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
      stopReason: turn.stopReason,
      text: turn.text,
      toolCalls: turn.toolCalls.map(t => t.title),
      backgroundStopped: turn.background.length ? turn.background : undefined,
      usage: turn.usage,
      costUSD: turn.costUSD,
      ...(run.stoppedWhy ? { error: `the run was stopped: ${run.stoppedWhy}` } : {}),
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
