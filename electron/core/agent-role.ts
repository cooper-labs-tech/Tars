import type { AgentRole, AgentStatus } from '../types';

/**
 * The Orchestrator toggle is the role.
 *
 * There used to be two switches. `role` made an agent its project's
 * orchestrator: the orchestration instructions, no editing tools, the global
 * room of the Chat, Telegram and Slack. Nothing in the interface set it: it
 * was read from the name ("orchestrator" or "super agent" in it), at creation,
 * at every rename and on load. The toggle, `orchestratorMode`, only took the
 * editing tools away, which every launch path already did for an
 * orchestrator. So the toggle changed nothing for the orchestrators, gave a
 * worker a restriction without the instructions that go with it, and renaming
 * "Tars-Orchestrator" to "Tars-Lead" would have demoted it without a word.
 * Audited on 2026-09-22; JeanBrasse decided the same evening that the toggle is the
 * role, the name decides nothing, and a project has one orchestrator.
 *
 * `orchestratorMode` stays on the record, always equal to the role, because
 * the renderer still reads it to draw the toggle and sends it back on every
 * save, until it reads `role`. A create or an update that names `role` is read
 * by it; one that only sends `orchestratorMode` is read as the toggle's old
 * name for the same thing.
 */

/** The version of agents.json from which the role is the toggle's. */
export const ROLE_IS_THE_TOGGLE_SINCE = 3;

/**
 * The orchestrator's powers: its instructions, its editing tools taken away,
 * writing to and asking the user, and a worker's message to it being a report.
 * Its project's orchestrator has them, and so does a chat's runner, a worker
 * that runs one chat's conversation with the orchestrator
 * (ORCHESTRATOR-PER-CHAT.md, 4.2). The powers and not the place: what only the
 * project's one orchestrator is (it never sleeps, the bots write to it, the
 * rule below keeps it unique) still reads the role, and a runner is stored as
 * a worker. Which site reads which: __tests__/electron/core/role-sites.test.ts.
 */
export function hasOrchestratorPowers(agent: { role?: string; kind?: string }): boolean {
  return agent.role === 'orchestrator' || agent.kind === 'chat';
}

/**
 * The role a create or an update asks for, if any. Throws on a role that is
 * neither, rather than leaving the agent as it was and saying it worked.
 */
export function requestedRole(params: { role?: unknown; orchestratorMode?: unknown }): AgentRole | undefined {
  if (params.role !== undefined && params.role !== null) {
    if (params.role === 'orchestrator' || params.role === 'worker') return params.role;
    throw new Error(`Invalid role: ${String(params.role)}`);
  }
  if (typeof params.orchestratorMode === 'boolean') {
    return params.orchestratorMode ? 'orchestrator' : 'worker';
  }
  return undefined;
}

function writeRole(agent: AgentStatus, role: AgentRole): void {
  agent.role = role;
  agent.orchestratorMode = role === 'orchestrator';
}

/**
 * Gives an agent its role. A project has one orchestrator: an agent that is
 * one now takes the role from any other orchestrator of its project, whoever
 * asked, and those are returned so the caller can restart them. Called with
 * the role the agent already has, it only restores that rule, which is what an
 * agent moved into another project needs.
 */
export function assignRole(agent: AgentStatus, role: AgentRole, fleet: Iterable<AgentStatus>): AgentStatus[] {
  writeRole(agent, role);
  if (role !== 'orchestrator') return [];
  const demoted: AgentStatus[] = [];
  for (const other of fleet) {
    if (other.id === agent.id || other.role !== 'orchestrator' || other.projectPath !== agent.projectPath) continue;
    writeRole(other, 'worker');
    demoted.push(other);
  }
  return demoted;
}

/**
 * The role a name gave until the toggle did. Read only to migrate what was
 * written before (agents.json before version 3, a team template member
 * without a role), never to decide anything new.
 */
export function roleFromName(name: string | undefined): AgentRole {
  const lower = name?.toLowerCase() ?? '';
  return lower.includes('super agent') || lower.includes('orchestrator') ? 'orchestrator' : 'worker';
}

/**
 * What made an agent an orchestrator before the toggle did: the role stored
 * from its name, or its name itself on a record older than the role field.
 * And the toggle, switched on, which from now on is the role.
 */
function roleBeforeTheToggle(agent: AgentStatus): AgentRole {
  if (agent.orchestratorMode === true) return 'orchestrator';
  if (agent.role === 'orchestrator' || agent.role === 'worker') return agent.role;
  return roleFromName(agent.name);
}

/**
 * The roles of the agents read from agents.json. A file written before the
 * toggle was the role is migrated once: role = toggle on, or the role the
 * name gave, so no orchestrator of that day changes. After that the stored
 * role is the whole truth and the name is never read.
 *
 * Then one orchestrator per project, whatever the file says: the first one in
 * it keeps the role, as the first was the one Tars already turned to
 * (getSuperAgent). Returns the agents that lost it.
 */
export function rolesOnLoad(list: AgentStatus[], fileVersion: number): AgentStatus[] {
  for (const agent of list) {
    writeRole(agent, fileVersion < ROLE_IS_THE_TOGGLE_SINCE
      ? roleBeforeTheToggle(agent)
      : agent.role === 'orchestrator' ? 'orchestrator' : 'worker');
  }
  const demoted: AgentStatus[] = [];
  const hasOne = new Set<string>();
  for (const agent of list) {
    if (agent.role !== 'orchestrator') continue;
    if (hasOne.has(agent.projectPath)) {
      writeRole(agent, 'worker');
      demoted.push(agent);
    } else {
      hasOne.add(agent.projectPath);
    }
  }
  return demoted;
}
