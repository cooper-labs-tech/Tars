/**
 * What the chat bots do, whatever the chat.
 *
 * Telegram and Slack each carried a copy of every flow: finding an agent by
 * name, starting it on a task or typing the task into its session, stopping
 * it, handing a message to the orchestrator, and reporting the fleet by status
 * and by project. The flows live here once. Each bot keeps its own words (its
 * texts, emoji, price table and command syntax), which is what its users read
 * and what d1-bots.contract.test.ts holds byte for byte.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type * as pty from 'node-pty';
import type { AgentPermissionMode, AgentStatus, AppSettings } from '../types';
import { isSuperAgent, getSuperAgentInstructionsPath } from '../utils';
import { hasOrchestratorPowers } from '../core/agent-role';
import { getProvider } from '../providers';
import type { CLIProvider } from '../providers/cli-provider';
import { writeProgrammaticInput, type MessageSender } from '../core/pty-manager';
import { cliRunningIn, shellReady, agentPtyEnv } from '../core/agent-pty';
import { stopAcpRuns } from './acp/delegate';
import { killStalePty, armTaskStartWatch, launchIntoTerminal, cliStartRefusal } from '../core/agent-manager';
import { toLaunch, projectName, type Launch } from '../platform';
import { consumeResumeSessionId } from '../utils/resume-session';
import { noteWaker } from '../core/agent-asleep';
import { noteLaunch, launchSettings } from '../core/agent-restart';
import { sessionStarted, launchUnlessRunning, launchAbandoned, dialogShown, takeSlot } from '../core/agent-launch';
import { handOffFrom, noteHandOff } from './task-ledger';

/** What a bot needs from the rest of Tars. */
export interface BotFleet {
  agents: Map<string, AgentStatus>;
  ptyProcesses: Map<string, pty.IPty>;
  settings: () => AppSettings;
  saveAgents: () => void;
  initAgentPty: (agent: AgentStatus) => Promise<string>;
}

/** The chat a message came from, as Tars names it on the line it types before it. */
export type BotChannel = 'Telegram' | 'Slack' | 'Discord';

/**
 * The fleet as the bots list it. A chat's runner runs one chat's conversation
 * with the orchestrator and is no member of the team (ORCHESTRATOR-PER-CHAT.md,
 * 4.2): listed, it read as one more worker, named after the orchestrator, and
 * every chat opened added one.
 */
export function listedAgents(agents: Iterable<AgentStatus>): AgentStatus[] {
  return [...agents].filter(a => a.kind !== 'chat');
}

/** An agent named in a command: a part of its name, or its id. */
export function findAgent(agents: Map<string, AgentStatus>, name: string): AgentStatus | undefined {
  // A chat's runner is named "<orchestrator> · <title>": a part of a name finds
  // the orchestrator, never one of its chats; an exact id still finds one.
  return Array.from(agents.values()).find(a => (a.kind !== 'chat' && a.name?.toLowerCase().includes(name)) || a.id === name);
}

export type StatusGroup = 'running' | 'waiting' | 'error' | 'stopped' | 'idle' | 'asleep';
const GROUPS: Array<[StatusGroup, string, (a: AgentStatus) => boolean]> = [
  ['running', 'Running', a => a.status === 'running'],
  ['waiting', 'Waiting', a => a.status === 'waiting'],
  ['error', 'Error', a => a.status === 'error'],
  ['stopped', 'Stopped', a => a.status === 'stopped'],
  ['idle', 'Idle', a => a.status === 'idle' || a.status === 'completed'],
  ['asleep', 'Asleep', a => a.status === 'asleep'],
];

/**
 * The fleet by status, a group per line of dots, the orchestrator first in each
 * group when asked. `strong` is the chat's bold: `*` in Telegram and Slack, `**` in Discord.
 */
