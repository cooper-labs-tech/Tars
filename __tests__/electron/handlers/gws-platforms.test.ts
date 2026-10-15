import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { CMD_SHIM_NODE, GCLOUD_CMD, SH_SHIM, pinPlatform } from '../providers/win-fake-disk';

/**
 * Settings > Google Workspace: finding gws and gcloud, `gws auth status`, and
 * gws registered as an MCP server (audit B/C-05).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: `"${gwsPath}" auth status --json` is handed to cmd.exe, where a
 *    `"`, `&` or `%` in the path is shell. It must be execFile with the argv
 *    [auth, status, --json].
 * 2. win32: gws is an npm gws.cmd, found neither by existsSync(dir\gws), which
 *    matches the sh shim if anything, nor by `which` through cmd.exe.
 * 3. win32: gcloud is gcloud.cmd under %LOCALAPPDATA%\Google\Cloud SDK and is
 *    not found.
 * 4. win32: gcloud's folder is put in front of the PATH with `:`.
 * 5. win32: gws.cmd is registered as the MCP server's command, which the CLIs
 *    cannot start; it must be node.exe with the shim's script.
 * 6. darwin/linux: the folders probed, the `which` asked and the PATH handed
 *    to gws differ from before, or `auth status` is not the line /bin/sh has
 *    always run.
 * Found with 5 (ETHOS 8, the sibling in the same file), written before its fix:
 * 7. win32: the MCP status asks the providers for the .cmd, which setup no
 *    longer writes: "not configured" after every setup.
 */

let tmpDir: string;
let unpin: (() => void) | undefined;
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const shellLines: Array<{ cmd: string; PATH?: string }> = [];
const spawned: Array<{ file: string; args: string[]; PATH?: string }> = [];
let capture: ((file: string, args: string[]) => string | undefined) | null = null;
/** What a line handed to the shell answers; undefined: it fails. */
let captureLine: ((cmd: string) => string | undefined) | null = null;
let fakeExisting = new Set<string>();
const registered: unknown[][] = [];

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
    existsSync: (p: fs.PathLike) => (String(p).startsWith(tmpDir) ? mod.existsSync(p) : fakeExisting.has(String(p))),
  };
});

let fullPathAnswer = '/full/path';
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: () => fullPathAnswer }));

const askedRegistered: string[] = [];
vi.mock('../../../electron/providers', () => ({
  getAllProviders: () => [{
    id: 'claude',
    registerMcpServer: async (...a: unknown[]) => { registered.push(a); },
    removeMcpServer: async () => {},
    isMcpServerRegistered: (_name: string, expected: string) => { askedRegistered.push(expected); return false; },
    getInstalledSkills: () => [],
  }],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  type Cb = (e: Error | null, r?: { stdout: string; stderr: string }) => void;
  const recordOrRun = (file: string, args: string[], opts: { env?: Record<string, string> }, cb: Cb) => {
    spawned.push({ file, args, ...(opts?.env ? { PATH: opts.env.PATH } : {}) });
    const out = capture!(file, args);
    if (out === undefined) cb(new Error(`${file}: not found`));
    else cb(null, { stdout: out, stderr: '' });
  };
  // With no capture set, the real execFile, promisified the way node does it
  // ({ stdout, stderr }): the Windows tests start a real npm shim.
  const execFile = Object.assign(
    (file: string, args: string[], opts: { env?: Record<string, string> }, cb: Cb) => {
      if (capture) return recordOrRun(file, args, opts, cb);
      return actual.execFile(file, args, opts, (e, stdout, stderr) => cb(e, { stdout: String(stdout), stderr: String(stderr) }));
    },
    {
      [promisify.custom]: (file: string, args: string[], opts: { env?: Record<string, string> }) => (capture
        ? new Promise((resolve, reject) => recordOrRun(file, args, opts, (e, r) => (e ? reject(e) : resolve(r))))
        : promisify(actual.execFile)(file, args, { ...opts, encoding: 'utf-8' })),
    },
  );
  return {
    ...actual,
    exec: (cmd: string, opts: { env?: Record<string, string> }, cb: Cb) => {
      shellLines.push({ cmd, ...(opts?.env ? { PATH: opts.env.PATH } : {}) });
      const out = captureLine?.(cmd);
      if (out === undefined) cb(new Error(`${cmd}: no answer in this test`));
      else cb(null, { stdout: out, stderr: '' });
    },
    execFile,
  };
});

async function register() {
  const { registerGwsHandlers } = await import('../../../electron/handlers/gws-handlers');
  registerGwsHandlers({ getAppSettings: () => ({}) as never, setAppSettings: () => {}, saveAppSettings: () => {} });
}

const savedEnv = new Map<string, string | undefined>();
function setEnv(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
}

const AUTH = { user: 'demo@example.com', token_valid: true, has_refresh_token: true, auth_method: 'oauth2', scopes: ['https://www.googleapis.com/auth/drive'] };

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  shellLines.length = 0;
  spawned.length = 0;
  registered.length = 0;
  askedRegistered.length = 0;
  capture = null;
  captureLine = null;
  fullPathAnswer = '/full/path';
  fakeExisting = new Set();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gws-'));
});

