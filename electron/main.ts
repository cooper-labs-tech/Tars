/**
 * Tars - Main Electron Entry Point
 *
 * This file initializes and wires together all the modular components:
 * - Window management and protocol handling
 * - Agent state and PTY management
 * - IPC handlers for renderer communication
 * - External services (Slack, Discord, the HTTP API, the relay to Hermes)
 * - MCP orchestrator integration
 */

// First of all: a test build on the account's own home stops before anything reads it.
import { SANDBOX_BUILD } from './core/sandbox-guard';
// Then: every module required after it is compiled from the cache it keeps.
import './core/compile-cache';
// Then the guard that keeps an uncaught exception from freezing main behind
// Electron's error box, before any other module loads (core/uncaught-guard.ts).
import { uncaught } from './uncaught';

import { startGithubWatch } from './services/github-watch';
import { onRelayReply, onRelayStatus, relayEnabled, relaySend, relayWasSent, startHermesRelay, tellUser } from './services/hermes-relay';
import { startRelayRouting } from './services/hermes-relay-routing';
import { reportsOn } from './services/event-reports';
import { app, dialog, ipcMain, Notification, powerSaveBlocker } from 'electron';
import { endPermissionAsks } from './services/permission-asks';
import { stopSharedMcp } from './services/mcp-shared';
import * as fs from 'fs';
import * as path from 'path';

// Types
import type { AppSettings, AgentStatus } from './types';

// Constants
import { APP_SETTINGS_FILE, API_PORT, API_TOKEN_FILE, DATA_DIR, DATA_DIR_MOVE, DATA_DIR_REWRITTEN, KANBAN_FILE, PRIVATE_DIR, dataPath } from './constants';
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

