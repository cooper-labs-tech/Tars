import { hasClaudeHooks } from './end-of-turn';
import { keyPrintOf } from '../services/cli-keys';
import { readAppSettingsFromDisk } from '../providers/cli-provider';
import { agentRecovered, reportEvent } from '../services/event-reports';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow, Notification } from 'electron';
import { AgentStatus, AppSettings } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENTS_FILE, API_TOKEN_FILE, DATA_DIR, dataPath } from '../constants';
import { dropRejectedTails, keysHandedToClaude, maskKeyFragments } from './key-fragments';
import { ensureDataDir, isSuperAgent, sendNotification } from '../utils';
import { isSkillName } from '../utils/skill-name';
import { quoted } from '../utils/reveal';
import { hasOrchestratorPowers, rolesOnLoad } from './agent-role';
import { holdsMessages } from './one-task';
import { deliveryVerdict, sessionTail, taskOnRecord } from './delivery-proof';
import { oweToFirstMessage, ptyProcesses, setDialogProbe, setCliProbe, setTurnProbe, setTurnInProgressProbe, writeProgrammaticInput } from './pty-manager';
import { dialogOpen, dialogShown } from './agent-launch';
import type * as pty from 'node-pty';
import { cliStoppedIn, spawnAgentPty, agentShell, codexLaunching } from './agent-pty';
import { killPty } from './pty-kill';
import { withPath, type DirectLaunch, type Launch } from '../platform';
import { buildFullPath } from '../utils/path-builder';
import { cliPathDirs } from '../utils/cli-path-dirs';
import { getProvider } from '../providers';
import { extractStatusLine } from '../utils/ansi';
import { carriedByTrim } from '../utils/terminal-modes';
import { updateSharedJsonSync } from '../utils/shared-file';
import { renameReplacingSync } from '../platform/rename-replacing';
import { scheduleTick } from '../utils/agents-tick';
import { getTasmaniaStatus } from '../services/tasmania-client';
import { emitAgentStatus } from '../services/agent-events';
import { agentStatusOnExit } from './quit-state';
import { clearStop } from './agent-stop';
import { wakeFromSleep } from './agent-asleep';
import { currentApiCall } from '../services/api-routes/call-context';
import { reportAgentToolError, reportHandledError, taskNeverStarted } from '../services/error-reports/handled';
import { UNKNOWN_TOOL } from '../services/error-reports/report';
import { trustsTooMuch } from '../utils/trust-too-much';

/**
 * When each agent's current status began (`statusSince`), stamped where the
 * status is written rather than by each writer.
 *
 * Forty lines assign `agent.status`, in the hooks, the routes, the bots and the
 * handlers, and a "since" left to each of them is a "since" one of them
 * forgets. So an agent put in the fleet has its `status` turned into an
 * accessor over the same value: writing a different status stamps the time,
 * writing the same one does not (a Stop hook posting `idle` on an idle agent
 * does not restart "idle for 4m"). It stays an enumerable own property, so
 * agents.json, a spread and JSON.stringify see a plain field. `lastActivity`
 * could not do this: every repaint of the terminal moves it. `waitingOn` goes
 * with the wait it describes, for the same reason: twelve lines clear
 * `waitingReason` by hand.
 */
function watchStatus(agent: AgentStatus, previous: AgentStatus | undefined): void {
  const descriptor = Object.getOwnPropertyDescriptor(agent, 'status');
  if (descriptor?.get) return;
  let value = agent.status;
  // An object replaced in the map keeps its time while its status is the same.
  agent.statusSince = previous && previous.status === value && previous.statusSince
    ? previous.statusSince
    : new Date().toISOString();
  Object.defineProperty(agent, 'status', {
    enumerable: true,
    configurable: true,
    get: () => value,
    set: (next: AgentStatus['status']) => {
      if (next === value) return;
      value = next;
      agent.statusSince = new Date().toISOString();
      // What it waited on belongs to that wait, whichever line ended it.
      if (next !== 'waiting') agent.waitingOn = undefined;
    },
  });
}

class AgentMap extends Map<string, AgentStatus> {
  override set(id: string, agent: AgentStatus): this {
    if (agent && typeof agent === 'object') watchStatus(agent, this.get(id));
    return super.set(id, agent);
  }
}

export const agents: Map<string, AgentStatus> = new AgentMap();

/**
 * The writer refuses to type into an open dialog (pty-manager.ts,
 * setDialogProbe), and this map is where an agent's dialog is known. Called by
 * main.ts at startup, beside the field probe.
 */
export function wireDialogProbe(): void {
  // And a held message goes into a CLI only, never its shell (setCliProbe).
  setCliProbe(ptyProcess => !cliStoppedIn(ptyProcess));
  setDialogProbe(agentId => {
    const agent = agents.get(agentId);
    return !!agent && dialogShown(agent, agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);
  });
  // What a message sent in `queue` mode waits out: the agent's turn, a run of it
  // over ACP, and the tasks waiting their turn before it (core/one-task.ts).
  setTurnProbe(agentId => {
    const agent = agents.get(agentId);
    return !!agent && holdsMessages(agent);
  });
  // The CLI's own turn, and nothing wider: what tells a message that opens a turn (pty-manager.ts, noteTurnCut).
  setTurnInProgressProbe(agentId => agents.get(agentId)?.status === 'running');
}

/**
 * Pre-populate Claude Code's workspace trust record for a given directory.
 *
 * BUG 6 fix: `--dangerously-skip-permissions` skips *runtime* permission
 * prompts (Edit/Write/Bash confirmations), but Claude Code has a SEPARATE
 * "workspace trust" dialog that fires on first launch in an unknown directory.
 * That dialog is gated by `~/.claude.json`'s
 * `projects[<absolute-path>].hasTrustDialogAccepted` flag: NOT by the
 * runtime permission mode. So even a bypass-mode agent hits the trust prompt
 * on first launch in a new project.
 *
 * Writing the flag ourselves before we spawn the claude process makes the
 * trust dialog never appear. Safe to call repeatedly and idempotent.
 *
 * Every live Claude Code reads and rewrites this file, so it is changed through
 * updateSharedJsonSync: never in place, never when the flag is already there,
 * with its 0600 mode kept. See that function for the risk that remains.
 */
