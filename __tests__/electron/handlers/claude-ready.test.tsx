import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Settings > System says "Claude Code ready" only when there is a Claude Code to run.
 *
 * `settings:getInfo` started from `claudeVersion = 'Unknown'` and kept it when
 * `claude --version` failed, and the page reads any non-empty version as ready:
 * with no claude anywhere, the row said ready. What can go wrong, each case below:
 *
 * 1. claude is nowhere: the version must come back empty, so the page shows its
 *    existing "not installed" badge. The bug: 'Unknown', which reads as ready.
 * 2. claude is found but fails (exits non-zero): not ready either.
 * 3. claude runs and prints nothing: nothing says it is Claude Code, not ready.
 * 4. claude is where Tars looks for the CLIs it launches (the PATH buildFullPath
 *    builds, which the Providers page probes too) but not on Electron's own PATH,
 *    as for an app opened from the Finder: ready, with its version. A probe on
 *    Electron's PATH alone would call it missing, or, before this fix, 'Unknown'.
 * 5. claude runs: the version is what it printed, trimmed.
 * 7. claude is reachable only through Settings > CLI Paths, as its own path or
 *    as an extra folder: ready. Launches and the Providers page find it there,
 *    so a probe that looked only at the default PATH would say not installed
 *    beside a Providers page saying ready.
 * 6. The page: an empty version shows "not installed" and not "ready", and the
 *    row's description does not start with a stray separator.
 *
 * The process boundary is simulated, not the handler: `child_process` is
 * replaced by a model of an OS lookup: a bare `claude` is searched for on the
 * PATH it is given, a path is taken as it is, and the file found on the real
 * disk says what that claude prints and how it exits. The model answers the old shell form
 * (`execSync('claude --version 2>/dev/null')`, which searched Electron's PATH)
 * the same way, so this file runs against the code before the fix and turns red.
 * Since the version probe ends with the quit (core/version-probe.ts), the
 * probe is a `spawn`, which the model answers too, with a child that has no
 * pid: the probe's end signals a process group, and a made-up pid could name
 * a real one.
 */

type Fake = { stdout: string; code: number };

// The file a claude is on disk: Windows finds a program by its extension
// (platform/cli-binary.ts resolves claude to claude.exe or claude.cmd).
const CLAUDE_FILE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** The claude a spawn of `file` would run: a path as it is, a bare name on PATH. */
function lookup(file: string, pathValue: string | undefined): Fake | 'missing' {
  if (file !== 'claude') return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as Fake : 'missing';
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, CLAUDE_FILE);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as Fake;
  }
  return 'missing';
}

function failure(found: Fake | 'missing'): Error {
  if (found === 'missing') return Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  return Object.assign(new Error(`Command failed: claude --version`), { code: found.code, status: found.code });
}

const isClaudeVersion = (file: string, args: unknown) =>
  path.basename(file).replace(/\.(exe|cmd)$/i, '') === 'claude' && Array.isArray(args) && args.length === 1 && args[0] === '--version';

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();

  type Cb = (err: Error | null, stdout?: string, stderr?: string) => void;
  const execFile = ((file: string, args: unknown, opts: unknown, cb?: Cb) => {
    if (!isClaudeVersion(file, args)) return (real.execFile as (...a: unknown[]) => unknown)(file, args, opts, cb);
    const callback = (typeof opts === 'function' ? opts : cb) as Cb;
    const env = (typeof opts === 'object' && opts && (opts as { env?: NodeJS.ProcessEnv }).env) || process.env;
    const found = lookup(file, env.PATH ?? env.Path);
    setImmediate(() => {
      if (found === 'missing' || found.code !== 0) callback(failure(found));
      else callback(null, found.stdout, '');
    });
    return undefined;
  }) as unknown as typeof real.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: unknown, opts: unknown) =>
    new Promise((resolve, reject) => {
      execFile(file, args as string[], opts as object, ((err: Error | null, stdout?: string, stderr?: string) =>
        err ? reject(err) : resolve({ stdout, stderr })) as never);
    });

  const execSync = ((command: string, opts?: unknown) => {
    if (!/^claude --version\b/.test(command)) return (real.execSync as (...a: unknown[]) => unknown)(command, opts);
    const found = lookup('claude', process.env.PATH);
    if (found === 'missing' || found.code !== 0) throw failure(found);
    return found.stdout;
  }) as unknown as typeof real.execSync;

  const spawn = ((file: string, args: unknown, opts?: { env?: NodeJS.ProcessEnv }) => {
    if (!isClaudeVersion(file, args)) return (real.spawn as (...a: unknown[]) => unknown)(file, args, opts);
    const found = lookup(file, (opts?.env ?? process.env).PATH);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, kill: () => true });
    setImmediate(() => {
      if (found === 'missing') { child.emit('error', failure(found)); return; }
      if (found.stdout) child.stdout.emit('data', found.stdout);
      child.emit('close', found.code, null);
    });
    return child;
  }) as unknown as typeof real.spawn;

  return { ...real, execFile, execSync, spawn, default: { ...real, execFile, execSync, spawn } };
});

