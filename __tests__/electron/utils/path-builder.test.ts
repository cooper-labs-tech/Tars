import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The PATH every agent, ACP run and updater is given.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. darwin/linux: any byte of today's output changes (order, a dropped
 *    entry, an empty entry that meant "current directory", the nvm dirs, the
 *    trailing join). The literals below were produced by the code as it stood
 *    at c349d7c1, before this change, and are the proof.
 * 2. win32: the Path is split on ':' and every drive colon cuts an entry in
 *    two, then re-joined with ':', which glues the prepended CLI dirs and the
 *    first system entry into one unusable entry.
 * 3. win32: the user's configured CLI dirs never reach the child PATH.
 * 4. win32: %USERPROFILE%\.local\bin (native claude.exe) or %APPDATA%\npm
 *    (npm global shims) is missing.
 * 5. win32: the same directory spelled twice with a different case or a
 *    trailing backslash survives twice (Windows paths are case-insensitive).
 * 6. win32: the existing value is read from `PATH` only, while an env started
 *    from Explorer spells it `Path`, so the system entries are lost.
 * 7. win32: the macOS-only entries (/usr/local/bin, /opt/homebrew/bin, nvm's
 *    bin dirs) are added to a Windows PATH.
 * 8. A directory listing that throws takes the whole PATH down with it.
 * 9. win32 (decided at review, 2026-09-25): the
 *    default Windows CLI dirs are put before the existing entries, so a
 *    where.exe, curl.exe or tar.exe dropped in %APPDATA%\npm or .local\bin
 *    shadows System32's. They go after; the user's own cliPathDirs stay first,
 *    an explicit choice, as on macOS.
 */

const fsState: { nvmExists: boolean; versions: string[] | Error } = { nvmExists: false, versions: [] };
const existsCalls: string[] = [];

// The code as it stood read the host's path module. These literals are the
// darwin/linux outputs, so the "before" run used path.posix: on a macOS or
// Linux host that is the same module.
vi.mock('path', async () => {
  const real = await vi.importActual<typeof import('path')>('path');
  return { ...real.posix, default: real.posix, posix: real.posix, win32: real.win32 };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const existsSync = (p: string) => { existsCalls.push(String(p)); return fsState.nvmExists; };
  const readdirSync = () => {
    if (fsState.versions instanceof Error) throw fsState.versions;
    return fsState.versions;
  };
  return { ...real, default: { ...real, existsSync, readdirSync }, existsSync, readdirSync };
});
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => '/Users/fallback' }, homedir: () => '/Users/fallback' };
});

import { buildFullPath } from '../../../electron/utils/path-builder';

const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
beforeEach(() => {
  fsState.nvmExists = false;
  fsState.versions = [];
  existsCalls.length = 0;
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
});

/** The six darwin/linux situations, run through the process environment as the callers do. */
const POSIX_CASES: Array<{ name: string; home?: string; path?: string; nvm?: string[] | Error; extra: string[] }> = [
  { name: 'plain', home: '/home/u', path: '/usr/bin:/bin', extra: [] },
  { name: 'nvm dir and duplicates', home: '/home/u', path: '/usr/bin:/bin:/usr/local/bin', nvm: ['v18.20.0', 'v20.11.1'], extra: ['/opt/claude/bin', '/usr/bin'] },
  { name: 'PATH unset', home: '/home/u', path: undefined, extra: ['/opt/x'] },
  { name: 'empty entries kept', home: '/home/u', path: '/a::/b:', extra: [] },
  { name: 'HOME unset', home: undefined, path: '/usr/bin', extra: [] },
  { name: 'nvm listing throws', home: '/home/u', path: '/usr/bin', nvm: new Error('EACCES'), extra: [] },
];

function runThroughProcessEnv(c: (typeof POSIX_CASES)[number]): string {
  if (c.home === undefined) delete process.env.HOME; else process.env.HOME = c.home;
  if (c.path === undefined) delete process.env.PATH; else process.env.PATH = c.path;
  fsState.nvmExists = c.nvm !== undefined;
  fsState.versions = c.nvm ?? [];
  return buildFullPath(c.extra);
}

/** Run with process.platform reading `platform`, as it does on that host. */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

describe('1. darwin/linux: the outputs of c349d7c1, unchanged', () => {
  it.each(['darwin', 'linux'] as const)('through process.env, as every caller calls it, on %s', (platform) => {
    expect(onPlatform(platform, () => POSIX_CASES.map(runThroughProcessEnv))).toEqual(POSIX_BEFORE);
  });
});

/**
 * Recorded by running the code as it stood at c349d7c1 (path.posix, the
 * mocks above) over POSIX_CASES, before path-builder.ts was edited.
 */
const POSIX_BEFORE = [
  '/home/u/.nvm/versions/node/v20.11.1/bin:/home/u/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/home/u/.local/bin:/usr/bin:/bin',
  '/opt/claude/bin:/usr/bin:/home/u/.nvm/versions/node/v20.11.1/bin:/home/u/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/home/u/.local/bin:/home/u/.nvm/versions/node/v18.20.0/bin:/bin',
  '/opt/x:/home/u/.nvm/versions/node/v20.11.1/bin:/home/u/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/home/u/.local/bin:',
  '/home/u/.nvm/versions/node/v20.11.1/bin:/home/u/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/home/u/.local/bin:/a::/b',
  '/Users/fallback/.nvm/versions/node/v20.11.1/bin:/Users/fallback/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/Users/fallback/.local/bin:/usr/bin',
  '/home/u/.nvm/versions/node/v20.11.1/bin:/home/u/.nvm/versions/node/v22.0.0/bin:/usr/local/bin:/opt/homebrew/bin:/home/u/.local/bin:/usr/bin',
];

