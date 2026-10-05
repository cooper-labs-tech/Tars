import { app, Notification, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { AgentStatus } from '../types';
import { TG_CHARACTER_FACES, SLACK_CHARACTER_FACES, DATA_DIR, OLD_DATA_DIR } from '../constants';

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow | null) {
  mainWindow = window;
}

export function getAppBasePath(): string {
  let appPath = app.getAppPath();
  if (appPath.includes('app.asar')) {
    appPath = appPath.replace('app.asar', 'app.asar.unpacked');
  }
  return path.join(appPath, 'out');
}

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    // Readable by its owner alone; narrowDataDir closes an older install's.
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Publish the instructions Tars gives every agent it runs.
 *
 * Written to ~/.dorothy/CLAUDE.md, which every agent mounts through
 * `--add-dir ~/.dorothy` with CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1,
 * whatever project it is working in.
 *
 * The content is a shipped resource and nothing else. It used to look for the
 * app directory's own CLAUDE.md first and copy it verbatim, falling back to a
 * neutral text only when it found none. Packaged, no CLAUDE.md is in the
 * bundle so the neutral text was written; run from a clone, app.getAppPath()
 * is the repository, so Tars's own two hundred and fifty lines of development
 * rules were handed to every agent in every unrelated project: draw the frame
 * in design/tars-redesign.pen first, never touch electron/, open the pull
 * request against JeanBrasse/Tars, run npm run e2e:guard before calling it
 * done. Reading it was not even useful for Tars itself, where an agent already
 * loads that file natively as its project instructions.
 *
 * These are two different documents and only one of them belongs here.
 */
export function ensureAgentInstructions(): void {
  const dest = path.join(DATA_DIR, 'CLAUDE.md');

  /**
   * Take away a file this function cannot vouch for.
   *
   * Every path out of here either writes the shipped resource or leaves
   * nothing. Returning early instead, which an earlier version did, meant a
   * machine that already had the wrong document kept it: exactly the machines
   * this is meant to repair. No instructions is the better failure. An agent
   * without this file still has its own project's instructions and its own
   * judgement; an agent with a stale copy of it is being told to follow
   * another project's rules.
   *
   * Nothing is written in its place, because the only correct content is the
   * resource that could not be read, and inventing a second copy of it here
   * is how the wrong document escaped in the first place.
   */
  const discard = (): void => {
    try {
      if (!fs.existsSync(dest)) return;
      console.warn(`[instructions] removing ${dest}, which is no longer anybody's document`);
      fs.rmSync(dest, { force: true });
    } catch (err) {
      // A removal that fails is still not a reason to stop the app starting.
      console.warn('[instructions] could not remove the stale file:', err);
    }
  };

  try {
    const source = getAgentInstructionsPath();
    if (!fs.existsSync(source)) {
      // Said every time, not only when there is something to delete: an
      // install that cannot find its own resources is broken, and every agent
      // it starts from now on runs with no instructions at all.
      console.warn('[instructions] missing from the bundle:', source);
      discard();
      return;
    }
    ensureDataDir();
    fs.writeFileSync(dest, fs.readFileSync(source, 'utf-8'), 'utf-8');
  } catch (err) {
    // Called during startup: a failure here must never stop the app opening.
    console.warn('[instructions] failed to publish:', err);
    // The write may have got halfway, so what is on disk is nobody's document.
    discard();
  }
}

/**
 * Migrate data from ~/.claude-manager to ~/.dorothy on first launch after rebrand.
 * Only copies files that don't already exist in the new location to avoid overwriting newer data.
 * Removes the old directory after successful migration.
 */
