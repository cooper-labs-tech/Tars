import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCliUpdatePass, updateCli, startCliUpdates, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';
import { cannotPlantPosixInstall } from '../../setup/posix-install-layout';

/**
 * Tars keeps claude and Amp up to date itself, and never under a session it
 * could break.
 *
 * Everything here runs against fake installs laid out exactly as the real ones
 * are on disk: claude's native installer (~/.local/bin/claude, a link into
 * ~/.local/share/claude/versions/<version>) and a global npm package
 * (<prefix>/bin/amp, a link into <prefix>/lib/node_modules/@sourcegraph/amp/
 * node_modules/@ampcode/cli/bin/amp.exe). The fakes record every argv they are
 * handed, so what is asserted is what Tars really ran, not what a mock was
 * told. No real CLI, no network, and nothing outside a scratch folder.
 *
 * What the real binaries did, measured before this was written, is on the
 * comment at the head of cli-updater.ts: a native update leaves a running
 * session alone, an npm one removes the binary for seconds.
 */

const NODE_DIR = path.dirname(process.execPath);

// Every test here starts real processes (node scripts, lsof). The first one
// took 546 ms alone and 5036 ms beside two other runs on a loaded machine,
// past vitest's 5 s default: the time is spawning, not the code under test.
vi.setConfig({ testTimeout: 30_000 });

/** A claude that records its argv and does what FAKE_CLAUDE_MODE says, the way 2.1.280 does. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['claude', ...args]) + '\\n');
const link = path.join(process.env.HOME, '.local/bin/claude');
const versions = path.join(process.env.HOME, '.local/share/claude/versions');
const current = path.basename(fs.realpathSync(link));
const mode = process.env.FAKE_CLAUDE_MODE || 'update';
// Open for as long as it runs, as a real binary is mapped: what lsof would see.
if (args[0] === 'run') { fs.openSync(fs.realpathSync(process.argv[1]), 'r'); console.log('ready'); setTimeout(() => {}, 60000); }
else if (args[0] === 'update' && mode === 'update') {
  const next = process.env.FAKE_NEXT || '1.0.1';
  fs.copyFileSync(path.join(versions, current), path.join(versions, next));
  fs.symlinkSync(path.join(versions, next), link + '.tmp');
  fs.renameSync(link + '.tmp', link);
  console.log('Current version: ' + current);
  console.log('Successfully updated from ' + current + ' to version ' + next);
} else if (args[0] === 'update' && mode === 'current') {
  console.log('Claude Code is up to date (' + current + ')');
} else if (args[0] === 'update' && mode === 'admin') {
  console.log('Updates are disabled by your administrator. Contact your IT team to get the latest version.');
} else if (args[0] === 'update' && mode === 'fail') {
  console.log('Current version: ' + current);
  console.error('Error: Failed to install native update');
  console.error('TelemetrySafeError: connect ECONNREFUSED 35.190.46.17:443');
  process.exit(1);
}
`;

/** An npm that records its argv, answers \`view\` with FAKE_LATEST, and rewrites the manifest a global install names. */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(['npm', ...args]) + '\\n');
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); process.exit(0); }
// An Amp launched while the update downloads: FAKE_START_DURING_DOWNLOAD names its binary.
if (args[0] === 'install' && !args.includes('--global') && process.env.FAKE_START_DURING_DOWNLOAD) {
  const child = require('child_process').spawn(process.env.FAKE_START_DURING_DOWNLOAD, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(process.env.FAKE_START_DURING_DOWNLOAD + '.pid', String(child.pid));
  child.unref();
}
if (args[0] === 'install' && args.includes('--global')) {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'lib', 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
process.exit(0);
`;

let root: string;
let calls: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  // A space and a quote in every path: an argv handed to a shell as one string
  // would come apart on them.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tars cli-update 'test' ")));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

function recorded(): string[][] {
  return fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function logLines(ctx: CliUpdateContext): string[] {
  return fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, 'utf8').split('\n').filter(Boolean) : [];
}

function ctxFor(home: string, env: Record<string, string> = {}, extraPath: string[] = []): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    tmpDir: root,
    env: {
      HOME: home,
      PATH: [...extraPath, path.join(home, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

/** ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>, as the native installer leaves it. */
function nativeClaude(home: string, version = '1.0.0'): string {
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(versions, version), FAKE_CLAUDE, { mode: 0o755 });
  fs.symlinkSync(path.join(versions, version), path.join(home, '.local', 'bin', 'claude'));
  return path.join(versions, version);
}

function linkedVersion(home: string): string {
  return path.basename(fs.realpathSync(path.join(home, '.local', 'bin', 'claude')));
}

/**
 * <prefix>/bin/amp -> the binary inside @ampcode/cli inside @sourcegraph/amp,
 * which is how JeanBrasse's Amp is installed. `runnable` makes the binary a copy of
 * node, a real executable a process can be kept running from; its own inode,
 * so lsof does not mistake the test runner for it.
 */
function npmAmp(prefix: string, version = '0.0.1', runnable = false, owner = '@sourcegraph/amp'): string {
  const pkgDir = path.join(prefix, 'lib', 'node_modules', owner);
  const binDir = path.join(pkgDir, 'node_modules', '@ampcode', 'cli', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: owner, version }));
  const binary = path.join(binDir, 'amp.exe');
  if (runnable) fs.copyFileSync(process.execPath, binary, fs.constants.COPYFILE_FICLONE);
  else fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), binary), path.join(prefix, 'bin', 'amp'));
  fs.writeFileSync(path.join(prefix, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
  return binary;
}

/** A process kept running, returned once it says it is ready: its file is open by then. */
async function startSession(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
    // A session that cannot start fails its test, not the run (an unhandled ENOENT, CI run 36232894943).
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the session exited (${code}) before it was ready`)));
  });
  return child;
}

