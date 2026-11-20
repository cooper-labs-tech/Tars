import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as realOs from 'os';
import * as path from 'path';

/**
 * Saving the Settings page must not delete what the page never had.
 *
 * `useSettings` fetches `~/.claude/settings.json` once when the page mounts and
 * sends that whole snapshot back on save. The window is created early in
 * startup and Tars writes the CLI hooks later in the same startup, so a page
 * opened in between holds `hooks: {}` for as long as it stays open, and the
 * save it makes minutes later used to write that empty block over the real
 * one. Measured at eight hook types before and none after, with `permissions`,
 * `enabledPlugins` and `includeCoAuthoredBy` going the same way. One file
 * serves the fourteen providers that run the claude binary, so every agent
 * lost its status reporting at once until Tars was next launched.
 *
 * Everything here runs against a temp HOME. The real file is read once, to
 * check the fixture below still has the shape of the thing being protected,
 * and is never written: forty agents are using it.
 */

// Named before the mocks, which vitest hoists above everything else in this
// file: a path built from a `const` up here would not exist yet when the mock
// factory runs. Nothing touches the disk until beforeEach.
const { tmpHome } = vi.hoisted(() => ({
  tmpHome: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `tars-settings-${process.pid}-${Date.now()}`),
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
    getVersion: () => '1.7.0', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
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

const SETTINGS_PATH = path.join(tmpHome, '.claude', 'settings.json');

/** Every dependency is a stub: none of them is on the settings path. */
function deps(): IpcHandlerDependencies {
  const fn = () => vi.fn() as never;
  return new Proxy({}, {
    get(target: Record<string, unknown>, key: string) {
      if (key in target) return target[key];
      const value = key.endsWith('ptyProcesses') || key === 'agents' ? new Map() : fn();
      target[key] = value;
      return value;
    },
  }) as IpcHandlerDependencies;
}

/**
 * The eight hook types the real file carries, with the shape Claude Code
 * writes: a matcher and the command Tars points it at. Written out here rather
 * than copied off disk so this runs anywhere, and checked against the real
 * file by the case at the bottom.
 */
const HOOK_TYPES = [
  'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd',
  'Notification', 'PermissionRequest', 'TaskCompleted', 'UserPromptSubmit',
];

function realShapedSettings(): Record<string, unknown> {
  return {
    includeCoAuthoredBy: true,
    permissions: { allow: ['Bash(npm run test:*)'], defaultMode: 'acceptEdits' },
    model: 'opus',
    hooks: Object.fromEntries(HOOK_TYPES.map(type => [
      type,
      [{ matcher: '', hooks: [{ type: 'command', command: `~/.claude/hooks/${type}.sh` }] }],
    ])),
    enabledPlugins: { 'vercel@marketplace': true, 'sentry@marketplace': true, 'paper@marketplace': true },
    extraKnownMarketplaces: { marketplace: { source: { source: 'github', repo: 'x/y' } } },
    tui: { theme: 'dark' },
    skipDangerousModePermissionPrompt: true,
    theme: 'dark',
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
  };
}

/**
 * What `settings:get` hands a page that mounted before Tars had written the
 * file, verbatim from the handler's own fallback, which is what that page then
 * sends back on save.
 */
const STALE_SNAPSHOT = {
  enabledPlugins: {},
  env: {},
  hooks: {},
  includeCoAuthoredBy: false,
  permissions: { allow: [], deny: [] },
};

function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
}

async function save(payload: Record<string, unknown>): Promise<unknown> {
  const handler = handlers.get('settings:save');
  if (!handler) throw new Error('settings:save was never registered');
  return handler({}, payload);
}

beforeEach(() => {
  handlers.clear();
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(realShapedSettings(), null, 2));
  registerIpcHandlers(deps());
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('a Settings page that opened before Tars had written the file', () => {
  it('cannot delete the eight hook types with the snapshot it is holding', async () => {
    await save(STALE_SNAPSHOT);

    const after = onDisk();
    expect(Object.keys(after.hooks as object).sort()).toEqual([...HOOK_TYPES].sort());
    // Not just the names: the commands are what the CLIs actually run, and an
    // empty array per type would keep the key and lose the hook.
    for (const type of HOOK_TYPES) {
      expect(JSON.stringify(after.hooks)).toContain(`${type}.sh`);
    }
  });

  it('cannot empty the plugins the CLI enabled, which that page cannot edit either', async () => {
    await save(STALE_SNAPSHOT);

    expect(after('enabledPlugins')).toEqual(realShapedSettings().enabledPlugins);
  });

  it('cannot empty the permissions it is holding two empty lists for', async () => {
    await save(STALE_SNAPSHOT);

    // The empty form of `permissions` is not an empty object: it is
    // `{allow: [], deny: []}`, which is what the page sends and what a guard
    // written only against `{}` would have let through.
    expect(after('permissions')).toEqual(realShapedSettings().permissions);
  });

  it('leaves the six keys it never mentions exactly as they were', async () => {
    const before = realShapedSettings();

    await save(STALE_SNAPSHOT);

    for (const key of ['model', 'extraKnownMarketplaces', 'tui', 'skipDangerousModePermissionPrompt', 'theme', 'statusLine']) {
      expect(after(key), key).toEqual(before[key]);
    }
  });

  it('cannot empty an env block the file is holding', async () => {
    // The real file has no `env`, so the fixture above has none either and
    // this guard was never reached by any case here: removing it left the
    // whole file green. Found by removing it, which is the only way that kind
    // of hole shows. A machine that has set one is the case it protects.
    const withEnv = { ...realShapedSettings(), env: { ANTHROPIC_MODEL: 'claude-opus-5', FOO: 'bar' } };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(withEnv, null, 2));

    await save(STALE_SNAPSHOT);

    expect(onDisk().env).toEqual(withEnv.env);
  });

  function after(key: string): unknown {
    return onDisk()[key];
  }
});

describe('a real edit still lands, which is the other half of this', () => {
  it('writes a permissions list the page actually filled in', async () => {
    const chosen = { allow: ['Bash(git status)', 'Read(**)'], deny: ['Bash(rm *)'] };

    await save({ ...STALE_SNAPSHOT, permissions: chosen });

    expect(onDisk().permissions).toEqual(chosen);
    // And the keys the payload carried nothing for are still not lost.
    expect(Object.keys(onDisk().hooks as object)).toHaveLength(8);
  });

  it('writes an env block the page actually filled in', async () => {
    const chosen = { ANTHROPIC_MODEL: 'claude-opus-5' };

    await save({ ...STALE_SNAPSHOT, env: chosen });

    expect(onDisk().env).toEqual(chosen);
  });

  it('empties env on purpose when the file had nothing there either', async () => {
    // The guard only holds when the file has something to protect. With no env
    // in the file, an empty env in the payload is written as sent: preserving
    // here would mean an empty value could never be saved at all.
    await save(STALE_SNAPSHOT);

    expect(onDisk().env).toEqual({});
  });

  it('turns includeCoAuthoredBy off, which is left unprotected on purpose', async () => {
    // Deliberate, and documented in the handler: it is a boolean the page does
    // edit, and a stale `false` cannot be told from a chosen one. The page
    // sending a delta instead of a snapshot is what closes it, and that is the
    // Settings page's half. Pinned so nobody reads the gap as an oversight.
    await save(STALE_SNAPSHOT);

    expect(onDisk().includeCoAuthoredBy).toBe(false);
  });
});

describe('the file this protects', () => {
  it('still has the shape the fixture claims, read from the real one', () => {
    // Not `os.homedir()`: this file mocks it, so that would read the fixture
    // back and assert nothing. The live path has to come from somewhere the
    // mock does not reach. Skipped where there is no such file, which is a
    // machine that has never run Claude Code.
    const real = path.join(process.env.HOME || '', '.claude', 'settings.json');
    if (!process.env.HOME || !fs.existsSync(real)) return;

    // Read only, never written: this is the live file. If Claude Code changes
    // how it stores hooks, the fixture above stops representing it and this is
    // where that shows.
    const parsed = JSON.parse(fs.readFileSync(real, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(['hooks', 'enabledPlugins', 'permissions']));
    expect(Object.keys(parsed.hooks as object).length).toBeGreaterThanOrEqual(1);
  });
});
