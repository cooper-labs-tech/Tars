import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ensureSecretFileMode, writeAtomicSync, writeSecretFileSync } from '../utils/secret-file';
import type { MessageSender } from '../core/pty-manager';
import { taskOfPrompt } from '../core/task-requests';

/**
 * The tasks the Usage page prices: one record per piece of work an agent does,
 * from the turn that starts it to the rest that ends it, with who handed it
 * over and the task it was handed for (PLAN-1.9.3.md, item 2).
 *
 * Nothing in Tars kept this. `workHandedAt` is overwritten at each hand-off,
 * the end of a turn leaves no time, and `requestedBy` is spent once the result
 * is handed back. So the ledger listens where those already happen: a hand-off
 * (Tars types work in, or starts a session with it), the turn it starts
 * (UserPromptSubmit), and the state the agent comes to rest in. What a task
 * cost is not written here: it is read from the transcripts when asked
 * (task-cost.ts), so a price that changes later is the price shown.
 *
 * Kept in ~/.dorothy/task-ledger.jsonl, which every agent can read, without
 * what each task said: that is its first line of JeanBrasse's typed prompts and of
 * the chat messages handed to orchestrators, kept in ~/.tars-private, which no
 * agent is handed (`textFile`, 0600; JeanBrasse's answer of 2026-10-05), and cut to
 * 200 characters. Durations, turns, sessions and costs stay in ~/.dorothy.
 */

export type TaskSource = 'terminal' | 'agent' | 'tars' | 'telegram' | 'slack' | 'discord' | 'hermes' | 'acp';
export type TaskOutcome = 'running' | 'completed' | 'error' | 'stopped';

/** What the ledger reads of an agent: the fields of AgentStatus it needs. */
export interface TaskAgentView {
  id: string;
  /** `asleep` ends no task: an agent sleeps only after the rest that ended it (services/agent-sleep.ts). */
  status: 'idle' | 'running' | 'completed' | 'error' | 'waiting' | 'stopped' | 'asleep';
  waitingReason?: string;
  projectPath?: string;
  worktreePath?: string;
  provider?: string;
  model?: string;
  claudeAccountId?: string | null;
}

export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  costUSD: number | null;
}

export interface TaskRecord {
  id: string;
  agentId: string;
  projectPath: string | null;
  /** Where the CLI ran when it was not the project itself: its transcripts are filed under it. */
  worktreePath: string | null;
  provider: string | null;
  model: string | null;
  accountId: string | null;
  source: TaskSource;
  requesterAgentId: string | null;
  parentTaskId: string | null;
  text: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number | null;
  /** The last moment the ledger heard of it: where a task cut short by a quit ends. */
  lastAt: number;
  outcome: TaskOutcome;
  turns: number;
  sessionIds: string[];
  /** A delegation over ACP: what the run itself reported. */
  acp?: AcpUsage;
  /**
   * A delegation over ACP: why its turn ended, as the agent said it
   * (`end_turn`, `max_tokens`...), or `interrupted` when a quit cut it (PR B).
   */
  stopReason?: string;
  /**
   * What its turns used, per model, as the state mod reported each one from
   * Claude Code's turn.complete (mods step 4). Absent: no turn reported. It
   * prices the task when its transcript is gone (task-cost.ts).
   */
  usageByModel?: Record<string, TurnTokens>;
  /** How many turns' usage is in usageByModel. */
  usageTurns?: number;
  /**
   * The same usage, per session and per model, so that a task whose sessions
   * left only some of their transcripts is priced per session (the Audit's L1
   * on #333). Turns recorded by 1.9.3 carry no session: they are in
   * usageByModel only.
   */
  usageBySession?: Record<string, Record<string, TurnTokens>>;
  /**
   * How many of usageTurns named their session. Fewer: some were recorded by
   * 1.9.3, which named none, and cannot be told apart (the Audit's gate of
   * #343).
   */
  sessionedTurns?: number;
}

/** One turn's tokens, as Claude Code's turn.complete gives them: no split of the cache writes, no searches. */
export interface TurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type TurnUsage = TurnTokens & { model: string };

export interface HandOff {
  source: Exclude<TaskSource, 'terminal' | 'acp'>;
  requesterAgentId?: string;
  text: string;
  /**
   * The id Tars typed in the sender line before it (core/task-requests.ts):
   * only the turn whose prompt carries it is this hand-off's. Without one (a
   * launch's prompt, which has no sender line), the next turn is.
   */
  ref?: string;
}