export function ensureProjectTrusted(projectPath: string): void {
  if (!projectPath) return;
  if (trustsTooMuch(projectPath)) {
    console.warn(`ensureProjectTrusted: ${projectPath} would trust every folder below it, left for Claude Code to ask`);
    return;
  }
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  type ClaudeConfig = {
    projects?: Record<string, {
      hasTrustDialogAccepted?: boolean;
      projectOnboardingSeenCount?: number;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };

  // Claude Code reads the flag under the folder it starts in, as the system
  // names it: the real path. A project reached through a link (anything under
  // macOS's /var or /tmp, a checkout linked elsewhere) trusted under the
  // spelling Tars saved alone still showed the dialog, and the agent's first
  // task answered it. Both are written; trustsTooMuch has judged both.
  const keys = [projectPath];
  try {
    const real = fs.realpathSync.native(projectPath);
    if (real !== projectPath) keys.push(real);
  } catch {
    // Not there yet: the saved spelling is all there is.
  }

  try {
    const outcome = updateSharedJsonSync<ClaudeConfig>(claudeJsonPath, config => {
      if (keys.every(key => config?.projects?.[key]?.hasTrustDialogAccepted === true)) return undefined;
      const projects = { ...config?.projects };
      for (const key of keys) {
        const existing = projects[key] ?? {};
        projects[key] = {
          ...existing,
          hasTrustDialogAccepted: true,
          projectOnboardingSeenCount: existing.projectOnboardingSeenCount ?? 1,
        };
      }
      return { ...config, projects };
    });
    if (outcome === 'written') {
      console.log(`ensureProjectTrusted: marked ${projectPath} trusted in ~/.claude.json`);
    } else if (outcome === 'unreadable') {
      console.warn(`ensureProjectTrusted: ${claudeJsonPath} is not valid JSON, left untouched`);
    } else if (outcome === 'busy') {
      console.warn(`ensureProjectTrusted: ${claudeJsonPath} kept changing, trust for ${projectPath} not written`);
    }
  } catch (err) {
    console.warn(`ensureProjectTrusted: failed to update ${claudeJsonPath}:`, err);
  }
}

export let agentsLoaded = false;
export let superAgentTelegramTask = false;
export let superAgentOutputBuffer: string[] = [];

export function setSuperAgentTelegramTask(value: boolean) {
  superAgentTelegramTask = value;
}

export function getSuperAgentOutputBuffer(): string[] {
  return superAgentOutputBuffer;
}

export function clearSuperAgentOutputBuffer() {
  superAgentOutputBuffer = [];
}

/**
 * Kill the agent's PTY if its recorded cwd no longer matches the agent's
 * current logical working directory (worktreePath ?? projectPath). Returns
 * true if the PTY was killed (caller should respawn before writing to it).
 *
 * This prevents the BUG 4 scenario where an agent has a worktree added
 * after its PTY was created: the running PTY keeps its old cwd, so
 * subsequent messages land in the main workspace instead of the worktree.
 */
/**
 * The key environment each agent terminal was spawned with, as a print
 * (services/cli-keys.ts, keyPrintOf): a start in a reused shell must carry the
 * keys set now (the Audit's L1 on #459). A codex key set after the shell was
 * spawned had codex started on Tars's provider without CODEX_API_KEY, which it
 * refuses; a key cleared stayed in the shell. In memory: a terminal does not
 * outlive Tars.
 */
const ptyKeyPrints = new WeakMap<pty.IPty, string>();

export function notePtyKeys(ptyProcess: pty.IPty, agent: AgentStatus, settings: AppSettings | Partial<AppSettings>): void {
  ptyKeyPrints.set(ptyProcess, keyPrintOf(agent, settings));
}

export function killStalePty(agent: AgentStatus): boolean {
  if (!agent.ptyId) return false;
  const expectedCwd = agent.worktreePath || agent.projectPath;
  const existing = ptyProcesses.get(agent.ptyId);
  const printed = existing ? ptyKeyPrints.get(existing) : undefined;
  const keysStale = printed !== undefined && printed !== keyPrintOf(agent, readAppSettingsFromDisk());
  if (agent.ptyCwd === expectedCwd && !keysStale) return false;
  if (existing) {
    try {
      killPty(existing);
    } catch (err) {
      console.warn(`Failed to kill stale PTY for agent ${agent.id}:`, err);
    }
    ptyProcesses.delete(agent.ptyId);
  }
  console.log(keysStale
    ? `Killed stale PTY for agent ${agent.id}: its CLI's key changed since it was spawned`
    : `Killed stale PTY for agent ${agent.id}: ptyCwd=${agent.ptyCwd} expected=${expectedCwd}`);
  agent.ptyId = undefined;
  agent.ptyCwd = undefined;
  return true;
}

const previousAgentStatus: Map<string, string> = new Map();

const pendingStatusChanges: Map<string, {
  newStatus: string;
  scheduledAt: number;
  timeoutId: NodeJS.Timeout;
}> = new Map();

/** Set by the quit: the terminals it ends must announce nothing while it runs. */
let statusNotificationsStopped = false;

/**
 * The quit's step, before it ends the terminals. On Windows the quit then waits
 * for their exits, up to 5 s more (holdExitUntilTerminalsExit, pty-kill.ts), and
 * each exit is a status change whose announcement could go out during that
 * wait: from here on none is made, and none still pending goes out. darwin and
 * linux end without that wait and keep today's announcements.
 */
export function stopStatusNotifications(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return;
  statusNotificationsStopped = true;
  for (const pending of pendingStatusChanges.values()) clearTimeout(pending.timeoutId);
  pendingStatusChanges.clear();
}

export function handleStatusChangeNotification(
  agent: AgentStatus,
  newStatus: string,
  appSettings: AppSettings,
  sendNotification: (title: string, body: string, agentId?: string, settings?: { notificationsEnabled: boolean }) => void,
  sendTelegramMessage?: (text: string) => void,
  sendSuperAgentResponseToTelegram?: (agent: AgentStatus) => void
) {
  if (statusNotificationsStopped) return;
  const prevStatus = previousAgentStatus.get(agent.id);

  // Out of error: its next error is news for JeanBrasse's reports again.
  if (newStatus !== 'error') agentRecovered(agent.id);

  if (!prevStatus) {
    previousAgentStatus.set(agent.id, newStatus);
    // Every caller calls on a change, so this one is a change too, with the
    // status before it unknown: an agent whose first change after Tars
    // starts is to error was neither notified nor reported (found in the
    // app proof of the event reports). The other statuses stay as they were.
    if (newStatus !== 'error') return;
  }

  if (prevStatus === newStatus) {
    return;
  }

  if (newStatus === 'running') {
    const pending = pendingStatusChanges.get(agent.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingStatusChanges.delete(agent.id);
    }
    previousAgentStatus.set(agent.id, newStatus);
    return;
  }

  const pending = pendingStatusChanges.get(agent.id);

  if (pending && pending.newStatus === newStatus) {
    return;
  }

  if (pending) {
    clearTimeout(pending.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    pendingStatusChanges.delete(agent.id);

    const currentAgent = agents.get(agent.id);
    if (!currentAgent || currentAgent.status !== newStatus) {
      return;
    }

    previousAgentStatus.set(agent.id, newStatus);

    const agentName = currentAgent.name || `Agent ${currentAgent.id.slice(0, 6)}`;
    // Its project's orchestrator and a chat's runner converse with the user,
    // who reads their turns where they happen: no desktop notification for them.
    const conversing = hasOrchestratorPowers(currentAgent);
    // The reply sent back to Telegram is the project's orchestrator's alone,
    // the one the bots write to: never a runner's.
    const isSuper = isSuperAgent(currentAgent);

    if (newStatus === 'waiting') {
      if (!conversing && appSettings.notifyOnWaiting) {
        sendNotification(
          `${agentName} needs your attention`,
          'The agent is waiting for your input.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    } else if (newStatus === 'completed' && appSettings.notifyOnComplete) {
      if (!conversing) {
        sendNotification(
          `${agentName} completed`,
          currentAgent.currentTask ? `Finished: ${currentAgent.currentTask.slice(0, 50)}...` : 'Task completed successfully.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendSuperAgentResponseToTelegram) {
        sendSuperAgentResponseToTelegram(currentAgent);
        superAgentTelegramTask = false;
      }
    }
    // To JeanBrasse's Telegram whatever the desktop switch says: that one is the
    // Mac's, this is his phone's (services/event-reports.ts).
    if (newStatus === 'error') {
      reportEvent({
        kind: 'agent-error',
        agentId: currentAgent.id,
        agentName,
        projectPath: currentAgent.projectPath || '',
        reason: currentAgent.error,
      });
    }
    if (newStatus === 'error' && appSettings.notifyOnError) {
      if (!conversing) {
        sendNotification(
          `${agentName} encountered an error`,
          currentAgent.error || 'An error occurred while running.',
          currentAgent.id,
          appSettings
        );
      }
      if (isSuper && superAgentTelegramTask && sendTelegramMessage) {
        sendTelegramMessage(`🔴 Super Agent error: ${currentAgent.error || 'An error occurred.'}`);
        superAgentTelegramTask = false;
      }
    }
  }, 5000);

  pendingStatusChanges.set(agent.id, {
    newStatus,
    scheduledAt: Date.now(),
    timeoutId,
  });
}

/**
 * On-disk format version. Bumping it lets loadAgents migrate old records
 * deliberately instead of hoping every field happens to still line up.
 * 3: the role is the Orchestrator toggle's, and no longer read from the name
 * (see core/agent-role.ts).
 * 4: an agent's kept output carries no fragment of a key Tars hands Claude
 * Code; a file below it is cleaned once, at load (cleanKeyFragments).
 */
const AGENTS_SCHEMA_VERSION = 4;
const KEY_FRAGMENTS_GONE_SINCE = 4;

/**
 * Retained terminal chunks per agent, bounded. What reads them now is text:
 * the status line, log search, get_agent_output, the overseer and Telegram.
 * A panel is shown the screen from the terminal's mirror instead, which is
 * what this buffer never reliably held after a long turn: see
 * core/terminal-mirror.ts. It is still the replay for a terminal with no
 * mirror, which is why the trim below keeps carrying the modes.
 */
const OUTPUT_CHUNK_CAP = 600;
const OUTPUT_RETAIN = 400;

/**
 * Appends a terminal chunk and keeps the buffer bounded.
 *
 * Five PTY handlers pushed into agent.output and none of them capped it, so a
 * chatty CLI grew that array for the life of the app, once per agent.
 *
 * What is trimmed goes on counting for a replay: the modes it left set, the
 * alternate screen and the mouse request first of all, come back as the first
 * chunk. See terminal-modes.ts.
 */
export function appendAgentOutput(agent: AgentStatus, chunk: string): void {
  agent.output.push(chunk);
  if (agent.output.length > OUTPUT_CHUNK_CAP) {
    const carried = carriedByTrim(agent.output.splice(0, agent.output.length - OUTPUT_RETAIN));
    if (carried) agent.output.unshift(carried);
  }
  markAgentsDirty();
}

interface AgentsFile {
  version: number;
  savedAt: string;
  agents: AgentStatus[];
}

function backupFile(): string {
  return path.join(DATA_DIR, 'agents.backup.json');
}

/**
 * The generation this process wrote last, and the proof it is still on disk.
 *
 * saveAgents kept its backup by reading agents.json back and parsing it, on
 * every single call, only to copy it to agents.backup.json. Measured on
 * 2026-09-18 against a snapshot of the real file (42 agents, 1.06 MB, 87% of
 * it the retained terminal scrollback the Dashboard replays), four interleaved
 * runs of 60 saves each: 6.96 ms a save became 3.30, and at three times the
 * fleet 21.8 ms became 10.7, with the worst call over a run down from 592 ms
 * to 107. Half the cost of a save, and most of its tail, spent re-reading a
 * string we had serialised ourselves one call earlier and written atomically.
 *
 * The parse was not pointless: it is what refuses to copy an unreadable file
 * over the last good one. So it is kept for the only case where it can happen
 * - a file that is not the one we wrote - and the stat taken straight after
 * our own rename is what tells the two apart. Nothing about the atomicity or
 * the mode of either file changes.
 */
let lastWrittenJson: string | undefined;
let lastWrittenStamp: string | undefined;

/** Size, modification time and inode: what changes when anything but our own
 *  rename touches the file, including an in-place rewrite of the same length. */
function fileStamp(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Keep the previous generation, which is all a backup is.
 *
 * Two deliberate equivalences with the read it replaces. A generation with no
 * agents in it is not remembered, so the next save falls back to the read,
 * parses the empty file and leaves the backup alone: deleting every agent
 * still does not destroy the last good copy. And a file whose stamp no longer
 * matches is read and parsed exactly as before, so a truncated agents.json
 * written by anything else is still refused rather than copied over.
 */
function backupPreviousGeneration(): void {
  if (lastWrittenJson !== undefined && lastWrittenStamp !== undefined
      && fileStamp(AGENTS_FILE) === lastWrittenStamp) {
    try {
      fs.writeFileSync(backupFile(), lastWrittenJson);
    } catch {
      // A backup that cannot be written is not a reason to lose the save.
    }
    return;
  }

  if (!fs.existsSync(AGENTS_FILE)) return;
  try {
    const existing = fs.readFileSync(AGENTS_FILE, 'utf-8');
    const existingAgents = parseAgentsFile(existing)?.agents;
    if (existingAgents && existingAgents.length > 0) {
      fs.writeFileSync(backupFile(), existing);
    }
  } catch {
    // An unreadable current file is exactly what the backup protects
    // against: leave the old backup alone.
  }
}

/** Runtime-only fields, stripped before writing. */
function persistable(agent: AgentStatus): AgentStatus {
  return {
    ...agent,
    ptyId: undefined,
    pathMissing: undefined,
    output: agent.output.slice(-100),
    status: agent.status === 'running' ? 'idle' : agent.status,
    // Runtime state, and the command a dialog asks about can carry a secret:
    // agents.json is in every agent's --add-dir (the gate of #172).
    waitingOn: undefined,
    // A wake belongs to its launch, which a restart of Tars does not carry.
    waking: undefined,
  } as AgentStatus;
}

function parseAgentsFile(raw: string): { agents: AgentStatus[]; version: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return { agents: parsed as AgentStatus[], version: 1 };       // v1: bare array
  const file = parsed as Partial<AgentsFile>;
  if (!Array.isArray(file?.agents)) return null;
  return { agents: file.agents, version: typeof file.version === 'number' ? file.version : 1 };
}

/**
 * Writes the agent list.
 *
 * Atomic: a temp file renamed into place, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. The backup is only ever
 * the previous generation, and only ever content known to be readable, so a
 * corrupt current file cannot overwrite the last good copy: see
 * backupPreviousGeneration, which is also where the cost of taking it went.
 */
export function saveAgents() {
  try {
    if (!agentsLoaded) {
      console.log('Skipping save - agents not loaded yet');
      return;
    }

    ensureDataDir();
    const payload: AgentsFile = {
      version: AGENTS_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      agents: Array.from(agents.values()).map(persistable),
    };

    backupPreviousGeneration();

    const json = JSON.stringify(payload, null, 2);
    const tmp = `${AGENTS_FILE}.tmp`;
    fs.writeFileSync(tmp, json);
    renameReplacingSync(tmp, AGENTS_FILE);
    // Remembered only when there is something to lose: see
    // backupPreviousGeneration for why an empty list is deliberately forgotten.
    const remember = payload.agents.length > 0;
    lastWrittenJson = remember ? json : undefined;
    lastWrittenStamp = remember ? fileStamp(AGENTS_FILE) : undefined;
    agentsDirty = false;
  } catch (err) {
    console.error('Failed to save agents:', err);
  }
}

/* ── Periodic flush ────────────────────────────────────────
 * Fields mutated on every PTY chunk (output, statusLine, lastActivity) used
 * to reach disk only when some other action happened to call saveAgents, so
 * a crash lost them. markAgentsDirty + this timer bound that loss.
 */
let agentsDirty = false;
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 30_000;

export function markAgentsDirty(): void {
  agentsDirty = true;
}

export function startAgentAutosave(intervalMs = FLUSH_INTERVAL_MS): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (agentsDirty) saveAgents();
  }, intervalMs);
  flushTimer.unref?.();
}

export function stopAgentAutosave(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

export function loadAgents() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) {
      console.log('No agents file found, starting fresh');
      agentsLoaded = true;
      return;
    }

    const data = fs.readFileSync(AGENTS_FILE, 'utf-8');
    let file = parseAgentsFile(data);

    // Unparseable or empty: fall back to the backup rather than carrying on
    // with an empty map, which the next save would then write over the file.
    if (!file || file.agents.length === 0) {
      const backup = backupFile();
      if (fs.existsSync(backup)) {
        const restored = parseAgentsFile(fs.readFileSync(backup, 'utf-8'));
        if (restored && restored.agents.length > 0) {
          console.warn(`agents.json unusable - restoring ${restored.agents.length} agents from backup`);
          file = restored;
        }
      }
    }

    if (!file) {
      // Keep the unreadable file for inspection instead of silently replacing it.
      try {
        fs.copyFileSync(AGENTS_FILE, `${AGENTS_FILE}.corrupt`);
      } catch { /* best effort */ }
      console.error('agents.json could not be parsed; kept a copy at agents.json.corrupt');
      agentsLoaded = true;
      return;
    }
    const agentsArray = file.agents;

    for (const agent of rolesOnLoad(agentsArray, file.version)) {
      console.warn(`[role] ${agent.name || agent.id} is a worker now: ${agent.projectPath} had another orchestrator, and a project has one`);
    }

    for (const agent of agentsArray) {
      const workingPath = agent.worktreePath || agent.projectPath;
      if (!fs.existsSync(workingPath)) {
        console.warn(`Agent ${agent.id} has missing path: ${workingPath} - marking as pathMissing`);
        agent.pathMissing = true;
      } else {
        agent.pathMissing = false;
      }

      // A stopped agent stays stopped across a restart, with who, when and
      // why, or the Dashboard resumes it at launch like any idle one. An
      // asleep one stays asleep, with since when: its conversation is kept,
      // and the first message wakes it on it (core/agent-asleep.ts).
      if (agent.status !== 'stopped' && agent.status !== 'asleep') agent.status = 'idle';
      agent.waking = undefined;
      agent.ptyId = undefined;
      agent.ptyCwd = undefined;
      agent.pendingDelivery = undefined;
      // Runtime only: a stall is measured on a live CLI (services/stall-watch.ts),
      // and what a Stop hook counted inside one died with it.
      agent.stalledSince = undefined;
      // A permission question held for the window died with the CLI that asked.
      agent.permissionAsk = undefined;
      agent.restPending = undefined;
      // `output` is typed as required but is runtime state: nothing writes it
      // to agents.json, so every agent read back from disk arrives without it.
      // Consumers that trusted the type crashed - fleetSummary did
      // `agent.output.length`, which took down the whole Logs page for anyone
      // who had agents and restarted the app.
      agent.output = Array.isArray(agent.output) ? agent.output : [];
      // `skills` has the same shape of problem and was left out of that fix.
      // It IS written to agents.json, but only by versions that had the field,
      // so a file from an older build, a hand edit, or a restored backup
      // arrives without it. Every provider's getPtyEnvVars opens with
      // `skills.join(',')`, so `agent:start` threw "Cannot read properties of
      // undefined (reading 'join')" and the agent simply never started, with
      // the reason buried in an IPC rejection.
      // And only names: every task opens with the skills, and one saved before
      // names were checked, or written in by hand, would open each of them
      // with whatever it says (the Audit's gate of #204).
      // Said, naming the agent and what goes, since the next save makes it final.
      const saved: unknown[] = Array.isArray(agent.skills) ? agent.skills : [];
      agent.skills = saved.filter(isSkillName);
      if (agent.skills.length !== saved.length) {
        const dropped = saved.filter(skill => !isSkillName(skill)).map(quoted).join(', ');
        console.warn(`[agents] ${quoted(agent.name || agent.id)}: skills dropped, not skill names: ${dropped}`);
      }
      // Session ownership is runtime state: any persisted session died with
      // the previous app run, and keeping it would make the stale-session
      // guard reject the next real session's hooks (and /health lie).
      agent.currentSessionId = undefined;
      agent.lastKilledSessionId = undefined;
      // resumableSessionId is deliberately kept: it is not ownership, it is
      // the only record of where this agent's conversation got to, and losing
      // it on load is what made every restart throw the work away.
      agent.waitingReason = undefined;

      // Migrate legacy skipPermissions boolean → permissionMode
      if (!agent.permissionMode) {
        agent.permissionMode = agent.skipPermissions ? 'auto' : 'normal';
      }

      // Backfill createdAt for legacy agents using lastActivity
      if (!agent.createdAt) {
        agent.createdAt = agent.lastActivity || new Date().toISOString();
      }

      agents.set(agent.id, agent);
    }

    console.log(`Loaded ${agents.size} agents from disk`);
    agentsLoaded = true;
    if (file.version < KEY_FRAGMENTS_GONE_SINCE) cleanKeyFragments();
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsLoaded = true;
  }
}

