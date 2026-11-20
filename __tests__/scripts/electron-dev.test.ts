import '../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/**
 * scripts/electron-dev.mjs, the last step of `npm run electron:start`: what
 * `NODE_ENV=development electron .` did, in a form every shell runs. cmd.exe,
 * npm's shell on Windows, read `NODE_ENV=development` as a command name.
 *
 * It goes through the electron package of this checkout, as `electron .` did,
 * with one thing swapped: the binary. ELECTRON_OVERRIDE_DIST_PATH, which only
 * that package's index.js reads, points it at this very node under the name
 * Electron looks for, so no 100 MB download and no display are needed (CI's
 * npm ci fetches no Electron binary). That binary runs a fixture that writes
 * down what it was given, then exits as told.
 *
 * The ways it can fail, each pinned below:
 *  1. NODE_ENV not `development` in Electron, above all when the parent holds
 *     another one (vitest's `test`, a shell's `production`);
 *  2. the rest of the environment not handed down (DOROTHY_DEV_URL);
 *  3. the argv changed on the way: reordered, split on a space, a quote or an
 *     ampersand read by a shell;
 *  4. another binary than the one this checkout's electron package names;
 *  5. Electron's exit code lost: its 0 and its 3 must be the launcher's;
 *  6. Electron killed and the launcher exiting 0 (it must exit 1, as
 *     `electron .` did);
 *  7. on POSIX, a SIGTERM or SIGINT to the launcher leaving Electron running.
 *     Not on Windows, where Ctrl+C reaches every process of the console and a
 *     kill is TerminateProcess, which nothing can catch.
 */

const SCRIPT = path.join(__dirname, '../../scripts/electron-dev.mjs');
const ELECTRON_PACKAGE = path.join(__dirname, '../../node_modules/electron');
const made: string[] = [];

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The stand-in binary: this node, where Electron's index.js looks under
 * ELECTRON_OVERRIDE_DIST_PATH, the name in path.txt, or `electron` when the
 * binary was never downloaded. Linked when it can be, copied otherwise.
 */
const fake = (() => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-electron-dist-'));
  made.push(dist);
  const pathTxt = path.join(ELECTRON_PACKAGE, 'path.txt');
  const binary = path.join(dist, fs.existsSync(pathTxt) ? fs.readFileSync(pathTxt, 'utf8') : 'electron');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  try {
    fs.linkSync(process.execPath, binary);
  } catch {
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
  }
  return { dist, binary };
})();

/** What Electron runs: records its view of the world in `out`, then exits with `mode`, dies, or waits. */
const FIXTURE = `
const fs = require('fs');
const [out, mode, ...rest] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({ nodeEnv: process.env.NODE_ENV, devUrl: process.env.DOROTHY_DEV_URL, argv: rest, execPath: process.execPath, pid: process.pid }));
if (mode === 'die') process.kill(process.pid, 'SIGKILL');
else if (mode === 'wait') setInterval(() => {}, 1000);
else process.exit(Number(mode));
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-electron-dev-'));
  made.push(dir);
  const fixture = path.join(dir, 'fixture.js');
  fs.writeFileSync(fixture, FIXTURE);
  return { fixture, out: path.join(dir, 'seen.json') };
}

const ENV = { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: fake.dist, NODE_ENV: 'production', DOROTHY_DEV_URL: 'http://127.0.0.1:3999' };

function launch(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, ...args], { env: ENV, encoding: 'utf8' }, (error, _stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr });
    });
  });
}

const seen = (out: string) => JSON.parse(fs.readFileSync(out, 'utf8'));

describe('npm run electron:start, its last step', { timeout: 60_000 }, () => {
  it('starts this checkout\'s Electron in development, with the environment and the argv it was given', async () => {
    const { fixture, out } = setup();
    const argv = ['a b', 'c&d', '"q"', '--flag=x y'];

    const run = await launch([fixture, out, '0', ...argv]);

    const got = seen(out);
    expect(got.nodeEnv).toBe('development');
    expect(got.devUrl).toBe('http://127.0.0.1:3999');
    expect(got.argv).toEqual(argv);
    expect(fs.realpathSync(got.execPath)).toBe(fs.realpathSync(fake.binary));
    expect(run.status).toBe(0);
  });

  it('exits with Electron\'s own exit code', async () => {
    const { fixture, out } = setup();

    const run = await launch([fixture, out, '3']);

    expect(fs.existsSync(out)).toBe(true);
    expect(run.status).toBe(3);
  });

  it('exits 1 when Electron is killed', async () => {
    const { fixture, out } = setup();

    const run = await launch([fixture, out, 'die']);

    expect(fs.existsSync(out)).toBe(true);
    expect(run.status).toBe(1);
    if (process.platform !== 'win32') expect(run.stderr).toContain('exited with signal SIGKILL');
  });

  it.skipIf(process.platform === 'win32').for(['SIGTERM', 'SIGINT'] as const)('passes a %s to Electron and does not outlive it', async signal => {
    const { fixture, out } = setup();
    const launcher = spawn(process.execPath, [SCRIPT, fixture, out, 'wait'], { env: ENV, stdio: 'ignore' });
    const exited = new Promise<number | null>(resolve => launcher.on('exit', code => resolve(code)));
    let pid: number | undefined;
    while (pid === undefined) {
      await new Promise(r => setTimeout(r, 50));
      try {
        pid = seen(out).pid;
      } catch {
        // not written yet, or written halfway
      }
    }

    launcher.kill(signal);

    expect(await exited).toBe(1);
    let gone: string | undefined;
    try {
      process.kill(pid, 0);
    } catch (err) {
      gone = (err as NodeJS.ErrnoException).code;
    }
    expect(gone, 'Electron outlived its launcher').toBe('ESRCH');
  });
});
