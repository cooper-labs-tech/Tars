import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorktreePath } from '../utils/worktree-path';
import type { AppSettings } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { removeAgent } from '../core/agent-remove';
import { launchAgent } from '../core/agent-launch';
import { setFirstTask } from '../core/first-task';
import { safeGit } from '../utils/safe-git';
import { deployTeam, type ClaudeSignIn, type MemberAgentConfig, type TeamDeployParams } from '../services/team-deploy';
import { gitInit, projectReadiness } from '../services/project-git';
import { DEFAULT_ACCOUNT_ID, readAccountsSettings } from '../services/claude-accounts/registry';
import { setAuth } from '../services/claude-accounts/state';
import { ClaudeCliMissing, claudeAuthStatus } from '../services/claude-accounts/auth';
import { newAgentSignIn, type SignInAnswer } from '../services/claude-accounts/launch';

/**
 * The first run's channels (2.0.7), from QA's fresh-install report (B3, B4, W4) and Tars-Frontend's request
 * (first-run-window.md): a project's git made (project:git-init), what PR delivery still lacks (project:readiness),
 * and a team deployed whole or not at all, its orchestrator started last (teams:deploy). Only the window reaches
 * them: no API route does.
 */

export const FIRST_RUN_CHANNELS = ['project:git-init', 'project:readiness', 'teams:deploy'] as const;

export interface FirstRunDeps {
  /** agent:create's own creation (ipc-handlers.ts): a member is made exactly as an agent from the window is. */
  createAgent: (config: MemberAgentConfig) => Promise<{ id: string }>;
  /** projects.json, and every agent's project. */
  projectPaths: () => string[];
  getAppSettings: () => AppSettings;
}

/**
 * Claude Code's sign-in for the accounts a team's Claude members will start on (the Audit's I1 on #584: any one
 * account signed in was taken as enough). Every account a launch can give them is asked now (account 1 always, and
 * each enabled account with several on), the answers recorded as the launch reads them, then the accounts a new
 * agent may start on are the ones that count (claude-accounts/launch.ts newAgentSignIn).
 */
async function claudeSignIn(getAppSettings: () => AppSettings): Promise<ClaudeSignIn> {
  const settings = readAccountsSettings();
  const asked = settings.accounts.filter(a => a.id === DEFAULT_ACCOUNT_ID || (settings.enabled && a.enabled));
  const accounts = asked.some(a => a.id === DEFAULT_ACCOUNT_ID) ? asked : [{ id: DEFAULT_ACCOUNT_ID, configDir: null }, ...asked];
  const binary = getAppSettings().cliPaths?.claude || 'claude';
  const answers: Record<string, SignInAnswer> = {};
  await Promise.all(accounts.map(async a => {
    try {
      const info = await claudeAuthStatus(binary, a.configDir ?? null);
      setAuth(a.id, { signedIn: info.signedIn, email: info.email, subscriptionType: info.subscriptionType, error: null, code: null });
      answers[a.id] = info.signedIn ? 'signed-in' : 'signed-out';
    } catch (err) {
      answers[a.id] = err instanceof ClaudeCliMissing ? 'cli-missing' : 'unknown';
    }
  }));
  return newAgentSignIn(settings, answers);
}

const gitOk = (cwd: string, args: string[]) => safeGit(cwd, args, { env: { LC_ALL: 'C' } }).then(() => true, () => false);

export function registerFirstRunHandlers(deps: FirstRunDeps): void {
  const isProject = (p: string) => {
    const wanted = path.resolve(p);
    return deps.projectPaths().some(known => typeof known === 'string' && known && path.resolve(known) === wanted);
  };

  ipcMain.handle('project:git-init', async (_event, projectPath: unknown) =>
    gitInit(typeof projectPath === 'string' ? projectPath : '', { isProject }));

  ipcMain.handle('project:readiness', async (_event, projectPath: unknown) =>
    projectReadiness(typeof projectPath === 'string' ? projectPath : '', { isProject }));

  ipcMain.handle('teams:deploy', async (_event, params: TeamDeployParams) => deployTeam(params, {
    isProject,
    takenNames: projectPath => new Set([...agents.values()]
      .filter(a => a.projectPath && path.resolve(a.projectPath) === path.resolve(projectPath))
      .map(a => a.name ?? '')),
    hasCommit: projectPath => gitOk(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    branchExists: (projectPath, branch) => gitOk(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]),
    worktreeExists: (projectPath, branch) => {
      const where = resolveWorktreePath(projectPath, branch);
      return !!where && fs.existsSync(where);
    },
    // Made by this deploy moments ago for a member that then failed, never used: --force takes the dependencies
    // cloned into it (ignored files) with it, as agent-remove.ts does for a member it removes.
    removeWorktree: async (projectPath, branch) => {
      const where = resolveWorktreePath(projectPath, branch);
      if (!where) return;
      try {
        await safeGit(projectPath, ['worktree', 'remove', where, '--force'], { env: { LC_ALL: 'C' } });
      } catch (err) {
        throw new Error(String((err as { stderr?: unknown }).stderr ?? (err as Error).message).trim().replace(/^(fatal|error): /, ''));
      }
    },
    deleteBranch: async (projectPath, branch) => {
      try {
        await safeGit(projectPath, ['branch', '-D', branch], { env: { LC_ALL: 'C' } });
      } catch (err) {
        throw new Error(String((err as { stderr?: unknown }).stderr ?? (err as Error).message).trim().replace(/^error: /, ''));
      }
    },
    claudeSignIn: () => claudeSignIn(deps.getAppSettings),
    create: config => deps.createAgent(config),
    remove: id => removeAgent(id),
    start: (id, prompt, options) => launchAgent(id, prompt, options),
    saveRole: (id, role) => {
      const agent = agents.get(id);
      if (!agent) return;
      agent.savedPrompt = role;
      saveAgents();
    },
    setFirstTask: (id, task) => {
      if (setFirstTask(agents.get(id), task).success) saveAgents();
    },
  }));
}