export function statusReport(
  list: AgentStatus[],
  words: { title: string; dot: Record<StatusGroup, string>; item: (a: AgentStatus) => string; orchestratorFirst: boolean; strong?: string },
): string {
  const b = words.strong ?? '*';
  let text = words.title;
  for (const [key, label, belongs] of GROUPS) {
    let group = list.filter(belongs);
    if (group.length === 0) continue;
    if (words.orchestratorFirst) group = [...group].sort((a, b) => (isSuperAgent(b) ? 1 : 0) - (isSuperAgent(a) ? 1 : 0));
    text += `${words.dot[key]} ${b}${label} (${group.length}):${b}\n`;
    group.forEach(a => { text += words.item(a); });
    if (key !== 'idle') text += '\n';
  }
  return text;
}

/** The dot of one agent's status, in a bot's own glyphs. */
export function statusDot(a: AgentStatus, dot: Record<StatusGroup, string>): string {
  return a.status === 'running' ? dot.running : a.status === 'waiting' ? dot.waiting : a.status === 'error' ? dot.error : dot.idle;
}

/** The projects that have agents, each with its agents, the orchestrators and the chats' runners left out. Null when there are none. */
export function projectsReport(
  agents: Map<string, AgentStatus>,
  words: {
    title: string; folder: string; indent: string; people: string; face: (a: AgentStatus) => string;
    dot: Record<StatusGroup, string>; strong?: string;
  },
): string | null {
  const byProject = new Map<string, AgentStatus[]>();
  for (const agent of listedAgents(agents.values())) {
    if (isSuperAgent(agent)) continue;
    byProject.set(agent.projectPath, [...(byProject.get(agent.projectPath) ?? []), agent]);
  }
  if (byProject.size === 0) return null;
  const b = words.strong ?? '*';
  let text = words.title;
  byProject.forEach((projectAgents, projectPath) => {
    text += `${words.folder} ${b}${projectName(projectPath) || 'Unknown'}${b}\n`;
    text += `${words.indent}\`${projectPath}\`\n`;
    text += `${words.indent}${words.people} Agents: ${projectAgents.map(a => `${words.face(a)}${a.name}${statusDot(a, words.dot)}`).join(', ')}\n\n`;
  });
  return text;
}

/**
 * What a bot's usage command reads out of Claude Code's own usage data. Only the
 * fields the bots render are modelled; the rest belongs to the reader that
 * produces it.
 */
export interface ClaudeUsageStats {
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
  totalSessions?: number;
  totalMessages?: number;
  firstSessionDate?: string;
}

/** Claude's usage priced per model, in tokens and dollars, the most expensive model first. */
export interface PricedUsage {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  byModel: Array<{ name: string; cost: number }>;
}

// Token pricing per million tokens (MTok) - same as frontend
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheHitsPerMTok: number; cache5mWritePerMTok: number }> = {
  'claude-opus-4-5-20251101': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheHitsPerMTok: 0.50, cache5mWritePerMTok: 6.25 },
  'claude-opus-4-1-20250501': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-opus-4-20250514': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, cacheHitsPerMTok: 1.50, cache5mWritePerMTok: 18.75 },
  'claude-sonnet-4-5-20251022': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-sonnet-4-20250514': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-3-7-sonnet-20250219': { inputPerMTok: 3, outputPerMTok: 15, cacheHitsPerMTok: 0.30, cache5mWritePerMTok: 3.75 },
  'claude-haiku-4-5-20251022': { inputPerMTok: 1, outputPerMTok: 5, cacheHitsPerMTok: 0.10, cache5mWritePerMTok: 1.25 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheHitsPerMTok: 0.10, cache5mWritePerMTok: 1.25 },
  'claude-3-5-haiku-20241022': { inputPerMTok: 0.80, outputPerMTok: 4, cacheHitsPerMTok: 0.08, cache5mWritePerMTok: 1 },
};