/**
 * Once, at the first load of a file from before 2.0.4 (the Audit's M2 on #458):
 * what Claude Code's question about a key provider's key left, its last 20
 * characters, in the agents' kept output, here and in the backup, and in the
 * rejected list of every .claude.json (core/key-fragments.ts). Saved at once,
 * at version 4, so the next load does not do it again. Says how many, never
 * what.
 */
function cleanKeyFragments(): void {
  let token: string | undefined;
  try { token = fs.readFileSync(API_TOKEN_FILE, 'utf-8').trim() || undefined; } catch { /* none yet */ }
  const keys = keysHandedToClaude(readAppSettingsFromDisk(), token);
  let masked = 0;
  for (const agent of agents.values()) {
    const result = maskKeyFragments(agent.output, keys);
    if (result.masked) {
      agent.output = result.chunks;
      masked += result.masked;
    }
  }
  saveAgents();
  // The backup this save has just filled with the generation before it.
  let inBackup = 0;
  const file = backupFile();
  try {
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown : undefined;
    const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown } | undefined)?.agents;
    for (const a of Array.isArray(list) ? list as Array<{ output?: unknown }> : []) {
      const result = maskKeyFragments(Array.isArray(a.output) ? a.output as string[] : [], keys);
      if (result.masked) {
        a.output = result.chunks;
        inBackup += result.masked;
      }
    }
    if (inBackup) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
      renameReplacingSync(tmp, file);
    }
  } catch (err) {
    console.warn(`[key-fragments] ${file} could not be cleaned: ${err instanceof Error ? err.message : String(err)}`);
  }
  const configs = dropRejectedTails(keys);
  if (masked || inBackup || configs) {
    console.log(`[key-fragments] masked ${masked} key fragment(s) in the agents' kept output and ${inBackup} in its backup, and took Tars's keys out of the rejected list of ${configs} .claude.json file(s)`);
  }
}