export function migrateFromClaudeManager() {
  if (!fs.existsSync(OLD_DATA_DIR)) return;

  console.log('Migrating data from ~/.claude-manager to ~/.dorothy...');

  const items = [
    'agents.json',
    'agents.backup.json',
    'app-settings.json',
    'kanban-tasks.json',
    'scheduler-metadata.json',
    'telegram-downloads',
    'scripts',
  ];

  for (const item of items) {
    const src = path.join(OLD_DATA_DIR, item);
    const dest = path.join(DATA_DIR, item);

    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      console.log(`  Skipping ${item} (already exists in ~/.dorothy)`);
      continue;
    }

    try {
      fs.cpSync(src, dest, { recursive: true });
      console.log(`  Migrated ${item}`);
    } catch (err) {
      console.error(`  Failed to migrate ${item}:`, err);
    }
  }

  try {
    fs.rmSync(OLD_DATA_DIR, { recursive: true, force: true });
    console.log('Removed ~/.claude-manager');
  } catch (err) {
    console.error('Failed to remove ~/.claude-manager:', err);
  }
}

type NotificationSoundKey = 'waiting' | 'complete' | 'stop' | 'error';

// Resolve which sound key to use based on notification title heuristics
function inferSoundKey(title: string): NotificationSoundKey | undefined {
  const t = title.toLowerCase();
  if (t.includes('permission') || t.includes('waiting') || t.includes('attention')) return 'waiting';
  if (t.includes('finished') || t.includes('response')) return 'stop';
  if (t.includes('completed') || t.includes('done')) return 'complete';
  if (t.includes('error')) return 'error';
  return undefined;
}

export function sendNotification(
  title: string,
  body: string,
  agentId?: string,
  appSettings?: { notificationsEnabled: boolean; notificationSounds?: Record<string, string> },
) {
  if (!appSettings?.notificationsEnabled) return;

  const soundKey = inferSoundKey(title);
  const soundFilePath = soundKey ? appSettings.notificationSounds?.[soundKey] : undefined;
  const fileExists = soundFilePath ? fs.existsSync(soundFilePath) : false;
  const hasCustomSound = !!(soundFilePath && fileExists);

  console.log(`[notification] title="${title}" soundKey=${soundKey} soundFilePath=${soundFilePath} fileExists=${fileExists} hasCustomSound=${hasCustomSound}`);
  console.log(`[notification] appSettings.notificationSounds=`, JSON.stringify(appSettings?.notificationSounds));

  const notification = new Notification({
    title,
    body,
    silent: hasCustomSound, // silence system sound if we're playing a custom one
  });

  notification.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (agentId) {
        mainWindow.webContents.send('agent:focus', { agentId });
      }
    }
  });

  notification.show();

  if (hasCustomSound) {
    playSound(soundFilePath!);
  }
}

