import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dropRunnerGrants } from '../../../electron/core/chat-grants';

/**
 * A deleted chat's runner leaves its copy of the project's settings.local.json behind, then its worktree goes
 * (electron/core/chat-grants.ts, called by services/chat-runners.ts before removeAgent). Claude Code puts that file
 * in the global git ignore, so a copy left there keeps the whole worktree as an ignored file (GATE-2.0.0-BULLETS, 1).
 *
 * How it fails, written before the fix of #394's gate (2026-10-13; cases 1 and 4 to 7 after the first cut, which
 * the gate's mutants H4 and H5 showed had no witness):
 * 1. The runner's copy stays, and the worktree with it.
 * 2. (the gate's M1) The worktree's `.claude` is a link to the project's (a repository that tracks it as one, or an
 *    agent that made it): the file deleted is the project's own, the user's grants.
 * 3. The worktree itself is reached through a link, and its real `.claude` is taken for a stranger's: nothing goes.
 * 4. (H4) settings.local.json is a link: the link goes, though it is no copy of Tars's; it must stay, and keep the
 *    worktree, which says why.
 * 5. (H5) The runner works somewhere else than the chat's own worktree (the project's root, another chat's): its
 *    file there is deleted.
 * 6. `.claude` holds more than the file: the rest goes with it.
 * 7. A worktree with no `.claude`, or none at all, throws.
 * 8. (the delta gate's L1) Above the worktree: the chat's folder is itself a link to the project
 *    (`.worktrees/chat-x -> ..`). lstat follows it, `.claude` is the project's real folder and its file a regular one:
 *    the project's own grants are deleted. Whatever the layout, the file the worktree reaches must never be the
 *    project's own.
 * 9. (QA's D2 on #394's delta) The worktree's `.claude` is a link to a folder other than the project's: another
 *    worktree's, or the user's own ~/.claude. The realpath check knows only the project's file, so without the check
 *    that `.claude` is no link, unlink goes through it and that folder's settings.local.json is deleted. Case 2 links
 *    to the project's `.claude`, which the realpath check guards too: it never showed the link check was needed.
 */

let root: string;
let project: string;
let worktree: string;
const grantsOf = (dir: string) => path.join(dir, '.claude', 'settings.local.json');
const write = (file: string, text = '{"permissions":{"allow":["Bash(npm test)"]}}') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-grants-'));
  project = path.join(root, 'demo');
  worktree = path.join(project, '.worktrees', 'chat-1a2b3c4d');
  write(grantsOf(project));
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('dropRunnerGrants', () => {
  it('1. removes the runner\'s copy, and .claude once empty', () => {
    write(grantsOf(worktree));
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
  });

  it('2. never removes the project\'s own file through a linked .claude', () => {
    fs.symlinkSync('../../.claude', path.join(worktree, '.claude'));
    expect(fs.existsSync(grantsOf(worktree)), 'the link reaches the project\'s file').toBe(true);
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
    expect(fs.lstatSync(path.join(worktree, '.claude')).isSymbolicLink()).toBe(true);
  });

  it('3. removes the copy in a worktree reached through a link', () => {
    write(grantsOf(worktree));
    const linked = path.join(root, 'linked-worktree');
    fs.symlinkSync(worktree, linked);
    dropRunnerGrants(project, linked, linked);
    expect(fs.existsSync(grantsOf(worktree))).toBe(false);
  });

  it('4. leaves a settings.local.json that is a link', () => {
    fs.mkdirSync(path.join(worktree, '.claude'));
    fs.symlinkSync(grantsOf(project), grantsOf(worktree));
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.lstatSync(grantsOf(worktree)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
  });

  it('5. touches nothing when the runner works elsewhere than its own worktree', () => {
    write(grantsOf(worktree));
    dropRunnerGrants(project, project, worktree);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
    dropRunnerGrants(project, undefined, worktree);
    dropRunnerGrants(project, worktree, undefined);
    expect(fs.existsSync(grantsOf(worktree))).toBe(true);
  });

  it('6. keeps what else .claude holds', () => {
    write(grantsOf(worktree));
    write(path.join(worktree, '.claude', 'agents', 'reviewer.md'), 'mine');
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.existsSync(grantsOf(worktree))).toBe(false);
    expect(fs.readFileSync(path.join(worktree, '.claude', 'agents', 'reviewer.md'), 'utf8')).toBe('mine');
  });

  it('7. does not throw without .claude, or without the worktree', () => {
    expect(() => dropRunnerGrants(project, worktree, worktree)).not.toThrow();
    const gone = path.join(project, '.worktrees', 'chat-gone');
    expect(() => dropRunnerGrants(project, gone, gone)).not.toThrow();
  });

  it('8. never removes the project\'s own file when the worktree is a link to the project', () => {
    fs.rmSync(worktree, { recursive: true });
    fs.symlinkSync('..', worktree);
    expect(fs.existsSync(grantsOf(worktree)), 'the link reaches the project\'s file').toBe(true);
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
  });

  it('9. never removes another folder\'s file through a .claude linked elsewhere than the project\'s', () => {
    const elsewhere = path.join(root, 'home', '.claude');
    write(path.join(elsewhere, 'settings.local.json'), '{"permissions":{"allow":["Bash(git push)"]}}');
    fs.symlinkSync(elsewhere, path.join(worktree, '.claude'));
    expect(fs.existsSync(grantsOf(worktree)), 'the link reaches the other folder\'s file').toBe(true);
    dropRunnerGrants(project, worktree, worktree);
    expect(fs.readFileSync(path.join(elsewhere, 'settings.local.json'), 'utf8')).toBe('{"permissions":{"allow":["Bash(git push)"]}}');
    expect(fs.lstatSync(path.join(worktree, '.claude')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(grantsOf(project))).toBe(true);
  });
});
