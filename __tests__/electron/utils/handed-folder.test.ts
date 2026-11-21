import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handedFolderProblem } from '../../../electron/utils/handed-folder';

/**
 * The folder an agent is handed besides its project (claude's and codex's --add-dir, gemini's
 * --include-directories), as create_agent and update_agent take it: never ~/.tars-private, what agents are never
 * handed (CLAUDE.md, "nothing under ~/.tars-private is ever passed to a CLI"). The Audit's L1 on #480.
 *
 * How it fails, written before the code:
 * 1. ~/.tars-private itself is taken.
 * 2. A folder inside it is taken.
 * 3. A folder that holds it is taken: the home folder, a parent of it, the root.
 * 4. Another spelling of one of those is taken: a trailing separator, a `..`, a `.`.
 * 5. A link that leads to one of those is taken: a link in a project to ~/.tars-private, to a folder inside it, to the
 *    home folder.
 * 5c. A `..` after a link is taken: the system follows the link and then goes up, while path.resolve drops the `..` on
 *    the text first (the Audit's M1 on #503: proj/lnk -> ~/.tars-private/accounts, then proj/lnk/../secrets).
 * 5b. A folder not made yet behind such a link is taken: no realpath answers for it, so its spelling alone was
 *    compared (found with the Windows suite, handed-folder-win32.test.ts, 2026-10-20).
 * 6. A folder that only looks like one of those is refused: a sibling named .tars-private-notes, a project under the
 *    home folder; or the check throws on a folder that does not exist, or while ~/.tars-private does not exist yet.
 */

let root: string;
let home: string;
let privateDir: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handed-folder-')));
  home = path.join(root, 'home');
  privateDir = path.join(home, '.tars-private');
  project = path.join(home, 'projects', 'demo');
  fs.mkdirSync(path.join(privateDir, 'accounts'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, '.tars-private-notes'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const problem = (folder: string) => handedFolderProblem(folder, { privateDir });

describe('a folder handed to an agent besides its project', () => {
  it('1 and 2. refuses ~/.tars-private and any folder inside it', () => {
    expect(problem(privateDir)).toMatch(/\.tars-private/);
    expect(problem(path.join(privateDir, 'accounts'))).toMatch(/\.tars-private/);
  });

  it('3. refuses a folder that holds it: the home folder, its parent, the root', () => {
    for (const holder of [home, root, path.parse(root).root]) {
      expect(problem(holder), holder).toMatch(/holds|\.tars-private/);
    }
  });

  it('4. refuses another spelling of those', () => {
    for (const spelling of [`${privateDir}/`, path.join(project, '..', '..', '.tars-private'), `${home}/.`, `${home}/projects/..`]) {
      expect(problem(spelling), spelling).not.toBeNull();
    }
  });

  it('5. refuses a link that leads into it or to a folder that holds it', () => {
    fs.symlinkSync(privateDir, path.join(project, 'secrets'));
    fs.symlinkSync(path.join(privateDir, 'accounts'), path.join(project, 'accounts'));
    fs.symlinkSync(home, path.join(project, 'home'));
    for (const link of ['secrets', 'accounts', 'home']) {
      expect(problem(path.join(project, link)), link).not.toBeNull();
    }
  });

  it('5c. refuses a path with a .. after a link, made or not yet made', () => {
    fs.mkdirSync(path.join(privateDir, 'secrets'));
    fs.symlinkSync(path.join(privateDir, 'accounts'), path.join(project, 'lnk'));
    expect(problem(`${project}/lnk/../secrets`)).not.toBeNull();
    expect(problem(`${project}/lnk/../brandnew`)).not.toBeNull();
  });

  it('5b. refuses a folder not made yet behind such a link', () => {
    fs.symlinkSync(privateDir, path.join(project, 'secrets'));
    expect(problem(path.join(project, 'secrets', 'not-made-yet'))).not.toBeNull();
    expect(problem(path.join(project, 'secrets', 'not-made-yet', 'deeper'))).not.toBeNull();
  });

  it('6. takes what only looks like one of those, and a folder that does not exist yet', () => {
    expect(problem(project)).toBeNull();
    expect(problem(path.join(home, '.tars-private-notes'))).toBeNull();
    expect(problem(path.join(home, 'projects', 'not-made-yet'))).toBeNull();
    fs.rmSync(privateDir, { recursive: true, force: true });
    expect(problem(project)).toBeNull();
    expect(problem(home)).not.toBeNull();
  });
});