afterEach(() => {
  unpin?.();
  unpin = undefined;
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── win32, on a real disk: gws.cmd from npm, gcloud.cmd from the Cloud SDK ──

describe.runIf(process.platform === 'win32')('win32 (real files; the lookup itself is tested on every host in cli-exec.test.ts)', () => {
  function installWindowsGws() {
    const home = path.join(tmpDir, 'Sam Lee');
    const appData = path.join(home, 'AppData', 'Roaming');
    const localAppData = path.join(home, 'AppData', 'Local');
    const npm = path.join(appData, 'npm');
    const script = path.join(npm, 'node_modules', '@googleworkspace', 'cli', 'bin', 'gws.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, [
      "const fs = require('fs');",
      'fs.appendFileSync(process.env.TARS_FAKE_CLI_LOG, JSON.stringify({ argv: process.argv.slice(2), path: process.env.PATH }) + "\\n");',
      `process.stdout.write(${JSON.stringify(JSON.stringify(AUTH))});`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(npm, 'gws.cmd'), CMD_SHIM_NODE('node_modules\\@googleworkspace\\cli\\bin\\gws.js'));
    fs.writeFileSync(path.join(npm, 'gws'), SH_SHIM);
    const sdk = path.join(localAppData, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin');
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(sdk, 'gcloud.cmd'), GCLOUD_CMD);
    fs.writeFileSync(path.join(sdk, 'gcloud'), SH_SHIM);
    const log = path.join(tmpDir, 'argv.jsonl');
    setEnv({
      USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, PATH: path.dirname(process.execPath),
      TARS_FAKE_CLI_LOG: log,
    });
    // What buildFullPath hands an agent there: node on it.
    fullPathAnswer = path.dirname(process.execPath);
    return { npm, script, sdk, log };
  }

  it('finds gws.cmd in %APPDATA%\\npm and gcloud.cmd in the Cloud SDK, with no shell', async () => {
    unpin = pinPlatform('win32');
    const { npm, sdk } = installWindowsGws();
    await register();

    expect(await handlers.get('gws:detect')!({})).toBe(path.join(npm, 'gws.cmd'));
    expect(await handlers.get('gws:detectGcloud')!({})).toBe(path.join(sdk, 'gcloud.cmd'));
    expect(shellLines).toEqual([]);
  });

  it('auth status runs the npm gws with its argv, gcloud first on a Windows PATH', async () => {
    unpin = pinPlatform('win32');
    const { sdk, log } = installWindowsGws();
    await register();

    const status = await handlers.get('gws:authStatus')!({}) as { authenticated: boolean; user: string };

    const [call] = fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(call.argv).toEqual(['auth', 'status', '--json']);
    expect(call.path.split(';')[0]).toBe(sdk);
    expect(status.authenticated).toBe(true);
    expect(status.user).toBe('demo@example.com');
    expect(shellLines).toEqual([]);
  });

  it('registers gws as `node` and its script, never the .cmd nor the path of today\'s node.exe', async () => {
    unpin = pinPlatform('win32');
    const { script } = installWindowsGws();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await register();

    await handlers.get('gws:setup')!({}, 'drive,gmail');

    expect(registered).toEqual([['google-workspace', 'node', [script, 'mcp', '-s', 'drive,gmail']]]);
  });

  it('the MCP status asks the providers for what setup wrote: the script, not the .cmd', async () => {
    unpin = pinPlatform('win32');
    const { script } = installWindowsGws();
    await register();

    await handlers.get('gws:getMcpStatus')!({});

    expect(askedRegistered).toEqual([script]);
  });
});

// ── darwin / linux ────────────────────────────────────────────────────────

describe.each(['darwin', 'linux'] as const)('%s: as before', (platform) => {
  it('the same folders and `which` questions for gws and gcloud', async () => {
    unpin = pinPlatform(platform);
    setEnv({ PATH: '/usr/bin:/bin' });
    captureLine = (cmd) => (cmd === 'which gcloud' ? '/sdk/bin/gcloud\n' : undefined);
    await register();

    expect(await handlers.get('gws:detect')!({})).toBe('');
    expect(await handlers.get('gws:detectGcloud')!({})).toBe('/sdk/bin/gcloud');

    const common = ['/opt/homebrew/bin', '/usr/local/bin', path.join(tmpDir, '.local/bin')];
    const gcloudDirs = [...common, '/opt/homebrew/share/google-cloud-sdk/bin',
      '/usr/local/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin', path.join(tmpDir, 'google-cloud-sdk/bin')];
    expect(shellLines).toEqual([
      { cmd: 'which gws', PATH: `${common.join(':')}:/usr/bin:/bin` },
      { cmd: 'which gcloud', PATH: `${gcloudDirs.join(':')}:/full/path` },
    ]);
    expect(spawned).toEqual([]);
  });

  it('auth status: the line /bin/sh has always run, the PATH as before', async () => {
    unpin = pinPlatform(platform);
    const nvmBin = path.join(tmpDir, '.nvm/versions/node', 'v 22 (x)', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });
    fs.writeFileSync(path.join(nvmBin, 'gws'), '#!/bin/sh\n');
    fakeExisting = new Set([path.join('/usr/local/bin', 'gcloud')]);
    captureLine = (cmd) => (cmd.endsWith(' auth status --json') ? JSON.stringify(AUTH) : undefined);
    await register();

    const status = await handlers.get('gws:authStatus')!({}) as { authenticated: boolean };

    const gwsPath = path.join(nvmBin, 'gws');
    expect(shellLines).toEqual([{ cmd: `"${gwsPath}" auth status --json`, PATH: `${path.dirname(path.join('/usr/local/bin', 'gcloud'))}:/full/path` }]);
    expect(spawned).toEqual([]);
    expect(status.authenticated).toBe(true);
  });

  it('registers gws with the path found, as before', async () => {
    unpin = pinPlatform(platform);
    fs.mkdirSync(path.join(tmpDir, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.local', 'bin', 'gws'), '#!/bin/sh\n');
    capture = () => undefined;
    await register();

    await handlers.get('gws:setup')!({});

    expect(registered).toEqual([['google-workspace', path.join(tmpDir, '.local', 'bin', 'gws'), ['mcp', '-s', 'drive,gmail,calendar,sheets,docs']]]);
  });
});
