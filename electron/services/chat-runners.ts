import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { AgentStatus } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { fieldInUse, ptyProcesses, withSenderLine, writeProgrammaticInput, WRITE_SETTLE_MS, type MessageSender } from '../core/pty-manager';
import { dialogOpen, launchAgent, sessionStarted, sessionStarting, setSlotGate, SENDER_WAIT_MS, type SlotGate } from '../core/agent-launch';
import { cliRunningIn } from '../core/agent-pty';
import { fallAsleep } from '../core/agent-asleep';
import { diskRefusal, freeSpace } from '../core/disk-space';
import { restartForSettings } from '../core/agent-restart';
import { stopAgent } from '../core/agent-stop';
import { removeAgent } from '../core/agent-remove';
import { dropRunnerGrants } from '../core/chat-grants';
import { chatLimitSentence, OFF_CLAUDE, offClaudeRefusal, recordedRunner, runnerNameOf, runnerPlaceOf, runnersToResume, startPointOf, unconfirmedRunners, victimOf, gitRefusal, looksAgain } from '../core/chat-slots';
import { setChatLookup } from '../core/chat-identity';
import { setChatLookups } from '../core/chat-inbox';
import { namesItsChats, pickChat } from './chat-addressing';
import { getProvider } from '../providers';
import { resolveResumeSessionId, resumeOnNextStart } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { agentStatusEmitter, emitAgentStatus } from './agent-events';
import { factsOf, sleepNow, sleepRefusal } from './agent-sleep';
import { readProcesses } from './stall-watch';
import { cloneDependencies, logDependencies } from './worktree-deps';
import { chatLimitOf, type Chat, type ChatStore } from './chats';

/**
 * A chat's conversation, run (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2; PR D of 2.0.0).
 *
 * Each chat other than Main gets, at its first send, a runner: an agent record
 * of its own, stored as a worker of `kind: 'chat'`, named "<orchestrator> ·
 * <title>", launched like the orchestrator (its instructions, its tool block,
 * its model, read from the orchestrator at each launch), in a worktree of its
 * own made from origin's default branch. Main's runner is the orchestrator.
 *
 * A send reaches the runner as the user's own words: typed into its CLI when
 * it runs (Claude Code takes them during a turn too), or as the prompt of a
 * launch that resumes its conversation when it does not.
 *
 * How many chats run at once is bounded by the RAM (chats.ts, chatLimitOf),
 * Main counted. A send that needs a slot when none is free puts the least
 * recently active runner the sleep rule allows to sleep (its 30 minutes
 * aside, never Main's), or answers `chat_limit` with the sentence and who
 * works: never a silent wait (JeanBrasse, 07/10). One lock holds the count, the
 * choice, the sleep and the launch together, so two sends cannot both take
 * the last slot (the Audit's M5).
 */

export type SendAnswer =
  | { success: true; chatId: string; runnerId: string; how: 'typed' | 'held' | 'launched' }
  | SendError;

export interface SendError {
  error: 'not_found' | 'invalid_request' | 'no_orchestrator' | 'provider_unsupported' | 'disk_full'
    | 'chat_limit' | 'runner_failed' | 'runner_mismatch' | 'chats_unavailable';
  reason: string;
  /** chat_limit: the limit, the RAM it comes from, and the chats working. */
  limit?: number;
  ramGb?: number;
  working?: Array<{ chatId: string; title: string; since: string }>;
}

const TEXT_MAX = 100_000;
/** A settled chat's runner that cannot sleep at once is tried again, this often and this many times. */
const SETTLE_RETRY_MS = 3_500;
const SETTLE_TRIES = 10;
/** How many times a full limit looks at a runner whose turn has just ended, and how far apart (freeSlot). */
const EVICTION_LOOKS = 6;
const EVICTION_PAUSE_MS = 500;

