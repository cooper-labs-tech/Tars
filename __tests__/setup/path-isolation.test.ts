import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { findOnPath, guardPath, pathWithoutHomes } from './path-guard';

/**
 * No CLI installed in a home is on the PATH a test runs with.
 *
 * Measured on 2026-11-27: twice in one day a unit test reached the owner's real
 * Hermes, found on PATH in ~/.local/bin, and started it in the throwaway home;
 * home-isolation.ts refused its unlink into ~/.hermes/tools both times. The
 * 20/11 incident, the owner's ~/.codex/config.toml, was the same class: a CLI
 * launched by its bare name, from the PATH of the terminal the suite runs in.
 * The chat's line in a real terminal, the version probe and codex's probes
 * launch one the same way. So the folders of the homes leave PATH before any
 * test file, and the suite's own tools come back by their resolved paths.
 *
 * How it can fail, written before path-guard.ts and path-isolation.ts:
 * 1. A folder under the account's home (os.userInfo().homedir, which no
 *    variable moves) stays on PATH: ~/.local/bin, ~/bin, ~/.cargo/bin,
 *    ~/.bun/bin, ~/.volta/bin, ~/go/bin, ~/.npm-global/bin, every
 *    ~/.nvm/versions/node/<v>/bin; a bare `hermes`, `codex`, `claude` or
 *    `gemini` installed there then starts the owner's own CLI.
 * 2. A folder under the HOME the run started with stays, when that HOME is not
 *    the account's (a sandbox HOME, a runner's).
 * 3. On Windows, a folder under the profile stays (USERPROFILE, APPDATA,
 *    LOCALAPPDATA: %APPDATA%\npm, %LOCALAPPDATA%\Programs), or one written in
 *    another case.
 * 4. A folder that reaches a home without spelling it stays: through a symlink,
 *    a `..`, a trailing or a doubled separator, or in another case on a
 *    filesystem that ignores case (macOS).
 * 5. A relative or empty entry stays: '' and '.' are the current folder, the
 *    repository, which lies under the home, and so is `node_modules/.bin`.
 * 6. A home that is a filesystem root, or empty (a container with no account
 *    home), takes every folder with it, and the suite can start nothing.
 * 7. The suite's own tools stop resolving: node, npm and npx, which sit under
 *    ~/.nvm on a developer's machine, and git.
 * 8. `node` resolves to another node than the one running vitest (a
 *    /usr/local/bin/node of another version), once the folders that held the
 *    right one first are gone.
 * 9. The folder node is kept by brings back what was installed globally with
 *    that node: `npm i -g @openai/codex` puts codex beside it.
 * 10. The guard runs after the test file's imports, so a module that reads PATH
 *     at load sees the old one.
 * 11. What the guard did outlives the file, or cannot be undone exactly.
 * 12. The opt-in that starts a real claude (TARS_REAL_CLAUDE=1, or a path) can
 *     no longer find it, or brings back the whole folder it sits in; or a
 *     value that is neither throws.
 * 13. What lies outside every home does not stay as it was, in its order:
 *     /usr/bin, /bin, /opt/homebrew/bin, C:\Windows\System32. bash, ps, jq,
 *     python3 and git live there.
 */

const FIXTURES = '__tests__/setup/fixtures/tmpdir-guard';
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
const onWindows = process.platform === 'win32';
const caseless = process.platform === 'darwin' || onWindows;
/** The PATH as this file's imports read it, before any test ran (10). */
const PATH_AT_IMPORT = process.env.PATH ?? '';
const record = (globalThis as typeof globalThis & { [key: symbol]: { homes: string[] } | undefined })[Symbol.for('tars.test.pathGuard')];

const posix = (value: string, homes: string[], cwd = '/srv/work') =>
  pathWithoutHomes({ value, homes, cwd, platform: 'linux', canonical: p => p });
const windows = (value: string, homes: string[], cwd = 'D:\\work') =>
  pathWithoutHomes({ value, homes, cwd, platform: 'win32', canonical: p => p });

