import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { pinPlatform } from './providers/win-fake-disk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { hasPosixModes } from '../setup/platform-limits';

/**
 * The files Tars shares with other programs are never seen half-written.
 *
 * `~/.claude.json` is read and rewritten by every live Claude Code, Claude's
 * `settings.json` is read by every claude binary, `~/.claude/mcp.json` by every
 * Claude session Tars starts, through --mcp-config. All three were rewritten in
 * place, so a reader that opened one mid-write got a truncated JSON document.
 * (`kanban-tasks.json` was a fourth, written whole by Tars and by mcp-kanban,
 * until #171 sent the tools to the Hermes board and the old local board went,
 * 06/10: nothing writes it now.)
 *
 * Every case runs the real writer and cuts into its writeFileSync: halfway
 * through, a reader parses the file, or the process dies. HOME is the
 * throwaway one the suite runs in. That no other code writes these files
 * directly is claude-files-writers.test.ts's to hold.
 */

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.7.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

// The claude binary never runs here. `claude mcp add` and `claude mcp remove`
// fail, as they do when the CLI is missing, so the provider takes its mcp.json
// path, which is the one under test. The mock knows the CLI by the bare name
// it is started with, which is what darwin/linux pass; on win32 the name is
// resolved to a real file first (a claude.exe the PATH may well hold), so the
// suites that reach the CLI run as linux: see cliAsGiven below.
const { claudeRuns, claudeOptions } = vi.hoisted(() => ({ claudeRuns: [] as string[][], claudeOptions: [] as unknown[] }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, ...rest: unknown[]) => {
      if (file === 'claude') {
        claudeRuns.push(rest[0] as string[]);
        throw new Error('claude: command not found');
      }
      return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    },
    // The orchestrator setup runs `claude mcp ...` asynchronously, with an argv.
    execFile: (file: string, args: unknown, ...rest: unknown[]) => {
      if (file === 'claude') {
        claudeRuns.push(args as string[]);
        claudeOptions.push(rest.find(r => typeof r === 'object'));
        const done = rest.find(r => typeof r === 'function') as ((err: Error) => void) | undefined;
        setImmediate(() => done?.(new Error('claude: command not found')));
        return {};
      }
      return (actual.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
    },
  };
});

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { ensureProjectTrusted } from '../../electron/core/agent-manager';
import { registerIpcHandlers, type IpcHandlerDependencies } from '../../electron/handlers/ipc-handlers';
import { registerMcpConfigHandlers } from '../../electron/handlers/mcp-config-handlers';
import { ClaudeProvider } from '../../electron/providers/claude-provider';
import { getAllProviders } from '../../electron/providers';
import { setupMemoryBackends, setupOrchestratorSetupHandler, setupOrchestratorRemoveHandler } from '../../electron/services/mcp-orchestrator';
import { enableStatusLine, disableStatusLine } from '../../electron/utils/statusline';
import { nodeHookCommand } from '../../electron/utils/hook-command';
import { KANBAN_FILE, dataPath } from '../../electron/constants';
import type { AppSettings } from '../../electron/types';
import { cannotSymlink } from '../setup/symlink-privilege';

const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const home = () => os.homedir();
const claudeJson = () => path.join(home(), '.claude.json');
const claudeSettings = () => path.join(home(), '.claude', 'settings.json');

/** Whether `file` is under `dir`, by the path given or the real one: temp dirs are /var here and /private/var once resolved. */
function under(dir: string, file: string): boolean {
  return file.startsWith(dir) || file.startsWith(fs.realpathSync(dir));
}

/**
 * Cuts into every write under `dir`: writes the first half, runs `midway` with
 * the path being written, then dies there or finishes. Returns the undo.
 */
function cutWrites(dir: string, midway: (file: string) => void, { die = false } = {}): () => void {
  const original = nodeFs.writeFileSync;
  nodeFs.writeFileSync = function (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) {
    if (typeof file === 'string' && under(dir, file) && typeof data === 'string') {
      original.call(nodeFs, file, data.slice(0, Math.floor(data.length / 2)), options);
      midway(file);
      if (die) throw new Error('the process died here');
      // The rest of that same write. Its file exists now, so a write that
      // creates exclusively ('wx', as writeAtomicSync does since lot 4) goes on
      // into it, as one write would, instead of failing to create it twice.
      const rest = options && typeof options === 'object' && options.flag === 'wx' ? { ...options, flag: 'w' } : options;
      return original.call(nodeFs, file, data, rest);
    }
    return original.call(nodeFs, file, data, options);
  } as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  return () => {
    nodeFs.writeFileSync = original;
    syncBuiltinESMExports();
  };
}

