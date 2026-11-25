import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the window may have shown in its folder (shell:reveal, 2.0.7). The buttons that show a folder (the Projects
 * page, Review, an agent's window and its Git panel, the data folder's notice, System) pass a path the window holds,
 * and a project's path comes from ~/.tars/projects.json, which every agent can write. So main judges the path itself.
 *
 * How it fails, written before the code (2026-11-26):
 *  R1. Anything but a folder is taken: a file, a link to a file, a path that does not exist.
 *  R2. A folder Tars does not know is taken: one in no project, nor an agent's folder or worktree, nor the data
 *      folder or ~/.claude.
 *  R3. A project entry Tars would not take as a project is taken: the home or a folder above it, a credential place
 *      (~/.ssh, ~/.config...), a folder inside the data folder (the rules mayBeProject and the Code panel's search keep).
 *  R4. A link inside a project that leads out of every project is taken, judged by its spelling rather than where it
 *      really lies.
 *  R5. Over-correction: a project, a folder in one, an agent's worktree, the data folder or ~/.claude refused.
 *  R6. Anything but an absolute path is taken: undefined, '', a number, a relative path.
 * And what no unit shows: that a folder is shown in its folder and never opened. The E2E
 * e2e/show-folder-reveals.spec.ts drives that from the Projects page.
 */

import { windowMayReveal } from '../../../electron/utils/window-file-access';
import { DATA_DIR } from '../../../electron/constants';

const home = () => os.homedir();
const at = (...p: string[]) => path.join(home(), ...p);
const dir = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p; };
const file = (p: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
let project: string;
let worktree: string;

beforeEach(() => {
  for (const d of ['.tars', '.claude', '.ssh', '.config', 'work', 'elsewhere']) fs.rmSync(at(d), { recursive: true, force: true });
  project = dir(at('work', 'harbor'));
  worktree = dir(at('work', 'harbor-wt', 'feat-x'));
  dir(DATA_DIR);
  dir(at('.claude'));
});

const known = () => [project, worktree];

describe('what the window may have shown in its folder', () => {
  it('R1. a folder only: no file, no link to one, nothing that does not exist', () => {
    const script = file(path.join(project, 'run.sh'));
    fs.symlinkSync(script, path.join(project, 'link-to-file'));
    for (const p of [script, path.join(project, 'link-to-file'), path.join(project, 'missing'), file(at('work', 'loose.txt'))]) {
      expect(windowMayReveal(p, [...known(), p]), p).toBe(false);
    }
  });

  it('R2. no folder Tars does not know', () => {
    for (const p of [dir(at('elsewhere', 'stranger')), dir(at('work'))]) expect(windowMayReveal(p, known()), p).toBe(false);
  });

  it('R3. no entry that is not a project: the home or above, a credential place, a folder in the data folder', () => {
    for (const p of [home(), path.dirname(home()), dir(at('.ssh')), dir(at('.config', 'gh')), dir(path.join(DATA_DIR, 'project-files', 'x'))]) {
      expect(windowMayReveal(p, [...known(), p]), p).toBe(false);
    }
  });

  it('R4. no link in a project that leads out of every project', () => {
    const out = dir(at('elsewhere', 'outside'));
    fs.symlinkSync(out, path.join(project, 'out'));
    expect(windowMayReveal(path.join(project, 'out'), known())).toBe(false);
  });

  it('R5. a project, a folder in one, an agent\'s worktree, the data folder and ~/.claude', () => {
    for (const p of [project, dir(path.join(project, 'src')), worktree, DATA_DIR, at('.claude')]) {
      expect(windowMayReveal(p, known()), p).toBe(true);
    }
  });

  it('R6. only an absolute path', () => {
    for (const p of [undefined, '', 42, 'work/harbor', '.']) expect(windowMayReveal(p, known()), String(p)).toBe(false);
  });
});