describe('1. darwin/linux: the same literals with the environment and platform injected', () => {
  it.each(['darwin', 'linux'] as const)('on %s', (platform) => {
    const outputs = POSIX_CASES.map((c) => {
      fsState.nvmExists = c.nvm !== undefined;
      fsState.versions = c.nvm ?? [];
      const env: Record<string, string | undefined> = {};
      if (c.home !== undefined) env.HOME = c.home;
      if (c.path !== undefined) env.PATH = c.path;
      // The process environment says something else: only the injected one counts.
      process.env.HOME = '/nobody';
      process.env.PATH = '/wrong';
      return buildFullPath(c.extra, { env, platform });
    });
    expect(outputs).toEqual(POSIX_BEFORE);
  });
});

describe('win32', () => {
  const env = {
    USERPROFILE: 'C:\\Users\\Sam Lee',
    APPDATA: 'C:\\Users\\Sam Lee\\AppData\\Roaming',
    Path: 'C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Program Files\\nodejs\\;C:\\Program Files (x86)\\Tool',
  };

  it('2, 3, 4, 9. the user\'s CLI dirs first, then every Path entry, then the two Windows CLI dirs, joined with ;', () => {
    const out = buildFullPath(['D:\\cli\\claude', 'C:\\Program Files (x86)\\Codex'], { env, platform: 'win32' });
    expect(out.split(';')).toEqual([
      'D:\\cli\\claude',
      'C:\\Program Files (x86)\\Codex',
      'C:\\WINDOWS\\system32',
      'C:\\WINDOWS',
      'C:\\Program Files\\nodejs\\',
      'C:\\Program Files (x86)\\Tool',
      'C:\\Users\\Sam Lee\\.local\\bin',
      'C:\\Users\\Sam Lee\\AppData\\Roaming\\npm',
    ]);
    expect(out).not.toContain(':\\WINDOWS:');
  });

  it('9. System32 comes before the default CLI dirs, so a tool dropped there never shadows it', () => {
    const out = buildFullPath([], { env, platform: 'win32' }).split(';');
    expect(out.indexOf('C:\\WINDOWS\\system32')).toBeLessThan(out.indexOf('C:\\Users\\Sam Lee\\AppData\\Roaming\\npm'));
    expect(out.indexOf('C:\\WINDOWS\\system32')).toBeLessThan(out.indexOf('C:\\Users\\Sam Lee\\.local\\bin'));
  });

  it('5. dedupes case-insensitively and across a trailing backslash, keeping the first spelling', () => {
    const out = buildFullPath(['c:\\windows\\SYSTEM32\\', 'C:\\Users\\sam lee\\.local\\bin'], { env, platform: 'win32' });
    const entries = out.split(';');
    expect(entries.filter((e) => /system32/i.test(e))).toEqual(['c:\\windows\\SYSTEM32\\']);
    expect(entries.filter((e) => /\.local\\bin/i.test(e))).toEqual(['C:\\Users\\sam lee\\.local\\bin']);
    expect(entries).toHaveLength(6);
  });

  it('6. reads the Path whatever the case of its key', () => {
    for (const key of ['Path', 'PATH', 'path']) {
      const out = buildFullPath([], { env: { USERPROFILE: 'C:\\U', [key]: 'C:\\sys' }, platform: 'win32' });
      expect(out.split(';')).toContain('C:\\sys');
    }
  });

  it('6. with two spellings, the one set last wins, as in { ...process.env, PATH: x }', () => {
    const out = buildFullPath([], { env: { USERPROFILE: 'C:\\U', Path: 'C:\\old', PATH: 'C:\\new' }, platform: 'win32' });
    expect(out.split(';')).toContain('C:\\new');
    expect(out.split(';')).not.toContain('C:\\old');
  });

  it('7. adds none of the macOS dirs and reads no nvm listing', () => {
    fsState.nvmExists = true;
    fsState.versions = ['v20.0.0'];
    const out = buildFullPath([], { env, platform: 'win32' });
    expect(out).not.toMatch(/homebrew|\/usr\/local|\.nvm/);
    expect(existsCalls).toEqual([]);
  });

  it('APPDATA unset: falls back to USERPROFILE\\AppData\\Roaming\\npm; no Path at all: the added dirs alone', () => {
    const out = buildFullPath([], { env: { USERPROFILE: 'C:\\U' }, platform: 'win32' });
    expect(out).toBe('C:\\U\\.local\\bin;C:\\U\\AppData\\Roaming\\npm');
  });

  it('drops the empty entries a Windows Path accumulates (;;), which name nothing there', () => {
    const out = buildFullPath([], { env: { USERPROFILE: 'C:\\U', APPDATA: 'C:\\A', Path: 'C:\\a;;C:\\b;' }, platform: 'win32' });
    expect(out).toBe('C:\\a;C:\\b;C:\\U\\.local\\bin;C:\\A\\npm');
  });
});
