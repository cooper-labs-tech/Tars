import type { AgentEffort, AgentPermissionMode } from '@/types/agent';
import { lastPathPart } from '@/lib/display-path';
import type { TeamTemplateMember } from '@/types/electron';

/**
 * Everything about the new one-screen creation flow that is not JSX, so it can
 * be unit tested without rendering React: the collapsed Options row reads out
 * its own contents, and both the agent and the team screens have a "can this
 * be submitted yet" gate that used to be buried in a step's Next/Back wiring.
 */

export const EFFORT_LEVELS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The one-line summary on the collapsed Options row for a single agent:
 * "2 skills · medium effort · own worktree · auto". Segments that are at
 * their default or empty drop out rather than printing "0 skills" or
 * "no worktree" - the row is a summary of what was changed, not a form dump.
 */
export function agentOptionsSummary(opts: {
  skillsCount: number;
  effort: AgentEffort;
  useWorktree: boolean;
  permissionMode: AgentPermissionMode;
}): string {
  return [
    opts.skillsCount > 0 ? `${opts.skillsCount} skill${opts.skillsCount === 1 ? '' : 's'}` : null,
    `${opts.effort} effort`,
    opts.useWorktree ? 'own worktree' : null,
    opts.permissionMode,
  ].filter(Boolean).join(' · ');
}

/**
 * The worktree an agent's settings show: its own, from `worktreePath`. agent:list's
 * `branchName` is the branch its folder is on (services/agent-truth.ts), its project's
 * for an agent with no worktree, so it cannot say whether the agent has one.
 */
export function ownWorktreeOf(agent: { worktreePath?: string; branchName?: string }): { on: boolean; branchName: string; locked: boolean } {
  const own = !!agent.worktreePath;
  return { on: own, branchName: own ? agent.branchName ?? '' : '', locked: own };
}

/** What a save of an agent's settings sends for its worktree: one turned on for an agent with none, with a branch. */
export function worktreeToSave(state: { useWorktree: boolean; branchName: string }, agent: { worktreePath?: string }): { enabled: true; branchName: string } | undefined {
  const branchName = state.branchName.trim();
  return state.useWorktree && !agent.worktreePath && branchName ? { enabled: true, branchName } : undefined;
}

/** Project is required; a worktree with no branch name has nowhere to be created. */
export function canSubmitAgent(opts: { projectPath: string; useWorktree: boolean; branchName: string }): boolean {
  return !!opts.projectPath && (!opts.useWorktree || !!opts.branchName.trim());
}

/** How many of a team's members carry a branch, i.e. get their own worktree. */
export function worktreeCount(members: Pick<TeamTemplateMember, 'worktreeBranch'>[]): number {
  return members.filter(m => !!m.worktreeBranch?.trim()).length;
}

/** "5 of 6 selected · 5 worktrees" - the count line above the member table. */
export function teamSelectionSummary(opts: {
  totalMembers: number;
  selectedCount: number;
  worktrees: number;
}): string {
  return `${opts.selectedCount} of ${opts.totalMembers} selected · ${opts.worktrees} worktree${opts.worktrees === 1 ? '' : 's'}`;
}

/** A team needs a project and at least one member checked. */
export function canSubmitTeam(opts: { projectPath: string; selectedCount: number }): boolean {
  return !!opts.projectPath && opts.selectedCount > 0;
}

/** "Deploy 5 agents" / "Deploy 1 agent" / "Deploy a team" while nothing is picked yet. */
/** The name a team member is deployed under, and so the name its mark in the table is drawn from. */
export function deployedMemberName(memberName: string, projectPath: string): string {
  return `${memberName} - ${lastPathPart(projectPath) || 'project'}`;
}

export function deployButtonLabel(selectedCount: number): string {
  if (selectedCount <= 0) return 'Deploy a team';
  return `Deploy ${selectedCount} agent${selectedCount === 1 ? '' : 's'}`;
}