/**
 * One spawn at a time, per agent.
 *
 * Seven places do the same thing: check `!agent.ptyId || !ptyProcesses.has(...)`,
 * await initAgentPty, then set agent.ptyId. The await is a genuine suspension
 * point (spawnAgentSession waits on the memory digest for every non-Claude CLI),
 * so two callers can both pass the check before either has set the id and both
 * spawn, orphaning the first process. A double-clicked Start button does it; so
 * does a renderer resume racing an MCP delegate_task.
 *
 * That was fixed once, on the three HTTP routes, with a lock local to
 * agent-routes.ts. The IPC handler, the Super Agent path, the Telegram bot and
 * the Slack bot were left with the same shape, which a verifying agent then
 * reproduced: two concurrent `agent:start` calls, two spawns.
 *
 * So the lock lives here instead, around the one function that actually spawns.
 * Every caller gets it whether or not it knows to ask, and a caller that arrives
 * while a live PTY already exists is handed that one rather than a second.
 */
const ptyInitLocks = new Map<string, Promise<string>>();


/**
 * How long a session has to actually begin its task before it is disbelieved.
 *
 * Ten minutes, and the number is measured rather than picked. A warm start
 * registers in about 1.4 seconds. A start with the network unreachable takes
 * 77 seconds. And a start against a socket that accepts but never answers, the
 * "Checking for updates" case JeanBrasse actually hit, had still not registered
 * after 400 seconds while being perfectly healthy. Ninety seconds would have
 * accused that agent, which is the error this whole check calls the worse one.
 *
 * Ten minutes is 400 times a normal start and about 8 times the worst slow
 * start that does eventually arrive. The failure it looks for lasted hours, so
 * waiting ten minutes to name it gives up almost none of the value.
 */
