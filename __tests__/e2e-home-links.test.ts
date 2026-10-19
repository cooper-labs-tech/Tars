import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cannotSymlink } from './setup/symlink-privilege';
import { linksLeaving } from '../e2e/home-links.mjs';

/**
 * linksLeaving: the symbolic links of a cloned home whose real target lies outside it (#467, the Audit's L1). The
 * Usage speed bench (e2e/usage-speed.bench.spec.ts) runs the app on a clone of a machine's home and refuses to start
 * while any link of the clone leads out of it: a Claude account folder's shared entries are links to the live
 * ~/.claude, a clone copies them as they are, and the bench of 18/10 ran two measures with them.
 *
 * Every way it can fail, written down before the module:
 * 1. a home with no link, or links that stay inside it, reported as leaving (a bench refused for nothing);
 * 2. an absolute link to a place outside not reported;
 * 3. a relative link that climbs out of the home not reported;
 * 4. a place outside reached through another spelling (a link outside on the way, or the home's own path spelled
 *    otherwise) judged by its spelling and not by where it really leads;
 * 5. a chain of links, the last one leading out, not reported;
 * 6. a link to a place that does not exist yet outside the home not reported (dangling, it may be made later);
 * 7. a loop of links hanging the walk or passing as inside;
 * 8. a linked directory walked into: its content listed as the home's, or a link to an ancestor walked forever;
 * 9. a report that does not say which link, relative to the home, and its target as written.
 */

let tmp: string;
let home: string;
let outside: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-links-')));
  home = path.join(tmp, 'home');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-accounts', 'acct'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'projects'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const link = (target: string, at: string) => fs.symlinkSync(target, path.join(home, at));
const names = () => linksLeaving(home).map((l: { link: string }) => l.link).sort();

describe('linksLeaving', () => {
  it('1. reports nothing for a home with no link', () => {
    expect(linksLeaving(home)).toEqual([]);
  });

  it.skipIf(cannotSymlink())('1. reports nothing for links that stay inside, absolute, relative or dangling', () => {
    link(path.join(home, '.claude', 'projects'), '.claude-accounts/acct/projects');
    link('../../.claude/plugins-not-made-yet', '.claude-accounts/acct/plugins');
    link('./projects', '.claude/projects-alias');
    link('..', '.claude/up');
    expect(linksLeaving(home)).toEqual([]);
  });

  it.skipIf(cannotSymlink())('2. reports an absolute link to a place outside', () => {
    link(path.join(outside, 'projects'), '.claude-accounts/acct/projects');
    expect(names()).toEqual([path.join('.claude-accounts', 'acct', 'projects')]);
  });

  it.skipIf(cannotSymlink())('3. reports a relative link that climbs out of the home', () => {
    link('../../../outside/projects', '.claude-accounts/acct/projects');
    link('../../home/../outside', '.claude/escape');
    expect(names()).toEqual([path.join('.claude', 'escape'), path.join('.claude-accounts', 'acct', 'projects')].sort());
  });

  it.skipIf(cannotSymlink())('4. judges where a link really leads, whatever the spelling of the path', () => {
    // Outside, through a link outside on the way.
    fs.symlinkSync(outside, path.join(tmp, 'alias'));
    link(path.join(tmp, 'alias', 'projects'), '.claude-accounts/acct/projects');
    // Inside, through another spelling of the home itself: no report.
    fs.symlinkSync(home, path.join(tmp, 'home-alias'));
    link(path.join(tmp, 'home-alias', '.claude', 'projects'), '.claude-accounts/acct/inside');
    expect(names()).toEqual([path.join('.claude-accounts', 'acct', 'projects')]);
    // The home handed in through its other spelling: the same answer.
    expect(linksLeaving(path.join(tmp, 'home-alias')).map((l: { link: string }) => l.link)).toEqual([path.join('.claude-accounts', 'acct', 'projects')]);
  });

  it.skipIf(cannotSymlink())('5. reports a chain whose last link leads out', () => {
    link(outside, '.claude/last');
    link('last/projects', '.claude/first');
    expect(names()).toEqual([path.join('.claude', 'first'), path.join('.claude', 'last')]);
  });

  it.skipIf(cannotSymlink())('6. reports a dangling link to a place outside, however it is spelled', () => {
    link(path.join(outside, 'not-made-yet'), '.claude/absent');
    link('../../outside/nor-this', '.claude/absent-relative');
    link('not-here/../../../outside', '.claude/absent-through-a-missing-name');
    expect(names()).toEqual([path.join('.claude', 'absent'), path.join('.claude', 'absent-relative'), path.join('.claude', 'absent-through-a-missing-name')]);
  });

  it.skipIf(cannotSymlink())('7. reports a loop of links, and returns', () => {
    link('b', '.claude/a');
    link('a', '.claude/b');
    expect(names()).toEqual([path.join('.claude', 'a'), path.join('.claude', 'b')]);
  });

  it.skipIf(cannotSymlink())('8. never walks into a linked directory', () => {
    fs.writeFileSync(path.join(outside, 'projects', 'secret.jsonl'), '{}');
    fs.symlinkSync('../../outside', path.join(outside, 'projects', 'back'));
    link(outside, '.claude/outside-dir');
    link(home, '.claude/home-again');
    const found = linksLeaving(home);
    expect(found.map((l: { link: string }) => l.link)).toEqual([path.join('.claude', 'outside-dir')]);
  });

  it.skipIf(cannotSymlink())('9. says which link, relative to the home, its target as written and where it leads', () => {
    link('../../../outside/projects', '.claude-accounts/acct/projects');
    const [found] = linksLeaving(home);
    expect(found).toEqual({
      link: path.join('.claude-accounts', 'acct', 'projects'),
      target: '../../../outside/projects',
      leadsTo: path.join(outside, 'projects'),
    });
  });
});