function hasLsof(): boolean {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    return true;
  } catch (err) {
    // `lsof -v` prints its version and exits 1 on some systems.
    return (err as { status?: number }).status === 1;
  }
}

describe('claude through its native installer', () => {
  it.skipIf(cannotPlantPosixInstall())('runs `claude update` as one argument, and reads the new version off the link', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const ctx = ctxFor(home);

    const [result] = await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctx);

    expect(result).toMatchObject({ cli: 'claude', outcome: 'updated', from: '1.0.0', to: '1.0.1' });
    expect(recorded()).toEqual([['claude', 'update']]);
    expect(linkedVersion(home)).toBe('1.0.1');
    expect(logLines(ctx)).toHaveLength(1);
    expect(logLines(ctx)[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z claude updated 1\.0\.0 to 1\.0\.1: Successfully updated from 1\.0\.0 to version 1\.0\.1 \(\d+\.\d s\)$/);
  });

  it.skipIf(cannotPlantPosixInstall())('does not wait for a running session, whose version stays on disk', async () => {
    const home = path.join(root, 'home');
    const first = nativeClaude(home);
    const ctx = ctxFor(home);
    // Holding its version open, as a real session holds its mapped binary:
    // anything that waited for running sessions would see this one.
    const session = await startSession(path.join(home, '.local', 'bin', 'claude'), ['run'], ctx.env);

    const result = await updateCli('claude', 'claude', ctx);

    expect(result.outcome).toBe('updated');
    expect(session.exitCode).toBeNull();
    expect(fs.existsSync(first)).toBe(true);
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('takes an update that exits 0 and moves nothing as unchanged, in claude\'s own words', async () => {
    // What `claude update` does under the administrator lockdown, measured on 2.1.280.
    const home = path.join(root, 'home');
    nativeClaude(home);
    const ctx = ctxFor(home, { FAKE_CLAUDE_MODE: 'admin' });

    const result = await updateCli('claude', 'claude', ctx);

    expect(result).toMatchObject({ outcome: 'unchanged', from: '1.0.0' });
    expect(result.to).toBeUndefined();
    expect(result.detail).toBe('Updates are disabled by your administrator. Contact your IT team to get the latest version.');
  });

  it.skipIf(cannotPlantPosixInstall())('logs every failure with the line that explains it', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const ctx = ctxFor(home, { FAKE_CLAUDE_MODE: 'fail' });

    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctx);
    const [result] = await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctx);

    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('Error: Failed to install native update; TelemetrySafeError: connect ECONNREFUSED');
    expect(result.detail).toContain('(exit 1');
    expect(logLines(ctx)).toHaveLength(2);
    expect(linkedVersion(home)).toBe('1.0.0');
  });

  it.skipIf(cannotPlantPosixInstall())('writes a check that changes nothing once, and the next change again', async () => {
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

  it.skipIf(cannotPlantPosixInstall()).each([
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

  it.skipIf(cannotPlantPosixInstall())('reads autoUpdates: false written by the native installer itself as no opinion, as claude does', async () => {
    // JeanBrasse's ~/.claude.json, as the native installer leaves it on every install.
    const home = path.join(root, 'home');
    nativeClaude(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ autoUpdates: false, installMethod: 'native', autoUpdatesProtectedForNative: true }));

    expect((await updateCli('claude', 'claude', ctxFor(home))).outcome).toBe('updated');
  });

  it.skipIf(cannotPlantPosixInstall())('never touches an install that lives outside the home it runs in', async () => {
    // A sandbox or a test run: HOME is a scratch folder, the claude on PATH is the real one.
    const realHome = path.join(root, 'real-home');
    nativeClaude(realHome);
    const sandbox = path.join(root, 'sandbox-home');
    fs.mkdirSync(sandbox);

    const result = await updateCli('claude', 'claude', ctxFor(sandbox, {}, [path.join(realHome, '.local', 'bin')]));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('is outside');
    expect(recorded()).toEqual([]);
    expect(linkedVersion(realHome)).toBe('1.0.0');
  });

  it.skipIf(cannotPlantPosixInstall())('refuses a Settings path that names one version, which the update would never move', async () => {
    const home = path.join(root, 'home');
    const pinned = nativeClaude(home);

    const result = await updateCli('claude', pinned, ctxFor(home));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('one fixed version');
    expect(recorded()).toEqual([]);
  });

  it('says so when claude is not there', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    expect(await updateCli('claude', 'claude', ctxFor(home))).toMatchObject({ outcome: 'skipped', detail: 'not installed: claude not found' });
  });
});

