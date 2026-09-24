import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { transcriptPath, transcriptRoots } from '../utils/resume-session';

/**
 * What an agent is actually on, as opposed to what Tars last wrote down.
 *
 * The branch: the working tree wins, since `agent.branchName` was only ever set
 * by Tars, and an agent's own `git checkout -b` never showed on its card.
 *
 * The model: the record wins, and is what a launch uses. The session's model
 * used to replace it everywhere, so a choice made later lost to the model a
 * session last answered on (thirteen agents moved to Opus 5.5 relaunched on
 * their old model), and the edit screen wrote the old one back. The session's
 * reading travels beside the record as `sessionModel`, for a screen showing a
 * `/model` typed in. Both readings are cached: the list is rebuilt about twice
 * a second.
 */

/** Short enough that a checkout shows up promptly, long enough that a list
 *  refreshing twice a second does not run git twice a second per agent. */
const TTL_MS = 5_000;

const branchCache = new Map<string, { value: string | null; at: number }>();
const modelCache = new Map<string, { value: string | null; at: number }>();

/* ── The branch ──────────────────────────────────────────────────────── */

/**
 * Read in the background and served from the cache: the list is built
 * synchronously and cannot wait on git, so a miss returns null and starts the
 * read, and the next refresh, a few hundred milliseconds later, has it.
 */
export function currentBranch(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const hit = branchCache.get(cwd);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  // Mark it fresh before the call, so a burst of list rebuilds spawns one git
  // rather than one per rebuild.
  branchCache.set(cwd, { value: hit?.value ?? null, at: now });
  execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, (err, stdout) => {
    const value = err ? null : stdout.trim() || null;
    // HEAD detached reads as "HEAD", which is not a branch name worth showing.
    branchCache.set(cwd, { value: value === 'HEAD' ? null : value, at: Date.now() });
  });
  return hit?.value ?? null;
}

/* ── The model ───────────────────────────────────────────────────────── */

/** The last line of a file, without reading the whole thing into memory twice.
 *  Transcripts run to megabytes and this is called per agent per refresh. */
function lastAssistantModel(file: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const model = typeof message?.model === 'string' ? message.model : null;
    // `<synthetic>` is what Claude Code writes for messages it generated
    // itself; it is not a model anyone chose.
    if (model && model !== '<synthetic>') return model;
  }
  return null;
}

/**
 * The model the session last answered on, or null, read from the transcript
 * so it reflects a `/model` typed into the terminal. For a screen, never a
 * launch.
 */
export function sessionModel(
  agent: { resumableSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): string | null {
  const sessionId = agent.resumableSessionId?.trim();
  if (!sessionId) return null;

  const key = sessionId;
  const hit = modelCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let found: string | null = null;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    const file = transcriptPath(root, sessionId, homeDir);
    if (!fs.existsSync(file)) continue;
    found = lastAssistantModel(file);
    if (found) break;
  }
  modelCache.set(key, { value: found, at: now });
  return found;
}

/* ── Work still running after the turn ─────────────────────────────────── */

const TASK_NOTE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const TASK_STATUS = /<status>([^<]+)<\/status>/;
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);

/** How much of a transcript's end the local-command probe reads. A command's
 *  three records take a few hundred bytes; a transcript runs to megabytes. */
const LOCAL_COMMAND_TAIL = 256 * 1024;

/**
 * When the session last recorded a local command finishing (ms since the
 * epoch), or undefined. A command typed at the prompt (/model, /effort,
 * /config ...) never reaches the model, so no UserPromptSubmit fires; it leaves
 * three records (`<local-command-caveat>`, `<command-name>`,
 * `<local-command-stdout>`) written when it finishes: 44 to 74 ms after the key
 * that closes a /model or /effort picker, and for /config only when it finally
 * closes (Claude Code 2.1.280). By then the field is empty.
 *
 * Silent for commands that write no such record: /help, /config closed with no
 * change, and /model cancelled with Esc, whose two `system` records are skipped
 * on purpose, since backing out of "Switch model?" writes the same pair while
 * the picker stays open (the gate of #128).
 */
export function lastLocalCommandAt(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): number | undefined {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return undefined;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    const file = transcriptPath(root, sessionId, homeDir);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const { size, mtimeMs } = fs.fstatSync(fd);
      // Asked every second while a message waits on a field somebody left
      // something in: the tail is read again only when the file has changed.
      const known = lastReadOf.get(file);
      if (known && known.size === size && known.mtimeMs === mtimeMs) return known.at;
      const length = Math.min(size, LOCAL_COMMAND_TAIL);
      const tail = Buffer.alloc(length);
      fs.readSync(fd, tail, 0, length, size - length);
      const at = latestLocalCommand(tail.toString('utf-8'));
      lastReadOf.set(file, { size, mtimeMs, at });
      return at;
    } catch {
      // not in this root
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return undefined;
}

/** What lastLocalCommandAt last read in each transcript, and the file it read it from. */
const lastReadOf = new Map<string, { size: number; mtimeMs: number; at: number | undefined }>();