const TASK_START_GRACE_MS = 600_000;

/**
 * Notice a session that came up and never took its task.
 *
 * JeanBrasse watched an agent sit at a Claude Code banner with an empty prompt,
 * marked `running`, for hours. Nothing was wrong with the process: it was
 * alive, it had a pty. It simply had no task, and every surface that could
 * have said so was reporting that it was working. That is the half that makes
 * the failure expensive: an agent that is stuck and an agent that is thinking
 * look identical from outside, so nobody looks.
 *
 * Lives here rather than beside one spawn site because the fault belongs to
 * the agent, not to the route that started it. An agent started from the
 * Agents page, from Telegram or from Slack goes nowhere near the API, and was
 * left unwatched while being exactly as capable of sitting there doing
 * nothing.
 *
 * Only for the CLIs that register at all. A session that has started its work
 * registers through the SessionStart hook, which is what sets
 * `currentSessionId`. The thirteen alternative providers run the same claude
 * binary with a different base url, so they register too; the handful that do
 * not are left alone rather than accused of a fault this cannot see. Being
 * wrong that way costs a missed report, being wrong the other way marks a
 * working agent broken.
 *
 * Registration is where this check ends and the delivery check begins. "It
 * registered, so it took its task" was never true: a CLI handed a task it never
 * received registers exactly the same way, about a second in, which is the
 * failure that hid behind this watch for weeks. With a task to deliver, the
 * agent now carries it until a turn actually starts. See noteSessionRegistered.
 */
export function armTaskStartWatch(agent: AgentStatus, ptyId: string | undefined, task?: string): void {
  if (!ptyId) return;
  if (!hasClaudeHooks(agent)) return;

  // Only a real task is worth confirming: a start with none has nothing to lose.
  agent.pendingDelivery = task && task.trim()
    ? { ptyId, task, dispatchedAt: new Date().toISOString() }
    : undefined;

  // The question this watch asks is "has a session registered since I armed",
  // and it used to ask it by emptying `currentSessionId` and seeing whether
  // anything filled it back in. That worked, and it cost far too much. Seven
  // callers arm this; only one, spawnAgentSession, has just ended the previous
  // session and laid its tombstone. The other six reuse a pty whose session is
  // alive and working. Emptying the field left that agent with no owner while
  // it worked, so the stale-session guard had nothing to compare against and
  // ownership went to whichever session posted next. It was restored only if a
  // UserPromptSubmit arrived; when none did, the agent worked on while
  // everything it said was dropped as unowned, and then this very watch
  // accused it of never having started.
  //
  // The question is asked directly now, and nothing is erased. Two facts
  // answer it, and either means the task landed: a session registered after
  // this moment, or a turn began after it. The first is the spawn, where a new
  // session is coming. The second is a dispatch typed into a session already
  // live, where no registration is ever coming and the turn is the only
  // evidence there will be. spawnAgentSession still clears the field a few
  // statements earlier, for its own reason: it really did end that session.
  const armedAt = Date.now();

  // Is the session that owns this agent still alive? It is, only if it claimed
  // the agent from the pty being armed. An id that was registered from an
  // older pty is left over from a session that died with it, and the two look
  // identical on the agent, which is why this used to be cleared every time.
  //
  // Cleared when it is stale, because it is: the guard would otherwise reject
  // the new session's own hooks as coming from the wrong session, which is the
  // failure this whole contract exists to prevent. Kept when it is live,
  // because erasing it is what left six of the seven callers dispatching into
  // an agent that then had no owner at all while it worked.
  const ownerIsLive = !!agent.currentSessionId && agent.sessionPtyId === ptyId;
  if (!ownerIsLive) {
    agent.currentSessionId = undefined;
  }
  const ownerAtArming = agent.currentSessionId;
  // Who delivered the task (2.0.4): an agent's tool, through the API, makes its never starting that tool's error.
  const deliveredBy = currentApiCall();

  const timer = setTimeout(() => {
    const live = agents.get(agent.id);
    // Replaced by a newer start, or gone: not this session's business.
    if (!live || live.ptyId !== ptyId) return;
    // Already exited: onExit owns that outcome and knows the exit code.
    if (!ptyProcesses.has(ptyId)) return;
    // It took its task: a session claimed the agent after this armed, or a
    // turn began after it. Either is proof, and neither needs the ownership
    // field to have been emptied first.
    if (live.currentSessionId && live.currentSessionId !== ownerAtArming) return;
    const registeredAt = live.sessionRegisteredAt ? Date.parse(live.sessionRegisteredAt) : 0;
    const turnStartedAt = live.lastTurnStartedAt ? Date.parse(live.lastTurnStartedAt) : 0;
    if (registeredAt > armedAt || turnStartedAt > armedAt) return;
    // It moved on by itself, to waiting or completed or error.
    if (live.status !== 'running') return;

    console.error(
      `[agent] ${live.name || live.id} has been running for `
      + `${Math.round(TASK_START_GRACE_MS / 1000)}s without starting a turn: the task never reached the CLI`,
    );
    live.status = 'error';
    live.error = 'The CLI started but never began the task, so nothing was run. '
      + 'The session is open and idle; send the task again.';
    live.lastActivity = new Date().toISOString();
    saveAgents();
    // Two audiences, two channels, and the interface is the one that was
    // missing. scheduleTick is what the Agents page and the tray read, so
    // without it the card kept saying "working", which is the whole of what
    // JeanBrasse was looking at. emitAgentStatus is what /wait and the orchestrator
    // that dispatched it hang off.
    scheduleTick();
    emitAgentStatus(live.id);
    // And in the reports, when they are on: never the agent's name or the task's words.
    const cli = getProvider(live.provider).id;
    if (deliveredBy?.fromMcp && deliveredBy.agentId) {
      reportAgentToolError({ code: 'never-started', tool: deliveredBy.tool ?? UNKNOWN_TOOL, cli });
    } else {
      reportHandledError(taskNeverStarted(cli, TASK_START_GRACE_MS));
    }
  }, TASK_START_GRACE_MS);
  // A pending check must never be the reason the app cannot quit.
  timer.unref();
}

