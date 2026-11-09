import { agents } from '../../core/agent-manager';
import { listWorktrees, newWorktree, pruneWorktrees, removeWorktree, type WorktreeRefusal } from '../project-worktrees';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * A worktree per task, for any project (2.0.7, W6 of the fresh-install report): the routes of mcp-orchestrator's
 * worktree_new, worktree_list, worktree_remove and worktree_prune (services/project-worktrees.ts).
 *
 * The project is always the calling agent's own, from its token: never one a body names. An agent of the project
 * that runs in a worktree (its worktreePath) keeps it, on a remove and on a prune.
 */

function callerAgent(req: RouteRequest, sendJson: SendJson) {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'A worktree is made for an agent\'s project: it takes an agent\'s own token (CLAUDE_MGR_API_TOKEN, in its terminal\'s environment).' }, 403);
    return undefined;
  }
  return agent;
}

/** The worktrees agents of the project run in: never removed here. */
function agentWorktrees(projectPath: string): string[] {
  return Array.from(agents.values()).filter(a => a.projectPath === projectPath && a.worktreePath).map(a => a.worktreePath!);
}

const STATUS: Record<WorktreeRefusal['code'], number> = {
  invalid_branch: 400, not_a_repository: 400, disk_full: 507, too_many: 409, git_refused: 409, dirty: 409, in_use: 409, not_found: 404,
};

export function registerWorktreeRoutes(app: RouteApp): void {
  app.get('/api/worktrees', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    sendJson({ project: agent.projectPath, worktrees: await listWorktrees(agent.projectPath) });
  });

  app.post('/api/worktrees', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const { branch } = req.body as { branch?: unknown };
    if (typeof branch !== 'string' || !branch.trim()) {
      sendJson({ error: 'branch is the new worktree\'s branch, as feat/<what>.', code: 'invalid_branch' }, 400);
      return;
    }
    const made = await newWorktree(agent.projectPath, branch.trim(), { protectedPaths: agentWorktrees(agent.projectPath) });
    if ('code' in made) sendJson(made, STATUS[made.code]);
    else sendJson({ success: true, ...made });
  });

  app.post('/api/worktrees/remove', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const { branch } = req.body as { branch?: unknown };
    if (typeof branch !== 'string' || !branch.trim()) {
      sendJson({ error: 'branch names the worktree to remove.', code: 'invalid_branch' }, 400);
      return;
    }
    const removed = await removeWorktree(agent.projectPath, branch.trim(), { protectedPaths: agentWorktrees(agent.projectPath) });
    if ('code' in removed) sendJson(removed, STATUS[removed.code]);
    else sendJson({ success: true, ...removed });
  });

  app.post('/api/worktrees/prune', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const { dryRun } = req.body as { dryRun?: unknown };
    sendJson({ success: true, ...(await pruneWorktrees(agent.projectPath, { protectedPaths: agentWorktrees(agent.projectPath), dryRun: dryRun === true })) });
  });
}