function playSound(filePath: string): void {
  if (process.platform === 'darwin') {
    execFile('afplay', [filePath], (err) => {
      if (err) console.error('Failed to play notification sound:', err.message);
    });
  } else if (process.platform === 'win32') {
    // PowerShell one-liner to play audio on Windows
    execFile('powershell', ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`], (err) => {
      if (err) console.error('Failed to play notification sound:', err.message);
    });
  } else {
    // Linux: try common players
    execFile('paplay', [filePath], (err) => {
      if (err) {
        execFile('aplay', [filePath], (err2) => {
          if (err2) console.error('Failed to play notification sound:', err2.message);
        });
      }
    });
  }
}

/** Its project's orchestrator: the Orchestrator toggle, and never the name.
 *  See core/agent-role.ts. */
export function isSuperAgent(agent: AgentStatus): boolean {
  return agent.role === 'orchestrator';
}

/** Find an orchestrator agent. Pass projectPath to get the orchestrator OF
 *  THAT PROJECT. Without it, callers with no project context (Telegram,
 *  Slack) get the first orchestrator found, all projects considered. */
export function getSuperAgent(agents: Map<string, AgentStatus>, projectPath?: string): AgentStatus | undefined {
  const orchestrators = Array.from(agents.values()).filter(a => isSuperAgent(a));
  if (projectPath) {
    return orchestrators.find(a => a.projectPath === projectPath);
  }
  return orchestrators[0];
}

export function formatAgentStatus(agent: AgentStatus): string {
  const isSuper = isSuperAgent(agent);
  const emoji = isSuper ? '👑' : (TG_CHARACTER_FACES[agent.character || ''] || '🤖');
  const statusEmoji = {
    idle: '⚪', running: '🟢', completed: '✅', error: '🔴', waiting: '🟡', stopped: '⏹', asleep: '💤'
  }[agent.status] || '⚪';

  let text = `${emoji} *${agent.name || 'Unnamed'}* ${statusEmoji}\n`;
  text += `   Status: ${agent.status}\n`;
  if (agent.currentTask) {
    text += `   Task: ${agent.currentTask.slice(0, 50)}${agent.currentTask.length > 50 ? '...' : ''}\n`;
  }
  if (!isSuper) {
    text += `   Project: \`${agent.projectPath.split('/').pop()}\``;
  }
  return text;
}

export function formatSlackAgentStatus(a: AgentStatus): string {
  const isSuper = isSuperAgent(a);
  const emoji = isSuper ? ':crown:' : (SLACK_CHARACTER_FACES[a.character || ''] || ':robot_face:');
  const statusEmoji = a.status === 'running' ? ':large_green_circle:' :
                      a.status === 'waiting' ? ':large_yellow_circle:' :
                      a.status === 'error' ? ':red_circle:' : ':white_circle:';

  let text = `${emoji} *${a.name}* ${statusEmoji}\n`;
  if (!isSuper) {
    const project = a.projectPath.split('/').pop() || 'Unknown';
    text += `    :file_folder: \`${project}\`\n`;
  }
  if (a.skills.length > 0) {
    text += `    :wrench: ${a.skills.slice(0, 3).join(', ')}${a.skills.length > 3 ? '...' : ''}\n`;
  }
  if (a.currentTask && a.status === 'running') {
    text += `    :speech_balloon: _${a.currentTask.slice(0, 40)}${a.currentTask.length > 40 ? '...' : ''}_\n`;
  }
  return text;
}

/**
 * Get the real filesystem path for asar-unpacked resources.
 * External processes (like claude CLI) can't read inside .asar archives,
 * so these files are unpacked to app.asar.unpacked/ on disk.
 */
function getResourcePath(filename: string): string {
  const appPath = app.getAppPath();
  const resourcePath = path.join(appPath, 'electron', 'resources', filename);
  // In production, replace app.asar with app.asar.unpacked for external process access
  return resourcePath.replace('app.asar', 'app.asar.unpacked');
}

/**
 * Get the path to the super agent instructions file
 */
export function getSuperAgentInstructionsPath(): string {
  return getResourcePath('super-agent-instructions.md');
}

/**
 * Get the path to the instructions every Tars agent is given
 */
export function getAgentInstructionsPath(): string {
  return getResourcePath('agent-instructions.md');
}

/**
 * Get the path to the local agent runner script
 */
export function getLocalAgentRunnerPath(): string {
  return getResourcePath('local-agent-runner.js');
}

/**
 * Get the path to the Telegram-specific instructions file
 */
export function getTelegramInstructionsPath(): string {
  return getResourcePath('telegram-instructions.md');
}

/**
 * Read super agent instructions from file
 */
export function getSuperAgentInstructions(): string {
  const instructionsPath = getSuperAgentInstructionsPath();
  try {
    if (fs.existsSync(instructionsPath)) {
      return fs.readFileSync(instructionsPath, 'utf-8');
    }
  } catch (err) {
    console.error('Failed to read super agent instructions:', err);
  }
  // Fallback instructions
  return 'You are the Super Agent - an orchestrator that manages other Claude agents using MCP tools. Use list_agents, start_agent, get_agent_output, send_telegram, send_slack and send_discord tools.';
}

/**
 * Read Telegram-specific instructions from file
 */
export function getTelegramInstructions(): string {
  const instructionsPath = getTelegramInstructionsPath();
  try {
    if (fs.existsSync(instructionsPath)) {
      return fs.readFileSync(instructionsPath, 'utf-8');
    }
  } catch (err) {
    console.error('Failed to read telegram instructions:', err);
  }
  return '';
}

