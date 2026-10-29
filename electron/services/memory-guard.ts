import * as fs from 'fs';
import * as path from 'path';
import { claudeProjectDirNames } from '../platform/claude-project-dir';
import { spellingsOf } from '../utils/resume-session';

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
  const cut = { by, lines: keptLines === 0 ? 1 : lines - keptLines, fromLine: keptLines + 1, size: size - kept.length } as const;
  const first = by === 'both' ? `${limit.lines} lines and ${kb(limit.size)} KB` : by === 'lines' ? `${limit.lines} lines` : `${kb(limit.size)} KB`;
  const lost = keptLines === 0
    ? `the end of line 1 never reaches an agent (${kb(cut.size)} KB)`
    : `${cut.lines} of its ${lines} lines, from line ${cut.fromLine}, never reach an agent (${kb(cut.size)} KB)`;
  return { state: 'cut', size, lines, limit, cut, notice: `${head}. Claude Code reads only its first ${first}: ${lost}. ${TO_DO}` };
}

/** Every project's MEMORY.md under ~/.claude/projects and each Claude account's own folder (~/.claude-accounts/<id>). */
export function findMemoryFiles(home: string): Array<{ folder: string; account: string; file: string }> {
  const roots: Array<{ account: string; dir: string }> = [{ account: 'default', dir: path.join(home, '.claude', 'projects') }];
  for (const id of listDir(path.join(home, '.claude-accounts'))) roots.push({ account: id, dir: path.join(home, '.claude-accounts', id, 'projects') });
  const out: Array<{ folder: string; account: string; file: string }> = [];
  for (const { account, dir } of roots) {
    for (const folder of listDir(dir)) {
      const file = path.join(dir, folder, 'memory', 'MEMORY.md');
      if (fs.existsSync(file)) out.push({ folder, account, file });
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

/** Whether the orchestrator is owed a note: once past the threshold, again only when it grew, re-armed under it. */
export function memoryNoteDue(told: number | undefined, guard: Pick<MemoryGuard, 'state' | 'size'>): { tell: boolean; told: number | undefined } {
  if (guard.state === 'ok') return { tell: false, told: undefined };
  if (guard.state === 'unread' || guard.size === null) return { tell: false, told };
  return told === undefined || guard.size > told ? { tell: true, told: guard.size } : { tell: false, told };
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
  for (const { folder, file } of findMemoryFiles(opts.home)) {
    let text: string | null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
    const guard = guardMemory(text);
    const step = memoryNoteDue(told[file], guard);
    if (step.told === undefined && told[file] !== undefined) { delete told[file]; changed = true; }
    const project = opts.owners.get(folder);
    if (!step.tell || !project) continue;
    const delivery = await opts.tell(project, `${guard.notice} The file: ${file}`).catch(() => 'failed');
    // Not typed (the orchestrator busy, or none running): owed, and given at a later pass.
    if (delivery === 'typed') { told[file] = step.told!; changed = true; }
  }
  if (changed) writeStore(opts.store, told);
}

function readStore(file: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
  } catch { return {}; }
}

function writeStore(file: string, told: Record<string, number>): void {
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