// The PATH Tars builds for the CLIs it launches: the folders it is handed
// first, as the real one puts them, then the machine's usual places.
const { cliPath } = vi.hoisted(() => ({ cliPath: { value: '' } }));
vi.mock('../../../electron/utils/path-builder', () => ({
  buildFullPath: (extraPaths: string[] = []) => [...extraPaths, cliPath.value].join(path.delimiter),
}));

/** Settings > CLI Paths, as the app settings hold them. */
let cliPaths: Record<string, unknown> = {};

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.9.1', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { SystemSection } from '../../../src/components/Settings/SystemSection';
import type { ClaudeInfo, AppSettings } from '../../../src/components/Settings/types';

function deps(): IpcHandlerDependencies {
  const fn = () => vi.fn() as never;
  return new Proxy({ getAppSettings: () => ({ cliPaths }) } as Record<string, unknown>, {
    get(target: Record<string, unknown>, key: string) {
      if (key in target) return target[key];
      const value = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : fn();
      target[key] = value;
      return value;
    },
  }) as IpcHandlerDependencies;
}

let root: string;
let emptyDir: string;
const savedPath = process.env.PATH;

/** A directory holding a `claude` that prints `stdout` and exits with `code`. */
function claudeIn(name: string, fake: Fake): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CLAUDE_FILE), JSON.stringify(fake));
  return dir;
}

async function getInfo(): Promise<ClaudeInfo> {
  const handler = handlers.get('settings:getInfo');
  if (!handler) throw new Error('settings:getInfo was never registered');
  return (await handler({})) as ClaudeInfo;
}

function page(info: ClaudeInfo): string {
  return renderToStaticMarkup(
    <SystemSection info={info} appSettings={{} as AppSettings} onSaveAppSettings={() => {}} />,
  );
}

/** The Claude Code row of the page, from its label to the next row's. */
function claudeRow(html: string): string {
  const start = html.indexOf('Claude Code');
  const end = html.indexOf('Data directory');
  expect(start, 'the page has no Claude Code row').toBeGreaterThan(-1);
  return html.slice(start, end);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-claude-ready-'));
  emptyDir = path.join(root, 'empty');
  fs.mkdirSync(emptyDir);
});

beforeEach(() => {
  handlers.clear();
  // Electron's own PATH, with no claude on it, in every case: only the PATH
  // Tars builds for its CLIs may find one.
  process.env.PATH = emptyDir;
  cliPath.value = emptyDir;
  cliPaths = {};
  registerIpcHandlers(deps());
});

afterAll(() => {
  process.env.PATH = savedPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('settings:getInfo', () => {
  it('1. says nothing about a version when claude is nowhere', async () => {
    const info = await getInfo();
    expect(info.claudeVersion).toBe('');
  });

  it('2. says nothing about a version when claude fails', async () => {
    cliPath.value = claudeIn('broken', { stdout: '', code: 1 });
    expect((await getInfo()).claudeVersion).toBe('');
  });

  it('3. says nothing about a version when claude prints nothing', async () => {
    cliPath.value = claudeIn('silent', { stdout: '\n', code: 0 });
    expect((await getInfo()).claudeVersion).toBe('');
  });

  it('4. finds claude where Tars finds the CLIs it launches, not only on its own PATH', async () => {
    cliPath.value = [emptyDir, claudeIn('local-bin', { stdout: '2.1.300 (Claude Code)\n', code: 0 })].join(path.delimiter);
    expect((await getInfo()).claudeVersion).toBe('2.1.300 (Claude Code)');
  });

  it('7. finds claude through its own path in Settings > CLI Paths', async () => {
    cliPaths = { claude: path.join(claudeIn('custom', { stdout: '2.1.303 (Claude Code)\n', code: 0 }), CLAUDE_FILE) };
    expect((await getInfo()).claudeVersion).toBe('2.1.303 (Claude Code)');
  });

  it('7. finds claude in a folder added in Settings > CLI Paths', async () => {
    cliPaths = { additionalPaths: [claudeIn('extra', { stdout: '2.1.304 (Claude Code)\n', code: 0 })] };
    expect((await getInfo()).claudeVersion).toBe('2.1.304 (Claude Code)');
  });

  it('5. hands back what claude printed, trimmed', async () => {
    cliPath.value = claudeIn('ok', { stdout: '  2.1.301 (Claude Code)  \n', code: 0 });
    expect((await getInfo()).claudeVersion).toBe('2.1.301 (Claude Code)');
  });
});

describe('Settings > System, from what settings:getInfo says', () => {
  it('6. reads not installed, and not ready, with no claude on the machine', async () => {
    const row = claudeRow(page(await getInfo()));
    expect(row).toContain('>not installed<');
    expect(row).not.toContain('>ready<');
    // The description is the settings path alone, not " · <path>".
    expect(row).not.toMatch(/>\s*·/);
  });

  it('6. reads ready, with the version, when claude is there', async () => {
    cliPath.value = claudeIn('ready', { stdout: '2.1.302 (Claude Code)\n', code: 0 });
    const row = claudeRow(page(await getInfo()));
    expect(row).toContain('>ready<');
    expect(row).toContain('2.1.302 (Claude Code) · ');
  });
});