/** The newest local-command record in some transcript lines, as its time. */
function latestLocalCommand(lines: string): number | undefined {
  let latest: number | undefined;
  for (const line of lines.split('\n')) {
    if (!line.includes('<command-name>') && !line.includes('<local-command-stdout>')) continue;
    let entry: Record<string, unknown>;
    try {
      // The first line of a tail is usually cut in two, and fails here.
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    // The CLI's own record starts with the tag; a prompt that quotes one does not.
    if (!/^\s*<(command-name|local-command-stdout)>/.test(text)) continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

/**
 * The background work this session started and has not heard back from. A turn
 * can end with work running (a background Bash, a Monitor, an async Agent):
 * Claude Code stops the turn (Tars reads `idle`), and when the work finishes a
 * `<task-notification>` starts the next turn by itself, so killing the CLI in
 * between kills both (on 2.1.280, a `sleep 25` went to the background and the
 * turn stopped ten seconds in).
 *
 * Both ends are structured in the transcript. Over a week of JeanBrasse's (329
 * starts): a Bash start carries `toolUseResult.backgroundTaskId`, a Monitor
 * `toolUseResult.taskId`, an async Agent `agentId` with `isAsync`; 322 ended in
 * a note naming the id with a `<status>`, 7 in TaskStop (which sends no note),
 * and 3 still ran. A Monitor's event notes carry no status: only a status ends
 * it.
 *
 * `sinceMs` is the launch of the CLI running now: a resumed or forked session
 * copies the earlier conversation with its old timestamps, and a task started
 * by a process that is gone is not running.
 */
export function pendingBackgroundWork(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  sinceMs: number,
  homeDir = os.homedir(),
): string[] {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return [];
  let raw: string | undefined;
  for (const root of transcriptRoots(agent.worktreePath, agent.projectPath)) {
    try {
      raw = fs.readFileSync(transcriptPath(root, sessionId, homeDir), 'utf-8');
      break;
    } catch {
      // not in this root
    }
  }
  if (!raw) return [];

  const started = new Set<string>();
  const finished = new Set<string>();
  const monitorCalls = new Set<string>();
  for (const line of raw.split('\n')) {
    // Most lines are none of these, and a transcript runs to megabytes.
    if (!/backgroundTaskId|isAsync|taskId|task-notification|Monitor|TaskStop|KillShell|KillBash/.test(line)) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(Date.parse(String(entry.timestamp ?? '')) >= sinceMs)) continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];

    if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'Monitor' && typeof block.id === 'string') monitorCalls.add(block.id);
        if (STOP_TOOLS.has(String(block.name))) {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = input.task_id ?? input.shell_id ?? input.bash_id;
          if (typeof id === 'string') finished.add(id);
        }
      }
      continue;
    }
    if (entry.type !== 'user') continue;

    const result = entry.toolUseResult as Record<string, unknown> | undefined;
    if (result && typeof result === 'object') {
      if (typeof result.backgroundTaskId === 'string') started.add(result.backgroundTaskId);
      else if (result.isAsync === true && typeof result.agentId === 'string') started.add(result.agentId);
      else if (typeof result.taskId === 'string'
        && blocks.some(b => b.type === 'tool_result' && monitorCalls.has(String(b.tool_use_id)))) {
        started.add(result.taskId);
      }
    }
    const text = typeof content === 'string'
      ? content
      : blocks.map(b => (typeof b.text === 'string' ? b.text : '')).join('\n');
    for (const [, note] of text.matchAll(TASK_NOTE)) {
      const id = note.match(TASK_ID)?.[1];
      const status = note.match(TASK_STATUS)?.[1]?.trim();
      if (id && status && status !== 'running') finished.add(id);
    }
  }
  return [...started].filter(id => !finished.has(id));
}

/**
 * The agent as it really is: its record, with the branch the working tree
 * reports and, beside `model` (what the next launch and the edit screen use),
 * the model its session last answered on, as `sessionModel`. Only fills in: a
 * null reading leaves the stored value alone.
 */
export function withSessionTruth<T extends {
  model?: string;
  branchName?: string;
  projectPath?: string;
  worktreePath?: string;
  resumableSessionId?: string;
}>(agent: T): T & { sessionModel?: string } {
  const branch = currentBranch(agent.worktreePath || agent.projectPath);
  const model = sessionModel(agent);
  return {
    ...agent,
    ...(branch ? { branchName: branch } : {}),
    ...(model ? { sessionModel: model } : {}),
  };
}

/** Test seam. */
export function clearAgentTruthCache(): void {
  branchCache.clear();
  modelCache.clear();
}


/**
 * When the session's turn was last interrupted, or undefined. Claude Code
 * records an interrupt as a user entry beginning `[Request interrupted by user`
 * and sends no hook for it (no Stop, no idle prompt in the Audit's 90 s);
 * refusing a permission writes it too, the only sign the dialog is gone (the
 * Audit's gate of #174). Read under both spellings of the project path, and
 * again only when the file changed: the writer asks every second.
 */
export function lastInterruptAt(
  agent: { currentSessionId?: string; projectPath?: string; worktreePath?: string },
  homeDir = os.homedir(),
): number | undefined {
  const sessionId = agent.currentSessionId?.trim();
  if (!sessionId) return undefined;
  const roots = transcriptRoots(agent.worktreePath, agent.projectPath);
  let latest: number | undefined;
  for (const root of roots) {
    const file = transcriptPath(root, sessionId, homeDir);
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const { size, mtimeMs } = fs.fstatSync(fd);
      const known = interruptReadOf.get(file);
      let at: number | undefined;
      if (known && known.size === size && known.mtimeMs === mtimeMs) {
        at = known.at;
      } else {
        const length = Math.min(size, LOCAL_COMMAND_TAIL);
        const tail = Buffer.alloc(length);
        fs.readSync(fd, tail, 0, length, size - length);
        at = latestInterrupt(tail.toString('utf-8'));
        interruptReadOf.set(file, { size, mtimeMs, at });
      }
      if (at !== undefined && (latest === undefined || at > latest)) latest = at;
    } catch {
      // not in this root
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return latest;
}

const interruptReadOf = new Map<string, { size: number; mtimeMs: number; at: number | undefined }>();

function latestInterrupt(lines: string): number | undefined {
  let latest: number | undefined;
  for (const line of lines.split('\n')) {
    if (!line.includes('[Request interrupted by user')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    if (!text.trimStart().startsWith('[Request interrupted by user')) continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}
