/**
 * Tars - Main Electron Entry Point
 *
 * This file initializes and wires together all the modular components:
 * - Window management and protocol handling
 * - Agent state and PTY management
 * - IPC handlers for renderer communication
 * - External services (Telegram, Slack, HTTP API)
 * - MCP orchestrator integration
 */

// First: every module required after it is compiled from the cache it keeps.
import './core/compile-cache';

import { startGithubWatch } from './services/github-watch';
import { onRelayReply, onRelayStatus, relayEnabled, relaySend, relayWasSent, startHermesRelay, tellUser } from './services/hermes-relay';
import { startRelayRouting } from './services/hermes-relay-routing';
import { settingsForRelay } from './services/hermes-relay-switch';
import { reportsOn } from './services/event-reports';
import { app, ipcMain } from 'electron';
import { endPermissionAsks } from './services/permission-asks';
import * as fs from 'fs';
import * as path from 'path';

// Types
import type { AppSettings, AgentStatus } from './types';

// Constants
import { APP_SETTINGS_FILE, API_TOKEN_FILE, DATA_DIR, KANBAN_FILE, PRIVATE_DIR, dataPath } from './constants';
import { timeIpcHandlers, startHealthMonitor, pageOf, ipcChannels } from './services/health/monitor';
import { readSamples, onlyKnown, type Vocabulary } from './services/health/samples';
import { APP_PAGES } from './services/health/pages';
import { abruptEndPayload } from './services/health/abrupt-end';
import { crashTypeSince } from './platform/crash-type';
import { registerDiagnosticHandlers } from './handlers/diagnostic-handlers';

// Core modules
import {
  createWindow,
  registerProtocolSchemes,
  setupProtocolHandler,
  getMainWindow,
  isDevBuild,
  revealMainWindow,
} from './core/window-manager';
import { claimSingleInstance, installDesktopShell } from './core/desktop-lifecycle';
import { linuxTrayShown } from './platform/linux-tray';

import {
  agents,
  loadAgents,
  saveAgents,
  initAgentPty,
  handleStatusChangeNotification,
  getSuperAgentOutputBuffer,
  clearSuperAgentOutputBuffer,
  superAgentTelegramTask,
} from './core/agent-manager';

import {
  ptyProcesses,
  quickPtyProcesses,
  skillPtyProcesses,
  pluginPtyProcesses,
  endAllTerminals,
  setFieldProbe,
} from './core/pty-manager';
import { startErrorReports } from './services/error-reports';
import { lastLocalCommandAt } from './services/agent-truth';

import { runShutdownSteps } from './core/shutdown';
import { initTray, destroyTray } from './core/tray-manager';
import { broadcastToAllWindows } from './utils/broadcast';

// Services
import { startApiServer } from './services/api-server';
import { startOpenAIBridgeServer, stopOpenAIBridgeServer } from './services/openai-bridge';
import {
  initTelegramBotService,
  initTelegramBot as initTelegramBotHandlers,
  getTelegramBot,
  sendTelegramMessage,
  sendSuperAgentResponseToTelegram,
} from './services/telegram-bot';
import {
  initSlackBot,
  getSlackApp,
  getSlackResponseChannel,
  getSlackResponseThreadTs,
} from './services/slack-bot';
import { initDiscordBot } from './services/discord-bot';
import { registerDiscordHandlers } from './handlers/discord-handlers';
import { announceAgentAccount, registerClaudeAccountsHandlers } from './handlers/claude-accounts-handlers';
import { setAccountEnvResolver } from './core/account-env';
import { claudeAccountEnvFor } from './services/claude-accounts/launch';
import { movedLaunch } from './services/claude-accounts/switching';
import { readAccountsSettings } from './services/claude-accounts/registry';
import { restartForSettings } from './core/agent-restart';
import {
  getClaudeSettings,
  getClaudeStats,
  getClaudeStatsNow,
  prewarmClaudeStats,
  getClaudeProjects,
  getClaudePlugins,
  getClaudeSkills,
  getClaudeHistory,
} from './services/claude-service';
import { configureStatusHooks, removeLegacyHookLogs } from './services/hooks-manager';
import { loadCatalog } from './services/model-catalog';
import { startAgentAutosave, stopAgentAutosave, wireDialogProbe, stopStatusNotifications } from './core/agent-manager';
import {
  setupMcpOrchestrator,
  setupMemoryBackends,
  registerMcpOrchestratorHandlers,
  getMcpOrchestratorPath,
} from './services/mcp-orchestrator';