import {
  agents,
  loadAgents,
  saveAgents,
  initAgentPty,
  handleStatusChangeNotification,
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
import { readTerminals } from './core/pty-spawn';
import { terminalsNearFullNote } from './core/pty-pool';
import { readFleetResources } from './services/fleet-resources-runtime';

// Services
import { startApiServer } from './services/api-server';
import { startOpenAIBridgeServer, stopOpenAIBridgeServer } from './services/openai-bridge';
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
import { noteApiPhase } from './core/api-listening';
import { registerCLIPathsHandlers } from './handlers/cli-paths-handlers';
import { registerBusHandlers } from './handlers/bus-handlers';
import { registerChatHandlers } from './handlers/chat-handlers';
import { flushBus } from './services/bus-store';
import { registerVaultHandlers } from './handlers/vault-handlers';
import { registerVaultProjectFilesHandlers } from './handlers/vault-project-files-handlers';
import { registerReviewHandlers } from './handlers/review-handlers';
import { registerAgentQueueHandlers } from './handlers/agent-queue-handlers';
import { registerTemplateHandlers } from './handlers/template-handlers';
import { registerTeamTemplateHandlers } from './handlers/team-template-handlers';
import { registerHermesHandlers } from './handlers/hermes-handlers';
import { registerOverseerHandlers } from './handlers/overseer-handlers';
import { startOverseerWatch, stopOverseerWatch, migrateOverseerOutOfAgentReach } from './services/overseer';
import { migrateWebhookSecretOutOfAgentReach } from './services/hermes-webhook-secret';
import { startAgentWatch, watchInterruptedTurns, tellQueuesKept } from './services/agent-watch';
import { endRequestsAtLaunch, endUnresumed } from './core/task-requests';
import { keepQueue, keptQueueRefs, restoreQueues } from './services/agent-queues';
import { oneTaskQueue } from './core/one-task';
import { replayQueuedItem } from './services/api-routes/agent-routes';
import { startTaskWatch, turnInterrupted } from './services/task-watch';
import { cliRunningIn } from './core/agent-pty';
import { beginRun, type PreviousRun } from './services/run-state';
import { endRestartRecovery, startRestartRecovery } from './services/restart-recovery';
import { startStallWatch, stopStallWatch, readProcesses, cliProcess, processTreeOf } from './services/stall-watch';
import { filesOpenBy, openFilesReadable } from './platform/open-files';
import { startCodexSessionWatch, type HookPost } from './services/codex-sessions';
import { startPiSessionWatch, piSessionDir } from './services/pi-sessions';
import { codexHome, codexSignInGap, loginShellCodexHome } from './providers/codex-cli';
import { codexKeyConfig } from './services/cli-keys';
import { getProvider } from './providers';
import { scheduleTick } from './utils/agents-tick';
import { terminalTokenOf } from './core/agent-tokens';
import { codexDialogOnScreen } from './core/terminal-mirror';
import { startSleepWatch, stopSleepWatch } from './services/agent-sleep';
import { startStatusWatch, stopStatusWatch } from './services/status-truth';
import { startBornWatch, stopBornWatch } from './services/born-watch';
import { endUsageProbes } from './services/claude-accounts/usage-probe';
import { initVaultDb, closeVaultDb } from './services/vault-db';
import { initAutoUpdater, checkForUpdates, setMainWindowGetter } from './services/update-checker';
import { checksForUpdates } from './core/sandbox-build';
import { startCliUpdates } from './services/cli-updater';
import { migrateLocalTasks, setKanbanAgentDirectory } from './services/kanban-board';
import { hermesKanban, tellAgentAsTars, tellOrchestratorAsTars } from './services/api-routes/kanban-routes';
import { giveSlotBackForOwner, startHeavySlot, stopHeavySlot, slotStatus } from './services/heavy-slot-runtime';
import { inboxAgentOf } from './core/chat-inbox';
import { installSlotShims } from './services/heavy-slot-cli';
import { startErrorTriage, stopErrorTriage } from './services/error-triage';
import { sentryTokenOutOf, settingsToSave } from './services/sentry-token';
import { SECRETS_FILE, migrateSecrets, readSecrets, saveSettingsSplit } from './services/settings-secrets';
import { retireTelegramBot, withoutRetiredSettings } from './services/telegram-retired';
import { agentStatusEmitter, emitAgentStatus } from './services/agent-events';
import { createKeepAwake } from './services/keep-awake';
import { endAcpRunsOnQuit, agentsRunningOverAcp } from './services/acp/delegate';
import { retentionLog, startTmpRetention } from './services/agent-tmp';
import { sweepRunTokenFolders } from './services/acp/run-token-file';
import { describeSecretFileError, ensureSecretFileMode, narrowDataDir, closeSecretsToOtherAccounts } from './utils/secret-file';
import { HERMES_CONNECTION_FILE, configuredHermesConnection } from './services/hermes-config';
import { createHermesSessionWatch, setHermesSessionWatch } from './services/hermes-session-watch';
import { probeHermes } from './services/hermes-client';
import { restartRunnersOf } from './services/chat-runners';

// Utils
import {
  setMainWindow as setUtilsMainWindow,
  sendNotification,
  isSuperAgent,
  ensureDataDir,
  ensureAgentInstructions,
  migrateFromClaudeManager,
} from './utils';
import { endVersionProbes } from './core/version-probe';
import { endAuthCommands } from './services/claude-accounts/auth';
import { TOOL_TOPIC } from './services/agent-guide';
import { getAllProviders } from './providers';
import { cliEnv, currentFolderLookupsOff, nodeMissing } from './platform';

// ============== App Settings Management ==============

// A closed stdout/stderr pipe (e.g. the launching shell exited) must never
// crash the app: console.log would otherwise throw an uncaught EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

// On Windows, nothing Tars starts by a bare name is looked up in the folder
// it is started in, which is often a project's (platform/git-command.ts).
Object.assign(process.env, currentFolderLookupsOff());

let appSettings: AppSettings = loadAppSettings();

/** The computer kept awake while an agent works, per keepAwake (services/keep-awake.ts). */
const keepAwake = createKeepAwake({ blocker: powerSaveBlocker, settings: () => appSettings, agents: () => agents.values() });

function startKeepAwake(): void {
  // Every status change the fleet announces, and every 30 s for a path that announces none.
  agentStatusEmitter.on('fleet-change', () => keepAwake.sync());
  setInterval(() => keepAwake.sync(), 30_000).unref?.();
  ipcMain.handle('keepAwake:state', () => keepAwake.state());
  keepAwake.sync();
}
let stopTmpRetention: () => void = () => undefined;
let previousRun: PreviousRun | null = null;
let recovery: { flush: () => void } | null = null;
// Off unless the user turned them on; followed live (services/error-reports).
// Every IPC handler registered from here on is timed for the health samples
// (services/health/monitor.ts): before any of them is registered.
timeIpcHandlers(ipcMain as unknown as Parameters<typeof timeIpcHandlers>[0]);

const errorReports = startErrorReports(() => appSettings.errorReportsEnabled === true, process.platform, {
  onFatalError: uncaught.onFatalError,
  // What an agent tool error may name (2.0.4): Tars's own tools and the CLIs it runs.
  vocabulary: { tools: new Set(Object.keys(TOOL_TOPIC)), clis: new Set(getAllProviders().map(provider => provider.id)) },
  channels: ipcChannels.known(),
});

/** The health samples, ~/.tars, on this machine only (services/health/samples.ts). */
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
  // Every key out of ~/.tars before anything reads one (services/settings-secrets.ts),
  // then what a 2.0.4 left of Tars's own Telegram bot (services/telegram-retired.ts).
  migrateSecrets();
  retireTelegramBot();
  try {
    if (fs.existsSync(APP_SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8'));
      // The Sentry token is kept in ~/.tars-private (services/sentry-token.ts),
      // and so are the other secrets (settings-secrets.json).
      // The switch is on only for the boolean true: the file is in ~/.tars,
      // which every agent can write, and "false" or 1 would read as on to a
      // page that tests it for truth (the Audit's L1 on #360).
      return { ...defaults, ...sentryTokenOutOf(saved), ...readSecrets(), newInterface: saved.newInterface === true, chatsReadEachOther: saved.chatsReadEachOther === true };
    }
  } catch (err) {
    console.error(`Failed to load app settings: ${describeSecretFileError(err)}`);
  }
  return { ...defaults, ...sentryTokenOutOf({}), ...readSecrets() };
}

function saveAppSettingsToFile(settings: AppSettings) {
  try {
    ensureDataDir();
    // 0600 and atomic. The secrets go to ~/.tars-private (settings-secrets.json,
    // and the Sentry token's own file), the rest to app-settings.json.
    saveSettingsSplit(withoutRetiredSettings(settingsToSave(settings)) as AppSettings);
  } catch (err) {
    console.error('Failed to save app settings:', err);
  }
}

// ============== Notification Handler Wrapper ==============

function handleStatusChangeNotificationWrapper(agent: AgentStatus, newStatus: string) {
  handleStatusChangeNotification(
    agent,
    newStatus,
    appSettings,
    sendNotification,
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
    setAppSettings: (settings: AppSettings) => { appSettings = settings; void errorReports.sync(); keepAwake.sync(); },
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
    initSlackBot: () => initSlackBot(() => appSettings, (settings) => {
      appSettings = settings;
      saveAppSettingsToFile(settings);
    }, getMainWindow()),
    initDiscordBot: startDiscordBot,
    getSlackApp,

    // Claude data functions. The page's stats come at once, as last computed,
    // and are computed again behind it once a minute old.
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
 * parked, on their project; ~/.tars/kanban-tasks.json stays as it is, the
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

/**
 * Tars's Hermes session, asked every half hour (services/hermes-session-watch.ts):
 * each check is a signed-in request, which keeps the session renewed, and finds it
 * when the gateway ended it. Only for a gateway a connection file names: none is
 * asked for a sandbox or a test home with no file. A test run may ask for a
 * shorter period (DOROTHY_HERMES_SESSION_EVERY_MS, under DOROTHY_E2E only).
 */
function hermesSessionEveryMs(): number {
  const asked = Number(process.env.DOROTHY_HERMES_SESSION_EVERY_MS);
  return process.env.DOROTHY_E2E === '1' && Number.isFinite(asked) && asked >= 200 ? asked : 30 * 60_000;
}

function startHermesSessionWatch() {
  const watch = createHermesSessionWatch({
    check: async () => {
      const configured = configuredHermesConnection();
      if (!configured || 'unusable' in configured) return { configured: false, reachable: false, authRequired: false, signedIn: false };
      const p = await probeHermes(configured.conn);
      return { configured: true, reachable: p.reachable, authRequired: p.authRequired, signedIn: p.signedIn, version: p.version };
    },
    everyMs: hermesSessionEveryMs(),
    onChange: state => broadcastToAllWindows('hermes:session:state', state),
  });
  setHermesSessionWatch(watch);
  watch.start();
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
  // No agent's CLI starts until this Tars listens on its port (core/api-listening.ts): "stopped" lets a start through,
  // and the window and the IPC come up before initApiServer, so the API reads "starting" from here (the Audit's L3 on
  // #541).
  noteApiPhase('starting');

  // Ensure data directory exists
  ensureDataDir();

  // Narrow the credential files on installs that predate the 0600 write.
  // A `mode` passed to writeFileSync only applies at creation, so an
  // app-settings.json already sitting at 0644 would keep it forever.
  for (const secret of [APP_SETTINGS_FILE, SECRETS_FILE, HERMES_CONNECTION_FILE, API_TOKEN_FILE, HEALTH_FILE]) {
    ensureSecretFileMode(secret);
  }
  // And the directory itself with everything in it: the fleet, the board, the
  // ledger and the vault were readable by every account on the machine.
  narrowDataDir(DATA_DIR);

  // Take JeanBrasse's conversation with the super chat out of ~/.tars, which is
  // the directory every agent is handed. Here rather than on the first read of
  // it: a run in which the Chat is never opened would otherwise leave the file
  // sitting there for its whole length.
  migrateOverseerOutOfAgentReach();
  // And the Hermes webhook secret, for the same reason: through the webhook it
  // gives any agent of any project work, and ~/.tars is one `cat` away.
  migrateWebhookSecretOutOfAgentReach();
  // Windows: the modes above do nothing there; an access list does the same,
  // set in the background (it never rejects, each failure is logged).
  // The health samples too: the privacy page says they are readable by the
  // user's account only.
  void closeSecretsToOtherAccounts([APP_SETTINGS_FILE, SECRETS_FILE, HERMES_CONNECTION_FILE, API_TOKEN_FILE, HEALTH_FILE], PRIVATE_DIR);

  // Write Tars's CLAUDE.md to ~/.tars/ so all spawned agents can load it
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

  // ~/.dorothy became ~/.tars as constants loaded (core/data-dir-move.ts), and
  // the old path was rewritten where Tars wrote it: said once here.
  if (DATA_DIR_MOVE.did !== 'none' && DATA_DIR_MOVE.did !== 'already') {
    console.log(`[data-dir] ${DATA_DIR_MOVE.did}: ${DATA_DIR}${DATA_DIR_MOVE.why ? ` (${DATA_DIR_MOVE.why})` : ''}`);
  }
  if (DATA_DIR_REWRITTEN.length) console.log(`[data-dir] ~/.dorothy rewritten to ~/.tars in ${DATA_DIR_REWRITTEN.length} file(s)`);

  // Load agents from disk
  loadAgents();
  // And the run token folders a delegated run or a crash left behind (services/acp/run-token-file.ts).
  sweepRunTokenFolders();
  // Whether the last run stopped abruptly, and who was working then, read
  // before this run's record replaces it (services/run-state.ts).
  previousRun = beginRun({ appVersion: app.getVersion() });
  // A run that did not quit is reported once, at this launch, when error
  // reports are on (services/health/abrupt-end.ts): its samples are read here,
  // before this run's first, and sent once every handler is registered, below.
  const lastRunSamples = previousRun ? readSamples(HEALTH_FILE) : [];
  // What leaves names only the channels this Tars registered and the app's
  // pages: the samples file is in ~/.tars, which agents may write.
  const healthWords: Vocabulary = { channels: ipcChannels.known(), pages: APP_PAGES };
  startHealthMonitor({
    file: HEALTH_FILE,
    everyMs: healthEveryMs(),
    agents: () => ({ total: agents.size, running: [...agents.values()].filter((a) => a.status === 'running').length }),
    page: () => pageOf(getMainWindow()?.webContents.getURL()),
    // Each agent's whole tree, weighed on the same sample (services/health/machine.ts, 2.0.5).
    agentTerminals: () => [...agents.values()].flatMap((a) => {
      const terminal = a.ptyId ? ptyProcesses.get(a.ptyId) : undefined;
      return terminal ? [{ id: a.id, pid: terminal.pid }] : [];
    }),
    // The machine's terminals on the same sample; past 80 % of its limit the window and every project's
    // orchestrator are told, once (core/pty-pool.ts, 2.0.6: the leak that filled macOS's 511 on 28-29/10).
    terminals: readTerminals,
    onTerminalsNearFull: (pool) => {
      void readFleetResources().then((r) => broadcastToAllWindows('resources:changed', r)).catch(() => undefined);
      const note = terminalsNearFullNote(pool);
      for (const project of new Set([...agents.values()].map((a) => a.projectPath))) void tellOrchestratorAsTars(project, note);
    },
  });
  registerDiagnosticHandlers({ reports: errorReports, samplesFile: HEALTH_FILE, known: healthWords });
  // Bound how much a crash can lose: PTY-driven fields reach disk on a timer.
  startAgentAutosave();

  // Setup protocol handler for production
  setupProtocolHandler();

  // Create the main window
  createWindow();
  uncaught.windowOpened();
  // Two data folders (core/data-dir-move.ts): which one Tars runs on is said
  // where the user sees it, once per start, and the window can ask for it
  // (app:dataDir). Never from an E2E run, which must put nothing on the screen.
  if (DATA_DIR_MOVE.notice && process.env.DOROTHY_E2E !== '1' && Notification.isSupported()) {
    new Notification({ title: 'Tars: two data folders', body: DATA_DIR_MOVE.notice }).show();
  }
  // Windows: no menu, toasts, close to the tray (desktop-lifecycle.ts).
  installDesktopShell({
    getMainWindow,
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

  // Windows: the hooks and the bundled tools run on Node, which a native
  // claude.exe does not bring. Said at each launch until it is installed.
  const noNode = nodeMissing(cliEnv() ?? process.env);
  if (noNode) void dialog.showMessageBox({ type: 'warning', ...noNode });

  // Register all IPC handlers
  const deps = createIpcDependencies();
  registerIpcHandlers(deps);
  registerMcpOrchestratorHandlers();
  registerCLIPathsHandlers({
    getAppSettings: () => appSettings,
    setAppSettings: (settings) => { appSettings = settings; void errorReports.sync(); keepAwake.sync(); },
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
  // Each project's reports/ and tools/, what its agents produce.
  registerVaultProjectFilesHandlers();
  // Review: every repository of every project, scanned and searched (services/review-repositories.ts).
  registerReviewHandlers();
  registerAgentQueueHandlers();


  // The relay to the user's Telegram through their Hermes, following its switch
  // live (services/hermes-relay.ts): the only way to their Telegram since 2.0.5,
  // when Tars's own bot went (services/telegram-retired.ts).
  startHermesRelay({ enabled: () => appSettings.hermesRelayEnabled === true });
  startRelayRouting({
    agents, ptyProcesses, settings: () => appSettings, saveAgents,
    initAgentPty: (agent: AgentStatus) => initAgentPty(agent, getMainWindow(), handleStatusChangeNotificationWrapper, saveAgents),
  });
  onRelayStatus(status => broadcastToAllWindows('hermes:relay:status', status));
  startHermesSessionWatch();

  // Initialize services
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
  // What the agents' queues kept from the run before is not ended: it waits, paused (2.0.5, services/agent-queues.ts).
  endRequestsAtLaunch(agents.values(), new Set(previousRun && !previousRun.resumedAndCrashedAgain
    ? previousRun.working.map((w) => w.agentId) : []), keptQueueRefs());
  saveAgents();
  // The agents' queues back, paused, each item waiting to be handed over again, and each project's orchestrator
  // told what waits; kept from now on at each change.
  const restoredQueues = restoreQueues(oneTaskQueue, replayQueuedItem);
  keepQueue(oneTaskQueue);
  tellQueuesKept(restoredQueues);
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
  // What an agent started that outlives its session: recorded, and said to its orchestrator an hour on, never
  // ended by Tars (services/born-watch.ts, 2.0.5).
  startBornWatch({
    fleet: () => agents.values(),
    hasSession: (agent) => {
      const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      return !!terminal && cliRunningIn(terminal);
    },
    tell: tellOrchestratorAsTars,
    save: saveAgents,
  });
  startKeepAwake();
  // The heavy-run slot for the whole machine (services/heavy-slot.ts): its shims in ~/.tars/bin for `tars-slot`, its
  // passes, and the window's read of who holds it and who waits.
  installSlotShims();
  startHeavySlot({
    getAppSettings: () => appSettings,
    // Told once when the holder is its project's orchestrator: as the holder.
    tellOrchestrator: (projectPath, text, unless) => (unless && inboxAgentOf(projectPath, agents.values())?.id === unless
      ? Promise.resolve('self') : tellOrchestratorAsTars(projectPath, text)),
    tellAgent: (agentId, text) => {
      const agent = agents.get(agentId);
      return agent ? tellAgentAsTars(agent, text) : Promise.resolve('gone');
    },
    broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  });
  ipcMain.handle('heavySlot:status', () => slotStatus());
  // The owner gives a lease back from the window (the Audit's M2 on #537); its holder and orchestrator are told.
  ipcMain.handle('heavySlot:giveBack', (_e, id: unknown) => typeof id === 'string' && giveSlotBackForOwner(id));
  // codex's turns, read from its session log and posted as its terminal's hooks
  // would post them, with that terminal's own token (services/codex-sessions.ts).
  // What a CLI without Tars's hooks would have posted, posted as its terminal,
  // with that terminal's own token, on the routes its hooks use.
  const postAsTerminal = (watch: string) => async (agentId: string, { path: route, body }: HookPost) => {
    const token = terminalTokenOf(agentId);
    if (!token) return;
    try {
      await fetch(`http://127.0.0.1:${API_PORT}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn(`[${watch}] ${route} for ${agentId} not posted:`, err instanceof Error ? err.message : err);
    }
  };
  // A status its CLI's own record and its terminal contradict, an event having
  // never reached Tars, posted as that terminal's hook would have (services/status-truth.ts).
  const postStatus = postAsTerminal('status');
  startStatusWatch({
    post: async (agentId, post) => {
      if (!terminalTokenOf(agentId)) return false;
      await postStatus(agentId, post);
      return true;
    },
    announce: (agent) => {
      emitAgentStatus(agent.id);
      broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: new Date().toISOString() });
      scheduleTick();
    },
  });
  // pi's turns, read from its session file (services/pi-sessions.ts).
  startPiSessionWatch({
    dirOf: (agentId) => piSessionDir(DATA_DIR, agentId),
    post: postAsTerminal('pi-sessions'),
    interrupted: (agentId, sessionId) => turnInterrupted(agentId, sessionId),
  });
  startCodexSessionWatch({
    post: postAsTerminal('codex-sessions'),
    dialogTitle: (agentId) => {
      const agent = agents.get(agentId);
      return codexDialogOnScreen(agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);
    },
    interrupted: (agentId, sessionId) => turnInterrupted(agentId, sessionId),
    resumableSessionOf: (agentId) => agents.get(agentId)?.resumableSessionId,
    codexRunning: (agentId) => {
      const agent = agents.get(agentId);
      const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      return !!terminal && cliRunningIn(terminal);
    },
    // Whose own codex holds a new session's file, read once per session that
    // names nobody: the codex under each waiting agent's terminal and what it
    // started (the Audit's M1 on #465). Unknown where files cannot be read, and
    // asked again when ps or lsof failed (the Audit's L5).
    openFilesReadable: () => openFilesReadable(),
    heldOpenBy: async (file, agentIds) => {
      if (!openFilesReadable()) return undefined;
      const procs = await readProcesses();
      if (!procs) return undefined;
      let real: string;
      try { real = fs.realpathSync(file); } catch { return null; }
      for (const agentId of agentIds) {
        const agent = agents.get(agentId);
        const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
        const codex = terminal ? cliProcess(terminal.pid, procs, 'codex') : undefined;
        if (!codex) continue;
        const open = await filesOpenBy(processTreeOf(codex.pid, procs));
        if (open === undefined) return undefined;
        if (open.has(real)) return agentId;
      }
      return null;
    },
    // Why the agent's codex will start not signed in, asked at its launch (the
    // Audit's L7 on #465): Tars hands codex its own home, and the user's login
    // may be in the CODEX_HOME their shell sets. Said in its status: codex shows
    // its sign-in screen and writes no session, so nothing else would say it.
    signInGapOf: async (agentId) => {
      const agent = agents.get(agentId);
      if (!agent) return undefined;
      return codexSignInGap({
        binaryPath: agent.cliPath || getProvider(agent.provider).resolveBinaryPath(appSettings),
        home: codexHome(),
        keyed: codexKeyConfig(appSettings).length > 0,
        shellHome: () => loginShellCodexHome(),
      });
    },
    notSignedIn: (agentId, text) => {
      const agent = agents.get(agentId);
      if (!agent) return;
      console.warn(`[codex] ${agent.name || agentId}: ${text}`);
      agent.status = 'error';
      agent.error = text;
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      scheduleTick();
      emitAgentStatus(agentId);
    },
  });
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
    if (appSettings.autoCheckUpdates === false || !checksForUpdates({ sandbox: SANDBOX_BUILD })) return;
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
  // every half hour, logged to ~/.tars/cli-updates.log. Under the same
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
      // The MCP servers shared between agents: their stdin closed, then each stopped by its own process.
      ['stopSharedMcp', stopSharedMcp],
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
      ['stopStatusWatch', stopStatusWatch],
      ['stopBornWatch', stopBornWatch],
      ['stopHeavySlot', stopHeavySlot],
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

export { appSettings };
