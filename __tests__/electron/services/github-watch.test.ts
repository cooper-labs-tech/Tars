import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pollGithub, githubRepoOf, GH_READ_ARGS, pollProjects } from '../../../electron/services/github-watch';
import { execFileSync } from 'node:child_process';

/**
 * What Tars reads from GitHub for the event reports: PRs merged, and changes
 * requested on a PR, in the repositories of the projects its agents work in,
 * through `gh`, read-only, every few minutes (step 4 of the relay plan).
 *
 * How it fails, written before the code (2026-09-28):
 * 1. The first poll reports every PR ever merged: a flood on the first start.
 *    The first poll of a repository is its baseline and reports nothing.
 * 2. A merged PR is reported at every poll.
 * 3. Changes requested are reported at every poll while they stand; or not
 *    again once the PR was approved and then refused anew.
 * 4. `gh` missing, not signed in, or failing throws, or reports anything.
 * 5. `gh` is asked for anything but a read: a merge, a comment, an edit.
 * 6. A project whose remote is not on GitHub, or has none, is polled.
 * 7. A restart forgets what was seen, and reports it again.
 * 9. (the Audit's gate of #234) `gh` is run with the main process's PATH: a
 *    Tars opened from the Dock or Finder has /usr/bin:/bin:/usr/sbin:/sbin
 *    only, gh lives in /opt/homebrew/bin, and every poll failed, silently.
 * 8. Polling resumes after a long pause (the bot off, Tars closed) and
 *    reports everything merged in the meantime: a repository not polled for
 *    an hour is taken as a new baseline.
 */

const REPO = 'JeanBrasse/Tars';
type Pr = { number: number; title: string; url: string; mergedAt?: string; reviewDecision?: string };
let merged: Pr[];
let open: Pr[];
let calls: string[][];
let fails = false;
const gh = async (args: string[]) => {
  calls.push(args);
  if (fails) throw new Error('gh: not logged in');
  return JSON.stringify(args.includes('merged') ? merged : open);
};
const pr = (n: number, extra: Partial<Pr> = {}): Pr => ({ number: n, title: `PR ${n}`, url: `https://github.com/${REPO}/pull/${n}`, ...extra });

beforeEach(() => {
  merged = [pr(1, { mergedAt: '2026-09-20T00:00:00Z' })];
  open = [pr(5, { reviewDecision: 'CHANGES_REQUESTED' })];
  calls = [];
  fails = false;
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
});

describe('polling GitHub', () => {
  it('1. reports nothing on a repository\'s first poll', async () => {
    expect(await pollGithub([REPO], gh)).toEqual([]);
  });

  it('2, 7. reports a PR merged since, once, across a restart', async () => {
    await pollGithub([REPO], gh);
    merged = [pr(231, { mergedAt: '2026-09-28T01:00:00Z' }), ...merged];
    const events = await pollGithub([REPO], gh);
    expect(events).toEqual([{ kind: 'pr-merged', repo: REPO, number: 231, title: 'PR 231', url: `https://github.com/${REPO}/pull/231` }]);
    expect(await pollGithub([REPO], gh)).toEqual([]);
  });

  it('3. reports changes requested when they are, once, and again after an approval', async () => {
    await pollGithub([REPO], gh);
    open = [pr(5, { reviewDecision: 'CHANGES_REQUESTED' }), pr(6, { reviewDecision: 'CHANGES_REQUESTED' })];
    expect((await pollGithub([REPO], gh)).map(e => [e.kind, e.number])).toEqual([['changes-requested', 6]]);
    expect(await pollGithub([REPO], gh)).toEqual([]);
    open = [pr(6, { reviewDecision: 'APPROVED' })];
    await pollGithub([REPO], gh);
    open = [pr(6, { reviewDecision: 'CHANGES_REQUESTED' })];
    expect((await pollGithub([REPO], gh)).map(e => [e.kind, e.number])).toEqual([['changes-requested', 6]]);
  });

  it('4. reports nothing and throws nothing when gh fails', async () => {
    fails = true;
    await expect(pollGithub([REPO], gh)).resolves.toEqual([]);
  });

  it('5. only ever asks gh to list, as JSON', async () => {
    await pollGithub([REPO], gh);
    await pollGithub([REPO], gh);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      expect(args).toContain('--json');
      expect(args).toContain('--repo');
      for (const word of ['merge', 'comment', 'edit', 'close', 'review', 'create']) expect(args[1]).not.toBe(word);
    }
    expect(GH_READ_ARGS).toEqual(['pr', 'list']);
  });
});