/** What a reader gets from the file right now: its JSON, or the reason it has none. */
function readAsJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
}

/** Every write and rename that reaches a file under `dir`, while `during` runs. */
async function writesUnder(dir: string, during: () => unknown): Promise<string[]> {
  const seen: string[] = [];
  const originalWrite = nodeFs.writeFileSync;
  const originalRename = nodeFs.renameSync;
  nodeFs.writeFileSync = function (...args: Parameters<typeof fs.writeFileSync>) {
    if (under(dir, String(args[0]))) seen.push(`write ${args[0]}`);
    return originalWrite.apply(nodeFs, args);
  } as typeof fs.writeFileSync;
  nodeFs.renameSync = function (...args: Parameters<typeof fs.renameSync>) {
    if (under(dir, String(args[1]))) seen.push(`rename to ${args[1]}`);
    return originalRename.apply(nodeFs, args);
  } as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    await during();
  } finally {
    nodeFs.writeFileSync = originalWrite;
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  return seen;
}

const leftovers = (dir: string) => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));

function deps(): IpcHandlerDependencies {
  return new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (!(key in target)) target[key] = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

/** A settings file the way it is kept: ten keys, Tars's hooks among them. */
const fullSettings = {
  includeCoAuthoredBy: true,
  permissions: { allow: ['Bash(npm run test:*)'], defaultMode: 'acceptEdits' },
  model: 'opus',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: '/Applications/Tars.app/hooks/on-stop.sh', timeout: 30 }] }] },
  enabledPlugins: { 'vercel@marketplace': true },
  extraKnownMarketplaces: { marketplace: { source: { source: 'github', repo: 'x/y' } } },
  tui: { theme: 'dark' },
  skipDangerousModePermissionPrompt: true,
  theme: 'dark',
  env: { SOME_TOKEN: 'example' },
};