/**
 * How long a registered session has to begin its turn before the task is taken
 * to have been lost on the way in.
 *
 * Measured the same way as the grace period above, by replaying
 * spawnAgentSession in a pty: once the SessionStart hook has registered, a
 * session that did receive its task starts the turn in 0.32 to 1.24 seconds
 * (median 0.73, thirty turns), with the full MCP configuration, with a three
 * thousand character task, cold or warm. Fifteen seconds is twelve times the
 * worst of those.
 *
 * Anchored on registration rather than on the spawn, deliberately: reaching
 * registration is the part that takes 77 seconds on a dead network and can take
 * forever against a socket that never answers, and that phase belongs to
 * TASK_START_GRACE_MS. This one only measures a CLI that is already up.
 */
const TURN_START_BOUND_MS = 15_000;

/**
 * A session registered itself through the SessionStart hook.
 *
 * All this starts is the clock on the delivery it was spawned for. Nothing here
 * treats registration as evidence that the task arrived.
 */
export function noteSessionRegistered(agent: AgentStatus): void {
  const pending = agent.pendingDelivery;
  if (!pending || !agent.ptyId || pending.ptyId !== agent.ptyId) return;
  // SessionStart arrives more than once. session-start.sh retries its POST
  // when the reply comes back empty, which is what happens when curl gives up
  // waiting for a response the server has already acted on, so two
  // registrations for one session is a normal Tuesday rather than an edge
  // case. Two registrations used to arm two timers: the first redelivered and
  // set `retried`, and the second read that flag a second later and went
  // straight to `error` while the redelivery was still landing. Tars called a
  // working agent dead, and its own retry was the trigger.
  if (pending.checkArmed) return;
  pending.checkArmed = true;
  scheduleDeliveryCheck(agent.id, pending.ptyId);
}

/**
 * The current session started a turn, from the UserPromptSubmit hook: the only
 * evidence Tars has that a task actually reached the CLI.
 */
export function noteTurnStarted(agent: AgentStatus): void {
  agent.lastTurnStartedAt = new Date().toISOString();
  agent.pendingDelivery = undefined;
  // Whatever stopped the last turn is not what this agent is doing now. Kept,
  // it would be shown again the next time the agent lands in `error` for a
  // reason that carries no text of its own, such as its process exiting: a
  // login that was fixed an hour ago offered as the cause of a crash.
  agent.error = undefined;
}

/**
 * How long the check keeps asking, for a CLI that neither takes its task nor says it is idle: then it stops,
 * typing nothing and accusing nothing. Two hours, well past the 36 s hooks of a loaded machine.
 */
const DELIVERY_ASK_FOR_MS = 2 * 60 * 60_000;

/**
 * Confirm the delivery, and send it a second way before giving up.
 *
 * The second way is the one that has always worked: typing into the live
 * session, which is what /dispatch does to an agent that is already running.
 * Only on proof that the CLI dropped it (core/delivery-proof.ts): it said it is
 * idle at its prompt, and nothing of the task is on its record. The clock alone
 * typed tasks a second time into CLIs still running their hooks, which ran
 * them twice (the DB brief fix-twin-deliveries-2810.md). Until then, it asks
 * again every TURN_START_BOUND_MS.
 */
function scheduleDeliveryCheck(agentId: string, ptyId: string): void {
  const timer = setTimeout(() => {
    const live = agents.get(agentId);
    if (!live) return;
    const pending = live.pendingDelivery;
    // A turn started, or a newer start replaced this one: not this task's business.
    if (!pending || pending.ptyId !== ptyId || live.ptyId !== ptyId) return;
    // This one has fired: nothing is armed until something arms it again.
    pending.checkArmed = false;
    const ptyProcess = ptyProcesses.get(ptyId);
    // The process is gone: onExit owns that outcome and knows the exit code.
    if (!ptyProcess) return;
    const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
    const registeredAt = time(live.sessionRegisteredAt);
    const verdict = deliveryVerdict({
      registeredAt: Number.isFinite(registeredAt) ? registeredAt : time(pending.dispatchedAt),
      turnStartedAt: Number.isFinite(time(live.lastTurnStartedAt)) ? time(live.lastTurnStartedAt) : undefined,
      idlePromptAt: Number.isFinite(time(live.idlePromptAt)) ? time(live.idlePromptAt) : undefined,
      retypedAt: Number.isFinite(time(pending.retypedAt)) ? time(pending.retypedAt) : undefined,
      onRecord: taskOnRecord(sessionTail(live), pending.task),
    });
    if (verdict === 'taken') {
      // In, late: its turn's own post had not landed, or the CLI holds it queued. Nobody is told it never began.
      console.log(`[agent] ${live.name || live.id}'s task is on its CLI's record: taken, nothing typed again`);
      live.pendingDelivery = undefined;
      saveAgents();
      return;
    }
    if (verdict === 'wait') {
      // Not idle at its prompt since: its hooks still run, or it works. Asked again later; nothing typed, nobody accused.
      if (Date.now() - time(pending.dispatchedAt) < DELIVERY_ASK_FOR_MS) {
        pending.checkArmed = true;
        scheduleDeliveryCheck(agentId, ptyId);
      } else {
        // Given up, and said: never a silent drop, and never "it never began", which it may have (the Audit's Low on #549).
        console.warn(`[agent] ${live.name || live.id} has neither taken its task nor said it is idle in ${DELIVERY_ASK_FOR_MS / 60_000} minutes: no longer asked, nothing typed again`);
        live.pendingDelivery = undefined;
        saveAgents();
        const settings = readAppSettingsFromDisk();
        sendNotification(
          `${live.name || 'An agent'}: its start could not be confirmed`,
          `Tars could not confirm in ${DELIVERY_ASK_FOR_MS / 3_600_000} hours that it began its task. It may have run: look at its terminal before sending it again.`,
          live.id, { ...settings, notificationsEnabled: settings.notificationsEnabled === true },
        );
        // agent-watch reads this module: imported when needed.
        void import('../services/agent-watch').then((watch) => watch.tellStartUnconfirmed(live.id));
      }
      return;
    }
    // A blocking permission dialog reads typed text as its answer, so a
    // redelivery there would accept the dialog rather than deliver anything.
    if (dialogOpen(live)) {
      pending.checkArmed = true;
      scheduleDeliveryCheck(agentId, ptyId);
      return;
    }

    if (verdict === 'retype' && !pending.retried) {
      console.warn(
        `[agent] ${live.name || live.id} is idle at its prompt with nothing of its task on record: `
        + 'typing the task into the live session',
      );
      pending.retried = true;
      pending.retypedAt = new Date().toISOString();
      live.lastActivity = new Date().toISOString();
      saveAgents();
      const outcome = writeProgrammaticInput(ptyProcess, pending.task, true, {
        agentId: live.id,
        from: 'Tars',
        sender: { kind: 'tars' },
        // Armed when the task is actually typed in, not when it was handed
        // over. A write waiting behind somebody's half-written sentence would
        // otherwise be counted as delivered, and the agent accused a minute
        // later of never having taken a task that had not been typed yet.
        onWritten: () => {
          pending.checkArmed = true;
          scheduleDeliveryCheck(agentId, ptyId);
        },
      });
      if (outcome === 'held') {
        console.warn(
          `[agent] the task for ${live.name || live.id} is waiting for the draft in its terminal; `
          + 'it goes in when that field is free',
        );
      }
      return;
    }

    console.error(
      `[agent] ${live.name || live.id} never started a turn: idle at its prompt twice, nothing of the task on its record, `
      + 'neither as an argument nor typed in',
    );
    live.pendingDelivery = undefined;
    live.status = 'error';
    live.error = 'The session came up but never took the task, which was sent twice: on the command '
      + 'line, then typed into the session. Nothing was run, and the session is still open.';
    live.lastActivity = new Date().toISOString();
    saveAgents();
    scheduleTick();
    emitAgentStatus(live.id);
  }, TURN_START_BOUND_MS);
  // A pending check must never be the reason the app cannot quit.
  timer.unref();
}