// Handlers
import { registerIpcHandlers, IpcHandlerDependencies } from './handlers/ipc-handlers';
import { registerCLIPathsHandlers } from './handlers/cli-paths-handlers';
import { registerBusHandlers } from './handlers/bus-handlers';
import { registerChatHandlers } from './handlers/chat-handlers';
import { flushBus } from './services/bus-store';
import { registerVaultHandlers } from './handlers/vault-handlers';
import { registerTemplateHandlers } from './handlers/template-handlers';
import { registerTeamTemplateHandlers } from './handlers/team-template-handlers';
import { registerHermesHandlers } from './handlers/hermes-handlers';
import { registerOverseerHandlers } from './handlers/overseer-handlers';
import { startOverseerWatch, stopOverseerWatch, migrateOverseerOutOfAgentReach } from './services/overseer';
import { migrateWebhookSecretOutOfAgentReach } from './services/hermes-webhook-secret';
import { startAgentWatch, watchInterruptedTurns } from './services/agent-watch';
import { endRequestsAtLaunch, endUnresumed } from './core/task-requests';
import { startTaskWatch } from './services/task-watch';
import { beginRun, type PreviousRun } from './services/run-state';
import { endRestartRecovery, startRestartRecovery } from './services/restart-recovery';
import { startStallWatch, stopStallWatch } from './services/stall-watch';
import { startSleepWatch, stopSleepWatch } from './services/agent-sleep';
import { endUsageProbes } from './services/claude-accounts/usage-probe';
import { initVaultDb, closeVaultDb } from './services/vault-db';
import { initAutoUpdater, checkForUpdates, setMainWindowGetter } from './services/update-checker';
import { startCliUpdates } from './services/cli-updater';
import { migrateLocalTasks, setKanbanAgentDirectory } from './services/kanban-board';
import { hermesKanban, tellOrchestratorAsTars } from './services/api-routes/kanban-routes';
import { startErrorTriage, stopErrorTriage } from './services/error-triage';
import { sentryTokenOutOf, settingsToSave } from './services/sentry-token';
import { agentStatusEmitter } from './services/agent-events';
import { endAcpRunsOnQuit, agentsRunningOverAcp } from './services/acp/delegate';
import { retentionLog, startTmpRetention } from './services/agent-tmp';
import { writeSecretFileSync, ensureSecretFileMode, narrowDataDir, closeSecretsToOtherAccounts } from './utils/secret-file';
import { HERMES_CONNECTION_FILE } from './services/hermes-config';
import { restartRunnersOf } from './services/chat-runners';

// Utils
import {
  setMainWindow as setUtilsMainWindow,
  sendNotification,
  isSuperAgent,
  getSuperAgent,
  ensureDataDir,
  ensureAgentInstructions,
  migrateFromClaudeManager,
} from './utils';
import { endVersionProbes } from './core/version-probe';
import { endAuthCommands } from './services/claude-accounts/auth';

// ============== App Settings Management ==============

// A closed stdout/stderr pipe (e.g. the launching shell exited) must never
// crash the app: console.log would otherwise throw an uncaught EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

let appSettings: AppSettings = loadAppSettings();
let stopTmpRetention: () => void = () => undefined;
let previousRun: PreviousRun | null = null;
let recovery: { flush: () => void } | null = null;
// Off unless the user turned them on; followed live (services/error-reports).
// Every IPC handler registered from here on is timed for the health samples
// (services/health/monitor.ts): before any of them is registered.
timeIpcHandlers(ipcMain as unknown as Parameters<typeof timeIpcHandlers>[0]);

const errorReports = startErrorReports(() => appSettings.errorReportsEnabled === true);

/** The health samples, ~/.dorothy, on this machine only (services/health/samples.ts). */
const HEALTH_FILE = dataPath('health-samples.jsonl');
/** Every 5 minutes; a test run may ask for a shorter period (DOROTHY_HEALTH_EVERY_MS, under DOROTHY_E2E only). */
function healthEveryMs(): number {
  const asked = Number(process.env.DOROTHY_HEALTH_EVERY_MS);
  return process.env.DOROTHY_E2E === '1' && Number.isFinite(asked) && asked >= 200 ? asked : 5 * 60_000;
}

