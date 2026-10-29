import * as fs from 'fs';
import * as path from 'path';
import { claudeProjectDirNames } from '../platform/claude-project-dir';
import { spellingsOf } from '../utils/resume-session';
import { envelopeValue } from '../utils/envelope-value';

/**
 * A project's MEMORY.md past what Claude Code loads of it (2.0.6, option c; its failures:
 * __tests__/electron/services/memory-guard.test.ts).
 *
 * Measured on Claude Code 2.1.312 (reports/memory-guard-runs/, 29/10): its loader (`per()` in the binary) trims the
 * file, keeps its first 200 lines, then, past 25,000 UTF-16 units (the 24.4 KB it names), cuts at the last line
 * break before 25,000. It tells the model in a WARNING after what it kept, never the user. No line is cut on its
 * own: a 320-character line reached the model whole. What follows measures as it does, so the window and the
 * project's orchestrator learn what never reaches an agent, past 22 KB or 180 lines before it happens.
 */

export const CLAUDE_MEMORY_LIMITS = { size: 25_000, lines: 200 } as const;
export const MEMORY_WARN_AT = { size: 22 * 1024, lines: 180 } as const;

export type MemoryGuardState = 'ok' | 'near' | 'cut' | 'unread';

export interface MemoryGuard {
  state: MemoryGuardState;
  /** The trimmed file's length in UTF-16 units, as Claude Code counts it; null when it could not be read. */
  size: number | null;
  lines: number | null;
  limit: { size: number; lines: number };
  /** What Claude Code does not load: which limit cut, how many lines from which, and how much. */
  cut: { by: 'size' | 'lines' | 'both'; lines: number; fromLine: number; size: number } | null;
  /** The words the window shows as they are, and the orchestrator's note begins with; null well under the limits. */
  notice: string | null;
}

const kb = (units: number) => (units / 1024).toFixed(1);
const TO_DO = 'Keep it an index, one line per memory, and move the details into topic files.';

/** What Claude Code loads of this MEMORY.md, and what it does not; null for a file that could not be read. */
export function guardMemory(text: string | null): MemoryGuard {
  const limit = { ...CLAUDE_MEMORY_LIMITS };
  if (text === null) return { state: 'unread', size: null, lines: null, limit, cut: null, notice: 'The size of MEMORY.md could not be read.' };
  const trimmed = text.trim();
  const lines = trimmed.split('\n').length;
  const size = trimmed.length;
  const byLines = lines > limit.lines;
  const bySize = size > limit.size;
  const head = `MEMORY.md is ${kb(size)} KB in ${lines} ${lines === 1 ? 'line' : 'lines'}`;
  if (!byLines && !bySize) {
    const near = size >= MEMORY_WARN_AT.size || lines >= MEMORY_WARN_AT.lines;
    return {
      state: near ? 'near' : 'ok', size, lines, limit, cut: null,
      notice: near ? `${head}, close to what Claude Code reads of it (${kb(limit.size)} KB and ${limit.lines} lines): past that, the rest never reaches an agent. ${TO_DO}` : null,
    };
  }
  // As per() does: the first 200 lines, then the last line break before 25,000.
  let kept = byLines ? trimmed.split('\n').slice(0, limit.lines).join('\n') : trimmed;
  let keptBySize = false;
  if (kept.length > limit.size) {
    const at = kept.lastIndexOf('\n', limit.size);
    kept = kept.slice(0, at > 0 ? at : limit.size);
    keptBySize = true;
  }
  const keptLines = trimmed[kept.length] === '\n' ? kept.split('\n').length : 0;
  const by = byLines && keptBySize ? 'both' : byLines ? 'lines' : 'size';
  // No line kept whole (a first line past 25,000): the rest of line 1 is lost, and every line after it.
  const cut = { by, lines: lines - keptLines, fromLine: keptLines + 1, size: size - kept.length } as const;
  const first = by === 'both' ? `${limit.lines} lines and ${kb(limit.size)} KB` : by === 'lines' ? `${limit.lines} lines` : `${kb(limit.size)} KB`;
  const after = lines - 1;
  const lost = keptLines === 0
    ? `everything after the first ${kb(limit.size)} KB of line 1${after > 0 ? `, and the ${after} ${after === 1 ? 'line' : 'lines'} after it,` : ''} never reaches an agent (${kb(cut.size)} KB)`
    : `${cut.lines} of its ${lines} lines, from line ${cut.fromLine}, never reach an agent (${kb(cut.size)} KB)`;
  return { state: 'cut', size, lines, limit, cut, notice: `${head}. Claude Code reads only its first ${first}: ${lost}. ${TO_DO}` };
}