let store: ChatStore | null = null;
/** Launches the allocator let through, which hold no terminal yet: they count against the limit. */
const reserved = new Set<string>();
/** What a runner is told at its next launch: it was left asleep at launch, over the limit. */
const notesForNextLaunch = new Map<string, string>();
let slotChain: Promise<unknown> = Promise.resolve();

/** One at a time: count the slots, choose whom to put to sleep, sleep it, and launch (M5). */
function withSlots<T>(fn: () => Promise<T>): Promise<T> {
  const run = slotChain.then(fn, fn);
  slotChain = run.catch(() => undefined);
  return run;
}

/**
 * Its CLI runs in its terminal, or a launch of it is on its way: what holds a
 * slot, and what a send types into. A terminal outlives its CLI (an /exit, a
 * crash) as a bare shell, which needs no slot and would run a typed line as a
 * command.
 */
export function isLive(agent: AgentStatus): boolean {
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  return !!terminal && (cliRunningIn(terminal) || sessionStarting(agent));
}

/**
 * The agent a chat runs on, when the fleet confirms its record: chats.json is
 * in ~/.dorothy, which every agent may write (core/chat-slots.ts, recordedRunner).
 * Nothing is typed, launched, counted, put to sleep or renamed for any other.
 */
export function runnerOf(chat: Chat): AgentStatus | undefined {
  const found = recordedRunner(chat, agents);
  return 'agent' in found ? found.agent : undefined;
}

/** Every chat, as copies; none while the chats are not loaded. */
export function allChats(): Chat[] {
  return store ? store.list().chats : [];
}

/** A chat by its id. */
export function chatById(chatId: string): Chat | undefined {
  return store?.get(chatId);
}

/**
 * The chat an agent runs, when the fleet confirms it: Main for the project's
 * orchestrator, its own chat for a runner. What its messages to a channel or
 * the room are named by (PR F).
 */
/** The chat an agent runs, only once its project has several chats: what its messages are named by. */
export function namedChatRunBy(agent: AgentStatus): Chat | undefined {
  const chat = chatRunBy(agent);
  return chat && namesItsChats(allChats(), chat) ? chat : undefined;
}

export function chatRunBy(agent: AgentStatus): Chat | undefined {
  const chat = store?.chatOfRunner(agent.id);
  return chat && runnerOf(chat) === agent ? chat : undefined;
}

/** Chats other than Main run on claude, whose conversations Tars resumes: an orchestrator on another CLI has Main only. */
const PROVIDER_UNSUPPORTED = OFF_CLAUDE;
const runsChats = (lead: AgentStatus): boolean => getProvider(lead.provider).binaryName === 'claude';

/** A send to a chat while its orchestrator is off claude (core/chat-slots.ts, offClaudeRefusal). */
function offClaude(chat: Chat, runnerLive: boolean): SendError | undefined {
  const lead = leadOf(chat.projectPath);
  const reason = offClaudeRefusal(chat.number, lead ? runsChats(lead) : undefined, runnerLive);
  return reason ? { error: 'provider_unsupported', reason } : undefined;
}

/** The project's orchestrator: its role, never a runner (H1). */
function leadOf(projectPath: string): AgentStatus | undefined {
  return [...agents.values()].find((a) => a.role === 'orchestrator' && a.kind !== 'chat' && a.projectPath === projectPath);
}

function announce(agent: AgentStatus): void {
  emitAgentStatus(agent.id);
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.lastActivity });
  scheduleTick();
}

/** A runner takes its project's orchestrator's configuration, when its chat names it (syncWithLead). */
function syncFromLead(runner: AgentStatus): void {
  const chat = runner.chatId ? store?.get(runner.chatId) : undefined;
  const lead = leadOf(runner.projectPath);
  if (!chat || !lead || runnerOf(chat) !== runner) return;
  syncWithLead(runner, lead, chat);
  saveAgents();
}