/** A delegation over ACP as it starts: a task from then on, so a quit mid-run leaves one (PR B). */
export interface AcpStart {
  agent: TaskAgentView;
  requesterAgentId?: string;
  text: string;
  startedAt: number;
}

/** How a delegation over ACP ended. */
export interface AcpEnd {
  outcome: Exclude<TaskOutcome, 'running'>;
  stopReason: string;
  /** What it answered: cut to RESULT_MAX and kept in ~/.tars-private (resultFile). */
  result?: string;
  usage: Omit<AcpUsage, 'costUSD'> | null;
  costUSD: number | null;
}

/** A task as read by its id: with what its run answered, which the shared file never holds. */
export type TaskWithResult = TaskRecord & { result?: string };

export interface AcpRun {
  agent: TaskAgentView;
  requesterAgentId?: string;
  text: string;
  startedAt: number;
  endedAt: number;
  outcome: Exclude<TaskOutcome, 'running'>;
  usage: Omit<AcpUsage, 'costUSD'> | null;
  costUSD: number | null;
}

/** A hand-off not followed by a turn within this long started nothing. */
const HAND_OFF_TTL_MS = 15 * 60_000;
const TEXT_MAX = 200;
/** What a delegated run's answer keeps: as much as an agent's lastCleanOutput. */
const RESULT_MAX = 8_000;
const STOP_REASON = /^[A-Za-z_]{1,64}$/;
const DEFAULT_MAX_LINES = 20_000;

/** One line of text, at most 200 characters, never a character cut in two. */
function clip(text: string | undefined): string {
  return Array.from((text ?? '').replace(/\s+/g, ' ').trim()).slice(0, TEXT_MAX).join('');
}

/**
 * How the agent's state ends its open task, or null when it does not: at
 * rest, as agent-watch.ts reads it (idle, stopped, or waiting for its next
 * prompt), or done or failed. A permission prompt or a question is not an end.
 */
export function endingOf(agent: TaskAgentView): Exclude<TaskOutcome, 'running'> | null {
  switch (agent.status) {
    case 'error': return 'error';
    case 'stopped': return 'stopped';
    case 'idle':
    case 'completed': return 'completed';
    case 'waiting': return agent.waitingReason === 'idle' ? 'completed' : null;
    default: return null;
  }
}

const SOURCES: readonly TaskSource[] = ['terminal', 'agent', 'tars', 'telegram', 'slack', 'discord', 'hermes', 'acp'];
const OUTCOMES: readonly TaskOutcome[] = ['running', 'completed', 'error', 'stopped'];
/** A session id as Claude Code writes them: never a path, since it becomes one (task-cost.ts). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isOptionalString = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= 4096);

/**
 * A task as the file holds it, checked field by field, or null. The file is in
 * ~/.dorothy, which every agent can write: a line that parses is not therefore
 * a task (the Audit's Low 2 on #305). A line with a field of the wrong type is
 * dropped whole; the text, the one free field, is cut to 200 characters here
 * as well as when it is written.
 */
