import { validateEndpointChoice } from '../services/inference-endpoints';
import { readAppSettingsFromDisk } from '../providers/cli-provider';
import * as fs from 'fs';
import { agents, saveAgents, killStalePty } from './agent-manager';
import { ptyProcesses } from './pty-manager';
import { killPty } from './pty-kill';
import { cliRunningIn } from './agent-pty';
import { sessionStarting } from './agent-launch';
import { orchestratorMoved } from './chat-identity';
import { launchSettings, changedLaunchSettings, restartForSettings, type RestartOutcome } from './agent-restart';
import { assignRole, requestedRole } from './agent-role';
import { planModeRefusal } from '../providers/plan-mode';
import { skillsProblem } from '../utils/skill-name';
import { handedFolderProblem } from '../utils/handed-folder';
import type { AgentStatus, AppSettings, WorktreeConfig, AgentCharacter, AgentProvider, AgentPermissionMode, AgentEffort, AgentRole } from '../types';

/**
 * An agent's settings changed: the one way in, for the window (agent:update)
 * and for an orchestrator (POST /api/agents/:id/update, the update_agent
 * tool). The window's handler was this body; update_agent takes it as it is
 * rather than a copy of it, which would drift.
 *
 * Every check first, git's included: a save refused changes nothing on the
 * record and kills no terminal. Then the save, which nothing refuses. Then
 * what the CLI only reads at launch is applied by restarting it, at a moment
 * that cuts nothing (core/agent-restart.ts).
 *
 * The two callers differ in one thing. The window ends the terminal a change
 * of provider, CLI path, project or worktree needs, whatever runs in it: the
 * user who saves sees what that cuts. An orchestrator does not, so its calls
 * pass `endsNoCli`, and such a change is refused while a CLI runs or starts
 * in the agent's terminal.
 */

export interface AgentUpdate {
  id: string;
  projectPath?: string;
  skills?: string[];
  secondaryProjectPath?: string | null;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort | null;
  name?: string;
  character?: AgentCharacter;
  model?: string | null;
  provider?: AgentProvider;
  localModel?: string | null;
  savedPrompt?: string | null;
  obsidianVaultPaths?: string[];
  worktree?: WorktreeConfig;
  /** The Orchestrator toggle. See core/agent-role.ts. */
  role?: AgentRole;
  /** The toggle's old name, read when `role` is absent. */
  orchestratorMode?: boolean;
  cliPath?: string | null;
  /** The inference endpoint its harness runs on, or null for none (services/inference-endpoints.ts). */
  endpointId?: string | null;
  /** Its own trace switch (services/trace-gate.ts). */
  traces?: boolean;
}

export interface AgentUpdateOptions {
  /** The window's, which makes an agent's own worktree (agent:create shares it). Without it a worktree is refused. */
  makeWorktree?: (projectPath: string, branchName: string) => Promise<{ worktreePath: string; branchName: string } | { error: string }>;
  /** Refuse a change that needs a new terminal while a CLI runs or starts in the agent's, rather than end it. */
  endsNoCli?: boolean;
}

export type AgentUpdateResult =
  | { success: false; error: string; code?: 'cli_running' }
  | {
    success: true;
    agent: AgentStatus;
    /** The fields of the record this changed. */
    changed: string[];
    /** What the CLI reads at launch that changed (core/agent-restart.ts). */
    changedAtLaunch: string[];
    /** What became of the restart they asked for, when they asked for one. */
    restart?: RestartOutcome;
  };

/**
 * A CLI at work in the agent's terminal: one runs there, or a launch is under
 * way (sessionStarting, core/agent-launch.ts), whose bare shell is about to
 * take it. Not a launch a stop has ended since: stop_agent leaves it marked
 * for up to CLI_BOOT_MS, and the agent stopped so that its CLI could be
 * changed read as starting one.
 */
export function cliAtWork(agent: AgentStatus): boolean {
  if (cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined)) return true;
  return agent.status !== 'stopped' && sessionStarting(agent);
}

/** The record's fields an update can change, compared before and after for `changed`. */
const FIELDS = [
  'name', 'character', 'provider', 'model', 'localModel', 'effort', 'permissionMode', 'cliPath', 'skills',
  'projectPath', 'secondaryProjectPath', 'obsidianVaultPaths', 'savedPrompt', 'worktreePath', 'branchName', 'role',
  'endpointId', 'traces',
] as const;