/** The most of a MEMORY.md Tars reads: far past what Claude Code loads, so a larger one is cut whatever it holds. */
export const MEMORY_READ_CAP = 1024 * 1024;

export type RegularFileRead =
  | { kind: 'text'; text: string; stat: fs.Stats }
  | { kind: 'too-large'; stat: fs.Stats }
  | { kind: 'not-read' };

/**
 * A memory file read the safe way (the Audit's L2 on #558, then R1 and R2 at 3d34ca644): a regular file only, its
 * link not followed (a FIFO opened for reading waits for a writer for ever, a link may lead to a device), without
 * blocking the main process, and never more than `cap` bytes. The lstat only spares an open; what is decided is
 * decided on the open file: O_NOFOLLOW and O_NONBLOCK where the platform has them (a FIFO or a link swapped in after
 * the lstat opens at once, or not at all), its own stat for its type and its size, and a positional read into a
 * buffer of cap + 1 bytes, so a file grown or swapped since is never read past the cap. A FIFO swapped in is refused
 * twice: by the open file's type, and by the positional read itself (ESPIPE). The guard and the Memory page's listing
 * read through it.
 */
export async function readRegularFile(file: string, cap: number = MEMORY_READ_CAP): Promise<RegularFileRead> {
  try { if (!(await fs.promises.lstat(file)).isFile()) return { kind: 'not-read' }; } catch { return { kind: 'not-read' }; }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'not-read' };
    if (stat.size > cap) return { kind: 'too-large', stat };
    const buffer = Buffer.alloc(cap + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    // Grown past the cap while it was read.
    if (filled > cap) return { kind: 'too-large', stat };
    return { kind: 'text', text: buffer.subarray(0, filled).toString('utf8'), stat };
  } catch {
    return { kind: 'not-read' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A MEMORY.md's guard, read through readRegularFile: past MEMORY_READ_CAP it is said too large, no figure made up. */
export async function guardMemoryFile(file: string): Promise<MemoryGuard> {
  const read = await readRegularFile(file);
  if (read.kind === 'not-read') return guardMemory(null);
  if (read.kind === 'too-large') {
    const size = Math.max(read.stat.size, MEMORY_READ_CAP + 1);
    return {
      state: 'cut', size: null, lines: null, limit: { ...CLAUDE_MEMORY_LIMITS }, cut: null,
      notice: `MEMORY.md is ${(size / 1024 / 1024).toFixed(1)} MB, more than Tars reads of it (${MEMORY_READ_CAP / 1024 / 1024} MB). Claude Code reads only its first ${kb(CLAUDE_MEMORY_LIMITS.size)} KB: everything after that never reaches an agent. ${TO_DO}`,
    };
  }
  return guardMemory(read.text);
}

/** Every project's MEMORY.md under ~/.claude/projects and each Claude account's own folder (~/.claude-accounts/<id>). */
export function findMemoryFiles(home: string): Array<{ folder: string; account: string; file: string }> {
  const roots: Array<{ account: string; dir: string }> = [{ account: 'default', dir: path.join(home, '.claude', 'projects') }];
  for (const id of listDir(path.join(home, '.claude-accounts'))) roots.push({ account: id, dir: path.join(home, '.claude-accounts', id, 'projects') });
  const out: Array<{ folder: string; account: string; file: string }> = [];
  for (const { account, dir } of roots) {
    for (const folder of listDir(dir)) {
      const file = path.join(dir, folder, 'memory', 'MEMORY.md');
      // A regular file only, its link not followed: what else bears the name is not Claude Code's memory to watch.
      let regular = false;
      try { regular = fs.lstatSync(file).isFile(); } catch { /* none */ }
      if (regular) out.push({ folder, account, file });
    }
  }
  return out;
}

function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
}

/** Each memory folder name an agent's project or worktree gives, in both spellings of the path, to that project. */
export function memoryFolderOwners(agents: Iterable<{ projectPath: string; worktreePath?: string }>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const agent of agents) {
    for (const where of [agent.projectPath, agent.worktreePath]) {
      if (!where) continue;
      for (const spelling of spellingsOf(where)) {
        for (const name of claudeProjectDirNames(spelling)) if (!owners.has(name)) owners.set(name, agent.projectPath);
      }
    }
  }
  return owners;
}

/** How much a file must grow since its last note to be told again: 2 KB or 20 lines. */
export const MEMORY_NOTE_STEP = { size: 2 * 1024, lines: 20 } as const;

