import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrowserWindow, Notification } from 'electron';
import { AgentStatus, AppSettings } from '../types';
import { broadcastToAllWindows } from '../utils/broadcast';
import { AGENTS_FILE, DATA_DIR, dataPath } from '../constants';
import { ensureDataDir, isSuperAgent } from '../utils';
import { isSkillName } from '../utils/skill-name';
import { quoted } from '../utils/reveal';
import { rolesOnLoad } from './agent-role';
import { ptyProcesses, setDialogProbe, writeProgrammaticInput } from './pty-manager';
import { dialogOpen, dialogShown } from './agent-launch';
import { spawnAgentPty } from './agent-pty';
import { buildFullPath } from '../utils/path-builder';
import { cliPathDirs } from '../utils/cli-path-dirs';
import { getProvider } from '../providers';
import { extractStatusLine } from '../utils/ansi';
import { carriedByTrim } from '../utils/terminal-modes';
import { updateSharedJsonSync } from '../utils/shared-file';
import { scheduleTick } from '../utils/agents-tick';
import { getTasmaniaStatus } from '../services/tasmania-client';
import { emitAgentStatus } from '../services/agent-events';

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
  setDialogProbe(agentId => {
    const agent = agents.get(agentId);
    return !!agent && dialogShown(agent, agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);
  });
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

  try {
    const outcome = updateSharedJsonSync<ClaudeConfig>(claudeJsonPath, config => {
      const existing = config?.projects?.[projectPath] ?? {};
      if (existing.hasTrustDialogAccepted === true) return undefined;
      return {
        ...config,
        projects: {
          ...config?.projects,
          [projectPath]: {
            ...existing,
            hasTrustDialogAccepted: true,
            projectOnboardingSeenCount: existing.projectOnboardingSeenCount ?? 1,
          },
        },
      };
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

/**
 * Whether marking this directory trusted would trust far more than a project.
 *
 * Claude Code reads `hasTrustDialogAccepted` for its working directory and
 * every directory above it, so the flag on $HOME trusts everything the account
 * owns and the flag on `/` trusts the machine. Refused: the root, the home
 * directory, anything above it, and a relative path, which names whatever the
 * app's working directory happens to be. Compared by the path given and by the
 * path the filesystem resolves, which follows a link and, on macOS, gives the
 * case the disk stores, so neither a link nor another spelling gets through.
 * Claude Code then shows its own dialog, which is the point of it.
 */
function trustsTooMuch(projectPath: string): boolean {
  if (!path.isAbsolute(projectPath)) return true;
  const spellings = (p: string) => {
    const resolved = path.resolve(p);
    try {
      return [resolved, fs.realpathSync.native(resolved)];
    } catch {
      return [resolved];
    }
  };
  const homes = spellings(os.homedir());
  return spellings(projectPath).some(dir =>
    dir === path.parse(dir).root
    || homes.some(home => home === dir || home.startsWith(dir + path.sep)));
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
export function killStalePty(agent: AgentStatus): boolean {
  if (!agent.ptyId) return false;
  const expectedCwd = agent.worktreePath || agent.projectPath;
  if (agent.ptyCwd === expectedCwd) return false;
  const existing = ptyProcesses.get(agent.ptyId);
  if (existing) {
    try {
      existing.kill();
    } catch (err) {
      console.warn(`Failed to kill stale PTY for agent ${agent.id}:`, err);
    }
    ptyProcesses.delete(agent.ptyId);
  }
  console.log(
    `Killed stale PTY for agent ${agent.id}: ptyCwd=${agent.ptyCwd} expected=${expectedCwd}`
  );
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

export function handleStatusChangeNotification(
  agent: AgentStatus,
  newStatus: string,
  appSettings: AppSettings,
  sendNotification: (title: string, body: string, agentId?: string, settings?: { notificationsEnabled: boolean }) => void,
  sendTelegramMessage?: (text: string) => void,
  sendSuperAgentResponseToTelegram?: (agent: AgentStatus) => void
) {
  const prevStatus = previousAgentStatus.get(agent.id);

  if (!prevStatus) {
    previousAgentStatus.set(agent.id, newStatus);
    return;
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
    const isSuper = isSuperAgent(currentAgent);

    if (newStatus === 'waiting') {
      if (!isSuper && appSettings.notifyOnWaiting) {
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
      if (!isSuper) {
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
    } else if (newStatus === 'error' && appSettings.notifyOnError) {
      if (!isSuper) {
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
 */
const AGENTS_SCHEMA_VERSION = 3;

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
    fs.renameSync(tmp, AGENTS_FILE);
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

      agent.status = 'idle';
      agent.ptyId = undefined;
      agent.ptyCwd = undefined;
      agent.pendingDelivery = undefined;
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
  } catch (err) {
    console.error('Failed to load agents:', err);
    agentsLoaded = true;
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
  if (getProvider(agent.provider).binaryName !== 'claude') return;

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
 * Confirm the delivery, and send it a second way before giving up.
 *
 * The second way is the one that has always worked: typing into the live
 * session, which is what /dispatch does to an agent that is already running.
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
    // A blocking permission dialog reads typed text as its answer, so a
    // redelivery there would accept the dialog rather than deliver anything.
    if (dialogOpen(live)) return;

    if (!pending.retried) {
      console.warn(
        `[agent] ${live.name || live.id} registered but has not started a turn after `
        + `${Math.round(TURN_START_BOUND_MS / 1000)}s: typing the task into the live session`,
      );
      pending.retried = true;
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
      `[agent] ${live.name || live.id} never started a turn: the task reached the CLI neither as an `
      + 'argument nor typed in',
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

async function initAgentPtyLocked(
  agent: AgentStatus,
  mainWindow: BrowserWindow | null,
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void,
  saveAgentsCallback: () => void
): Promise<string> {
  // Re-check under the lock: the caller's check happened before it queued here,
  // and the call it was queued behind may have just created the PTY it wanted.
  if (agent.ptyId && ptyProcesses.has(agent.ptyId)) return agent.ptyId;

  const shell = '/bin/bash';
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
  let savedSettings: Record<string, unknown> = {};
  try {
    const settingsFile = dataPath('app-settings.json');
    if (fs.existsSync(settingsFile)) {
      savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      cliExtraPaths.push(...cliPathDirs(savedSettings.cliPaths as Record<string, unknown> | undefined));
    }
  } catch {
    // Ignore settings load errors
  }
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
  );

  const ptyProcess = spawnAgentPty({
    binaryName: agentProvider.binaryName,
    shell,
    args: ['-l'],
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env as { [key: string]: string },
      PATH: fullPath,
      ...providerEnvVars,
      // CLAUDE_MGR_API_URL is imposed by spawnAgentPty, on the one line that
      // starts a process, so the API-driven spawn cannot miss it as it did.
      // Load CLAUDE.md from --add-dir directories (e.g. ~/.dorothy)
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      ...tasmaniaEnv,
    },
  });

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  agent.ptyCwd = cwd;

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
    const agentData = agents.get(agent.id);
    // Guard: only mutate if this PTY is still the active one (prevents race on restart/stop)
    if (agentData && agentData.ptyId === ptyId) {
      const newStatus = exitCode === 0 ? 'completed' : 'error';
      agentData.status = newStatus;
      agentData.lastActivity = new Date().toISOString();
      handleStatusChangeNotificationCallback(agentData, newStatus);
      saveAgentsCallback();
    }
    ptyProcesses.delete(ptyId);
    broadcastToAllWindows('agent:complete', {
      type: 'complete',
      agentId: agent.id,
      ptyId,
      exitCode,
      timestamp: new Date().toISOString(),
    });
    scheduleTick();
  });

  return ptyId;
}
