import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A project's MEMORY.md past what Claude Code loads of it (2.0.6, option c; the brief of 29/10 said 24.4 KB, cut
 * silently). Measured on Claude Code 2.1.312 before writing this (reports/memory-guard-runs/):
 * - its loader (`per()`, read in the binary) trims the file, counts its lines and its length in UTF-16 units (not
 *   bytes), keeps the first 200 lines, then, past 25,000 units, cuts at the last line break before 25,000;
 * - it tells the model, not the user: "> WARNING: MEMORY.md is 260 lines (limit: 200). Only part of it was loaded:
 *   60 of 260 lines were cut off, starting at line 201 (...)" (probe-claude.sh, haiku, 29/10);
 * - 150 lines of 200 characters (30,269 bytes): the index ends at L123, "27 of 150 lines were cut off, starting at line
 *   124", and "29.6KB (limit: 24.4KB)";
 * - no line is cut on its own: a 320-character line reached the model whole, and the " …" the Audit saw at about 150
 *   characters are in the files themselves (this project's MEMORY.md, its entries shortened by hand).
 *
 * How it fails, written before the code (29/10):
 * M1. It measures what Claude Code does not: bytes for its length (a French index of 24,000 characters is 26 KB of
 *     bytes and is not cut), untrimmed text, a trailing newline as one more line.
 * M2. The line cut: a file of 260 lines is not said cut, or not as Claude Code cuts it (60 of 260, from line 201).
 * M3. The size cut: the probe's 150 lines of 200 characters are not said cut at line 124, 27 of 150 lines.
 * M4. Both at once, or a first line alone past the size: a count of lines that is not what is lost.
 * M5. Close to the limits (22 KB, or 180 lines) is not said, or said for a file well under them; a file that cannot
 *     be read gets a made-up size instead of none.
 * M6. The words: how much and which lines never reach an agent, and what to do; none for a file well under.
 * M7. The files watched: every project's memory/MEMORY.md under ~/.claude/projects and under each Claude account's own
 *     folder (~/.claude-accounts/<id>/projects); a project folder with no MEMORY.md, or a memory that is not a folder,
 *     is taken for one. Paths built with the platform's own separator (Windows' and Linux's ~/.claude too).
 * M8. A memory folder is put to the wrong project, or to none: an agent's project, and the worktree it works in, both
 *     name it, in both spellings of a path (as saved, and real).
 * M9. Told every pass, or never again: once when the file passes 22 KB or 180 lines, again only when it grew since,
 *     and again after it fell back under and passed once more.
 * M10. The run: the note goes to the project's orchestrator with the file's path; one not typed (the orchestrator
 *     busy) is owed and given at a later pass; a folder no project owns tells nobody; a restart of Tars does not
 *     tell again what was told (the told sizes kept in a file).
 * M11. The window's Memory rows do not carry it: a project's row with a MEMORY.md must say its guard; one that
 *     cannot be read says the size was not read.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-memory-guard-')));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** The probe's files (reports/memory-guard-runs/make-memory.py): numbered lines, line 5 being 320 characters. */
function probeFile(count: number, width: number): string {
  const out: string[] = [];
  for (let n = 1; n <= count; n++) {
    const head = `- L${String(n).padStart(3, '0')} memory entry`;
    out.push(n === 5
      ? `${head} ${'x'.repeat(320 - head.length - ' LONGLINE-TAIL-OK'.length - 1)} LONGLINE-TAIL-OK`
      : `${head} ${'y'.repeat(Math.max(0, width - head.length - 1))}`.slice(0, Math.max(width, head.length)));
  }
  return out.join('\n') + '\n';
}

describe('what Claude Code loads of a MEMORY.md', () => {
  it('M1. measures as Claude Code does: trimmed, in lines and UTF-16 units, not bytes', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    const french = 'é'.repeat(24_000);
    expect(Buffer.byteLength(french)).toBe(48_000);
    const g = guardMemory(`\n\n${french}\n\n`);
    expect(g).toMatchObject({ size: 24_000, lines: 1, cut: null });
    expect(guardMemory('a\nb\n').lines).toBe(2);
    expect(guardMemory('😀').size).toBe(2);
  });

  it('M2. the line cut: 260 lines keep 200, 60 cut from line 201, as the CLI said', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    expect(guardMemory(probeFile(260, 40))).toMatchObject({ state: 'cut', lines: 260, cut: { by: 'lines', lines: 60, fromLine: 201 } });
    expect(guardMemory(probeFile(200, 40)).cut).toBeNull();
  });

  it('M3. the size cut: 150 lines of 200 characters keep 123, 27 cut from line 124, as the CLI said', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    const g = guardMemory(probeFile(150, 200));
    expect(g).toMatchObject({ state: 'cut', lines: 150, cut: { by: 'size', lines: 27, fromLine: 124 } });
    expect(g.size).toBe(30_269);
    expect(g.cut!.size).toBe(30_269 - (123 * 201 - 1 + (320 - 200)));
  });

  it('M4. both cuts, and a first line alone past the size', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    expect(guardMemory(probeFile(300, 200)).cut).toMatchObject({ by: 'both', lines: 177, fromLine: 124 });
    expect(guardMemory('z'.repeat(30_000)).cut).toEqual({ by: 'size', lines: 1, fromLine: 1, size: 5_000 });
  });

  it('M5. close to the limits, well under them, and a file that cannot be read', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    expect(guardMemory('q'.repeat(22 * 1024)).state).toBe('near');
    expect(guardMemory('q'.repeat(22 * 1024 - 1)).state).toBe('ok');
    expect(guardMemory(probeFile(180, 20)).state).toBe('near');
    expect(guardMemory(probeFile(179, 20)).state).toBe('ok');
    expect(guardMemory(null)).toEqual({ state: 'unread', size: null, lines: null, limit: { size: 25_000, lines: 200 }, cut: null, notice: 'The size of MEMORY.md could not be read.' });
  });

  it('M6. the words say how much, which lines, and what to do; none well under', async () => {
    const { guardMemory } = await import('../../../electron/services/memory-guard');
    expect(guardMemory(probeFile(150, 200)).notice).toBe('MEMORY.md is 29.6 KB in 150 lines. Claude Code reads only its first 24.4 KB: 27 of its 150 lines, from line 124, never reach an agent (5.3 KB). Keep it an index, one line per memory, and move the details into topic files.');
    expect(guardMemory(probeFile(260, 40)).notice).toBe('MEMORY.md is 10.7 KB in 260 lines. Claude Code reads only its first 200 lines: 60 of its 260 lines, from line 201, never reach an agent (2.4 KB). Keep it an index, one line per memory, and move the details into topic files.');
    expect(guardMemory(probeFile(300, 200)).notice).toMatch(/^MEMORY\.md is 59\.\d KB in 300 lines\. Claude Code reads only its first 200 lines and 24\.4 KB: 177 of its 300 lines, from line 124, never reach an agent/);
    expect(guardMemory('z'.repeat(30_000)).notice).toBe('MEMORY.md is 29.3 KB in 1 line. Claude Code reads only its first 24.4 KB: the end of line 1 never reaches an agent (4.9 KB). Keep it an index, one line per memory, and move the details into topic files.');
    expect(guardMemory('q'.repeat(23_000)).notice).toBe('MEMORY.md is 22.5 KB in 1 line, close to what Claude Code reads of it (24.4 KB and 200 lines): past that, the rest never reaches an agent. Keep it an index, one line per memory, and move the details into topic files.');
    expect(guardMemory('short').notice).toBeNull();
    for (const g of [guardMemory(probeFile(150, 200)), guardMemory('q'.repeat(23_000))]) expect(g.notice).not.toMatch(/[–—]/);
  });
});

