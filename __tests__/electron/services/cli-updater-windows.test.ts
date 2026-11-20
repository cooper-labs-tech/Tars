import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The busy check's PowerShell query is answered from a process table (see the
// fakes' header): one real query took up to 25 s on CI's runner. Test 10b asks
// the real one.
vi.mock('child_process', async (importOriginal) => {
  const { childProcessForTests } = await import('./cli-updater-windows-fakes');
  return childProcessForTests(await importOriginal<typeof import('child_process')>());
});

import {
  CMD_SHIM_EXE, endSessions, launcherVersion, nativeClaudeExe, nodeAs, npmPackage, npmPrefixWith, processTable,
  requirePreload as preloadOption, started,
} from './cli-updater-windows-fakes';
import { runCliUpdatePass, updateCli, startCliUpdates, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';
import { pwsh7ModulePath } from '../platform/pwsh7-module-path';

/**
 * Tars keeps claude and Amp up to date on Windows too (audit A28).
 *
 * Before this, every CLI was "skipped: not installed" there, silently: the
 * lookup asked for an executable bit and a name without PATHEXT, the native
 * installer was recognised by a link it does not make on Windows, npm's
 * global packages were looked for under lib/node_modules, the busy check ran
 * lsof, and npm was started by a bare name, which is npm.cmd there.
 *
 * The layouts below are the real ones, read on this machine and in the
 * installer itself:
 * - claude's native installer keeps each version as a file in
 *   %USERPROFILE%\.local\share\claude\versions (2.1.77 and 2.1.78 here) and
 *   copies the one it installs over %USERPROFILE%\.local\bin\claude.exe, the
 *   running one renamed aside to claude.exe.old.<time>. It takes a launcher
 *   whose size is a version's as being on that version: the win32 branch of
 *   its own installer, read out of the 2.1.78 binary.
 * - npm's global prefix is %APPDATA%\npm: packages in node_modules right
 *   under it, no lib, and the shims (amp.cmd, npm.cmd) beside them, no bin.
 *   A shim runs `node <script>` or a native .exe inside its package.
 *
 * Every fake is a real Windows program: a claude.exe that is this run's
 * node.exe under that name, told what to do by a script NODE_OPTIONS
 * preloads, and npm and amp as npm's own .cmd shims over node scripts. The
 * fakes record the argv they were handed. No real CLI, no network, nothing
 * outside a scratch folder.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. claude.exe in ~/.local/bin is not found: no executable bit on Windows, or
 *    no PATHEXT, and a CLI that is there is logged as not installed.
 * 2. The native install is not recognised because its launcher is a file, not
 *    a link, and its version is not read from the versions it is a copy of.
 * 3. `claude.exe update` is not run as one argument, or the verdict is taken
 *    from its words instead of what is on disk after it.
 * 4. An update is held back by, or breaks, a session running the old launcher.
 * 5. An update that changes nothing is called one, a failure is not logged
 *    with the line that explains it.
 * 6. A claude.exe in ~/.local/bin that is none of the installer's versions is
 *    updated as if it were.
 * 7. claude installed by npm (a native exe inside its package) is updated
 *    through a path nobody measured, instead of named and left.
 * 8. Amp's global package is not found under %APPDATA%\npm\node_modules, or
 *    its version is read from the wrong manifest.
 * 9. npm is started by a bare name (ENOENT: it is npm.cmd), or through a
 *    shell, rather than as the node and script its shim runs, with the
 *    arguments macOS gets.
 * 10. The busy check runs lsof, or misses a process running the package: a
 *    node.exe with its script on the command line.
 * 11. When the busy check cannot run, the update goes ahead instead of waiting.
 * 12. An install outside the home Tars runs in is touched.
 * 13. A Settings path that names something Windows cannot start is logged as
 *    not installed, instead of saying why.
 * 14. The schedule main.ts starts does not reach the native claude a launch
 *    on Windows would find.
 *
 * Added at win-reviewer's gate (2026-09-25), written before the fixes:
 * 15. A process running the package's script by a path spelled with forward
 *    slashes (`node C:/.../node_modules/pkg/bin/cli.js`, or in another case)
 *    reads as not running, and npm replaces the folder under it.
 * 16. A process the updater starts (the busy check, npm view and install,
 *    claude.exe update) opens a console window: in the packaged app, a window
 *    flashing up every thirty minutes.
 *
 * Added after CI run 36232894943 (2026-09-26), where these ran on
 * windows-latest for the first time:
 * 17. The tests wait on the machine's real process table: a Get-CimInstance
 *    query took up to 25 s there and test 10 ran past its 60 s. The busy
 *    check's query is answered from a table (cli-updater-windows-fakes.ts);
 *    10b alone asks the real PowerShell, and must still find the session.
 * 18. What cli-updater.test.ts pins beyond the macOS and Linux layout, which
 *    skips on Windows, goes unchecked here: a check that changes nothing is
 *    logged more than once; claude is updated although the user turned its
 *    updates off, or left alone for the autoUpdates the installer itself
 *    wrote; Amp is reinstalled or downgraded for a version that is not newer;
 *    npm's cache lands in the home or stays; Amp is updated although its
 *    settings say not to; a CLI with no measured update path is not named.
 *
 * Added when Tars was found started from PowerShell 7 (2026-09-28):
 * 19. The busy check runs Windows PowerShell 5.1 with the PSModulePath of a
 *    Tars started from pwsh 7: it finds pwsh 7's Core-only modules first, has
 *    no Select-Object or ConvertTo-Json, prints no table, and every update of
 *    an npm CLI is held back as "could not be checked" (10c).
 */

const onWindows = process.platform === 'win32';

vi.setConfig({ testTimeout: 60_000 });

/** Preloaded into the fake claude.exe (this run's node.exe), where it acts as claude 2.1.78's Windows installer does. */
const FAKE_CLAUDE = `
const fs = require('fs'), path = require('path');
if (path.basename(process.execPath).toLowerCase() === 'claude.exe' && process.argv[1]) {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['claude', ...args]) + '\\n');
  // What the real installer has to live with: a scanner may hold a file just
  // written, or the launcher just copied, for a moment (EBUSY on the runner's
  // rename, CI run 36256354047). Each step is tried again for up to 10 s.
  const settle = step => {
    const until = Date.now() + 10000;
    for (;;) {
      try { return step(); } catch (e) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || Date.now() > until) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  };
  const launcher = process.execPath;
  const versions = path.join(process.env.USERPROFILE, '.local', 'share', 'claude', 'versions');
  const current = fs.readdirSync(versions).find(v => fs.statSync(path.join(versions, v)).size === fs.statSync(launcher).size);
  const mode = process.env.FAKE_CLAUDE_MODE || 'update';
  if (args[0] === 'update' && mode === 'update') {
    const next = process.env.FAKE_NEXT || '1.0.1';
    settle(() => fs.copyFileSync(path.join(versions, current), path.join(versions, next)));
    settle(() => fs.appendFileSync(path.join(versions, next), Buffer.alloc(16 + next.length)));
    const old = launcher + '.old.' + Date.now();
    settle(() => fs.renameSync(launcher, old));
    settle(() => fs.copyFileSync(path.join(versions, next), launcher));
    try { fs.unlinkSync(old); } catch { /* running, as claude leaves it */ }
    console.log('Current version: ' + current);
    console.log('Successfully updated from ' + current + ' to version ' + next);
  } else if (args[0] === 'update' && mode === 'current') {
    console.log('Claude Code is up to date (' + current + ')');
  } else if (args[0] === 'update' && mode === 'fail') {
    console.log('Current version: ' + current);
    console.error('Error: Failed to install native update');
    console.error('TelemetrySafeError: connect ECONNREFUSED 35.190.46.17:443');
    process.exit(1);
  }
  process.exit(0);
}
`;

/** npm's cli, faked: records its argv, answers `view` with FAKE_LATEST, rewrites the manifest a global install names. */
const FAKE_NPM = `
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['npm', ...args]) + '\\n');
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); process.exit(0); }
if (args[0] === 'install' && args.includes('--global')) {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
process.exit(0);
`;

let root: string;
let calls: string;
let preload: string;

beforeEach(() => {
  // A space and a quote in every path: an argv handed to a shell as one string would come apart on them.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tars cli-update 'win' ")));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  preload = path.join(root, 'fake-claude.cjs');
  fs.writeFileSync(preload, FAKE_CLAUDE);
});

// The sessions are ended and waited for first, so nothing holds the folder
// when it goes; the retries cover what Windows still holds a moment after an
// exit (21 s at most, inside this hook's 60 s).
afterEach(async () => {
  processTable.mode = 'fake';
  await endSessions();
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 60_000);

/** NODE_OPTIONS for the preload. */
const requirePreload = () => preloadOption(preload);

function recorded(): string[][] {
  return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function logLines(ctx: CliUpdateContext): string[] {
  return fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, 'utf8').split('\n').filter(Boolean) : [];
}

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function ctxFor(home: string, env: Record<string, string> = {}, extraPath: string[] = []): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    tmpDir: root,
    env: {
      USERPROFILE: home,
      HOME: home,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: [...extraPath, path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'), SYSTEM32].join(';'),
      NODE_OPTIONS: requirePreload(),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

const nativeClaude = nativeClaudeExe;
/** %APPDATA%\npm with npm's own shim over the fake npm cli above. */
const npmPrefix = (home: string) => npmPrefixWith(home, FAKE_NPM);
/** amp.cmd over @sourcegraph/amp's script, as `npm install -g @sourcegraph/amp` leaves it. */
const npmAmp = npmPackage;

/** A session kept running, listed in the process table, returned once it says it is ready. */
async function startSession(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  processTable.sessions.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the session exited (${code}) before it was ready`)));
  });
  return child;
}

describe.skipIf(!onWindows)('claude through its native installer, on Windows', () => {
  it('1, 2, 3. finds claude.exe, reads its version off the versions, runs `claude.exe update`, and reads the new one the same way', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const ctx = ctxFor(home);

    const [result] = await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctx);

    expect(result).toMatchObject({ cli: 'claude', outcome: 'updated', from: '1.0.0', to: '1.0.1' });
    expect(recorded()).toEqual([['claude', 'update']]);
    expect(launcherVersion(home)).toBe('1.0.1');
    expect(logLines(ctx)).toHaveLength(1);
    expect(logLines(ctx)[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z claude updated 1\.0\.0 to 1\.0\.1: Successfully updated from 1\.0\.0 to version 1\.0\.1 \(\d+\.\d s\)$/);
  });

  it('4. does not wait for a session running the launcher, which keeps running the copy set aside', async () => {
    const home = path.join(root, 'home');
    const launcher = nativeClaude(home);
    const ctx = ctxFor(home);
    const session = await startSession(launcher, ['-e', "console.log('ready'); setTimeout(() => {}, 60000)"], ctx.env);

    const result = await updateCli('claude', 'claude', ctx);

    expect(result).toMatchObject({ outcome: 'updated', from: '1.0.0', to: '1.0.1' });
    expect(session.exitCode).toBeNull();
  });

  it('5. takes an update that exits 0 and moves nothing as unchanged, in claude\'s own words', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'current' }));

    expect(result).toMatchObject({ outcome: 'unchanged', from: '1.0.0', detail: 'Claude Code is up to date (1.0.0)' });
    expect(result.to).toBeUndefined();
  });

  it('5. logs a failure with the line that explains it', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'fail' }));

    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('Error: Failed to install native update; TelemetrySafeError: connect ECONNREFUSED');
    expect(result.detail).toContain('(exit 1');
    expect(launcherVersion(home)).toBe('1.0.0');
  });

  it('6. leaves alone a claude.exe in ~/.local/bin that is none of the installer\'s versions', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    // A different build put there by hand: one byte more than every version.
    const launcher = path.join(home, '.local', 'bin', 'claude.exe');
    // A launcher just made may still be held a moment, as the fake's own steps are.
    fs.rmSync(launcher, { maxRetries: 10, retryDelay: 200 });
    fs.copyFileSync(process.execPath, launcher);
    fs.appendFileSync(launcher, Buffer.alloc(1));

    const result = await updateCli('claude', 'claude', ctxFor(home));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain(`installed through ${launcher}`);
    expect(recorded()).toEqual([]);
  });

  it('12. never touches an install that lives outside the home it runs in', async () => {
    const realHome = path.join(root, 'real-home');
    nativeClaude(realHome);
    const sandbox = path.join(root, 'sandbox-home');
    fs.mkdirSync(sandbox);

    const result = await updateCli('claude', 'claude', ctxFor(sandbox, {}, [path.join(realHome, '.local', 'bin')]));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('is outside');
    expect(recorded()).toEqual([]);
    expect(launcherVersion(realHome)).toBe('1.0.0');
  });

  it('13. says why a Settings path Windows cannot start is left, rather than that claude is missing', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const version = path.join(home, '.local', 'share', 'claude', 'versions', '1.0.0');

    const result = await updateCli('claude', version, ctxFor(home));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).not.toContain('not installed');
    expect(result.detail).toContain('not a Windows executable');
    expect(recorded()).toEqual([]);
  });

  it('1. says so when claude is not there', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    expect(await updateCli('claude', 'claude', ctxFor(home))).toMatchObject({ outcome: 'skipped', detail: 'not installed: claude not found' });
  });

  it('7. names claude installed by npm, a native exe inside its package, and runs nothing', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const pkgDir = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
    nodeAs(path.join(pkgDir, 'bin', 'claude.exe'));
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.220' }));
    fs.writeFileSync(path.join(prefix, 'claude.cmd'), CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));

    const result = await updateCli('claude', 'claude', ctxFor(home, { FAKE_LATEST: '9.9.9' }));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('installed through npm (@anthropic-ai/claude-code)');
    expect(recorded()).toEqual([]);
  });
});

describe.skipIf(!onWindows)('amp as a global npm package, on Windows', () => {
  it('8, 9. updates the package in %APPDATA%\\npm\\node_modules, through npm.cmd\'s node and script, with the arguments macOS gets', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });

    const [result] = await runCliUpdatePass([{ cli: 'amp', command: 'amp' }], ctx);

    expect(result).toMatchObject({ cli: 'amp', outcome: 'updated', from: '0.0.1', to: '0.0.2' });
    const npm = recorded();
    expect(npm.map(c => c.slice(0, 2))).toEqual([['npm', 'view'], ['npm', 'install'], ['npm', 'install']]);
    const cache = npm[0][npm[0].indexOf('--cache') + 1];
    expect(npm[0]).toEqual(['npm', 'view', '@sourcegraph/amp', 'version', '--prefix', prefix, '--cache', cache, '--fetch-retries=0']);
    const scratch = npm[1][npm[1].indexOf('--prefix') + 1];
    expect(scratch).not.toBe(prefix);
    expect(npm[1]).not.toContain('--global');
    expect(npm[1].at(-1)).toBe('@sourcegraph/amp@0.0.2');
    expect(npm[2]).toEqual(['npm', 'install', '--global', '--prefix', prefix, '--cache', cache, '--prefer-offline', '--no-audit', '--no-fund', '@sourcegraph/amp@0.0.2']);
    expect(fs.existsSync(path.dirname(cache))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@sourcegraph', 'amp', 'package.json'), 'utf8')).version).toBe('0.0.2');
  });

  it('10. waits while a process runs the package, and updates once it has ended', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const script = npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    const session = await startSession(process.execPath, [script], ctx.env);

    const held = await updateCli('amp', 'amp', ctx);

    expect(held.outcome).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
    expect(recorded().map(c => c[1])).toEqual(['view']);

    session.kill();
    await new Promise(resolve => session.once('exit', resolve));

    const done = await updateCli('amp', 'amp', ctx);
    expect(done).toMatchObject({ outcome: 'updated', from: '0.0.1', to: '0.0.2' });
  });

  // The one case that reads the machine's real process table through
  // PowerShell (17): up to 25 s a query on CI's runner, hence its timeout.
  it('10b. finds a process running the package in the real process table, and waits for it', async () => {
    processTable.mode = 'real';
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const script = npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    const session = await startSession(process.execPath, [script], ctx.env);

    const held = await updateCli('amp', 'amp', ctx);

    expect(held.outcome, JSON.stringify(held)).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
    expect(recorded().map(c => c[1])).toEqual(['view']);
  }, 180_000);

  it('10c. reads the real process table as well when Tars was started from PowerShell 7', async () => {
    processTable.mode = 'real';
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const script = npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2', PSModulePath: pwsh7ModulePath(root) });
    const session = await startSession(process.execPath, [script], ctx.env);

    const held = await updateCli('amp', 'amp', ctx);

    expect(held.outcome, JSON.stringify(held)).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
  }, 180_000);

  it('11. holds an update back when it cannot tell whether Amp is running', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    npmAmp(prefix);
    // PowerShell cannot be started: nothing can list the processes.
    processTable.mode = 'broken';
    const result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: '0.0.2' }));

    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'deferred' });
    expect(result.detail).toContain('could not be checked');
    expect(recorded().map(c => c[1])).toEqual(['view']);
  });

  it('15. waits for a process that names the package with forward slashes, in another case', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    const script = npmAmp(prefix);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    // C:/USERS/.../node_modules/@SOURCEGRAPH/amp/bin/amp.js: the same file for Windows.
    const spelled = script.replace(/\\/g, '/').replace(/@sourcegraph/, '@SOURCEGRAPH');
    const session = await startSession(process.execPath, [spelled], ctx.env);

    const held = await updateCli('amp', 'amp', ctx);

    expect(held.outcome, JSON.stringify(held)).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
    expect(recorded().map(c => c[1])).toEqual(['view']);
  });

  it('16. hides the console window of every process it starts', async () => {
    const home = path.join(root, 'home');
    const prefix = npmPrefix(home);
    npmAmp(prefix);
    nativeClaude(home);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    started.length = 0;

    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }, { cli: 'amp', command: 'amp' }], ctx);

    const kinds = started.map(s => path.win32.basename(s.file).toLowerCase());
    // claude.exe update, the busy check (PowerShell, twice) and npm (node.exe, three times).
    expect(kinds).toEqual(expect.arrayContaining(['claude.exe', 'powershell.exe', 'node.exe']));
    expect(started.filter(s => s.windowsHide !== true), 'started with a console window').toEqual([]);
  });

  it('12. never touches a global prefix outside the home it runs in', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    const prefix = npmPrefix(elsewhere);
    npmAmp(prefix);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    const result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: '0.0.2' }, [prefix]));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('is outside');
    expect(recorded()).toEqual([]);
  });
});

/** 18: cli-updater.test.ts's cases whose subject is not the layout, with its assertions, on the Windows layout. */
describe.skipIf(!onWindows)('what cli-updater.test.ts pins beyond the layout, on Windows', () => {
  it('writes a check that changes nothing once, and the next change again', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const current = ctxFor(home, { FAKE_CLAUDE_MODE: 'current' });

    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], current);
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], current);
    expect(logLines(current)).toHaveLength(1);
    expect(logLines(current)[0]).toContain('claude unchanged 1.0.0: Claude Code is up to date (1.0.0)');

    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home));
    expect(logLines(current)).toHaveLength(2);
    expect(logLines(current)[1]).toContain('claude updated 1.0.0 to 1.0.1');
    expect(recorded()).toHaveLength(3);
  });

  it.each([
    ['DISABLE_AUTOUPDATER in ~/.claude/settings.json', { settings: { env: { DISABLE_AUTOUPDATER: '1' } } }, 'DISABLE_AUTOUPDATER is set in ~/.claude/settings.json'],
    ['DISABLE_UPDATES in the environment', { env: { DISABLE_UPDATES: 'true' } }, 'DISABLE_UPDATES is set in the environment Tars was started with'],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in settings', { settings: { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'yes-please' } } }, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set in ~/.claude/settings.json'],
    ['autoUpdates false, not set by the native installer', { config: { autoUpdates: false, installMethod: 'npm' } }, 'autoUpdates is false in ~/.claude.json'],
  ])('leaves claude alone when the user turned updates off: %s', async (_name, setup, why) => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const s = setup as { settings?: object; config?: object; env?: Record<string, string> };
    if (s.settings) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(s.settings));
    }
    if (s.config) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(s.config));

    const result = await updateCli('claude', 'claude', ctxFor(home, s.env));

    expect(result).toMatchObject({ outcome: 'skipped', from: '1.0.0', detail: why });
    expect(recorded()).toEqual([]);
  });

  it('reads autoUpdates: false written by the native installer itself as no opinion, as claude does', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ autoUpdates: false, installMethod: 'native', autoUpdatesProtectedForNative: true }));

    expect((await updateCli('claude', 'claude', ctxFor(home))).outcome).toBe('updated');
  });

  it.each([
    ['the same version', '0.0.1'],
    ['an older one', '0.0.0'],
    ['the same release with another build hash', '0.0.1-gdeadbe'],
  ])('neither reinstalls nor downgrades when npm offers %s', async (_name, latest) => {
    const home = path.join(root, 'home');
    npmAmp(npmPrefix(home), '0.0.1-gce258b');

    const result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: latest }));

    expect(result.outcome).toBe('unchanged');
    expect(recorded().map(c => c[1])).toEqual(['view']);
  });

  it.each([
    ['nothing newer', { FAKE_LATEST: '0.0.1' }],
    ['a view that fails', { FAKE_LATEST: '' }],
  ])('keeps npm\'s cache out of the home, and removes it, when there is %s', async (_name, env) => {
    const home = path.join(root, 'home');
    npmAmp(npmPrefix(home), '0.0.1');

    await updateCli('amp', 'amp', ctxFor(home, env));

    const caches = recorded().map(c => c[c.indexOf('--cache') + 1]);
    expect(caches).toHaveLength(1);
    expect(recorded()[0]).toContain('--cache');
    expect(path.relative(home, caches[0]).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.dirname(caches[0]))).toBe(false);
  });

  it('leaves amp alone when the user turned its updates off in their own settings', async () => {
    const home = path.join(root, 'home');
    npmAmp(npmPrefix(home));
    fs.mkdirSync(path.join(home, '.config', 'amp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'amp', 'settings.json'), JSON.stringify({ 'amp.updates.mode': 'disabled' }));

    const result = await updateCli('amp', 'amp', ctxFor(home, { FAKE_LATEST: '0.0.2' }));

    expect(result).toMatchObject({ outcome: 'skipped', detail: 'amp.updates.mode is "disabled" in ~/.config/amp/settings.json' });
    expect(recorded()).toEqual([]);
  });

  it('names one it has no measured path for, and runs nothing', async () => {
    const home = path.join(root, 'home');
    npmAmp(npmPrefix(home), '1.0.0', '@openai/codex', 'codex');

    const result = await updateCli('codex', 'codex', ctxFor(home, { FAKE_LATEST: '9.9.9' }));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toBe('installed through npm (@openai/codex); no update path for it has been measured. Update it yourself');
    expect(recorded()).toEqual([]);
  });
});

describe.skipIf(!onWindows)('the schedule main.ts starts, on Windows', () => {
  it('14. updates the native claude a launch would find, 5 s after it starts, into ~/.tars/cli-updates.log', async () => {
    // The suite's throwaway home, where the app's paths point: buildFullPath
    // adds its ~/.local/bin. The PATH it starts from is narrowed to System32
    // for the case, so no CLI of this machine's is on it.
    const home = os.homedir();
    nativeClaude(home);
    const saved = { path: process.env.PATH, options: process.env.NODE_OPTIONS, calls: process.env.FAKE_CALLS };
    process.env.PATH = SYSTEM32;
    process.env.NODE_OPTIONS = requirePreload();
    process.env.FAKE_CALLS = calls;
    try {
      startCliUpdates(() => ({ cliPaths: { claude: '', amp: '' } }) as unknown as AppSettings, () => ['claude']);
      await vi.waitFor(() => {
        expect(fs.existsSync(CLI_UPDATES_LOG) && fs.readFileSync(CLI_UPDATES_LOG, 'utf8')).toContain('claude updated 1.0.0 to 1.0.1');
      }, { timeout: 30_000, interval: 250 });
      expect(CLI_UPDATES_LOG).toBe(path.join(home, '.tars', 'cli-updates.log'));
      expect(recorded()).toEqual([['claude', 'update']]);
    } finally {
      process.env.PATH = saved.path;
      if (saved.options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.options;
      if (saved.calls === undefined) delete process.env.FAKE_CALLS; else process.env.FAKE_CALLS = saved.calls;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  });
});