function loadAppSettings(): AppSettings {
  const defaults: AppSettings = {
    notificationsEnabled: true,
    notifyOnWaiting: true,
    notifyOnComplete: true,
    notifyOnStop: true,
    notifyOnError: true,
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramAuthToken: '',
    telegramAuthorizedChatIds: [],
    telegramRequireMention: false,
    hermesRelayEnabled: false,
    slackEnabled: false,
    slackBotToken: '',
    slackAppToken: '',
    slackSigningSecret: '',
    slackChannelId: '',
    slackAllowedUserIds: [],
    discordEnabled: false,
    discordBotToken: '',
    discordChannelId: '',
    discordAllowedUserIds: [],
    discordRequireMention: true,
    errorReportsEnabled: false,
    sentryAuthToken: '',
    sentryTriageProject: '',
    jiraEnabled: false,
    jiraDomain: '',
    jiraEmail: '',
    jiraApiToken: '',
    socialDataEnabled: false,
    socialDataApiKey: '',
    xPostingEnabled: false,
    xApiKey: '',
    xApiSecret: '',
    xAccessToken: '',
    xAccessTokenSecret: '',
    tasmaniaEnabled: false,
    tasmaniaServerPath: '',
    gwsEnabled: false,
    gwsSkillsInstalled: false,
    verboseModeEnabled: false,
    // statusLineEnabled is deliberately absent. It used to default to false,
    // two lines above a check reading `!== false` and a comment saying it
    // defaults to true for new users, so for everyone who had never touched
    // the switch the app took the disable branch on every launch and deleted
    // `statusLine` out of ~/.claude/settings.json. Absent means unchosen, and
    // unchosen means Tars leaves that file alone.
    chromeEnabled: false,
    autoCheckUpdates: true,
    autoStartAgentsOnLaunch: true,
    newInterface: false,
    chatsReadEachOther: false,
    opencodeEnabled: false,
    opencodeDefaultModel: '',
    ampEnabled: false,
    ampDefaultModel: '',
    defaultProvider: 'claude',
    cliPaths: {
      amp: '',
      claude: '',
      codex: '',
      gemini: '',
      grok: '',
      qwencode: '',
      opencode: '',
      pi: '',
      gws: '',
      gcloud: '',
      gh: '',
      node: '',
      minimax: '',
      additionalPaths: [],
    },
  };
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      // The Sentry token is kept in ~/.tars-private (services/sentry-token.ts).
      // The switch is on only for the boolean true: the file is in ~/.dorothy,
      // which every agent can write, and "false" or 1 would read as on to a
      // page that tests it for truth (the Audit's L1 on #360).
      return { ...defaults, ...sentryTokenOutOf(saved), newInterface: saved.newInterface === true, chatsReadEachOther: saved.chatsReadEachOther === true };
    }
  } catch (err) {
    console.error('Failed to load app settings:', err);
  }
  return { ...defaults, ...sentryTokenOutOf({}) };
}