export async function initAgentPty(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  const inFlight = ptyInitLocks.get(agent.id);
  if (inFlight) return inFlight;

  const run = initAgentPtyLocked(agent, mainWindow, handleStatusChangeNotificationCallback, saveAgentsCallback);
  // Cleared however it ends, so a failed spawn does not wedge the agent.
  ptyInitLocks.set(agent.id, run);
  try {
    return await run;
  } finally {
    if (ptyInitLocks.get(agent.id) === run) ptyInitLocks.delete(agent.id);
  }
}

/**
 * The CLI initAgentPty starts in place of a shell, handed over by
 * startCliInTerminal and taken once. Keyed by the agent record because every
 * caller reaches initAgentPty through a wrapper that passes the agent alone
 * (main.ts, the bots, the IPC handlers).
 */
const cliToStart = new WeakMap<AgentStatus, DirectLaunch>();

/** What startCliInTerminal needs from its caller: the live map and the one way a terminal is opened. */
export interface AgentTerminals {
  ptyProcesses: Map<string, pty.IPty>;
  initAgentPty: (agent: AgentStatus) => Promise<string>;
}

/**
 * Why a start may not replace the shell an agent waits in on Windows, or
 * undefined when it may.
 *
 * Nothing Tars starts runs in that shell there (a start replaces it, see
 * startCliInTerminal), and node-pty cannot say what does (cliRunningIn), but a
 * person can type a CLI into it by hand. When that CLI registered its session
 * from this very terminal, killing the shell ends a live session without the
 * tombstone spawnAgentSession lays, and its hooks go on posting into the next
 * one. Refused, as a start is on macOS when a CLI runs in the terminal. A CLI
 * typed by hand that registers no session (codex, gemini) cannot be seen, and
 * is killed with the shell: a known Windows limit.
 */
export function cliStartRefusal(
  agent: AgentStatus,
  start: Pick<Launch, 'platform'> | NodeJS.Platform = process.platform,
): string | undefined {
  if ((typeof start === 'string' ? start : start.platform) !== 'win32') return undefined;
  if (!agent.ptyId || !agent.currentSessionId || agent.sessionPtyId !== agent.ptyId) return undefined;
  return `${agent.name || agent.id} has a CLI session typed into its terminal by hand. Nothing was started: stop the agent first, or give it the task in its terminal.`;
}

/**
 * Start an agent's CLI as its terminal's own process, where darwin and linux
 * type the launch line into the shell waiting there (win32).
 *
 * Nothing is typed on Windows: a line typed into PowerShell runs each line of
 * a multi-line prompt as a command, and PowerShell 5.1 has no `&&`. So the waiting shell is killed and the terminal opened again
 * through initAgentPty, the one function that spawns an agent's terminal,
 * with the CLI as its process, in the launch's folder and environment.
 * Refused, with the shell left alone, when cliStartRefusal says so.
 *
 * The agent names no terminal while its shell is killed: every onExit of an
 * agent terminal acts only for the terminal its agent names, and the shell
 * ending is not the agent stopping.
 */
export async function startCliInTerminal(
  agent: AgentStatus,
  launch: DirectLaunch,
  deps: AgentTerminals,
): Promise<pty.IPty> {
  const refused = cliStartRefusal(agent, launch);
  if (refused) throw new Error(refused);
  const shellId = agent.ptyId;
  const shell = shellId ? deps.ptyProcesses.get(shellId) : undefined;
  if (shellId) deps.ptyProcesses.delete(shellId);
  agent.ptyId = undefined;
  if (shell) killPty(shell);

  cliToStart.set(agent, launch);
  let opened: string;
  try {
    opened = await deps.initAgentPty(agent);
  } catch (err) {
    cliToStart.delete(agent);
    throw err;
  }
  agent.ptyId = opened;
  // Still here, initAgentPty never took it: it handed back the terminal a call
  // before this one was already opening, a shell, not this CLI.
  if (cliToStart.delete(agent)) {
    throw new Error(
      `${agent.name || agent.id}: another terminal was being opened for this agent, so its CLI was not started. Start it again.`,
    );
  }
  const cli = deps.ptyProcesses.get(agent.ptyId);
  if (!cli) throw new Error(`${agent.name || agent.id}: the terminal of its CLI is gone as soon as it was opened.`);
  return cli;
}

/**
 * Start the command a launch describes in the agent's terminal, and return the
 * terminal it runs in. darwin/linux: typed into the shell waiting there, once
 * `ready` resolves or `delayMs` has passed, as each caller always waited.
 * win32: the CLI replaces that shell (startCliInTerminal), nothing typed.
 */
