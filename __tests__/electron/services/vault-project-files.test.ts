import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Vault reads and edits each project's folder (2.0.4, the maintainer's
 * decisions of 18/10, the frames "Vault · project folders" of #457): reports/
 * and tools/ of ~/.tars/project-files/<key>, what the agents produce. The
 * window is the renderer: a page with an XSS, or a dependency gone bad, holds
 * every channel the preload hands it (the Audit's requirements, section 1).
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  V1. (R1.1) A channel takes a path, or a key, a subfolder or a name that
 *      leaves its place: `../x`, `a/b`, `..`, `.`, an absolute path, a NUL,
 *      `C:x`, a name of 201 characters, a hidden name, a subfolder other than
 *      reports and tools, a key with no folder.
 *  V2. (R1.2) A link leads out: a symbolic link in reports/ to an SSH key or to
 *      app-settings.json is read, written or followed; a hard link (a second
 *      name) is read or written; a subfolder or the project's folder itself is
 *      a link elsewhere and is listed, read or written through.
 *  V3. (R1.3) No limits: a write over 1 MB, a write with a NUL, a write of an
 *      extension that is not text or a script, a binary file read as text, a
 *      long file sent whole (the frames: the first 200 KB, its size said, not
 *      editable past 1 MB). A file the window writes is executable, or not 0600.
 *  V4. (The frames) A save writes over a file an agent changed after it was
 *      opened (mtimeSeen): it must answer `changed`, with the time, and write
 *      nothing. A new file writes over one that appeared meanwhile.
 *  V5. (R1.5) notes/ goes, and a file in it is lost: its files move to
 *      reports/notes (reports/notes-<date> when that is taken), said where,
 *      never deleted; a new folder has reports/ and tools/ only.
 *  V6. (The frames) The lists: a project folder unnamed, or its counts wrong,
 *      or a folder that cannot be read making the whole list fail; a file
 *      without its size, time, kind or whether it runs as it is; not newest
 *      first; more than 1,000 entries.
 */

import { DATA_DIR } from '../../../electron/constants';
import { projectFilesDir, ensureProjectFiles, PROJECT_FILES_SUBDIRS } from '../../../electron/utils/project-files';
import {
  listProjectFolders, listProjectFiles, readProjectFile, writeProjectFile, moveNotesOut,
  READ_SHOWN_BYTES, WRITE_MAX_BYTES, LIST_MAX,
} from '../../../electron/services/vault-project-files';

const root = () => path.join(DATA_DIR, 'project-files');
let project: string;
let key: string;
let dir: string;

const write = (file: string, text: string | Buffer, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); return file; };

beforeEach(() => {
  fs.rmSync(root(), { recursive: true, force: true });
  project = path.join(os.homedir(), 'projects', 'atlas');
  fs.mkdirSync(project, { recursive: true });
  dir = ensureProjectFiles(project).dir!;
  key = path.basename(dir);
});

describe('V1. no path, and nothing that leaves its place', () => {
  it('refuses every shape of key, subfolder and name that is not one of its own', () => {
    write(path.join(dir, 'reports', 'r.md'), '# r');
    const bad: Array<[string, string, string]> = [
      ['../x', 'reports', 'r.md'], ['a/b', 'reports', 'r.md'], ['..', 'reports', 'r.md'], ['.', 'reports', 'r.md'],
      [dir, 'reports', 'r.md'], [`${key}\0`, 'reports', 'r.md'], ['C:x', 'reports', 'r.md'], ['nobody-0123456789', 'reports', 'r.md'],
      [key, 'notes', 'r.md'], [key, '../reports', 'r.md'], [key, 'reports/..', 'r.md'], [key, '', 'r.md'],
      [key, 'reports', '../r.md'], [key, 'reports', 'a/r.md'], [key, 'reports', '..'], [key, 'reports', '.'], [key, 'reports', '/etc/passwd'],
      [key, 'reports', 'r.md\0'], [key, 'reports', `${'a'.repeat(198)}.md`], [key, 'reports', '.hidden.md'], [key, 'reports', 'C:r.md'],
    ];
    for (const [k, sub, name] of bad) {
      const read = readProjectFile(k, sub, name);
      expect('error' in read && read.error, `${k} ${sub} ${name}`).toBeTruthy();
      const written = writeProjectFile(k, sub, name, 'x', null);
      expect('error' in written && written.error, `write ${k} ${sub} ${name}`).toBeTruthy();
    }
    expect('error' in listProjectFiles('../x', 'reports')).toBe(true);
    expect('error' in listProjectFiles(key, 'notes')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'reports', 'r.md'), 'utf8')).toBe('# r');
  });
});

