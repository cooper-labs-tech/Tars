import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Vault shows every folder of a project (2.0.5, the owner's go of 28/10; the frames of #526, "Vault (2.0.5) ·
 * project folders as a tree", and their notes for the Backend, GJwkc): one level at a time of any folder of
 * ~/.tars/project-files/<key>/, nested ones included, named by the folder's key and a list of segments, never a path.
 * The Vault's rules of 2.0.4 hold (vault-project-files.test.ts, V1 to V6).
 *
 * Every way it can fail, written before the code (2026-10-28):
 *  T1. A place that leaves the project's folder or is not a list of names: `..`, `.`, an empty segment, a segment with
 *      a separator (`a/b`, `a\b`), a NUL, `C:x`, a hidden segment, an absolute path, a string with a slash, more than
 *      16 levels; or a heavy folder (node_modules, .git, .venv...) opened when asked.
 *  T2. A link at any depth: a folder of the place that is a symbolic link, at the first level or the third, listed,
 *      read or written through; a link listed by following it (its target's type or size read); a file with a second
 *      name (a hard link) read.
 *  T3. A folder swapped for a link between the list and the read (an agent shares the folder): the read, the write
 *      and the next list of that place go through the link to what it points at.
 *  T4. The list: folders not first, not by name, or without their count; a heavy folder counted or left out; a
 *      hidden entry other than a heavy folder shown; files not newest first; a link or a hard link left out instead of
 *      said; a folder that cannot be read making the list fail, or shown as empty.
 *  T5. Pages: more than 200 by default, or past the 1,000 cap when asked for more; no total, no offset, no `more`.
 *  T6. Writes and reads in a nested folder break the rules of 2.0.4: not 0600, not text only, past 1 MB; and the form
 *      the window uses today (`sub: 'reports'`) stops working.
 */

import { DATA_DIR } from '../../../electron/constants';
import { ensureProjectFiles } from '../../../electron/utils/project-files';
import {
  listProjectPlace, readProjectFile, writeProjectFile, listProjectFiles, HEAVY_FOLDERS, PAGE_DEFAULT, LIST_MAX,
} from '../../../electron/services/vault-project-files';

const root = () => path.join(DATA_DIR, 'project-files');
let key: string;
let dir: string;
let outside: string;

const write = (file: string, text: string, mtimeSec?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
};
const posix = process.platform !== 'win32';

beforeEach(() => {
  fs.rmSync(root(), { recursive: true, force: true });
  const project = path.join(os.homedir(), 'projects', 'harbor');
  fs.mkdirSync(project, { recursive: true });
  dir = ensureProjectFiles(project).dir!;
  key = path.basename(dir);
  outside = fs.mkdtempSync(path.join(os.homedir(), 'outside-'));
  write(path.join(outside, 'secret.md'), 'not the vault\'s');
  write(path.join(outside, 'deep', 'secret.md'), 'not the vault\'s');
});

describe('T1. a place is a list of names inside the project\'s folder', () => {
  it('refuses every shape that leaves it, or that is not a list of names', () => {
    write(path.join(dir, 'reports', 'overnight', 'a.md'), '# a');
    const bad: unknown[] = [
      ['..'], ['reports', '..'], ['.'], [''], ['reports/overnight'], ['reports\\overnight'], ['reports', 'over\0night'],
      ['C:x'], ['.hidden'], [dir], '/etc', 'reports/overnight', [1], [['reports']], Array(17).fill('a'),
    ];
    for (const place of bad) {
      const listed = listProjectPlace(key, place as string[]);
      expect('error' in listed, JSON.stringify(place)).toBe(true);
      expect('error' in readProjectFile(key, place as string[], 'a.md'), JSON.stringify(place)).toBe(true);
      expect('error' in writeProjectFile(key, place as string[], 'b.md', 'x', null), JSON.stringify(place)).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, 'b.md'))).toBe(false);
  });

  it('never opens a heavy folder', () => {
    for (const heavy of ['node_modules', '.git', '.venv']) {
      fs.mkdirSync(path.join(dir, 'reports', 'wt', heavy, 'deep'), { recursive: true });
      const asked = listProjectPlace(key, ['reports', 'wt', heavy]);
      expect(asked).toMatchObject({ code: 'heavy' });
    }
    expect(HEAVY_FOLDERS).toEqual(expect.arrayContaining(['node_modules', '.git', '.venv', 'venv', '.next', '__pycache__', '.turbo', 'dist-electron', 'target']));
  });
});

