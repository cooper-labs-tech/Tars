import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { CMD_SHIM_EXE, CMD_SHIM_NODE, GCLOUD_CMD, SH_SHIM, fakeWinFs, pinPlatform } from '../providers/win-fake-disk';

/**
 * Settings > CLI paths: detecting the CLIs, and the PATH written for them to
 * ~/.dorothy/cli-paths.json (audit B/C-01..C-04).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. PATH split on `:` and joined with `:`: `C:\a;D:\b` is cut at the drive
 *    colons, in the shell PATH read for detection and in cli-paths.json's
 *    fullPath, which must read back through pathEntries with `C:\tools` and
 *    `D:\a b (x)` intact.
 * 2. existsSync(dir\claude) with no PATHEXT: claude.exe and claude.cmd are
 *    missed, and npm's extensionless sh shim, which Windows cannot run, is
 *    taken for the CLI.
 * 3. `which X` through cmd.exe, where there is no `which`; and the login
 *    shell `-ilc 'echo $PATH'`, which is no Windows shell. On win32 no
 *    subprocess at all: the PATH is the process's, the lookup is in Node.
 * 4. The Windows install locations (%USERPROFILE%\.local\bin, %APPDATA%\npm,
 *    %LOCALAPPDATA%\Programs, ~\scoop\shims, WinGet\Links, the Cloud SDK)
 *    are not searched when the PATH lacks them.
 * 5. A saved path that is the sh shim alone is kept; a saved path that names
 *    claude.cmd, with or without its extension, is refused.
 * 6. gcloud.cmd, a batch file and no npm shim, is not detected.
 * 7. The macOS folders (/opt/homebrew/bin) or a relative PATH entry reach the
 *    disk on Windows: drive-relative, a planting hole.
 * 8. darwin/linux: the detection result, the files probed, or the `which`
 *    asked (now execFile with an argv) differ from before.
 * 9. darwin/linux: the bytes of cli-paths.json's fullPath differ from before,
 *    an unset PATH included.
 */

let tmpDir: string;
let unpin: (() => void) | undefined;
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
/** Every subprocess the handlers start, normalised: exec('which x') and execFile('which', ['x']) read the same. */
const spawned: Array<{ file: string; args: string[]; PATH?: string }> = [];
let whichAnswers: Record<string, string> = {};
let shellPathAnswer = '';
/** darwin/linux probes outside the temp home answer from this set, never from the real disk. */
let fakeExisting = new Set<string>();

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

vi.mock('fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fs')>();
  return {
    ...mod,
    existsSync: (p: fs.PathLike) => {
      const s = String(p);
      if (s.startsWith(tmpDir)) return mod.existsSync(p);
      return fakeExisting.has(s);
    },
  };
});

function answer(file: string, args: string[], opts: unknown) {
  const env = (opts as { env?: Record<string, string> } | undefined)?.env;
  spawned.push({ file, args, ...(env ? { PATH: env.PATH } : {}) });
  if (args[0] === '-ilc') return shellPathAnswer;
  if (file === 'which' && whichAnswers[args[0]] !== undefined) return whichAnswers[args[0]];
  return undefined;
}

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
    const [file, ...args] = cmd.split(' ');
    const out = answer(file, args, opts);
    if (out === undefined) cb(new Error(`${cmd}: not found`));
    else cb(null, { stdout: out });
  },
  execFile: (file: string, args: string[], opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
    const out = answer(file, args, opts);
    if (out === undefined) cb(new Error(`${file} ${args.join(' ')}: not found`));
    else cb(null, { stdout: out });
  },
}));

async function register() {
  const mod = await import('../../../electron/handlers/cli-paths-handlers');
  mod.registerCLIPathsHandlers({ getAppSettings: () => ({}) as never, setAppSettings: () => {}, saveAppSettings: () => {} });
  return mod;
}

const saved = new Map<string, string | undefined>();
function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  spawned.length = 0;
  whichAnswers = {};
  shellPathAnswer = '';
  fakeExisting = new Set();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cli-paths-'));
  fs.mkdirSync(path.join(tmpDir, '.dorothy'), { recursive: true });
});