function executable(file: string, body = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

describe('the folders that leave PATH', () => {
  it('1, 2. every folder under the account home and under the HOME the run started with', () => {
    const value = ['/home/a/.local/bin', '/usr/bin', '/home/a/.nvm/versions/node/v22.0.0/bin', '/home/a/bin',
      '/home/a/.cargo/bin', '/runner/home/.bun/bin', '/bin'].join(':');
    const { kept, removed } = posix(value, ['/home/a', '/runner/home']);
    expect(kept).toEqual(['/usr/bin', '/bin']);
    expect(removed).toEqual(['/home/a/.local/bin', '/home/a/.nvm/versions/node/v22.0.0/bin', '/home/a/bin', '/home/a/.cargo/bin', '/runner/home/.bun/bin']);
  });

  it('1. a folder beside the home, whose name only starts like it, stays', () => {
    expect(posix('/home/ab/bin:/home/a-tools/bin', ['/home/a']).kept).toEqual(['/home/ab/bin', '/home/a-tools/bin']);
  });

  it('3. on Windows, every folder under the profile, in any case, and only those', () => {
    const value = ['C:\\Windows\\System32', 'C:\\Users\\a\\AppData\\Roaming\\npm', 'c:\\users\\A\\.cargo\\bin',
      'C:\\Program Files\\Git\\cmd', 'C:\\Users\\a\\AppData\\Local\\Programs\\Hermes'].join(';');
    const { kept, removed } = windows(value, ['C:\\Users\\a', 'C:\\Users\\a\\AppData\\Roaming', 'C:\\Users\\a\\AppData\\Local']);
    expect(kept).toEqual(['C:\\Windows\\System32', 'C:\\Program Files\\Git\\cmd']);
    expect(removed).toHaveLength(3);
  });

  it('4. a folder that reaches the home through a symlink, a .., a trailing or doubled separator, or another case', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
    const home = path.join(base, 'Home');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const link = path.join(base, 'outside');
    fs.symlinkSync(path.join(home, '.local', 'bin'), link);
    const sep = path.delimiter;
    const value = [link, `${home}${path.sep}..${path.sep}Home${path.sep}.local${path.sep}bin`, `${home}${path.sep}.local${path.sep}bin${path.sep}`,
      `${home}${path.sep}${path.sep}.local${path.sep}bin`].join(sep);
    expect(pathWithoutHomes({ value, homes: [home], cwd: base }).kept).toEqual([]);
    const otherCase = path.join(base, 'HOME', '.local', 'bin');
    expect(pathWithoutHomes({ value: otherCase, homes: [home], cwd: base }).kept).toEqual(caseless ? [] : [otherCase]);
  });

  it('5. an empty, a dot or a relative entry, when the folder it names is under a home', () => {
    expect(posix(':.:node_modules/.bin:/usr/bin', ['/home/a'], '/home/a/repo').kept).toEqual(['/usr/bin']);
    expect(posix('node_modules/.bin:/usr/bin', ['/home/a'], '/srv/repo').kept).toEqual(['node_modules/.bin', '/usr/bin']);
  });

  it('6. a home that is a filesystem root, or empty, protects nothing', () => {
    expect(posix('/usr/bin:/bin', ['/', '']).kept).toEqual(['/usr/bin', '/bin']);
    expect(windows('C:\\Windows\\System32', ['C:\\', '']).kept).toEqual(['C:\\Windows\\System32']);
  });

  it('13. what is outside every home stays, in its order', () => {
    const value = '/opt/homebrew/bin:/home/a/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin';
    expect(posix(value, ['/home/a']).kept).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin']);
  });
});

describe.skipIf(onWindows)('the suite\'s own tools, by their resolved paths', () => {
  /** A node folder under a home, with npm, npx and a CLI installed globally beside it. */
  function nodeUnderHome() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-'));
    const home = path.join(base, 'home');
    const nodeDir = path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin');
    for (const name of ['node', 'npm', 'npx', 'codex']) executable(path.join(nodeDir, name));
    executable(path.join(home, '.local', 'bin', 'hermes'));
    executable(path.join(home, '.local', 'bin', 'claude'));
    const system = path.join(base, 'usr-bin');
    executable(path.join(system, 'jq'));
    return { base, home, nodeDir, system, binDir: path.join(base, 'suite-bin') };
  }

  it('7, 8, 9. node, npm and npx come back first, from beside the node running, and nothing else of that folder', () => {
    const at = nodeUnderHome();
    const env: NodeJS.ProcessEnv = { PATH: [path.join(at.home, '.local', 'bin'), at.nodeDir, at.system].join(':') };
    guardPath(env, { homes: [at.home], cwd: at.base, binDir: at.binDir, execPath: path.join(at.nodeDir, 'node') });
    const dirs = (env.PATH ?? '').split(':');
    expect(dirs).toEqual([at.binDir, at.system]);
    expect(fs.readdirSync(at.binDir).sort()).toEqual(['node', 'npm', 'npx']);
    expect(fs.realpathSync(path.join(at.binDir, 'node'))).toBe(fs.realpathSync(path.join(at.nodeDir, 'node')));
    for (const cli of ['codex', 'hermes', 'claude']) expect(findOnPath(cli, env.PATH ?? ''), cli).toEqual([]);
    expect(findOnPath('jq', env.PATH ?? '')).toEqual([path.join(at.system, 'jq')]);
  });

  it('7. git comes back by its own path when only a home held it', () => {
    const at = nodeUnderHome();
    const git = executable(path.join(at.home, '.local', 'git', 'bin', 'git'));
    const env: NodeJS.ProcessEnv = { PATH: [path.dirname(git), at.system].join(':') };
    guardPath(env, { homes: [at.home], cwd: at.base, binDir: at.binDir, execPath: path.join(at.nodeDir, 'node') });
    expect(fs.realpathSync(findOnPath('git', env.PATH ?? '')[0])).toBe(fs.realpathSync(git));
    expect(fs.readdirSync(at.binDir).sort()).toEqual(['git', 'node', 'npm', 'npx']);
  });

  it('11. restore puts PATH back exactly, unset included', () => {
    const at = nodeUnderHome();
    const value = [path.join(at.home, '.local', 'bin'), at.system].join(':');
    const env: NodeJS.ProcessEnv = { PATH: value };
    const guarded = guardPath(env, { homes: [at.home], cwd: at.base, binDir: at.binDir, execPath: path.join(at.nodeDir, 'node') });
    expect(env.PATH).not.toBe(value);
    guarded.restore();
    expect(env.PATH).toBe(value);
    const unset: NodeJS.ProcessEnv = {};
    guardPath(unset, { homes: [at.home], cwd: at.base, binDir: path.join(at.base, 'suite-bin-2'), execPath: path.join(at.nodeDir, 'node') }).restore();
    expect('PATH' in unset).toBe(false);
  });

  it('12. the real-claude opt-in brings back claude alone, by the name or the path given; another value brings back nothing', () => {
    const at = nodeUnderHome();
    const localBin = path.join(at.home, '.local', 'bin');
    const opts = (binDir: string) => ({ homes: [at.home], cwd: at.base, binDir, execPath: path.join(at.nodeDir, 'node') });

    const byName: NodeJS.ProcessEnv = { PATH: [localBin, at.system].join(':'), TARS_REAL_CLAUDE: '1' };
    guardPath(byName, opts(path.join(at.base, 'by-name')));
    expect(fs.realpathSync(findOnPath('claude', byName.PATH ?? '')[0])).toBe(fs.realpathSync(path.join(localBin, 'claude')));
    expect(findOnPath('hermes', byName.PATH ?? '')).toEqual([]);

    const elsewhere = executable(path.join(at.base, 'tools', 'claude-2'));
    const byPath: NodeJS.ProcessEnv = { PATH: at.system, TARS_REAL_CLAUDE: elsewhere };
    guardPath(byPath, opts(path.join(at.base, 'by-path')));
    expect(fs.realpathSync(findOnPath('claude', byPath.PATH ?? '')[0])).toBe(fs.realpathSync(elsewhere));
    expect(byPath.PATH?.split(':')).not.toContain(path.dirname(elsewhere));

    const other: NodeJS.ProcessEnv = { PATH: [localBin, at.system].join(':'), TARS_REAL_CLAUDE: 'kept' };
    expect(() => guardPath(other, opts(path.join(at.base, 'other')))).not.toThrow();
    expect(findOnPath('claude', other.PATH ?? '')).toEqual([]);
  });
});