/** An mcp.json with a server someone added by hand, token included, beside one of Tars's. */
const mcpServersNow = {
  mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_example' } },
    tasmania: { command: 'node', args: ['/work/tasmania/dist/index.js'] },
  },
};
const mcpJson = () => path.join(home(), '.claude', 'mcp.json');
function writeMcpJson(contents: unknown = mcpServersNow): void {
  fs.mkdirSync(path.dirname(mcpJson()), { recursive: true });
  fs.writeFileSync(mcpJson(), typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

/**
 * For a suite that makes the product start `claude`: process.platform reads
 * linux, so the name reaches the mock above as given and nothing is resolved
 * on the disk. On a Windows host the resolver would otherwise find the
 * machine's own claude.exe and run it. How win32 starts the CLI is proven
 * against a recording npm shim in providers/mcp-registration-cli.test.ts.
 */
function cliAsGiven() {
  let unpin: () => void = () => {};
  beforeEach(() => { unpin = pinPlatform('linux'); });
  afterEach(() => unpin());
}

beforeEach(() => {
  fs.rmSync(claudeJson(), { force: true });
  fs.rmSync(path.join(home(), '.claude'), { recursive: true, force: true });
  fs.rmSync(path.dirname(KANBAN_FILE), { recursive: true, force: true });
});

describe('~/.claude.json, through ensureProjectTrusted', () => {
  /** A config the way Claude Code keeps it: an account, some projects, 0600. */
  function claudeConfig() {
    const config = {
      numStartups: 41,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/work/project-${i}`, { hasTrustDialogAccepted: true, history: ['x'.repeat(200)] }])),
    };
    fs.writeFileSync(claudeJson(), JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(claudeJson(), 0o600);
    return config;
  }

  it('leaves the previous file whole when the write dies halfway', () => {
    const before = claudeConfig();
    const undo = cutWrites(home(), () => {}, { die: true });
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(readAsJson(claudeJson())).toEqual(before);
    expect(leftovers(home())).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', () => {
    claudeConfig();
    const seenMidway: unknown[] = [];
    const undo = cutWrites(home(), () => seenMidway.push(readAsJson(claudeJson())));
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toMatchObject({ numStartups: 41 });
    expect(readAsJson(claudeJson())).toMatchObject({ projects: { '/work/new-project': { hasTrustDialogAccepted: true } } });
  });

  it('writes nothing when the project is already trusted', async () => {
    claudeConfig();
    const before = fs.statSync(claudeJson());

    const writes = await writesUnder(home(), () => ensureProjectTrusted('/work/project-3'));

    expect(writes).toEqual([]);
    expect(fs.statSync(claudeJson()).mtimeMs).toBe(before.mtimeMs);
  });

  it.skipIf(!hasPosixModes())('keeps the file readable by its owner only', () => {
    claudeConfig();

    ensureProjectTrusted('/work/new-project');

    expect(fs.statSync(claudeJson()).mode & 0o777).toBe(0o600);
  });

  it('keeps a change Claude made between the read and the rename', () => {
    claudeConfig();
    let claudeWrote = false;
    const undo = cutWrites(home(), file => {
      if (claudeWrote || file === claudeJson() || file === fs.realpathSync(claudeJson())) return;
      claudeWrote = true;
      // Claude Code saving its own counter while Tars prepares its file.
      const current = JSON.parse(fs.readFileSync(claudeJson(), 'utf-8'));
      fs.writeFileSync(`${claudeJson()}.claude`, JSON.stringify({ ...current, numStartups: 42 }, null, 2), { mode: 0o600 });
      fs.renameSync(`${claudeJson()}.claude`, claudeJson());
    });
    try {
      ensureProjectTrusted('/work/new-project');
    } finally {
      undo();
    }

    expect(claudeWrote).toBe(true);
    expect(readAsJson(claudeJson())).toMatchObject({
      numStartups: 42,
      projects: { '/work/new-project': { hasTrustDialogAccepted: true } },
    });
  });

  it.skipIf(cannotSymlink())('updates the file a link points at, and leaves the link a link', () => {
    const dotfiles = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dotfiles-'));
    fs.writeFileSync(path.join(dotfiles, 'claude.json'), JSON.stringify({ projects: {} }), { mode: 0o600 });
    fs.symlinkSync(path.join(dotfiles, 'claude.json'), claudeJson());

    ensureProjectTrusted('/work/new-project');

    expect(fs.lstatSync(claudeJson()).isSymbolicLink()).toBe(true);
    expect(readAsJson(path.join(dotfiles, 'claude.json'))).toMatchObject({ projects: { '/work/new-project': { hasTrustDialogAccepted: true } } });
  });

  it('leaves a file that is not JSON exactly as it is', () => {
    fs.writeFileSync(claudeJson(), '{"projects": {"/work/a": ', { mode: 0o600 });

    ensureProjectTrusted('/work/new-project');

    expect(fs.readFileSync(claudeJson(), 'utf-8')).toBe('{"projects": {"/work/a": ');
  });
});

describe("Claude's settings.json, through settings:save", () => {
  const save = (settings: Record<string, unknown>) => handlers.get('settings:save')!({}, settings) as Promise<{ success: boolean }>;
  const settingsNow = { env: { A: '1' }, hooks: { Stop: [{ command: 'on-stop.sh' }] }, permissions: { allow: ['Bash(git:*)'], deny: [] } };

  beforeEach(() => {
    handlers.clear();
    registerIpcHandlers(deps());
    fs.mkdirSync(path.dirname(claudeSettings()), { recursive: true });
    fs.writeFileSync(claudeSettings(), JSON.stringify(settingsNow, null, 2));
  });

  it('leaves the previous file whole when the write dies halfway', async () => {
    const undo = cutWrites(path.dirname(claudeSettings()), () => {}, { die: true });
    try {
      await save({ env: { A: '2' } });
    } finally {
      undo();
    }

    expect(readAsJson(claudeSettings())).toEqual(settingsNow);
    expect(leftovers(path.dirname(claudeSettings()))).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(claudeSettings()), () => seenMidway.push(readAsJson(claudeSettings())));
    try {
      expect(await save({ env: { A: '2' } })).toMatchObject({ success: true });
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(settingsNow);
    expect(readAsJson(claudeSettings())).toMatchObject({ env: { A: '2' }, hooks: settingsNow.hooks });
  });

  it('writes nothing when the save changes nothing', async () => {
    const writes = await writesUnder(path.dirname(claudeSettings()), () =>
      save({ env: { A: '1' }, permissions: { allow: ['Bash(git:*)'], deny: [] } }));

    expect(writes).toEqual([]);
  });
});

describe("Claude's settings.json, through the hooks Tars installs at every launch", () => {
  const HOOKS_DIR = path.join(__dirname, '../../hooks');
  /** Settings someone keeps: their own keys, and no hooks yet. */
  const settingsNow = { env: { A: '1' }, permissions: { allow: ['Bash(git:*)'], deny: [] }, statusLine: { type: 'command', command: 'statusline.sh' } };
  const configureHooks = () => new ClaudeProvider().configureHooks(HOOKS_DIR);
  const stopHook = () => (readAsJson(claudeSettings()) as { hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> } }).hooks?.Stop?.[0]?.hooks?.[0]?.command;
  /** What the Stop entry runs: the .sh on darwin and linux, the Node runner on win32 (hook-command.ts). */
  const OUR_STOP = process.platform === 'win32'
    ? nodeHookCommand(path.join(HOOKS_DIR, 'tars-hook.mjs'), 'on-stop')
    : path.join(HOOKS_DIR, 'on-stop.sh');

  beforeEach(() => {
    fs.mkdirSync(path.dirname(claudeSettings()), { recursive: true });
    fs.writeFileSync(claudeSettings(), JSON.stringify(settingsNow, null, 2));
  });

  it('adds the hooks beside the settings already there', async () => {
    await configureHooks();

    expect(readAsJson(claudeSettings())).toMatchObject(settingsNow);
    expect(stopHook()).toBe(OUR_STOP);
  });

  it('leaves the previous file whole when the write dies halfway', async () => {
    const undo = cutWrites(path.dirname(claudeSettings()), () => {}, { die: true });
    try {
      await expect(configureHooks()).rejects.toThrow('the process died here');
    } finally {
      undo();
    }

    expect(readAsJson(claudeSettings())).toEqual(settingsNow);
    expect(leftovers(path.dirname(claudeSettings()))).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(claudeSettings()), () => seenMidway.push(readAsJson(claudeSettings())));
    try {
      await configureHooks();
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(settingsNow);
    expect(stopHook()).toBe(OUR_STOP);
  });

  it('writes nothing when every hook is already there', async () => {
    await configureHooks();

    const writes = await writesUnder(path.dirname(claudeSettings()), () => configureHooks());

    expect(writes).toEqual([]);
  });

  it("keeps the file's own mode", async () => {
    fs.chmodSync(claudeSettings(), 0o600);

    await configureHooks();

    expect(stopHook()).toBe(OUR_STOP);
    if (hasPosixModes()) expect(fs.statSync(claudeSettings()).mode & 0o777).toBe(0o600);
  });

  it('keeps a change Claude made between the read and the rename', async () => {
    let claudeWrote = false;
    const undo = cutWrites(path.dirname(claudeSettings()), file => {
      if (claudeWrote || file === claudeSettings() || file === fs.realpathSync(claudeSettings())) return;
      claudeWrote = true;
      // Claude Code saving a setting while Tars prepares its file.
      const current = JSON.parse(fs.readFileSync(claudeSettings(), 'utf-8'));
      fs.writeFileSync(`${claudeSettings()}.claude`, JSON.stringify({ ...current, model: 'opus' }, null, 2));
      fs.renameSync(`${claudeSettings()}.claude`, claudeSettings());
    });
    try {
      await configureHooks();
    } finally {
      undo();
    }

    expect(claudeWrote).toBe(true);
    expect(readAsJson(claudeSettings())).toMatchObject({ ...settingsNow, model: 'opus' });
    expect(stopHook()).toBe(OUR_STOP);
  });

  it('leaves a file that is not JSON exactly as it is, instead of the hooks alone', async () => {
    // What a reader gets from a file Claude Code is halfway through writing.
    fs.writeFileSync(claudeSettings(), '{"env": {"A": "1"}, "permissions": ');

    await configureHooks();

    expect(fs.readFileSync(claudeSettings(), 'utf-8')).toBe('{"env": {"A": "1"}, "permissions": ');
  });
});

describe('~/.claude/mcp.json, when `claude mcp add` or `claude mcp remove` has failed', () => {
  cliAsGiven();
  const mcpJson = () => path.join(home(), '.claude', 'mcp.json');
  /** A server someone added by hand, with its token, beside one of Tars's. */
  const servers = {
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_example' } },
      tasmania: { command: 'node', args: ['/work/tasmania/dist/index.js'] },
    },
  };
  const gws = { command: '/opt/homebrew/bin/gws', args: ['mcp', '-s', 'drive'] };
  const register = () => new ClaudeProvider().registerMcpServer('google-workspace', gws.command, gws.args);
  const remove = () => new ClaudeProvider().removeMcpServer('tasmania');

  beforeEach(() => {
    claudeRuns.length = 0;
    fs.mkdirSync(path.dirname(mcpJson()), { recursive: true });
    fs.writeFileSync(mcpJson(), JSON.stringify(servers, null, 2));
  });

  it('registers beside the servers already there', async () => {
    await register();

    // Since 2.0.5 claude registers into this file itself, and runs no CLI for a server not in its user scope (services/mcp-roles.ts).
    expect(claudeRuns).toEqual([]);
    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { ...servers.mcpServers, 'google-workspace': gws } });
  });

  it('leaves the previous file whole when a registration dies halfway', async () => {
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      await expect(register()).rejects.toThrow('the process died here');
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(servers);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });

  it('never shows a session starting a partial file while it registers', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(mcpJson()), () => seenMidway.push(readAsJson(mcpJson())));
    try {
      await register();
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(servers);
    expect(readAsJson(mcpJson())).toMatchObject({ mcpServers: { 'google-workspace': gws } });
  });

  it('writes nothing when the server is registered as asked already', async () => {
    await register();

    const writes = await writesUnder(path.dirname(mcpJson()), () => register());

    expect(writes).toEqual([]);
  });

  it.skipIf(!hasPosixModes())("keeps the file's own mode, and creates a new one readable by its owner only", async () => {
    fs.chmodSync(mcpJson(), 0o644);
    await register();
    expect(fs.statSync(mcpJson()).mode & 0o777).toBe(0o644);

    // It can carry a server's token, as the one above does.
    fs.rmSync(mcpJson());
    await register();
    expect(fs.statSync(mcpJson()).mode & 0o777).toBe(0o600);
  });

  it('refuses to register into a file that is not JSON, and leaves it as it is', async () => {
    fs.writeFileSync(mcpJson(), '{"mcpServers": {"github": ');

    await expect(register()).rejects.toThrow('not valid JSON');

    expect(fs.readFileSync(mcpJson(), 'utf-8')).toBe('{"mcpServers": {"github": ');
  });

  it('removes a server and keeps the others', async () => {
    await remove();

    expect(claudeRuns).toEqual([['mcp', 'remove', '-s', 'user', 'tasmania']]);
    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { github: servers.mcpServers.github } });
  });

  it('leaves the previous file whole when a removal dies halfway', async () => {
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      await remove();
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(servers);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });

  it('never shows a session starting a partial file while it removes', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(mcpJson()), () => seenMidway.push(readAsJson(mcpJson())));
    try {
      await remove();
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(servers);
    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { github: servers.mcpServers.github } });
  });

  it('creates nothing when there is no file to remove from', async () => {
    fs.rmSync(mcpJson());

    const writes = await writesUnder(path.dirname(mcpJson()), () => remove());

    expect(writes).toEqual([]);
    expect(fs.existsSync(mcpJson())).toBe(false);
  });
});

describe("Claude's settings.json, through the status line Tars turns on at every launch", () => {
  const settingsDir = () => path.dirname(claudeSettings());
  const statusLine = () => (readAsJson(claudeSettings()) as { statusLine?: { command?: string } }).statusLine;
  /**
   * The command Tars's status line runs: its bash script in the data folder on
   * darwin and linux, the bundled statusline.mjs through Node on win32.
   * The bundled hooks folder is where the electron mock above
   * puts the app, this checkout.
   */
  const OUR_STATUS_LINE = process.platform === 'win32'
    ? nodeHookCommand(path.join(process.cwd(), 'hooks', 'statusline.mjs'))
    : dataPath('statusline.sh');
  const withoutStatusLine = () => {
    const rest = { ...(readAsJson(claudeSettings()) as Record<string, unknown>) };
    delete rest.statusLine;
    return rest;
  };

  beforeEach(() => {
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(claudeSettings(), JSON.stringify(fullSettings, null, 2));
  });

  it('changes statusLine and nothing else in a whole settings file', () => {
    enableStatusLine();

    expect(statusLine()?.command).toBe(OUR_STATUS_LINE);
    expect(withoutStatusLine()).toEqual(fullSettings);
  });

  it('writes nothing at the next launch', async () => {
    enableStatusLine();

    const writes = await writesUnder(settingsDir(), () => enableStatusLine());

    expect(writes).toEqual([]);
  });

  it('never shows a reader a partial file while it writes', () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(settingsDir(), () => seenMidway.push(readAsJson(claudeSettings())));
    try {
      enableStatusLine();
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(fullSettings);
    expect(statusLine()?.command).toBe(OUR_STATUS_LINE);
  });

  it('leaves the previous file whole when the write dies halfway', () => {
    const undo = cutWrites(settingsDir(), () => {}, { die: true });
    try {
      expect(() => enableStatusLine()).toThrow('the process died here');
    } finally {
      undo();
    }

    expect(readAsJson(claudeSettings())).toEqual(fullSettings);
    expect(leftovers(settingsDir())).toEqual([]);
  });

  it('leaves a file that is not JSON exactly as it is, turning it on or off', () => {
    // What a reader gets from a file Claude Code is halfway through writing.
    fs.writeFileSync(claudeSettings(), '{"model": "opus", "permissions": ');

    enableStatusLine();
    disableStatusLine();

    expect(fs.readFileSync(claudeSettings(), 'utf-8')).toBe('{"model": "opus", "permissions": ');
  });

  it('turning it off removes the entry without a reader ever seeing half a file', () => {
    enableStatusLine();
    const before = readAsJson(claudeSettings());
    const seenMidway: unknown[] = [];
    const undo = cutWrites(settingsDir(), () => seenMidway.push(readAsJson(claudeSettings())));
    try {
      disableStatusLine();
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(before);
    expect(readAsJson(claudeSettings())).toEqual(fullSettings);
  });
});

describe('~/.claude.json, through the memory backends Tars registers at launch', () => {
  const honcho = {
    memoryHonchoEnabled: true,
    memoryHonchoMcpUrl: 'https://honcho.example/mcp',
    memoryHonchoApiKey: 'hk_example',
  } as unknown as AppSettings;
  const config = {
    numStartups: 41,
    oauthAccount: { emailAddress: 'someone@example.com' },
    projects: { '/work/a': { hasTrustDialogAccepted: true } },
    mcpServers: { github: { type: 'stdio', command: 'npx' } },
  };

  beforeEach(() => {
    fs.writeFileSync(claudeJson(), JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(claudeJson(), 0o600);
  });

  it('adds the backend beside everything else, and keeps the file readable by its owner only', () => {
    setupMemoryBackends(honcho);

    expect(readAsJson(claudeJson())).toEqual({
      ...config,
      mcpServers: { ...config.mcpServers, honcho: { type: 'http', url: 'https://honcho.example/mcp', headers: { Authorization: 'Bearer hk_example' } } },
    });
    if (hasPosixModes()) expect(fs.statSync(claudeJson()).mode & 0o777).toBe(0o600);
  });

  it('never shows a reader a partial file while it writes', () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(home(), file => {
      if (file.includes('.claude.json')) seenMidway.push(readAsJson(claudeJson()));
    });
    try {
      setupMemoryBackends(honcho);
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(config);
  });

  it('leaves the previous file whole when the write dies halfway', () => {
    const undo = cutWrites(home(), () => {}, { die: true });
    try {
      setupMemoryBackends(honcho);
    } finally {
      undo();
    }

    expect(readAsJson(claudeJson())).toEqual(config);
    expect(leftovers(home())).toEqual([]);
  });

  it('keeps a change Claude made between the read and the rename', () => {
    let claudeWrote = false;
    const undo = cutWrites(home(), file => {
      if (claudeWrote || !file.includes('.claude.json') || file === claudeJson() || file === fs.realpathSync(claudeJson())) return;
      claudeWrote = true;
      const current = JSON.parse(fs.readFileSync(claudeJson(), 'utf-8'));
      fs.writeFileSync(`${claudeJson()}.claude`, JSON.stringify({ ...current, numStartups: 42 }, null, 2), { mode: 0o600 });
      fs.renameSync(`${claudeJson()}.claude`, claudeJson());
    });
    try {
      setupMemoryBackends(honcho);
    } finally {
      undo();
    }

    expect(claudeWrote).toBe(true);
    expect(readAsJson(claudeJson())).toMatchObject({ numStartups: 42, mcpServers: { honcho: { url: 'https://honcho.example/mcp' } } });
  });
});

describe('~/.claude/mcp.json, from every provider whose configDir is ~/.claude', () => {
  cliAsGiven();
  // Found by the directory they write into, not listed: Claude and the
  // providers that run its binary.
  const family = getAllProviders().filter(p => p.configDir === path.join(os.homedir(), '.claude'));
  const gws = { command: '/opt/homebrew/bin/gws', args: ['mcp', '-s', 'drive'] };

  beforeEach(() => writeMcpJson());

  it('is the fourteen that run the claude binary, so the cases below cover each', () => {
    expect(family.length).toBeGreaterThanOrEqual(14);
    expect(family.map(p => p.id)).toContain('claude');
  });

  it.each(family.map(p => [p.id, p] as const))('%s registers beside the servers already there', async (_id, provider) => {
    await provider.registerMcpServer('google-workspace', gws.command, gws.args);

    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { ...mcpServersNow.mcpServers, 'google-workspace': gws } });
  });

  it.each(family.map(p => [p.id, p] as const))('%s refuses to register into a file that is not JSON, and leaves it as it is', async (_id, provider) => {
    writeMcpJson('{"mcpServers": {"github": ');

    await expect(provider.registerMcpServer('google-workspace', gws.command, gws.args)).rejects.toThrow('not valid JSON');

    expect(fs.readFileSync(mcpJson(), 'utf-8')).toBe('{"mcpServers": {"github": ');
  });

  it.each(family.map(p => [p.id, p] as const))('%s leaves the previous file whole when its write dies halfway', async (_id, provider) => {
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      await expect(provider.registerMcpServer('google-workspace', gws.command, gws.args)).rejects.toThrow('the process died here');
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(mcpServersNow);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });

  it.each(family.map(p => [p.id, p] as const))('%s removes one server and keeps the others', async (_id, provider) => {
    await provider.removeMcpServer('tasmania');

    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { github: mcpServersNow.mcpServers.github } });
  });

  it.each(family.map(p => [p.id, p] as const))('%s leaves the previous file whole when a removal dies halfway', async (_id, provider) => {
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      await provider.removeMcpServer('tasmania').catch(() => {});
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(mcpServersNow);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });
});

describe('~/.claude/mcp.json, from the MCP settings page', () => {
  const update = (provider: string) => handlers.get('mcp:update')!({}, {
    provider, name: 'linear', command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_KEY: 'lin_example' },
  }) as Promise<{ success: boolean; error?: string }>;
  const remove = (provider: string) => handlers.get('mcp:delete')!({}, { provider, name: 'tasmania' }) as Promise<{ success: boolean; error?: string }>;
  const linear = { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_KEY: 'lin_example' } };

  beforeEach(() => {
    handlers.clear();
    registerMcpConfigHandlers();
    writeMcpJson();
  });

  it.each(['claude', 'minimax'])('saves a server for %s beside the others', async (provider) => {
    expect(await update(provider)).toMatchObject({ success: true });

    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { ...mcpServersNow.mcpServers, linear } });
  });

  it('never shows a reader a partial file while it saves', async () => {
    const seenMidway: unknown[] = [];
    const undo = cutWrites(path.dirname(mcpJson()), () => seenMidway.push(readAsJson(mcpJson())));
    try {
      expect(await update('claude')).toMatchObject({ success: true });
    } finally {
      undo();
    }

    expect(seenMidway.length, 'the write was not cut into, so this proves nothing').toBeGreaterThan(0);
    for (const seen of seenMidway) expect(seen).toEqual(mcpServersNow);
  });

  it('refuses a file that is not JSON and leaves it as it is', async () => {
    writeMcpJson('{"mcpServers": {"github": ');

    const result = await update('claude');

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('not valid JSON');
    expect(fs.readFileSync(mcpJson(), 'utf-8')).toBe('{"mcpServers": {"github": ');
  });

  it('deletes one server and keeps the others', async () => {
    expect(await remove('claude')).toMatchObject({ success: true });

    expect(readAsJson(mcpJson())).toEqual({ mcpServers: { github: mcpServersNow.mcpServers.github } });
  });

  it('leaves the previous file whole when a deletion dies halfway', async () => {
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      expect(await remove('claude')).toMatchObject({ success: false });
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(mcpServersNow);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });
});

describe('~/.claude/mcp.json, from the orchestrator setup when `claude mcp add` fails', () => {
  cliAsGiven();
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-resources-'));
  const bundle = path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js');
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  let resourcesPathBefore: string | undefined;
  const setup = () => handlers.get('orchestrator:setup')!({}) as Promise<{ success: boolean; error?: string; method?: string }>;

  beforeAll(() => {
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, '');
    resourcesPathBefore = processWithResources.resourcesPath;
    processWithResources.resourcesPath = resources;
  });
  afterAll(() => {
    processWithResources.resourcesPath = resourcesPathBefore;
  });

  beforeEach(() => {
    handlers.clear();
    claudeRuns.length = 0;
    setupOrchestratorSetupHandler();
    setupOrchestratorRemoveHandler();
    writeMcpJson();
  });

  it('registers beside the servers already there', async () => {
    expect(await setup()).toMatchObject({ success: true, method: 'mcp-json-fallback' });

    // An argv: the path is an argument of its own, never inside a shell string.
    // What mcpNodeCommand names (mcp-server-runtime.test.ts): this is not a
    // packaged Tars and no launcher was written, so `node`.
    const launcher = 'node';
    expect(claudeRuns).toContainEqual(['mcp', 'add', '-s', 'user', 'claude-mgr-orchestrator', launcher, bundle]);
    // Bounded for good: the default SIGTERM leaves a child that ignores it
    // running, and the setup waiting on it (the gate of #128).
    expect(claudeOptions.at(-1)).toMatchObject({ timeout: 15_000, killSignal: 'SIGKILL' });
    expect(readAsJson(mcpJson())).toEqual({
      mcpServers: { ...mcpServersNow.mcpServers, 'claude-mgr-orchestrator': { command: launcher, args: [bundle] } },
    });
  });

  it('refuses a file that is not JSON and leaves it as it is', async () => {
    writeMcpJson('{"mcpServers": {"github": ');

    const result = await setup();

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('not valid JSON');
    expect(fs.readFileSync(mcpJson(), 'utf-8')).toBe('{"mcpServers": {"github": ');
  });

  it('removes only its own entry', async () => {
    await setup();

    expect(await handlers.get('orchestrator:remove')!({})).toMatchObject({ success: true });

    expect(readAsJson(mcpJson())).toEqual(mcpServersNow);
  });

  it('leaves the previous file whole when the removal dies halfway', async () => {
    await setup();
    const before = readAsJson(mcpJson());
    const undo = cutWrites(path.dirname(mcpJson()), () => {}, { die: true });
    try {
      await handlers.get('orchestrator:remove')!({});
    } finally {
      undo();
    }

    expect(readAsJson(mcpJson())).toEqual(before);
    expect(leftovers(path.dirname(mcpJson()))).toEqual([]);
  });
});

describe("fs:write-text-file and Claude's own files", () => {
  const writeText = (filePath: string, content: string) =>
    handlers.get('fs:write-text-file')!({}, { filePath, content }) as Promise<{ success: boolean; error?: string }>;

  beforeEach(() => {
    handlers.clear();
    registerIpcHandlers(deps());
    fs.mkdirSync(path.join(home(), '.claude'), { recursive: true });
    fs.writeFileSync(claudeSettings(), JSON.stringify(fullSettings, null, 2));
    writeMcpJson();
  });

  it.each(['settings.json', 'mcp.json'])('refuses ~/.claude/%s and leaves it as it is', async (name) => {
    const file = path.join(home(), '.claude', name);
    const before = fs.readFileSync(file, 'utf-8');

    const result = await writeText(`~/.claude/${name}`, '{"half": ');

    expect(result).toMatchObject({ success: false });
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it.skipIf(cannotSymlink())('refuses them through a link too', async () => {
    fs.symlinkSync(claudeSettings(), path.join(home(), '.claude', 'CLAUDE.md'));
    const before = fs.readFileSync(claudeSettings(), 'utf-8');

    expect(await writeText('~/.claude/CLAUDE.md', 'notes')).toMatchObject({ success: false });

    expect(fs.readFileSync(claudeSettings(), 'utf-8')).toBe(before);
  });

  it('still writes the instruction files it is there for', async () => {
    expect(await writeText('~/.claude/CLAUDE.md', '# Notes\n')).toMatchObject({ success: true });

    expect(fs.readFileSync(path.join(home(), '.claude', 'CLAUDE.md'), 'utf-8')).toBe('# Notes\n');
  });
});
