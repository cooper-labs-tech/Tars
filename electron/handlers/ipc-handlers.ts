import { ipcMain, dialog, shell, app } from 'electron';
import { stopAcpRuns } from '../services/acp/delegate';
import { publishedWaitingOn } from '../utils/waiting-on';
import { defaultShell } from '../utils/default-shell';
import { openTerminal } from '../utils/open-terminal';
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../services/update-checker';
import { registerMemoryHandlers } from './memory-handlers';
import { registerObsidianHandlers } from './obsidian-handlers';
import { registerGwsHandlers } from './gws-handlers';
import { registerMcpConfigHandlers } from './mcp-config-handlers';
import { broadcastToAllWindows } from '../utils/broadcast';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DATA_DIR, dataPath } from '../constants';
import { v4 as uuidv4 } from 'uuid';
import * as pty from 'node-pty';
import TelegramBot from 'node-telegram-bot-api';
import { App as SlackApp, LogLevel } from '@slack/bolt';

// Import types
import type { AgentStatus, WorktreeConfig, AgentCharacter, AppSettings, AgentProvider, AgentPermissionMode, AgentEffort, AgentRole } from '../types';
import { buildFullPath } from '../utils/path-builder';
import { cliPathDirs } from '../utils/cli-path-dirs';
import { projectFolders } from '../services/project-index';
import { marketplaceListing } from '../services/skills-marketplace';
import { skillsProblem } from '../utils/skill-name';
import { resolveWorktreePath } from '../utils/worktree-path';
import { writeAtomicSync } from '../utils/secret-file';
import { getProvider, getAllProviders } from '../providers';
import { messagesWaiting, writeHumanInput, writeProgrammaticInput } from '../core/pty-manager';
import { killStalePty, ensureProjectTrusted, appendAgentOutput, armTaskStartWatch } from '../core/agent-manager';
import { extractStatusLine } from '../utils/ansi';
import { scheduleTick } from '../utils/agents-tick';
import { loadCatalog, modelsForProvider, priceFor, catalogStatus } from '../services/model-catalog';
import { assembleDigest, needsPromptInjection, wrapDigestForPrompt, searchMemory, memoryStatus } from '../services/memory-hub';
import { usableHermesConnection } from '../services/hermes-config';
import { reviewDiff, fileDiff, repoSummary } from '../services/git-review';
import { searchLogs, agentTail, fleetSummary } from '../services/log-search';
import { usageByProvider as ledgerUsageByProvider } from '../services/usage-ledger';
import { consumeResumeSessionId, resolveResumeSessionId } from '../utils/resume-session';
import { registerAgentLauncher, launchBegins, launchAbandoned, sessionStarting, type AgentLauncher } from '../core/agent-launch';
import { launchSettings, changedLaunchSettings, restartForSettings, noteLaunch, restartAgent, pendingRestarts, forgetRestart } from '../core/agent-restart';
import { assignRole, requestedRole } from '../core/agent-role';
import type { ClaudeSettings, ClaudeStats, ClaudeProject, ClaudePlugin, ClaudeSkill, ClaudeHistoryEntry } from '../services/claude-service';
import * as crypto from 'crypto';
import * as https from 'https';
import { getTasmaniaStatus, tasmaniaFetch } from '../services/tasmania-client';
import { enforcesOrchestratorMode } from '../providers/cli-provider';
import { withSessionTruth } from '../services/agent-truth';
import { spawnAgentPty, cliRunningIn } from '../core/agent-pty';
import { updateSharedJsonSync } from '../utils/shared-file';
import { terminalSnapshot, leftFullscreenIn, rememberPanelSize, resizeTerminalMirror } from '../core/terminal-mirror';

/**
 * Normalize a JIRA domain value to a full hostname.
 * Handles both legacy subdomain-only values (e.g. "mycompany") and
 * full hostnames (e.g. "mycompany.atlassian.net", "issues.example.com").
 */
function normalizeJiraHost(domain: string): string {
  let host = domain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Legacy: bare subdomain without dots → append .atlassian.net
  if (!host.includes('.')) {
    host = `${host}.atlassian.net`;
  }
  return host;
}

// Dependencies interface for dependency injection
export interface IpcHandlerDependencies {
  // State
  ptyProcesses: Map<string, pty.IPty>;
  agents: Map<string, AgentStatus>;
  skillPtyProcesses: Map<string, pty.IPty>;
  quickPtyProcesses: Map<string, pty.IPty>;
  pluginPtyProcesses: Map<string, pty.IPty>;

  // Functions
  getMainWindow: () => Electron.BrowserWindow | null;
  getAppSettings: () => AppSettings;
  setAppSettings: (settings: AppSettings) => void;
  saveAppSettings: (settings: AppSettings) => void;
  saveAgents: () => void;
  initAgentPty: (agent: AgentStatus) => Promise<string>;
  handleStatusChangeNotification: (agent: AgentStatus, newStatus: string) => void;
  isSuperAgent: (agent: AgentStatus) => boolean;
  getMcpOrchestratorPath: () => string;
  initTelegramBot: () => void;
  initSlackBot: () => void;
  initDiscordBot: () => void;
  getTelegramBot: () => TelegramBot | null;
  getSlackApp: () => SlackApp | null;
  getSuperAgentTelegramTask: () => boolean;
  getSuperAgentOutputBuffer: () => string[];
  setSuperAgentOutputBuffer: (buffer: string[]) => void;

  // Claude data functions. The real shapes live in claude-service.ts, which is
  // what actually provides these: this used to restate them as `any`, so a
  // change over there could not reach the handlers that consume it.
  getClaudeSettings: () => Promise<ClaudeSettings | null>;
  getClaudeStats: () => Promise<ClaudeStats | null>;
  getClaudeProjects: () => Promise<ClaudeProject[]>;
  getClaudePlugins: () => Promise<ClaudePlugin[]>;
  getClaudeSkills: () => Promise<ClaudeSkill[]>;
  getClaudeHistory: (limit?: number) => Promise<ClaudeHistoryEntry[]>;
}

/**
 * Register all IPC handlers
 */

/** Projects the user added by hand. Kept in ~/.dorothy so they outlive app
 *  updates and are shared by every surface (the renderer's localStorage was
 *  neither durable nor visible outside the Projects page). */
const CUSTOM_PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