describe('V2. no link out', () => {
  it('a symbolic link in reports/, to an SSH key or to the settings, is neither read, written nor listed as a file', () => {
    const key1 = write(path.join(os.homedir(), '.ssh', 'id_rsa'), 'PRIVATE KEY');
    const settings = write(path.join(DATA_DIR, 'app-settings.json'), '{"deepSeekApiKey":"k"}');
    const before = [fs.statSync(key1).mtimeMs, fs.statSync(settings).mtimeMs];
    fs.symlinkSync(key1, path.join(dir, 'reports', 'key.md'));
    fs.symlinkSync(settings, path.join(dir, 'reports', 'settings.json'));
    for (const name of ['key.md', 'settings.json']) {
      const read = readProjectFile(key, 'reports', name);
      expect('error' in read, name).toBe(true);
      expect(JSON.stringify(read)).not.toMatch(/PRIVATE KEY|deepSeekApiKey/);
      const r = readProjectFile(key, 'reports', name);
      const written = writeProjectFile(key, 'reports', name, 'pwned', 'mtimeMs' in r ? (r.mtimeMs as number) : null);
      expect('error' in written || 'changed' in written, name).toBe(true);
    }
    expect(fs.readFileSync(key1, 'utf8')).toBe('PRIVATE KEY');
    expect(fs.readFileSync(settings, 'utf8')).toBe('{"deepSeekApiKey":"k"}');
    expect([fs.statSync(key1).mtimeMs, fs.statSync(settings).mtimeMs]).toEqual(before);
    const listed = listProjectFiles(key, 'reports');
    expect('files' in listed && listed.files.map((f) => f.name)).toEqual([]);
  });

  it('a hard link, a second name of a file, is neither read nor written', () => {
    const secret = write(path.join(os.homedir(), '.ssh', 'id_ed25519'), 'PRIVATE KEY 2');
    fs.linkSync(secret, path.join(dir, 'reports', 'h.md'));
    expect('error' in readProjectFile(key, 'reports', 'h.md')).toBe(true);
    const got = writeProjectFile(key, 'reports', 'h.md', 'pwned', fs.statSync(secret).mtimeMs);
    expect('error' in got).toBe(true);
    expect(fs.readFileSync(secret, 'utf8')).toBe('PRIVATE KEY 2');
  });

  it('a subfolder or the project\'s folder that is a link elsewhere is not gone through', () => {
    const elsewhere = path.join(os.homedir(), 'elsewhere');
    write(path.join(elsewhere, 'secret.md'), 'elsewhere');
    fs.rmSync(path.join(dir, 'tools'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, 'tools'));
    expect('error' in listProjectFiles(key, 'tools')).toBe(true);
    expect('error' in readProjectFile(key, 'tools', 'secret.md')).toBe(true);
    expect('error' in writeProjectFile(key, 'tools', 'new.sh', 'echo', null)).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual(['secret.md']);
    const linkedKey = 'linked-0123456789';
    fs.symlinkSync(elsewhere, path.join(root(), linkedKey));
    expect('error' in listProjectFiles(linkedKey, 'reports')).toBe(true);
    expect(listProjectFolders([]).map((f) => f.key)).not.toContain(linkedKey);
  });
});

