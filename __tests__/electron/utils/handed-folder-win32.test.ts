import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * handed-folder.ts on Windows: never ~/.tars-private, in any of the spellings Windows takes for one folder. Run as
 * a Windows host runs it, on any host: `path` is path.win32 and the disk is a Windows one in memory, whose
 * realpathSync.native answers as Windows's does (a junction to its target, an 8.3 short name to its long name, the
 * case as it is on disk). On 2026-10-20 update-agent-route.test.ts 12b failed on a Windows PC (Nexarion434): create_agent
 * answered 200 for a folder inside ~/.tars-private.
 *
 * How it fails, written before the code:
 * 1. The folder itself is taken, spelled in another case, with `/`, with a trailing separator, dot or space, or
 *    with a `\\?\` prefix.
 * 2. A folder inside it is taken, in any of those spellings, made or not yet made.
 * 3. A folder that holds it is taken: the home folder, C:\Users, the drive's root, in any case or separator, or the
 *    home folder by its 8.3 short name.
 * 4. A junction to it, or a folder inside one, is taken, or a `..` after a junction to a folder inside it (the Audit's
 *    M1 on #503: Windows goes up from the target, path.resolve drops the `..` on the text); or a folder not made yet under the home folder's 8.3
 *    short name (no realpath answers for a path that does not exist, so its spelling alone was compared).
 * 5. The comparison follows process.platform while the paths follow the host's `path`: on a Windows host whose
 *    process.platform says linux (update-agent-route.test.ts runs so, for its POSIX CLI disk), POSIX rules read a
 *    C:\ path, and a folder inside the private one is not seen inside it.
 * 6. Over-refusal: a sibling named .tars-private-notes, a project under the home folder, another drive, or a
 *    project folder not made yet is refused; or the check throws.
 */

const disk = vi.hoisted(() => ({ entries: new Map<string, string>() }));

vi.mock('path', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return { ...p.win32, default: p.win32, posix: p.posix, win32: p.win32 };
});

vi.mock('fs', async () => {
  const f = await vi.importActual<typeof import('fs')>('fs');
  const p = await vi.importActual<typeof import('path')>('path');
  const w = p.win32;
  /** Windows's realpath: each segment looked up in any case, a junction or a short name followed to its target. */
  const realpath = (input: unknown): string => {
    const full = w.resolve(String(input).replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, ''));
    const root = w.parse(full).root;
    let cur = disk.entries.get(root.toUpperCase());
    if (cur === undefined) throw Object.assign(new Error(`ENOENT: realpath '${full}'`), { code: 'ENOENT' });
    for (const seg of full.slice(root.length).split('\\').filter(Boolean)) {
      const next = disk.entries.get(w.join(cur, seg).toUpperCase());
      if (next === undefined) throw Object.assign(new Error(`ENOENT: realpath '${full}'`), { code: 'ENOENT' });
      cur = next;
    }
    return cur;
  };
  const realpathSync = Object.assign((x: unknown) => realpath(x), { native: (x: unknown) => realpath(x) });
  return { ...f, default: { ...f, realpathSync }, realpathSync };
});

// Only what handed-folder reads: the real module would move a data folder on load, on this host's disk.
vi.mock('../../../electron/constants', () => ({ PRIVATE_DIR: 'C:\\Users\\Nexarion434\\.tars-private' }));

import { handedFolderProblem, handedSecondaryFolder } from '../../../electron/utils/handed-folder';

const HOME = 'C:\\Users\\Nexarion434';
const PRIVATE = `${HOME}\\.tars-private`;

/** Lay the disk: every real folder by its long name, and the aliases Windows resolves (junction, 8.3 name). */
function lay() {
  disk.entries.clear();
  const real = ['C:\\', 'C:\\Users', HOME, PRIVATE, `${PRIVATE}\\accounts`, `${HOME}\\.tars-private-notes`,
    `${HOME}\\projects`, `${HOME}\\projects\\demo`, `${HOME}\\projects\\shared`, 'D:\\', 'D:\\work'];
  for (const r of real) disk.entries.set(r.toUpperCase(), r);
  disk.entries.set('C:\\USERS\\NEXARI~1', HOME);
  disk.entries.set(`${HOME}\\projects\\demo\\secrets`.toUpperCase(), PRIVATE);
  // The Audit's M1 on #503: a junction to a folder inside it, then `..` (Windows goes up from the target).
  disk.entries.set(`${HOME}\\projects\\demo\\acc`.toUpperCase(), `${PRIVATE}\\accounts`);
}

const HOST = Object.getOwnPropertyDescriptor(process, 'platform')!;
const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...HOST, value: platform });
beforeEach(() => { lay(); as('win32'); });
afterAll(() => { Object.defineProperty(process, 'platform', HOST); });

const problem = (folder: string) => handedFolderProblem(folder, { privateDir: PRIVATE });

const ITSELF = [
  PRIVATE,
  'c:\\users\\nexarion434\\.TARS-PRIVATE',
  'C:/Users/Nexarion434/.tars-private',
  `${PRIVATE}\\`,
  `${PRIVATE}.`,
  `${PRIVATE} `,
  `\\\\?\\${PRIVATE}`,
  `${HOME}\\projects\\..\\.tars-private`,
];

const INSIDE = [
  `${PRIVATE}\\accounts`,
  `${PRIVATE}\\claude-accounts.json`,
  'C:/Users/Nexarion434/.tars-private/accounts',
  'c:\\USERS\\nexarion434/.tars-private\\not-made-yet',
];

const HOLDERS = [HOME, 'c:\\users\\nexarion434\\', 'C:/Users', 'C:\\', 'c:/', 'C:\\Users\\NEXARI~1'];

const THROUGH_ALIASES = [
  `${HOME}\\projects\\demo\\secrets`,
  `${HOME}\\projects\\demo\\SECRETS\\accounts`,
  `${HOME}\\projects\\demo\\secrets\\not-made-yet`,
  `${HOME}\\projects\\demo\\acc\\..\\brandnew`,
  `${HOME}\\projects\\demo\\acc\\..\\accounts`,
  'C:\\Users\\NEXARI~1\\.tars-private',
  'C:\\Users\\NEXARI~1\\.tars-private\\not-made-yet',
];

describe('~/.tars-private on Windows', () => {
  it('1. refuses the folder itself in every spelling', () => {
    expect(ITSELF.filter(f => problem(f) === null)).toEqual([]);
  });

  it('2. refuses a folder inside it, made or not', () => {
    expect(INSIDE.filter(f => problem(f) === null)).toEqual([]);
  });

  it('3. refuses a folder that holds it, the home folder by its 8.3 name too', () => {
    expect(HOLDERS.filter(f => problem(f) === null)).toEqual([]);
  });

  it('4. refuses a junction to it, a folder inside one, and a folder not made yet under an 8.3 name', () => {
    expect(THROUGH_ALIASES.filter(f => problem(f) === null)).toEqual([]);
  });

  it('5. reads a Windows path by Windows rules even where process.platform says linux', () => {
    as('linux');
    expect([...ITSELF, ...INSIDE, ...HOLDERS, ...THROUGH_ALIASES].filter(f => problem(f) === null)).toEqual([]);
  });

  it('6. takes what only looks like one of those, and never throws', () => {
    const fine = [`${HOME}\\.tars-private-notes`, `${HOME}\\projects\\shared`, 'D:\\work', `${HOME}\\projects\\not-made-yet`, 'c:/users/nexarion434/projects/demo'];
    expect(fine.map(f => [f, problem(f)])).toEqual(fine.map(f => [f, null]));
  });

  it('the launch leaves out every refused spelling and keeps a plain folder', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect([...ITSELF, ...INSIDE, ...HOLDERS, ...THROUGH_ALIASES].filter(f => handedSecondaryFolder(f) !== undefined)).toEqual([]);
    expect(handedSecondaryFolder(`${HOME}\\projects\\shared`)).toBe(`${HOME}\\projects\\shared`);
    warn.mockRestore();
  });
});

/**
 * A folder where credentials are kept, on Windows (handed-folder-credentials.test.ts for the rule and its failure
 * list): %USERPROFILE%\.ssh, the stores under %APPDATA%, in Windows's spellings, behind a junction, and what holds them.
 */
describe('a credential folder on Windows', () => {
  const SSH = `${HOME}\\.ssh`;
  const ROAMING = `${HOME}\\AppData\\Roaming`;
  const CREDS = [SSH, `${ROAMING}\\Microsoft\\Credentials`, `${ROAMING}\\GitHub CLI`];
  beforeEach(() => {
    for (const r of [SSH, `${HOME}\\AppData`, ROAMING, `${ROAMING}\\Microsoft`, `${ROAMING}\\Microsoft\\Credentials`, `${ROAMING}\\GitHub CLI`, `${ROAMING}\\SomeApp`]) {
      disk.entries.set(r.toUpperCase(), r);
    }
    disk.entries.set(`${HOME}\\projects\\demo\\keys`.toUpperCase(), SSH);
  });
  const cred = (folder: string) => handedFolderProblem(folder, { privateDir: PRIVATE, credentialDirs: CREDS } as never);

  it('refuses the folder in every spelling, one inside it, and one behind a junction', () => {
    const refused = [SSH, 'c:\\users\\nexarion434\\.SSH', 'C:/Users/Nexarion434/.ssh', `${SSH}\\`, `${SSH}\\id_not_made`,
      `${ROAMING}\\GitHub CLI\\hosts`, `${HOME}\\projects\\demo\\keys`, `${HOME}\\projects\\demo\\KEYS\\not-made`];
    expect(refused.filter(f => cred(f) === null)).toEqual([]);
  });

  it('refuses %APPDATA% and AppData, which hold the stores', () => {
    expect([ROAMING, `${HOME}\\AppData`, 'c:/users/nexarion434/appdata/roaming'].filter(f => cred(f) === null)).toEqual([]);
  });

  it('takes another folder of %APPDATA%, a project and another drive', () => {
    const fine = [`${ROAMING}\\SomeApp`, `${HOME}\\projects\\demo`, 'D:\\work'];
    expect(fine.map(f => [f, cred(f)])).toEqual(fine.map(f => [f, null]));
  });
});
