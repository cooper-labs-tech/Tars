import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewDiff, resetReviewCache } from '../../../electron/services/git-review';

/**
 * The Review page reads a file's patch only once that file is picked
 * (`review:file`), but `review:diff` built every patch of the tree alongside
 * the file list: two `git diff` runs over the whole change, up to 2 MB carried
 * over IPC, for a list (the Orchestrator's brief after #231, item 7). A
 * list-only call asks for the list and nothing else.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A list-only call still runs git for the patches, or hands one back.
 * 2. Its list is not the full call's: files, statuses, counts, untracked
 *    files, the base, ahead and behind.
 * 3. A list-only answer is kept and then handed to a full call, which gets no
 *    patch; or a full answer handed to a list-only call has its patch cleared
 *    in place, and the next full call gets none.
 * 4. Over-correction: a list-only call after a full one, with nothing
 *    changed, runs git for the list again instead of reading what is kept;
 *    or a call with no option (the Review page as it is today) loses its
 *    patch.
 * 5. The option does not cross IPC: the preload, the renderer's type or the
 *    handler drops it.
 *
 * And from QA's gate of #247 (QA-PR247.md, after #282 cut a patch past
 * MAX_PATCH_BYTES):
 * 6. On a change past the cut, the full call loses #282's cut (its patch
 *    whole, or empty and "not cut"), or the list-only call reads the patch
 *    anyway and says it was cut.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Windows starts no extensionless script, and execFile finds git.exe there
 * whatever the PATH holds first: the git that writes down its arguments
 * (beforeEach) is never run. There the same lines are written down by
 * execFile itself, for git, and for promisify's form of it, which git-review
 * uses. Elsewhere child_process is as it is.
 */
const recorder = vi.hoisted(() => ({ log: '' }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  if (process.platform !== 'win32') return actual;
  const { promisify } = await import('util');
  const { appendFileSync } = await import('fs');
  const note = (file: unknown, args: unknown) => {
    if ((file === 'git' || /[\\/]git\.exe$/i.test(String(file))) && Array.isArray(args)) appendFileSync(recorder.log, `${args.join(' ')}\n`);
  };
  const original = actual.execFile as unknown as ((...a: unknown[]) => unknown) & { [key: symbol]: (...a: unknown[]) => unknown };
  const execFile = Object.assign((file: unknown, args: unknown, ...rest: unknown[]) => {
    note(file, args);
    return original(file, args, ...rest);
  }, {
    [promisify.custom]: (file: unknown, args: unknown, ...rest: unknown[]) => {
      note(file, args);
      return original[promisify.custom](file, args, ...rest);
    },
  });
  return { ...actual, execFile };
});

let tmp: string;
let repo: string;
let log: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** The git commands Tars ran since the last call, as argument lines. */
function ran(): string[] {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  // Tars runs every git with --no-optional-locks and -c core.quotePath=false first.
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/^--no-optional-locks /, '').replace(/^-c core\.quotePath=false /, '');
  fs.writeFileSync(log, '');
  return lines;
}
// A diff that is not a list: since #272 the lists are `diff -M --numstat -z` and `diff -M --name-status -z`.
const patchRuns = (lines: string[]) => lines.filter(l => /^diff\b/.test(l) && !/--(numstat|name-status)\b/.test(l));

