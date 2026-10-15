import { isValidBranchName, resolveWorktreePath } from '../utils/worktree-path';

/**
 * The rules a chat's runner is made and scheduled by (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.2; PR D of 2.0.0). Pure: services/chat-runners.ts reads the fleet,
 * git and the RAM, and hands them in.
 */

/** A runner reads "<orchestrator> · <chat title>": a worker's sender line tells the chats apart. */
export function runnerNameOf(orchestratorName: string | undefined, title: string): string {
  const lead = orchestratorName?.trim() || 'Orchestrator';
  return `${lead} · ${title}`;
}

/**
 * Where a chat's runner works: `<project>/.worktrees/chat-<8 hex>`, on the
 * branch `chat/<the same>`, the 8 hex being the first of the chat's id (a
 * uuid). Only hex reaches the path, so no id can steer it; null when fewer
 * than 8 are found.
 */
export function runnerPlaceOf(projectPath: string, chatId: string): { worktreePath: string; branchName: string } | null {
  const short = (chatId ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
  if (short.length < 8) return null;
  const worktreePath = resolveWorktreePath(projectPath, `chat-${short}`);
  const branchName = `chat/${short}`;
  if (!worktreePath || !isValidBranchName(branchName)) return null;
  return { worktreePath, branchName };
}

/**
 * The commit a runner's branch starts from: origin's default branch (fetched
 * first by the caller), else origin/main or origin/master, else the local
 * main or master. Never the root's current branch, which may be anything at
 * that moment. Null when none exists.
 */
export function startPointOf(git: { originHead: string | null; refs: string[] }): string | null {
  if (git.originHead) return git.originHead;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (git.refs.includes(ref)) return ref;
  }
  return null;
}

/**
 * Why git refused, from its stderr: `git worktree add`, as the page reads it
 * after "Its worktree could not be made: ", and `git worktree remove`, inside
 * an agent's worktreeKept (core/agent-remove.ts). git writes its progress
 * ("Preparing worktree ...") and its hints to stderr too: only its error and
 * fatal lines are the reason, else Tars says it has none.
 */
export function gitRefusal(stderr: string): string {
  const reasons = stderr.split(/\r?\n/)
    .map((line) => /^(?:fatal|error): (.*)$/.exec(line.trim())?.[1]?.trim().replace(/[.;]+$/, ''))
    .filter((reason): reason is string => !!reason);
  return reasons.length ? reasons.join('; ') : 'git refused it without saying why';
}

/** A live runner that a full limit may put to sleep, and what the sleep rule says of it. */
export interface SlotCandidate {
  agentId: string;
  /** Main's runner, the project's orchestrator: it never sleeps. */
  isMain: boolean;
  /** Epoch ms. */
  lastActivity: number;
  /** Why the sleep rule (its 30 minutes aside) refuses it, or null. */
  refusal: string | null;
}

/** The least recently active runner the rule lets sleep, never Main's; null when none may. */
export function victimOf(candidates: SlotCandidate[]): string | null {
  const free = candidates.filter((c) => !c.isMain && c.refusal === null).sort((a, b) => a.lastActivity - b.lastActivity);
  return free[0]?.agentId ?? null;
}

/**
 * After an abrupt stop: the runners that were working, the most recently
 * active first, resumed while slots are left; the rest stay asleep.
 */
export function runnersToResume(working: Array<{ agentId: string; lastActivity: number }>, slots: number): { resume: string[]; leave: string[] } {
  const ordered = [...working].sort((a, b) => b.lastActivity - a.lastActivity).map((w) => w.agentId);
  const take = Math.max(0, slots);
  return { resume: ordered.slice(0, take), leave: ordered.slice(take) };
}

/** Why a chat other than Main is refused while its orchestrator runs a CLI other than claude (the Audit's L4 on #379). */
export const OFF_CLAUDE = "This project's orchestrator runs a CLI whose conversations Tars cannot resume: chats other than Main work with claude for now.";

/**
 * And what becomes of the chat's runner when it still runs (2.0.1): left to
 * finish, since a stopped runner could not start again while the orchestrator
 * is off claude (the slot gate refuses it), and the answers of the work it
 * handed out would be refused with it. Running, its turn ends as it would, the
 * sleep rule keeps it awake while those answers are owed, and it sleeps after.
 */
const OFF_CLAUDE_RUNNING = "This chat's runner, still running on claude, is left to finish: its turn ends as it would and the agents it gave work to still answer it, but nothing more from this chat reaches it until the orchestrator runs claude again.";