/** A model's family, as the price table and the report name it, from any spelling of its id. */
const FAMILIES: Array<[RegExp, string, string]> = [
  [/opus-4-5|opus-4\.5/, 'claude-opus-4-5', 'Opus 4.5'],
  [/opus-4-1|opus-4\.1/, 'claude-opus-4-1', 'Opus 4.1'],
  [/opus-4|opus4/, 'claude-opus-4', 'Opus 4'],
  [/sonnet-4-5|sonnet-4\.5/, 'claude-sonnet-4-5', 'Sonnet 4.5'],
  [/sonnet-4|sonnet4/, 'claude-sonnet-4', 'Sonnet 4'],
  [/sonnet-3|sonnet3/, 'claude-3-7-sonnet-20250219', 'Sonnet 3.7'],
  [/haiku-4-5|haiku-4\.5/, 'claude-haiku-4-5', 'Haiku 4.5'],
  [/haiku-3-5|haiku-3\.5/, 'claude-3-5-haiku-20241022', 'Haiku 3.5'],
];
const familyOf = (modelId: string) => FAMILIES.find(([pattern]) => pattern.test(modelId.toLowerCase()));

function modelCost(modelId: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING[familyOf(modelId)?.[1] ?? 'claude-sonnet-4'];
  return (input / 1_000_000) * pricing.inputPerMTok +
         (output / 1_000_000) * pricing.outputPerMTok +
         (cacheRead / 1_000_000) * pricing.cacheHitsPerMTok +
         (cacheWrite / 1_000_000) * pricing.cache5mWritePerMTok;
}

/**
 * Claude's usage, priced with the table Telegram's /usage has always used, which
 * Discord's shares. Slack keeps its own, smaller one (slack-bot.ts): putting it on
 * this table would change the numbers it answers.
 */
export function priceUsage(stats: ClaudeUsageStats): PricedUsage {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  const byModel: Array<{ name: string; cost: number }> = [];
  Object.entries(stats.modelUsage ?? {}).forEach(([modelId, usage]) => {
    const modelInput = usage.inputTokens || 0;
    const modelOutput = usage.outputTokens || 0;
    const modelCacheRead = usage.cacheReadInputTokens || 0;
    const modelCacheWrite = usage.cacheCreationInputTokens || 0;
    input += modelInput;
    output += modelOutput;
    cacheRead += modelCacheRead;
    const modelPrice = modelCost(modelId, modelInput, modelOutput, modelCacheRead, modelCacheWrite);
    cost += modelPrice;
    byModel.push({ name: familyOf(modelId)?.[2] ?? modelId.split('-').slice(0, 3).join(' '), cost: modelPrice });
  });
  byModel.sort((a, b) => b.cost - a.cost);
  return { cost, input, output, cacheRead, byModel };
}

