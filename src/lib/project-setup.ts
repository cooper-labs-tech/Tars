import type { ElectronAPI } from '@/types/electron';
import type { StatusTone } from '@/components/ui';

/**
 * What the window says of a project's setup offers (2.0.7; PR 586's electronAPI.projectSetup; frame `First run
 * (2.0.7) · states`). Main decides what applies and words its reasons and refusals; these give each answer its line.
 */

type Setup = NonNullable<ElectronAPI['projectSetup']>;
type Offer = Extract<Awaited<ReturnType<Setup['offer']>>, { success: true }>;
type CiAnswer = Awaited<ReturnType<Setup['writeCi']>>;
type ClaudeMdAnswer = Awaited<ReturnType<Setup['writeClaudeMd']>>;
type PermissionAnswer = Awaited<ReturnType<Setup['setTeamPermissionMode']>>;

export type SetupLine = { tone: StatusTone; text: string };
export type OfferLine = SetupLine & { offer: boolean };

/** A path inside the project, said from its root. */
function inProject(file: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, '');
  return file.startsWith(root + '/') || file.startsWith(root + '\\') ? file.slice(root.length + 1) : file;
}

/** The CI offer: its checks and the branch its pull requests go into; what the project has; or main's reason. */
export function ciLine(ci: Offer['ci'], projectPath: string): OfferLine {
  if (ci.state === 'offer') {
    const branch = /pull_request:\s*\n\s*branches:\s*\[([^\]]+)\]/.exec(ci.content)?.[1]?.trim();
    return { tone: 'waiting', text: `A CI workflow for GitHub: ${ci.checks.join(', ')} on each pull request${branch ? ` into ${branch}` : ''}.`, offer: true };
  }
  if (ci.state === 'present') return { tone: 'running', text: `Has a CI workflow: ${inProject(ci.path, projectPath)}`, offer: false };
  return { tone: 'idle', text: ci.why, offer: false };
}

/**
 * What the CI's yes did: where it is committed, that nothing was pushed, and what the user does next (nothing hands
 * the orchestrator the task by itself); `note`, the worktrees of merged work main pruned first. Or main's refusal.
 */
export function ciDoneLine(a: CiAnswer, projectPath: string): SetupLine & { note?: string } {
  if (!a.success) return { tone: 'error', text: a.error };
  return {
    tone: 'running',
    text: `Committed ${inProject(a.file, a.worktree)} on ${a.branch}, in ${inProject(a.worktree, projectPath)}, not pushed. Ask your orchestrator to deliver it as a pull request.`,
    ...(a.pruned.length ? { note: `Before it, removed the worktrees of work already merged: ${a.pruned.join(', ')}.` } : {}),
  };
}

export function claudeMdLine(c: Offer['claudeMd']): OfferLine {
  return c.state === 'offer'
    ? { tone: 'waiting', text: 'A short CLAUDE.md: the checks, each agent\'s area, and how a change is delivered.', offer: true }
    : { tone: 'running', text: 'Has its CLAUDE.md.', offer: false };
}

export function claudeMdDoneLine(a: ClaudeMdAnswer): SetupLine {
  return a.success ? { tone: 'running', text: 'Wrote CLAUDE.md.' } : { tone: 'error', text: a.error };
}

/** The agents main sets to one level: the project's own, never a chat's runner (services/project-setup.ts teamOf). */
export function teamOf<A extends { projectPath: string; kind?: string }>(fleet: readonly A[], projectPath: string): A[] {
  return fleet.filter(a => a.projectPath === projectPath && a.kind !== 'chat');
}

/** How many took the level, and who did not and why; or main's refusal before any agent. */
export function permissionOutcome(a: PermissionAnswer, mode: string): SetupLine[] {
  if (!a.agents) return [{ tone: 'error', text: a.error ?? 'The level could not be set.' }];
  const took = a.agents.filter(x => x.success).length;
  return [
    { tone: took === a.agents.length ? 'running' : 'waiting', text: `Set to ${mode}: ${took} of ${a.agents.length} agent${a.agents.length === 1 ? '' : 's'}.` },
    ...a.agents.filter(x => !x.success).map(x => ({ tone: 'error' as const, text: `${x.name || x.id}: ${(x.error ?? 'not set').replace(/\.$/, '')}.` })),
  ];
}