describe('amp as a global npm package', () => {
  // Both of these reach the lsof check, which reads every process on the
  // machine: 1 to 9 s measured here.
  it.skipIf(!hasLsof())('updates the package that owns the binary, by its own name, downloading before it installs', async () => {
    const prefix = path.join(root, 'home', '.nvm', 'versions', 'node', 'v22');
    npmAmp(prefix);
    const home = path.join(root, 'home');
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });

    const [result] = await runCliUpdatePass([{ cli: 'amp', command: path.join(prefix, 'bin', 'amp') }], ctx);

    expect(result).toMatchObject({ cli: 'amp', outcome: 'updated', from: '0.0.1', to: '0.0.2' });
    const npm = recorded();
    expect(npm.map(c => c.slice(0, 2))).toEqual([['npm', 'view'], ['npm', 'install'], ['npm', 'install']]);
    const cache = npm[0][npm[0].indexOf('--cache') + 1];
    // Without retries: a refused connection fails in under a second and says so.
    expect(npm[0]).toEqual(['npm', 'view', '@sourcegraph/amp', 'version', '--prefix', prefix, '--cache', cache, '--fetch-retries=0']);
    // The download goes into a scratch prefix, never the real one...
    const scratch = npm[1][npm[1].indexOf('--prefix') + 1];
    expect(scratch).not.toBe(prefix);
    expect(npm[1]).not.toContain('--global');
    expect(npm[1].at(-1)).toBe('@sourcegraph/amp@0.0.2');
    expect(fs.existsSync(scratch)).toBe(false);
    // ...and only then the install over the real one, from what was downloaded.
    expect(npm[2]).toEqual(['npm', 'install', '--global', '--prefix', prefix, '--cache', cache, '--prefer-offline', '--no-audit', '--no-fund', '@sourcegraph/amp@0.0.2']);
    // One cache for all three, in the scratch folder, gone with it.
    expect(npm[1][npm[1].indexOf('--cache') + 1]).toBe(cache);
    expect(path.dirname(cache)).toBe(path.dirname(scratch));
    expect(fs.existsSync(path.dirname(cache))).toBe(false);
    // `amp update` would have asked for @ampcode/cli, which EEXISTs on this install.
    expect(JSON.stringify(npm)).not.toContain('@ampcode/cli');
    expect(logLines(ctx)[0]).toContain('amp updated 0.0.1 to 0.0.2: npm install -g @sourcegraph/amp@0.0.2');
  }, 60_000);

  it.skipIf(!hasLsof())('waits while a process runs the binary, and updates once it has ended', async () => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    const binary = npmAmp(prefix, '0.0.1', true);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });
    const session = await startSession(path.join(prefix, 'bin', 'amp'), ['-e', "console.log('ready'); setTimeout(() => {}, 60000)"], ctx.env);

    const held = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctx);

    expect(held.outcome).toBe('deferred');
    expect(held.detail).toContain(`pid ${session.pid}`);
    // Not even downloaded: with nothing kept between checks, a download per
    // deferred check would fetch the whole tarball every half hour.
    expect(recorded().map(c => c[1])).toEqual(['view']);
    expect(fs.existsSync(binary)).toBe(true);

    session.kill('SIGKILL');
    await new Promise(resolve => session.once('exit', resolve));

    const done = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctx);
    expect(done).toMatchObject({ outcome: 'updated', from: '0.0.1', to: '0.0.2' });
  }, 120_000);

  it.skipIf(!hasLsof())('asks again after the download, and holds back for an amp started meanwhile', async () => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    const binary = npmAmp(prefix, '0.0.1', true);
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_START_DURING_DOWNLOAD: binary });
    try {
      const result = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctx);

      expect(result.outcome).toBe('deferred');
      expect(result.detail).toContain(`pid ${fs.readFileSync(`${binary}.pid`, 'utf8')}`);
      expect(recorded().map(c => c[1])).toEqual(['view', 'install']);
      expect(recorded().some(c => c.includes('--global'))).toBe(false);
    } finally {
      try { process.kill(Number(fs.readFileSync(`${binary}.pid`, 'utf8')), 'SIGKILL'); } catch { /* not started */ }
    }
  }, 120_000);

  it.skipIf(cannotPlantPosixInstall()).each([
    ['the same version', '0.0.1'],
    ['an older one', '0.0.0'],
    ['the same release with another build hash', '0.0.1-gdeadbe'],
  ])('neither reinstalls nor downgrades when npm offers %s', async (_name, latest) => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    npmAmp(prefix, '0.0.1-gce258b');

    const result = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctxFor(home, { FAKE_LATEST: latest }));

    expect(result.outcome).toBe('unchanged');
    expect(recorded().map(c => c[1])).toEqual(['view']);
  });

  it.skipIf(cannotPlantPosixInstall()).each([
    ['nothing newer', { FAKE_LATEST: '0.0.1' }],
    ['a view that fails', { FAKE_LATEST: '' }],
  ])('keeps npm\'s cache out of the home, and removes it, when there is %s', async (_name, env) => {
    // ~/.npm is never pruned: it kept 38 MB of every Amp release, even of an
    // update that was then deferred.
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    npmAmp(prefix, '0.0.1');

    await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctxFor(home, env));

    const caches = recorded().map(c => c[c.indexOf('--cache') + 1]);
    expect(caches).toHaveLength(1);
    expect(recorded()[0]).toContain('--cache');
    expect(path.relative(home, caches[0]).startsWith('..')).toBe(true);
    expect(fs.existsSync(path.dirname(caches[0]))).toBe(false);
  });

  it.skipIf(cannotPlantPosixInstall())('leaves amp alone when the user turned its updates off in their own settings', async () => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    npmAmp(prefix);
    fs.mkdirSync(path.join(home, '.config', 'amp'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'amp', 'settings.json'), JSON.stringify({ 'amp.updates.mode': 'disabled' }));

    const result = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctxFor(home, { FAKE_LATEST: '0.0.2' }));

    expect(result).toMatchObject({ outcome: 'skipped', detail: 'amp.updates.mode is "disabled" in ~/.config/amp/settings.json' });
    expect(recorded()).toEqual([]);
  });

  it.skipIf(cannotPlantPosixInstall())('never touches a global prefix outside the home it runs in', async () => {
    const prefix = path.join(root, 'elsewhere');
    npmAmp(prefix);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);

    const result = await updateCli('amp', path.join(prefix, 'bin', 'amp'), ctxFor(home, { FAKE_LATEST: '0.0.2' }));

    expect(result.outcome).toBe('skipped');
    expect(recorded()).toEqual([]);
  });
});