function taskOf(v: unknown): TaskRecord | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (!isId(t.id) || !isId(t.agentId)) return null;
  for (const key of ['projectPath', 'worktreePath', 'provider', 'model', 'accountId', 'requesterAgentId', 'parentTaskId'] as const) {
    if (!isOptionalString(t[key])) return null;
  }
  if (!SOURCES.includes(t.source as TaskSource) || !OUTCOMES.includes(t.outcome as TaskOutcome)) return null;
  // Written by builds before the text moved out; none since (textFile).
  if (t.text !== undefined && typeof t.text !== 'string') return null;
  if (!isTime(t.startedAt) || !isTime(t.lastAt) || !(t.endedAt === null || isTime(t.endedAt))) return null;
  if (!isCount(t.turns)) return null;
  if (!Array.isArray(t.sessionIds) || t.sessionIds.length > 1000 || !t.sessionIds.every((s) => typeof s === 'string' && SESSION_ID.test(s))) return null;
  if (t.stopReason !== undefined && !(typeof t.stopReason === 'string' && STOP_REASON.test(t.stopReason))) return null;
  let acp: AcpUsage | undefined;
  if (t.acp !== undefined) {
    const a = t.acp as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') return null;
    if (![a.inputTokens, a.outputTokens, a.cachedReadTokens, a.cachedWriteTokens].every(isCount)) return null;
    if (!(a.costUSD === null || (typeof a.costUSD === 'number' && Number.isFinite(a.costUSD)))) return null;
    acp = {
      inputTokens: a.inputTokens as number, outputTokens: a.outputTokens as number,
      cachedReadTokens: a.cachedReadTokens as number, cachedWriteTokens: a.cachedWriteTokens as number,
      costUSD: a.costUSD as number | null,
    };
  }
  // What its turns used, as a rewrite of the file carries it: checked as a usage line is.
  let usageByModel: Record<string, TurnTokens> | undefined;
  if (t.usageByModel !== undefined) {
    if (!t.usageByModel || typeof t.usageByModel !== 'object' || !isCount(t.usageTurns)) return null;
    const entries = Object.entries(t.usageByModel as Record<string, unknown>);
    if (entries.length > MAX_MODELS) return null;
    usageByModel = {};
    for (const [model, raw] of entries) {
      const tokens = tokensOf(raw);
      if (!isModel(model) || !tokens) return null;
      usageByModel[model] = tokens;
    }
  }
  let usageBySession: Record<string, Record<string, TurnTokens>> | undefined;
  if (t.usageBySession !== undefined) {
    if (!t.usageBySession || typeof t.usageBySession !== 'object') return null;
    const sessions = Object.entries(t.usageBySession as Record<string, unknown>);
    if (sessions.length > 1000) return null;
    usageBySession = {};
    for (const [sessionId, models] of sessions) {
      if (!SESSION_ID.test(sessionId) || !models || typeof models !== 'object') return null;
      const entries = Object.entries(models as Record<string, unknown>);
      if (entries.length > MAX_MODELS) return null;
      const kept: Record<string, TurnTokens> = {};
      for (const [model, raw] of entries) {
        const tokens = tokensOf(raw);
        if (!isModel(model) || !tokens) return null;
        kept[model] = tokens;
      }
      usageBySession[sessionId] = kept;
    }
  }
  return {
    id: t.id, agentId: t.agentId,
    projectPath: t.projectPath as string | null, worktreePath: t.worktreePath as string | null,
    provider: t.provider as string | null, model: t.model as string | null, accountId: t.accountId as string | null,
    source: t.source as TaskSource, requesterAgentId: t.requesterAgentId as string | null, parentTaskId: t.parentTaskId as string | null,
    text: clip(t.text as string | undefined), startedAt: t.startedAt, endedAt: t.endedAt as number | null, lastAt: t.lastAt,
    outcome: t.outcome as TaskOutcome, turns: t.turns, sessionIds: [...t.sessionIds] as string[],
    ...(acp ? { acp } : {}),
    ...(typeof t.stopReason === 'string' ? { stopReason: t.stopReason } : {}),
    ...(usageByModel ? { usageByModel, usageTurns: t.usageTurns as number } : {}),
    ...(usageBySession ? { usageBySession } : {}),
    ...(isCount(t.sessionedTurns) && usageByModel && t.sessionedTurns <= (t.usageTurns as number) ? { sessionedTurns: t.sessionedTurns } : {}),
  };
}

const MAX_MODELS = 20;
const isModel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Tokens as a line or a task holds them, checked, or null. */
function tokensOf(v: unknown): TurnTokens | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  return [t.input, t.output, t.cacheRead, t.cacheWrite].every(isCount)
    ? { input: t.input as number, output: t.output as number, cacheRead: t.cacheRead as number, cacheWrite: t.cacheWrite as number }
    : null;
}

/**
 * A turn's usage as the state mod sends it, Claude Code's turn.complete
 * `usage` (a count it leaves out is nought), or null when it is not one.
 */
export function turnUsageOf(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (!isModel(u.model)) return null;
  const count = (v: unknown) => (v === undefined ? 0 : v);
  const tokens = tokensOf({
    input: u.input_tokens, output: u.output_tokens,
    cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens),
  });
  return tokens ? { model: u.model, ...tokens } : null;
}