/** The orchestrator's configuration, read at each launch, never copied once (4.2). */
function syncWithLead(runner: AgentStatus, lead: AgentStatus, chat: Chat): void {
  runner.name = runnerNameOf(lead.name, chat.title);
  runner.teamOrchestratorId = lead.id;
  runner.provider = lead.provider;
  runner.model = lead.model;
  runner.savedPrompt = lead.savedPrompt;
  runner.localModel = lead.localModel;
  runner.effort = lead.effort;
  runner.permissionMode = lead.permissionMode;
  runner.skipPermissions = lead.skipPermissions;
  runner.cliPath = lead.cliPath;
  runner.skills = [...(lead.skills ?? [])];
  runner.claudeAccountPin = lead.claudeAccountPin;
  runner.obsidianVaultPaths = [...(lead.obsidianVaultPaths ?? [])];
  runner.secondaryProjectPath = lead.secondaryProjectPath;
  runner.character = lead.character;
}

type Git = { code: number; stdout: string; stderr: string };
/** In the C locale: gitRefusal reads git's "fatal:" and "error:", which a translated git would not write. */
function git(cwd: string, args: string[]): Promise<Git> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const failed = (reason: string): SendError => ({ error: 'runner_failed', reason });

/**
 * The runner of a chat's first send: its worktree, from origin's default
 * branch (fetched) or the local default branch's head, never the root's
 * current branch (R7); its dependencies cloned (#325); the project's
 * settings.local.json copied once; then its record.
 */