afterEach(() => {
  unpin?.();
  unpin = undefined;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── win32 ─────────────────────────────────────────────────────────────────

const HOME = 'C:\\Users\\Sam Lee';
const NPM = `${HOME}\\AppData\\Roaming\\npm`;
const LOCAL_BIN = `${HOME}\\.local\\bin`;
const SCOOP = `${HOME}\\scoop\\shims`;
const WINGET = `${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links`;
const SDK = `${HOME}\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin`;
const TOOLS = 'C:\\Program Files (x86)\\tools';

const WIN_DISK: Record<string, string> = {
  [`${LOCAL_BIN}\\claude.exe`]: 'MZ',
  [`${NPM}\\claude`]: SH_SHIM,
  [`${NPM}\\claude.cmd`]: CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
  [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: 'MZ',
  [`${NPM}\\codex`]: SH_SHIM,
  [`${NPM}\\codex.cmd`]: CMD_SHIM_NODE('node_modules\\@openai\\codex\\bin\\codex.js'),
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NPM}\\gemini`]: SH_SHIM,
  [`${SCOOP}\\gh.exe`]: 'MZ',
  [`${WINGET}\\node.exe`]: 'MZ',
  [`${SDK}\\gcloud.cmd`]: GCLOUD_CMD,
  [`${TOOLS}\\grok.exe`]: 'MZ',
  'C:\\cwd-plant\\bin\\qwen.exe': 'MZ',
  'C:\\cwd-plant\\opt\\homebrew\\bin\\amp.exe': 'MZ',
  'C:\\sh-only\\pi': SH_SHIM,
};

const winEnv = {
  Path: `bin;"${TOOLS}";C:\\Windows\\System32`, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: HOME,
  APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local`,
};

describe('win32 detection', () => {
  it('finds each CLI where Windows installs it, never the sh shim, never a relative folder', async () => {
    const { detectWindowsCLIPaths } = await import('../../../electron/handlers/cli-paths-handlers');
    const disk = fakeWinFs(WIN_DISK);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const found = detectWindowsCLIPaths(undefined, winEnv, disk);

    expect(found).toEqual({
      amp: '', claude: `${LOCAL_BIN}\\claude.exe`, codex: `${NPM}\\codex.cmd`, gemini: '', grok: `${TOOLS}\\grok.exe`,
      qwencode: '', opencode: '', pi: '', gws: '', gcloud: `${SDK}\\gcloud.cmd`, gh: `${SCOOP}\\gh.exe`,
      node: `${WINGET}\\node.exe`, minimax: '',
    });
    expect(disk.relativeProbes).toEqual([]);
  });

  it('keeps a saved path that names a runnable CLI, with or without its extension, and refuses the sh shim alone', async () => {
    const { detectWindowsCLIPaths } = await import('../../../electron/handlers/cli-paths-handlers');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const found = detectWindowsCLIPaths({ claude: `${NPM}\\claude`, codex: `${NPM}\\codex.cmd`, pi: 'C:\\sh-only\\pi', gh: 'gh' }, winEnv, fakeWinFs(WIN_DISK));

    expect(found.claude).toBe(`${NPM}\\claude`);
    expect(found.codex).toBe(`${NPM}\\codex.cmd`);
    expect(found.pi).toBe('');
    expect(found.gh).toBe(`${SCOOP}\\gh.exe`);
  });

  it('through the handler on this platform: no login shell, no `which`, no subprocess at all', async () => {
    unpin = pinPlatform('win32');
    setEnv({ PATH: 'C:\\nowhere-tars-test' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await register();

    await handlers.get('cliPaths:detect')!({}, { refresh: true });

    expect(spawned).toEqual([]);
  });
});

describe('cli-paths.json fullPath on win32', () => {
  it('round-trips through pathEntries: C:\\tools and D:\\a b (x) intact, first, in order', async () => {
    unpin = pinPlatform('win32');
    setEnv({ PATH: 'C:\\Windows\\System32;C:\\Windows', USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming` });
    const mod = await register();
    const { pathEntries } = await import('../../../electron/platform');

    await handlers.get('cliPaths:save')!({}, { claude: '', additionalPaths: ['C:\\tools', 'D:\\a b (x)'] });

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.dorothy', 'cli-paths.json'), 'utf-8'));
    const entries = pathEntries(written.fullPath, 'win32');
    expect(entries.slice(0, 2)).toEqual(['C:\\tools', 'D:\\a b (x)']);
    expect(entries).toContain('C:\\Windows\\System32');
    expect(entries).toContain(`${HOME}\\AppData\\Roaming\\npm`);
    expect(entries.every((e) => /^[A-Z]:\\/i.test(e)), entries.join(' | ')).toBe(true);
    expect(mod.getFullPath()).toBe(written.fullPath);
  });

  it('with no file yet, the default is a Windows PATH too', async () => {
    unpin = pinPlatform('win32');
    setEnv({ PATH: 'C:\\Windows\\System32;D:\\bin (x)', USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming` });
    const mod = await register();
    const { pathEntries } = await import('../../../electron/platform');

    const entries = pathEntries(mod.getCLIPathsConfig().fullPath, 'win32');

    expect(entries).toContain('D:\\bin (x)');
    expect(entries.every((e) => /^[A-Z]:\\/i.test(e)), entries.join(' | ')).toBe(true);
  });
});

// ── darwin / linux: the same as before, byte for byte ─────────────────────

/**
 * The old detection, as it read before this lot, table-driven: probe each
 * folder for the bare name, then `which` with those folders before the
 * process PATH. The product's detection must do exactly this on darwin and
 * linux; the same test run against the old code passes too (the negative
 * witness is a mutant).
 */
function oldDetection(home: string, shellPath: string, processPath: string) {
  const commonPaths = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.grok/bin'),
    path.join(home, 'Library/pnpm'), path.join(home, '.yarn/bin')];
  for (const dir of shellPath.split(':')) if (dir && !commonPaths.includes(dir)) commonPaths.push(dir);
  const nvmDir = path.join(home, '.nvm/versions/node');
  if (fs.existsSync(nvmDir)) for (const v of fs.readdirSync(nvmDir)) commonPaths.push(path.join(nvmDir, v, 'bin'));
  const gcloudPaths = [...commonPaths, '/opt/homebrew/share/google-cloud-sdk/bin',
    '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin', path.join(home, 'google-cloud-sdk/bin')];
  const order: Array<[string, string, string[], string[]]> = [
    ['claude', 'claude', commonPaths, commonPaths], ['codex', 'codex', commonPaths, commonPaths],
    ['gemini', 'gemini', commonPaths, commonPaths], ['grok', 'grok', commonPaths, commonPaths],
    ['opencode', 'opencode', commonPaths, commonPaths], ['amp', 'amp', commonPaths, commonPaths],
    ['pi', 'pi', commonPaths, commonPaths], ['gws', 'gws', commonPaths, commonPaths],
    ['gcloud', 'gcloud', gcloudPaths, gcloudPaths], ['gh', 'gh', ['/opt/homebrew/bin', '/usr/local/bin'], commonPaths],
    ['node', 'node', commonPaths, commonPaths], ['qwencode', 'qwen', commonPaths, commonPaths],
    ['minimax', 'minimax', commonPaths, commonPaths],
  ];
  const result: Record<string, string> = { amp: '', claude: '', codex: '', gemini: '', grok: '', qwencode: '', opencode: '', pi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '' };
  const calls: Array<{ file: string; args: string[]; PATH?: string }> = [{ file: process.env.SHELL!, args: ['-ilc', 'echo $PATH'] }];
  for (const [key, bin, probe, whichDirs] of order) {
    const hit = probe.find((d) => fs.existsSync(path.join(d, bin)));
    if (hit) { result[key] = path.join(hit, bin); continue; }
    calls.push({ file: 'which', args: [bin], PATH: `${whichDirs.join(':')}:${processPath}` });
    if (whichAnswers[bin]?.trim()) result[key] = whichAnswers[bin].trim();
  }
  return { result, calls };
}

describe.each(['darwin', 'linux'] as const)('%s: detection and fullPath as before', (platform) => {
  it('the same result, the same folders, the same `which` questions, now as argv', async () => {
    unpin = pinPlatform(platform);
    setEnv({ SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' });
    fs.mkdirSync(path.join(tmpDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.local', 'bin', 'claude'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(tmpDir, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node'), '');
    fakeExisting = new Set([path.join('/usr/local/bin', 'gh'), path.join('/shell/b', 'codex')]);
    shellPathAnswer = '/shell/a:/shell/b:/usr/local/bin\n';
    whichAnswers = { gemini: '/elsewhere/gemini\n', qwen: '\n' };
    const expected = oldDetection(tmpDir, shellPathAnswer.trim(), '/usr/bin:/bin');
    await register();

    const result = await handlers.get('cliPaths:detect')!({}, { refresh: true });

    expect(result).toEqual(expected.result);
    expect(spawned).toEqual(expected.calls);
  });

  it('the fullPath bytes, an empty entry and an unset PATH included', async () => {
    unpin = pinPlatform(platform);
    fs.mkdirSync(path.join(tmpDir, '.nvm', 'versions', 'node', 'v20.0.0'), { recursive: true });
    const defaults = ['/opt/homebrew/bin', '/usr/local/bin', path.join(tmpDir, '.local/bin'), path.join(tmpDir, 'Library/pnpm'),
      path.join(tmpDir, '.yarn/bin'), path.join(tmpDir, '.nvm/versions/node', 'v20.0.0', 'bin')];
    const old = (extra: string[], envPath: string | undefined) => [...new Set([...extra, ...defaults, ...(envPath || '').split(':')])].join(':');
    const mod = await register();
    const file = path.join(tmpDir, '.dorothy', 'cli-paths.json');

    for (const envPath of ['/usr/bin:/bin::/opt/x', undefined]) {
      setEnv({ PATH: envPath });
      await handlers.get('cliPaths:save')!({}, { claude: '', additionalPaths: ['/custom/bin', '/usr/bin'] });
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).fullPath).toBe(old(['/custom/bin', '/usr/bin'], envPath));
    }
    fs.rmSync(file);
    setEnv({ PATH: '/usr/bin:/bin' });
    expect(mod.getCLIPathsConfig().fullPath).toBe(old([], '/usr/bin:/bin'));
  });
});
