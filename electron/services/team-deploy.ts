import * as path from 'path';
import type { AgentCharacter, AgentEffort, AgentPermissionMode, AgentProvider, AgentRole } from '../types';
import type { TeamTemplateMember } from '../types/team-template';
import { isValidBranchName, resolveWorktreePath } from '../utils/worktree-path';

/**
 * A team deployed in one call, every member made or none (the window's teams:deploy, 2.0.7). From QA's fresh-install
 * report (fresh-install-turnkey.md, B3 and B4) and Tars-Frontend's request (first-run-window.md): New team made its
 * members one by one from the window, so a plain folder left the orchestrator alone and failed the rest with git's
 * raw words, and the orchestrator was started before its team existed, the roster its session reads empty.
 *
 * Everything that can be known before is checked before anything is made: the folder is a project, the members can
 * be told apart and their branches are ones git takes inside .worktrees, a folder holds a first commit when a member
 * asks for a worktree, Claude Code is there and signed in on the accounts the Claude members will start on. Then
 * every member is made, the
 * orchestrator last; one that cannot be made takes back every member this deploy made (and the branches it created).
 * Each member's role is its own saved prompt; the brief is the orchestrator's first task (each member's when the team
 * has no orchestrator), typed once at its next start and never kept as a role (core/first-task.ts; the orchestrator's
 * task of 10/11). Started on deploy, each starts with no task of its own, the orchestrator after its whole team, so
 * the roster it reads at its start holds every member and the brief is its first prompt; the others wait at their
 * prompt for its delegations. A start that fails leaves the team made, and says who did not start.
 */

export interface TeamDeployParams {
  projectPath: string;
  /** As New team edited them: a member with no worktreeBranch works in the project's own checkout. */
  members: TeamTemplateMember[];
  /** The team's brief: the orchestrator's first task, and every member's, before its own saved prompt. */
  brief?: string;
  startOnDeploy: boolean;
  /** The window told the user Claude Code is signed out, and they deploy all the same. */
  signedOutOk?: boolean;
}

export interface MemberProblem { member: string; reason: string }

export type TeamDeployCode = 'not-a-project' | 'invalid' | 'not-a-repository' | 'signed-out' | 'cli-missing' | 'busy' | 'failed';

export type TeamDeployResult =
  | { success: true; agentIds: string[]; skipped: MemberProblem[]; notStarted: MemberProblem[] }
  /** `left`: what taking the made members back could not undo (a worktree kept, a branch git would not delete). */
  | { success: false; error: string; code: TeamDeployCode; failed: MemberProblem[]; left: string[] };

/** What agent:create takes, for one member. */
export interface MemberAgentConfig {
  projectPath: string;
  name: string;
  skills: string[];
  character: AgentCharacter;
  permissionMode: AgentPermissionMode;
  effort?: AgentEffort;
  provider: AgentProvider;
  model?: string;
  localModel?: string;
  role?: AgentRole;
  worktree?: { enabled: true; branchName: string };
}

/**
 * Claude Code's sign-in for the accounts the team's Claude members will start on (claude-accounts/launch.ts
 * newAgentSignIn), and, with several accounts on, the names of those that are signed out.
 */
export interface ClaudeSignIn { state: 'signed-in' | 'signed-out' | 'cli-missing' | 'unknown'; signedOut: string[] }

/** The main process's pieces, injected so the rules above are tested on their own (team-deploy.test.ts). */
export interface TeamDeployDeps {
  isProject(projectPath: string): boolean;
  /** The names of the agents already on that project. */
  takenNames(projectPath: string): Set<string>;
  /** Whether the folder is a git repository with a first commit, which a worktree needs. */
  hasCommit(projectPath: string): Promise<boolean>;
  branchExists(projectPath: string, branch: string): Promise<boolean>;
  /** Whether the member's worktree (<project>/.worktrees/<branch>) is there. */
  worktreeExists(projectPath: string, branch: string): boolean;
  /** A worktree this deploy made for a member that then failed, taken away again. */
  removeWorktree(projectPath: string, branch: string): Promise<void>;
  deleteBranch(projectPath: string, branch: string): Promise<void>;
  claudeSignIn(): Promise<ClaudeSignIn>;
  create(config: MemberAgentConfig): Promise<{ id: string }>;
  remove(id: string): Promise<{ worktreeKept?: string }>;
  start(id: string, prompt: string, options: { model?: string; provider?: AgentProvider; localModel?: string }): Promise<unknown>;
  /** The member's role, its saved prompt: what every start of it reads ("## Your role"). */
  saveRole(id: string, role: string): void;
  /** A task kept for the agent's next fresh start, typed once (core/first-task.ts). */
  setFirstTask(id: string, task: string): void;
}