/** A line of the file, checked as taskOf checks a task, or null. */
function lineOf(v: unknown): Line | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  if (l.t === 'task') {
    const task = taskOf(l.task);
    return task ? { t: 'task', task } : null;
  }
  if (!isId(l.id) || !isTime(l.at)) return null;
  if (l.t === 'turn') {
    if (l.sessionId !== undefined && !(typeof l.sessionId === 'string' && SESSION_ID.test(l.sessionId))) return null;
    return { t: 'turn', id: l.id, at: l.at, ...(typeof l.sessionId === 'string' ? { sessionId: l.sessionId } : {}) };
  }
  if (l.t === 'usage') {
    const tokens = tokensOf(l);
    // A session id since the Audit's L1 on #333; none on a line 1.9.3 wrote.
    if (l.sessionId !== undefined && !(typeof l.sessionId === 'string' && SESSION_ID.test(l.sessionId))) return null;
    return tokens && isModel(l.model)
      ? { t: 'usage', id: l.id, at: l.at, ...(typeof l.sessionId === 'string' ? { sessionId: l.sessionId } : {}), model: l.model, ...tokens }
      : null;
  }
  if (l.t === 'acp' && OUTCOMES.includes(l.outcome as TaskOutcome) && l.outcome !== 'running'
    && typeof l.stopReason === 'string' && STOP_REASON.test(l.stopReason)
    && (l.costUSD === null || (typeof l.costUSD === 'number' && Number.isFinite(l.costUSD)))) {
    const u = l.usage as Record<string, unknown> | null;
    if (u !== null && !(u && typeof u === 'object' && [u.inputTokens, u.outputTokens, u.cachedReadTokens, u.cachedWriteTokens].every(isCount))) return null;
    return {
      t: 'acp', id: l.id, at: l.at, outcome: l.outcome as Exclude<TaskOutcome, 'running'>, stopReason: l.stopReason, costUSD: l.costUSD as number | null,
      usage: u ? { inputTokens: u.inputTokens as number, outputTokens: u.outputTokens as number, cachedReadTokens: u.cachedReadTokens as number, cachedWriteTokens: u.cachedWriteTokens as number } : null,
    };
  }
  if (l.t === 'end' && OUTCOMES.includes(l.outcome as TaskOutcome) && l.outcome !== 'running') {
    return { t: 'end', id: l.id, at: l.at, outcome: l.outcome as Exclude<TaskOutcome, 'running'> };
  }
  return null;
}

type Line =
  | { t: 'task'; task: TaskRecord }
  | { t: 'turn'; id: string; at: number; sessionId?: string }
  | { t: 'end'; id: string; at: number; outcome: Exclude<TaskOutcome, 'running'> }
  | { t: 'acp'; id: string; at: number; outcome: Exclude<TaskOutcome, 'running'>; stopReason: string; usage: Omit<AcpUsage, 'costUSD'> | null; costUSD: number | null }
  | ({ t: 'usage'; id: string; at: number; sessionId?: string } & TurnUsage);

/** Tokens added to a per-model record, false when it already holds as many models as it may. */
function addTo(byModel: Record<string, TurnTokens>, usage: TurnUsage): boolean {
  const prior = byModel[usage.model];
  if (!prior && Object.keys(byModel).length >= MAX_MODELS) return false;
  byModel[usage.model] = {
    input: (prior?.input ?? 0) + usage.input, output: (prior?.output ?? 0) + usage.output,
    cacheRead: (prior?.cacheRead ?? 0) + usage.cacheRead, cacheWrite: (prior?.cacheWrite ?? 0) + usage.cacheWrite,
  };
  return true;
}

/** A turn's usage added to what its task holds, per model, and per session when it names one. */
function addUsage(task: TaskRecord, usage: TurnUsage, sessionId: string | undefined): void {
  const byModel = task.usageByModel ?? {};
  if (!addTo(byModel, usage)) return;
  task.usageByModel = byModel;
  task.usageTurns = (task.usageTurns ?? 0) + 1;
  if (!sessionId) return;
  const bySession = task.usageBySession ?? {};
  addTo(bySession[sessionId] ??= {}, usage);
  task.usageBySession = bySession;
  task.sessionedTurns = (task.sessionedTurns ?? 0) + 1;
}

