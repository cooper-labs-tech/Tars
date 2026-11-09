import { ipcMain } from 'electron';
import * as path from 'path';
import { agents } from '../core/agent-manager';
import { updateAgent } from '../core/agent-update';
import { restartRunnersOf } from '../services/chat-runners';
import { setupOffer, teamOf, writeCi, writeClaudeMd } from '../services/project-setup';
import type { AgentPermissionMode } from '../types';

/**
 * What the window offers a project so that the owner's workflow runs there with nothing set up by hand (2.0.7, W3,
 * W5 and W7 of the fresh-install report): its CI workflow and its CLAUDE.md (services/project-setup.ts), and one
 * permission level for its whole team. IPC only, so only the owner, in the window, says yes: no agent's token
 * reaches these, and none has an API route.
 */

const MODES: readonly AgentPermissionMode[] = ['plan', 'normal', 'auto', 'bypass'];

function projectOf(value: unknown): string | undefined {
  return typeof value === 'string' && path.isAbsolute(value) ? value : undefined;
}

export function registerProjectSetupHandlers(): void {
  ipcMain.handle('project:setupOffer', async (_event, projectPath: unknown) => {
    const project = projectOf(projectPath);
    if (!project) return { success: false, error: 'projectPath is an absolute path.' };
    return { success: true, ...(await setupOffer(project, teamOf(project, agents.values()))) };
  });

  ipcMain.handle('project:writeCi', async (_event, projectPath: unknown) => {
    const project = projectOf(projectPath);
    if (!project) return { success: false, error: 'projectPath is an absolute path.' };
    const written = await writeCi(project);
    return 'code' in written ? { success: false, ...written } : { success: true, ...written };
  });

  ipcMain.handle('project:writeClaudeMd', async (_event, projectPath: unknown) => {
    const project = projectOf(projectPath);
    if (!project) return { success: false, error: 'projectPath is an absolute path.' };
    const written = await writeClaudeMd(project, teamOf(project, agents.values()));
    return 'code' in written ? { success: false, ...written } : { success: true, ...written };
  });

  // The owner chooses once for the whole team (W5): each agent through agent:update's own path, which restarts a
  // live CLI at a moment that cuts nothing (core/agent-restart.ts), and its chats' runners with it.
  ipcMain.handle('project:setTeamPermissionMode', async (_event, params: { projectPath?: unknown; permissionMode?: unknown }) => {
    const project = projectOf(params?.projectPath);
    const mode = params?.permissionMode as AgentPermissionMode;
    if (!project) return { success: false, error: 'projectPath is an absolute path.' };
    if (!MODES.includes(mode)) return { success: false, error: `permissionMode is one of ${MODES.join(', ')}.` };
    const results: Array<{ id: string; name?: string; success: boolean; error?: string }> = [];
    for (const agent of teamOf(project, agents.values())) {
      const result = await updateAgent({ id: agent.id, permissionMode: mode });
      if (result.success) restartRunnersOf(result.agent.id, result.changedAtLaunch);
      results.push({ id: agent.id, name: agent.name, success: result.success, ...(result.success ? {} : { error: result.error }) });
    }
    return { success: results.every(r => r.success), agents: results };
  });
}
