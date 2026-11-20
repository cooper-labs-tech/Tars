import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from '../providers/win-fake-disk';

// ── Mocks ────────────────────────────────────────────────────────────────────

let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
let tmpDir: string;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

const shellCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
    cb(null, { stdout: '' });
  }),
  // The login shell that reads the user's PATH, and `which`, now an argv too.
  execFile: vi.fn((file: string, args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
    if (file !== 'which') shellCalls.push({ file, args });
    cb(null, { stdout: '' });
  }),
}));

// The login shell is a CLI probe since 20/11 (core/cli-probe.ts, the Audit's P3 on probe orphans): recorded and
// answered here as its execFile was, and no shell is started.
vi.mock('../../../electron/core/cli-probe', () => ({
  probeCli: vi.fn(async (file: string, args: string[]) => {
    shellCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  }),
}));

vi.mock('util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('util')>();
  return {
    ...mod,
    promisify: vi.fn((fn: unknown) => {
      return async (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          (fn as (...a: unknown[]) => void)(...args, (err: Error | null, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };
    }),
  };
});

function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for "${channel}"`);
  return fn({}, ...args);
}

// ── Setup ────────────────────────────────────────────────────────────────────

let mockSettings: Record<string, unknown>;
let unpin: () => void;

beforeEach(() => {
  vi.resetModules();
  // Everything below is the darwin/linux detection: a login shell, `which`,
  // extensionless binaries. Windows has its own, in cli-paths-platforms.test.ts.
  unpin = pinPlatform('darwin');
  handlers = new Map();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-paths-test-'));
  fs.mkdirSync(path.join(tmpDir, '.tars'), { recursive: true });

  mockSettings = {};
  shellCalls.length = 0;
});

afterEach(() => {
  unpin();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cli-paths-handlers', () => {
  async function registerHandlers() {
    const { registerCLIPathsHandlers } = await import('../../../electron/handlers/cli-paths-handlers');
    registerCLIPathsHandlers({
      getAppSettings: () => mockSettings as any,
      setAppSettings: (s: unknown) => { mockSettings = s as Record<string, unknown>; },
      saveAppSettings: vi.fn(),
    });
  }

  it('registers all 3 handlers', async () => {
    await registerHandlers();
    expect(handlers.has('cliPaths:detect')).toBe(true);
    expect(handlers.has('cliPaths:get')).toBe(true);
    expect(handlers.has('cliPaths:save')).toBe(true);
  });

  describe('cliPaths:detect', () => {
    it('returns path object with claude, gh, node', async () => {
      await registerHandlers();
      const result = await invokeHandler('cliPaths:detect') as Record<string, string>;

      expect(result).toHaveProperty('claude');
      expect(result).toHaveProperty('gh');
      expect(result).toHaveProperty('node');
    });

    it('finds claude at known path in home dir', async () => {
      // Create a fake claude binary at ~/.local/bin
      const binDir = path.join(tmpDir, '.local', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/bash');

      await registerHandlers();
      const result = await invokeHandler('cliPaths:detect') as { claude: string };

      // Should find claude somewhere (may be system path or our fake)
      expect(result.claude).toBeTruthy();
    });

    // Every Settings section and every "+ Agent" and "+ Team" dialog asked,
    // and each call started a login shell: 114 to 762 ms (the Audit, 2026-09-23).
    it('starts one login shell per app run, however many surfaces ask, at once or later', async () => {
      await registerHandlers();

      const [a, b] = await Promise.all([invokeHandler('cliPaths:detect'), invokeHandler('cliPaths:detect')]);
      const c = await invokeHandler('cliPaths:detect');

      expect(shellCalls).toHaveLength(1);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    it('runs the shell as a file with its script as an argument, never a command line', async () => {
      process.env.SHELL = '/bin/zsh; touch /tmp/owned';
      try {
        await registerHandlers();
        await invokeHandler('cliPaths:detect');
      } finally {
        delete process.env.SHELL;
      }

      expect(shellCalls[0]).toEqual({ file: '/bin/zsh; touch /tmp/owned', args: ['-ilc', 'echo $PATH'] });
    });

    it('looks again when asked (the Detect button), and when the saved paths change', async () => {
      await registerHandlers();
      await invokeHandler('cliPaths:detect');

      await invokeHandler('cliPaths:detect', { refresh: true });
      expect(shellCalls).toHaveLength(2);

      await invokeHandler('cliPaths:save', { claude: path.join(tmpDir, 'claude') });
      await invokeHandler('cliPaths:detect');
      expect(shellCalls).toHaveLength(3);

      await invokeHandler('cliPaths:detect');
      expect(shellCalls).toHaveLength(3);
    });

    it('answers a refresh with what is on disk now', async () => {
      await registerHandlers();
      const before = await invokeHandler('cliPaths:detect') as { claude: string };
      const binDir = path.join(tmpDir, 'saved');
      fs.mkdirSync(binDir, { recursive: true });
      const saved = path.join(binDir, 'claude');
      mockSettings = { cliPaths: { claude: saved } };
      await invokeHandler('cliPaths:detect');
      // Saved but not there yet: the detection keeps what it found.
      fs.writeFileSync(saved, '#!/bin/sh\n', { mode: 0o755 });

      const cached = await invokeHandler('cliPaths:detect') as { claude: string };
      const fresh = await invokeHandler('cliPaths:detect', { refresh: true }) as { claude: string };

      expect(cached.claude).toBe(before.claude);
      expect(fresh.claude).toBe(saved);
    });
  });

  describe('cliPaths:get', () => {
    it('returns default empty paths when no settings', async () => {
      await registerHandlers();
      const result = await invokeHandler('cliPaths:get') as Record<string, unknown>;

      expect(result.claude).toBe('');
      expect(result.gh).toBe('');
      expect(result.node).toBe('');
      expect(result.additionalPaths).toEqual([]);
    });

    it('returns saved paths from settings', async () => {
      mockSettings = {
        cliPaths: {
          claude: '/usr/local/bin/claude',
          gh: '/usr/local/bin/gh',
          node: '/usr/local/bin/node',
          additionalPaths: ['/custom/bin'],
        },
      };

      await registerHandlers();
      const result = await invokeHandler('cliPaths:get') as Record<string, unknown>;

      expect(result.claude).toBe('/usr/local/bin/claude');
      expect(result.additionalPaths).toEqual(['/custom/bin']);
    });
  });

  describe('cliPaths:save', () => {
    it('saves paths to settings and config file', async () => {
      await registerHandlers();

      const paths = {
        claude: '/opt/homebrew/bin/claude',
        gh: '/opt/homebrew/bin/gh',
        node: '/opt/homebrew/bin/node',
        additionalPaths: ['/custom/bin'],
      };

      const result = await invokeHandler('cliPaths:save', paths) as { success: boolean };

      expect(result.success).toBe(true);
      expect(mockSettings.cliPaths).toEqual(paths);

      // Verify config file was written
      const configPath = path.join(tmpDir, '.tars', 'cli-paths.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(saved.claude).toBe('/opt/homebrew/bin/claude');
      expect(saved.fullPath).toBeDefined();
    });

    it('returns error on failure', async () => {
      await registerHandlers();

      // Force settings to throw
      const deps = {
        getAppSettings: () => { throw new Error('Settings broken'); },
        setAppSettings: vi.fn(),
        saveAppSettings: vi.fn(),
      };

      // Re-register with broken deps
      const { registerCLIPathsHandlers } = await import('../../../electron/handlers/cli-paths-handlers');
      registerCLIPathsHandlers(deps as any);

      const result = await invokeHandler('cliPaths:save', {
        claude: '',
        gh: '',
        node: '',
        additionalPaths: [],
      }) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Settings broken');
    });
  });
});

// ── Exported utility function tests ─────────────────────────────────────────

describe('getCLIPathsConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const { getCLIPathsConfig } = await import('../../../electron/handlers/cli-paths-handlers');
    const config = getCLIPathsConfig();

    expect(config.claude).toBe('');
    expect(config.gh).toBe('');
    expect(config.node).toBe('');
    expect(config.fullPath).toBeDefined();
    expect(typeof config.fullPath).toBe('string');
  });

  it('reads from config file when present', async () => {
    const configPath = path.join(tmpDir, '.tars', 'cli-paths.json');
    fs.writeFileSync(configPath, JSON.stringify({
      claude: '/usr/local/bin/claude',
      gh: '/usr/local/bin/gh',
      node: '/usr/local/bin/node',
      additionalPaths: [],
      fullPath: '/usr/local/bin',
      updatedAt: '2026-01-01',
    }));

    const { getCLIPathsConfig } = await import('../../../electron/handlers/cli-paths-handlers');
    const config = getCLIPathsConfig();

    expect(config.claude).toBe('/usr/local/bin/claude');
    expect(config.fullPath).toBe('/usr/local/bin');
  });
});

describe('getFullPath', () => {
  it('returns a non-empty path string', async () => {
    const { getFullPath } = await import('../../../electron/handlers/cli-paths-handlers');
    const fullPath = getFullPath();

    expect(typeof fullPath).toBe('string');
    expect(fullPath.length).toBeGreaterThan(0);
  });
});
