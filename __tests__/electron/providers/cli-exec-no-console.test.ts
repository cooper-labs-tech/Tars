import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { pinPlatform } from './win-fake-disk';

/**
 * A CLI Tars runs outside a terminal opens no console window on Windows.
 *
 * Tars is a GUI program: a console program it starts without windowsHide gets
 * a console window of its own, which flashes on the screen for every
 * `claude mcp add`, `claude mcp list` or `gws auth status`.
 *
 * How it fails, written before the code:
 * 1. win32: execCli or execCliSync starts the CLI without windowsHide.
 * 2. darwin/linux: execFile is not handed the caller's options as given, the
 *    same object, as it was before execCli existed. A synchronous call that
 *    names no time of its own gets the caller's options plus one
 *    (cli-probe-gaps.test.ts 5, 27/11): a CLI that hangs no longer freezes
 *    the main thread for good.
 */

const seen = vi.hoisted(() => [] as Array<{ fn: string; file: string; options: unknown }>);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, _args: string[], options: unknown) => {
      seen.push({ fn: 'execFileSync', file, options });
      return '';
    },
    execFile: (file: string, _args: string[], options: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      seen.push({ fn: 'execFile', file, options });
      cb(null, '', '');
    },
  };
});

let unpin: () => void = () => {};

beforeEach(() => {
  vi.resetModules();
  seen.length = 0;
});

afterEach(() => unpin());

describe('the console window of a CLI started outside a terminal', () => {
  it.runIf(process.platform === 'win32')('1. win32: execCliSync and execCli start it hidden', async () => {
    const { execCliSync, execCli } = await import('../../../electron/providers/cli-exec');

    execCliSync(process.execPath, ['-v'], { encoding: 'utf-8' });
    await execCli(process.execPath, ['-v'], { encoding: 'utf-8' });

    expect(seen.map(s => s.fn)).toEqual(['execFileSync', 'execFile']);
    for (const { options } of seen) expect(options).toMatchObject({ windowsHide: true, encoding: 'utf-8' });
  });

  it.each(['darwin', 'linux'] as const)('2. %s: the options as given, untouched', async (platform) => {
    unpin = pinPlatform(platform);
    const { execCliSync, execCli } = await import('../../../electron/providers/cli-exec');
    const sync = { encoding: 'utf-8' as const, stdio: 'pipe' as const, timeout: 7000 };
    const async = { encoding: 'utf-8' as const, timeout: 5000 };
    const untimed = { encoding: 'utf-8' as const, stdio: 'pipe' as const };

    execCliSync('claude', ['mcp', 'list'], sync);
    await execCli('claude', ['mcp', 'list'], async);
    execCliSync('claude', ['mcp', 'list'], untimed);

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ fn: 'execFileSync', file: 'claude' });
    expect(seen[0].options).toBe(sync);
    expect(seen[1]).toMatchObject({ fn: 'execFile', file: 'claude' });
    expect(seen[1].options).toBe(async);
    expect(seen[2].options).toMatchObject(untimed);
    expect((seen[2].options as { timeout?: unknown }).timeout).toBeGreaterThan(0);
  });
});