function saveAppSettingsToFile(settings: AppSettings) {
  try {
    ensureDataDir();
    // 0600 and atomic: this file carries every provider API key, the Hermes
    // gateway token and the memory-backend credentials.
    // Everything but the Sentry token, which goes to ~/.tars-private.
    writeSecretFileSync(APP_SETTINGS_FILE, JSON.stringify(settingsToSave(settings), null, 2));
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}

// ============== Telegram Bot Initialization ==============

function initTelegramBot() {
  // First inject dependencies into the Telegram bot service
  initTelegramBotService(
    agents,
    ptyProcesses,
    // Live: a save replaces this object, and the bot must see the new one.
    () => appSettings,
    getMainWindow(),
    () => getSuperAgent(agents),
    saveAgents,
    getClaudeStats,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    saveAppSettingsToFile
  );

  // Then initialize the bot with handlers
  initTelegramBotHandlers();
}

// ============== Notification Handler Wrapper ==============

function handleStatusChangeNotificationWrapper(agent: AgentStatus, newStatus: string) {
  handleStatusChangeNotification(
    agent,
    newStatus,
    appSettings,
    sendNotification,
    (text: string) => sendTelegramMessage(text),
    sendSuperAgentResponseToTelegram
  );
}

// ============== IPC Handler Dependencies ==============

function createIpcDependencies(): IpcHandlerDependencies {
  return {
    // State
    ptyProcesses,
    agents,
    skillPtyProcesses,
    quickPtyProcesses,
    pluginPtyProcesses,

    // Functions
    getMainWindow,
    getAppSettings: () => appSettings,
    setAppSettings: (settings: AppSettings) => { appSettings = settings; void errorReports.sync(); },
    saveAppSettings: saveAppSettingsToFile,
    saveAgents,
    initAgentPty: (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    handleStatusChangeNotification: handleStatusChangeNotificationWrapper,
    isSuperAgent,
    getMcpOrchestratorPath,
    initTelegramBot,
    initSlackBot: () => initSlackBot(() => appSettings, (settings) => {
      appSettings = settings;
      saveAppSettingsToFile(settings);
    }, getMainWindow()),
    initDiscordBot: startDiscordBot,
    getTelegramBot,
    getSlackApp,
    getSuperAgentTelegramTask: () => {
      // Read at call time, not at wire-up time: this is a mutable module
      // binding, and TypeScript's CommonJS output dereferences it on each
      // access, so the import gives the current value the require gave.
      return superAgentTelegramTask;
    },
    getSuperAgentOutputBuffer,
    setSuperAgentOutputBuffer: (buffer: string[]) => {
      // This is handled internally by agent-manager
      clearSuperAgentOutputBuffer();
      buffer.forEach(item => getSuperAgentOutputBuffer().push(item));
    },

    // Claude data functions. The page's stats come at once, as last computed,
    // and are computed again behind it once a minute old; the bots keep
    // getClaudeStats, which waits for numbers no older than that.
    getClaudeSettings,
    getClaudeStats: getClaudeStatsNow,
    getClaudeProjects,
    getClaudePlugins,
    getClaudeSkills,
    getClaudeHistory,
  };
}

/** The Discord bot on the settings as they are now; the channel it detects is saved like Slack's. */
function startDiscordBot() {
  initDiscordBot(() => appSettings, (settings) => {
    appSettings = settings;
    saveAppSettingsToFile(settings);
  }, getMainWindow());
}

// ============== API Server Initialization ==============

function initApiServer() {
  startApiServer(
    getMainWindow(),
    appSettings,
    getTelegramBot,
    getSlackApp,
    getSlackResponseChannel(),
    getSlackResponseThreadTs(),
    handleStatusChangeNotificationWrapper,
    sendNotification,
    (agent: AgentStatus) => initAgentPty(
      agent,
      getMainWindow(),
      handleStatusChangeNotificationWrapper,
      saveAgents
    ),
    () => appSettings
  );
  // Loopback-only, always on: it is a no-op until a Venice or custom-vendor
  // agent's PTY is spawned with the bridge's URL baked into ANTHROPIC_BASE_URL.
  // See services/openai-bridge.ts for why this cannot just be another /api/*
  // route, and for the addressing scheme that lets one server serve both.
  startOpenAIBridgeServer();
  moveLocalKanbanToHermes();
  // Sentry's new errors, as parked tasks on the board of the project named in
  // Settings, told to its orchestrator. Does nothing until the token, the
  // project, error reports and Hermes are all there (services/error-triage.ts).
  startErrorTriage({
    settings: () => appSettings, hermes: hermesKanban, tell: tellOrchestratorAsTars,
    relay: { enabled: relayEnabled, send: relaySend, wasSent: relayWasSent, onReply: onRelayReply, tellUser },
    onFleetChange: listener => agentStatusEmitter.on('fleet-change', listener),
  });
}

/**
 * The agents' kanban is the Hermes board now (services/kanban-board.ts). The
 * open tasks of the old local board, which no page shows, move there once,
 * parked, on their project; ~/.dorothy/kanban-tasks.json stays as it is, the
 * backup. Whatever Hermes did not take is tried again at the next launch.
 */
function moveLocalKanbanToHermes() {
  setKanbanAgentDirectory(id => agents.get(id));
  const hermes = hermesKanban();
  if (!hermes) return;
  if ('unusable' in hermes) {
    console.warn(`[kanban] local board not moved to Hermes: ${hermes.unusable}`);
    return;
  }
  void migrateLocalTasks(hermes, KANBAN_FILE, path.join(DATA_DIR, 'kanban-moved-to-hermes.json')).then(r => {
    if (r.moved || r.errors.length) {
      console.log(`[kanban] local board to Hermes: ${r.moved} moved, ${r.skipped} already there${r.errors.length ? `, ${r.errors.length} left for the next launch: ${r.errors.join('; ')}` : ''}`);
    }
  }, err => console.warn('[kanban] local board to Hermes: not attempted:', err));
}

// ============== App Initialization ==============

// One Tars per profile, on every platform. A second launch shows the first
// one's window and ends here: it has read app-settings.json and nothing else,
// and it writes nothing and starts nothing.
const isPrimaryInstance = claimSingleInstance(showMainWindow);
if (!isPrimaryInstance) app.exit(0);

// Register protocol schemes before app is ready
registerProtocolSchemes();

/** How often the app looks for a new version while it is running. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  console.log('App ready, initializing...');

  // Ensure data directory exists
  ensureDataDir();

  // Narrow the credential files on installs that predate the 0600 write.
  // A `mode` passed to writeFileSync only applies at creation, so an
  // app-settings.json already sitting at 0644 would keep it forever.
  for (const secret of [APP_SETTINGS_FILE, HERMES_CONNECTION_FILE, API_TOKEN_FILE, HEALTH_FILE]) {
    ensureSecretFileMode(secret);
  }
  // And the directory itself with everything in it: the fleet, the board, the
  // ledger and the vault were readable by every account on the machine.
  narrowDataDir(DATA_DIR);

  // Take JeanBrasse's conversation with the super chat out of ~/.dorothy, which is
  // the directory every agent is handed. Here rather than on the first read of
  // it: a run in which the Chat is never opened would otherwise leave the file
  // sitting there for its whole length.
  migrateOverseerOutOfAgentReach();
  // And the Hermes webhook secret, for the same reason: through the webhook it
  // gives any agent of any project work, and ~/.dorothy is one `cat` away.
  migrateWebhookSecretOutOfAgentReach();
  // Windows: the modes above do nothing there; an access list does the same,
  // set in the background (it never rejects, each failure is logged).
  // The health samples too: the privacy page says they are readable by the
  // user's account only.
  void closeSecretsToOtherAccounts([APP_SETTINGS_FILE, HERMES_CONNECTION_FILE, API_TOKEN_FILE, HEALTH_FILE], PRIVATE_DIR);

  // Write Tars's CLAUDE.md to ~/.dorothy/ so all spawned agents can load it
  ensureAgentInstructions();

  // Install/update statusline script if enabled (ensures script is always up-to-date after app updates)
  // statusLineEnabled defaults to true for new users
  try {
    const { enableStatusLine, disableStatusLine } = await import('./utils/statusline');
    // Only an explicit choice acts here. This runs on every launch and is not
    // a user action: it exists to refresh the script after an update. Reading
    // an absent setting as "off" turned that refresh into a deletion in
    // another program's configuration file, once per launch, for anyone who
    // had never opened that switch.
    if (appSettings.statusLineEnabled === true) {
      enableStatusLine();
    } else if (appSettings.statusLineEnabled === false) {
      disableStatusLine();
    }
  } catch {
    // ignore statusline errors on startup
  }

  // Migrate data from ~/.claude-manager if it exists (rebrand migration)
  migrateFromClaudeManager();

  // Load agents from disk
  loadAgents();
  // Whether the last run stopped abruptly, and who was working then, read
  // before this run's record replaces it (services/run-state.ts).
  previousRun = beginRun({ appVersion: app.getVersion() });
  // A run that did not quit is reported once, at this launch, when error
  // reports are on (services/health/abrupt-end.ts): its samples are read here,
  // before this run's first, and sent once every handler is registered, below.
  const lastRunSamples = previousRun ? readSamples(HEALTH_FILE) : [];
  // What leaves names only the channels this Tars registered and the app's
  // pages: the samples file is in ~/.dorothy, which agents may write.
  const healthWords: Vocabulary = { channels: ipcChannels.known(), pages: APP_PAGES };
  startHealthMonitor({
    file: HEALTH_FILE,
    everyMs: healthEveryMs(),
    agents: () => ({ total: agents.size, running: [...agents.values()].filter((a) => a.status === 'running').length }),
    page: () => pageOf(getMainWindow()?.webContents.getURL()),
  });
  registerDiagnosticHandlers({ reports: errorReports, samplesFile: HEALTH_FILE, known: healthWords });
  // Bound how much a crash can lose: PTY-driven fields reach disk on a timer.
  startAgentAutosave();

  // Setup protocol handler for production
  setupProtocolHandler();

  // Create the main window
  createWindow();
  // Windows and Linux: no menu, close to the tray; Windows: toasts and the
  // session end (desktop-lifecycle.ts). Linux hides on close only once the
  // session bus says a tray is shown, asked here in the background: until it
  // answers, a close closes, as before.
  let linuxTray = false;
  if (process.platform === 'linux') void linuxTrayShown().then((shown) => { linuxTray = shown; });
  installDesktopShell({
    getMainWindow,
    trayShown: () => linuxTray,
    explanation: {
      explained: () => appSettings.closeToTrayExplained === true,
      markExplained: () => {
        appSettings = { ...appSettings, closeToTrayExplained: true };
        saveAppSettingsToFile(appSettings);
      },
    },
  });

  // Set the main window reference in utils
  setUtilsMainWindow(getMainWindow());

  // Initialize macOS menu bar tray with custom popup panel
  initTray();

  // Register all IPC handlers
  const deps = createIpcDependencies();
  registerIpcHandlers(deps);
  registerMcpOrchestratorHandlers();
  registerCLIPathsHandlers({
    getAppSettings: () => appSettings,
    setAppSettings: (settings) => { appSettings = settings; void errorReports.sync(); },
    saveAppSettings: saveAppSettingsToFile,
  });

  // Register agent template handlers (no deps, self-contained)
  registerTemplateHandlers();
  registerTeamTemplateHandlers();
  registerHermesHandlers();
  registerDiscordHandlers({ getAppSettings: () => appSettings });
  const claudeAccounts = registerClaudeAccountsHandlers({
    getAppSettings: () => appSettings,
    agents,
    saveAgents,
    loginPtys: pluginPtyProcesses,
    onAgentAccountChanged: (agentId) => {
      restartForSettings(agentId, ['claudeAccount']);
      // An orchestrator's chats run on its account too: each runner takes it (the Audit's L3 on #379).
      restartRunnersOf(agentId, ['claudeAccount']);
    },
  });
  // Back from a terminal where a login may have changed a sign-in: Settings
  // shows what Claude Code says now (handlers/claude-accounts-handlers.ts).
  app.on('browser-window-focus', () => claudeAccounts.whenShown());
  // Every agent process asks which Claude account it starts on. With the
  // option off the answer is null and nothing changes (core/account-env.ts).
  setAccountEnvResolver((agentId, cwd, purpose) => {
    const agent = agents.get(agentId);
    if (!agent) return null;
    const before = agent.claudeAccountId;
    const env = claudeAccountEnvFor(agent, { agents: agents.values(), cwd, purpose });
    // A move Tars asked for (services/claude-accounts/switching.ts), made by this launch.
    if (env?.move) movedLaunch(agent, env.move);
    // Every window shows the account an agent runs on.
    if (agent.claudeAccountId !== before) announceAgentAccount(agent);
    return env;
  });
  // Which accounts are signed in, asked of Claude Code before the first
  // launches need it; until it answers, only account 1 is used.
  if (readAccountsSettings().enabled) void claudeAccounts.refreshAll();
  registerOverseerHandlers();
  registerBusHandlers();
  // The chats' records, and the migration that makes each project's
  // orchestrator's conversation its chat #1, Main (handlers/chat-handlers.ts).
  registerChatHandlers({ agents, chatsShown: () => appSettings.newInterface === true });

  // The overseer's watch timer: an unprompted briefing reaches the Chat page
  // through the same broadcast channel every other live update uses.
  startOverseerWatch((message) => broadcastToAllWindows('overseer:briefing', message));

  // Initialize vault database
  initVaultDb();

  // Register vault handlers
  registerVaultHandlers({ getMainWindow });


  // The relay to the user's Telegram through their Hermes, following its switch
  // live (services/hermes-relay.ts). On, it is the only voice there: the Tars
  // bot's token is gone and the bot stays off (hermes-relay-switch.ts).
  const forRelay = settingsForRelay(appSettings);
  if (forRelay !== appSettings) {
    appSettings = forRelay;
    saveAppSettingsToFile(forRelay);
  }
  startHermesRelay({ enabled: () => appSettings.hermesRelayEnabled === true });
  startRelayRouting({
    agents, ptyProcesses, settings: () => appSettings, saveAgents,
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, getMainWindow(), handleStatusChangeNotificationWrapper, saveAgents),
  });
  onRelayStatus(status => broadcastToAllWindows('hermes:relay:status', status));

  // Initialize services
  initTelegramBot();
  initSlackBot(() => appSettings, (settings) => {
    appSettings = settings;
    saveAppSettingsToFile(settings);
  }, getMainWindow());
  startDiscordBot();
  initApiServer();
  // Delegation reports back on its own from here: an agent that finishes tells
  // whoever dispatched it, without the orchestrator having to ask.
  // What the last run owed, its waiting room messages, the run record, and,
  // after an abrupt stop, the agents that were working resumed with a note
  // (services/restart-recovery.ts). After the launcher and the API are up.
  // The abrupt end of the last run: its version, uptime, the OS's crash type,
  // its last health sample, now that every handler is registered.
  if (previousRun) {
    const samples = lastRunSamples.map((s) => onlyKnown(s, healthWords));
    const payload = abruptEndPayload(previousRun, samples, crashTypeSince(previousRun.startedAt));
    void errorReports.sendHealth('abrupt-end', payload as unknown as Record<string, unknown>).then((result) => {
      if (!result.sent) console.log(`[health] the abrupt end of the last run was not reported: ${result.reason}`);
    });
  }
  const restarted = startRestartRecovery(previousRun);
  recovery = restarted;
  startAgentWatch();
  // Requests still out from the run before: what was queued or typed into a
  // terminal that is gone never ran, and each requester is told (the Audit's
  // R3). The one in hand stays only for a worker the resume restarts (after an
  // abrupt stop); after a clean quit it is ended too (the Audit's M1).
  endRequestsAtLaunch(agents.values(), new Set(previousRun && !previousRun.resumedAndCrashedAgain
    ? previousRun.working.map((w) => w.agentId) : []));
  saveAgents();
  // And once the resume has run, the work in hand of each worker it did not
  // relaunch (deleted, stopped or whose folder is gone since, a launch that
  // failed) is ended and told: kept until then, it waited on an end that
  // never came (the Audit's Low on #351).
  void restarted.resumed.then((outcomes) => {
    endUnresumed(agents.values(), outcomes);
    saveAgents();
  });
  // The tasks the Usage page prices: who handed what, from turn to rest
  // (services/task-ledger.ts).
  startTaskWatch();
  // And an agent that reads running while it does nothing is told to whoever
  // handed it the work (services/stall-watch.ts).
  startStallWatch();
  // Agents with no turn for 30 minutes sleep, orchestrators never (services/agent-sleep.ts).
  startSleepWatch();
  // Each agent's temporary folder, which a boot does not empty, kept to 7 days
  // and 20 GB in all (services/agent-tmp.ts). A development run may bring the
  // first pass forward, for the e2e.
  const firstRetentionMs = !app.isPackaged ? Number(process.env.DOROTHY_TMP_RETENTION_FIRST_MS) || undefined : undefined;
  stopTmpRetention = startTmpRetention({
    liveAgentIds: () => [
      ...[...agents.values()].filter(a => !!a.ptyId && ptyProcesses.has(a.ptyId)).map(a => a.id),
      ...agentsRunningOverAcp(),
    ],
    knownAgentIds: () => [...agents.keys()],
    sessionsOf: (id) => {
      const a = agents.get(id);
      return [a?.currentSessionId, a?.resumableSessionId].filter((s): s is string => !!s);
    },
    freeBytes: () => {
      try {
        const st = fs.statfsSync(DATA_DIR);
        return st.bavail * st.bsize;
      } catch {
        return null;
      }
    },
    log: retentionLog,
  }, { firstMs: firstRetentionMs });
  // A message held behind a slash command typed by hand goes in once the
  // command's record says the field emptied (core/pty-manager.ts).
  setFieldProbe(agentId => {
    const agent = agents.get(agentId);
    return agent ? lastLocalCommandAt(agent) : undefined;
  });
  // And nothing is typed into a dialog its CLI shows: a permission, an
  // AskUserQuestion. Its Enter would answer it (the Audit, 2026-09-24).
  wireDialogProbe();
  // And a turn ended by Esc, which sends no hook, ends here from the transcript.
  watchInterruptedTurns();

  // Setup MCP orchestrator and hooks
  // Warm the model/price catalogue without blocking the window: a stale disk
  // copy answers immediately, the network refresh lands whenever it lands.
  loadCatalog().catch(() => { /* cached or floor prices carry the app */ });
  // The transcript scan, started now rather than by the first page to ask for
  // it: 2.4 to 3 s on JeanBrasse's 1826 transcripts, which that page used to wait for.
  // After loadCatalog, which installs a fresh disk copy as it is called: a scan
  // started before it priced with another object, and the first minute past it
  // scanned everything again for the swap.
  prewarmClaudeStats();

  // Registration only has to finish before an agent starts, not before the
  // window paints. It used to hold the main thread through the first render.
  void setupMcpOrchestrator(appSettings).catch(err =>
    console.error('MCP registration failed:', err));
  setupMemoryBackends(appSettings);
  await configureStatusHooks();
  removeLegacyHookLogs();

  // Initialize electron-updater (wires up IPC events for progress, downloaded, error)
  initAutoUpdater(getMainWindow);
  setMainWindowGetter(getMainWindow);

  // Updates: once shortly after launch, then on a timer.
  //
  // It used to be the launch check alone, which is the one moment it helps
  // least: Tars is left open for days at a time, so someone who never quits
  // never learned there was a new version. Half an hour is well inside
  // GitHub's unauthenticated rate limit and the check itself is one request.
  //
  // "Check for updates" is read at every tick, not once at launch: turning it
  // off stops the next check, and turning it on starts one within half an hour,
  // without a restart. It is the one switch for these and the CLIs' below.
  const check = () => {
    if (appSettings.autoCheckUpdates === false) return;
    checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err);
    });
  };
  setTimeout(check, 5000);
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  // Never hold the process open for a version check.
  timer.unref?.();

  // And the CLIs the agents run, which Tars keeps from updating themselves:
  // claude and Amp, when at least one agent runs them, 5 s after launch and
  // every half hour, logged to ~/.dorothy/cli-updates.log. Under the same
  // switch. See services/cli-updater.ts.
  startCliUpdates(() => appSettings, () => [...agents.values()].map(agent => agent.provider));

  // PRs merged and changes requested in the agents' repositories, read with
  // `gh` while the reports go out (the relay is on), for the user's event reports.
  startGithubWatch(() => [...agents.values()].map(agent => agent.projectPath).filter(Boolean), reportsOn);

  console.log('App initialization complete');
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Re-create window on macOS when dock icon is clicked
/**
 * The main window made again when it was closed: on macOS Tars keeps running
 * without one. Not before the app is ready, when nothing can be made yet. Asked
 * of the window manager, not of the window count: the tray panel is a window
 * too, kept hidden once it exists.
 */
