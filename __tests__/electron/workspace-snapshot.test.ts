import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotWorkspace, readBlob } from '../../electron/services/workspace-snapshot';

/**
 * The workspace snapshot a traced turn takes at its start and its end (trace feature B1): the HEAD, a hash of the
 * working tree with its dirty and untracked files, and the bytes of what is dirty, read from the agent's own checkout
 * without disturbing it.
 *
 * How it fails, written before the code (27/11):
 * 1. Two snapshots of the same tree differ, or the hash does not follow HEAD's content.
 * 2. A dirty edit leaves the hash as it was, or undoing the edit does not bring it back.
 * 3. An untracked file is left out, or an ignored one (node_modules, a build folder) is read.
 * 4. The same content staged or not gives two hashes (the hash is of the working tree, not of the index).
 * 5. A tracked file deleted from the disk leaves the hash as it was.
 * 6. The snapshot writes into the agent's .git: an object, the index (git status refreshes it when it can take the
 *    lock), index.lock, a ref; or it fails, or removes the lock, when another process holds index.lock.
 * 7. A git call that hangs blocks the snapshot, or a timeout is recorded as an empty hash or a zero instead of null.
 * 8. A folder that is not a checkout, or does not exist, throws.
 * 9. A repository with no commit yet throws, or has no hash for its files.
 * 10. A path with spaces, quotes or non-ASCII letters is mangled (git quotes such paths unless told -z).
 * 11. A file git's autocrlf writes with CRLF over an LF blob, touched without a change, counts as changed.
 * 12. The bytes of a dirty file are not kept for the diff, or a file over the size limit is read into memory.
 * 13. readBlob writes, or throws on a blob that does not exist.
 */

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
const write = (rel: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

/** Every entry under .git: its path, size, times and mode, so any write shows. */
function dotGit(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const st = fs.lstatSync(full);
      out[path.relative(repo, full)] = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
      if (e.isDirectory()) walk(full);
    }
  };
  walk(path.join(repo, '.git'));
  return out;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-'));
  git('init', '-q', '-b', 'main');
  write('a.txt', 'one\ntwo\n');
  write('src/b.ts', 'export const b = 1;\n');
  write('.gitignore', 'node_modules/\ndist/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('the workspace snapshot', () => {
  it('1: the same tree twice gives the same hash, and HEAD is the commit', async () => {
    const s1 = await snapshotWorkspace(repo);
    const s2 = await snapshotWorkspace(repo);
    expect(s1.head).toBe(git('rev-parse', 'HEAD'));
    expect(s1.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(s2.tree).toBe(s1.tree);
    write('a.txt', 'one\ntwo\nthree\n');
    git('commit', '-q', '-am', 'second');
    const s3 = await snapshotWorkspace(repo);
    expect(s3.head).not.toBe(s1.head);
    expect(s3.tree).not.toBe(s1.tree);
  });

  it('2: a dirty edit changes the hash, and undoing it brings the hash back', async () => {
    const before = await snapshotWorkspace(repo);
    write('a.txt', 'one\ntwo\nand a third\n');
    const dirty = await snapshotWorkspace(repo);
    expect(dirty.tree).not.toBe(before.tree);
    expect(dirty.head).toBe(before.head);
    write('a.txt', 'one\ntwo\n');
    expect((await snapshotWorkspace(repo)).tree).toBe(before.tree);
  });

  it('3: an untracked file counts, an ignored one does not', async () => {
    const before = await snapshotWorkspace(repo);
    write('node_modules/x/index.js', 'ignored\n');
    write('dist/out.js', 'ignored\n');
    expect((await snapshotWorkspace(repo)).tree).toBe(before.tree);
    write('notes.md', 'untracked\n');
    const after = await snapshotWorkspace(repo);
    expect(after.tree).not.toBe(before.tree);
    expect([...after.files!.keys()]).toContain('notes.md');
    expect([...after.files!.keys()].some(p => p.startsWith('node_modules/'))).toBe(false);
  });

  it('4: the same content, staged or not, gives the same hash', async () => {
    write('a.txt', 'one\ntwo\nstaged or not\n');
    const unstaged = await snapshotWorkspace(repo);
    git('add', 'a.txt');
    const staged = await snapshotWorkspace(repo);
    expect(staged.tree).toBe(unstaged.tree);
  });

  it('5: a tracked file deleted from the disk changes the hash', async () => {
    const before = await snapshotWorkspace(repo);
    fs.rmSync(path.join(repo, 'src', 'b.ts'));
    const after = await snapshotWorkspace(repo);
    expect(after.tree).not.toBe(before.tree);
    expect(after.files!.has('src/b.ts')).toBe(false);
  });

  it('6: nothing under .git moves, and another process\'s index.lock is left alone', async () => {
    write('a.txt', 'one\ntwo\nedited\n');
    write('fresh.txt', 'new\n');
    // A stat change with no content change: what git status would refresh into the index when it can.
    const t = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(repo, 'src', 'b.ts'), t, t);
    const before = dotGit();
    const s = await snapshotWorkspace(repo);
    expect(s.tree).not.toBeNull();
    expect(dotGit()).toEqual(before);
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), 'held by someone else');
    const held = dotGit();
    const s2 = await snapshotWorkspace(repo);
    expect(s2.tree).toBe(s.tree);
    expect(dotGit()).toEqual(held);
    expect(fs.readFileSync(path.join(repo, '.git', 'index.lock'), 'utf8')).toBe('held by someone else');
  });

  it('7: a git call past its time records null, never an empty hash or a zero, and returns', async () => {
    const s = await snapshotWorkspace(repo, { timeoutMs: 1 });
    expect(s.head).toBeNull();
    expect(s.tree).toBeNull();
    expect(s.files).toBeNull();
  });

  it('8: a folder that is not a checkout, or is missing, gives nulls', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-plain-'));
    try {
      const s = await snapshotWorkspace(plain);
      expect(s).toMatchObject({ head: null, tree: null, files: null });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(await snapshotWorkspace(path.join(repo, 'no-such-folder'))).toMatchObject({ head: null, tree: null, files: null });
  });

  it('9: a repository with no commit yet has no head and still a hash of its files', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-fresh-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: fresh });
      fs.writeFileSync(path.join(fresh, 'x.txt'), 'x\n');
      const s = await snapshotWorkspace(fresh);
      expect(s.head).toBeNull();
      expect(s.tree).toMatch(/^[0-9a-f]{64}$/);
      expect([...s.files!.keys()]).toEqual(['x.txt']);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('10: paths with spaces, quotes and accents come through whole', async () => {
    write('dir with space/fichier "é".txt', 'accent\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'odd names');
    write('dir with space/fichier "é".txt', 'accent changed\n');
    const s = await snapshotWorkspace(repo);
    expect(s.files!.has('dir with space/fichier "é".txt')).toBe(true);
    const sha = s.files!.get('dir with space/fichier "é".txt')!;
    expect(s.contents.get(sha)?.toString()).toBe('accent changed\n');
  });

  it('11: a CRLF copy of an LF blob, touched without a change, is not a change', async () => {
    git('config', 'core.autocrlf', 'true');
    write('crlf.txt', 'l1\r\nl2\r\n');
    git('add', 'crlf.txt');
    git('commit', '-q', '-m', 'crlf');
    const before = await snapshotWorkspace(repo);
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(repo, 'crlf.txt'), t, t);
    expect((await snapshotWorkspace(repo)).tree).toBe(before.tree);
  });

  it('12: a dirty file\'s bytes are kept, one over the limit is not read', async () => {
    write('a.txt', 'one\ntwo\nkept\n');
    write('big.bin', Buffer.alloc(2048, 0x61));
    const s = await snapshotWorkspace(repo, { maxFileBytes: 1024 });
    expect(s.contents.get(s.files!.get('a.txt')!)?.toString()).toBe('one\ntwo\nkept\n');
    expect(s.files!.get('big.bin')).toMatch(/^large:/);
    expect(s.contents.size).toBe(1);
  });

  it('13: readBlob reads a committed blob without writing, and gives null for one that is not there', async () => {
    const s = await snapshotWorkspace(repo);
    const before = dotGit();
    expect((await readBlob(repo, s.files!.get('a.txt')!))?.toString()).toBe('one\ntwo\n');
    expect(await readBlob(repo, '0'.repeat(40))).toBeNull();
    expect(dotGit()).toEqual(before);
  });
});