export interface TaskLedger {
  handedOff(agentId: string, handOff: HandOff): void;
  turnStarted(agent: TaskAgentView, turn: { sessionId?: string; text?: string }): void;
  stateChanged(agent: TaskAgentView, opts?: { backgroundLeft?: boolean }): void;
  acpRun(run: AcpRun): void;
  /** A delegation over ACP begins: its task, open, and its id. */
  acpStarted(run: AcpStart): string;
  /** That delegation ended: why, what it answered, what it used. */
  acpEnded(taskId: string, end: AcpEnd): void;
  /** One task by its id, with its run's answer when it has one. */
  task(id: string): TaskWithResult | undefined;
  /** The delegations a quit cut, found open at this start: given once, for their askers to be told. */
  interruptedAtStart(): TaskRecord[];
  /**
   * A turn's usage, from the state mod: filed under the agent's latest task in
   * that session, ended or not, since Claude Code's turn.complete comes after
   * the Stop that ended it (8 to 14 ms after, measured on 2.1.289). Returns
   * that task's id, or null when no task of the agent ran in that session.
   */
  turnUsage(agentId: string, sessionId: string, usage: TurnUsage): string | null;
  openTaskOf(agentId: string): TaskRecord | undefined;
  tasks(): TaskRecord[];
}

