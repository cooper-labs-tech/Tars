import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { npmCommand } from '../../scripts/npm-command.mjs';

/**
 * scripts/npm-command.mjs: how a script runs npm or npx with no shell, on
 * every platform. scope-checks.mjs (npm run e2e:auto) spawned the bare npx,
 * which on Windows is npx.cmd: ENOENT without a shell, and with
 * one every argument goes through cmd.exe (CVE-2024-27980).
 *
 * The ways it can fail, each pinned below:
 *  1. on macOS or Linux, anything but the bare `npm` / `npx` and the argv as
 *     given, which is what the scripts ran before and must keep running,
 *     whatever npm_execpath says;
 *  2. on Windows, the bare name, a .cmd shim, or anything that needs a shell;
 *  3. on Windows, npx run through npm-cli.js or npm through npx-cli.js;
 *  4. on Windows, trusting an npm_execpath that is not npm's (yarn, pnpm), or
 *     one whose entry points are not there;
 *  5. on Windows, finding nothing and returning a command anyway, which would
 *     fail later as ENOENT or run something else, instead of saying where it
 *     looked;
 *  6. the argv altered: reordered, joined or quoted;
 *  7. a tool other than npm or npx accepted;
 *  8. on this machine, a command that does not actually run npm and npx.
 */

const win = path.win32;
const NODE = 'C:\\nvm\\v22.23.3\\node.exe';
const BUNDLED = (entry: string) => win.join('C:\\nvm\\v22.23.3', 'node_modules', 'npm', 'bin', entry);
const RUNNING = (entry: string) => win.join('D:\\tools\\npm\\bin', entry);
const ARGV = ['run', 'electron:build', '--', 'a b', 'c&d', '"q"'];

function onWindows(env: Record<string, string | undefined>, present: string[]) {
  return (tool: 'npm' | 'npx') => npmCommand(tool, ARGV, {
    platform: 'win32',
    env,
    execPath: NODE,
    exists: (file: string) => present.includes(file),
  });
}

describe('npmCommand on macOS and Linux', () => {
  it.for(['darwin', 'linux'] as const)('spawns the bare name with the argv untouched on %s, whatever npm_execpath says', platform => {
    for (const tool of ['npm', 'npx'] as const) {
      const run = npmCommand(tool, ARGV, {
        platform,
        env: { npm_execpath: RUNNING('npm-cli.js') },
        execPath: '/usr/local/bin/node',
        exists: () => true,
      });
      expect(run).toEqual({ command: tool, args: ARGV });
    }
  });
});

describe('npmCommand on Windows', () => {
  it('runs the npm that started the script, through node, when npm_execpath names it', () => {
    const resolve = onWindows({ npm_execpath: RUNNING('npm-cli.js') }, [RUNNING('npm-cli.js'), RUNNING('npx-cli.js'), BUNDLED('npm-cli.js')]);

    expect(resolve('npm')).toEqual({ command: NODE, args: [RUNNING('npm-cli.js'), ...ARGV] });
    expect(resolve('npx')).toEqual({ command: NODE, args: [RUNNING('npx-cli.js'), ...ARGV] });
  });

  it('reads npm_execpath when npx set it too', () => {
    const resolve = onWindows({ npm_execpath: RUNNING('npx-cli.js') }, [RUNNING('npm-cli.js'), RUNNING('npx-cli.js')]);

    expect(resolve('npm').args[0]).toBe(RUNNING('npm-cli.js'));
    expect(resolve('npx').args[0]).toBe(RUNNING('npx-cli.js'));
  });

  it.for([
    ['no npm_execpath', undefined],
    ['yarn', 'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\yarn\\bin\\yarn.js'],
    ['pnpm', 'C:\\Users\\x\\AppData\\Local\\pnpm\\pnpm.cjs'],
    ['an npm that is gone', RUNNING('npm-cli.js')],
  ] as const)('falls back to the npm beside node with %s', ([, execpath]) => {
    const resolve = onWindows({ npm_execpath: execpath }, [BUNDLED('npm-cli.js'), BUNDLED('npx-cli.js')]);

    expect(resolve('npm')).toEqual({ command: NODE, args: [BUNDLED('npm-cli.js'), ...ARGV] });
    expect(resolve('npx')).toEqual({ command: NODE, args: [BUNDLED('npx-cli.js'), ...ARGV] });
  });

  it('throws, naming every place it looked, when there is no npm to run', () => {
    const resolve = onWindows({ npm_execpath: RUNNING('npm-cli.js') }, []);

    expect(() => resolve('npx')).toThrow(`cannot find npx-cli.js to run npx without a shell: looked at ${RUNNING('npx-cli.js')} and ${BUNDLED('npx-cli.js')}`);
  });

  it('never returns a shim or a bare name', () => {
    const resolve = onWindows({}, [BUNDLED('npm-cli.js'), BUNDLED('npx-cli.js')]);

    for (const tool of ['npm', 'npx'] as const) {
      const { command, args } = resolve(tool);
      expect(command).toBe(NODE);
      expect(args[0]).toMatch(/-cli\.js$/);
    }
  });
});

it('refuses a tool other than npm or npx', () => {
  expect(() => npmCommand('yarn' as 'npm', [])).toThrow('npmCommand runs npm or npx, not yarn');
});

// The real npm and npx, started cold: a loaded windows-latest runner took more
// than vitest's 5 s for `npm --version`.
describe('on this machine', { timeout: 30_000 }, () => {
  it.for(['npm', 'npx'] as const)('runs %s with no shell', tool => {
    const { command, args } = npmCommand(tool, ['--version']);
    const run = spawnSync(command, args, { encoding: 'utf8', shell: false });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.runIf(process.platform === 'win32')('is needed here: the bare name the scripts spawned is not found', () => {
    // The witness for Windows: what scope-checks.mjs did before.
    expect(spawnSync('npm', ['--version']).error).toMatchObject({ code: 'ENOENT' });
  });
});