function remakeMainWindow(): void {
  if (!app.isReady()) return;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) return;
  createWindow();
  setUtilsMainWindow(getMainWindow());
}

/** A second launch's hand-over (claimSingleInstance): the window brought forward, made again first if it was closed. */
function showMainWindow(): void {
  remakeMainWindow();
  revealMainWindow();
}

app.on('activate', remakeMainWindow);

// Save agents and end every terminal before quitting. In two passes: the
// first saves, stops what writes, and holds the quit while the terminals'
// process trees end and node-pty delivers their exits (endAllTerminals, at
// most TERMINAL_GRACE_MS plus half a second); then it quits again, and the
// second closes what the terminals no longer need. Their exits used to come
// after a synchronous before-quit, one of them during Electron's final
// cleanup, where it aborted the app (the crash report of #231's proof).
let terminalsEnded = false;
let endingTerminals = false;
app.on('before-quit', (event) => {
  if (!terminalsEnded) {
    event.preventDefault();
    if (endingTerminals) return;
    endingTerminals = true;
    console.log('App quitting, saving agents and ending every terminal...');
    // First, before anything waits: the quit begins (nothing new is spawned
    // from here on, no exit is its agent's news), and every terminal has its
    // tree read and its hangup sent before endAllTerminals first yields. The
    // delegated runs' grace below is synchronous, so the two graces run at
    // once instead of one after the other.
    const terminals = endAllTerminals();
    // Each step guarded, and the two that write to disk first: see shutdown.ts.
    // The bus journal writes once per turn of the event loop rather than once
    // per row, so a turn that ends in a quit is the one that never gets there.
    runShutdownSteps([
      ['flushBus', flushBus],
      ['saveAgents', saveAgents],
      // Before the app exits, which neither the stop's timer nor a run left
      // reparented to launchd would wait for: at most a second, then SIGKILL.
      ['endAcpRunsOnQuit', endAcpRunsOnQuit],
      // A permission question held for the window: the mod's request is answered, back to its dialog.
      ['endPermissionAsks', endPermissionAsks],
      ['destroyTray', destroyTray],
      ['stopAgentAutosave', stopAgentAutosave],
      ['stopOverseerWatch', stopOverseerWatch],
      ['stopStallWatch', stopStallWatch],
      // Windows: before the terminals' exits come in, which the quit waits
      // for there, up to 5 s more (pty-kill.ts): no announcement goes out
      // meanwhile, a pending one included. Nothing on darwin and linux.
      ['stopStatusNotifications', () => stopStatusNotifications()],
      ['stopErrorTriage', stopErrorTriage],
      ['stopSleepWatch', stopSleepWatch],
      ['stopTmpRetention', () => stopTmpRetention()],
      // A claude asked for an account's usage (get_usage) just before the quit.
      ['endUsageProbes', endUsageProbes],
      // A CLI's --version asked for by Settings just before the quit: amp's
      // kept writing into the home after Tars was gone (gate of #298).
      ['endVersionProbes', endVersionProbes],
      // A `claude auth status` the accounts list started just before the
      // quit: it wrote .claude.json into the home after Tars was gone.
      ['endAuthCommands', endAuthCommands],
      // Last: what is owed on disk, and the run marked as ended cleanly, so
      // the next launch resumes nobody.
      ['endRestartRecovery', () => endRestartRecovery(recovery)],
    ]);
    void terminals
      .catch(err => console.error('Failed to end the terminals on quit:', err))
      .finally(() => {
        terminalsEnded = true;
        app.quit();
      });
    return;
  }
  runShutdownSteps([
    ['closeVaultDb', closeVaultDb],
    ['stopOpenAIBridgeServer', stopOpenAIBridgeServer],
  ]);
});

/**
 * Loopback hosts whose TLS errors may be waived, and only in a dev build.
 *
 * This used to be `url.startsWith('https://localhost')` - a raw prefix test on
 * the whole URL, not a host comparison. `https://localhost.attacker.example/x`
 * and `https://localhostess.example` both match that prefix, so Chromium was
 * told to accept an expired, self-signed or wrong-host certificate for a host
 * the attacker owns; any subresource the renderer pulls from it (an <img> in a
 * note whose markdown an agent wrote, say) then travels over a connection whose
 * certificate was never validated, with no interstitial. The handler also had
 * no build guard despite its "in development" comment, so it shipped enabled in
 * the signed release. Now: parse the URL, compare the hostname exactly, and
 * only ever waive in an unpackaged build - see isDevBuild().
 */
const TLS_WAIVER_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function mayWaiveCertificateError(url: string): boolean {
  if (!isDevBuild()) return false;
  let hostname: string;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return false;
  }
  // URL keeps IPv6 literals bracketed ("[::1]"); strip so the set matches.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }
  return TLS_WAIVER_HOSTS.has(hostname.toLowerCase());
}

// Handle certificate errors in development
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (mayWaiveCertificateError(url)) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

export { appSettings, getTelegramBot };
