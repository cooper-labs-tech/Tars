import '../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { nextBuild } from '../../scripts/build-renderer.mjs';

/**
 * scripts/build-renderer.mjs: `npm run build:renderer`. It replaces a
 * `bash -c 'set -e; ...; trap ... EXIT'` that neither cmd.exe nor PowerShell
 * can run (and `bash` there is WSL's).
 *
 * `next build` with ELECTRON_BUILD=1 is a static export, which can hold neither
 * route handlers nor a dynamic icon: src/app/api and src/app/icon.tsx are moved
 * aside for the build and must come back whatever happens to it. Each case runs
 * the script in a throwaway checkout with a fake `next build`, which writes down
 * what it found and then passes, fails, or waits to be interrupted.
 *
 * The ways it can fail, each pinned below:
 *  1. src/app/api or src/app/icon.tsx still in place while next build runs;
 *  2. not put back after a build that passed;
 *  3. not put back after a build that failed, or next build's exit code lost,
 *     read as 0 or replaced by another;
 *  4. not put back when the build is interrupted: SIGINT, SIGTERM or SIGHUP on
 *     POSIX, Ctrl+C on Windows; or the script dying while next build still runs;
 *     or, on Windows, a next build the Ctrl+C never reached left to run to its end;
 *  5. what comes back not what went away: a file changed, a folder nested;
 *  6. .next and out of an earlier build left for next build to mix in;
 *  7. next build run without ELECTRON_BUILD=1, elsewhere than the checkout, with
 *     other arguments, or another next than this checkout's;
 *  8. a checkout with no icon.tsx refused, or given one afterwards;
 *  9. a checkout with no src/app/api built anyway;
 * 10. a backup left by a build killed outright (SIGKILL, a closed laptop) moved
 *     into or overwritten: the shell version put src/app/api inside it. This
 *     one stops, touches nothing, and says how to recover;
 * 11. a restore that failed reported as a success.
 */

const SCRIPT = path.join(__dirname, '../../scripts/build-renderer.mjs');
const made: string[] = [];

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const ROUTE = 'export async function GET() { return Response.json({ ok: true }); }\n';
const ICON = 'export default function Icon() { return null; }\n';

/** The fake next build: records what it found, then does what FAKE_MODE says. */
const FAKE_NEXT = `
const fs = require('fs');
const at = p => fs.existsSync(p);
fs.writeFileSync(process.env.FAKE_SAW, JSON.stringify({
  api: at('src/app/api'), apiBackup: at('src/app/_api_backup'),
  icon: at('src/app/icon.tsx'), iconBackup: at('src/app/_icon_backup.tsx'),
  next: at('.next'), out: at('out'),
  electronBuild: process.env.ELECTRON_BUILD, argv: process.argv.slice(2), cwd: process.cwd(),
}));
const mode = process.env.FAKE_MODE;
if (mode === 'recreate') { fs.mkdirSync('src/app/api/other', { recursive: true }); fs.writeFileSync('src/app/api/other/route.ts', 'x'); process.exit(0); }
if (mode === 'wait') { fs.writeFileSync(process.env.FAKE_SAW + '.ready', ''); setInterval(() => {}, 1000); }
// A next build the Ctrl+C never reached: one started just after it was pressed.
else if (mode === 'deaf') { process.on('SIGINT', () => {}); process.on('SIGBREAK', () => {}); fs.writeFileSync(process.env.FAKE_SAW + '.ready', String(process.pid)); setInterval(() => {}, 1000); }
else process.exit(Number(mode));
`;

interface Checkout { root: string; saw: string; run: string; ready: string }

