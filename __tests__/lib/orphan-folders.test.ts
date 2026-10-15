import { describe, it, expect } from 'vitest';
import {
  folderLabel, sizeLabel, changedLabel, whyLabel, removeLabel,
  listingHint, confirmText, removingHint, doneHint, diskLine, unreadLine, keptTitle,
} from '../../src/lib/orphan-folders';
import type { OrphanFolder } from '../../src/types/electron';

/**
 * What Settings, System says of the folders no agent owns, and of the disk
 * (src/lib/orphan-folders.ts), on #334's contract. Frames: `Settings · System
 * · folders no agent owns` and its states. Written before the code. How it can
 * fail:
 * 1. a size reads wrong: a folder under a megabyte as "0 MB", a total past a
 *    gigabyte in MB, the totals without the frame's one decimal ("11.0 GB"),
 *    the disk with one ("81 GB" in the frame);
 * 2. one folder reads as many: "1 folders", "remove 1 folders";
 * 3. a folder is named by its absolute path, the home in it, where the frame
 *    names it by its project and its place under .worktrees; a project
 *    Windows wrote too, whose separator is `\` (the same for 9);
 * 4. a name hides, turns or breaks the line: a folder under .worktrees is
 *    named by whatever made it, an agent among them;
 * 5. a last change that is unknown or does not parse reads "NaN months", and
 *    one month reads "1 months";
 * 6. the end of a removal that removed nothing reads "Removed 0 folders", and
 *    one that kept folders does not say why they stay;
 * 7. the disk below Tars's floor reads like any other;
 * 8. a folder main did not remove reads as one it failed to: since #334's
 *    4e939d5c it also declines one that holds a repository or a live worktree
 *    by the time it comes to it, and its row's title says which (written
 *    before the change of the sentence);
 * 9. a project git could not list reads as one with no orphan: since #334's
 *    d1cc80a8 main names it in unreadProjects and offers none of its folders,
 *    and the row still says every folder belongs to a worktree git knows, or
 *    says nothing of it beside the folders offered; it is named by its path,
 *    the home in it, where the rows name a project by its folder's name; a
 *    name hides, turns or breaks the line; two projects read as one ("its
 *    folders"). Git's reason stays in main's log: main does not send it;
 * 10. a folder the confirm named that main kept because it was no longer one
 *    no agent owns when its turn came (since #334's 9db11f16 main removes
 *    only the paths the window showed, and keeps one gone by hand or a
 *    worktree again) has no row once the list is read again, and the end
 *    says its row says why, or counts it among the folders kept for a
 *    reason the rows give;
 * 11. a folder main could not remove says why in its title with Node's code
 *    alone (ENOTEMPTY, EACCES), which tells a person nothing: since #334's
 *    9db11f16 main sends the code and a path inside the folder. The words
 *    lose the code a search needs, or the path; a code without words reads
 *    as nothing; one of main's own sentences or a process's name is
 *    rewritten; a path inside the folder hides, turns or breaks the line,
 *    and so does a detail shown as main sent it, a process's name from lsof
 *    or /proc (written before the code, JeanBrasse's go of 07/10; that last case
 *    added after it, at the Audit's gate of #345, and seen red on a mutant).
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = new Date(2026, 9, 6, 12, 0);
const monthsAgo = (n: number) => new Date(2026, 9 - n, 6, 12, 0).toISOString();

const folder = (over: Partial<OrphanFolder> = {}): OrphanFolder => ({
  project: '/Users/you/projects/tars-hermes',
  path: '/Users/you/projects/tars-hermes/.worktrees/feat-relay-retry',
  name: 'feat-relay-retry',
  reason: 'git-forgot',
  sizeBytes: 412 * MB,
  lastChangedAt: monthsAgo(5),
  ...over,
});

describe('a folder\'s row', () => {
  it('names it by its project and its place under .worktrees, never by its path (3)', () => {
    expect(folderLabel(folder())).toBe('tars-hermes/.worktrees/feat-relay-retry');
    expect(folderLabel(folder({ name: 'feat/live' }))).toBe('tars-hermes/.worktrees/feat/live');
  });

  it('names a project Windows wrote by its folder too, never by its path (3)', () => {
    const project = 'C:\\Users\\you\\projects\\tars-hermes';
    expect(folderLabel(folder({ project }))).toBe('tars-hermes/.worktrees/feat-relay-retry');
    expect(folderLabel(folder({ project: `${project}\\` }))).toBe('tars-hermes/.worktrees/feat-relay-retry');
  });

  it('flattens what hides, turns or breaks the line (4)', () => {
    expect(folderLabel(folder({ name: 'feat\u202Eyrter\u2028x' }))).toBe('tars-hermes/.worktrees/feat yrter x');
  });

  it('says why in the frame\'s words', () => {
    expect(whyLabel('git-forgot')).toBe('git forgot it');
    expect(whyLabel('no-git')).toBe('no .git');
    expect(whyLabel('in-use')).toBe('in use');
    expect(whyLabel('unknown-use')).toBe('use unknown');
    expect(whyLabel('failed')).toBe('not removed');
  });

  it('sizes in KB, MB, then GB with one decimal (1)', () => {
    expect(sizeLabel(412 * MB)).toBe('412 MB');
    expect(sizeLabel(200_000)).toBe('195 KB');
    expect(sizeLabel(0)).toBe('0 KB');
    expect(sizeLabel(11 * GB)).toBe('11.0 GB');
    expect(sizeLabel(1.25 * GB)).toBe('1.3 GB');
  });

  it('says when it last changed, never NaN, one month as one (5)', () => {
    expect(changedLabel(monthsAgo(5), NOW)).toBe('5 months');
    expect(changedLabel(monthsAgo(1), NOW)).toBe('1 month');
    expect(changedLabel(new Date(2026, 9, 6, 9, 0).toISOString(), NOW)).toBe('3 hours');
    expect(changedLabel(new Date(2026, 9, 6, 11, 59, 30).toISOString(), NOW)).toBe('just now');
    expect(changedLabel(null, NOW)).toBe('unknown');
    expect(changedLabel('not a date', NOW)).toBe('unknown');
  });
});

describe('the row\'s sentences', () => {
  const listing = { folders: [folder()], count: 59, totalBytes: 11 * GB, unreadProjects: [] };

  it('the list, and the button, one folder as one (1, 2)', () => {
    expect(listingHint(listing)).toBe('59 folders, 11.0 GB, in your projects\' .worktrees that git no longer knows, so nothing says whether they hold work. Tars never removes them on its own.');
    expect(listingHint({ folders: [folder()], count: 1, totalBytes: 412 * MB, unreadProjects: [] })).toBe('1 folder, 412 MB, in your projects\' .worktrees that git no longer knows, so nothing says whether it holds work. Tars never removes it on its own.');
    expect(listingHint({ folders: [], count: 0, totalBytes: 0, unreadProjects: [] })).toBe('None: every folder in your projects\' .worktrees belongs to a worktree git knows.');
    expect(removeLabel(59)).toBe('remove 59 folders');
    expect(removeLabel(1)).toBe('remove 1 folder');
  });

  it('asks first, saying what goes', () => {
    expect(confirmText(listing)).toBe('Remove these 59 folders, 11.0 GB, for good? Git no longer knows them, so nothing says whether they hold work, and what is in them is lost.');
    expect(confirmText({ folders: [folder()], count: 1, totalBytes: 412 * MB })).toBe('Remove this folder, 412 MB, for good? Git no longer knows it, so nothing says whether it holds work, and what is in it is lost.');
  });

  it('counts as it goes', () => {
    expect(removingHint({ done: 23, total: 59, freedBytes: 4.1 * GB, current: '/x' })).toBe('Removing 23 of 59: 4.1 GB given back so far.');
    expect(removingHint(null)).toBe('Removing…');
  });

  it('says what was removed, and why what stays stays (6)', () => {
    const kept = (reason: 'in-use' | 'unknown-use' | 'failed') => ({ path: '/p/.worktrees/a', project: '/p', reason });
    expect(doneHint({ removed: 58, freedBytes: 10.8 * GB, kept: [kept('in-use')] })).toBe('Removed 58 folders: 10.8 GB given back. One was kept: a process works in it.');
    expect(doneHint({ removed: 2, freedBytes: 2 * MB, kept: [] })).toBe('Removed 2 folders: 2 MB given back.');
    expect(doneHint({ removed: 1, freedBytes: 2 * MB, kept: [kept('in-use'), kept('in-use')] })).toBe('Removed 1 folder: 2 MB given back. 2 were kept: a process works in each.');
    expect(doneHint({ removed: 0, freedBytes: 0, kept: [kept('unknown-use'), kept('unknown-use')] })).toBe('None was removed: Tars could not read which processes work in them, so all 2 were kept.');
    expect(doneHint({ removed: 3, freedBytes: 3 * MB, kept: [kept('failed')] })).toBe('Removed 3 folders: 3 MB given back. One was kept: its row says why.');
    expect(doneHint({ removed: 0, freedBytes: 0, kept: [kept('failed'), kept('failed')] })).toBe('None was removed. 2 were kept: their rows say why.');
    expect(doneHint({ removed: 3, freedBytes: 3 * MB, kept: [kept('in-use'), kept('failed')] })).toBe('Removed 3 folders: 3 MB given back. 2 were kept: their rows say why.');
  });
});

describe('the disk', () => {
  it('says how much is free, of how much, and the floor (1)', () => {
    expect(diskLine({ freeBytes: 81 * GB, totalBytes: 460 * GB, floorBytes: 30 * GB })).toEqual({
      hint: '81 GB free of 460 GB on the startup disk. Tars warns below 30 GB.', value: '81 GB free', low: false,
    });
  });

  it('marks it below the floor (7)', () => {
    expect(diskLine({ freeBytes: 24 * GB, totalBytes: 460 * GB, floorBytes: 30 * GB })).toMatchObject({ value: '24 GB free', low: true });
  });
});

describe('a project git could not list (9)', () => {
  const api = '/Users/you/projects/api-server';
  const web = '/Users/you/web';

  it('is named under the row as the rows name a project, never by its path', () => {
    expect(unreadLine([api])).toBe('Git could not list the worktrees of api-server, so Tars cannot say which of its folders no agent owns.');
    expect(unreadLine([`${api}/`])).toBe('Git could not list the worktrees of api-server, so Tars cannot say which of its folders no agent owns.');
    expect(unreadLine([api, web])).toBe('Git could not list the worktrees of api-server and web, so Tars cannot say which of their folders no agent owns.');
    expect(unreadLine([api, web, '/Users/you/projects/tars-hermes'])).toBe('Git could not list the worktrees of api-server, web and tars-hermes, so Tars cannot say which of their folders no agent owns.');
    expect(unreadLine([])).toBeNull();
  });

  it('names a project Windows wrote by its folder too, never by its path', () => {
    expect(unreadLine(['C:\\Users\\you\\projects\\api-server'])).toBe('Git could not list the worktrees of api-server, so Tars cannot say which of its folders no agent owns.');
  });

  it('flattens what hides, turns or breaks the line', () => {
    const rlo = String.fromCodePoint(0x202e);
    const ls = String.fromCodePoint(0x2028);
    expect(unreadLine([`/Users/you/api${rlo}revres${ls}x`])).toBe('Git could not list the worktrees of api revres x, so Tars cannot say which of its folders no agent owns.');
  });

  it('keeps the row from saying every folder is known, and leaves the list as it reads beside it', () => {
    expect(listingHint({ count: 0, totalBytes: 0, unreadProjects: [api] })).toBe('None in the projects git could read.');
    expect(listingHint({ count: 0, totalBytes: 0, unreadProjects: [] })).toBe('None: every folder in your projects\' .worktrees belongs to a worktree git knows.');
    expect(listingHint({ count: 59, totalBytes: 11 * GB, unreadProjects: [api] })).toBe('59 folders, 11.0 GB, in your projects\' .worktrees that git no longer knows, so nothing says whether they hold work. Tars never removes them on its own.');
  });
});

describe('a folder that was no longer one no agent owns when its turn came (10)', () => {
  const k = (path: string, reason: 'in-use' | 'unknown-use' | 'failed') => ({ path, project: '/p', reason });
  const x = '/p/.worktrees/x';

  it('is said in the end, since no row is left to say it', () => {
    expect(doneHint({ removed: 2, freedBytes: 2 * MB, kept: [k(x, 'failed')] }, new Set())).toBe('Removed 2 folders: 2 MB given back. One was no longer a folder no agent owns.');
    expect(doneHint({ removed: 0, freedBytes: 0, kept: [k(x, 'failed'), k('/p/.worktrees/y', 'failed')] }, new Set())).toBe('None was removed. 2 were no longer folders no agent owns.');
  });

  it('leaves the rows to say why for the ones still listed', () => {
    const busy = '/p/.worktrees/busy';
    expect(doneHint({ removed: 2, freedBytes: 2 * MB, kept: [k(busy, 'in-use'), k(x, 'failed')] }, new Set([busy]))).toBe('Removed 2 folders: 2 MB given back. One was kept: a process works in it. One was no longer a folder no agent owns.');
    expect(doneHint({ removed: 0, freedBytes: 0, kept: [k(busy, 'failed'), k(x, 'failed')] }, new Set([busy]))).toBe('None was removed. One was kept: its row says why. One was no longer a folder no agent owns.');
    expect(doneHint({ removed: 0, freedBytes: 0, kept: [k(busy, 'unknown-use'), k(x, 'failed')] }, new Set([busy]))).toBe('None was removed: Tars could not read which processes work in it, so it was kept. One was no longer a folder no agent owns.');
    expect(doneHint({ removed: 1, freedBytes: 2 * MB, kept: [k(busy, 'in-use')] }, new Set([busy]))).toBe('Removed 1 folder: 2 MB given back. One was kept: a process works in it.');
  });
});

describe('why a folder was kept, in its title (11)', () => {
  const failed = (detail?: string) => ({ path: '/p/.worktrees/x', project: '/p', reason: 'failed' as const, detail });

  it('says a failure in plain words, the path inside the folder and the code after them', () => {
    expect(keptTitle(failed('ENOTEMPTY'))).toBe('not empty (ENOTEMPTY)');
    expect(keptTitle(failed('EACCES on locked/f'))).toBe('permission denied: locked/f (EACCES)');
    expect(keptTitle(failed('EPERM on node_modules/.bin/x'))).toBe('not permitted: node_modules/.bin/x (EPERM)');
    expect(keptTitle(failed('EBUSY'))).toBe('in use (EBUSY)');
  });

  it('leaves a code it has no words for, a sentence of main\'s and a process as main sent them', () => {
    expect(keptTitle(failed('EXDEV on a/b'))).toBe('EXDEV on a/b');
    expect(keptTitle(failed('it is no longer a folder of the project\'s .worktrees'))).toBe('it is no longer a folder of the project\'s .worktrees');
    expect(keptTitle({ path: '/p/.worktrees/busy', project: '/p', reason: 'in-use', detail: 'sleep (33193)' })).toBe('sleep (33193)');
  });

  it('says nothing when main said nothing', () => {
    expect(keptTitle(failed())).toBeUndefined();
    expect(keptTitle({ path: '/p/.worktrees/a', project: '/p', reason: 'unknown-use' })).toBeUndefined();
  });

  it('flattens what hides, turns or breaks the line in the path', () => {
    const rlo = String.fromCodePoint(0x202e);
    const ls = String.fromCodePoint(0x2028);
    expect(keptTitle(failed(`EACCES on a${rlo}b${ls}c`))).toBe('permission denied: a b c (EACCES)');
  });

  it('flattens a detail shown as main sent it, a process named by a hostile binary', () => {
    const rlo = String.fromCodePoint(0x202e);
    const nl = String.fromCodePoint(0x0a);
    expect(keptTitle({ path: '/p/.worktrees/busy', project: '/p', reason: 'in-use', detail: `a${rlo}b${nl}c (1)` })).toBe('a b c (1)');
  });
});