describe.skipIf(!posix)('T2. a link at any depth', () => {
  it('refuses a place whose folder is a link, at the first level or deeper', () => {
    fs.symlinkSync(outside, path.join(dir, 'linked'));
    fs.mkdirSync(path.join(dir, 'reports', 'a', 'b'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'reports', 'a', 'b', 'c'));
    for (const place of [['linked'], ['linked', 'deep'], ['reports', 'a', 'b', 'c'], ['reports', 'a', 'b', 'c', 'deep']]) {
      expect(listProjectPlace(key, place), place.join('/')).toMatchObject({ code: 'link' });
      expect('error' in readProjectFile(key, place, 'secret.md')).toBe(true);
      expect('error' in writeProjectFile(key, place, 'x.md', 'x', null)).toBe(true);
    }
    expect(fs.readdirSync(outside).sort()).toEqual(['deep', 'secret.md']);
  });

  it('lists a link as a link with its target as written, never followed, and a hard link as one, never read', () => {
    fs.mkdirSync(path.join(dir, 'reports', 'n'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'reports', 'n', 'to-outside'));
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'reports', 'n', 'file-link.md'));
    fs.linkSync(path.join(outside, 'secret.md'), path.join(dir, 'reports', 'n', 'hard.md'));
    const listed = listProjectPlace(key, ['reports', 'n']);
    if ('error' in listed) throw new Error(listed.error);
    const byName = Object.fromEntries(listed.entries.map(e => [e.name, e]));
    expect(byName['to-outside']).toMatchObject({ type: 'link', target: outside });
    expect(byName['file-link.md']).toMatchObject({ type: 'link', target: path.join(outside, 'secret.md') });
    expect(byName['to-outside']).not.toHaveProperty('entries');
    expect(byName['hard.md']).toMatchObject({ type: 'file', hardlink: true });
    expect(readProjectFile(key, ['reports', 'n'], 'hard.md')).toMatchObject({ code: 'link' });
    expect(readProjectFile(key, ['reports', 'n'], 'file-link.md')).toMatchObject({ code: 'link' });
  });
});

describe.skipIf(!posix)('T3. a folder swapped for a link between the list and the read', () => {
  it('reads, writes and lists nothing through the link it became', () => {
    write(path.join(dir, 'reports', 'run', 'deep', 'secret.md'), 'the vault\'s own');
    expect('error' in listProjectPlace(key, ['reports', 'run', 'deep'])).toBe(false);
    // An agent swaps reports/run for a link to a folder outside that has the same names.
    fs.rmSync(path.join(dir, 'reports', 'run'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'reports', 'run'));
    expect(listProjectPlace(key, ['reports', 'run', 'deep'])).toMatchObject({ code: 'link' });
    expect(readProjectFile(key, ['reports', 'run', 'deep'], 'secret.md')).toMatchObject({ code: 'link' });
    expect(writeProjectFile(key, ['reports', 'run', 'deep'], 'secret.md', 'over', null)).toMatchObject({ code: 'link' });
    expect(fs.readFileSync(path.join(outside, 'deep', 'secret.md'), 'utf8')).toBe('not the vault\'s');
  });
});