function readCustomProjects(): string[] {
  try {
    if (!fs.existsSync(CUSTOM_PROJECTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((p: unknown) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function writeCustomProjects(list: string[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic: a crash between truncate and write left an unparseable file, and
  // the reader above silently returns [] for that - the user's project list
  // just disappears.
  writeAtomicSync(CUSTOM_PROJECTS_FILE, JSON.stringify(Array.from(new Set(list)), null, 2));
}

export function registerIpcHandlers(deps: IpcHandlerDependencies): void {
  registerPtyHandlers(deps);
  registerAgentHandlers(deps);
  registerSkillHandlers(deps);
  registerPluginHandlers(deps);
  registerClaudeDataHandlers(deps);
  registerSettingsHandlers(deps);
  registerAppSettingsHandlers(deps);
  registerUpdateHandlers();
  // Orchestrator handlers are registered separately in services/mcp-orchestrator.ts
  registerTasmaniaHandlers(deps);
  registerOllamaHandlers(deps);
  registerFileSystemHandlers(deps);
  registerShellHandlers(deps);
  registerMemoryHandlers();
  registerObsidianHandlers({ getAppSettings: deps.getAppSettings, setAppSettings: deps.setAppSettings, saveAppSettings: deps.saveAppSettings });
  registerGwsHandlers({ getAppSettings: deps.getAppSettings, setAppSettings: deps.setAppSettings, saveAppSettings: deps.saveAppSettings });
  registerMcpConfigHandlers();
  registerTrayHandlers(deps);
}

// ============== Tray Panel IPC Handlers ==============

function registerTrayHandlers(deps: IpcHandlerDependencies): void {
  const { getMainWindow } = deps;

  ipcMain.handle('tray:showMainWindow', async () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
    return { success: true };
  });

  ipcMain.handle('tray:quit', async () => {
    app.quit();
    return { success: true };
  });
}

// ============== PTY Terminal IPC Handlers ==============

function registerPtyHandlers(deps: IpcHandlerDependencies): void {
  const { ptyProcesses, getMainWindow } = deps;

  // Create a new PTY terminal
  ipcMain.handle('pty:create', async (_event, { cwd, cols, rows }: { cwd?: string; cols?: number; rows?: number }) => {
    const id = uuidv4();
    const shell = defaultShell();

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: process.env as { [key: string]: string },
    });

    ptyProcesses.set(id, ptyProcess);

    // Send data from PTY to renderer
    ptyProcess.onData((data) => {
      getMainWindow()?.webContents.send('pty:data', { id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      getMainWindow()?.webContents.send('pty:exit', { id, exitCode });
      ptyProcesses.delete(id);
    });

    return { id };
  });

  // Write to PTY
  ipcMain.handle('pty:write', async (_event, { id, data }: { id: string; data: string }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.write(data);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Resize PTY
  ipcMain.handle('pty:resize', async (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Kill PTY
  ipcMain.handle('pty:kill', async (_event, { id }: { id: string }) => {
    const ptyProcess = ptyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcesses.delete(id);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });
}

// ============== Agent Management IPC Handlers ==============

function registerAgentHandlers(deps: IpcHandlerDependencies): void {
  const {
    agents,
    ptyProcesses,
    getMainWindow,
    getAppSettings,
    saveAgents,
    initAgentPty,
    handleStatusChangeNotification,
    isSuperAgent,
    getSuperAgentTelegramTask,
    getSuperAgentOutputBuffer,
    setSuperAgentOutputBuffer
  } = deps;

  // Create a new agent (now creates a PTY-backed terminal)
  ipcMain.handle('agent:create', async (_event, config: {
    projectPath: string;
    skills: string[];
    worktree?: WorktreeConfig;
    character?: AgentCharacter;
    name?: string;
    secondaryProjectPath?: string;
    permissionMode?: AgentPermissionMode;
    effort?: AgentEffort;
    provider?: AgentProvider;
    model?: string;
    localModel?: string;
    obsidianVaultPaths?: string[];
    /** The Orchestrator toggle. See core/agent-role.ts. */
    role?: AgentRole;
    /** The toggle's old name, read when `role` is absent. */
    orchestratorMode?: boolean;
    cliPath?: string;
  }) => {
    const id = uuidv4();
    const shell = '/bin/bash';

    // Validate effort against allowed values to prevent shell injection
    const VALID_EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (config.effort && !VALID_EFFORTS.includes(config.effort)) {
      throw new Error(`Invalid effort level: ${config.effort}`);
    }
    // Before anything is created: a refused role leaves no worktree or terminal behind.
    const role = requestedRole(config) ?? 'worker';
    // Every task the agent is given opens with its skills (gate of #204).
    const skillsWrong = skillsProblem(config.skills ?? []);
    if (skillsWrong) throw new Error(`Not created: ${skillsWrong}.`);

    // Validate model name: only allow safe characters (alphanumeric, dash, dot, slash, colon, underscore)
    if (config.model && !/^[a-zA-Z0-9._\-\/:@]+$/.test(config.model)) {
      throw new Error(`Invalid model name: ${config.model}`);
    }

    // Validate project path exists
    let cwd = config.projectPath;
    if (!fs.existsSync(cwd)) {
      console.warn(`Project path does not exist: ${cwd}, using home directory`);
      cwd = os.homedir();
    }

    let worktreePath: string | undefined;
    let branchName: string | undefined;

    // Create git worktree if enabled
    if (config.worktree?.enabled && config.worktree?.branchName) {
      branchName = config.worktree.branchName;
      const worktreesDir = path.join(cwd, '.worktrees');
      // resolveWorktreePath refuses `..`: the old regex allowed both `.` and
      // `/`, so `../../../etc` passed it, resolved outside the project, and
      // the "already exists, reusing it" branch below then made it the cwd.
      worktreePath = resolveWorktreePath(cwd, branchName);
      if (!worktreePath) {
        throw new Error('Invalid branch name');
      }

      console.log(`Creating git worktree for agent ${id} at ${worktreePath} on branch ${branchName}`);

      try {
        // Create .worktrees directory if it doesn't exist
        if (!fs.existsSync(worktreesDir)) {
          fs.mkdirSync(worktreesDir, { recursive: true });
        }

        // Check if worktree already exists
        if (fs.existsSync(worktreePath)) {
          console.log(`Worktree already exists at ${worktreePath}, reusing it`);
        } else {
          // git is invoked as argv, never as a shell string. These commands
          // used to be built by concatenation into single quotes, and
          // worktreePath derives from the caller's projectPath: an ordinary
          // folder like "Bob's Projects" broke the quoting (git never ran, the
          // catch below swallowed it, and the agent silently worked in the
          // shared repository instead of the isolated worktree it asked for),
          // and a folder named `x';touch /tmp/pwned;'` ran its own command.
          const { execFileSync } = await import('child_process');

          // Check if branch already exists
          try {
            execFileSync('git', ['rev-parse', '--verify', branchName], { cwd, stdio: 'pipe' });
            // Branch exists, create worktree using existing branch
            execFileSync('git', ['worktree', 'add', worktreePath, branchName], { cwd, stdio: 'pipe' });
          } catch {
            // Branch doesn't exist, create worktree with new branch
            execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd, stdio: 'pipe' });
          }
        }

        // Use the worktree path as the working directory
        cwd = worktreePath;
      } catch (err) {
        // Do not degrade to the shared checkout. This used to drop the
        // worktree and carry on with cwd = projectPath, so a worktree that
        // could not be created turned into an agent writing straight into the
        // user's main workspace with nothing on screen to say so (only
        // DeployTeamDialog ever inspected branchName afterwards).
        console.error(`Failed to create git worktree:`, err);
        throw new Error(
          `Failed to create git worktree for branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(`Creating PTY for agent ${id} with shell ${shell} in ${cwd}`);

    // Build PATH that includes user-configured paths, nvm, and other common locations for claude
    const currentSettings = getAppSettings();
    const fullPath = buildFullPath(cliPathDirs(currentSettings.cliPaths));

    // Create PTY for this agent
    // Strip nested-session env vars to prevent errors
    const cleanEnv = { ...process.env as { [key: string]: string } };
    // Each provider may have env vars to delete; always delete CLAUDECODE for Claude
    delete cleanEnv['CLAUDECODE'];

    const allSkills = [...new Set(config.skills)];

    // Get provider-specific env vars
    const agentProvider = getProvider(config.provider);
    const providerEnvVars = agentProvider.getPtyEnvVars(id, config.projectPath, allSkills, currentSettings);

    // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd so
    // bypass/auto-mode agents never see the first-launch trust prompt.
    ensureProjectTrusted(cwd);

    let ptyProcess: pty.IPty;
    try {
      // Through spawnAgentPty: this is an agent's pty, so it needs what Tars
      // imposes on one. Found while fixing the local switch, and it is the
      // same hole: getPtyEnvVars puts CLAUDE_AGENT_ID in here, so an agent
      // created in a sandbox posted its hooks to 31415 under a real id.
      ptyProcess = spawnAgentPty({
        binaryName: agentProvider.binaryName,
        shell,
        args: ['-l'],
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...cleanEnv,
          PATH: fullPath,
          ...providerEnvVars,
        },
      });
      console.log(`PTY created successfully for agent ${id}, PID: ${ptyProcess.pid}`);
    } catch (err) {
      console.error(`Failed to create PTY for agent ${id}:`, err);
      throw err;
    }

    const ptyId = uuidv4();
    ptyProcesses.set(ptyId, ptyProcess);

    // Validate secondary project path if provided
    let secondaryProjectPath: string | undefined;
    if (config.secondaryProjectPath) {
      if (fs.existsSync(config.secondaryProjectPath)) {
        secondaryProjectPath = config.secondaryProjectPath;
        console.log(`Secondary project path validated: ${secondaryProjectPath}`);
      } else {
        console.warn(`Secondary project path does not exist: ${config.secondaryProjectPath}`);
      }
    }

    const now = new Date().toISOString();
    const status: AgentStatus = {
      id,
      status: 'idle',
      projectPath: config.projectPath,
      secondaryProjectPath,
      worktreePath,
      branchName,
      skills: config.skills,
      output: [],
      lastActivity: now,
      createdAt: now,
      ptyId,
      ptyCwd: cwd,
      character: config.character || 'robot',
      name: config.name || `Agent ${id.slice(0, 4)}`,
      permissionMode: config.permissionMode || 'normal',
      effort: config.effort,
      provider: config.provider || 'claude',
      model: config.model,
      localModel: config.localModel,
      obsidianVaultPaths: config.obsidianVaultPaths || [],
      cliPath: config.cliPath,
    };
    // A new orchestrator takes the role from its project's current one.
    const demoted = assignRole(status, role, agents.values());
    agents.set(id, status);

    // Save agents to disk
    saveAgents();
    for (const other of demoted) restartForSettings(other.id, ['orchestrator']);

    // Forward PTY output to renderer
    // Guard: skip if this PTY was replaced (e.g. local provider recreates PTY in agent:start)
    ptyProcess.onData((data) => {
      const agent = agents.get(id);
      if (!agent || agent.ptyId !== ptyId) return;

      appendAgentOutput(agent, data);
      agent.lastActivity = new Date().toISOString();
      agent.statusLine = extractStatusLine(agent.output);

      // Capture Super Agent output for Telegram
      if (getSuperAgentTelegramTask() && isSuperAgent(agent)) {
        const buffer = getSuperAgentOutputBuffer();
        buffer.push(data);
        if (buffer.length > 200) {
          setSuperAgentOutputBuffer(buffer.slice(-100));
        }
      }

      broadcastToAllWindows('agent:output', {
        type: 'output',
        agentId: id,
        ptyId,
        data,
        timestamp: new Date().toISOString(),
      });
      scheduleTick();
    });

    ptyProcess.onExit(({ exitCode }) => {
      const agent = agents.get(id);
      // Skip status update if this PTY was replaced by a newer one
      if (agent && agent.ptyId === ptyId) {
        console.log(`Agent ${id} PTY exited with code ${exitCode}`);
        const newStatus = exitCode === 0 ? 'completed' : 'error';
        agent.status = newStatus;
        agent.lastActivity = new Date().toISOString();
        handleStatusChangeNotification(agent, newStatus);
        broadcastToAllWindows('agent:complete', {
          type: 'complete',
          agentId: id,
          ptyId,
          exitCode,
          timestamp: new Date().toISOString(),
        });
      }
      ptyProcesses.delete(ptyId);
      scheduleTick();
    });

    return { ...status, ptyId };
  });

  // Start an agent with a prompt (sends command to PTY). The one launch of an
  // agent's CLI into its terminal: the handler below, the Kanban automation and
  // the restart that applies changed settings all come through here. See
  // core/agent-launch.ts.
  const launchInTerminal: AgentLauncher = async (id, prompt, options) => {
    const agent = agents.get(id);
    if (!agent) throw new Error('Agent not found');

    // The directory has to exist before anything else happens. Without this we
    // spawned a PTY, built the whole CLI command and wrote
    // `cd '<gone>' && claude ...` into it - bash printed "No such file or
    // directory", the && short-circuited, and the user was left looking at a
    // shell prompt with no indication that anything had failed. Projects do get
    // moved and deleted, so this is a normal state, not a corrupt one.
    const startDir = agent.worktreePath || agent.projectPath;
    if (!fs.existsSync(startDir)) {
      agent.pathMissing = true;
      agent.status = 'error';
      agent.currentTask = `Folder not found: ${startDir}`;
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      broadcastToAllWindows('agent:status', {
        type: 'status', agentId: id, status: 'error', timestamp: agent.lastActivity,
      });
      scheduleTick();
      throw new Error(
        `${agent.name || id} cannot start: its folder ${startDir} no longer exists. ` +
        `Point the agent at another folder in its settings, or delete it.`,
      );
    }
    agent.pathMissing = false;

    // Validate model name from options to prevent shell injection
    if (options?.model && !/^[a-zA-Z0-9._\-\/:@]+$/.test(options.model)) {
      throw new Error(`Invalid model name: ${options.model}`);
    }

    // If the agent's worktreePath changed after the PTY was spawned, the
    // existing PTY is stuck in the wrong cwd. Kill it so initAgentPty below
    // respawns with the correct working directory.
    killStalePty(agent);

    // A CLI still running in the PTY gets nothing typed into it. The status
    // cannot say so: a turn that fails leaves claude alive at its prompt, and
    // an agent done or idle keeps its session open, so a start from any of
    // those states typed `cd '...' && claude ...` into claude's own input, and
    // the local provider below would have killed the session outright. The
    // terminal says what runs in it; after /exit only the shell is left, and
    // the start goes ahead.
    if (agent.ptyId && cliRunningIn(ptyProcesses.get(agent.ptyId))) {
      return {
        success: false,
        cliRunning: true,
        error: `${agent.name || id} is still running a CLI in its terminal. Nothing was typed into it: stop the agent first, or give it the task in its terminal.`,
      };
    }

    // Initialize PTY if agent was restored from disk and doesn't have one
    let ptyJustCreated = false;
    if (!agent.ptyId || !ptyProcesses.has(agent.ptyId)) {
      console.log(`Agent ${id} needs PTY initialization`);
      const ptyId = await initAgentPty(agent);
      agent.ptyId = ptyId;
      ptyJustCreated = true;
    }

    // Determine provider: prefer agent-level, fallback to options, default to 'claude'
    const provider = agent.provider || options?.provider || 'claude';
    const localModel = agent.localModel || options?.localModel;

    // ── For local provider, recreate PTY with Tasmania env vars baked in ──
    if (provider === 'local') {

      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status !== 'running' || !tasmaniaStatus.endpoint) {
        throw new Error('Tasmania is not running or no model is loaded. Start a model in Tasmania settings first.');
      }

      // Strip /v1 suffix from endpoint. Tasmania's TerminalPanel uses
      // `http://127.0.0.1:${port}` (no /v1), because Claude Code's SDK
      // appends /v1/messages itself. Including /v1 causes double-pathing
      // (http://…/v1/v1/messages) which breaks all API calls.
      const endpoint = tasmaniaStatus.endpoint!.replace(/\/v1\/?$/, '');
      const model = localModel || tasmaniaStatus.modelName || 'default';

      // Kill the existing PTY and recreate with env vars in the process environment.
      // Writing `export ...` to an already-running shell is racy: the shell may not
      // process the export before the claude command runs. Baking vars into pty.spawn()
      // guarantees they're in the process environment from the start.
      const oldPty = ptyProcesses.get(agent.ptyId!);
      if (oldPty) {
        oldPty.kill();
        ptyProcesses.delete(agent.ptyId!);
      }

      const currentSettings = getAppSettings();
      const fullPathForLocal = buildFullPath(cliPathDirs(currentSettings.cliPaths));

      const cleanEnvLocal = { ...process.env as { [key: string]: string } };
      delete cleanEnvLocal['CLAUDECODE'];

      const workingDir = agent.worktreePath || agent.projectPath;
      const cwd = fs.existsSync(workingDir) ? workingDir : os.homedir();

      // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd.
      ensureProjectTrusted(cwd);

      // Local provider uses Claude provider env vars + Tasmania env vars.
      // Override CLAUDE_PROVIDER to 'local' so usage tracking records the correct provider.
      const localProviderEnvVars = {
        ...getProvider('claude').getPtyEnvVars(agent.id, agent.projectPath, agent.skills, currentSettings),
        CLAUDE_PROVIDER: 'local',
      };

      // Through spawnAgentPty like the other two. This is an agent's pty: it
      // carries CLAUDE_AGENT_ID, and its hooks post to /api/hooks/* with the
      // token spawnAgentPty mints for it. Spawned directly it had no
      // CLAUDE_MGR_API_URL, so those posts fell back to 31415 and a sandbox
      // agent switched to local wrote its status into the live Tars, under a
      // real fleet id. Exactly the damage the same variable fixed elsewhere.
      const newPty = spawnAgentPty({
        binaryName: getProvider('claude').binaryName,
        shell: '/bin/bash',
        args: ['-l'],
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...cleanEnvLocal,
          PATH: fullPathForLocal,
          ...localProviderEnvVars,
          // Tasmania-specific env vars:
          // - ANTHROPIC_BASE_URL without /v1 (SDK appends /v1/messages)
          // - ANTHROPIC_MODEL with the raw local model name
          ANTHROPIC_BASE_URL: endpoint,
          ANTHROPIC_MODEL: model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      });

      const newPtyId = uuidv4();
      ptyProcesses.set(newPtyId, newPty);
      agent.ptyId = newPtyId;
      agent.ptyCwd = cwd;

      // Re-attach event handlers
      newPty.onData((data) => {
        const agentData = agents.get(id);
        if (agentData) {
          appendAgentOutput(agentData, data);
          agentData.lastActivity = new Date().toISOString();
          agentData.statusLine = extractStatusLine(agentData.output);
          if (getSuperAgentTelegramTask() && isSuperAgent(agentData)) {
            const buffer = getSuperAgentOutputBuffer();
            buffer.push(data);
            if (buffer.length > 200) {
              setSuperAgentOutputBuffer(buffer.slice(-100));
            }
          }
        }
        broadcastToAllWindows('agent:output', {
          type: 'output',
          agentId: id,
          ptyId: newPtyId,
          data,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });

      newPty.onExit(({ exitCode }) => {
        console.log(`Agent ${id} PTY exited with code ${exitCode}`);
        const agentData = agents.get(id);
        // Guard: only mutate if this PTY is still the active one (prevents race on restart)
        if (agentData && agentData.ptyId === newPtyId) {
          const newStatus = exitCode === 0 ? 'completed' : 'error';
          agentData.status = newStatus;
          agentData.lastActivity = new Date().toISOString();
          handleStatusChangeNotification(agentData, newStatus);
        }
        ptyProcesses.delete(newPtyId);
        broadcastToAllWindows('agent:complete', {
          type: 'complete',
          agentId: id,
          ptyId: newPtyId,
          exitCode,
          timestamp: new Date().toISOString(),
        });
        scheduleTick();
      });
    }

    // Get the (potentially recreated) PTY process
    const ptyProcess = ptyProcesses.get(agent.ptyId!);
    if (!ptyProcess) throw new Error('PTY not found');

    // ── Build CLI command via provider ─────────────────────────────
    const appSettingsForCommand = getAppSettings();
    const cliProvider = getProvider(provider);
    const binaryPath = agent.cliPath || cliProvider.resolveBinaryPath(appSettingsForCommand);

    // Its project's orchestrator: the toggle, never the name.
    const isSuperAgentCheck = isSuperAgent(agent);

    // Resolve MCP config path: pass for ALL agents using flag strategy (Claude)
    let mcpConfigPath: string | undefined;
    let systemPromptFile: string | undefined;
    if (cliProvider.getMcpConfigStrategy() === 'flag') {
      const possibleMcpPath = path.join(os.homedir(), '.claude', 'mcp.json');
      if (fs.existsSync(possibleMcpPath)) {
        mcpConfigPath = possibleMcpPath;
      }
    }

    // Super Agent-specific: system prompt file
    if (isSuperAgentCheck) {
      const { getSuperAgentInstructionsPath } = await import('../utils');
      const superAgentInstructionsPath = getSuperAgentInstructionsPath();
      if (fs.existsSync(superAgentInstructionsPath)) {
        systemPromptFile = superAgentInstructionsPath;
      }
    }

    const allAgentSkills = [...new Set(agent.skills || [])];

    // The model the agent is set to, as the API path does: an explicit model
    // on this call, else the record. The session's own model used to come
    // between the two, which is the model the session being replaced last
    // answered on: an agent moved to Opus 5.5 in the Agents page came back up
    // on Opus 5, and one untouched for a month on whatever it ran then.
    // `default` is no model at all, so the CLI picks its own.
    const chosenModel = options?.model || agent.model;
    const resolvedModel = (provider !== 'local' && chosenModel && chosenModel !== 'default')
      ? chosenModel
      : undefined;

    // CLIs without Claude's SessionStart hook get the project's memory in the
    // prompt instead - otherwise those agents start knowing nothing.
    let promptWithMemory = prompt;
    if (needsPromptInjection(cliProvider.configDir)) {
      try {
        const digest = await assembleDigest({
          projectPath: agent.projectPath,
          settings: appSettingsForCommand as never,
          hermes: usableHermesConnection(),
          budgetMs: 3000,
        });
        const wrapped = wrapDigestForPrompt(digest);
        if (wrapped) promptWithMemory = `${wrapped}\n\n${prompt}`;
      } catch {
        // Memory is context, not a precondition.
      }
    }

    // Which conversation to continue. Without a word from the caller, the usual
    // rule: the last session, once per app run. A restart names the session it
    // has just replaced, and it is continued under a new id: `--resume` alone
    // keeps the id, which is now the tombstone of the killed session, so every
    // post of the resumed one would be dropped as stale. Measured on 2.1.280,
    // `--resume <id> --fork-session` with a new model and effort: both show in
    // the header, the conversation answers from its history, and the
    // transcript is a new file under a new id.
    const namedResume = options?.resumeSessionId;
    const resumeSessionId = namedResume === undefined
      ? consumeResumeSessionId(agent)
      : namedResume === null
        ? null
        : resolveResumeSessionId({ ...agent, resumableSessionId: namedResume });

    const forkSession = !!resumeSessionId && namedResume !== undefined;
    // A fork writes no transcript before its first turn: until it does, the
    // conversation to resume is still this one. See forkedFromSessionId.
    agent.forkedFromSessionId = forkSession ? resumeSessionId ?? undefined : undefined;

    // What this launch passes, read with the command it builds: the shell wait
    // below leaves half a second for a change to land that the command does
    // not carry (see noteLaunch).
    const launched = launchSettings(agent);
    const command = cliProvider.buildInteractiveCommand({
      resumeSessionId: resumeSessionId ?? undefined,
      forkSession,
      binaryPath,
      prompt: promptWithMemory,
      model: resolvedModel,
      verbose: appSettingsForCommand.verboseModeEnabled,
      // The agent's own, orchestrator or not, as the API launch has always
      // done. This one put every orchestrator in bypass whatever it was set
      // to, so a permission mode changed in the Agents page never reached an
      // orchestrator, restart or not, and a worker switched to orchestrator
      // was quietly given bypass. The Kanban automation still asks for it.
      permissionMode: options?.permissionMode ?? agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal'),
      effort: agent.effort,
      secondaryProjectPath: agent.secondaryProjectPath,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      mcpConfigPath,
      systemPromptFile,
      skills: allAgentSkills,
      isSuperAgent: isSuperAgentCheck,
      chrome: appSettingsForCommand.chromeEnabled,
      // BUG 5: an orchestrator cannot edit files.
      orchestratorMode: isSuperAgentCheck,
    });

    // Persist the prompt for future re-launches and update status. Working
    // only with a task. A start without one, which is every start from the
    // Dashboard, autostart included, and every restart, brings the CLI up at
    // its prompt, where it waits: marked `running`, it stayed that way until a
    // turn it never had came to an end. Measured on 2026-09-22: eleven agents
    // relaunched by hand from the Dashboard sat in `running` with no task for
    // half an hour in front of an idle prompt, and agent-watch will not write
    // to an agent that is `running`, so a note owed to one of them waited on a
    // turn that was not coming.
    if (prompt.trim()) {
      agent.savedPrompt = prompt;
      agent.status = 'running';
      agent.currentTask = prompt.slice(0, 100);
    } else {
      agent.status = 'idle';
      agent.currentTask = undefined;
      agent.waitingReason = undefined;
    }
    agent.lastActivity = new Date().toISOString();
    // Started from the Agents page, which never touches the API and so was
    // the one path with no check on whether the task actually landed.
    armTaskStartWatch(agent, agent.ptyId, promptWithMemory);
    broadcastToAllWindows('agent:status', {
      type: 'status',
      agentId: id,
      status: agent.status,
      timestamp: agent.lastActivity,
    });
    scheduleTick();

    // First cd to the appropriate directory (worktree if exists, otherwise project), then run claude
    const workingPath = (agent.worktreePath || agent.projectPath).replace(/'/g, "'\\''");
    const fullCommand = `cd '${workingPath}' && ${command}`;

    // Wait for the shell to initialize before writing the command.
    // A freshly-spawned PTY needs time for bash to start up (~200ms).
    // Local provider always recreates the PTY, so it always needs the delay.
    const needsDelay = ptyJustCreated || provider === 'local';
    if (needsDelay) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          writeProgrammaticInput(ptyProcess, fullCommand);
          resolve();
        }, 500);
      });
    } else {
      writeProgrammaticInput(ptyProcess, fullCommand);
    }
    noteLaunch(ptyProcess, launched);

    // Save updated status
    saveAgents();

    return { success: true };
  };
  /**
   * The launch, under way from its first line until its CLI runs in the
   * terminal (sessionStarting, core/agent-launch.ts): a restart kills the old
   * terminal, opens a new one, gives its shell half a second, then types. A
   * sender that lands in that time waits for the CLI rather than start a
   * session over it and lose the conversation.
   */
  const startAgentCli: AgentLauncher = async (id, prompt, options) => {
    const launch = launchBegins(id, { withTask: !!prompt?.trim() });
    try {
      const result = await launchInTerminal(id, prompt, options);
      if (!result.success) launchAbandoned(id, launch);
      return result;
    } catch (err) {
      launchAbandoned(id, launch);
      throw err;
    }
  };
  registerAgentLauncher(startAgentCli);

  ipcMain.handle('agent:start', async (_event, { id, prompt, options }: {
    id: string;
    prompt: string;
    options?: { model?: string; resume?: boolean; provider?: AgentProvider; localModel?: string }
  }) =>
    // What a window may choose, and nothing else: the session a restart
    // resumes lands on a command line, and the permission the Kanban
    // automation imposes is its own. Neither is taken from an IPC message.
    startAgentCli(id, prompt, {
      model: options?.model,
      provider: options?.provider,
      localModel: options?.localModel,
    }));

  // Get agent status
  ipcMain.handle('agent:get', async (_event, id: string) => {
    const agent = agents.get(id);
    if (!agent) return null;

    // Looking at an agent opens nothing. An agent with no terminal is shown
    // as one: nothing to replay, since what it kept is the tail of a terminal
    // gone with it, and no terminal named. This used to open a login shell,
    // whose banner went into the agent's output and read as its last words in
    // the Chat's fleet list; agent:start opens the terminal a launch needs.
    const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
    if (!ptyProcess) {
      return { ...agent, ptyId: undefined, output: [], cliRunning: false, leftFullscreen: false, launching: sessionStarting(agent), waitingOn: publishedWaitingOn(agent) };
    }
    // What a panel writes to show this agent: its terminal's screen as one
    // chunk, rather than the kept tail of the stream, which after a long turn
    // no longer held a frame. See core/terminal-mirror.ts. Taken last, with
    // nothing awaited after it, so no chunk can reach a panel between the
    // snapshot and this reply.
    const screen = terminalSnapshot(ptyProcess);
    return {
      ...agent,
      output: screen === undefined ? agent.output : [screen],
      cliRunning: cliRunningIn(ptyProcess),
      leftFullscreen: leftFullscreenIn(ptyProcess),
      launching: sessionStarting(agent), waitingOn: publishedWaitingOn(agent),
    };
  });

  // Get all agents
  ipcMain.handle('agent:list', async () => {
    // Without the scrollback. This runs on mount, after every create, start,
    // stop, remove and update, on every agent:complete and on every tick where
    // the count changed - serialising each agent's whole terminal history over
    // IPC each time. Whoever needs the output asks for that agent.
    // The branch and the model come from the working tree and the transcript
    // when they disagree with the record: the session is what happened, the
    // record is a note Tars made earlier. See services/agent-truth.ts.
    return Array.from(agents.values()).map(agent => withSessionTruth({
      ...agent,
      output: [],
      cliRunning: cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined),
      leftFullscreen: leftFullscreenIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined),
      launching: sessionStarting(agent), waitingOn: publishedWaitingOn(agent),
    }));
  });

  // Update an agent (supports all editable fields)
  ipcMain.handle('agent:update', async (_event, params: {
    id: string;
    projectPath?: string;
    skills?: string[];
    secondaryProjectPath?: string | null;
    permissionMode?: AgentPermissionMode;
    effort?: AgentEffort | null;
    name?: string;
    character?: AgentCharacter;
    model?: string | null;
    provider?: AgentProvider;
    localModel?: string | null;
    savedPrompt?: string | null;
    obsidianVaultPaths?: string[];
    worktree?: WorktreeConfig;
    /** The Orchestrator toggle. See core/agent-role.ts. */
    role?: AgentRole;
    /** The toggle's old name, read when `role` is absent. */
    orchestratorMode?: boolean;
    cliPath?: string | null;
  }) => {
    const agent = agents.get(params.id);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }
    let role: AgentRole | undefined;
    try {
      role = requestedRole(params);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Checked before any field changes: a refused edit changes nothing.
    if (params.skills !== undefined) {
      const skillsWrong = skillsProblem(params.skills);
      if (skillsWrong) return { success: false, error: `Not saved: ${skillsWrong}.` };
    }
    // What the running CLI was started with, as far as this edit can change it.
    const launchBefore = launchSettings(agent);

    // Update fields if provided
    if (params.projectPath !== undefined && params.projectPath !== agent.projectPath) {
      if (!fs.existsSync(params.projectPath)) {
        return { success: false, error: 'Project path does not exist' };
      }
      agent.projectPath = params.projectPath;
      agent.pathMissing = false;
      // The old worktree belongs to the previous repository. Detach it so the
      // agent works directly in the new project (a new worktree can be set up
      // via the worktree param below).
      agent.worktreePath = undefined;
      agent.branchName = undefined;
      // BUG 4: any live PTY still has the old repo as cwd.
      killStalePty(agent);
      agent.status = 'idle';
      agent.currentTask = undefined;
    }
    if (params.skills !== undefined) {
      agent.skills = params.skills;
    }
    if (params.secondaryProjectPath !== undefined) {
      if (params.secondaryProjectPath === null) {
        agent.secondaryProjectPath = undefined;
      } else if (fs.existsSync(params.secondaryProjectPath)) {
        agent.secondaryProjectPath = params.secondaryProjectPath;
      } else {
        return { success: false, error: 'Secondary project path does not exist' };
      }
    }
    if (params.permissionMode !== undefined) {
      agent.permissionMode = params.permissionMode;
    }
    if (params.effort !== undefined) {
      agent.effort = params.effort === null ? undefined : params.effort;
    }
    if (params.name !== undefined) {
      // Only the name: the role is the toggle's (core/agent-role.ts).
      agent.name = params.name;
    }
    if (params.character !== undefined) {
      agent.character = params.character;
    }
    if (params.model !== undefined) {
      agent.model = params.model === null ? undefined : params.model;
    }
    if (params.provider !== undefined) {
      if (params.provider !== agent.provider && agent.ptyId) {
        // The live PTY still carries the OLD provider's ANTHROPIC_* env.
        // Messages would silently route to the previous vendor. Kill it so
        // the next start/dispatch respawns with the new provider's env.
        const staleProviderPty = ptyProcesses.get(agent.ptyId);
        if (staleProviderPty) {
          staleProviderPty.kill();
          ptyProcesses.delete(agent.ptyId);
        }
        agent.ptyId = undefined;
        agent.ptyCwd = undefined;
        agent.status = 'idle';
        agent.currentTask = undefined;
      }
      agent.provider = params.provider;
    }
    if (params.localModel !== undefined) {
      agent.localModel = params.localModel === null ? undefined : params.localModel;
    }
    if (params.savedPrompt !== undefined) {
      agent.savedPrompt = params.savedPrompt === null ? undefined : params.savedPrompt;
    }
    if (params.obsidianVaultPaths !== undefined) {
      agent.obsidianVaultPaths = params.obsidianVaultPaths;
    }
    if (params.cliPath !== undefined) {
      const newCliPath = params.cliPath === null ? undefined : params.cliPath;
      if (newCliPath !== agent.cliPath && agent.ptyId) {
        // Same reasoning as a provider change: the running PTY was spawned
        // with the old binary.
        const staleCliPty = ptyProcesses.get(agent.ptyId);
        if (staleCliPty) {
          staleCliPty.kill();
          ptyProcesses.delete(agent.ptyId);
        }
        agent.ptyId = undefined;
        agent.ptyCwd = undefined;
        agent.status = 'idle';
        agent.currentTask = undefined;
      }
      agent.cliPath = newCliPath;
    }
    if (params.worktree !== undefined && !agent.worktreePath) {
      // Only allow worktree setup if agent doesn't already have one
      // (worktree changes on a running agent could be destructive)
      if (params.worktree.enabled && params.worktree.branchName) {
        const branchName = params.worktree.branchName;
        const worktreesDir = path.join(agent.projectPath, '.worktrees');
        const worktreePath = resolveWorktreePath(agent.projectPath, branchName);
        if (!worktreePath) {
          return { success: false, error: 'Invalid branch name' };
        }
        try {
          if (!fs.existsSync(worktreesDir)) {
            fs.mkdirSync(worktreesDir, { recursive: true });
          }
          if (!fs.existsSync(worktreePath)) {
            // argv, not a shell string: worktreePath comes from the project
            // path, so a quote or a space in it used to break the command (or
            // run its own). See the same fix in agent:create.
            const { execFileSync } = await import('child_process');
            try {
              execFileSync('git', ['rev-parse', '--verify', branchName], { cwd: agent.projectPath, stdio: 'pipe' });
              execFileSync('git', ['worktree', 'add', worktreePath, branchName], { cwd: agent.projectPath, stdio: 'pipe' });
            } catch {
              execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath], { cwd: agent.projectPath, stdio: 'pipe' });
            }
          }
          agent.worktreePath = worktreePath;
          agent.branchName = branchName;
          // BUG 4: the running PTY (if any) was spawned with cwd=projectPath.
          // It must be killed so the next agent:start respawns in the new
          // worktree directory. Otherwise writes leak into the main workspace.
          killStalePty(agent);
          agent.status = 'idle';
          agent.currentTask = undefined;
        } catch (err) {
          console.error('Failed to create worktree on update:', err);
          return { success: false, error: 'Failed to create git worktree' };
        }
      }
    }

    // Last, once the project is settled: an orchestrator, whether the toggle
    // was just switched on or it has just moved in, is its project's only one.
    const demoted = assignRole(agent, role ?? (agent.role === 'orchestrator' ? 'orchestrator' : 'worker'), agents.values());

    agent.lastActivity = new Date().toISOString();
    saveAgents();

    // A model, an effort or another flag the CLI only reads when it starts is
    // applied by restarting it, at a moment that cuts nothing: see
    // core/agent-restart.ts. Saving it used to change the record and leave the
    // CLI running on the old value until somebody relaunched it by hand. The
    // orchestrator this one replaced goes back to work as a worker the same way.
    const changedAtLaunch = changedLaunchSettings(launchBefore, launchSettings(agent));
    if (changedAtLaunch.length > 0) restartForSettings(agent.id, changedAtLaunch);
    for (const other of demoted) restartForSettings(other.id, ['orchestrator']);

    return { success: true, agent };
  });

  // Stop an agent
  ipcMain.handle('agent:stop', async (_event, id: string) => {
    const agent = agents.get(id);
    // A delegated run too, which has no terminal: an agent running only one
    // was not stopped at all (the Audit's table, #6).
    if (agent) await stopAcpRuns(agent.id, 'the agent was stopped');
    if (agent?.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
      agent.ptyId = undefined;
      agent.status = 'idle';
      agent.currentTask = undefined;
      // The killed session is a tombstone, exactly as the API's stop makes
      // it. Its hooks outlive the kill: SessionEnd posts `completed` under the
      // session id this agent still recorded as its owner, so the post passed
      // the stale check and put a stopped agent back to done. Only the owner
      // field moves; the refusal of posts from any other session is untouched.
      if (agent.currentSessionId) {
        agent.lastKilledSessionId = agent.currentSessionId;
      }
      agent.currentSessionId = undefined;
      agent.lastActivity = new Date().toISOString();
      // Mark as manually stopped to prevent status detection from overriding
      (agent as AgentStatus & { _manuallyStoppedAt?: number })._manuallyStoppedAt = Date.now();
      saveAgents();

      // Send status change notification to all windows
      broadcastToAllWindows('agent:status', {
        type: 'status',
        agentId: id,
        status: 'idle',
        timestamp: new Date().toISOString(),
      });
      scheduleTick();
    }
    return { success: true };
  });

  // Remove an agent
  /**
   * Which providers actually enforce orchestrator mode.
   *
   * Fourteen run the Claude binary and take --disallowed-tools, so for them
   * the tools are genuinely absent. The five CLIs with their own syntax have
   * no verified equivalent, and an orchestrator on those is guided by its
   * persona rather than restricted. The creation screen says so instead of
   * letting the switch imply something it cannot deliver.
   */
  ipcMain.handle('provider:orchestratorSupport', async () => {
    const out: Record<string, boolean> = {};
    for (const provider of getAllProviders()) {
      out[provider.id] = enforcesOrchestratorMode(provider.binaryName);
    }
    return out;
  });

  ipcMain.handle('agent:remove', async (_event, id: string) => {
    const agent = agents.get(id);
    if (agent) await stopAcpRuns(agent.id, 'the agent was deleted');
    if (agent?.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
      // Nullify so pending onExit callbacks won't mutate state
      agent.ptyId = undefined;
    }

    // Clean up worktree if it exists
    if (agent?.worktreePath && agent?.branchName) {
      try {
        // argv, not a shell string: an apostrophe in the project path used to
        // make this fail silently and leak a stale worktree behind the deleted
        // agent. See the same fix in agent:create.
        const { execFileSync } = await import('child_process');
        console.log(`Removing worktree at ${agent.worktreePath}`);
        execFileSync('git', ['worktree', 'remove', agent.worktreePath, '--force'], { cwd: agent.projectPath, stdio: 'pipe' });
        console.log(`Worktree removed successfully`);
      } catch (err) {
        console.warn(`Failed to remove worktree:`, err);
        // Continue even if worktree removal fails
      }
    }

    agents.delete(id);
    forgetRestart(id);

    // Save agents to disk
    saveAgents();

    return { success: true };
  });

  // Update agent's secondary project path
  ipcMain.handle('agent:setSecondaryProject', async (_event, { id, secondaryProjectPath }: { id: string; secondaryProjectPath: string | null }) => {
    const agent = agents.get(id);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    // Validate the path if provided
    if (secondaryProjectPath) {
      if (!fs.existsSync(secondaryProjectPath)) {
        return { success: false, error: 'Path does not exist' };
      }
      agent.secondaryProjectPath = secondaryProjectPath;
      console.log(`Set secondary project path for agent ${id}: ${secondaryProjectPath}`);
    } else {
      // Clear the secondary project path
      agent.secondaryProjectPath = undefined;
      console.log(`Cleared secondary project path for agent ${id}`);
    }

    // Save updated agents to disk
    saveAgents();

    return { success: true, agent };
  });

  // Send input to an agent
  ipcMain.handle('agent:input', async (_event, { id, input }: { id: string; input: string }) => {
    const agent = agents.get(id);
    if (agent?.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        try {
          // Not ptyProcess.write: this is the only place a person's keys
          // reach an agent, so it is the only place the field can be known,
          // and the only place a key can be held out of a write of Tars's
          // own. See writeHumanInput.
          writeHumanInput(ptyProcess, input);
          return { success: true };
        } catch (err) {
          console.error('Failed to write to PTY:', err);
          return { success: false, error: 'Failed to write to PTY' };
        }
      }
    }
    return { success: false, error: 'PTY not found' };
  });

  /**
   * Which agents are holding a message they cannot write into their terminal.
   *
   * The same state `agent:message-waiting` pushes, for a panel that opened
   * after the wait began: a push is only heard by a window that was already
   * listening, and a notice nobody sees is the thing this exists to prevent.
   * An agent absent from the list is holding nothing.
   */
  ipcMain.handle('agent:messagesWaiting', async () => ({ success: true, waiting: messagesWaiting() }));

  /**
   * The restarts waiting to apply a changed model, effort or other launch
   * setting, and what each waits on. The same state `agent:restart-pending`
   * pushes, for a window that opened after the wait began (core/agent-restart.ts).
   */
  ipcMain.handle('agent:pendingRestarts', async () => ({ success: true, pending: pendingRestarts() }));

  /**
   * Restart an agent's CLI now, continuing its conversation under a new
   * session id. What the Dashboard's `restart` calls; a stop then a start
   * begins a new conversation instead.
   */
  ipcMain.handle('agent:restart', async (_event, id: string) => restartAgent(id));

  // Resize agent PTY
  ipcMain.handle('agent:resize', async (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    // Kept even when there is no PTY to resize yet: the next one is spawned
    // at this size. See rememberPanelSize.
    if (!rememberPanelSize(id, cols, rows)) return { success: false, error: 'Invalid size' };
    const agent = agents.get(id);
    if (agent?.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        try {
          ptyProcess.resize(cols, rows);
          resizeTerminalMirror(ptyProcess, cols, rows);
          return { success: true };
        } catch (err) {
          console.error('Failed to resize PTY:', err);
          return { success: false, error: 'Failed to resize PTY' };
        }
      }
    }
    return { success: false, error: 'PTY not found' };
  });
}

// ============== Skills IPC Handlers ==============

function registerSkillHandlers(deps: IpcHandlerDependencies): void {
  const { skillPtyProcesses, getMainWindow } = deps;

  // Start skill installation (spawns npx directly: no login shell to avoid
  // users' zshrc/compdef issues breaking the install flow)
  ipcMain.handle('skill:install-start', async (_event, { repo, cols, rows }: { repo: string; cols?: number; rows?: number }) => {
    const id = uuidv4();

    // Parse repo to get the GitHub URL and skill name
    // Format: "owner/repo/skill-name" or "owner/repo" for full repo install
    const parts = repo.split('/');
    let npxArgs: string[];
    if (parts.length >= 3) {
      const repoPath = `${parts[0]}/${parts[1]}`;
      const skillName = parts.slice(2).join('/');
      npxArgs = ['skills', 'add', `https://github.com/${repoPath}`, '--skill', skillName];
    } else {
      npxArgs = ['skills', 'add', `https://github.com/${repo}`];
    }

    const fullPath = buildFullPath();
    const ptyProcess = pty.spawn('npx', npxArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: os.homedir(),
      env: { ...process.env, PATH: fullPath } as { [key: string]: string },
    });

    skillPtyProcesses.set(id, ptyProcess);

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      getMainWindow()?.webContents.send('skill:pty-data', { id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      getMainWindow()?.webContents.send('skill:pty-exit', { id, exitCode });
      skillPtyProcesses.delete(id);
    });

    return { id, repo };
  });

  // Write to skill installation PTY
  ipcMain.handle('skill:install-write', async (_event, { id, data }: { id: string; data: string }) => {
    const ptyProcess = skillPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.write(data);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Resize skill installation PTY
  ipcMain.handle('skill:install-resize', async (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const ptyProcess = skillPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Kill skill installation PTY
  ipcMain.handle('skill:install-kill', async (_event, { id }: { id: string }) => {
    const ptyProcess = skillPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.kill();
      skillPtyProcesses.delete(id);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Fetch skills marketplace from skills.sh (server-side to avoid CORS)
  // skills.sh, served from the last listing and refreshed behind it
  // (services/skills-marketplace.ts). `fetchedAt` says how old it is.
  ipcMain.handle('skill:fetch-marketplace', async () => marketplaceListing());

  // Legacy install (kept for backwards compatibility)
  ipcMain.handle('skill:install', async (_event, repo: string) => {
    // Just start the installation and return immediately
    // The actual interaction happens via skill:install-start
    return { success: true, message: 'Use skill:install-start for interactive installation' };
  });

  // Get installed skills from Claude config (backward compat: flat list)
  ipcMain.handle('skill:list-installed', async () => {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        // Skills are stored in enabledPlugins as "skill-name@source": true/false
        if (settings.enabledPlugins) {
          return Object.keys(settings.enabledPlugins)
            .filter(key => settings.enabledPlugins[key]) // Only enabled ones
            .map(key => key.split('@')[0]); // Extract skill name before @
        }
        return [];
      }
      return [];
    } catch {
      return [];
    }
  });

  // Get installed skills per provider
  ipcMain.handle('skill:list-installed-all', async () => {
    const providers = getAllProviders();
    const result: Record<string, string[]> = {};
    for (const p of providers) {
      result[p.id] = p.getInstalledSkills();
    }
    return result;
  });

  // Symlink a skill from Claude's skill dir to another provider's skill dir
  ipcMain.handle('skill:link-to-provider', async (_event, { skillName, providerId }: { skillName: string; providerId: string }) => {
    try {
      // Source: the first Claude skill dir that contains the skill
      const claudeProvider = getProvider('claude');
      let sourcePath: string | null = null;
      for (const dir of claudeProvider.getSkillDirectories()) {
        const candidate = path.join(dir, skillName);
        if (fs.existsSync(candidate)) {
          sourcePath = candidate;
          break;
        }
      }

      if (!sourcePath) {
        return { success: false, error: `Skill "${skillName}" not found in Claude skill directories` };
      }

      // getProvider falls back to Claude for an id it does not know (see
      // providers/index.ts), so an unrecognised string is safe rather than
      // needing to be proven a provider id first.
      const targetProvider = getProvider(providerId as AgentProvider);
      const targetDirs = targetProvider.getSkillDirectories();
      if (!targetDirs.length) {
        return { success: false, error: `Provider "${providerId}" has no skill directories` };
      }

      const targetDir = targetDirs[0];
      const targetPath = path.join(targetDir, skillName);

      // Skip if already exists
      if (fs.existsSync(targetPath)) {
        return { success: true };
      }

      // Ensure parent dir exists
      fs.mkdirSync(targetDir, { recursive: true });

      // Create symlink
      fs.symlinkSync(sourcePath, targetPath, 'dir');
      console.log(`Linked skill "${skillName}" to ${providerId} at ${targetPath}`);

      return { success: true };
    } catch (err) {
      console.error(`Failed to link skill "${skillName}" to ${providerId}:`, err);
      return { success: false, error: String(err) };
    }
  });
}

// ============== Plugin IPC Handlers ==============

function registerPluginHandlers(deps: IpcHandlerDependencies): void {
  const { pluginPtyProcesses, getMainWindow } = deps;

  // Start plugin installation (creates interactive PTY)
  // Start plugin installation (uses --no-rcs to skip shell rc files that may
  // contain broken completions like compdef from other tools)
  /**
   * Installing a plugin or a skill.
   *
   * This spawns a PTY, so the user can answer the CLI's prompts. What it will
   * not do is run an arbitrary string: the command has to be one of the shapes
   * an install actually takes, built from names the catalogue validated. It
   * used to accept anything, which made a marketplace entry a one-click way to
   * run code on this machine.
   */
  const INSTALL_SHAPES = [
    /^claude plugin marketplace add [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+( && claude plugin install [A-Za-z0-9._-]+@[A-Za-z0-9._-]+( -y)?)?$/,
    /^claude plugin install [A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?( -y)?$/,
    /^npx (-y )?skills add [A-Za-z0-9._\/-]+$/,
    /^\/plugin install [A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/,
    /^\/skill install [A-Za-z0-9._\/-]+$/,
  ];

  ipcMain.handle('plugin:install-start', async (_event, { command, cols, rows }: { command: string; cols?: number; rows?: number }) => {
    if (typeof command !== 'string' || !INSTALL_SHAPES.some(shape => shape.test(command.trim()))) {
      console.error('[plugin] refused an install command that is not an install:', command);
      return { error: 'That command is not an install and will not be run.' };
    }

    const id = uuidv4();
    const shell = defaultShell();

    // If the command starts with /, it's a Claude CLI slash command - prefix with 'claude'
    const finalCommand = command.startsWith('/') ? `claude "${command}"` : command;
    const fullPath = buildFullPath();

    // Use -c to run the command directly, skipping rc files to avoid
    // compdef/completion errors from the user's shell config
    const shellArgs = shell.endsWith('zsh')
      ? ['--no-rcs', '-c', finalCommand]
      : ['-c', finalCommand];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: os.homedir(),
      env: { ...process.env, PATH: fullPath } as { [key: string]: string },
    });

    pluginPtyProcesses.set(id, ptyProcess);

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      getMainWindow()?.webContents.send('plugin:pty-data', { id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      getMainWindow()?.webContents.send('plugin:pty-exit', { id, exitCode });
      pluginPtyProcesses.delete(id);
    });

    return { id };
  });

  // Write to plugin installation PTY
  ipcMain.handle('plugin:install-write', async (_event, { id, data }: { id: string; data: string }) => {
    const ptyProcess = pluginPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.write(data);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Resize plugin installation PTY
  ipcMain.handle('plugin:install-resize', async (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    const ptyProcess = pluginPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Kill plugin installation PTY
  ipcMain.handle('plugin:install-kill', async (_event, { id }: { id: string }) => {
    const ptyProcess = pluginPtyProcesses.get(id);
    if (ptyProcess) {
      ptyProcess.kill();
      pluginPtyProcesses.delete(id);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });
}

// ============== Claude Data IPC Handlers ==============

function registerClaudeDataHandlers(deps: IpcHandlerDependencies): void {
  const {
    getClaudeSettings,
    getClaudeStats,
    getClaudeProjects,
    getClaudePlugins,
    getClaudeSkills,
    getClaudeHistory
  } = deps;

  // Get all Claude data
  ipcMain.handle('claude:getData', async () => {
    try {
      const [settings, stats, projects, plugins, skills, history] = await Promise.all([
        getClaudeSettings(),
        getClaudeStats(),
        getClaudeProjects(),
        getClaudePlugins(),
        getClaudeSkills(),
        getClaudeHistory(50),
      ]);

      // Read rate limits from statusline cache file
      let rateLimits = null;
      try {
        const rateLimitsFile = dataPath('rate-limits.json');
        if (fs.existsSync(rateLimitsFile)) {
          rateLimits = JSON.parse(fs.readFileSync(rateLimitsFile, 'utf-8'));
        }
      } catch {
        // ignore parse errors
      }

      // Read accumulated token stats from statusline
      let tokenStats = null;
      try {
        const tokenStatsFile = dataPath('token-stats.json');
        if (fs.existsSync(tokenStatsFile)) {
          const raw = JSON.parse(fs.readFileSync(tokenStatsFile, 'utf-8'));
          // Sum all sessions
          let totalIn = 0, totalOut = 0, totalCost = 0, extraCost = 0;
          const modelTokens: Record<string, { in: number; out: number }> = {};
          const dailyCosts: Record<string, { cost: number; extraCost: number }> = {};
          const providerTotals: Record<string, { in: number; out: number; cost: number; sessions: number }> = {};
          for (const session of Object.values(raw) as Array<{ in: number; out: number; cost: number; model?: string; extra?: boolean; date?: string; provider?: string }>) {
            totalIn += session.in || 0;
            totalOut += session.out || 0;
            totalCost += session.cost || 0;
            if (session.extra) {
              extraCost += session.cost || 0;
            }
            if (session.model && session.model !== 'unknown') {
              if (!modelTokens[session.model]) {
                modelTokens[session.model] = { in: 0, out: 0 };
              }
              modelTokens[session.model].in += session.in || 0;
              modelTokens[session.model].out += session.out || 0;
            }
            if (session.date) {
              if (!dailyCosts[session.date]) {
                dailyCosts[session.date] = { cost: 0, extraCost: 0 };
              }
              dailyCosts[session.date].cost += session.cost || 0;
              if (session.extra) {
                dailyCosts[session.date].extraCost += session.cost || 0;
              }
            }
            // Per-provider breakdown (defaults legacy rows to 'claude')
            const providerKey = session.provider || 'claude';
            if (!providerTotals[providerKey]) {
              providerTotals[providerKey] = { in: 0, out: 0, cost: 0, sessions: 0 };
            }
            providerTotals[providerKey].in += session.in || 0;
            providerTotals[providerKey].out += session.out || 0;
            providerTotals[providerKey].cost += session.cost || 0;
            providerTotals[providerKey].sessions += 1;
          }
          tokenStats = {
            totalInputTokens: totalIn,
            totalOutputTokens: totalOut,
            totalCostUsd: totalCost,
            extraCostUsd: extraCost,
            sessionCount: Object.keys(raw).length,
            modelTokens,
            dailyCosts,
            providerTotals,
          };
        }
      } catch {
        // ignore parse errors
      }

      return {
        settings,
        stats,
        projects,
        plugins,
        skills,
        history,
        activeSessions: [],
        rateLimits,
        tokenStats,
      };
    } catch (err) {
      console.error('Failed to get Claude data:', err);
      return null;
    }
  });
}

// ============== Settings IPC Handlers ==============

/** A value that carries nothing: absent, or an empty object or list. */
function carriesNothing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** The same question for `permissions`, whose empty form is not an empty
 *  object but two empty lists. */
function permissionsCarryNothing(value: unknown): boolean {
  if (carriesNothing(value)) return true;
  const p = value as { allow?: unknown[]; deny?: unknown[] };
  return (p.allow?.length ?? 0) === 0 && (p.deny?.length ?? 0) === 0;
}

function registerSettingsHandlers(_deps: IpcHandlerDependencies): void {
  const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

  // Get Claude settings
  ipcMain.handle('settings:get', async () => {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) {
        return {
          enabledPlugins: {},
          env: {},
          hooks: {},
          includeCoAuthoredBy: false,
          permissions: { allow: [], deny: [] },
        };
      }
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    } catch (err) {
      console.error('Failed to read settings:', err);
      return null;
    }
  });

  // Save Claude settings
  ipcMain.handle('settings:save', async (_event, settings: {
    enabledPlugins?: Record<string, boolean>;
    env?: Record<string, string>;
    hooks?: Record<string, unknown>;
    includeCoAuthoredBy?: boolean;
    permissions?: { allow: string[]; deny: string[] };
  }) => {
    try {
      // Every claude binary reads this file, and Claude Code writes it too, so
      // it is changed through updateSharedJsonSync: never in place, with its
      // mode kept, and not written at all when the save changes nothing.
      const outcome = updateSharedJsonSync<Record<string, unknown>>(SETTINGS_PATH, existingSettings => {
        // The renderer sends its entire snapshot of this file, taken once when
        // the Settings page mounted and never refreshed (useSettings.ts fetches
        // on mount only). The window is created early in startup and Tars writes
        // the CLI hooks later in it, so a Settings page opened in between holds
        // `hooks: {}` and goes on holding it. A save made minutes later wrote
        // that empty block over the real one: measured at eight hooks before and
        // none after, taking `permissions`, `enabledPlugins` and
        // `includeCoAuthoredBy` with it. It is one file for all fourteen
        // providers that run the claude binary, and nothing would have restored
        // a status hook until the next launch of Tars.
        //
        // The guard belongs here rather than in the page because it has to hold
        // for whatever a renderer sends. The other half, sending only the delta,
        // is the page's, and it already does exactly that for the app's own
        // settings, with a comment in handleSaveAppSettings explaining why.
        const existing = existingSettings ?? {};
        const newSettings: Record<string, unknown> = { ...existing, ...settings };

        // Nothing that reaches this handler edits these two. The Settings page
        // has no control for either: hooks are Tars's own and plugins are the
        // CLI's, and both simply ride along in the snapshot. They can be lost
        // here, never meant, so the file keeps what it has.
        for (const key of ['hooks', 'enabledPlugins'] as const) {
          if (key in existing) newSettings[key] = existing[key];
        }

        // These two the page does edit, so an incoming value is taken as meant.
        // Unless it carries nothing at all while the file holds something, which
        // is the shape of a stale snapshot rather than of someone clearing a
        // field by hand.
        if (carriesNothing(settings.env) && !carriesNothing(existing.env)) {
          newSettings.env = existing.env;
        }
        if (permissionsCarryNothing(settings.permissions) && !permissionsCarryNothing(existing.permissions)) {
          newSettings.permissions = existing.permissions;
        }

        // `includeCoAuthoredBy` is left as sent, deliberately. It is a boolean
        // the page does edit, and a stale `false` is indistinguishable from a
        // deliberate one: there is no empty value to recognise. That one closes
        // when the page sends a delta instead of a snapshot, which is the half
        // that belongs to the Settings page.
        return newSettings;
      }, { createMode: 0o644 });

      if (outcome === 'unreadable') return { success: false, error: `${SETTINGS_PATH} is not valid JSON: left untouched` };
      if (outcome === 'busy') return { success: false, error: `${SETTINGS_PATH} kept changing while saving: nothing written` };
      return { success: true };
    } catch (err) {
      console.error('Failed to save settings:', err);
      return { success: false, error: String(err) };
    }
  });

  // Get Claude info (version, paths, etc.)
  ipcMain.handle('settings:getInfo', async () => {
    try {
      const { execSync } = await import('child_process');

      // Try to get Claude version
      let claudeVersion = 'Unknown';
      try {
        claudeVersion = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim();
      } catch {
        // Claude not installed or not in PATH
      }

      return {
        claudeVersion,
        configPath: path.join(os.homedir(), '.claude'),
        settingsPath: SETTINGS_PATH,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
      };
    } catch (err) {
      console.error('Failed to get info:', err);
      return null;
    }
  });
}

// ============== App Settings IPC Handlers (Notifications) ==============

function registerAppSettingsHandlers(deps: IpcHandlerDependencies): void {
  const {
    getMainWindow,
    getAppSettings,
    setAppSettings,
    saveAppSettings,
    initTelegramBot,
    initSlackBot,
    initDiscordBot,
    getTelegramBot,
    getSlackApp
  } = deps;

  // Get app settings (notifications, etc.)
  ipcMain.handle('app:getVersion', async () => {
    const { app } = await import('electron');
    return { version: app.getVersion() };
  });

  ipcMain.handle('app:getSettings', async () => {
    return getAppSettings();
  });

  // Live model + price catalogue. A new model or a price change lands here
  // without a release; the renderer never has to know where it came from.
  //
  // custom-openai is the one provider with no catalogue entry to serve
  // (see model-catalog.ts's PROVIDER_KEYS comment): a private or self-hosted
  // endpoint cannot be in a public catalogue, so its "model list" is whatever
  // the user typed into Settings, read straight from app settings instead.
  ipcMain.handle('models:list', async (_event, { provider }: { provider: string }) => {
    if (provider === 'custom-openai') {
      const model = getAppSettings().customOpenAIModel?.trim();
      return { models: model ? [{ id: model, name: model, description: 'Configured in Settings' }] : [] };
    }
    await loadCatalog();
    return { models: modelsForProvider(provider) };
  });

  ipcMain.handle('models:price', async (_event, { modelId, provider }: { modelId: string; provider?: string }) => {
    await loadCatalog();
    return { price: priceFor(modelId, provider) };
  });

  ipcMain.handle('models:catalog-status', async () => catalogStatus());

  // What an agent actually changed. Shell-free: git runs with an argv array,
  // so a branch or path with a quote in it is data rather than syntax.
  ipcMain.handle('review:diff', async (_event, { repoPath, baseBranch }: { repoPath: string; baseBranch?: string }) => {
    try {
      return { success: true as const, diff: await reviewDiff(repoPath, { baseBranch }) };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // One search across every agent's output, instead of opening 29 terminals.
  ipcMain.handle('logs:search', async (
    _event,
    { query, agentIds, projectPath, limit }: { query: string; agentIds?: string[]; projectPath?: string; limit?: number },
  ) => {
    if (!query?.trim()) return { lines: [], scannedAgents: 0, truncated: false };
    return searchLogs({ query, agentIds, projectPath, limit });
  });

  ipcMain.handle('logs:tail', async (_event, { agentId, lines }: { agentId: string; lines?: number }) => {
    return agentTail(agentId, lines) ?? { lines: [], agentName: '' };
  });

  ipcMain.handle('logs:fleet', async () => ({ agents: fleetSummary() }));

  // Spend from Tars's own ledger, and only from it: one row per ACP turn, any
  // provider. Claude's transcripts reach the page through claude:getData.
  // `daily` and `oldest` cover the whole file whatever sinceDays says, so the
  // page can cut the same window from them as from the transcripts' days.
  ipcMain.handle('usage:by-provider', async (_event, { sinceDays }: { sinceDays?: number } = {}) =>
    ledgerUsageByProvider(sinceDays));

  ipcMain.handle('review:repo', async (_event, { repoPath }: { repoPath: string }) => {
    try {
      return { success: true as const, summary: await repoSummary(repoPath) };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('review:file', async (
    _event,
    { repoPath, file, baseBranch }: { repoPath: string; file: string; baseBranch?: string },
  ) => {
    try {
      return { success: true as const, patch: await fileDiff(repoPath, file, baseBranch) };
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Memory: real status (each backend is probed, not inferred from settings)
  // and federated search across every configured source.
  ipcMain.handle('memory:sources', async (_event, { projectPath }: { projectPath?: string } = {}) => {
    const settings = getAppSettings() as never;
    return { sources: await memoryStatus({ settings, hermes: usableHermesConnection(), projectPath }) };
  });

  ipcMain.handle('memory:search', async (
    _event,
    { query, projectPath, sources, limit }: { query: string; projectPath?: string; sources?: string[]; limit?: number },
  ) => {
    if (!query?.trim()) return { hits: [], errors: [] };
    const settings = getAppSettings() as never;
    return searchMemory({
      query,
      projectPath,
      settings,
      hermes: usableHermesConnection(),
      sources: sources as never,
      limit,
    });
  });

  ipcMain.handle('models:refresh', async () => {
    await loadCatalog(true);
    return catalogStatus();
  });

  // Save app settings
  ipcMain.handle('app:saveSettings', async (_event, newSettings: Partial<AppSettings>) => {
    try {
      const telegramChanged = newSettings.telegramEnabled !== undefined ||
                              newSettings.telegramBotToken !== undefined;

      const slackChanged = newSettings.slackEnabled !== undefined ||
                           newSettings.slackBotToken !== undefined ||
                           newSettings.slackAppToken !== undefined;

      // Who it answers and the mention rule are read at each message: only a
      // new token, or switching it on or off, reconnects the bot.
      const discordChanged = newSettings.discordEnabled !== undefined ||
                             newSettings.discordBotToken !== undefined;

      const currentSettings = getAppSettings();
      const updatedSettings = { ...currentSettings, ...newSettings };
      setAppSettings(updatedSettings);
      saveAppSettings(updatedSettings);

      // Reinitialize Telegram bot if settings changed
      if (telegramChanged) {
        initTelegramBot();
      }

      // Reinitialize Slack bot if settings changed
      if (slackChanged) {
        initSlackBot();
      }

      if (discordChanged) {
        initDiscordBot();
      }

      // Re-sync shared memory backend MCP registrations when their settings change
      const memoryBackendsChanged = Object.keys(newSettings).some(k => k.startsWith('memoryGbrain') || k.startsWith('memoryHoncho'));
      if (memoryBackendsChanged) {
        const { setupMemoryBackends } = await import('../services/mcp-orchestrator');
        setupMemoryBackends(updatedSettings);
      }

      // Toggle Claude Code statusline
      if (newSettings.statusLineEnabled !== undefined) {
        const { enableStatusLine, disableStatusLine } = await import('../utils/statusline');
        if (newSettings.statusLineEnabled) {
          enableStatusLine();
        } else {
          disableStatusLine();
        }
      }

      return { success: true };
    } catch (err) {
      console.error('Failed to save app settings:', err);
      return { success: false, error: String(err) };
    }
  });

  // Test Telegram connection
  ipcMain.handle('telegram:test', async () => {
    const appSettings = getAppSettings();
    if (!appSettings.telegramBotToken) {
      return { success: false, error: 'No bot token configured' };
    }

    try {
      const testBot = new TelegramBot(appSettings.telegramBotToken);
      const me = await testBot.getMe();
      return { success: true, botName: me.username };
    } catch (err) {
      console.error('Telegram test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Send test message to Telegram
  ipcMain.handle('telegram:sendTest', async () => {
    const appSettings = getAppSettings();
    const telegramBot = getTelegramBot();

    // Use the first authorized chat ID, or fall back to legacy chatId
    const chatId = appSettings.telegramAuthorizedChatIds?.[0] || appSettings.telegramChatId;

    if (!telegramBot || !chatId) {
      return { success: false, error: 'Bot not connected or no authorized users. Authenticate with /auth <token> first.' };
    }

    try {
      await telegramBot.sendMessage(chatId, '✅ Test message from Tars!');
      return { success: true };
    } catch (err) {
      console.error('Telegram send test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Generate or regenerate Telegram auth token
  ipcMain.handle('telegram:generateAuthToken', async () => {
    const appSettings = getAppSettings();
    const newToken = crypto.randomBytes(16).toString('hex');

    appSettings.telegramAuthToken = newToken;
    saveAppSettings(appSettings);
    setAppSettings(appSettings);

    return { success: true, token: newToken };
  });

  // Remove an authorized Telegram chat ID
  ipcMain.handle('telegram:removeAuthorizedChatId', async (_event, chatId: string) => {
    const appSettings = getAppSettings();

    if (!appSettings.telegramAuthorizedChatIds) {
      return { success: false, error: 'No authorized chat IDs' };
    }

    appSettings.telegramAuthorizedChatIds = appSettings.telegramAuthorizedChatIds.filter(
      (id: string) => id !== chatId
    );

    // If removing the legacy chatId, clear it too
    if (appSettings.telegramChatId === chatId) {
      appSettings.telegramChatId = appSettings.telegramAuthorizedChatIds[0] || '';
    }

    saveAppSettings(appSettings);
    setAppSettings(appSettings);

    // Notify frontend of settings change
    const mainWindow = getMainWindow();
    mainWindow?.webContents.send('settings:updated', appSettings);

    return { success: true };
  });

  // Test X API credentials (OAuth 1.0a)
  ipcMain.handle('xapi:test', async () => {
    const appSettings = getAppSettings();
    if (!appSettings.xApiKey || !appSettings.xApiSecret || !appSettings.xAccessToken || !appSettings.xAccessTokenSecret) {
      return { success: false, error: 'All 4 X API credentials are required' };
    }

    try {
  
      // OAuth 1.0a signing for GET /2/users/me
      const method = 'GET';
      const url = 'https://api.x.com/2/users/me';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomBytes(16).toString('hex');

      const percentEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c: string) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

      const oauthParams: Record<string, string> = {
        oauth_consumer_key: appSettings.xApiKey,
        oauth_nonce: nonce,
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: timestamp,
        oauth_token: appSettings.xAccessToken,
        oauth_version: '1.0',
      };

      const paramString = Object.keys(oauthParams).sort()
        .map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`).join('&');
      const sigBase = `${method}&${percentEncode(url)}&${percentEncode(paramString)}`;
      const sigKey = `${percentEncode(appSettings.xApiSecret)}&${percentEncode(appSettings.xAccessTokenSecret)}`;
      const signature = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64');
      oauthParams['oauth_signature'] = signature;

      const authHeader = 'OAuth ' + Object.keys(oauthParams).sort()
        .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');

      const result = await new Promise<{ success: boolean; username?: string; error?: string }>((resolve) => {
        const req = https.request({
          hostname: 'api.x.com',
          port: 443,
          path: '/2/users/me',
          method: 'GET',
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        }, (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                resolve({ success: true, username: parsed.data?.username });
              } catch {
                resolve({ success: false, error: 'Invalid response' });
              }
            } else {
              resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
            }
          });
        });
        req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
        req.end();
      });
      return result;
    } catch (err) {
      console.error('X API test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Test SocialData API key
  ipcMain.handle('socialdata:test', async () => {
    const appSettings = getAppSettings();
    if (!appSettings.socialDataApiKey) {
      return { success: false, error: 'No API key configured' };
    }

    try {
      const result = await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
        const req = https.request({
          hostname: 'api.socialdata.tools',
          port: 443,
          path: '/twitter/user/elonmusk',
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${appSettings.socialDataApiKey}`,
            'Accept': 'application/json',
          },
        }, (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                resolve({ success: true, error: undefined });
              } catch {
                resolve({ success: false, error: 'Invalid response from API' });
              }
            } else if (res.statusCode === 402) {
              resolve({ success: false, error: 'Insufficient credits on your SocialData account' });
            } else {
              resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
            }
          });
        });
        req.on('error', (err: Error) => resolve({ success: false, error: err.message }));
        req.end();
      });
      return result;
    } catch (err) {
      console.error('SocialData test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Test Slack connection
  ipcMain.handle('slack:test', async () => {
    const appSettings = getAppSettings();
    if (!appSettings.slackBotToken || !appSettings.slackAppToken) {
      return { success: false, error: 'Bot token and App token are required' };
    }

    try {
      // Create a temporary Slack app to test the tokens
      const testApp = new SlackApp({
        token: appSettings.slackBotToken,
        appToken: appSettings.slackAppToken,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      });

      // Test auth
      const authResult = await testApp.client.auth.test();
      await testApp.stop();

      return { success: true, botName: authResult.user };
    } catch (err) {
      console.error('Slack test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // Send test message to Slack
  ipcMain.handle('slack:sendTest', async () => {
    const appSettings = getAppSettings();
    const slackApp = getSlackApp();

    if (!slackApp || !appSettings.slackChannelId) {
      return { success: false, error: 'Bot not connected or no channel ID. Mention the bot or DM it first.' };
    }

    try {
      await slackApp.client.chat.postMessage({
        channel: appSettings.slackChannelId,
        text: ':white_check_mark: Test message from Tars!',
        mrkdwn: true,
      });
      return { success: true };
    } catch (err) {
      console.error('Slack send test failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // ============== JIRA IPC Handlers ==============

  ipcMain.handle('jira:test', async () => {
    const appSettings = getAppSettings();
    if (!appSettings.jiraDomain || !appSettings.jiraEmail || !appSettings.jiraApiToken) {
      return { success: false, error: 'JIRA domain, email, and API token are all required' };
    }

    try {
      const auth = Buffer.from(`${appSettings.jiraEmail}:${appSettings.jiraApiToken}`).toString('base64');
      const jiraHost = normalizeJiraHost(appSettings.jiraDomain);
      const res = await fetch(`https://${jiraHost}/rest/api/3/myself`, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (res.ok) {
        const data = await res.json();
        return { success: true, displayName: data.displayName, email: data.emailAddress };
      } else {
        const text = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
    } catch (err) {
      console.error('JIRA test failed:', err);
      return { success: false, error: String(err) };
    }
  });
}

// ============== Update Checker IPC Handlers ==============

function registerUpdateHandlers(): void {
  ipcMain.handle('app:checkForUpdates', async () => {
    return checkForUpdates();
  });

  ipcMain.handle('app:downloadUpdate', async () => {
    return downloadUpdate();
  });

  ipcMain.handle('app:quitAndInstall', async () => quitAndInstall());

  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    shell.openExternal(url);
    return { success: true };
  });
}

// ============== File System IPC Handlers ==============

function registerFileSystemHandlers(deps: IpcHandlerDependencies): void {
  const { getMainWindow, agents, getClaudeSkills } = deps;

  ipcMain.handle('fs:list-projects', async () => {
    try {
      const claudeDir = path.join(os.homedir(), '.claude', 'projects');
      const projects: Array<{ id: string; path: string; name: string; custom?: boolean }> = [];
      const seen = new Set<string>();

      const push = async (p: string, id: string, custom = false) => {
        if (!p || p === '/' || p === os.homedir()) return;
        if (seen.has(p) || /\/\.?worktrees\//.test(p)) return;
        seen.add(p);
        if (!await fs.promises.access(p).then(() => true, () => false)) return;
        projects.push({ id, path: p, name: path.basename(p), ...(custom ? { custom: true } : {}) });
      };

      // Projects the user explicitly added (persisted here, not in the
      // renderer's localStorage, so they survive updates and are visible to
      // every surface: agent creation, team deployment, Brain).
      for (const p of readCustomProjects()) await push(p, `custom:${p}`, true);

      // Decoded once per folder, without blocking (services/project-index.ts).
      for (const folder of await projectFolders(claudeDir)) await push(folder.projectPath, folder.name);

      return projects;
    } catch (err) {
      console.error('Failed to list projects:', err);
      return [];
    }
  });

  /**
   * Reads well-known project files without a shell. The Brain graph used to
   * build `cat "<projectPath>/..."` command strings and hand them to
   * shell:exec: a path containing $(...) or a backtick executed arbitrary
   * code as soon as the page opened.
   */
  /** Roots a free-form file path is allowed to live under. */
  const textFileRoots = () => [
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.gemini'),
    path.join(os.homedir(), '.grok'),
    DATA_DIR,
    ...readCustomProjects(),
  ];

  const isAllowedTextFile = (target: string) => {
    const resolved = path.resolve(target.replace(/^~/, os.homedir()));
    return textFileRoots().some(root => resolved === root || resolved.startsWith(root + path.sep));
  };

  /**
   * Claude's own JSON files, which fs:write-text-file never writes although
   * `~/.claude` is one of its roots. It writes the text it is given, in place,
   * and every claude binary reads these as it starts: a half-written or
   * mistyped settings.json or mcp.json stops Claude Code. Tars changes them
   * through updateSharedJsonSync, and the one caller, the Brain page, edits
   * CLAUDE.md files. Compared through links, which the write would follow.
   */
  const isClaudeJsonFile = (target: string) => {
    const real = (file: string) => (fs.existsSync(file) ? fs.realpathSync(file) : file);
    return [
      path.join(os.homedir(), '.claude.json'),
      path.join(os.homedir(), '.claude', 'settings.json'),
      path.join(os.homedir(), '.claude', 'mcp.json'),
    ].some(file => real(file) === real(target));
  };

  ipcMain.handle('fs:read-text-file', async (_event, filePath: string) => {
    try {
      const target = path.resolve(String(filePath || '').replace(/^~/, os.homedir()));
      if (!isAllowedTextFile(target)) return { content: '', error: 'Path outside allowed roots' };
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { content: '', error: 'Not found' };
      return { content: fs.readFileSync(target, 'utf-8') };
    } catch (err) {
      return { content: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('fs:write-text-file', async (_event, params: { filePath: string; content: string }) => {
    try {
      const target = path.resolve(String(params?.filePath || '').replace(/^~/, os.homedir()));
      if (!isAllowedTextFile(target)) return { success: false, error: 'Path outside allowed roots' };
      if (isClaudeJsonFile(target)) return { success: false, error: `${path.basename(target)} is Claude Code's own file and is not written as text` };
      fs.writeFileSync(target, String(params?.content ?? ''), 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /**
   * Directories fs:read-project-files may read under: the CLI config dirs, the
   * projects the app itself knows about (added by hand, seen by Claude Code,
   * or attached to an agent) and the skill directories it enumerates.
   *
   * The handler used to accept any absolute base, unlike its confined siblings
   * fs:read-text-file/fs:write-text-file, so one call
   * (`{ paths: ['~/.ssh', '~/.dorothy'], relative: ['id_rsa', 'api-token'] }`)
   * turned it into a general file reader (neither `path.isAbsolute` nor
   * `!rel.includes('..')` says anything about where the base points).
   * DATA_DIR is deliberately not a root here: it holds api-token and
   * app-settings.json, and no caller of this channel reads from it.
   */
  const projectFileRoots = async (): Promise<string[]> => {
    const roots = [
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.codex'),
      path.join(os.homedir(), '.gemini'),
      path.join(os.homedir(), '.grok'),
      path.join(os.homedir(), '.agents'),
      ...readCustomProjects(),
    ];

    for (const agent of agents.values()) {
      if (agent.projectPath) roots.push(agent.projectPath);
      if (agent.worktreePath) roots.push(agent.worktreePath);
    }

    // Projects Claude Code has seen, same source as fs:list-projects.
    for (const folder of await projectFolders(path.join(os.homedir(), '.claude', 'projects'))) {
      roots.push(folder.projectPath);
    }

    // Skills can be symlinks out of ~/.claude/skills, so allow the real paths
    // the app resolved rather than only the directory they are linked from.
    try {
      for (const skill of await getClaudeSkills()) {
        if (skill?.path) roots.push(skill.path);
      }
    } catch { /* skills unreadable, skip */ }

    return roots
      .filter(r => typeof r === 'string' && r && path.isAbsolute(r))
      .map(r => path.resolve(r))
      .filter(r => r !== path.parse(r).root && r !== os.homedir());
  };

  ipcMain.handle('fs:read-project-files', async (_event, params: { paths: string[]; relative: string[] }) => {
    const out: Record<string, string> = {};
    const paths = Array.isArray(params?.paths) ? params.paths : [];
    const relative = Array.isArray(params?.relative) ? params.relative : [];
    const roots = await projectFileRoots();
    for (const base of paths) {
      if (typeof base !== 'string' || !path.isAbsolute(base)) continue;
      const resolvedBase = path.resolve(base);
      const allowed = roots.some(root => resolvedBase === root || resolvedBase.startsWith(root + path.sep));
      if (!allowed) continue;
      for (const rel of relative) {
        if (typeof rel !== 'string' || rel.includes('..')) continue;
        // Resolved containment, so an absolute or otherwise creative `rel`
        // cannot climb back out of the base the check above approved.
        const target = path.resolve(resolvedBase, rel);
        if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) continue;
        try {
          if (fs.existsSync(target) && fs.statSync(target).isFile()) {
            out[target] = fs.readFileSync(target, 'utf-8');
          }
        } catch { /* unreadable, skip */ }
      }
    }
    return { files: out };
  });

  ipcMain.handle('fs:add-custom-project', async (_event, projectPath: string) => {
    try {
      const clean = String(projectPath || '').trim();
      if (!clean || !fs.existsSync(clean)) return { success: false, error: 'Folder not found' };
      const list = readCustomProjects();
      if (!list.includes(clean)) {
        list.push(clean);
        writeCustomProjects(list);
      }
      return { success: true, projects: list };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('fs:remove-custom-project', async (_event, projectPath: string) => {
    try {
      const list = readCustomProjects().filter(p => p !== projectPath);
      writeCustomProjects(list);
      return { success: true, projects: list };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Open folder dialog
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openDirectory'],
    });
    return result.filePaths[0] || null;
  });

  // Open files dialog (for attachments)
  ipcMain.handle('dialog:open-files', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'] },
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'md'] },
      ],
    });
    return result.filePaths || [];
  });

  // Open audio file dialog (for notification sounds)
  ipcMain.handle('dialog:open-audio', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'] },
      ],
    });
    return result.filePaths[0] || null;
  });
}

// ============== Tasmania IPC Handlers ==============

function registerTasmaniaHandlers(deps: IpcHandlerDependencies): void {
  const { getAppSettings } = deps;

  // Import shared Tasmania client

  // Test: check MCP server exists + Control API reachable
  ipcMain.handle('tasmania:test', async () => {
    const appSettings = getAppSettings();
    const serverPath = appSettings.tasmaniaServerPath;
    const serverExists = serverPath ? fs.existsSync(serverPath) : false;

    let apiReachable = false;
    try {
      const res = await tasmaniaFetch('/api/status');
      apiReachable = res.ok;
    } catch {
      // API not reachable
    }

    return {
      success: serverExists && apiReachable,
      serverExists,
      apiReachable,
    };
  });

  // Get live server status from Control API
  ipcMain.handle('tasmania:getStatus', async () => {
    try {
      const res = await tasmaniaFetch('/api/status');
      if (!res.ok) {
        return { status: 'stopped' as const, backend: null, port: null, modelName: null, modelPath: null, endpoint: null, startedAt: null, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      return {
        status: data.status || 'stopped',
        backend: data.backend || null,
        port: data.port || null,
        modelName: data.modelName || null,
        modelPath: data.modelPath || null,
        endpoint: data.endpoint || null,
        startedAt: data.startedAt || null,
      };
    } catch {
      return { status: 'stopped' as const, backend: null, port: null, modelName: null, modelPath: null, endpoint: null, startedAt: null };
    }
  });

  // List available local models from Control API
  ipcMain.handle('tasmania:getModels', async () => {
    try {
      const res = await tasmaniaFetch('/api/models');
      if (!res.ok) {
        return { models: [], error: `HTTP ${res.status}` };
      }
      const models = await res.json();
      return { models: Array.isArray(models) ? models : [] };
    } catch (err) {
      return { models: [], error: String(err) };
    }
  });

  // Start a model via Control API
  ipcMain.handle('tasmania:loadModel', async (_event, modelPath: string) => {
    try {
      const res = await tasmaniaFetch('/api/start', {
        method: 'POST',
        body: JSON.stringify({ modelPath }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Stop running model via Control API
  ipcMain.handle('tasmania:stopModel', async () => {
    try {
      const res = await tasmaniaFetch('/api/stop', { method: 'POST' });
      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Check if Tasmania MCP is registered across all providers
  ipcMain.handle('tasmania:getMcpStatus', async () => {
    try {
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();
      const appSettings = getAppSettings();
      const expectedPath = appSettings.tasmaniaServerPath || '';

      // Check all providers: configured if registered in at least one
      let configured = false;
      for (const provider of providers) {
        try {
          if (provider.isMcpServerRegistered('tasmania', expectedPath)) {
            configured = true;
            break;
          }
        } catch {
          // Skip provider on error
        }
      }

      // Fallback: also check via claude mcp list if not found
      if (!configured) {
        try {
          const { exec } = await import('child_process');
          await new Promise<void>((resolve) => {
            exec('claude mcp list', { timeout: 3000 }, (_err, stdout) => {
              if (stdout) configured = stdout.includes('tasmania');
              resolve();
            });
          });
        } catch {
          // claude CLI not available
        }
      }

      return { configured };
    } catch (err) {
      return { configured: false, error: String(err) };
    }
  });

  // Register Tasmania MCP with all providers
  ipcMain.handle('tasmania:setup', async () => {
    try {
      const appSettings = getAppSettings();
      const serverPath = appSettings.tasmaniaServerPath;

      if (!serverPath) {
        return { success: false, error: 'MCP server path not configured. Set the path above first.' };
      }

      if (!fs.existsSync(serverPath)) {
        return { success: false, error: `MCP server not found at ${serverPath}` };
      }

      const command = serverPath.endsWith('.ts') ? 'npx' : 'node';
      const args = serverPath.endsWith('.ts') ? ['tsx', serverPath] : [serverPath];

      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();

      for (const provider of providers) {
        try {
          await provider.registerMcpServer('tasmania', command, args);
        } catch (err) {
          console.error(`[${provider.id}] Failed to register Tasmania:`, err);
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Remove Tasmania MCP from all providers
  ipcMain.handle('tasmania:remove', async () => {
    try {
      const { getAllProviders } = await import('../providers');
      const providers = getAllProviders();

      for (const provider of providers) {
        try {
          await provider.removeMcpServer('tasmania');
        } catch (err) {
          console.error(`[${provider.id}] Failed to remove Tasmania:`, err);
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}

// ============== Ollama IPC Handlers ==============

/** Ollama has no signup, no key, nothing to validate but "is it up". */
function registerOllamaHandlers(deps: IpcHandlerDependencies): void {
  const { getAppSettings } = deps;

  ipcMain.handle('ollama:test', async () => {
    const appSettings = getAppSettings();
    const base = (appSettings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    try {
      // /api/tags is Ollama's own lightweight "list local models" endpoint -
      // cheap to call and answers only when the server is actually up, unlike
      // pinging the Anthropic-compat surface which would need a real request.
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return { reachable: res.ok };
    } catch {
      return { reachable: false };
    }
  });
}

// ============== Shell IPC Handlers ==============

function registerShellHandlers(deps: IpcHandlerDependencies): void {
  const { quickPtyProcesses, getMainWindow } = deps;

  /**
   * Open a directory in a terminal: Terminal.app on macOS, the first one installed on Linux.
   *
   * This used to escape only single quotes in `cwd` and nothing at all in a
   * `command` parameter, then paste both into a double-quoted AppleScript
   * literal inside a shell string run through a login shell. A single double
   * quote in either value closed the literal and the rest was parsed as
   * AppleScript: a cwd of `/tmp/x" & (do shell script "id > /tmp/PWNED") & "`
   * ran its own shell command before Terminal was ever involved, and
   * `command` was a plain arbitrary-execution parameter: the primitive
   * shell:exec was removed for. Project paths come from ~/.dorothy/projects.json
   * and from folders the user picks, so a quote in one is not exotic.
   *
   * So: no shell (execFile with an argv array), no `command` parameter (no
   * caller supplies one), and the directory is escaped for both layers it
   * crosses: shell quoting for the `cd` that `do script` runs, then
   * AppleScript quoting for the string literal that holds it. On Linux, the
   * first terminal installed, the directory as its cwd (utils/open-terminal.ts).
   */
  ipcMain.handle('shell:open-terminal', async (_event, { cwd }: { cwd: string; command?: string }) => {
    // macOS through Terminal.app, Linux through the first terminal installed,
    // and a refusal elsewhere: utils/open-terminal.ts.
    const r = await openTerminal(String(cwd || ''));
    return r.success ? { success: true } : { success: false, error: r.error };
  });

  // Execute arbitrary command (uses PTY)
  /**
   * The renderer can ask for three things, by name.
   *
   * This used to take an arbitrary string and run it through a login shell,
   * which made every other sandbox in the app decorative: anything that ran in
   * the renderer had full user-privilege command execution. The three real
   * uses are asking a CLI its version, reading a repository's branch, and
   * revealing a path in Finder. So those are what it does now, through
   * execFile with an argv array, or through Electron's own shell API.
   */
  /**
   * Browsing a project, without a shell.
   *
   * The code panel used to build `find`, `cat` and `grep` command strings and
   * run them through a login shell, so a search query containing a quote was
   * command execution. These walk and read the tree directly, confined to the
   * project root.
   */
  const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', 'out', 'release', '.worktrees']);

  function withinRoot(root: string, target: string): boolean {
    const r = path.resolve(root);
    const t = path.resolve(target);
    return t === r || t.startsWith(r + path.sep);
  }

  function walkProject(root: string, maxDepth: number, limit: number, match?: (name: string) => boolean): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > maxDepth || out.length >= limit) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.length >= limit) return;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (!match || match(entry.name)) {
          out.push(path.relative(root, full));
        }
      }
    };
    walk(root, 1);
    return out.sort();
  }

  ipcMain.handle('project:list-files', async (_event, { root, maxDepth }: { root: string; maxDepth?: number }) => {
    if (!root || !fs.existsSync(root)) return { success: false as const, error: 'no such directory' };
    return { success: true as const, files: walkProject(root, Math.min(maxDepth ?? 3, 6), 300) };
  });

  ipcMain.handle('project:search-files', async (_event, { root, query }: { root: string; query: string }) => {
    if (!root || !fs.existsSync(root) || !query) return { success: false as const, error: 'root and query are required' };
    const needle = query.toLowerCase();
    return { success: true as const, files: walkProject(root, 6, 50, name => name.toLowerCase().includes(needle)) };
  });

  ipcMain.handle('project:search-content', async (
    _event,
    { root, query }: { root: string; query: string },
  ) => {
    if (!root || !fs.existsSync(root) || !query) return { success: false as const, error: 'root and query are required' };
    const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.md']);
    const needle = query.toLowerCase();
    const hits: { path: string; line: number; text: string }[] = [];

    for (const rel of walkProject(root, 6, 4000, name => exts.has(path.extname(name)))) {
      if (hits.length >= 50) break;
      const full = path.join(root, rel);
      if (!withinRoot(root, full)) continue;
      let content: string;
      try {
        if (fs.statSync(full).size > 512_000) continue;
        content = fs.readFileSync(full, 'utf-8');
      } catch { continue; }
      if (!content.toLowerCase().includes(needle)) continue;
      content.split('\n').forEach((text, i) => {
        if (hits.length >= 50) return;
        if (text.toLowerCase().includes(needle)) hits.push({ path: rel, line: i + 1, text: text.slice(0, 300) });
      });
    }
    return { success: true as const, hits };
  });

  ipcMain.handle('shell:version', async (_event, { binary }: { binary: string }) => {
    // A path from settings or a bare binary name, never an expression.
    if (!binary || /[;&|`$<>(){}\n\r"']/.test(binary)) {
      return { success: false, error: 'invalid binary' };
    }
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const { stdout, stderr } = await promisify(execFile)(binary, ['--version'], {
        timeout: 8000,
        env: { ...process.env, PATH: buildFullPath() },
      });
      return { success: true, output: (stdout || stderr || '').trim() };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('shell:branch', async (_event, { cwd }: { cwd: string }) => {
    if (!cwd || !fs.existsSync(cwd)) return { success: false, error: 'no such directory' };
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const { stdout } = await promisify(execFile)('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd, timeout: 8000,
      });
      return { success: true, output: stdout.trim() };
    } catch {
      return { success: false, error: 'not a git repository' };
    }
  });

  ipcMain.handle('shell:reveal', async (_event, { path: target }: { path: string }) => {
    if (!target || !fs.existsSync(target)) return { success: false, error: 'no such path' };
    const { shell } = await import('electron');
    const error = await shell.openPath(target);
    return error ? { success: false, error } : { success: true };
  });

  // Start a new quick terminal PTY
  ipcMain.handle('shell:startPty', async (_event, { cwd, cols, rows }: { cwd?: string; cols?: number; rows?: number }) => {
    const id = uuidv4();
    const shell = defaultShell();

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: process.env as { [key: string]: string },
    });

    quickPtyProcesses.set(id, ptyProcess);

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      getMainWindow()?.webContents.send('shell:ptyOutput', { ptyId: id, data });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      getMainWindow()?.webContents.send('shell:ptyExit', { ptyId: id, exitCode });
      quickPtyProcesses.delete(id);
    });

    return id;
  });

  // Write to quick terminal PTY
  ipcMain.handle('shell:writePty', async (_event, { ptyId, data }: { ptyId: string; data: string }) => {
    const ptyProcess = quickPtyProcesses.get(ptyId);
    if (ptyProcess) {
      ptyProcess.write(data);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Resize quick terminal PTY
  ipcMain.handle('shell:resizePty', async (_event, { ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }) => {
    const ptyProcess = quickPtyProcesses.get(ptyId);
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });

  // Kill quick terminal PTY
  ipcMain.handle('shell:killPty', async (_event, { ptyId }: { ptyId: string }) => {
    const ptyProcess = quickPtyProcesses.get(ptyId);
    if (ptyProcess) {
      ptyProcess.kill();
      quickPtyProcesses.delete(ptyId);
      return { success: true };
    }
    return { success: false, error: 'PTY not found' };
  });
}