export async function updateAgent(params: AgentUpdate, opts: AgentUpdateOptions = {}): Promise<AgentUpdateResult> {
  const agent = agents.get(params.id);
  if (!agent) {
    return { success: false, error: 'Agent not found' };
  }
  // A chat's runner takes its settings from the project's orchestrator at
  // each launch (services/chat-runners.ts): changed here, its role would take
  // the orchestrator's place, its project would lose its worktree, and the
  // rest would be undone at its next send (the Audit's M2 on #379).
  if (agent.kind === 'chat') {
    return { success: false, error: `${agent.name || agent.id} runs a chat: its settings are the project's orchestrator's. Change them there.` };
  }
  // Plan on a provider that has none, set here or kept across a move to it, would run as normal (the Audit's Low 2 on #407).
  if (params.provider !== undefined || params.permissionMode !== undefined) {
    const noPlan = planModeRefusal(params.provider ?? agent.provider, params.permissionMode ?? agent.permissionMode);
    if (noPlan) return { success: false, error: noPlan };
  }
  let role: AgentRole | undefined;
  try {
    role = requestedRole(params);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Every check first, git's included: a save refused changes nothing on the record and kills no terminal, as
  // the Agents page tells the user ("Not saved: <reason>. Your changes are still here."). The name, the CLI and
  // the rest used to be written, and a terminal killed for a new provider or CLI, before git ran, and a refusal
  // undid none of it (the Audit's MEDIUM on #403).
  if (params.skills !== undefined) {
    const skillsWrong = skillsProblem(params.skills);
    if (skillsWrong) return { success: false, error: `Not saved: ${skillsWrong}.` };
  }
  // An endpoint, its harness and its model, checked together whenever one of them moves for an agent on one
  // (services/inference-endpoints.ts): approved, one of the four harnesses, a model it lists.
  const endpointAfter = params.endpointId === undefined ? agent.endpointId : params.endpointId ?? undefined;
  if (params.endpointId !== undefined || (endpointAfter && (params.provider !== undefined || params.model !== undefined))) {
    const wrong = validateEndpointChoice(readAppSettingsFromDisk() as AppSettings, {
      endpointId: endpointAfter, provider: params.provider ?? agent.provider, model: params.model === undefined ? agent.model : params.model,
    });
    if (wrong) return { success: false, error: `Not saved: ${wrong}` };
  }
  if (params.traces !== undefined && typeof params.traces !== 'boolean') return { success: false, error: 'Not saved: traces is on or off.' };
  const moving = params.projectPath !== undefined && params.projectPath !== agent.projectPath;
  if (moving && !fs.existsSync(params.projectPath!)) {
    return { success: false, error: 'Project path does not exist' };
  }
  // Never ~/.tars-private, from the window as from update_agent (the Audit's L4 on #480).
  const handed = params.secondaryProjectPath ? handedFolderProblem(params.secondaryProjectPath) : null;
  if (handed) return { success: false, error: `Not saved: ${handed}.` };
  if (params.secondaryProjectPath && !fs.existsSync(params.secondaryProjectPath)) {
    return { success: false, error: 'Secondary project path does not exist' };
  }
  const makesWorktree = !!(params.worktree?.enabled && params.worktree.branchName && (moving || !agent.worktreePath));
  // Last of the checks, before the one that writes: what would end the terminal, while a CLI is at work in it.
  if (opts.endsNoCli) {
    const ending = [
      ...(params.provider !== undefined && params.provider !== agent.provider ? ['provider'] : []),
      ...(params.cliPath !== undefined && (params.cliPath ?? undefined) !== agent.cliPath ? ['CLI path'] : []),
      ...(endpointTerminalChanges(agent, params) ? ['endpoint'] : []),
      ...(moving ? ['project'] : []),
      ...(makesWorktree ? ['worktree'] : []),
    ];
    if (ending.length > 0 && cliAtWork(agent)) {
      return {
        success: false,
        code: 'cli_running',
        error: `A CLI runs in the terminal of "${agent.name || agent.id}", and a new ${ending.join(' and ')} needs a new one: `
          + 'ending it would cut what it is doing. Stop the agent with stop_agent once its work is done, then change it; '
          + 'its next start runs the new CLI. Nothing was changed.',
      };
    }
  }
  // The worktree, the one check that writes: made before the record changes, in the project the agent will be in.
  // Only for an agent with none (a move detaches the old one): changing it under a running agent could be
  // destructive.
  let worktree: { worktreePath: string; branchName: string } | undefined;
  if (makesWorktree) {
    if (!opts.makeWorktree) return { success: false, error: 'An agent\'s worktree is set in the Agents page of Tars.' };
    const made = await opts.makeWorktree(moving ? params.projectPath! : agent.projectPath, params.worktree!.branchName);
    if ('error' in made) return { success: false, error: made.error };
    worktree = made;
  }
  // What the running CLI was started with, as far as this edit can change it.
  const launchBefore = launchSettings(agent);
  const before = FIELDS.map(field => JSON.stringify(agent[field]));

  // Then the save, which nothing refuses any more.
  if (moving) {
    agent.projectPath = params.projectPath!;
    agent.pathMissing = false;
    // The old worktree belongs to the previous repository. Detach it so the
    // agent works directly in the new project (a new worktree can be set up
    // via the worktree param).
    agent.worktreePath = undefined;
    agent.branchName = undefined;
    // BUG 4: any live PTY still has the old repo as cwd.
    killStalePty(agent);
    agent.status = 'idle';
    agent.currentTask = undefined;
  }
  if (params.skills !== undefined) {
    agent.skills = params.skills;
  }
  if (params.secondaryProjectPath !== undefined) {
    agent.secondaryProjectPath = params.secondaryProjectPath === null ? undefined : params.secondaryProjectPath;
  }
  if (params.permissionMode !== undefined) {
    agent.permissionMode = params.permissionMode;
  }
  if (params.effort !== undefined) {
    agent.effort = params.effort === null ? undefined : params.effort;
  }
  if (params.name !== undefined) {
    // Only the name: the role is the toggle's (core/agent-role.ts).
    agent.name = params.name;
  }
  if (params.character !== undefined) {
    agent.character = params.character;
  }
  // The endpoint session (its token, its model, whether it is traced) is minted with the terminal
  // (core/agent-pty.ts): a new endpoint, model or trace switch needs a new terminal, as a new provider does.
  if (endpointTerminalChanges(agent, params) && agent.ptyId) {
    const stale = ptyProcesses.get(agent.ptyId);
    if (stale) {
      killPty(stale);
      ptyProcesses.delete(agent.ptyId);
    }
    agent.ptyId = undefined;
    agent.ptyCwd = undefined;
    agent.status = 'idle';
    agent.currentTask = undefined;
  }
  if (params.endpointId !== undefined) agent.endpointId = params.endpointId ?? undefined;
  if (params.traces !== undefined) agent.traces = params.traces;
  if (params.model !== undefined) {
    agent.model = params.model === null ? undefined : params.model;
  }
  if (params.provider !== undefined) {
    if (params.provider !== agent.provider && agent.ptyId) {
      // The live PTY still carries the OLD provider's ANTHROPIC_* env.
      // Messages would silently route to the previous vendor. Kill it so
      // the next start/dispatch respawns with the new provider's env.
      const staleProviderPty = ptyProcesses.get(agent.ptyId);
      if (staleProviderPty) {
        killPty(staleProviderPty);
        ptyProcesses.delete(agent.ptyId);
      }
      agent.ptyId = undefined;
      agent.ptyCwd = undefined;
      agent.status = 'idle';
      agent.currentTask = undefined;
    }
    agent.provider = params.provider;
  }
  if (params.localModel !== undefined) {
    agent.localModel = params.localModel === null ? undefined : params.localModel;
  }
  if (params.savedPrompt !== undefined) {
    agent.savedPrompt = params.savedPrompt === null ? undefined : params.savedPrompt;
  }
  if (params.obsidianVaultPaths !== undefined) {
    agent.obsidianVaultPaths = params.obsidianVaultPaths;
  }
  if (params.cliPath !== undefined) {
    const newCliPath = params.cliPath === null ? undefined : params.cliPath;
    if (newCliPath !== agent.cliPath && agent.ptyId) {
      // Same reasoning as a provider change: the running PTY was spawned
      // with the old binary.
      const staleCliPty = ptyProcesses.get(agent.ptyId);
      if (staleCliPty) {
        killPty(staleCliPty);
        ptyProcesses.delete(agent.ptyId);
      }
      agent.ptyId = undefined;
      agent.ptyCwd = undefined;
      agent.status = 'idle';
      agent.currentTask = undefined;
    }
    agent.cliPath = newCliPath;
  }
  if (worktree) {
    agent.worktreePath = worktree.worktreePath;
    agent.branchName = worktree.branchName;
    // BUG 4: the running PTY (if any) was spawned with cwd=projectPath.
    // It must be killed so the next agent:start respawns in the new
    // worktree directory. Otherwise writes leak into the main workspace.
    killStalePty(agent);
    agent.status = 'idle';
    agent.currentTask = undefined;
  }

  // Last, once the project is settled: an orchestrator, whether the toggle
  // was just switched on or it has just moved in, is its project's only one.
  const demoted = assignRole(agent, role ?? (agent.role === 'orchestrator' ? 'orchestrator' : 'worker'), agents.values());

  agent.lastActivity = new Date().toISOString();
  saveAgents();
  // The role moved: its project's Main follows the orchestrator (core/chat-identity.ts).
  orchestratorMoved();

  // A model, an effort or another flag the CLI only reads when it starts is
  // applied by restarting it, at a moment that cuts nothing: see
  // core/agent-restart.ts. Saving it used to change the record and leave the
  // CLI running on the old value until somebody relaunched it by hand. The
  // orchestrator this one replaced goes back to work as a worker the same way.
  const changedAtLaunch = changedLaunchSettings(launchBefore, launchSettings(agent));
  const restart = changedAtLaunch.length > 0 ? restartForSettings(agent.id, changedAtLaunch) : undefined;
  for (const other of demoted) restartForSettings(other.id, ['orchestrator']);

  const changed = FIELDS.filter((field, i) => JSON.stringify(agent[field]) !== before[i]);
  return { success: true, agent, changed, changedAtLaunch, ...(restart ? { restart } : {}) };
}

/** Whether this update changes what an endpoint session was minted with: the endpoint, or its model or traces while on one. */
function endpointTerminalChanges(agent: AgentStatus, params: AgentUpdate): boolean {
  const after = params.endpointId === undefined ? agent.endpointId : params.endpointId ?? undefined;
  if (after !== agent.endpointId) return true;
  if (!after) return false;
  return (params.model !== undefined && (params.model ?? undefined) !== agent.model)
    || (params.traces !== undefined && params.traces !== (agent.traces === true));
}