export async function launchIntoTerminal(
  agent: AgentStatus,
  ptyProcess: pty.IPty,
  start: Launch,
  opts: AgentTerminals & { delayMs?: number; ready?: (ptyProcess: pty.IPty) => Promise<void> },
): Promise<pty.IPty> {
  // A CLI started here owes nothing of one started before it in this terminal:
  // a bot's relaunch carries the guide section in its command, and the next
  // message gave it again, with the memory as it was then (the Audit's L-B and
  // QA's L1 on #448). A launch that owes it says so after (startAgentCli).
  oweToFirstMessage(ptyProcess, '');
  if (start.platform === 'win32') return startCliInTerminal(agent, start, opts);
  if (opts.ready) await opts.ready(ptyProcess);
  // codex typed into a shell already there, one reused too: noted as it starts (core/agent-pty.ts).
  if (getProvider(agent.provider).binaryName === 'codex') codexLaunching(agent.id, start.cwd);
  if (opts.delayMs) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        writeProgrammaticInput(ptyProcess, start.typedLine);
        resolve();
      }, opts.delayMs);
    });
  } else {
    writeProgrammaticInput(ptyProcess, start.typedLine);
  }
  return ptyProcess;
}

async function initAgentPtyLocked(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  // Re-check under the lock: the caller's check happened before it queued here,
  // and the call it was queued behind may have just created the PTY it wanted.
  if (agent.ptyId && ptyProcesses.has(agent.ptyId)) return agent.ptyId;

  const cli = cliToStart.get(agent);
  cliToStart.delete(agent);
  const { ptyProcess, cwd } = cli ? spawnCli(agent, cli) : await spawnShell(agent);

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  agent.ptyCwd = cwd;
  // A terminal again: a stop is over (core/agent-stop.ts), and a sleep too,
  // the agent waking until its CLI is up (core/agent-asleep.ts).
  clearStop(agent);
  wakeFromSleep(agent);

  attachAgentTerminal(agent, ptyId, ptyProcess, handleStatusChangeNotificationCallback, saveAgentsCallback);
  return ptyId;
}

/** The CLI as the terminal's process, with the launch's folder and environment (win32: nothing is typed into a shell). */
function spawnCli(agent: AgentStatus, launch: DirectLaunch): { ptyProcess: pty.IPty; cwd: string } {
  ensureProjectTrusted(launch.cwd);
  console.log(`Starting the CLI of agent ${agent.id} in ${launch.cwd}: ${launch.file}`);
  const ptyProcess = spawnAgentPty({
    binaryName: getProvider(agent.provider).binaryName,
    shell: launch.file,
    args: launch.commandLine,
    runsCommand: true,
    cols: 120,
    rows: 30,
    cwd: launch.cwd,
    env: launch.env,
  });
  return { ptyProcess, cwd: launch.cwd };
}

/** The shell an agent's terminal waits in, with the environment its CLI will have. */
async function spawnShell(agent: AgentStatus): Promise<{ ptyProcess: pty.IPty; cwd: string }> {
  let cwd = agent.worktreePath || agent.projectPath;

  if (!fs.existsSync(cwd)) {
    console.warn(`Agent ${agent.id} cwd does not exist: ${cwd}. Falling back to home directory`);
    cwd = os.homedir();
  }

  // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd so
  // bypass-mode agents never see the first-launch prompt.
  ensureProjectTrusted(cwd);

  console.log(`Initializing PTY for restored agent ${agent.id} in ${cwd}`);

  // Build PATH that includes user-configured paths, nvm, and other common locations for claude
  const cliExtraPaths: string[] = [];
  // With their keys, from ~/.tars-private since 2.0.4 (services/settings-secrets.ts):
  // app-settings.json alone holds none, and the terminal's environment needs them.
  const savedSettings = readAppSettingsFromDisk() as Record<string, unknown>;
  cliExtraPaths.push(...cliPathDirs(savedSettings.cliPaths as Record<string, unknown> | undefined));
  const fullPath = buildFullPath(cliExtraPaths);

  // For local provider, bake Tasmania env vars into the PTY process environment
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        const localModel = agent.localModel || tasmaniaStatus.modelName || 'default';
        // Strip /v1 suffix: Claude Code SDK appends /v1/messages itself
        const baseUrl = tasmaniaStatus.endpoint!.replace(/\/v1\/?$/, '');
        tasmaniaEnv = {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_MODEL: localModel,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        console.warn(`Agent ${agent.id} is local provider but Tasmania is not running. PTY created without Tasmania env vars`);
      }
    } catch (err) {
      console.warn(`Failed to get Tasmania status for agent ${agent.id}:`, err);
    }
  }

  // Get provider-specific env vars. Pass loaded savedSettings so alt
  // providers (OpenRouter, DeepSeek, etc.) can inject ANTHROPIC_BASE_URL
  // and ANTHROPIC_API_KEY from the configured API keys.
  const agentProvider = getProvider(agent.provider);
  const providerEnvVars = agentProvider.getPtyEnvVars(
    agent.id,
    agent.projectPath,
    agent.skills,
    savedSettings as unknown as AppSettings,
    { model: agent.model, effort: agent.effort },
  );

  const ptyProcess = spawnAgentPty({
    binaryName: agentProvider.binaryName,
    ...agentShell({ setting: savedSettings.terminalShell as string | undefined }),
    runsCommand: false,
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...withPath(process.env, fullPath, process.platform),
      ...providerEnvVars,
      // CLAUDE_MGR_API_URL is imposed by spawnAgentPty, on the one line that
      // starts a process, so the API-driven spawn cannot miss it as it did.
      // Load CLAUDE.md from --add-dir directories (e.g. ~/.tars)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...tasmaniaEnv,
    },
  });
  // The keys this shell's environment carries, for a start that reuses it.
  notePtyKeys(ptyProcess, agent, savedSettings as unknown as AppSettings);
  return { ptyProcess, cwd };
}

/** What an agent terminal's output and exit do, whichever process it runs. */
function attachAgentTerminal(
  agent: AgentStatus,
  ptyId: string,
  ptyProcess: pty.IPty,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void,
): void {
  ptyProcess.onData((data) => {
    const agentData = agents.get(agent.id);
    if (agentData) {
      appendAgentOutput(agentData, data);
      agentData.lastActivity = new Date().toISOString();
      agentData.statusLine = extractStatusLine(agentData.output);

      if (superAgentTelegramTask && isSuperAgent(agentData)) {
        superAgentOutputBuffer.push(data);
        if (superAgentOutputBuffer.length > 200) {
          superAgentOutputBuffer = superAgentOutputBuffer.slice(-100);
        }
      }
    }
    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: agent.id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`Agent ${agent.id} PTY exited with code ${exitCode}`);
    ptyProcesses.delete(ptyId);
    // Ended by the quit: neither the agent's completion nor its error, and
    // the closing window is not told it was (the Audit's gate of #235).
    const newStatus = agentStatusOnExit(exitCode);
    if (!newStatus) return;
    const agentData = agents.get(agent.id);
    // Only while this terminal is still the agent's. A restart ends the old
    // one after the new one has started, and a stop clears it before it ends
    // it: neither is the agent's news, and the agent:complete made the window
    // move its current task to done (the Frontend's finding of 05/10). The
    // window reads who stopped an agent on the stop's own status event (#329).
    if (!agentData || agentData.ptyId !== ptyId) return;
    agentData.status = newStatus;
    agentData.lastActivity = new Date().toISOString();
    handleStatusChangeNotificationCallback(agentData, newStatus);
    saveAgentsCallback();
    broadcastToAllWindows('agent:complete', {
      type: 'complete',
      agentId: agent.id,
      ptyId,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });
}