beforeEach(() => {
  resetReviewCache();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-review-list-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'gone.txt'), 'bye\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  git(['checkout', '-qb', 'feat']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(['rm', '-q', 'gone.txt']);
  git(['commit', '-qam', 'two']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\ny\n');

  // On Windows execFile writes them down (the mock above).
  if (process.platform === 'win32') {
    log = recorder.log = path.join(tmp, 'git.log');
    return;
  }
  // Every git Tars runs goes through this one, which writes down its arguments.
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  log = path.join(tmp, 'git.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // Retried, and not synchronously: a patch past the cut ends git at
  // maxBuffer, and execFile answers without waiting for git to exit. On
  // Windows the folder git works in cannot be removed until it has, and rmSync
  // does not retry that refusal at all (EBUSY on the folder's first rmdir);
  // fs.promises.rm retries the whole removal, here for at most 5.5 s.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const listOnly = { listOnly: true } as Parameters<typeof reviewDiff>[1];

describe('the review diff, asked for its list only', () => {
  it('1, 2. runs no git for the patches, hands none back, and lists what the full call lists', async () => {
    const list = await reviewDiff(repo, listOnly);
    const listRuns = ran();
    resetReviewCache();
    const full = await reviewDiff(repo);
    const fullRuns = ran();

    expect(patchRuns(fullRuns).length, 'the full call builds patches').toBeGreaterThan(0);
    expect(patchRuns(listRuns)).toEqual([]);
    expect(list.patch).toBe('');
    expect(list.truncated).toBe(false);
    expect({ ...list, patch: full.patch, truncated: full.truncated }).toEqual(full);
    expect(list.files.map(f => [f.path, f.status])).toEqual(expect.arrayContaining([
      ['a.txt', 'modified'], ['gone.txt', 'deleted'], ['new.txt', 'untracked'],
    ]));
  });

  it('3. hands a full call its patch after a list-only one, and keeps the full patch after a list-only read of it', async () => {
    await reviewDiff(repo, listOnly);
    const full = await reviewDiff(repo);
    expect(full.patch).toContain('+three');

    const list = await reviewDiff(repo, listOnly);
    expect(list.patch).toBe('');
    expect((await reviewDiff(repo)).patch).toContain('+three');
  });

  it('4. reads a list-only call from a full answer kept, and leaves the default call its patch', async () => {
    const full = await reviewDiff(repo);
    expect(full.patch).toContain('+two');
    ran();

    const list = await reviewDiff(repo, listOnly);

    expect(list.files).toEqual(full.files);
    expect(ran().filter(l => /^diff|^ls-files|^rev-list/.test(l))).toEqual([]);
  });
});

describe('the option, across IPC', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');

  it('5. is passed by the preload, typed for the renderer, and handed on by the handler', () => {
    expect(read('electron/preload.ts')).toMatch(/diff: \(repoPath: string, baseBranch\?: string, opts\?: \{ listOnly\?: boolean \}\) =>\s*ipcRenderer\.invoke\('review:diff', \{ repoPath, baseBranch, listOnly: opts\?\.listOnly === true \}\)/);
    expect(read('src/types/electron.d.ts')).toMatch(/diff: \(repoPath: string, baseBranch\?: string, opts\?: \{ listOnly\?: boolean \}\) =>/);
    expect(read('electron/handlers/ipc-handlers.ts')).toMatch(/reviewDiff\(repoPath, \{ baseBranch, listOnly: listOnly === true \}\)/);
  });
});

describe('a change past the patch cut (QA, gate of #247)', () => {
  it('6. the full call keeps the cut, and the list-only call reads no patch at all', async () => {
    // Over git()'s 8 MB buffer, as review-stays-in-the-repository.test.ts builds it: a
    // tracked file grown to 300 000 lines, since an untracked file is in no patch.
    fs.writeFileSync(path.join(repo, 'big.txt'), 'start\n');
    git(['add', 'big.txt']);
    git(['commit', '-qm', 'big']);
    fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(30).concat('\n').repeat(300_000));
    ran();

    const list = await reviewDiff(repo, listOnly);
    const listRuns = ran();
    resetReviewCache();
    const full = await reviewDiff(repo);

    expect(patchRuns(listRuns)).toEqual([]);
    expect(list).toMatchObject({ patch: '', truncated: false });
    expect(list.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'big.txt', status: 'added', additions: 300_000 })]));
    expect(full.truncated).toBe(true);
    expect(full.patch.endsWith('… patch truncated')).toBe(true);
  });
});