function mcpConfigPathFor(provider: CLIProvider): string | undefined {
  if (provider.getMcpConfigStrategy() !== 'flag') return undefined;
  const candidate = path.join(os.homedir(), '.claude', 'mcp.json');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** The agent's terminal, opened when it has none. */
async function terminalOf(fleet: BotFleet, agent: AgentStatus): Promise<pty.IPty | undefined> {
  if (!agent.ptyId || !fleet.ptyProcesses.has(agent.ptyId)) {
    const ptyId = await fleet.initAgentPty(agent);
    agent.ptyId = ptyId;
  }
  return fleet.ptyProcesses.get(agent.ptyId);
}

/**
 * Claim the agent's launch, the way every sender does: a launch on its way owns
 * the terminal until its CLI runs, so it is waited for; a terminal whose cwd is
 * stale is killed first (BUG 4), so that one opened next starts in the right
 * directory. Returned before the terminal is opened, so that a terminal that
 * fails to open gives the launch up.
 */
async function claimLaunch(agent: AgentStatus): Promise<object | null> {
  killStalePty(agent);
  await sessionStarted(agent);
  // No CLI up there: this is a launch from now on, for every other sender.
  return launchUnlessRunning(agent);
}

/**
 * Typed plainly, once the shell is at its prompt: this is a shell, not the CLI's
 * field. Every agent terminal is /bin/bash, Apple's 3.2, which has no bracketed
 * paste, and a long launch pasted went in as `00~cd ...` and started nothing;
 * typed before the prompt, a long launch is cut (shellReady).
 */
async function typeLaunch(
  fleet: BotFleet, agent: AgentStatus, ptyProcess: pty.IPty, launch: Launch, task: string, before: StatusBefore,
  from: BotChannel, handedOver: string,
): Promise<void> {
  // darwin/linux: typed once the shell is at its prompt. win32 types
  // nothing, the CLI replaces the shell: no prompt to wait for.
  if (launch.platform !== 'win32') await shellReady(ptyProcess);
  // Work handed over, for the task its first turn opens (task-ledger.ts).
  noteHandOff(agent.id, { ...handOffFrom({ kind: 'channel', channel: from }), text: handedOver });
  let cli: pty.IPty;
  try {
    cli = await launchIntoTerminal(agent, ptyProcess, launch, fleet);
  } catch (err) {
    // win32 only, where the CLI's terminal is opened here: it never ran, so
    // the agent is what it was before markRunning, and the bot says why. A
    // line typed into a shell, on darwin and linux, is left as it always was.
    if (launch.platform === 'win32') {
      Object.assign(agent, before);
      fleet.saveAgents();
    }
    throw err;
  }
  noteLaunch(cli, launchSettings(agent));
  fleet.saveAgents();
  // Started from a chat, and just as able to come up with no task.
  armTaskStartWatch(agent, agent.ptyId, task);
}

/**
 * How the command starts in the agent's terminal (platform/launch.ts): typed
 * into its shell on darwin and linux, as the terminal's process on win32.
 * Worked out before the agent is marked running, so a CLI that cannot be
 * started there, or a shell it may not replace, leaves it as it was.
 */
function launchIn(agent: AgentStatus, ptyProcess: pty.IPty, workingDir: string, command: string): Launch {
  const launch = toLaunch(command, workingDir, agentPtyEnv(ptyProcess) ?? process.env);
  const refused = cliStartRefusal(agent, launch);
  if (refused) throw new Error(refused);
  return launch;
}

/** Where the launch runs. Read where each flow always read it. */
function workingDirOf(agent: AgentStatus): string {
  return agent.worktreePath || agent.projectPath;
}

/** What markRunning changes, as it was: put back when the CLI never started. */
type StatusBefore = Pick<AgentStatus, 'status' | 'currentTask' | 'lastActivity'>;

function markRunning(agent: AgentStatus, task: string): StatusBefore {
  const before = { status: agent.status, currentTask: agent.currentTask, lastActivity: agent.lastActivity };
  agent.status = 'running';
  agent.currentTask = task.slice(0, 100);
  agent.lastActivity = new Date().toISOString();
  return before;
}

export type StartOutcome = 'no-terminal' | 'refused' | 'held' | 'written' | 'started';

/**
 * How a bot answers an outcome. Called where the answer always went, inside
 * the flow: a Slack reply that fails is a failure of the flow, as it was, while
 * Telegram's replies are sent and not waited for (its callbacks return nothing).
 */
export type Reply<Outcome, Detail = undefined> = (outcome: Outcome, detail?: Detail) => unknown;

/**
 * Start an agent on a task from a chat. A CLI already up in its terminal is a
 * session between turns (every turn ends on `idle`, a failed one on `error`):
 * the task goes in as a message, since typed as a launch command it landed in
 * the CLI's own field. Otherwise it is launched on its own model, effort and
 * permission mode, an orchestrator with its instructions. A throw is the
 * launch abandoned, and rethrown for the bot to say so.
 */
export async function startWithTask(
  fleet: BotFleet, agent: AgentStatus, task: string, from: BotChannel,
  opts: { resume: boolean; reply: Reply<StartOutcome> },
): Promise<void> {
  let launch: object | null = null;
  // A chat's runner starts within the RAM's limit, whoever starts it: refused,
  // nothing is opened and the bot says why (core/agent-launch.ts; the Audit's
  // L2 on #379). Any other agent, or a runner whose CLI runs, passes at once.
  const slot = await takeSlot(agent.id);
  if (!slot.ok) throw new Error(slot.error);
  // Asleep, it wakes on its own conversation whatever this chat resumes, and
  // reads woken by the chat (core/agent-asleep.ts).
  const asleep = agent.status === 'asleep';
  if (asleep) noteWaker(agent.id, from, 'chat');
  try {
    const workingDir = workingDirOf(agent);
    launch = await claimLaunch(agent);
    const ptyProcess = await terminalOf(fleet, agent);
    if (!ptyProcess) {
      if (launch) launchAbandoned(agent.id, launch);
      await opts.reply('no-terminal');
      return;
    }
    if (cliRunningIn(ptyProcess)) {
      const outcome = writeProgrammaticInput(ptyProcess, task, true, {
        agentId: agent.id, from, sender: { kind: 'channel', channel: from },
      });
      if (outcome === 'refused') {
        await opts.reply('refused');
        return;
      }
      // Running once it is typed. Held, it is not: a dialog may be what
      // holds it, and `running` here would erase the one record of that
      // dialog, and the message would go into it (the Audit's census).
      if (outcome === 'written') agent.status = 'running';
      agent.currentTask = task.slice(0, 100);
      agent.lastActivity = new Date().toISOString();
      fleet.saveAgents();
      await opts.reply(outcome);
      return;
    }
    const provider = getProvider(agent.provider);
    // Resolved before the resume id is taken, as they always were: a throw
    // here leaves the conversation to resume next time.
    const binaryPath = provider.resolveBinaryPath(fleet.settings());
    const mcpConfigPath = mcpConfigPathFor(provider);
    const command = provider.buildInteractiveCommand({
      resumeSessionId: opts.resume || asleep ? consumeResumeSessionId(agent) ?? undefined : undefined,
      binaryPath,
      prompt: task,
      model: agent.model,
      permissionMode: agent.permissionMode ?? (agent.skipPermissions ? 'bypass' : 'normal'),
      effort: agent.effort,
      secondaryProjectPath: agent.secondaryProjectPath,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      mcpConfigPath,
      // An orchestrator starts with its instructions from a chat too, as from
      // the Dashboard and the API: without them it does the work itself. The
      // orchestrator's powers, a chat's runner's too (core/agent-role.ts).
      systemPromptFile: hasOrchestratorPowers(agent) && fs.existsSync(getSuperAgentInstructionsPath())
        ? getSuperAgentInstructionsPath()
        : undefined,
      skills: [...new Set(agent.skills || [])],
      isSuperAgent: hasOrchestratorPowers(agent),
      orchestratorMode: hasOrchestratorPowers(agent),
    });
    const start = launchIn(agent, ptyProcess, workingDir, command);
    const before = markRunning(agent, task);
    await typeLaunch(fleet, agent, ptyProcess, start, task, before, from, task);
    await opts.reply('started');
  } catch (err) {
    if (launch) launchAbandoned(agent.id, launch);
    throw err;
  } finally {
    slot.release();
  }
}

/** Ctrl+C into the agent's terminal, its delegated run stopped, and the agent idle. */
export function stopNow(fleet: BotFleet, agent: AgentStatus): void {
  if (agent.ptyId) fleet.ptyProcesses.get(agent.ptyId)?.write('\x03');
  // A run it was delegated goes too (the Audit's table, #6): it has no
  // terminal for the Ctrl+C to reach.
  void stopAcpRuns(agent.id, 'the agent was stopped from a chat');
  agent.status = 'idle';
  agent.currentTask = undefined;
  fleet.saveAgents();
}

export type ForwardOutcome = 'no-terminal' | 'typed' | 'refused' | 'started';

/** With `typed`: what the message waits behind, when it is held rather than in the field yet. */
export type ForwardDetail = { heldBy: 'dialog' | 'draft' };

/**
 * A chat message to the orchestrator: typed into its session when a CLI runs
 * in its terminal, whatever its status says (a CLI that died without its
 * SessionEnd left `running` over a bare shell, and a message typed there ran as
 * a command); otherwise it is started with the message as its task. `context`
 * goes before the message: where it came from and how to answer there. A throw
 * is the launch abandoned, and rethrown for the bot to say so.
 */
export async function forwardToOrchestrator(
  fleet: BotFleet,
  orchestrator: AgentStatus,
  from: BotChannel,
  opts: {
    message: string;
    /** Before the message, when there is something to say about where it came from; '' for nothing. */
    context: string;
    /**
     * Who the line before it names: the chat by default. The relay passes the
     * user, whose own words it carries (hermes-relay-routing.ts).
     */
    sender?: MessageSender;
    permissionMode: AgentPermissionMode;
    resume: boolean;
    /** Read only for a launch: Telegram writes a file of its own for it. */
    systemPromptFile: () => string | undefined;
    reply: Reply<ForwardOutcome, ForwardDetail>;
  },
): Promise<void> {
  const prompt = opts.context ? `${opts.context} ${opts.message}` : opts.message;
  let launch: object | null = null;
  try {
    launch = await claimLaunch(orchestrator);
    const ptyProcess = await terminalOf(fleet, orchestrator);
    if (!ptyProcess) {
      if (launch) launchAbandoned(orchestrator.id, launch);
      await opts.reply('no-terminal');
      return;
    }
    if (cliRunningIn(ptyProcess)) {
      orchestrator.currentTask = opts.message.slice(0, 100);
      orchestrator.lastActivity = new Date().toISOString();
      fleet.saveAgents();
      // Held for a person: somebody is typing there, or left a draft. Called
      // at once when that is why; never for Tars's own previous write, which
      // ends by itself in a moment.
      let heldForPerson = false;
      const outcome = writeProgrammaticInput(ptyProcess, prompt, true, {
        agentId: orchestrator.id, from, sender: opts.sender ?? { kind: 'channel', channel: from }, task: opts.message,
        onHeld: () => { heldForPerson = true; },
      });
      // Refused: the terminal holds all it can, and nothing was typed.
      if (outcome === 'refused') {
        await opts.reply('refused');
        return;
      }
      // Held: it goes in by itself once what holds it is gone, and whoever
      // sent it can be told what that is (JeanBrasse's answer 24 of 2026-10-05).
      const heldBy = outcome !== 'held' ? undefined
        : dialogShown(orchestrator, ptyProcess) ? 'dialog' as const
          : heldForPerson ? 'draft' as const : undefined;
      await opts.reply('typed', heldBy ? { heldBy } : undefined);
      return;
    }
    const workingDir = workingDirOf(orchestrator);
    const provider = getProvider(orchestrator.provider || 'claude');
    const binaryPath = provider.resolveBinaryPath(fleet.settings());
    const mcpConfigPath = mcpConfigPathFor(provider);
    // A file, never inlined: in a double-quoted shell word the instructions'
    // backticks became command substitutions and ran.
    const systemPromptFile = opts.systemPromptFile();
    const command = provider.buildInteractiveCommand({
      resumeSessionId: opts.resume ? consumeResumeSessionId(orchestrator) ?? undefined : undefined,
      binaryPath,
      prompt,
      model: orchestrator.model,
      permissionMode: opts.permissionMode,
      effort: orchestrator.effort,
      secondaryProjectPath: orchestrator.secondaryProjectPath,
      obsidianVaultPaths: orchestrator.obsidianVaultPaths,
      mcpConfigPath,
      systemPromptFile,
      skills: [...new Set(orchestrator.skills || [])],
      isSuperAgent: true,
      orchestratorMode: true,
    });
    const start = launchIn(orchestrator, ptyProcess, workingDir, command);
    const before = markRunning(orchestrator, opts.message);
    await typeLaunch(fleet, orchestrator, ptyProcess, start, prompt, before, from, opts.message);
    await opts.reply('started');
  } catch (err) {
    if (launch) launchAbandoned(orchestrator.id, launch);
    throw err;
  }
}
