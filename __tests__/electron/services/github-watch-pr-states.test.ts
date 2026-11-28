import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prStatesOf, prStatesOfProjects, testGhOf } from '../../../electron/services/github-watch';

/**
 * The end of a branch's pull request, merged or closed, as a traced session's outcome takes it (27/11, trace feature
 * A3). Read through `gh pr list`, as the event reports read the merged ones: one call per repository, `--state
 * closed`, which lists the merged ones too (gh 2.88.1, measured on 27/11: each reads `MERGED` or `CLOSED`, with its
 * `closedAt`).
 *
 * How it fails, written before the code:
 *  1. A pull request closed without being merged is missed (only the merged are read), or its branch is not read; a
 *     merged one's time is not when it merged, a closed one's not when it closed.
 *  2. Anything but `gh pr list --repo <repo> --state closed --json ...` is run: it must stay read-only.
 *  3. A repository whose list fails (gh missing, signed out, a network error) throws, or takes the others with it.
 *  4. A project whose origin is not on GitHub, or that has none, is asked about; projects sharing a repository are not
 *     all named for its pull requests.
 *  5. The stand-in gh an E2E names (DOROTHY_E2E_GH) is taken outside DOROTHY_E2E, or in a packaged build.
 */

const merged = { number: 41, state: 'MERGED', headRefName: 'feat/a', mergedAt: '2026-11-27T10:00:00Z', closedAt: '2026-11-27T10:00:01Z' };
const closed = { number: 42, state: 'CLOSED', headRefName: 'feat/b', mergedAt: null, closedAt: '2026-11-27T11:00:00Z' };

describe('the end of a pull request, by its branch', () => {
  it('1 and 2. merged and closed, with their branch and time, from one read-only list per repository', async () => {
    const calls: string[][] = [];
    const states = await prStatesOf(['owner/one'], async (args) => { calls.push(args); return JSON.stringify([merged, closed]); });
    expect(states).toEqual([
      { repo: 'owner/one', number: 41, branch: 'feat/a', state: 'merged', at: Date.parse(merged.mergedAt) },
      { repo: 'owner/one', number: 42, branch: 'feat/b', state: 'closed', at: Date.parse(closed.closedAt) },
    ]);
    expect(calls).toHaveLength(1);
    const [args] = calls;
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(args).toEqual(expect.arrayContaining(['--repo', 'owner/one', '--state', 'closed', '--json']));
    expect(args[args.indexOf('--json') + 1].split(',').sort()).toEqual(['closedAt', 'headRefName', 'mergedAt', 'number', 'state']);
  });

  it('3. a list that fails gives nothing for that repository, and the others still read', async () => {
    const states = await prStatesOf(['owner/bad', 'owner/good'], async (args) => {
      if (args.includes('owner/bad')) throw new Error('gh: not logged in');
      return JSON.stringify([merged, { number: 3, state: 'OPEN', headRefName: 'x' }, { number: 'nope' }]);
    });
    expect(states.map(s => [s.repo, s.number])).toEqual([['owner/good', 41]]);
  });

  it('4. only projects on GitHub are asked, and projects sharing a repository are all named', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prs-'));
    const mk = (name: string, origin?: string) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
      return dir;
    };
    const a = mk('a', 'https://github.com/owner/one.git');
    const b = mk('b', 'git@github.com:owner/one.git');
    const c = mk('c', 'https://gitlab.example/owner/two.git');
    const d = mk('d');
    const asked: string[] = [];
    const states = await prStatesOfProjects([a, b, c, d], async (args) => { asked.push(args[args.indexOf('--repo') + 1]); return JSON.stringify([merged]); });
    expect(asked).toEqual(['owner/one']);
    expect(states).toEqual([expect.objectContaining({ repo: 'owner/one', number: 41, projects: [a, b] })]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('5. the E2E\'s stand-in gh only under DOROTHY_E2E, never in a packaged build', () => {
    expect(testGhOf({ DOROTHY_E2E: '1', DOROTHY_E2E_GH: '/tmp/gh' }, false)).toBe('/tmp/gh');
    expect(testGhOf({ DOROTHY_E2E: '1', DOROTHY_E2E_GH: '/tmp/gh' }, true)).toBeNull();
    expect(testGhOf({ DOROTHY_E2E_GH: '/tmp/gh' }, false)).toBeNull();
    expect(testGhOf({ DOROTHY_E2E: '1', DOROTHY_E2E_GH: 'gh' }, false)).toBeNull();
  });
});