/** A member's agent name on its project, as New team named them: "Frontend - my-app". */
export function deployedName(memberName: string, projectPath: string): string {
  return `${memberName.trim()} - ${path.basename(path.resolve(projectPath)) || 'project'}`;
}

const isClaude = (m: TeamTemplateMember) => !m.provider || m.provider === 'claude';
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Projects with a deploy running: a second one on the same project would make the team twice. */
const deploying = new Set<string>();

export async function deployTeam(params: TeamDeployParams, deps: TeamDeployDeps): Promise<TeamDeployResult> {
  const refuse = (code: TeamDeployCode, error: string, failed: MemberProblem[] = []): TeamDeployResult => ({ success: false, code, error, failed, left: [] });
  const projectPath = typeof params?.projectPath === 'string' ? params.projectPath : '';
  if (!projectPath || !deps.isProject(projectPath)) return refuse('not-a-project', `${projectPath || 'That folder'} is not one of Tars's projects: add it first`);
  const members = Array.isArray(params.members) ? params.members : [];
  if (!members.length) return refuse('invalid', 'The team has no member');

  // Members the deploy can tell apart, branches git takes inside .worktrees, one orchestrator at most.
  const invalid: MemberProblem[] = [];
  const names = new Set<string>();
  const branches = new Set<string>();
  for (const m of members) {
    const label = typeof m?.name === 'string' ? m.name : '';
    if (!label.trim()) { invalid.push({ member: label, reason: 'a member has no name' }); continue; }
    const name = deployedName(label, projectPath);
    if (names.has(name)) invalid.push({ member: label, reason: 'two members have this name' });
    names.add(name);
    if (m.worktreeBranch) {
      if (!isValidBranchName(m.worktreeBranch) || !resolveWorktreePath(projectPath, m.worktreeBranch)) {
        invalid.push({ member: label, reason: `"${m.worktreeBranch}" is not a branch name a worktree can take` });
      } else if (branches.has(m.worktreeBranch)) {
        invalid.push({ member: label, reason: `two members work on the branch ${m.worktreeBranch}` });
      }
      branches.add(m.worktreeBranch);
    }
  }
  if (members.filter(m => m?.role === 'orchestrator').length > 1) invalid.push({ member: '', reason: 'a team has one orchestrator at most' });
  if (invalid.length) return refuse('invalid', `Nothing was made: ${invalid.map(i => (i.member ? `${i.member}: ${i.reason}` : i.reason)).join('; ')}`, invalid);

  const key = path.resolve(projectPath);
  if (deploying.has(key)) return refuse('busy', 'A team is being deployed on this project already: wait for it');
  deploying.add(key);
  try {
    // Already on the project: skipped, not made twice.
    const taken = deps.takenNames(projectPath);
    const skipped: MemberProblem[] = [];
    const toMake = members.filter(m => {
      if (!taken.has(deployedName(m.name, projectPath))) return true;
      skipped.push({ member: m.name, reason: 'already deployed on this project' });
      return false;
    });
    if (!toMake.length) return { success: true, agentIds: [], skipped, notStarted: [] };

    // Claude Code there, and signed in on the accounts the Claude members will start on (QA's B3: six terminals asking
    // for a login after the deploy; the Audit's I1: one account signed in among several was taken as enough).
    const claudeMembers = toMake.filter(isClaude);
    if (claudeMembers.length) {
      const signIn = await deps.claudeSignIn();
      if (signIn.state === 'cli-missing') {
        return refuse('cli-missing', 'Claude Code is not installed, or not where Tars looks for it: install it first (Settings, CLI paths)',
          claudeMembers.map(m => ({ member: m.name, reason: 'Claude Code is not installed' })));
      }
      if (signIn.state === 'signed-out' && !params.signedOutOk) {
        const out = signIn.signedOut;
        const on = out.length ? ` on ${out.length > 1 ? `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]}` : out[0]}` : '';
        const reason = `Claude Code is signed out${on}${out.length > 1 ? ', the accounts it may start on' : out.length ? ', the account it would start on' : ''}`;
        return refuse('signed-out', `Claude Code is signed out${on}: sign in first, or deploy anyway and sign in from a member's terminal`,
          claudeMembers.map(m => ({ member: m.name, reason })));
      }
    }

    // A worktree needs a repository with a first commit (QA's B4: five members failed with git's words).
    const withWorktree = toMake.filter(m => m.worktreeBranch);
    if (withWorktree.length && !(await deps.hasCommit(projectPath))) {
      return refuse('not-a-repository', 'This folder is not a git repository with a first commit: make it one, or deploy without worktrees',
        withWorktree.map(m => ({ member: m.name, reason: 'its worktree needs a git repository with a first commit' })));
    }
    const newBranches = new Set<string>();
    for (const m of withWorktree) if (!(await deps.branchExists(projectPath, m.worktreeBranch!))) newBranches.add(m.worktreeBranch!);
    // A worktree there before the deploy is never taken away, whatever fails.
    const hadWorktree = new Set(withWorktree.map(m => m.worktreeBranch!).filter(b => deps.worktreeExists(projectPath, b)));

    // Every member made, the orchestrator last; one that fails takes the others back.
    const order = [...toMake.filter(m => m.role !== 'orchestrator'), ...toMake.filter(m => m.role === 'orchestrator')];
    const made: Array<{ member: TeamTemplateMember; id: string }> = [];
    for (const m of order) {
      try {
        const { id } = await deps.create({
          projectPath, name: deployedName(m.name, projectPath), skills: m.skills ?? [], character: m.character,
          permissionMode: m.permissionMode, effort: m.effort, provider: m.provider, model: m.model, localModel: m.localModel,
          role: m.role, ...(m.worktreeBranch ? { worktree: { enabled: true, branchName: m.worktreeBranch } } : {}),
        });
        made.push({ member: m, id });
      } catch (err) {
        const reason = reasonOf(err);
        const left: string[] = [];
        for (const { member, id } of made) {
          const removed = await deps.remove(id).catch(e => ({ worktreeKept: `it could not be removed (${reasonOf(e)})` }));
          if (removed.worktreeKept) { left.push(`${deployedName(member.name, projectPath)}: ${removed.worktreeKept}`); continue; }
          if (member.worktreeBranch && newBranches.has(member.worktreeBranch)) {
            await deps.deleteBranch(projectPath, member.worktreeBranch).catch(e => { left.push(`the branch ${member.worktreeBranch}: ${reasonOf(e)}`); });
          }
        }
        // The member that failed may have made its worktree first (the API not listening, no terminal left: the
        // Audit's L1 on #584): taken back too, and its new branch.
        const own = m.worktreeBranch;
        if (own && !hadWorktree.has(own) && deps.worktreeExists(projectPath, own)) {
          try {
            await deps.removeWorktree(projectPath, own);
            if (newBranches.has(own)) await deps.deleteBranch(projectPath, own).catch(e => { left.push(`the branch ${own}: ${reasonOf(e)}`); });
          } catch (e) {
            left.push(`the worktree of ${m.name}: ${reasonOf(e)}`);
          }
        }
        console.warn(`[team-deploy] ${projectPath}: ${m.name} could not be made (${reason}); ${made.length} member(s) taken back${left.length ? `, left: ${left.join('; ')}` : ''}`);
        return {
          success: false, code: 'failed', failed: [{ member: m.name, reason }], left,
          error: `${m.name} could not be made: ${reason}. Nothing of this team was kept${left.length ? ', but for what is listed' : ''}.`,
        };
      }
    }

    // Each role its own; the brief the orchestrator's first task (each member's with no orchestrator), never a role.
    for (const { member, id } of made) if (member.savedPrompt?.trim()) deps.saveRole(id, member.savedPrompt.trim());
    const brief = params.brief?.trim();
    if (brief) {
      const lead = made.find(x => x.member.role === 'orchestrator');
      const leadless = !members.some(m => m.role === 'orchestrator');
      for (const { id } of lead ? [lead] : leadless ? made : []) deps.setFirstTask(id, brief);
    }
    // Started in the same order, the orchestrator after its whole team: the launch types its first task.
    const notStarted: MemberProblem[] = [];
    for (const [i, { member, id }] of made.entries()) {
      if (!params.startOnDeploy) continue;
      // The order Tars launches them in, which is what it holds to: each CLI then starts when its shell is ready.
      console.log(`[team-deploy] ${projectPath}: starting ${deployedName(member.name, projectPath)}, ${i + 1} of ${made.length}`);
      try {
        const started = await deps.start(id, '', { model: member.model, provider: member.provider, localModel: member.localModel });
        const answer = started as { success?: unknown; error?: unknown } | undefined;
        if (answer && answer.success === false) notStarted.push({ member: member.name, reason: String(answer.error ?? 'it did not start') });
      } catch (err) {
        notStarted.push({ member: member.name, reason: reasonOf(err) });
      }
    }
    console.log(`[team-deploy] ${projectPath}: ${made.length} member(s) made${skipped.length ? `, ${skipped.length} skipped` : ''}${notStarted.length ? `, ${notStarted.length} not started` : ''}`);
    return { success: true, agentIds: made.map(x => x.id), skipped, notStarted };
  } finally {
    deploying.delete(key);
  }
}