describe('the CLIs Tars does not update', () => {
  it.skipIf(cannotPlantPosixInstall())('names one it has no measured path for, and runs nothing', async () => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    npmAmp(prefix, '1.0.0', false, '@openai/codex');

    const result = await updateCli('codex', path.join(prefix, 'bin', 'amp'), ctxFor(home, { FAKE_LATEST: '9.9.9' }));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toBe('installed through npm (@openai/codex); no update path for it has been measured. Update it yourself');
    expect(recorded()).toEqual([]);
  });

  it.skipIf(cannotPlantPosixInstall())('names claude installed any other way than the native installer', async () => {
    const home = path.join(root, 'home');
    const prefix = path.join(home, 'npm-global');
    npmAmp(prefix, '2.1.0', false, '@anthropic-ai/claude-code');

    const result = await updateCli('claude', path.join(prefix, 'bin', 'amp'), ctxFor(home, { FAKE_LATEST: '9.9.9' }));

    expect(result.outcome).toBe('skipped');
    expect(result.detail).toContain('installed through npm (@anthropic-ai/claude-code)');
    expect(recorded()).toEqual([]);
  });
});

describe('the schedule main.ts starts', () => {
  it('starts nothing in an E2E run, which boots the real app in a scratch HOME', () => {
    vi.useFakeTimers();
    process.env.DOROTHY_E2E = '1';
    try {
      startCliUpdates(() => ({}) as AppSettings, () => ['claude']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      delete process.env.DOROTHY_E2E;
      vi.useRealTimers();
    }
  });

  it.skipIf(cannotPlantPosixInstall())('updates the claude a launch would find, 5 s after it starts, into ~/.dorothy/cli-updates.log', async () => {
    // The suite's own throwaway HOME, which is where the app's paths point
    // here: ~/.local/bin is on the PATH buildFullPath composes, and any real
    // CLI further down that PATH lives outside this home and is left alone.
    const home = os.homedir();
    nativeClaude(home);
    process.env.FAKE_CALLS = calls;
    try {
      startCliUpdates(() => ({ cliPaths: { claude: '', amp: '' } }) as unknown as AppSettings, () => ['claude']);
      await vi.waitFor(() => {
        expect(fs.existsSync(CLI_UPDATES_LOG) && fs.readFileSync(CLI_UPDATES_LOG, 'utf8')).toContain('claude updated 1.0.0 to 1.0.1');
      }, { timeout: 30_000, interval: 250 });
      expect(CLI_UPDATES_LOG).toBe(path.join(home, '.dorothy', 'cli-updates.log'));
      expect(recorded()).toEqual([['claude', 'update']]);
      // Whatever else that first pass found on this machine's PATH, a real Amp
      // under ~/.nvm for one, it only named.
      const others = fs.readFileSync(CLI_UPDATES_LOG, 'utf8').split('\n').filter(l => l && !/^\S+ claude /.test(l));
      for (const line of others) expect(line).toMatch(/^\S+ \S+ skipped/);
    } finally {
      delete process.env.FAKE_CALLS;
    }
  }, 60_000);
});