describe('V3. limits', () => {
  it('refuses a write over 1 MB, with a NUL, or of an extension that is not text or a script', () => {
    expect(WRITE_MAX_BYTES).toBe(1024 * 1024);
    expect('error' in writeProjectFile(key, 'reports', 'big.md', 'a'.repeat(WRITE_MAX_BYTES + 1), null)).toBe(true);
    expect('error' in writeProjectFile(key, 'reports', 'nul.md', 'a\0b', null)).toBe(true);
    for (const name of ['x.exe', 'x.app', 'x.dylib', 'x', 'x.html', 'x.svg', 'x.command']) {
      expect('error' in writeProjectFile(key, 'tools', name, 'echo', null), name).toBe(true);
      expect(fs.existsSync(path.join(dir, 'tools', name)), name).toBe(false);
    }
    expect(writeProjectFile(key, 'reports', 'ok.md', 'a'.repeat(WRITE_MAX_BYTES), null)).toMatchObject({ ok: true });
  });

  it('writes 0600, never executable, in tools/ as in reports/', () => {
    expect(writeProjectFile(key, 'tools', 'run.sh', '#!/bin/bash\necho hi\n', null)).toMatchObject({ ok: true });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'tools', 'run.sh')).mode & 0o777).toBe(0o600);
    const listed = listProjectFiles(key, 'tools');
    expect('files' in listed && listed.files.find((f) => f.name === 'run.sh')?.runnable).toBe(false);
  });

  it('reads a binary file by its name and size only, and a long one up to its first 200 KB, not editable', () => {
    write(path.join(dir, 'reports', 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    const png = readProjectFile(key, 'reports', 'diagram.png');
    expect(png).toMatchObject({ kind: 'other', size: 8, editable: false });
    expect('text' in png ? png.text : undefined).toBeUndefined();
    const long = 'line\n'.repeat(700_000);
    write(path.join(dir, 'reports', 'build-log.md'), long);
    const read = readProjectFile(key, 'reports', 'build-log.md');
    expect(read).toMatchObject({ kind: 'markdown', size: Buffer.byteLength(long), truncated: true, editable: false });
    expect(Buffer.byteLength('text' in read ? read.text ?? '' : '')).toBeLessThanOrEqual(READ_SHOWN_BYTES);
  });
});