describe('the MEMORY.md files Tars watches', () => {
  const home = path.join(tmp, 'home');
  const put = (rel: string, text = '# memory\n') => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };

  it('M7. every project\'s, under ~/.claude and each account\'s folder, and nothing else', async () => {
    const { findMemoryFiles } = await import('../../../electron/services/memory-guard');
    put(path.join('.claude', 'projects', '-p-one', 'memory', 'MEMORY.md'));
    put(path.join('.claude', 'projects', '-p-none', 'memory', 'notes.md'));
    put(path.join('.claude', 'projects', '-p-file', 'memory'));
    put(path.join('.claude-accounts', 'acc2', 'projects', '-p-two', 'memory', 'MEMORY.md'));
    const found = findMemoryFiles(home).sort((a, b) => a.folder.localeCompare(b.folder));
    expect(found).toEqual([
      { folder: '-p-one', account: 'default', file: path.join(home, '.claude', 'projects', '-p-one', 'memory', 'MEMORY.md') },
      { folder: '-p-two', account: 'acc2', file: path.join(home, '.claude-accounts', 'acc2', 'projects', '-p-two', 'memory', 'MEMORY.md') },
    ]);
    expect(findMemoryFiles(path.join(tmp, 'no-home'))).toEqual([]);
  });

  it('M8. a memory folder belongs to the project of the agent working there, by its project or its worktree', async () => {
    const { memoryFolderOwners } = await import('../../../electron/services/memory-guard');
    const project = path.join(tmp, 'harbor');
    const worktree = path.join(tmp, 'harbor', '.worktrees', 'w1');
    fs.mkdirSync(worktree, { recursive: true });
    const link = path.join(tmp, 'harbor-link');
    fs.symlinkSync(project, link);
    const owners = memoryFolderOwners([{ projectPath: link, worktreePath: worktree }]);
    const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
    expect(owners.get(enc(link))).toBe(link);
    expect(owners.get(enc(project))).toBe(link);
    expect(owners.get(enc(worktree))).toBe(link);
    expect(owners.get(enc(path.join(tmp, 'elsewhere')))).toBeUndefined();
  });
});

