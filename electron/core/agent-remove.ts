import { safeGitSync } from '../utils/safe-git';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStatus } from '../types';
import { agents, saveAgents } from './agent-manager';
import { ptyProcesses, endTerminalTree } from './pty-manager';
import { endWorkerRequests } from './task-requests';
import { forgetRestart } from './agent-restart';
import { stopAcpRuns } from '../services/acp/delegate';
import { dropPermissionAsks } from '../services/permission-asks';
import { ignoredNotCaches, saveUncommittedWork, submodulesWithWork } from '../services/save-worktree-work';
import { gitRefusal } from './chat-slots';

export interface RemovedAgent {
  success: true;
  /** The branch its uncommitted work was saved on. */
  savedTo?: string;
  /** Why its worktree was kept, when it was. */
  worktreeKept?: string;
}

/**
 * An agent deleted, with its worktree: what `agent:remove` does from the
 * window, and what deleting a chat does to the chat's runner
 * (services/chat-runners.ts). Moved here from the handler so both go the
 * same way.
 *
 * Its delegated runs and permission questions end with it; its terminal's
 * whole tree is ended, as a stop ends it; its uncommitted work is saved on wip/<name> first, without asking
 * (JeanBrasse, 05/10), since `--force` below removes whatever was not committed. A
 * save that fails keeps the worktree where it is, and says so, as do files git
 * ignores that are not caches, a repository of its own inside it, and a
 * submodule holding work no remote has (#312, #335), and so does a removal git
 * refuses (a locked worktree, the Audit's L1 on #398). What it was asked and
 * will never finish is told to each requester (the Audit's R3).
 *
 * Out of the fleet first, before anything is awaited (the Audit's L1 on #533): while its terminal's tree ends, a
 * start would have given it a new terminal, left with no agent. And a worktree another agent of the fleet works in
 * (the window lets two agents share one) is kept, with that agent's name, and nothing saved in this one's (M1):
 * removing it took the folder from under an agent still running there.
 */
export async function removeAgent(id: string): Promise<RemovedAgent> {
  const agent = agents.get(id);
  agents.delete(id);
  if (agent) await stopAcpRuns(agent.id, 'the agent was deleted');
  dropPermissionAsks(id);
  if (agent?.ptyId) {
    const ptyProcess = ptyProcesses.get(agent.ptyId);
    ptyProcesses.delete(agent.ptyId);
    // Nullify so pending onExit callbacks won't mutate state
    agent.ptyId = undefined;
    // Its whole tree, as a stop ends it (pty-manager.ts): the hangup alone left a CLI deaf to it, and its child,
    // running with no agent to name them (the Audit's L4 on #523).
    if (ptyProcess) await endTerminalTree(ptyProcess);
  }

  let savedTo: string | undefined;
  let worktreeKept: string | undefined;
  const sharer = agent?.worktreePath ? agentWorkingIn(agent.worktreePath) : undefined;
  if (sharer) {
    worktreeKept = `${sharer.name || sharer.id} works in it too, so its worktree was kept at ${agent!.worktreePath}`;
    console.warn(`[agent:remove] ${worktreeKept}`);
  }
  if (!worktreeKept && agent?.worktreePath && agent?.branchName && fs.existsSync(agent.worktreePath)) {
    try {
      const saved = await saveUncommittedWork(agent.worktreePath, agent.name || agent.id);
      savedTo = saved?.branch;
      if (savedTo) console.log(`[agent:remove] ${agent.name}'s uncommitted work saved on ${savedTo}`);
      // What git ignores, a .env or an e2e run, no commit keeps: the
      // worktree stays, rebuildable caches aside (the Audit's gate of #312).
      // And a git repository of its own, which the save could only point at.
      if (saved?.nestedRepos.length) {
        worktreeKept = `it holds git repositories of its own, which no commit of the worktree keeps (${saved.nestedRepos.slice(0, 5).join(', ')}), so its worktree was kept at ${agent.worktreePath}`;
        console.warn(`[agent:remove] ${worktreeKept}`);
      }
      // A submodule's commits and changes live in the worktree's own git
      // store, which the removal deletes, and no remote may have them.
      const submodules = worktreeKept ? [] : await submodulesWithWork(agent.worktreePath);
      if (submodules.length) {
        worktreeKept = `its submodules hold work no remote has (${submodules.slice(0, 5).join(', ')}), which removing the worktree would lose, so its worktree was kept at ${agent.worktreePath}`;
        console.warn(`[agent:remove] ${worktreeKept}`);
      }
      const ignored = worktreeKept ? [] : await ignoredNotCaches(agent.worktreePath);
      if (ignored.length) {
        const named = ignored.slice(0, 5).join(', ') + (ignored.length > 5 ? ` and ${ignored.length - 5} more` : '');
        worktreeKept = `it holds files git ignores, which no commit keeps (${named}), so its worktree was kept at ${agent.worktreePath}`;
        console.warn(`[agent:remove] ${worktreeKept}`);
      }
    } catch (err) {
      worktreeKept = `its uncommitted work could not be saved (${err instanceof Error ? err.message : String(err)}), so its worktree was kept at ${agent.worktreePath}`;
      console.warn(`[agent:remove] ${worktreeKept}`);
    }
  }

  // Clean up worktree if it exists
  if (agent?.worktreePath && agent?.branchName && !worktreeKept) {
    try {
      // argv, not a shell string: an apostrophe in the project path used to
      // make this fail silently and leak a stale worktree behind the deleted
      // agent. See the same fix in agent:create.
      console.log(`Removing worktree at ${agent.worktreePath}`);
      // In the C locale: gitRefusal reads git's "fatal:", which a translated git would not write.
      safeGitSync(agent.projectPath, ['worktree', 'remove', agent.worktreePath, '--force'], { env: { LC_ALL: 'C' } });
      console.log(`Worktree removed successfully`);
    } catch (err) {
      // The agent goes all the same; its folder, when there is one, stays, and the window says why. A worktree
      // already gone (removed outside Tars, or moved then pruned: "is not a working tree") keeps nothing.
      const reason = gitRefusal(String((err as { stderr?: unknown }).stderr ?? ''));
      if (fs.existsSync(agent.worktreePath)) worktreeKept = `git could not remove it (${reason}), so its worktree was kept at ${agent.worktreePath}`;
      console.warn(`[agent:remove] git worktree remove ${agent.worktreePath}: ${reason}`);
    }
  }

  // What it was asked and will never finish, each requester told (the Audit's R3).
  if (agent) endWorkerRequests(agent, 'deleted', { withLinked: true });
  forgetRestart(id);

  // Save agents to disk
  saveAgents();

  return { success: true, ...(savedTo ? { savedTo } : {}), ...(worktreeKept ? { worktreeKept } : {}) };
}

/** An agent of the fleet whose worktree is this folder, compared by real path (the removed one is out of it already). */
function agentWorkingIn(folder: string): AgentStatus | undefined {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const target = real(folder);
  for (const other of agents.values()) {
    if (other.worktreePath && real(other.worktreePath) === target) return other;
  }
  return undefined;
}
