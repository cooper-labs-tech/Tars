import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NODE_DIST_NPX, SH_SHIM, pinPlatform } from '../providers/win-fake-disk';

/**
 * Settings > Tasmania > set up: the command written into every CLI's MCP
 * config for the user's Tasmania server (found at win-reviewer's gate,
 * 2026-09-25, the sibling of the orchestrator's bundled servers).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: a .ts server is written as `npx tsx <path>`: npx is npx.cmd, which
 *    no CLI's spawn can start (ENOENT for the bare name, EINVAL for the .cmd).
 *    It must be `node <npx-cli.js> tsx <path>`, with bare `node`.
 * 2. win32: an npx that cannot be found is written anyway and nothing is said:
 *    it must be kept as given and logged with the reason.
 * 3. darwin/linux: anything but `npx tsx <path>` for .ts and `node <path>`
 *    for .js, as before.
 */

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${(process.env.TEMP || process.env.TMPDIR || '/tmp').replace(/[\\/]$/, '')}${process.platform === 'win32' ? '\\' : '/'}tars-tasmania-setup-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.9', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

const registered: Array<[string, string, string[]]> = [];
vi.mock('../../../electron/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/providers')>()),
  getAllProviders: () => [{
    id: 'claude',
    registerMcpServer: async (name: string, command: string, args: string[]) => { registered.push([name, command, args]); },
  }],
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import type { AppSettings } from '../../../electron/types';

let settings: Partial<AppSettings> = {};
let unpin: (() => void) | undefined;
const savedPath = process.env.PATH;

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { getAppSettings: () => settings as AppSettings };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

function serverFile(name: string) {
  const file = path.join(tmpHome, 'tasmania (x)', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

beforeEach(() => {
  handlers.clear();
  registered.length = 0;
  fs.mkdirSync(tmpHome, { recursive: true });
  registerIpcHandlers(deps());
});

afterEach(() => {
  unpin?.();
  unpin = undefined;
  process.env.PATH = savedPath;
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.each(['darwin', 'linux'] as const)('%s: as before', (platform) => {
  it('npx tsx for a .ts server, node for a .js one', async () => {
    unpin = pinPlatform(platform);
    const ts = serverFile('index.ts');
    const js = serverFile('index.js');

    settings = { tasmaniaServerPath: ts };
    expect(await handlers.get('tasmania:setup')!({})).toEqual({ success: true });
    settings = { tasmaniaServerPath: js };
    expect(await handlers.get('tasmania:setup')!({})).toEqual({ success: true });

    expect(registered).toEqual([['tasmania', 'npx', ['tsx', ts]], ['tasmania', 'node', [js]]]);
  });
});

describe.runIf(process.platform === 'win32')('win32 (real npx.cmd on disk)', () => {
  it('a .ts server is `node <npx-cli.js> tsx <path>`, never npx.cmd', async () => {
    unpin = pinPlatform('win32');
    const nodeDir = path.join(tmpHome, 'node dist');
    const npxCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    fs.mkdirSync(path.dirname(npxCli), { recursive: true });
    fs.writeFileSync(npxCli, '');
    fs.writeFileSync(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-prefix.js'), '');
    fs.writeFileSync(path.join(nodeDir, 'npx.cmd'), NODE_DIST_NPX);
    fs.writeFileSync(path.join(nodeDir, 'npx'), SH_SHIM);
    process.env.PATH = [nodeDir, path.dirname(process.execPath)].join(';');
    const ts = serverFile('index.ts');
    settings = { tasmaniaServerPath: ts };

    expect(await handlers.get('tasmania:setup')!({})).toEqual({ success: true });

    expect(registered).toEqual([['tasmania', 'node', [npxCli, 'tsx', ts]]]);
  });

  it('no npx anywhere: kept as given, and said', async () => {
    unpin = pinPlatform('win32');
    process.env.PATH = path.join(tmpHome, 'empty');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ts = serverFile('index.ts');
    settings = { tasmaniaServerPath: ts };

    expect(await handlers.get('tasmania:setup')!({})).toEqual({ success: true });

    expect(registered).toEqual([['tasmania', 'npx', ['tsx', ts]]]);
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/tasmania.*npx.*not-found/);
  });
});