describe('V4. never over a file changed since it was opened', () => {
  it('answers changed, with the time, and writes nothing; writes once the time is the file\'s', async () => {
    const file = write(path.join(dir, 'reports', 'r.md'), '# mine');
    const opened = readProjectFile(key, 'reports', 'r.md') as { mtimeMs: number };
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, '# the agent\'s');
    const stale = writeProjectFile(key, 'reports', 'r.md', '# my edit', opened.mtimeMs);
    expect(stale).toMatchObject({ changed: true });
    expect((stale as { mtimeMs: number }).mtimeMs).toBe(fs.statSync(file).mtimeMs);
    expect(fs.readFileSync(file, 'utf8')).toBe('# the agent\'s');
    const fresh = writeProjectFile(key, 'reports', 'r.md', '# my edit', (stale as { mtimeMs: number }).mtimeMs);
    expect(fresh).toMatchObject({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('# my edit');
  });

  it('a new file does not write over one that appeared meanwhile', () => {
    write(path.join(dir, 'reports', 'n.md'), '# appeared');
    expect(writeProjectFile(key, 'reports', 'n.md', '# new', null)).toMatchObject({ changed: true });
    expect(fs.readFileSync(path.join(dir, 'reports', 'n.md'), 'utf8')).toBe('# appeared');
  });
});

describe('V5. notes/ goes, and nothing in it is lost', () => {
  it('moves notes/ into reports/notes, or reports/notes-<date> when taken, and says where', () => {
    expect([...PROJECT_FILES_SUBDIRS].sort()).toEqual(['reports', 'tools']);
    expect(fs.existsSync(path.join(dir, 'notes'))).toBe(false);
    write(path.join(dir, 'notes', 'a.md'), 'note a');
    write(path.join(dir, 'notes', 'deep', 'b.md'), 'note b');
    const moved = moveNotesOut(dir);
    expect(moved).toEqual({ to: path.join(dir, 'reports', 'notes') });
    expect(fs.readFileSync(path.join(dir, 'reports', 'notes', 'a.md'), 'utf8')).toBe('note a');
    expect(fs.readFileSync(path.join(dir, 'reports', 'notes', 'deep', 'b.md'), 'utf8')).toBe('note b');
    expect(fs.existsSync(path.join(dir, 'notes'))).toBe(false);
    write(path.join(dir, 'notes', 'c.md'), 'note c');
    const again = moveNotesOut(dir) as { to: string };
    expect(path.basename(again.to)).toMatch(/^notes-\d{4}-\d{2}-\d{2}/);
    expect(fs.readFileSync(path.join(again.to, 'c.md'), 'utf8')).toBe('note c');
    expect(fs.readFileSync(path.join(dir, 'reports', 'notes', 'a.md'), 'utf8')).toBe('note a');
    expect(moveNotesOut(dir)).toBeNull();
  });
});

describe('V6. the lists', () => {
  it('names each project folder and counts its reports and tools; one it cannot read is said, not fatal', () => {
    write(path.join(dir, 'reports', 'a.md'), 'a');
    write(path.join(dir, 'reports', 'b.md'), 'b');
    write(path.join(dir, 'tools', 't.sh'), 'echo');
    const orphan = path.join(root(), 'gone-0123456789');
    fs.mkdirSync(path.join(orphan, 'reports'), { recursive: true });
    const folders = listProjectFolders([project]);
    const atlas = folders.find((f) => f.key === key)!;
    expect(atlas).toMatchObject({ name: 'atlas', projectPath: project, reports: 2, tools: 1 });
    expect(folders.find((f) => f.key === 'gone-0123456789')).toMatchObject({ name: 'gone', projectPath: null, reports: 0 });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      fs.chmodSync(path.join(dir, 'tools'), 0o000);
      try {
        const again = listProjectFolders([project]).find((f) => f.key === key)!;
        expect(again.reports).toBe(2);
        expect(typeof again.tools === 'object' && 'error' in again.tools).toBe(true);
      } finally {
        fs.chmodSync(path.join(dir, 'tools'), 0o755);
      }
    }
  });

  it('gives each file its size, time, kind and whether it runs as it is, newest first, 1,000 at most', async () => {
    write(path.join(dir, 'tools', 'old.py'), 'print(1)', 0o755);
    await new Promise((r) => setTimeout(r, 20));
    write(path.join(dir, 'tools', 'new.json'), '{}');
    const listed = listProjectFiles(key, 'tools');
    expect('files' in listed).toBe(true);
    const files = (listed as { files: Array<Record<string, unknown>> }).files;
    expect(files.map((f) => f.name)).toEqual(['new.json', 'old.py']);
    expect(files[0]).toMatchObject({ name: 'new.json', size: 2, kind: 'text', runnable: false });
    expect(files[1]).toMatchObject({ name: 'old.py', kind: 'code', runnable: process.platform !== 'win32' });
    expect(typeof files[0].mtimeMs).toBe('number');
    expect(LIST_MAX).toBe(1000);
    for (let i = 0; i < LIST_MAX + 5; i++) fs.writeFileSync(path.join(dir, 'reports', `r${i}.md`), '');
    const many = listProjectFiles(key, 'reports') as { files: unknown[]; more?: number };
    expect(many.files.length).toBe(LIST_MAX);
    expect(many.more).toBe(5);
  });

  it('a project folder is made with reports/ and tools/ only', () => {
    const other = path.join(os.homedir(), 'projects', 'meridian');
    fs.mkdirSync(other, { recursive: true });
    const made = ensureProjectFiles(other).dir!;
    expect(fs.readdirSync(made).sort()).toEqual(['reports', 'tools']);
    expect(made).toBe(projectFilesDir(other));
  });
});