/** What the orchestrator was told of a file: the most of its size and lines, and the worst state, it heard. */
export interface MemoryTold { size: number; lines: number; state: 'near' | 'cut' }

/**
 * Whether the orchestrator is owed a note: once past the threshold, again when either limit grew past what it was
 * told or the state got worse (the Audit's M1 on #558: a file shrinking in size while passing 200 lines lost lines
 * untold), re-armed under the threshold. A file too large to read gives no figure: told once, as cut.
 */
export function memoryNoteDue(told: MemoryTold | undefined, guard: Pick<MemoryGuard, 'state' | 'size' | 'lines'>): { tell: boolean; told: MemoryTold | undefined } {
  if (guard.state === 'ok') return { tell: false, told: undefined };
  if (guard.state === 'unread') return { tell: false, told };
  const state = guard.state;
  if (guard.size === null || guard.lines === null) {
    return told?.state === 'cut' ? { tell: false, told } : { tell: true, told: { size: told?.size ?? 0, lines: told?.lines ?? 0, state } };
  }
  if (!told) return { tell: true, told: { size: guard.size, lines: guard.lines, state } };
  const worse = state === 'cut' && told.state === 'near';
  // A file being written to grows a little at every pass: told again only past a step (the orchestrator's decision
  // on the Audit's I9 of #558: 10 notes in 10 passes for one line a pass).
  const grown = guard.size >= told.size + MEMORY_NOTE_STEP.size || guard.lines >= told.lines + MEMORY_NOTE_STEP.lines;
  if (!worse && !grown) return { tell: false, told };
  return { tell: true, told: { size: Math.max(told.size, guard.size), lines: Math.max(told.lines, guard.lines), state: worse ? 'cut' : told.state === 'cut' ? 'cut' : state } };
}

export interface MemoryGuardPass {
  home: string;
  /** Where the sizes told are kept, so a restart of Tars does not tell again (in ~/.tars). */
  store: string;
  /** The project each memory folder belongs to (memoryFolderOwners). */
  owners: Map<string, string>;
  /** Tars's note to that project's orchestrator; only one typed is told (kanban-routes.ts tellOrchestratorAsTars). */
  tell: (projectPath: string, text: string) => Promise<string>;
}

/** One pass over every project's MEMORY.md: the notes owed, told, and what was told kept. Never throws. */
export async function runMemoryGuardPass(opts: MemoryGuardPass): Promise<void> {
  const told = readStore(opts.store);
  let changed = false;
  const files = findMemoryFiles(opts.home);
  // A file no longer found is forgotten, in this pass: written again past the limit, smaller than what was told, it
  // would never be told (the QA's F1 on #558: a new file losing 14 lines with no note).
  const found = new Set(files.map(f => f.file));
  for (const file of Object.keys(told)) if (!found.has(file)) { delete told[file]; changed = true; }
  for (const { folder, file } of files) {
    const guard = await guardMemoryFile(file);
    const step = memoryNoteDue(told[file], guard);
    if (step.told === undefined && told[file] !== undefined) { delete told[file]; changed = true; }
    const project = opts.owners.get(folder);
    if (!step.tell || !project) continue;
    // The path holds an account folder's name, any name under ~/.claude-accounts: quoted and escaped, as every value
    // a note from Tars interpolates (utils/envelope-value.ts; the Audit's L3 on #558).
    const delivery = await opts.tell(project, `${guard.notice} The file: ${envelopeValue(file)}`).catch(() => 'failed');
    // Not typed (the orchestrator busy, or none running): owed, and given at a later pass.
    if (delivery === 'typed') { told[file] = step.told!; changed = true; }
  }
  if (changed) writeStore(opts.store, told);
}

function readStore(file: string): Record<string, MemoryTold> {
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, MemoryTold] => {
      const t = e[1] as Partial<MemoryTold> | null;
      return !!t && typeof t === 'object' && count(t.size) && count(t.lines) && (t.state === 'near' || t.state === 'cut');
    }));
  } catch { return {}; }
}

function writeStore(file: string, told: Record<string, MemoryTold>): void {
  try { fs.writeFileSync(file, JSON.stringify(told, null, 2)); } catch (err) { console.warn('[memory-guard] what was told could not be kept:', (err as Error).message); }
}

/** The pass every `everyMs`, one at a time, until stopped; the timer never holds the app open. */
export function startMemoryGuard(everyMs: number, pass: () => MemoryGuardPass): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runMemoryGuardPass(pass()).finally(() => { running = false; });
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