async function makeRunner(chat: Chat, lead: AgentStatus): Promise<{ runner: AgentStatus } | SendError> {
  const project = lead.projectPath;
  const place = runnerPlaceOf(project, chat.id);
  if (!place) return failed('This chat has no id a worktree can be named after.');
  if (fs.existsSync(place.worktreePath)) return failed(`A folder is already at ${place.worktreePath}: move it away, and send again.`);
  if ((await git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${place.branchName}`])).code === 0) {
    return failed(`A branch ${place.branchName} already exists in this project: delete or rename it, and send again.`);
  }
  const remotes = (await git(project, ['remote'])).stdout.split('\n').map((r) => r.trim());
  if (remotes.includes('origin')) {
    // Offline, the default branch as last fetched is where the runner starts.
    const fetched = await git(project, ['fetch', '--quiet', 'origin']);
    if (fetched.code !== 0) console.warn(`[chat-runners] git fetch origin failed in ${project}: ${fetched.stderr.trim()}`);
  }
  const head = await git(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const refs: string[] = [];
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0) refs.push(ref);
  }
  const start = startPointOf({ originHead: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null, refs });
  if (!start) return failed('This project has no default branch to start a chat from (no origin/main, origin/master, main or master).');
  fs.mkdirSync(path.dirname(place.worktreePath), { recursive: true });
  const added = await git(project, ['worktree', 'add', '-b', place.branchName, place.worktreePath, start]);
  if (added.code !== 0) return failed(`Its worktree could not be made: ${gitRefusal(added.stderr)}.`);
  await logDependencies(place.worktreePath, await cloneDependencies(project, place.worktreePath));
  // The grants the orchestrator has, copied once: they diverge after, as any worktree's do.
  const grants = path.join(project, '.claude', 'settings.local.json');
  if (fs.existsSync(grants)) {
    try {
      fs.mkdirSync(path.join(place.worktreePath, '.claude'), { recursive: true });
      fs.copyFileSync(grants, path.join(place.worktreePath, '.claude', 'settings.local.json'), fs.constants.COPYFILE_EXCL);
    } catch (err) {
      console.warn(`[chat-runners] settings.local.json not copied into ${place.worktreePath}: ${(err as Error).message}`);
    }
  }
  const now = new Date().toISOString();
  const runner: AgentStatus = {
    id: uuidv4(),
    status: 'idle',
    projectPath: project,
    worktreePath: place.worktreePath,
    branchName: place.branchName,
    skills: [],
    output: [],
    lastActivity: now,
    createdAt: now,
    role: 'worker',
    orchestratorMode: false,
    kind: 'chat',
    chatId: chat.id,
  };
  syncWithLead(runner, lead, chat);
  agents.set(runner.id, runner);
  saveAgents();
  const bound = store!.setRunner(chat.id, runner.id);
  if ('error' in bound) {
    await removeAgent(runner.id);
    return failed(`The chat could not take its runner: ${bound.reason}`);
  }
  announce(runner);
  console.log(`[chat-runners] ${runner.name}: made in ${place.worktreePath} on ${place.branchName}, from ${start}`);
  return { runner };
}

/** The agents that run chats and hold a slot now: a live terminal, or a launch let through. */
function slotHolders(): Array<{ chat: Chat; agent: AgentStatus }> {
  const seen = new Set<string>();
  const out: Array<{ chat: Chat; agent: AgentStatus }> = [];
  for (const chat of store!.list().chats) {
    const agent = runnerOf(chat);
    if (!agent || seen.has(agent.id)) continue;
    if (!isLive(agent) && !reserved.has(agent.id)) continue;
    seen.add(agent.id);
    out.push({ chat, agent });
  }
  return out;
}

/** The chats that hold a slot now, for system:chatLimit. */
export function chatsWorking(): number {
  return store ? slotHolders().length : 0;
}

/** A slot for `forAgentId`, freed by a sleep when none is; or the refusal the user sees. */
async function freeSlot(forAgentId?: string): Promise<SendError | null> {
  const limit = chatLimitOf(os.totalmem(), process.env);
  for (let look = 1; ; look += 1) {
    const holders = slotHolders().filter(({ agent }) => agent.id !== forAgentId);
    if (holders.length < limit.limit) return null;
    const procs = await readProcesses();
    const now = Date.now();
    const candidates = holders.map(({ chat, agent }) => {
      const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      return {
        agentId: agent.id,
        isMain: chat.number === 1 || agent.kind !== 'chat',
        lastActivity: Date.parse(agent.lastActivity) || 0,
        refusal: reserved.has(agent.id) ? 'starting' : sleepRefusal(factsOf(agent, procs, now), { anyAge: true }),
        forSend: reserved.has(agent.id),
        // A message Tars has just typed in keeps the field in use a moment (WRITE_SETTLE_MS): it settles by itself.
        settlesInMs: terminal ? fieldInUse(terminal)?.retryInMs : undefined,
      };
    });
    const victimId = victimOf(candidates);
    const victim = victimId ? agents.get(victimId) : undefined;
    // Read again with nothing awaited since, then put to sleep: a message on its
    // way to it is in its field (fieldInUse), and the sleep is synchronous up to
    // the end of its terminal's tree.
    if (victim && isLive(victim) && sleepRefusal(factsOf(victim, procs, Date.now()), { anyAge: true }) === null) {
      await sleepNow(victim, 'to free a slot for another chat');
      return null;
    }
    // A turn's end reaches Tars from its Stop hook, whose process is still
    // under the CLI for a moment after (busy), the process table may not come
    // at all under load, a message Tars has just typed in keeps the field in
    // use until it settles, and a restart with no prompt is idle once its start
    // is through: such a runner is looked at again, a little later (looksAgain).
    const passing = candidates.filter(looksAgain);
    if (passing.length && look < EVICTION_LOOKS) {
      const wait = Math.max(EVICTION_PAUSE_MS, ...passing.map((c) => Math.min(c.settlesInMs ?? 0, WRITE_SETTLE_MS)));
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const why = candidates.map((c) => `${agents.get(c.agentId)?.name || c.agentId}: ${c.isMain ? 'main' : c.refusal ?? 'free'}`).join(', ');
    console.log(`[chat-runners] chat_limit (${limit.limit} working): ${why}`);
    const working = holders.map(({ chat, agent }) => ({ chatId: chat.id, title: chat.title, since: agent.statusSince ?? agent.lastActivity }));
    return {
      error: 'chat_limit',
      reason: chatLimitSentence(limit.limit, limit.ramGb, limit.perChatGb, working.map((w) => w.title)),
      limit: limit.limit,
      ramGb: limit.ramGb,
      working,
    };
  }
}

/**
 * The user's words into a chat's runner while its CLI runs: once a launch on
 * its way has taken keys (a message typed earlier is lost, #134), never into a
 * dialog (its Enter would answer it), and as the user's own, with no sender
 * line. Claude Code takes them during a turn too, in order.
 */
async function typeInto(runner: AgentStatus, chat: Chat, text: string, sender?: MessageSender): Promise<SendAnswer> {
  // The one place a chat's words are typed: refused here once its orchestrator
  // is off claude, its runner still running (2.0.1).
  const refused = offClaude(chat, true);
  if (refused) return refused;
  if (!(await sessionStarted(runner, SENDER_WAIT_MS))) {
    return failed(`${runner.name || 'Its agent'} is still starting: nothing was typed. Send it again in a moment.`);
  }
  const terminal = runner.ptyId ? ptyProcesses.get(runner.ptyId) : undefined;
  if (!terminal) return failed('Its terminal ended while the message waited: send it again.');
  if (dialogOpen(runner)) {
    return failed('Its CLI shows a dialog (a permission or a question), and a typed Enter would answer it: answer the dialog, then send again.');
  }
  const outcome = writeProgrammaticInput(terminal, text, true, sender
    ? { agentId: runner.id, from: fromOf(sender), sender }
    : { agentId: runner.id, from: 'you' });
  if (outcome === 'refused') return failed('Its terminal already holds as many messages as it can take: wait for it, and send again.');
  return { success: true, chatId: chat.id, runnerId: runner.id, how: outcome === 'held' ? 'held' : 'typed' };
}

/** Who a message is from, as the agent's panel names a waiting one. */
function fromOf(sender: MessageSender): string {
  if (sender.kind === 'agent') return sender.name || sender.id;
  if (sender.kind === 'channel') return sender.channel;
  if (sender.kind === 'user') return `the user via ${sender.via}`;
  return 'Tars';
}

/**
 * The user's words into a chat: typed into its runner's CLI when it runs, or
 * the prompt of a launch that resumes its conversation, within the limit.
 *
 * With a sender (a bot, the relay: PR F), what arrives is that sender's, after
 * the line Tars writes for it, typed or at the head of the launch's prompt; a
 * chat's own window sends none, and its words are the user's own.
 */
export async function sendToChat(chatId: unknown, text: unknown, opts: { sender?: MessageSender } = {}): Promise<SendAnswer> {
  if (!store) return { error: 'chats_unavailable', reason: 'The chats are not loaded yet.' };
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) {
    return { error: 'invalid_request', reason: `A message is text, 1 to ${TEXT_MAX} characters.` };
  }
  // A runner that runs needs no slot: typed into at once, never behind
  // another chat's runner being made in the lock (git fetch, the worktree,
  // its dependencies; the Audit's L5 on #379). Read again in the lock for a
  // launch.
  const known = store.get(chatId);
  const running = known ? runnerOf(known) : undefined;
  if (known && running && isLive(running)) return typeInto(running, known, text, opts.sender);
  // Under the lock: whether a slot is needed, and the launch that takes it.
  const decided = await withSlots(async (): Promise<SendAnswer | { typeInto: AgentStatus; chat: Chat }> => {
    const chat = store!.get(chatId);
    if (!chat) return { error: 'not_found', reason: 'No chat has this id.' };
    const lead = leadOf(chat.projectPath);
    const recorded = recordedRunner(chat, agents);
    if ('why' in recorded && recorded.why === 'gone') {
      return failed(chat.number === 1
        ? "This chat's orchestrator was deleted: set an orchestrator for the project on the Agents page."
        : "This chat's agent was deleted. Start a new chat.");
    }
    if ('why' in recorded && recorded.why === 'not_its_own') {
      return {
        error: 'runner_mismatch',
        reason: chat.number === 1
          ? "Main is the conversation of the project's orchestrator, and the agent this chat names is not it (the orchestrator changed, or chats.json was edited): nothing was sent."
          : 'The agent this chat names is not the one made for it (chats.json was edited): nothing was sent. Start a new chat.',
      };
    }
    let runner = 'agent' in recorded ? recorded.agent : undefined;
    if (runner && isLive(runner)) return { typeInto: runner, chat };
    const full = diskRefusal(freeSpace());
    if (full) return { error: 'disk_full', reason: full };
    // A chat other than Main is launched on its orchestrator's CLI: claude only,
    // at its first send and at every later one (the Audit's L4 on #379).
    const offClaudeRefused = offClaude(chat, false);
    if (offClaudeRefused) return offClaudeRefused;
    if (!runner) {
      if (!lead) return { error: 'no_orchestrator', reason: 'This project has no orchestrator: set one on the Agents page.' };
      const refused = await freeSlot();
      if (refused) return refused;
      const made = await makeRunner(chat, lead);
      if (!('runner' in made)) return made;
      runner = made.runner;
    } else {
      const refused = await freeSlot(runner.id);
      if (refused) return refused;
    }
    if (runner.kind === 'chat' && lead) {
      syncWithLead(runner, lead, chat);
      saveAgents();
    }
    // A chat's conversation goes on, whatever this run of Tars started before.
    // Asleep, it wakes on its own session (core/agent-asleep.ts). Stopped, that
    // session is a tombstone, whose hooks are dropped as stale: it goes on
    // under a new id, as a restart does (core/agent-restart.ts).
    resumeOnNextStart(runner.id);
    const conversation = runner.status === 'asleep' ? null : resolveResumeSessionId(runner);
    const options = { message: true, ...(conversation && conversation === runner.lastKilledSessionId ? { resumeSessionId: conversation } : {}) };
    const note = notesForNextLaunch.get(runner.id);
    notesForNextLaunch.delete(runner.id);
    reserved.add(runner.id);
    try {
      const said = opts.sender ? withSenderLine(opts.sender, text) : text;
      const result = await launchAgent(runner.id, note ? `${note}\n\n${said}` : said, options);
      if (!result.success) return failed(result.error);
      return { success: true, chatId: chat.id, runnerId: runner.id, how: 'launched' };
    } finally {
      reserved.delete(runner.id);
    }
  });
  return 'typeInto' in decided ? typeInto(decided.typeInto, decided.chat, text, opts.sender) : decided;
}

/** Whether a chat may lose its runner: Main's is the orchestrator, never removed by a chat (4.1). */
function ownRunnerOf(chat: Chat): AgentStatus | undefined {
  const runner = runnerOf(chat);
  return runner?.kind === 'chat' ? runner : undefined;
}

/**
 * A deleted chat's runner: stopped first, so nothing more is asked in its
 * name, then checked again by the caller for work it asked for while it
 * stopped (the Audit's L6 on #379).
 */
export async function stopRunnerOf(chat: Chat): Promise<void> {
  const runner = ownRunnerOf(chat);
  if (runner) await stopAgent(runner, { by: 'you', reason: 'its chat was deleted' }, { save: saveAgents, announce });
}

/** Then, once nothing it asked for is out, removed with its worktree, its work saved on wip/ first (#312, #335). */
export async function removeRunnerOf(chat: Chat): Promise<{ savedTo?: string; worktreeKept?: string }> {
  const runner = ownRunnerOf(chat);
  if (!runner) return {};
  dropRunnerGrants(runner.projectPath, runner.worktreePath, runnerPlaceOf(runner.projectPath, chat.id)?.worktreePath);
  const removed = await removeAgent(runner.id);
  announce(runner);
  return { ...(removed.savedTo ? { savedTo: removed.savedTo } : {}), ...(removed.worktreeKept ? { worktreeKept: removed.worktreeKept } : {}) };
}

const settling = new Set<string>();

/** A settled chat's runner sleeps as soon as the rule allows it (its 30 minutes aside). */
async function sleepIfSettled(runnerId: string, triesLeft: number): Promise<void> {
  if (!store || settling.has(runnerId)) return;
  const runner = agents.get(runnerId);
  const chat = runner?.kind === 'chat' && runner.chatId ? store.get(runner.chatId) : undefined;
  if (!runner || !chat || runnerOf(chat) !== runner || !chat.settledAt || !isLive(runner)) return;
  settling.add(runnerId);
  try {
    const procs = await readProcesses();
    const why = isLive(runner) ? sleepRefusal(factsOf(runner, procs, Date.now()), { anyAge: true }) : 'no-cli';
    if (why === null) {
      await sleepNow(runner, 'its chat was settled');
      return;
    }
    if (triesLeft > 0 && why !== 'no-cli') {
      setTimeout(() => { void sleepIfSettled(runnerId, triesLeft - 1); }, SETTLE_RETRY_MS).unref?.();
    }
  } finally {
    settling.delete(runnerId);
  }
}

/** Settling a chat puts its runner to sleep at once, or as soon as it may; Main's never sleeps (4.2). */
export function settleRunner(chat: Chat): void {
  const runner = ownRunnerOf(chat);
  if (runner) void sleepIfSettled(runner.id, SETTLE_TRIES);
}

/** A renamed chat's runner is renamed with it: workers read the chat in its sender line. */
export function renameRunner(chat: Chat): void {
  const runner = ownRunnerOf(chat);
  if (!runner) return;
  const lead = leadOf(chat.projectPath);
  runner.name = runnerNameOf(lead?.name, chat.title);
  saveAgents();
  announce(runner);
}

/**
 * The orchestrator was saved (agent:update): each runner of its project takes
 * its configuration and name, and a live one is restarted on the launch
 * settings that changed, at a moment that cuts nothing (#120), in its own slot.
 */
export function restartRunnersOf(leadId: string, changed: string[]): void {
  if (!store) return;
  const lead = agents.get(leadId);
  if (!lead || lead.role !== 'orchestrator') return;
  // Moved to a CLI whose conversations Tars cannot resume: its runners are
  // neither copied onto it nor restarted on it (the Audit's L4 on #379).
  if (!runsChats(lead)) return;
  for (const runner of agents.values()) {
    if (runner.kind !== 'chat' || runner.projectPath !== lead.projectPath) continue;
    const chat = runner.chatId ? store.get(runner.chatId) : undefined;
    if (!chat || runnerOf(chat) !== runner) continue;
    syncWithLead(runner, lead, chat);
    if (changed.length && isLive(runner)) restartForSettings(runner.id, changed);
  }
  saveAgents();
}

/**
 * At a launch after an abrupt stop: the runners that were working beyond what
 * the limit leaves, the least recently active, are not relaunched. They are
 * put asleep, their conversation kept, and their next launch opens with why.
 * Returns their ids, which crash-resume then leaves alone.
 */
export function leaveRunnersAsleep(working: Array<{ agentId: string }>, now = Date.now()): Set<string> {
  if (!store) return new Set();
  const limit = chatLimitOf(os.totalmem(), process.env);
  const runners = working.map((w) => agents.get(w.agentId)).filter((a): a is AgentStatus => !!a && a.kind === 'chat');
  // The others working that run a chat (Main's orchestrator) take their slot first.
  const mains = working.filter((w) => {
    const agent = agents.get(w.agentId);
    const chat = agent && agent.kind !== 'chat' ? store!.chatOfRunner(agent.id) : undefined;
    return !!chat && runnerOf(chat) === agent;
  }).length;
  const { leave } = runnersToResume(runners.map((r) => ({ agentId: r.id, lastActivity: Date.parse(r.lastActivity) || 0 })), limit.limit - mains);
  const stoppedAt = new Date(now).toTimeString().slice(0, 5);
  for (const id of leave) {
    const runner = agents.get(id)!;
    fallAsleep(runner, undefined, now);
    notesForNextLaunch.set(id, `[Tars] Tars stopped abruptly while this chat was working, and it was not restarted at launch (${stoppedAt}): `
      + `the limit is ${limit.limit} chats working at once. Your conversation is as it was; pick up where it stopped.`);
    console.log(`[chat-runners] ${runner.name}: not restarted at launch, the limit is ${limit.limit}; asleep`);
  }
  if (leave.length) saveAgents();
  return new Set(leave);
}

function onFleetChange(agentId: string): void {
  const agent = agents.get(agentId);
  if (agent?.kind === 'chat' && (agent.status === 'idle' || agent.status === 'completed')) void sleepIfSettled(agentId, 0);
}

/**
 * The slot a runner's start takes, whoever starts it: a wake by news, a
 * restart, a worker's message to it (core/agent-launch.ts). A launch a send
 * already let through (reserved) passes, as does a runner that runs, and an
 * agent that runs no chat of its own (Main's orchestrator is never refused a
 * start: a full limit puts a runner to sleep at its chat's next send).
 */
const slotGate: SlotGate = async (agentId) => {
  const passes = { ok: true as const, release: () => undefined };
  const agent = agents.get(agentId);
  if (!store || !agent || agent.kind !== 'chat' || isLive(agent) || reserved.has(agentId)) return passes;
  // On its orchestrator's CLI, claude only (the Audit's L4 on #379).
  const lead = leadOf(agent.projectPath);
  if (lead && !runsChats(lead)) return { ok: false as const, error: PROVIDER_UNSUPPORTED };
  // Its configuration is the orchestrator's, read at each launch, whoever
  // starts it, not only at a send (the Audit's L3 on #379).
  syncFromLead(agent);
  return withSlots(async () => {
    if (isLive(agent) || reserved.has(agentId)) return passes;
    const refused = await freeSlot(agentId);
    if (refused) return { ok: false as const, error: refused.reason };
    reserved.add(agentId);
    return { ok: true as const, release: () => { reserved.delete(agentId); } };
  });
};

/** Called once by handlers/chat-handlers.ts, with the store it made. */
export function startChatRunners(chatStore: ChatStore): void {
  if (store) return;
  store = chatStore;
  // A record is a claim: an agent marked a chat's runner keeps the mark, and
  // the orchestrator's powers with it, only while a chat names it (L1).
  const unconfirmed = unconfirmedRunners(agents, (chatId) => chatStore.get(chatId));
  for (const agent of unconfirmed) {
    console.warn(`[chat-runners] ${agent.name || agent.id}: marked as a chat's runner, but no chat names it; a worker from now on`);
    agent.kind = undefined;
    agent.chatId = undefined;
    agent.teamOrchestratorId = undefined;
  }
  if (unconfirmed.length) saveAgents();
  setSlotGate(slotGate);
  setChatLookup({
    byId: (chatId) => chatStore.get(chatId),
    byRunner: (agentId) => {
      const chat = chatStore.chatOfRunner(agentId);
      return chat && runnerOf(chat)?.id === agentId ? chat : undefined;
    },
  });
  setChatLookups({
    inbox: (projectPath) => {
      const picked = pickChat(chatStore.list().chats, projectPath, null);
      if (picked.kind !== 'chat') return null;
      // Main's agent is the orchestrator, whatever its record says (runner_mismatch is the send's to tell).
      return { agent: picked.chat.number === 1 ? leadOf(projectPath) : runnerOf(picked.chat) };
    },
    chatRunBy: (agentId) => {
      const agent = agents.get(agentId);
      return agent ? chatRunBy(agent) : undefined;
    },
    namedChatOf: (agentId) => {
      const agent = agents.get(agentId);
      return agent ? namedChatRunBy(agent) : undefined;
    },
  });
  agentStatusEmitter.on('fleet-change', onFleetChange);
}