export function createTaskLedger(opts: {
  file: string;
  /** Where each task's text is kept, apart from the ledger: a file only its owner reads. */
  textFile: string;
  /** Where each delegated run's answer is kept, apart from the ledger: a file only its owner reads. */
  resultFile?: string;
  now?: () => number;
  maxLines?: number;
  /**
   * Whether `receiverId` leads `senderId`: a message from the second to the
   * first is then a report, not a delegation (#302's rule for the delegation
   * link: its project's orchestrator). The ledger knows no roles; the app
   * answers from the fleet (task-watch.ts).
   */
  leads?: (receiverId: string, senderId: string) => boolean;
}): TaskLedger {
  const { file, textFile } = opts;
  const resultFile = opts.resultFile;
  const results = new Map<string, string>();
  let interrupted: TaskRecord[] = [];
  const now = opts.now ?? Date.now;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  const byId = new Map<string, TaskRecord>();
  const open = new Map<string, string>();
  // Each agent's hand-offs in the order Tars made them (the Audit's R1): one
  // per agent was kept, and the next turn took it, whoever started that turn.
  const pending = new Map<string, Array<HandOff & { at: number; parentTaskId: string | null }>>();
  let lines = 0;

  const apply = (line: Line): void => {
    if (line.t === 'task') {
      byId.set(line.task.id, { ...line.task, sessionIds: [...line.task.sessionIds] });
      return;
    }
    const task = byId.get(line.id);
    // A turn's usage comes after the Stop that ended its task.
    if (line.t === 'usage') {
      if (task) addUsage(task, line, line.sessionId);
      return;
    }
    if (!task || task.endedAt !== null) return;
    if (line.t === 'acp') {
      task.endedAt = line.at;
      task.lastAt = Math.max(task.lastAt, line.at);
      task.outcome = line.outcome;
      task.stopReason = line.stopReason;
      task.acp = {
        inputTokens: line.usage?.inputTokens ?? task.acp?.inputTokens ?? 0,
        outputTokens: line.usage?.outputTokens ?? task.acp?.outputTokens ?? 0,
        cachedReadTokens: line.usage?.cachedReadTokens ?? task.acp?.cachedReadTokens ?? 0,
        cachedWriteTokens: line.usage?.cachedWriteTokens ?? task.acp?.cachedWriteTokens ?? 0,
        costUSD: line.costUSD ?? task.acp?.costUSD ?? null,
      };
      return;
    }
    if (line.t === 'turn') {
      task.turns += 1;
      task.lastAt = Math.max(task.lastAt, line.at);
      if (line.sessionId && !task.sessionIds.includes(line.sessionId)) task.sessionIds.push(line.sessionId);
    } else {
      task.endedAt = line.at;
      task.lastAt = Math.max(task.lastAt, line.at);
      task.outcome = line.outcome;
    }
  };

  /** A line as the shared file holds it: a task without its text. */
  const shared = (line: Line): object => (line.t === 'task' ? { t: 'task', task: { ...line.task, text: undefined } } : line);

  const writeText = (id: string, text: string): void => {
    if (!text) return;
    try {
      fs.mkdirSync(path.dirname(textFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(textFile, JSON.stringify({ id, text }) + '\n', { mode: 0o600 });
    } catch (err) {
      console.warn('[task-ledger] could not keep a task\'s text:', (err as Error).message);
    }
  };

  const write = (line: Line): void => {
    apply(line);
    if (line.t === 'task') writeText(line.task.id, line.task.text);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(shared(line)) + '\n');
      lines += 1;
      if (lines > maxLines) compact();
    } catch (err) {
      console.warn('[task-ledger] could not write:', (err as Error).message);
    }
  };

  const writeResult = (id: string, result: string): void => {
    if (!resultFile) return;
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(resultFile, JSON.stringify({ id, result }) + '\n', { mode: 0o600 });
    } catch (err) {
      console.warn('[task-ledger] could not keep a run\'s answer:', (err as Error).message);
    }
  };

  /** Both files again, one line per task kept: the ledger without texts, the texts apart. */
  const rewrite = (kept: TaskRecord[]): void => {
    if (resultFile) {
      const keep = new Set(kept.map((task) => task.id));
      for (const id of [...results.keys()]) if (!keep.has(id)) results.delete(id);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true, mode: 0o700 });
      writeSecretFileSync(resultFile, [...results.entries()].map(([id, result]) => JSON.stringify({ id, result }) + '\n').join(''));
    }
    writeAtomicSync(file, kept.map((task) => JSON.stringify(shared({ t: 'task', task })) + '\n').join(''));
    fs.mkdirSync(path.dirname(textFile), { recursive: true, mode: 0o700 });
    writeSecretFileSync(textFile, kept.filter((task) => task.text).map((task) => JSON.stringify({ id: task.id, text: task.text }) + '\n').join(''));
    lines = kept.length;
  };

  /** The file again, one line per task, the newest half of the bound kept. */
  const compact = (): void => {
    const kept = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-Math.floor(maxLines / 2));
    byId.clear();
    for (const task of kept) byId.set(task.id, task);
    rewrite(kept);
  };

  // The texts first, each checked: a line that is not one is skipped.
  const texts = new Map<string, string>();
  let rawTexts = '';
  try {
    rawTexts = fs.readFileSync(textFile, 'utf-8');
    ensureSecretFileMode(textFile);
  } catch { /* none yet */ }
  for (const text of rawTexts.split('\n')) {
    if (!text.trim()) continue;
    try {
      const v = JSON.parse(text) as { id?: unknown; text?: unknown };
      if (isId(v?.id) && typeof v.text === 'string') texts.set(v.id, clip(v.text));
    } catch { /* damaged: skipped */ }
  }

  // The runs' answers, each checked as a text line is.
  if (resultFile) {
    let rawResults = '';
    try {
      rawResults = fs.readFileSync(resultFile, 'utf-8');
      ensureSecretFileMode(resultFile);
    } catch { /* none yet */ }
    for (const line of rawResults.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as { id?: unknown; result?: unknown };
        if (isId(v?.id) && typeof v.result === 'string') results.set(v.id, Array.from(v.result).slice(0, RESULT_MAX).join(''));
      } catch { /* damaged: skipped */ }
    }
  }

  // What was written before: a damaged line is skipped, the rest read. A task
  // still open was cut short by a quit, and ends where it was last heard of.
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch { /* none yet */ }
  // A text found in the shared file was written there by a build before it
  // moved out: it moves now, and the shared file is written again without it.
  let inline = false;
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    lines += 1;
    try {
      const line = lineOf(JSON.parse(text));
      if (line?.t === 'task') {
        if (line.task.text) inline = true;
        line.task.text = texts.get(line.task.id) ?? line.task.text;
      }
      if (line) apply(line);
    } catch { /* damaged: skipped */ }
  }
  if (inline) {
    try {
      rewrite([...byId.values()].sort((a, b) => a.startedAt - b.startedAt));
    } catch (err) {
      console.warn('[task-ledger] could not move the tasks\' texts out of the shared ledger:', (err as Error).message);
    }
  }
  for (const task of byId.values()) {
    if (task.endedAt !== null) continue;
    // A delegation a quit cut: marked so, and kept for its asker to be told.
    if (task.source === 'acp') {
      write({ t: 'acp', id: task.id, at: task.lastAt, outcome: 'stopped', stopReason: 'interrupted', usage: null, costUSD: null });
      interrupted.push({ ...task, sessionIds: [...task.sessionIds] });
    } else {
      write({ t: 'end', id: task.id, at: task.lastAt, outcome: 'stopped' });
    }
  }

  const openTaskOf = (agentId: string): TaskRecord | undefined => {
    const id = open.get(agentId);
    return id ? byId.get(id) : undefined;
  };

  return {
    handedOff(agentId, handOff) {
      const senderId = handOff.requesterAgentId;
      const requester = senderId && senderId !== agentId ? openTaskOf(senderId) : undefined;
      // A worker writing to the agent that handed it its task, or to the agent
      // that leads it, is reporting: the task it starts there is not handed on
      // from the worker's (QA's gate of #305: the lead's next task and all it
      // delegated after nested under the worker's, a task of 1 read 21).
      const reports = !!senderId && ((requester?.requesterAgentId === agentId) || (opts.leads?.(agentId, senderId) ?? false));
      const list = (pending.get(agentId) ?? []).filter((h) => now() - h.at <= HAND_OFF_TTL_MS);
      list.push({ ...handOff, text: clip(handOff.text), at: now(), parentTaskId: reports ? null : requester?.id ?? null });
      pending.set(agentId, list);
    },

    turnStarted(agent, turnIn) {
      const at = now();
      // Only a session id that reads back (taskOf): anything else is no session to price.
      const turn = { ...turnIn, sessionId: turnIn.sessionId && SESSION_ID.test(turnIn.sessionId) ? turnIn.sessionId : undefined };
      // A hand-off is taken by the turn that runs it, whichever task that turn
      // belongs to: typed in while a task was open, it is that task's. The turn
      // whose prompt carries a hand-off's id takes that one; a turn with no id
      // takes the oldest hand-off that has none (a launch's prompt), and never
      // one Tars typed with an id: JeanBrasse typing into the worker, a scheduled
      // task or a /loop is a task of its own.
      const list = pending.get(agent.id) ?? [];
      // Read from the envelope Tars wrote at the prompt's start, for the agent it names (the Audit's gate of #351).
      const tagged = taskOfPrompt(turnIn.text);
      const index = tagged
        ? list.findIndex((h) => h.ref === tagged.ref && h.requesterAgentId === tagged.senderId)
        : list.findIndex((h) => !h.ref);
      const handOff = index >= 0 ? list[index] : undefined;
      if (index >= 0) list.splice(index, 1);
      if (list.length) pending.set(agent.id, list); else pending.delete(agent.id);
      const current = openTaskOf(agent.id);
      if (current) {
        write({ t: 'turn', id: current.id, at, sessionId: turn.sessionId });
        return;
      }
      const fresh = handOff && at - handOff.at <= HAND_OFF_TTL_MS ? handOff : undefined;
      const task: TaskRecord = {
        id: randomUUID(),
        agentId: agent.id,
        projectPath: agent.projectPath ?? null,
        worktreePath: agent.worktreePath ?? null,
        provider: agent.provider ?? null,
        model: agent.model ?? null,
        accountId: agent.claudeAccountId ?? null,
        source: fresh?.source ?? 'terminal',
        requesterAgentId: fresh?.requesterAgentId ?? null,
        parentTaskId: fresh?.parentTaskId ?? null,
        text: fresh ? fresh.text : clip(turn.text),
        startedAt: at,
        endedAt: null,
        lastAt: at,
        outcome: 'running',
        turns: 1,
        sessionIds: turn.sessionId ? [turn.sessionId] : [],
      };
      open.set(agent.id, task.id);
      write({ t: 'task', task });
    },

    stateChanged(agent, opts) {
      const task = openTaskOf(agent.id);
      if (!task) return;
      const outcome = endingOf(agent);
      if (!outcome) return;
      // Resting with work still running in the background is not the end: the
      // agent comes back when that work reports (agent-watch.ts says why).
      if (outcome === 'completed' && opts?.backgroundLeft) return;
      open.delete(agent.id);
      write({ t: 'end', id: task.id, at: now(), outcome });
    },

    acpRun(run) {
      const requester = run.requesterAgentId && run.requesterAgentId !== run.agent.id
        ? openTaskOf(run.requesterAgentId) : undefined;
      write({
        t: 'task',
        task: {
          id: randomUUID(),
          agentId: run.agent.id,
          projectPath: run.agent.projectPath ?? null,
          worktreePath: run.agent.worktreePath ?? null,
          provider: run.agent.provider ?? null,
          model: run.agent.model ?? null,
          accountId: run.agent.claudeAccountId ?? null,
          source: 'acp',
          requesterAgentId: run.requesterAgentId ?? null,
          parentTaskId: requester?.id ?? null,
          text: clip(run.text),
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          lastAt: run.endedAt,
          outcome: run.outcome,
          turns: 1,
          sessionIds: [],
          acp: {
            inputTokens: run.usage?.inputTokens ?? 0,
            outputTokens: run.usage?.outputTokens ?? 0,
            cachedReadTokens: run.usage?.cachedReadTokens ?? 0,
            cachedWriteTokens: run.usage?.cachedWriteTokens ?? 0,
            costUSD: run.costUSD,
          },
        },
      });
    },

    acpStarted(run) {
      const requester = run.requesterAgentId && run.requesterAgentId !== run.agent.id
        ? openTaskOf(run.requesterAgentId) : undefined;
      const id = randomUUID();
      write({
        t: 'task',
        task: {
          id,
          agentId: run.agent.id,
          projectPath: run.agent.projectPath ?? null,
          worktreePath: run.agent.worktreePath ?? null,
          provider: run.agent.provider ?? null,
          model: run.agent.model ?? null,
          accountId: run.agent.claudeAccountId ?? null,
          source: 'acp',
          requesterAgentId: run.requesterAgentId ?? null,
          parentTaskId: requester?.id ?? null,
          text: clip(run.text),
          startedAt: run.startedAt,
          endedAt: null,
          lastAt: run.startedAt,
          outcome: 'running',
          turns: 1,
          sessionIds: [],
          acp: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, costUSD: null },
        },
      });
      return id;
    },

    acpEnded(taskId, end) {
      const task = byId.get(taskId);
      if (!task || task.endedAt !== null) return;
      if (end.result) {
        const result = Array.from(end.result).slice(0, RESULT_MAX).join('');
        results.set(taskId, result);
        writeResult(taskId, result);
      }
      write({
        t: 'acp', id: taskId, at: now(), outcome: end.outcome,
        stopReason: STOP_REASON.test(end.stopReason) ? end.stopReason : 'unknown', usage: end.usage, costUSD: end.costUSD,
      });
    },

    task(id) {
      const task = byId.get(id);
      if (!task) return undefined;
      const result = results.get(id);
      return { ...task, sessionIds: [...task.sessionIds], ...(result !== undefined ? { result } : {}) };
    },

    interruptedAtStart() {
      const given = interrupted;
      interrupted = [];
      return given;
    },

    turnUsage(agentId, sessionId, usage) {
      let task: TaskRecord | undefined;
      for (const t of byId.values()) {
        if (t.agentId === agentId && t.sessionIds.includes(sessionId) && (!task || t.startedAt >= task.startedAt)) task = t;
      }
      if (!task) return null;
      write({ t: 'usage', id: task.id, at: now(), sessionId, ...usage });
      return task.id;
    },

    openTaskOf,

    tasks() {
      return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt).map((t) => ({
        ...t, sessionIds: [...t.sessionIds],
        ...(t.usageByModel ? { usageByModel: Object.fromEntries(Object.entries(t.usageByModel).map(([m, u]) => [m, { ...u }])) } : {}),
        ...(t.usageBySession ? { usageBySession: Object.fromEntries(Object.entries(t.usageBySession).map(([sid, models]) => [sid, Object.fromEntries(Object.entries(models).map(([m, u]) => [m, { ...u }]))])) } : {}),
      }));
    },
  };
}

/**
 * The app's ledger, once main.ts has started it (task-watch.ts). Null before
 * that and in the tests of everything else, where a hand-off or a turn is then
 * simply not recorded.
 */
let live: TaskLedger | null = null;

export function setLiveTaskLedger(ledger: TaskLedger | null): void {
  live = ledger;
}

export function liveTaskLedger(): TaskLedger | null {
  return live;
}

/** Who handed the work over, from the sender Tars typed before it. */
export function handOffFrom(sender: MessageSender | undefined): Pick<HandOff, 'source' | 'requesterAgentId'> {
  if (sender?.kind === 'agent') return { source: 'agent', requesterAgentId: sender.id };
  if (sender?.kind === 'channel') return { source: sender.channel.toLowerCase() as HandOff['source'] };
  return { source: 'tars' };
}

/** Recorded, never thrown: a ledger that cannot write must not stop the work it describes. */
export function noteHandOff(agentId: string, handOff: HandOff): void {
  try {
    live?.handedOff(agentId, handOff);
  } catch (err) {
    console.warn('[task-ledger] hand-off not recorded:', (err as Error).message);
  }
}
