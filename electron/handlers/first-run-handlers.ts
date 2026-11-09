import { ipcMain } from 'electron';
import * as path from 'path';
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
 * Claude Code's sign-in for the accounts a team's Claude members would run on, asked now: account 1, or every
 * enabled account with several on. Signed in when one of them is, missing when there is no claude to ask.
 */
async function claudeSignIn(getAppSettings: () => AppSettings): Promise<ClaudeSignIn> {
  const settings = readAccountsSettings();
  const listed = settings.enabled ? settings.accounts.filter(a => a.enabled) : settings.accounts.filter(a => a.id === DEFAULT_ACCOUNT_ID);
  const accounts = listed.length ? listed : [{ id: DEFAULT_ACCOUNT_ID, configDir: null }];
  const binary = getAppSettings().cliPaths?.claude || 'claude';
  const states = await Promise.all(accounts.map(async (a): Promise<ClaudeSignIn> => {
    try {
      const info = await claudeAuthStatus(binary, a.configDir ?? null);
      setAuth(a.id, { signedIn: info.signedIn, email: info.email, subscriptionType: info.subscriptionType, error: null, code: null });
      return info.signedIn ? 'signed-in' : 'signed-out';
    } catch (err) {
      return err instanceof ClaudeCliMissing ? 'cli-missing' : 'unknown';
    }
  }));
  if (states.includes('signed-in')) return 'signed-in';
  if (states.includes('cli-missing')) return 'cli-missing';
  return states.every(s => s === 'signed-out') ? 'signed-out' : 'unknown';
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