/** A checkout laid out as the build finds it, and the script that runs the build on it. */
function checkout({ icon = true, api = true, mode = '0' } = {}): Checkout {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-build-renderer-'));
  made.push(dir);
  const root = path.join(dir, 'checkout');
  const put = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  put('src/app/page.tsx', 'export default function Page() { return null; }\n');
  if (api) put('src/app/api/health/route.ts', ROUTE);
  if (icon) put('src/app/icon.tsx', ICON);
  put('.next/cache/stale', 'an earlier build');
  put('out/index.html', 'an earlier export');
  const fake = path.join(dir, 'fake-next.cjs');
  fs.writeFileSync(fake, FAKE_NEXT);
  const saw = path.join(dir, 'saw.json');
  const run = path.join(dir, 'run.mjs');
  fs.writeFileSync(run, [
    `process.env.FAKE_SAW = ${JSON.stringify(saw)};`,
    `process.env.FAKE_MODE = ${JSON.stringify(mode)};`,
    `const { main } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
    `await main({ build: { command: process.execPath, args: [${JSON.stringify(fake)}, 'build'] } });`,
  ].join('\n'));
  return { root, saw, run, ready: `${saw}.ready` };
}

function run(c: Checkout): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [c.run], { cwd: c.root, encoding: 'utf8' }, (error, _stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr });
    });
  });
}

const saw = (c: Checkout) => JSON.parse(fs.readFileSync(c.saw, 'utf8'));
const at = (c: Checkout, file: string) => path.join(c.root, file);

/** Everything the build moves is back where it was, as it was, and no backup is left. */
function expectPutBack(c: Checkout, { icon = true } = {}) {
  expect(fs.readFileSync(at(c, 'src/app/api/health/route.ts'), 'utf8')).toBe(ROUTE);
  expect(fs.readdirSync(at(c, 'src/app/api'))).toEqual(['health']);
  if (icon) expect(fs.readFileSync(at(c, 'src/app/icon.tsx'), 'utf8')).toBe(ICON);
  else expect(fs.existsSync(at(c, 'src/app/icon.tsx'))).toBe(false);
  expect(fs.existsSync(at(c, 'src/app/_api_backup'))).toBe(false);
  expect(fs.existsSync(at(c, 'src/app/_icon_backup.tsx'))).toBe(false);
}

describe.concurrent('npm run build:renderer', { timeout: 60_000 }, () => {
  it('builds with the routes and the icon moved aside, in a clean checkout, then puts them back', async ({ expect }) => {
    const c = checkout();

    const result = await run(c);

    expect(saw(c)).toEqual({
      api: false, apiBackup: true, icon: false, iconBackup: true, next: false, out: false,
      electronBuild: '1', argv: ['build'], cwd: fs.realpathSync(c.root),
    });
    expectPutBack(c);
    expect(result.status).toBe(0);
  });

  it.for([1, 3])('puts them back after a build that exits %i, and exits with its code', async (code, { expect }) => {
    const c = checkout({ mode: String(code) });

    const result = await run(c);

    expect(saw(c).apiBackup).toBe(true);
    expectPutBack(c);
    expect(result.status).toBe(code);
  });

  it('builds a checkout with no icon, and leaves it with none', async ({ expect }) => {
    const c = checkout({ icon: false });

    const result = await run(c);

    expect(saw(c)).toMatchObject({ api: false, apiBackup: true, icon: false, iconBackup: false });
    expectPutBack(c, { icon: false });
    expect(result.status).toBe(0);
  });

  it('does not build a checkout with no src/app/api, and leaves its icon alone', async ({ expect }) => {
    const c = checkout({ api: false });

    const result = await run(c);

    expect(fs.existsSync(c.saw), 'next build ran').toBe(false);
    expect(fs.readFileSync(at(c, 'src/app/icon.tsx'), 'utf8')).toBe(ICON);
    expect(fs.existsSync(at(c, 'src/app/_icon_backup.tsx'))).toBe(false);
    expect(result.stderr).toContain('src/app/api');
    expect(result.status).toBe(1);
  });

  it.for(['_api_backup', '_icon_backup.tsx'])('stops on a src/app/%s left by a killed build, and touches neither', async (left, { expect }) => {
    const c = checkout();
    const leftover = at(c, `src/app/${left}`);
    if (left === '_api_backup') {
      fs.mkdirSync(path.join(leftover, 'older'), { recursive: true });
      fs.writeFileSync(path.join(leftover, 'older', 'route.ts'), 'the routes of an earlier build');
    } else {
      fs.writeFileSync(leftover, 'the icon of an earlier build');
    }
    const before = fs.readdirSync(at(c, 'src/app')).sort();

    const result = await run(c);

    expect(fs.existsSync(c.saw), 'next build ran').toBe(false);
    expect(fs.readdirSync(at(c, 'src/app')).sort()).toEqual(before);
    expect(fs.readFileSync(at(c, 'src/app/api/health/route.ts'), 'utf8')).toBe(ROUTE);
    expect(fs.readFileSync(at(c, 'src/app/icon.tsx'), 'utf8')).toBe(ICON);
    expect(result.stderr).toContain(`src/app/${left} already exists`);
    expect(result.status).toBe(1);
  });

  it('fails, and keeps the routes in their backup, when something took their place during the build', async ({ expect }) => {
    // The shell version moved the backup inside the new folder and exited 0.
    const c = checkout({ mode: 'recreate' });

    const result = await run(c);

    expect(fs.readFileSync(at(c, 'src/app/_api_backup/health/route.ts'), 'utf8')).toBe(ROUTE);
    expect(fs.existsSync(at(c, 'src/app/api/_api_backup'))).toBe(false);
    expect(fs.readFileSync(at(c, 'src/app/icon.tsx'), 'utf8')).toBe(ICON);
    expect(result.stderr).toContain('could not put src/app/_api_backup back');
    expect(result.status).toBe(1);
  });

  it.skipIf(process.platform === 'win32').for(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('puts them back when interrupted by %s, once next build has stopped, then dies of it', async (signal, { expect }) => {
    const c = checkout({ mode: 'wait' });
    const script = spawn(process.execPath, [c.run], { cwd: c.root, stdio: 'ignore' });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => script.on('exit', (code, sig) => resolve({ code, signal: sig })));
    while (!fs.existsSync(c.ready)) await new Promise(r => setTimeout(r, 50));

    script.kill(signal);

    expect(await ended).toEqual({ code: null, signal });
    expectPutBack(c);
  });

  it.runIf(process.platform === 'win32')('puts them back on a Ctrl+C in its console, once next build has stopped', async ({ expect }) => {
    // What a user's Ctrl+C does: CTRL_C_EVENT to every process of the console,
    // the script and next build alike. The helper attaches to the script's own
    // (hidden) console to send it, so the test runner never receives one.
    const c = checkout({ mode: 'wait' });
    const helper = path.join(path.dirname(c.root), 'ctrl-c.ps1');
    fs.writeFileSync(helper, CTRL_C_HELPER);

    const out = await new Promise<string>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, process.execPath, c.run, c.root, c.ready],
        { encoding: 'utf8', timeout: 50_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
    });

    expect(saw(c).apiBackup).toBe(true);
    expectPutBack(c);
    expect(out).toMatch(/EXIT=-?\d+/);
    expect(out).not.toContain('EXIT=0');
  });

  it.runIf(process.platform === 'win32')('stops a next build the Ctrl+C never reached, and puts them back', async ({ expect }) => {
    // A Ctrl+C pressed while the script moves things aside reaches the console
    // before next build is in it, and the script only hears of it once next
    // build has started: next build never sees it, and the script, which
    // catches it, waited for the whole build to end.
    const c = checkout({ mode: 'deaf' });
    const helper = path.join(path.dirname(c.root), 'ctrl-c.ps1');
    fs.writeFileSync(helper, CTRL_C_HELPER);
    const pid = () => Number(fs.existsSync(c.ready) ? fs.readFileSync(c.ready, 'utf8') : 0);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, process.execPath, c.run, c.root, c.ready],
          { encoding: 'utf8', timeout: 50_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
      });

      expectPutBack(c);
      expect(out).toMatch(/EXIT=-?\d+/);
      expect(out).not.toContain('EXIT=0');
      expect(() => process.kill(pid(), 0), 'next build was left running').toThrow();
    } finally {
      try { process.kill(pid()); } catch { /* gone, as it should be */ }
    }
  });
});

describe('the next build it runs by default', () => {
  it('is this checkout\'s next, run by this node, with the argument build', () => {
    const require = createRequire(__filename);
    const manifest = require.resolve('next/package.json');
    const { bin } = require(manifest) as { bin: string | Record<string, string> };

    const { command, args } = nextBuild();

    expect(command).toBe(process.execPath);
    expect(args).toEqual([path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin.next), 'build']);
    expect(fs.existsSync(args[0])).toBe(true);
  });

  /** The command, run as `node <script>` in a checkout with no src/app/api, where it has to stop with 1. */
  async function fromTheCommandLine(script: (root: string) => string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-build-renderer-cli-'));
    made.push(root);
    fs.mkdirSync(path.join(root, 'src/app'), { recursive: true });
    return new Promise<{ status: number | null; stderr: string }>(resolve => {
      execFile(process.execPath, [script(root)], { cwd: root, encoding: 'utf8' }, (error, _stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stderr });
      });
    });
  }

  it('runs from the command line, and there stops before building a checkout with no src/app/api', async () => {
    const result = await fromTheCommandLine(() => SCRIPT);

    expect(result.stderr).toContain('src/app/api');
    expect(result.status).toBe(1);
  });

  it('runs from the command line through a link to scripts/, as it does from a subst drive or a junctioned checkout', async () => {
    // Node runs the module from its real path: a check against the path as typed
    // never matched, and the command exited 0 having done nothing.
    let link = '';
    try {
      const result = await fromTheCommandLine(root => {
        link = path.join(root, 'linked-scripts');
        fs.symlinkSync(path.dirname(SCRIPT), link, 'junction'); // a junction on Windows, a directory symlink elsewhere
        return path.join(link, 'build-renderer.mjs');
      });

      expect(result.stderr).toContain('src/app/api');
      expect(result.status).toBe(1);
    } finally {
      // The link alone: rmdir removes a junction without following it, unlink a symlink.
      if (link) (process.platform === 'win32' ? fs.rmdirSync : fs.unlinkSync)(link);
    }
  });
});

/** Starts the script in a console of its own, waits for next build, presses Ctrl+C there, prints the exit code. */
const CTRL_C_HELPER = String.raw`
param([string]$Node, [string]$Run, [string]$Root, [string]$Ready)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TarsConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
}
'@
# A parent that ignores Ctrl+C (a shell that started this one in a process
# group of its own) hands that on to every process it starts, and the script
# would never see the Ctrl+C below: Ctrl+C is handled again here first, and the
# script inherits that instead.
[void][TarsConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$p = Start-Process -FilePath $Node -ArgumentList ('"' + $Run + '"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
$null = $p.Handle
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path -LiteralPath $Ready)) {
  if ($p.HasExited) { throw "the script exited before next build started: $($p.ExitCode)" }
  if ((Get-Date) -gt $deadline) { throw 'next build never started' }
  Start-Sleep -Milliseconds 50
}
[void][TarsConsole]::FreeConsole()
if (-not [TarsConsole]::AttachConsole([uint32]$p.Id)) { throw "AttachConsole: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[void][TarsConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not [TarsConsole]::GenerateConsoleCtrlEvent(0, 0)) { throw "GenerateConsoleCtrlEvent: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[void][TarsConsole]::FreeConsole()
if (-not $p.WaitForExit(30000)) { $p.Kill(); throw 'the script did not exit after Ctrl+C' }
"EXIT=$($p.ExitCode)"
`;