describe('the repository of a project', () => {
  it('6. is its GitHub origin, and nothing for another host or no remote', () => {
    expect(githubRepoOf('https://github.com/JeanBrasse/Tars.git')).toBe('JeanBrasse/Tars');
    expect(githubRepoOf('git@github.com:JeanBrasse/Tars.git')).toBe('JeanBrasse/Tars');
    expect(githubRepoOf('ssh://git@github.com/JeanBrasse/Tars')).toBe('JeanBrasse/Tars');
    expect(githubRepoOf('https://gitlab.com/x/y.git')).toBeUndefined();
    expect(githubRepoOf('https://github.com.evil.example/x/y')).toBeUndefined();
    expect(githubRepoOf(undefined)).toBeUndefined();
    expect(githubRepoOf('https://github.com/x/y;rm -rf')).toBeUndefined();
  });
});

describe('after a pause', () => {
  it('8. takes a repository not polled for an hour as a new baseline', async () => {
    const t0 = Date.UTC(2026, 8, 28, 9, 0, 0);
    await pollGithub([REPO], gh, t0);
    merged = [pr(300, { mergedAt: '2026-09-28T11:00:00Z' }), ...merged];
    expect(await pollGithub([REPO], gh, t0 + 2 * 3_600_000)).toEqual([]);
    merged = [pr(301, { mergedAt: '2026-09-28T11:05:00Z' }), ...merged];
    expect((await pollGithub([REPO], gh, t0 + 2 * 3_600_000 + 300_000)).map(e => e.number)).toEqual([301]);
  });
});

describe('the gh and git a real poll runs', () => {
  it('9. are found under the bare PATH of an app opened from the Dock', async () => {
    const home = os.homedir();
    // The first of the folders buildFullPath adds, ahead of /opt/homebrew/bin:
    // the machine's own gh is never the one answering here.
    const bin = path.join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const log = path.join(home, 'gh-calls.log');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${log}'\necho '[]'\n`, { mode: 0o755 });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gh-project-'));
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/JeanBrasse/Tars.git']);

    const saved = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      await pollProjects([project]);
    } finally {
      process.env.PATH = saved;
    }

    expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '', 'gh was never run').toMatch(/^pr list --repo JeanBrasse\/Tars/m);
  });
});

describe('a PR event of a project', () => {
  it('10. carries the project whose repository it was found in: a reply to its report goes to that project', async () => {
    const home = os.homedir();
    const bin = path.join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const mergedFile = path.join(home, 'merged.json');
    fs.writeFileSync(mergedFile, '[]');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *"--state merged"*) cat '${mergedFile}' ;; *) echo '[]' ;; esac\n`, { mode: 0o755 });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gh-project-'));
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/someone/elsewhere.git']);

    await pollProjects([project]);
    fs.writeFileSync(mergedFile, JSON.stringify([{ number: 7, title: 'Seven', url: 'https://github.com/someone/elsewhere/pull/7', mergedAt: '2026-10-01T01:00:00Z' }]));
    const events = await pollProjects([project]);

    expect(events).toEqual([expect.objectContaining({ kind: 'pr-merged', repo: 'someone/elsewhere', number: 7, projectPath: project })]);
  });
});
