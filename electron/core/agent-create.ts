import type { AgentCharacter, AgentEffort, AgentPermissionMode, AgentProvider, AgentRole, AgentStatus, WorktreeConfig } from '../types';

/**
 * The one way an agent is created: its record and its terminal. The window's `agent:create` handler registers its
 * creation here and calls it, and so does the load window when it makes its load agents (services/load-agents.ts), so
 * neither makes an agent another way (the spawn rule: no third way in). The same pattern as core/agent-launch.ts.
 */
export interface AgentCreateConfig {
  projectPath: string;
  skills: string[];
  worktree?: WorktreeConfig;
  character?: AgentCharacter;
  name?: string;
  secondaryProjectPath?: string;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  provider?: AgentProvider;
  model?: string;
  localModel?: string;
  obsidianVaultPaths?: string[];
  /** The Orchestrator toggle. See core/agent-role.ts. */
  role?: AgentRole;
  /** The toggle's old name, read when `role` is absent. */
  orchestratorMode?: boolean;
  cliPath?: string;
  /** The inference endpoint its harness runs on (services/inference-endpoints.ts), with `model` one of its models. */
  endpointId?: string;
  /** Its own trace switch, off by default (services/trace-gate.ts). */
  traces?: boolean;
  /** A load agent of a project (trace feature C3): made by the load window only, never by the window's form. */
  load?: boolean;
}

export type AgentCreator = (config: AgentCreateConfig) => Promise<AgentStatus & { ptyId: string }>;

let creator: AgentCreator | null = null;

/** Called once, by the handler that owns the creation. */
export function registerAgentCreator(fn: AgentCreator): void {
  creator = fn;
}

/** Creates an agent through the registered creation, or throws when Tars has not registered it yet. */
export function createAgent(config: AgentCreateConfig): Promise<AgentStatus & { ptyId: string }> {
  if (!creator) return Promise.reject(new Error('Tars cannot create an agent yet: its handlers are not registered'));
  return creator(config);
}
