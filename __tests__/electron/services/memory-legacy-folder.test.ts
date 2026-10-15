import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A MEMORY.md an older Tars made under a folder Claude never reads (the gate
 * of #375, M1).
 *
 * Before 1.9.6, Memory named a project's folder on macOS and Linux by `/` and
 * `.` to `-`: for `/Users/me/my_proj with space` that is
 * `-Users-me-my_proj with space`, where Claude Code never looks; Claude's own
 * is `-Users-me-my-proj-with-space`. Measured by the Audit on a throwaway HOME
 * holding both (the old one with the MEMORY.md, Claude's after one session):
 * the Memory page listed the project twice under the same path, the old
 * memory in one row Claude does not read, and an empty row where it does.
 * JeanBrasse's orchestrator chose: a one-time copy into Claude's folder, never
 * overwriting, the old file kept; one row per project, Claude's, which names
 * the older copy.
 *
 * How it fails, written before the code:
 *  1. The project is listed twice, or its row is the old folder, or Claude's
 *     folder does not end up holding the old memory.
 *  2. A MEMORY.md already in Claude's folder is overwritten, or the old file
 *     is moved or deleted.
 *  3. Claude's folder does not exist yet (the project has not run since):
 *     nothing is copied, and the only row is the old folder.
 *  4. Listing again copies again, or changes what is there.
 *  5. A folder of a project Tars does not know is touched.
 *  6. A copy that fails (Claude's folder cannot be written) breaks the
 *     listing, or loses the old memory from the page.
 *  7. The memory's other files (every .md of the old memory folder) stay behind.
 *  8. A file Claude's folder already holds, other than MEMORY.md (a topic
 *     Claude wrote), is overwritten by the old folder's file of that name.
 *  9. Claude's folder already holds a MEMORY.md, and the old folder's other
 *     files are copied in anyway, beside an index that never names them (QA's
 *     gate of #375: lifting the guard on Claude's MEMORY.md kept every case
 *     above green, case 2's old folder holding a MEMORY.md alone).
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mem-legacy-')));
const fakeHome = path.join(tmp, 'home');
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fakeHome }, homedir: () => fakeHome };
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const PROJECT = '/Users/me/my_proj with space';
const LEGACY = '-Users-me-my_proj with space';
const CLAUDES = '-Users-me-my-proj-with-space';
const projects = () => path.join(fakeHome, '.claude', 'projects');
const memory = (folder: string, file = 'MEMORY.md') => path.join(projects(), folder, 'memory', file);
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

async function list(known = [PROJECT]) {
  vi.resetModules();
  const { listProjectMemories } = await import('../../../electron/services/memory-service');
  return (await listProjectMemories(known)).filter((p) => p.provider === 'claude' || p.id.startsWith('tars:'));
}
const rowsOf = (rows: Awaited<ReturnType<typeof list>>, projectPath = PROJECT) => rows.filter((r) => r.projectPath === projectPath);

beforeEach(() => { fs.rmSync(projects(), { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('a memory an older Tars made under a folder Claude never reads', () => {
  it('1, 7. is copied into Claude\'s folder, its other memory files included, and the project is one row, Claude\'s, naming the older copy', async () => {
    put(memory(LEGACY), '# remembered\n- see [[topic]]\n');
    put(memory(LEGACY, 'topic.md'), 'the topic\n');
    put(path.join(projects(), CLAUDES, '0b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70.jsonl'), '{}\n');
    const rows = rowsOf(await list());
    expect(read(memory(CLAUDES))).toBe('# remembered\n- see [[topic]]\n');
    expect(read(memory(CLAUDES, 'topic.md'))).toBe('the topic\n');
    expect(rows).toHaveLength(1);
    expect(path.basename(path.dirname(rows[0].memoryDir))).toBe(CLAUDES);
    expect(rows[0].hasMemory).toBe(true);
    expect(rows[0].files.map((f) => f.name)).toEqual(['MEMORY.md', 'topic.md']);
    expect(rows[0].olderCopy).toBe(path.join(projects(), LEGACY, 'memory'));
    // 2. the old file stays
    expect(read(memory(LEGACY))).toBe('# remembered\n- see [[topic]]\n');
  });

  it('2. never overwrites a MEMORY.md Claude\'s folder holds', async () => {
    put(memory(LEGACY), 'old\n');
    put(memory(CLAUDES), 'what Claude reads\n');
    const rows = rowsOf(await list());
    expect(read(memory(CLAUDES))).toBe('what Claude reads\n');
    expect(read(memory(LEGACY))).toBe('old\n');
    expect(rows).toHaveLength(1);
    expect(path.basename(path.dirname(rows[0].memoryDir))).toBe(CLAUDES);
    expect(rows[0].olderCopy).toBe(path.join(projects(), LEGACY, 'memory'));
  });

  it('9. copies nothing in when Claude\'s folder already holds a MEMORY.md, the old topic files included', async () => {
    put(memory(LEGACY), 'old\n- see [[topic]]\n');
    put(memory(LEGACY, 'topic.md'), 'the old topic\n');
    put(memory(CLAUDES), 'what Claude reads\n');
    const rows = rowsOf(await list());
    expect(fs.readdirSync(path.join(projects(), CLAUDES, 'memory'))).toEqual(['MEMORY.md']);
    expect(read(memory(CLAUDES))).toBe('what Claude reads\n');
    expect(read(memory(LEGACY, 'topic.md'))).toBe('the old topic\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].olderCopy).toBe(path.join(projects(), LEGACY, 'memory'));
  });

  it('8. never overwrites another file Claude\'s folder holds', async () => {
    put(memory(LEGACY), 'old\n');
    put(memory(LEGACY, 'topic.md'), 'the old topic\n');
    put(memory(CLAUDES, 'topic.md'), 'the topic Claude wrote\n');
    await list();
    expect(read(memory(CLAUDES, 'topic.md'))).toBe('the topic Claude wrote\n');
    expect(read(memory(CLAUDES))).toBe('old\n');
  });

  it('3. makes Claude\'s folder when the project has not run since', async () => {
    put(memory(LEGACY), 'old\n');
    const rows = rowsOf(await list());
    expect(read(memory(CLAUDES))).toBe('old\n');
    expect(rows).toHaveLength(1);
    expect(path.basename(path.dirname(rows[0].memoryDir))).toBe(CLAUDES);
  });

  it('4. copies once: a second listing changes nothing', async () => {
    put(memory(LEGACY), 'old\n');
    await list();
    put(memory(CLAUDES), 'edited since, in Claude\'s folder\n');
    put(memory(LEGACY), 'old, edited again\n');
    const rows = rowsOf(await list());
    expect(read(memory(CLAUDES))).toBe('edited since, in Claude\'s folder\n');
    expect(rows).toHaveLength(1);
  });

  it('5. leaves the folders of a project Tars does not know as they were', async () => {
    put(memory(LEGACY), 'old\n');
    await list([]);
    expect(fs.existsSync(path.join(projects(), CLAUDES))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('6. lists the project with its older copy named when the copy fails', async () => {
    put(memory(LEGACY), 'old\n');
    fs.mkdirSync(path.join(projects(), CLAUDES));
    fs.chmodSync(path.join(projects(), CLAUDES), 0o500);
    try {
      const rows = rowsOf(await list());
      expect(rows).toHaveLength(1);
      expect(rows[0].olderCopy).toBe(path.join(projects(), LEGACY, 'memory'));
      expect(read(memory(LEGACY))).toBe('old\n');
    } finally {
      fs.chmodSync(path.join(projects(), CLAUDES), 0o700);
    }
  });
});
