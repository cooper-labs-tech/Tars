import { agents } from '../../core/agent-manager';
import * as path from 'path';
import { listWorktrees, newWorktree, pruneWorktrees, removeWorktree, turnPushOff, type WorktreeRefusal } from '../project-worktrees';
import { grantFor } from '../cross-project-grants';
import type { AgentStatus } from '../../types';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report): the routes of mcp-orchestrator's
 * worktree_new, worktree_list, worktree_remove and worktree_prune (services/project-worktrees.ts).
 *
 * The project is the calling agent's own, from its token, or (2.0.7) another project the owner's allowlist opens to
 * it (`project`, services/cross-project-grants.ts): a fleet worktree, made under that project's .worktrees/ for one
 * of its agents to be moved onto (update_agent with worktree), its push turned off on request (`noPush`). Never a
 * folder a body names: the worktree's path is the project's .worktrees/<branch> (utils/worktree-path.ts). Nothing here
 * checks out, moves or resets the project's main checkout. An agent that runs in a worktree (its worktreePath) keeps
 * it, on a remove and on a prune.
 */

function callerAgent(req: RouteRequest, sendJson: SendJson) {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'A worktree is made for an agent\'s project: it takes an agent\'s own token (CLAUDE_MGR_API_TOKEN, in its terminal\'s environment).' }, 403);
    return undefined;
  }
  return agent;
}

/**
 * The folders agents work in: each one's own worktree, and the folder its terminal was started in (a task worktree
 * no worktreePath names, the Audit's L2 on #585). Every agent's, whatever its project: never removed here.
 */
function agentWorktrees(): string[] {
  return Array.from(agents.values()).flatMap(a => [a.worktreePath, a.ptyCwd]).filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * The project a call acts in: the caller's own, or the one it names that the owner's grant opens to it. Undefined,
 * answered, otherwise.
 */
function projectOf(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): string | undefined {
  const asked = (req.method === 'GET' ? req.url.searchParams.get('project') : (req.body as { project?: unknown } | undefined)?.project) ?? undefined;
  if (asked === undefined || asked === null || asked === '') return agent.projectPath;
  if (typeof asked !== 'string' || !path.isAbsolute(asked)) {
    sendJson({ error: 'project is an absolute project path.', code: 'invalid_project' }, 400);
    return undefined;
  }
  if (path.resolve(asked) === path.resolve(agent.projectPath)) return agent.projectPath;
  if (grantFor(agent, asked)) return path.resolve(asked);
  sendJson({
    error: `Worktrees of ${asked} are made by its own agents, or by an agent the owner's grant from your project to that one opens it to (Settings, the allowlist across projects).`,
    code: 'cross_project_not_granted',
  }, 403);
  return undefined;
}

const STATUS: Record<WorktreeRefusal['code'], number> = {
  invalid_branch: 400, not_a_repository: 400, disk_full: 507, too_many: 409, git_refused: 409, dirty: 409, in_use: 409, not_found: 404, unknown_branch: 404,
};

export function registerWorktreeRoutes(app: RouteApp): void {
  app.get('/api/worktrees', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const project = projectOf(req, agent, sendJson);
    if (!project) return;
    sendJson({ project, worktrees: await listWorktrees(project) });
  });

  app.post('/api/worktrees', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const project = projectOf(req, agent, sendJson);
    if (!project) return;
    const { branch, existing, noPush } = req.body as { branch?: unknown; existing?: unknown; noPush?: unknown };
    if (typeof branch !== 'string' || !branch.trim()) {
      sendJson({ error: 'branch is the new worktree\'s branch, as feat/<what>.', code: 'invalid_branch' }, 400);
      return;
    }
    if (noPush !== undefined && typeof noPush !== 'boolean') {
      sendJson({ error: 'noPush is true or false.', code: 'invalid_no_push' }, 400);
      return;
    }
    // existing: a PR's branch, never made new from the default branch when it cannot be found (the Audit's L6 on #585).
    const made = await newWorktree(project, branch.trim(), { protectedPaths: agentWorktrees(), existing: existing === true });
    if ('code' in made) {
      sendJson(made, STATUS[made.code]);
      return;
    }
    if (noPush === true) {
      try {
        await turnPushOff(made.path);
      } catch (err) {
        sendJson({ success: true, ...made, project, pushOff: false, note: `Made, but its push could not be turned off: ${(err as Error).message}. Remove it with worktree_remove if it must not push.` });
        return;
      }
    }
    sendJson({ success: true, ...made, project, ...(noPush === true ? { pushOff: true } : {}) });
  });

  app.post('/api/worktrees/remove', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const project = projectOf(req, agent, sendJson);
    if (!project) return;
    const { branch } = req.body as { branch?: unknown };
    if (typeof branch !== 'string' || !branch.trim()) {
      sendJson({ error: 'branch names the worktree to remove.', code: 'invalid_branch' }, 400);
      return;
    }
    const removed = await removeWorktree(project, branch.trim(), { protectedPaths: agentWorktrees() });
    if ('code' in removed) sendJson(removed, STATUS[removed.code]);
    else sendJson({ success: true, ...removed });
  });

  app.post('/api/worktrees/prune', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const project = projectOf(req, agent, sendJson);
    if (!project) return;
    const { dryRun } = req.body as { dryRun?: unknown };
    sendJson({ success: true, ...(await pruneWorktrees(project, { protectedPaths: agentWorktrees(), dryRun: dryRun === true })) });
  });
}