describe('the PATH this file runs with', () => {
  it('1, 2, 10. holds no folder under a home, from the first import on', () => {
    expect(record?.homes.length, 'path-isolation.ts ran').toBeGreaterThan(0);
    for (const value of [process.env.PATH ?? '', PATH_AT_IMPORT]) {
      expect(pathWithoutHomes({ value, homes: record!.homes, cwd: process.cwd() }).removed).toEqual([]);
    }
  });

  it('7, 8. resolves node to the node running vitest, and npm, npx and git to working tools', () => {
    const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' });
    expect(fs.realpathSync(node.stdout.trim())).toBe(fs.realpathSync(process.execPath));
    for (const tool of ['npm', 'npx', 'git']) {
      expect(spawnSync(tool, ['--version'], { encoding: 'utf8', shell: onWindows }).status, tool).toBe(0);
    }
  });

  it.skipIf(onWindows)('1, 2, 7, 13. a child run from a home full of CLIs: none of them starts, and the suite\'s tools do', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-child-'));
    const home = path.join(base, 'home');
    const started = path.join(base, 'started');
    fs.mkdirSync(started);
    // Each CLI a test could reach by its bare name, as an installer leaves it in the home, writing a mark if started.
    for (const cli of ['hermes', 'codex', 'claude', 'gemini']) {
      executable(path.join(home, '.local', 'bin', cli), `#!/bin/sh\ntouch '${path.join(started, cli)}'\necho STARTED\n`);
    }
    // Another node, first on the PATH it starts with.
    executable(path.join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin', 'node'), `#!/bin/sh\ntouch '${path.join(started, 'node')}'\necho WRONG-NODE\n`);
    const system = path.join(base, 'usr-bin');
    executable(path.join(system, 'jq-stand-in'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'child-run-'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST')));
    const PATH = [path.join(home, '.nvm', 'versions', 'node', 'v9.0.0', 'bin'), path.join(home, '.local', 'bin'),
      path.join(os.userInfo().homedir, '.local', 'bin'), system, '/usr/bin', '/bin'].join(':');
    const child = spawnSync(process.execPath, [VITEST, 'run', '--config', `${FIXTURES}/vitest.config.mts`, '--reporter=default', 'path-from-home'], {
      cwd: process.cwd(),
      env: { ...env, HOME: home, PATH, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PATH_CHILD_HOME: home, PATH_CHILD_SYSTEM: system },
      encoding: 'utf8',
      timeout: 90_000,
    });
    const output = stripVTControlCharacters(`${child.stdout}${child.stderr}`);
    expect(output).toMatch(/Test Files {2}1 passed \(1\)/);
    expect(child.status, output).toBe(0);
    expect(fs.readdirSync(started), 'what started from the home').toEqual([]);
  }, 120_000);
});