describe('T4. one level, in the order the frames show', () => {
  it('folders first by name with their count, heavy ones named and not counted, then files newest first', () => {
    write(path.join(dir, 'reports', 'b-folder', 'one.md'), '1');
    write(path.join(dir, 'reports', 'b-folder', 'two.md'), '2');
    fs.mkdirSync(path.join(dir, 'reports', 'a-folder'));
    fs.mkdirSync(path.join(dir, 'reports', 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'reports', '.git'));
    fs.mkdirSync(path.join(dir, 'reports', '.cache'));
    write(path.join(dir, 'reports', '.hidden.md'), 'h');
    write(path.join(dir, 'reports', 'old.md'), 'o', 1_700_000_000);
    write(path.join(dir, 'reports', 'new.md'), 'n', 1_800_000_000);
    const listed = listProjectPlace(key, ['reports']);
    if ('error' in listed) throw new Error(listed.error);
    expect(listed.entries.map(e => e.name)).toEqual(['.git', 'a-folder', 'b-folder', 'node_modules', 'new.md', 'old.md']);
    expect(listed.entries.find(e => e.name === 'b-folder')).toMatchObject({ type: 'folder', entries: 2 });
    expect(listed.entries.find(e => e.name === 'a-folder')).toMatchObject({ type: 'folder', entries: 0 });
    for (const heavy of ['.git', 'node_modules']) {
      const e = listed.entries.find(x => x.name === heavy)!;
      expect(e).toMatchObject({ type: 'folder', heavy: true });
      expect(e).not.toHaveProperty('entries');
    }
    expect(listed.entries.find(e => e.name === 'new.md')).toMatchObject({ type: 'file', kind: 'markdown', size: 1 });
    expect(listed).toMatchObject({ total: 6, offset: 0 });
    expect(listed).not.toHaveProperty('more');
  });

  it('lists the project\'s own folder, and every folder in it, not only reports and tools', () => {
    write(path.join(dir, 'briefs', 'x.md'), 'x');
    write(path.join(dir, 'top.md'), 't');
    const top = listProjectPlace(key, []);
    if ('error' in top) throw new Error(top.error);
    expect(top.entries.filter(e => e.type === 'folder').map(e => e.name)).toEqual(['briefs', 'reports', 'tools']);
    expect(top.entries.map(e => e.name)).toContain('top.md');
    expect(readProjectFile(key, ['briefs'], 'x.md')).toMatchObject({ text: 'x' });
  });

  it.skipIf(!posix || process.getuid?.() === 0)('says a folder that cannot be read, with its code, and lists the rest', () => {
    fs.mkdirSync(path.join(dir, 'reports', 'locked'));
    write(path.join(dir, 'reports', 'ok.md'), 'ok');
    fs.chmodSync(path.join(dir, 'reports', 'locked'), 0o000);
    try {
      const listed = listProjectPlace(key, ['reports']);
      if ('error' in listed) throw new Error(listed.error);
      expect(listed.entries.find(e => e.name === 'locked')).toMatchObject({ type: 'folder', error: 'EACCES' });
      expect(listProjectPlace(key, ['reports', 'locked'])).toMatchObject({ code: 'unreadable', errno: 'EACCES' });
    } finally {
      fs.chmodSync(path.join(dir, 'reports', 'locked'), 0o700);
    }
  });
});

describe('T5. pages', () => {
  it('gives 200 by default, the next ones from an offset, and never more than 1,000 an answer', () => {
    for (let i = 0; i < 1_250; i++) write(path.join(dir, 'reports', 'many', `f${String(i).padStart(4, '0')}.txt`), 'x', 1_700_000_000 + i);
    const first = listProjectPlace(key, ['reports', 'many']);
    if ('error' in first) throw new Error(first.error);
    expect(PAGE_DEFAULT).toBe(200);
    expect(first.entries).toHaveLength(200);
    expect(first).toMatchObject({ total: 1_250, offset: 0, more: 1_050 });
    expect(first.entries[0].name).toBe('f1249.txt');
    const next = listProjectPlace(key, ['reports', 'many'], { offset: 200 });
    if ('error' in next) throw new Error(next.error);
    expect(next.entries[0].name).toBe('f1049.txt');
    expect(next).toMatchObject({ offset: 200, more: 850 });
    const capped = listProjectPlace(key, ['reports', 'many'], { limit: 5_000 });
    if ('error' in capped) throw new Error(capped.error);
    expect(capped.entries).toHaveLength(LIST_MAX);
    expect(capped).toMatchObject({ more: 250 });
  });
});

describe('T6. a nested folder keeps the rules of 2.0.4, and today\'s form still works', () => {
  it('writes text only, 0600, in a nested folder, and reads it back', () => {
    fs.mkdirSync(path.join(dir, 'reports', 'overnight', 'wt'), { recursive: true });
    const place = ['reports', 'overnight', 'wt'];
    expect(writeProjectFile(key, place, 'n.md', '# nested', null)).toMatchObject({ ok: true });
    expect(readProjectFile(key, place, 'n.md')).toMatchObject({ text: '# nested', editable: true });
    if (posix) expect(fs.statSync(path.join(dir, ...place, 'n.md')).mode & 0o777).toBe(0o600);
    expect(writeProjectFile(key, place, 'n.exe', 'x', null)).toMatchObject({ code: 'extension' });
    expect(writeProjectFile(key, place, 'big.md', 'x'.repeat(1024 * 1024 + 1), null)).toMatchObject({ code: 'too_large' });
  });

  it('keeps `sub` as today\'s window sends it', () => {
    write(path.join(dir, 'reports', 'r.md'), '# r');
    expect(readProjectFile(key, 'reports', 'r.md')).toMatchObject({ text: '# r' });
    const listed = listProjectFiles(key, 'reports');
    expect('error' in listed ? listed : listed.files.map(f => f.name)).toEqual(['r.md']);
  });
});