/**
 * What a send to a chat answers while its project's orchestrator is off
 * claude, or null when it goes on. A chat other than Main runs on its
 * orchestrator's CLI, claude only: refused as soon as the orchestrator leaves
 * it, its runner running or not (2.0.1; 2.0.0 typed into a runner still
 * running). Main's runner is the orchestrator itself, on whatever CLI.
 * `leadRunsChats` is undefined for a project with no orchestrator, which
 * answers its own refusal.
 */
export function offClaudeRefusal(chatNumber: number, leadRunsChats: boolean | undefined, runnerLive: boolean): string | null {
  if (chatNumber === 1 || leadRunsChats !== false) return null;
  return runnerLive ? `${OFF_CLAUDE} ${OFF_CLAUDE_RUNNING}` : OFF_CLAUDE;
}

/**
 * Whether a full limit looks at a runner again, a little later, rather than
 * answering chat_limit: its refusal passes by itself. A Stop hook's process
 * still under the CLI (busy), a process table that did not come, a message
 * Tars has just typed in settling, and a start on its way (2.0.2: a runner
 * restarting with no prompt, to follow a new orchestrator, is idle a moment
 * later; one started with a message is then in its turn, and refuses). Never
 * Main, which never sleeps, nor a runner being started for the send in hand.
 */
export function looksAgain(c: { isMain: boolean; refusal: string | null; settlesInMs?: number; forSend?: boolean }): boolean {
  if (c.isMain || c.forSend) return false;
  return c.refusal === 'busy' || c.refusal === 'no-process-table' || c.refusal === 'starting'
    || (c.refusal === 'field' && c.settlesInMs !== undefined);
}

/** What a send answers when every slot holds a chat that is working (JeanBrasse, 07/10: an error the user sees). */
export function chatLimitSentence(limit: number, ramGb: number, perChatGb: number, working: string[]): string {
  const one = limit === 1;
  return `${limit} ${one ? 'chat is' : 'chats are'} already working, the most this Mac runs at once `
    + `(${ramGb} GB of RAM, one chat per ${perChatGb} GB). `
    + `Wait for ${one ? 'it' : 'one'} to finish, or stop ${one ? 'it' : 'one'}: ${working.join(', ')}.`;
}

/** What the fleet says of an agent a chat's record names. */
export interface RecordedRunnerFacts {
  id: string;
  role?: string;
  kind?: string;
  chatId?: string;
  projectPath: string;
}

/**
 * The agent a chat's record names as its runner, as the fleet confirms it
 * (the Audit's Info on #361). chats.json sits in ~/.dorothy, which every agent
 * may write, so a record's runnerId is a claim: nothing is typed into,
 * launched, counted in a slot, put to sleep or renamed for it until this
 * agrees. Main's runner is the project's orchestrator; any other chat's is the
 * runner made for that chat, in its project. `none`: no runner yet; `gone`: no
 * agent has that id; `not_its_own`: one does, and it is not this chat's.
 */
export function recordedRunner<A extends RecordedRunnerFacts>(
  chat: { id: string; number: number; projectPath: string; runnerId: string | null },
  fleet: ReadonlyMap<string, A>,
): { agent: A } | { why: 'none' | 'gone' | 'not_its_own' } {
  if (!chat.runnerId) return { why: 'none' };
  const agent = fleet.get(chat.runnerId);
  if (!agent) return { why: 'gone' };
  if (agent.projectPath !== chat.projectPath) return { why: 'not_its_own' };
  const own = chat.number === 1
    ? agent.role === 'orchestrator' && agent.kind !== 'chat'
    : agent.kind === 'chat' && agent.chatId === chat.id;
  return own ? { agent } : { why: 'not_its_own' };
}

/**
 * The agents marked as a chat's runner that no chat names (the Audit's L1 on
 * #379): `kind: 'chat'` comes from agents.json, in ~/.dorothy, which every
 * agent may write, and it gives the orchestrator's powers. At launch these go
 * back to plain workers; a runner Tars makes later is its own.
 */
export function unconfirmedRunners<A extends RecordedRunnerFacts>(
  fleet: ReadonlyMap<string, A>,
  chatOf: (chatId: string) => { id: string; number: number; projectPath: string; runnerId: string | null } | undefined,
): A[] {
  return [...fleet.values()].filter((agent) => {
    if (agent.kind !== 'chat') return false;
    const chat = agent.chatId ? chatOf(agent.chatId) : undefined;
    if (!chat) return true;
    const found = recordedRunner(chat, fleet);
    return !('agent' in found) || found.agent.id !== agent.id;
  });
}