describe('telling the project\'s orchestrator', () => {
  it('M9. once past the threshold, again only when it grew, and again after falling back under', async () => {
    const { memoryNoteDue } = await import('../../../electron/services/memory-guard');
    const at = (size: number) => ({ state: size >= 22 * 1024 ? (size > 25_000 ? 'cut' : 'near') : 'ok', size } as const);
    let told: number | undefined;
    const said: number[] = [];
    for (const size of [10_000, 23_000, 23_000, 22_900, 23_500, 30_000, 30_000, 9_000, 22_600]) {
      const step = memoryNoteDue(told, at(size));
      if (step.tell) said.push(size);
      told = step.told;
    }
    expect(said).toEqual([23_000, 23_500, 30_000, 22_600]);
    expect(memoryNoteDue(23_000, { state: 'unread', size: null })).toEqual({ tell: false, told: 23_000 });
  });

  it('M10. the run tells the owner\'s orchestrator, owes a note not typed, tells nobody for no owner, and keeps what it told', async () => {
    const { runMemoryGuardPass } = await import('../../../electron/services/memory-guard');
    const home = path.join(tmp, 'run-home');
    const dir = (folder: string) => path.join(home, '.claude', 'projects', folder, 'memory');
    fs.mkdirSync(dir('-owned'), { recursive: true });
    fs.mkdirSync(dir('-stray'), { recursive: true });
    fs.writeFileSync(path.join(dir('-owned'), 'MEMORY.md'), probeFile(150, 200));
    fs.writeFileSync(path.join(dir('-stray'), 'MEMORY.md'), probeFile(150, 200));
    const store = path.join(tmp, 'run-store.json');
    const notes: Array<{ project: string; text: string }> = [];
    let delivery: 'typed' | 'not-now' = 'not-now';
    const pass = () => runMemoryGuardPass({
      home, store, owners: new Map([['-owned', '/p/harbor']]),
      tell: async (project, text) => { notes.push({ project, text }); return delivery; },
    });
    await pass();
    expect(notes).toHaveLength(1);
    delivery = 'typed';
    await pass();
    expect(notes).toHaveLength(2);
    expect(notes[1].project).toBe('/p/harbor');
    expect(notes[1].text).toContain('MEMORY.md is 29.6 KB in 150 lines.');
    expect(notes[1].text).toContain(path.join(dir('-owned'), 'MEMORY.md'));
    await pass();
    expect(notes, 'told again with nothing grown, or by a new guard after a restart').toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))).toEqual({ [path.join(dir('-owned'), 'MEMORY.md')]: 30_269 });
  });
});

describe('the window\'s Memory rows', () => {
  it('M11. a row with a MEMORY.md carries its guard; one that cannot be read says so', async () => {
    const fakeHome = path.join(tmp, 'rows-home');
    vi.resetModules();
    vi.doMock('os', async (orig) => {
      const actual = await orig<typeof import('os')>();
      return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
    });
    try {
      const memory = path.join(fakeHome, '.claude', 'projects', '-p-big', 'memory');
      fs.mkdirSync(memory, { recursive: true });
      fs.writeFileSync(path.join(memory, 'MEMORY.md'), probeFile(150, 200));
      const unread = path.join(fakeHome, '.claude', 'projects', '-p-locked', 'memory');
      fs.mkdirSync(unread, { recursive: true });
      fs.mkdirSync(path.join(unread, 'MEMORY.md'));
      const { listProjectMemories } = await import('../../../electron/services/memory-service');
      const rows = await listProjectMemories([]);
      const big = rows.find(r => r.memoryDir === memory)!;
      expect(big.guard).toMatchObject({ state: 'cut', cut: { by: 'size', lines: 27, fromLine: 124 } });
      expect(rows.find(r => r.memoryDir === unread)!.guard).toMatchObject({ state: 'unread', size: null });
    } finally {
      vi.doUnmock('os');
      vi.resetModules();
    }
  });
});
