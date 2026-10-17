import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectFilesKey, projectFilesDir, ensureProjectFiles, PROJECT_FILES_DIR_NAME } from '../../../electron/utils/project-files';

/**
 * The folder Tars keeps for each project (utils/project-files.ts), where its
 * agents keep scripts, notes and reports outside the repository.
 *
 * How this can fail, written before the code:
 * 1. two spellings of one project (a trailing separator; on Windows, case and
 *    `/` against `\`) get two folders, and the agents of one project do not
 *    find each other's notes;
 * 2. two projects with the same folder name (~/a/app and ~/b/app) share one;
 * 3. a project's name carries what a file name may not (separators, `..`, a
 *    colon, a space at the end, a character Windows refuses): the folder lands
 *    elsewhere or cannot be made;
 * 4. a root path or a name with no letter gives an empty or hidden key;
 * 5. the key changes from one run to the next, and the folder is lost;
 * 6. a long project name makes a path past what Windows takes;
 * 7. the folder is inside the repository, a temporary folder or ~/Documents
 *    (iCloud evicts it), or clashes with ~/.dorothy/projects.json;
 * 8. a relative path is given a folder relative to wherever Tars runs;
 * 9. making it again empties or replaces what is there (it is never deleted).
 * 10. an accented name (café) loses its letters instead of keeping them without
 *     the accent: two projects that differ by an accent read alike, and the
 *     folder's name is not the project's (the Audit's mutant M2 on #448);
 * 11. a folder that cannot be made (a full disk, a permission, a file in its
 *     place) is blamed on the project's path, "not absolute", and the agent is
 *     told something false about its project (the Audit's L6 on #448).
 */

describe('the key of a project folder', () => {
  it('is one for two spellings of one place (1)', () => {
    expect(projectFilesKey('/Users/u/work/app/', 'darwin')).toBe(projectFilesKey('/Users/u/work/app', 'darwin'));
    expect(projectFilesKey('/home/u/app//', 'linux')).toBe(projectFilesKey('/home/u/app', 'linux'));
    expect(projectFilesKey('C:\\Users\\U\\Work\\App', 'win32')).toBe(projectFilesKey('c:/users/u/work/app/', 'win32'));
    // Linux tells case apart, so two folders there.
    expect(projectFilesKey('/home/u/App', 'linux')).not.toBe(projectFilesKey('/home/u/app', 'linux'));
  });

  it('is two for two projects with one name (2)', () => {
    expect(projectFilesKey('/home/u/a/app', 'linux')).not.toBe(projectFilesKey('/home/u/b/app', 'linux'));
  });

  it('is readable and safe on every system (3, 4, 6)', () => {
    for (const [p, platform] of [
      ['/home/u/My Project: v2 ', 'linux'],
      ['/home/u/..', 'linux'],
      ['C:\\work\\CON', 'win32'],
      ['/', 'linux'],
      ['C:\\', 'win32'],
      ['/home/u/日本語', 'darwin'],
      [`/home/u/${'x'.repeat(300)}`, 'linux'],
    ] as const) {
      const key = projectFilesKey(p, platform)!;
      expect(key, p).toMatch(/^[a-z0-9][a-z0-9-]{0,40}-[0-9a-f]{10}$/);
      expect(key.length).toBeLessThanOrEqual(52);
    }
    expect(projectFilesKey('/home/u/My Project: v2', 'linux')).toMatch(/^my-project-v2-[0-9a-f]{10}$/);
    expect(projectFilesKey('C:\\work\\CON', 'win32')).not.toMatch(/^con-/);
  });

  it('keeps an accented letter without its accent (10)', () => {
    expect(projectFilesKey('/home/u/caf\u00e9', 'linux')).toMatch(/^cafe-[0-9a-f]{10}$/);
    // The same name typed decomposed (e and a combining accent), as macOS may give it.
    expect(projectFilesKey('/home/u/cafe\u0301', 'linux')).toMatch(/^cafe-[0-9a-f]{10}$/);
    expect(projectFilesKey('/home/u/\u00c9t\u00e9 2026', 'darwin')).toMatch(/^ete-2026-[0-9a-f]{10}$/);
  });

  it('is the same on every call (5)', () => {
    expect(projectFilesKey('/home/u/app', 'linux')).toBe('app-' + projectFilesKey('/home/u/app', 'linux')!.slice(-10));
    expect(projectFilesKey('/home/u/app', 'linux')).toBe(projectFilesKey('/home/u/app', 'linux'));
  });

  it('is none for a relative path (8)', () => {
    expect(projectFilesKey('app', 'linux')).toBeNull();
    expect(projectFilesKey('', 'linux')).toBeNull();
    expect(projectFilesKey('work\\app', 'win32')).toBeNull();
    expect(projectFilesDir('./app')).toBeNull();
  });
});

describe('the project folder on disk', () => {
  it('lives under the data folder, apart from projects.json, the project and the temporary folders (7)', () => {
    const dir = projectFilesDir('/home/u/app')!;
    const data = path.join(os.homedir(), '.dorothy');
    expect(path.dirname(dir)).toBe(path.join(data, PROJECT_FILES_DIR_NAME));
    expect(PROJECT_FILES_DIR_NAME).not.toMatch(/^projects(\.json)?$/);
    expect(dir.startsWith('/home/u/app')).toBe(false);
    expect(dir.startsWith(path.join(os.homedir(), 'Documents'))).toBe(false);
    expect(dir.startsWith(path.join(data, 'tmp'))).toBe(false);
  });

  it('is made with tools, notes and reports, and making it again keeps what is there (9)', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-'));
    const dir = ensureProjectFiles(project).dir!;
    expect(dir).toBe(projectFilesDir(project));
    for (const sub of ['tools', 'notes', 'reports']) expect(fs.statSync(path.join(dir, sub)).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(dir, 'notes', 'kept.md'), 'kept');
    expect(ensureProjectFiles(project).dir).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'notes', 'kept.md'), 'utf8')).toBe('kept');
    expect(ensureProjectFiles('relative/app')).toEqual({ dir: null, why: 'its path is not absolute' });
  });

  it('says why when it cannot be made, and does not blame the path (11)', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-unmade-'));
    const dir = projectFilesDir(project)!;
    // A file where the folder goes: mkdir fails as it does on a full disk or a
    // folder Tars may not write, with the path absolute and fine.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'in the way');
    const made = ensureProjectFiles(project);
    expect(made.dir).toBeNull();
    expect(made.why).toContain(dir);
    expect(made.why).toMatch(/could not be made/);
    expect(made.why).not.toMatch(/absolute/);
    fs.rmSync(dir);
  });
});
