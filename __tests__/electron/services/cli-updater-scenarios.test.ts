import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCliUpdatePass, updateCli, startCliUpdates, clisInUse, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';
import { cannotPlantPosixInstall } from '../../setup/posix-install-layout';

/**
 * What cli-updater.test.ts does not pin, written by QA at the gate of PR #119:
 * the 5 s and 30 min timers, one pass at a time, one CLI at a time, the first
 * pass naming what it leaves alone, and failure paths the other file does not
 * reach. Thirteen mutants of cli-updater.ts are killed here and nowhere else.
 * Fakes only, scratch folders only.
 */

const NODE_DIR = path.dirname(process.execPath);

// Every test here starts real processes (node scripts, lsof). The first one
// took 546 ms alone and 5036 ms beside two other runs on a loaded machine,
// past vitest's 5 s default: the time is spawning, not the code under test.
vi.setConfig({ testTimeout: 30_000 });

const SLOW_CLAUDE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const log = (x) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(x) + '\\n');
log(['claude-start', args.join(' '), Date.now()]);
const link = path.join(process.env.HOME, '.local/bin/claude');
const versions = path.join(process.env.HOME, '.local/share/claude/versions');
const current = path.basename(fs.realpathSync(link));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_MS || 0));
const mode = process.env.FAKE_CLAUDE_MODE || 'update';
if (args[0] === 'update' && mode === 'update') {
  const next = process.env.FAKE_NEXT || '1.0.1';
  fs.copyFileSync(path.join(versions, current), path.join(versions, next));
  fs.symlinkSync(path.join(versions, next), link + '.tmp');
  fs.renameSync(link + '.tmp', link);
  console.log('Successfully updated from ' + current + ' to version ' + next);
} else if (args[0] === 'update' && mode === 'current') {
  console.log('Claude Code is up to date (' + current + ')');
} else if (args[0] === 'update' && mode === 'unlink') {
  fs.unlinkSync(link);
  console.log('Successfully updated');
}
log(['claude-end', Date.now()]);
`;

const FAKE_NPM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const log = (x) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(x) + '\\n');
log(['npm-start', args[0], args.includes('--global') ? 'global' : 'local', Date.now()]);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.NPM_SLOW_MS || 0));
const mode = process.env.FAKE_NPM_MODE || 'ok';
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); log(['npm-end', Date.now()]); process.exit(0); }
if (args[0] === 'install' && !args.includes('--global') && mode === 'download-fails') {
  console.error('npm error code E404'); log(['npm-end', Date.now()]); process.exit(1);
}
if (args[0] === 'install' && args.includes('--global') && mode !== 'no-change') {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'lib', 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
log(['npm-end', Date.now()]);
process.exit(0);
`;

let root: string;
let calls: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cliupd-')));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const recorded = (): unknown[][] => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const logLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ctxFor(home: string, env: Record<string, string> = {}, dirs?: string[]): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    tmpDir: root,
    env: {
      HOME: home,
      PATH: (dirs ?? [path.join(home, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin']).join(path.delimiter),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

function nativeClaude(home: string, version = '1.0.0'): void {
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(versions, version), SLOW_CLAUDE, { mode: 0o755 });
  fs.symlinkSync(path.join(versions, version), path.join(home, '.local', 'bin', 'claude'));
}

function npmAmp(prefix: string, version = '0.0.1'): string {
  const pkgDir = path.join(prefix, 'lib', 'node_modules', '@sourcegraph', 'amp');
  const binDir = path.join(pkgDir, 'node_modules', '@ampcode', 'cli', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@sourcegraph/amp', version }));
  fs.writeFileSync(path.join(binDir, 'amp.exe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), path.join(binDir, 'amp.exe')), path.join(prefix, 'bin', 'amp'));
  fs.writeFileSync(path.join(prefix, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
  return path.join(prefix, 'bin', 'amp');
}

type Captured = { fn: () => void; ms: number; unref: boolean };

function captureTimers(run: () => void): { timeouts: Captured[]; intervals: Captured[] } {
  const timeouts: Captured[] = [];
  const intervals: Captured[] = [];
  const fake = (into: Captured[]) => ((fn: () => void, ms: number) => {
    const t: Captured = { fn, ms, unref: false };
    into.push(t);
    return { unref() { t.unref = true; } };
  }) as never;
  const st = vi.spyOn(globalThis, 'setTimeout').mockImplementation(fake(timeouts));
  const si = vi.spyOn(globalThis, 'setInterval').mockImplementation(fake(intervals));
  try {
    run();
  } finally {
    st.mockRestore();
    si.mockRestore();
  }
  return { timeouts, intervals };
}

describe('QA #119: the schedule', () => {
  it('Q1 arms the first pass at 5 s and the next every 30 min, neither holding the app open', () => {
    const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => ({}) as AppSettings, () => []));
    expect(timeouts.map(t => [t.ms, t.unref])).toEqual([[5000, true]]);
    expect(intervals.map(t => [t.ms, t.unref])).toEqual([[30 * 60 * 1000, true]]);
  });

  it.skipIf(cannotPlantPosixInstall())('Q2 first pass updates claude and names an installed CLI it leaves alone; a tick during a pass starts nothing; the next tick runs', async () => {
    const home = os.homedir();
    nativeClaude(home, '1.0.0');
    const codexRan = path.join(root, 'codex-ran');
    fs.writeFileSync(path.join(home, '.local', 'bin', 'codex'), `#!/bin/sh\necho ran >> '${codexRan}'\n`, { mode: 0o755 });
    const keys = ['FAKE_CALLS', 'SLOW_MS', 'FAKE_NEXT', 'FAKE_CLAUDE_MODE'];
    Object.assign(process.env, { FAKE_CALLS: calls, SLOW_MS: '1500', FAKE_NEXT: '1.0.1' });
    // The scheduled pass searches the PATH the app has, and the directory that
    // holds node can hold real CLIs too (an nvm bin holds a global Amp): a
    // node on its own, so this pass sees the fakes and nothing real.
    const nodeOnly = path.join(root, 'node-only');
    fs.mkdirSync(nodeOnly);
    // A script, not a link: removing a link to the real node reads as a write
    // into the real home to the suite's isolation guard.
    fs.writeFileSync(path.join(nodeOnly, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [nodeOnly, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    try {
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => ({ cliPaths: {} }) as unknown as AppSettings, () => ['claude', 'codex']));
      const [first] = timeouts;
      const [tick] = intervals;

      first.fn();
      await sleep(400);
      tick.fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / codex skipped/.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      await sleep(300);

      expect(recorded().filter(c => c[0] === 'claude-start')).toHaveLength(1);
      expect(fs.existsSync(codexRan)).toBe(false);
      const one = logLines(CLI_UPDATES_LOG);
      expect(one.filter(l => / claude updated 1\.0\.0 to 1\.0\.1: /.test(l))).toHaveLength(1);
      expect(one.filter(l => / codex skipped: installed through .*no update path for it has been measured/.test(l))).toHaveLength(1);
      // No agent runs Amp: named once, never looked for.
      expect(one.filter(l => / amp skipped: no agent runs it, so Tars does not check it$/.test(l))).toHaveLength(1);

      Object.assign(process.env, { SLOW_MS: '0', FAKE_CLAUDE_MODE: 'current' });
      tick.fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / claude unchanged 1\.0\.1: Claude Code is up to date/.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      await sleep(300);
      expect(recorded().filter(c => c[0] === 'claude-start')).toHaveLength(2);
      expect(logLines(CLI_UPDATES_LOG).filter(l => / codex /.test(l))).toHaveLength(1);
    } finally {
      for (const k of keys) delete process.env[k];
      process.env.PATH = savedPath;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('Q3 runs one CLI at a time within a pass', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }, { cli: 'amp', command: amp }], ctxFor(home, { SLOW_MS: '1200', FAKE_LATEST: '0.0.1' }));
    const c = recorded();
    const claudeEnd = c.find(x => x[0] === 'claude-end')![1] as number;
    const npmStart = c.find(x => x[0] === 'npm-start')![3] as number;
    expect(npmStart).toBeGreaterThanOrEqual(claudeEnd);
  }, 30_000);
});

describe('QA #119: what the log says', () => {
  it.skipIf(cannotPlantPosixInstall())('Q4 logs two successive updates, one per pass', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.1' }));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.2' }));
    const lines = logLines(path.join(root, 'cli-updates.log'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('claude updated 1.0.1 to 1.0.2');
  });

  it.skipIf(cannotPlantPosixInstall())('Q8 reports a link that is gone after the update as a failure', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const r = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'unlink' }));
    expect(r.outcome).toBe('failed');
  });

  it.skipIf(cannotPlantPosixInstall())('Q10 finds an install under a home reached through a symlink', async () => {
    const real = path.join(root, 'real-home');
    nativeClaude(real);
    const alias = path.join(root, 'alias-home');
    fs.symlinkSync(real, alias);
    const r = await updateCli('claude', 'claude', ctxFor(alias, {}, [path.join(alias, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin']));
    expect(r.outcome).toBe('updated');
  });

  it.skipIf(cannotPlantPosixInstall())('Q11 moves a log past 256 KB to .1 and starts a new one', async () => {
    const home = path.join(root, 'home');
    nativeClaude(home);
    const log = path.join(root, 'cli-updates.log');
    fs.writeFileSync(log, 'x'.repeat(256 * 1024 + 1));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_CLAUDE_MODE: 'current' }));
    expect(fs.statSync(`${log}.1`).size).toBe(256 * 1024 + 1);
    expect(logLines(log)).toHaveLength(1);
  });
});

describe('QA #119: Amp paths the PR tests do not reach', () => {
  it.skipIf(cannotPlantPosixInstall())('Q5 holds an update back when it cannot tell whether Amp is running (no lsof)', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    // lsof is in /usr/sbin on macOS and in /usr/bin on Linux: every folder that
    // holds one is left off, whichever machine this runs on.
    const dirs = [path.join(home, '.local', 'bin'), NODE_DIR, '/usr/bin', '/bin'].filter(dir => !fs.existsSync(path.join(dir, 'lsof')));
    expect(dirs, 'the folder that holds node was left off too: it holds an lsof').toContain(NODE_DIR);
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2' }, dirs));
    expect(r.outcome).toBe('deferred');
    expect(r.detail).toContain('could not be checked');
    expect(recorded().some(c => c[0] === 'npm-start' && c[2] === 'global')).toBe(false);
  });

  it.skipIf(cannotPlantPosixInstall())('Q6 installs nothing when the download fails', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'download-fails' }));
    expect(r.outcome).toBe('failed');
    expect(r.detail).toContain('downloading @sourcegraph/amp@0.0.2');
    expect(recorded().some(c => c[0] === 'npm-start' && c[2] === 'global')).toBe(false);
  });

  it.skipIf(cannotPlantPosixInstall())('Q7 does not call an install that left the old version in place an update', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'no-change' }));
    expect(r.outcome).toBe('failed');
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('Q9 takes a minor release as newer', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.5');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.1.0' }));
    expect(r).toMatchObject({ outcome: 'updated', from: '0.0.5', to: '0.1.0' });
  }, 60_000);
});

describe('one switch, and only the CLIs the fleet runs (JeanBrasse, 2026-09-23)', () => {
  it.skipIf(cannotPlantPosixInstall())('U1 checks no CLI while "Check for updates" is off, says so once, and checks again once it is back on', async () => {
    const home = os.homedir();
    nativeClaude(home, '1.0.0');
    process.env.FAKE_CALLS = calls;
    process.env.FAKE_NEXT = '1.0.1';
    const nodeOnly = path.join(root, 'node-only');
    fs.mkdirSync(nodeOnly);
    fs.writeFileSync(path.join(nodeOnly, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [nodeOnly, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    const settings = { cliPaths: {}, autoCheckUpdates: false } as unknown as AppSettings;
    try {
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => settings, () => ['claude']));

      timeouts[0].fn();
      intervals[0].fn();
      await sleep(500);
      expect(recorded(), 'a CLI was checked with the switch off').toEqual([]);
      expect(logLines(CLI_UPDATES_LOG).filter(l => / all off: "Check for updates" is off in Settings/.test(l))).toHaveLength(1);

      settings.autoCheckUpdates = true;
      intervals[0].fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / claude updated 1\.0\.0 to 1\.0\.1: /.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
    } finally {
      delete process.env.FAKE_CALLS;
      delete process.env.FAKE_NEXT;
      process.env.PATH = savedPath;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('U2 leaves an installed Amp alone on a fleet with no Amp agent, and updates it once one runs it', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(path.join(home, 'npm-global'), '0.0.1');
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });

    const [unused] = await runCliUpdatePass([{ cli: 'amp', command: amp, inUse: false }], ctx);
    expect(unused).toMatchObject({ outcome: 'skipped', detail: 'no agent runs it, so Tars does not check it' });
    expect(recorded(), 'npm was run for an Amp no agent uses').toEqual([]);

    const [used] = await runCliUpdatePass([{ cli: 'amp', command: amp, inUse: true }], ctx);
    expect(used.outcome).not.toBe('skipped');
    expect(recorded().length).toBeGreaterThan(0);
  }, 60_000);

  it('U3 reads the fleet by provider: no provider is Claude, the thirteen other vendors run claude, Amp runs amp', () => {
    expect([...clisInUse([])]).toEqual([]);
    expect([...clisInUse([undefined, 'claude', 'minimax' as never])]).toEqual(['claude']);
    expect(clisInUse(['claude', 'amp' as never, 'codex' as never])).toEqual(new Set(['claude', 'amp', 'codex']));
  });
});

/**
 * What U1 to U3 leave open, written by QA at the gate of PR #140.
 *
 * U1's "back on" half reads the shared log, where Q2 has already written the
 * line it looks for, so it holds whatever the switch does once it is back on.
 * Here a pass is counted by the fake CLI's own calls, in this test's file, and
 * a log line by what it adds to the log. A tick that lands while a pass is
 * still running does nothing, so each step waits for its pass to end.
 */
describe('QA #140: the switch at every tick, and the fleet at every tick', () => {
  const runs = () => recorded().filter(c => c[0] === 'claude-end').length;
  const count = (re: RegExp) => logLines(CLI_UPDATES_LOG).filter(l => re.test(l)).length;
  const OFF = / all off: "Check for updates" is off in Settings, so no CLI is checked$/;
  const NOT_RUN = / claude skipped: no agent runs it, so Tars does not check it$/;

  /** Waits for claude to have been run `n` times in all, and for that pass to be over. */
  async function passes(n: number) {
    await vi.waitFor(() => expect(runs()).toBe(n), { timeout: 20_000, interval: 100 });
    await sleep(500);
  }

  async function scheduled(getSettings: () => AppSettings, fleet: Array<string | undefined>, body: (tick: () => void) => Promise<void>) {
    const home = os.homedir();
    nativeClaude(home, '1.0.0');
    Object.assign(process.env, { FAKE_CALLS: calls, FAKE_CLAUDE_MODE: 'current' });
    const nodeOnly = path.join(root, 'node-only');
    fs.mkdirSync(nodeOnly);
    fs.writeFileSync(path.join(nodeOnly, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = [nodeOnly, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    try {
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(getSettings, () => fleet as never));
      let fired = false;
      await body(() => { (fired ? intervals[0] : timeouts[0]).fn(); fired = true; });
    } finally {
      delete process.env.FAKE_CALLS;
      delete process.env.FAKE_CLAUDE_MODE;
      process.env.PATH = savedPath;
      fs.rmSync(path.join(home, '.local'), { recursive: true, force: true });
    }
  }

  // Settings are saved the way app:saveSettings saves them: a new object each
  // time, never the one the updater was started with changed in place.
  it.skipIf(cannotPlantPosixInstall())('V1 checks again at the next tick once the switch is back on, counted by the CLI it runs', async () => {
    let settings = { cliPaths: {}, autoCheckUpdates: false } as unknown as AppSettings;
    await scheduled(() => settings, ['claude'], async tick => {
      tick();
      await sleep(800);
      expect(recorded(), 'a CLI was run with the switch off').toEqual([]);
      settings = { ...settings, autoCheckUpdates: true };
      tick();
      await passes(1);
    });
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('V2 stops at the next tick when the switch is turned off after a pass, says so once, and resumes when it is back on', async () => {
    let settings = { cliPaths: {}, autoCheckUpdates: true } as unknown as AppSettings;
    await scheduled(() => settings, ['claude'], async tick => {
      tick();
      await passes(1);
      const before = count(OFF);
      settings = { ...settings, autoCheckUpdates: false };
      tick();
      tick();
      await sleep(800);
      expect(runs(), 'claude was run after the switch was turned off').toBe(1);
      expect(count(OFF) - before, 'the off line, once for two ticks').toBe(1);
      settings = { ...settings, autoCheckUpdates: true };
      tick();
      await passes(2);
    });
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('V3 leaves an installed claude alone once no agent runs it, says so, and checks it again when one does', async () => {
    const settings = { cliPaths: {}, autoCheckUpdates: true } as unknown as AppSettings;
    const fleet: Array<string | undefined> = ['claude'];
    await scheduled(() => settings, fleet, async tick => {
      tick();
      await passes(1);
      const before = count(NOT_RUN);
      fleet.splice(0, fleet.length, 'codex');
      tick();
      await vi.waitFor(() => expect(count(NOT_RUN)).toBe(before + 1), { timeout: 20_000, interval: 100 });
      await sleep(500);
      expect(recorded().filter(c => c[0] === 'claude-start'), 'claude was run for a fleet that does not run it').toHaveLength(1);
      fleet.push('claude');
      tick();
      await passes(2);
    });
  }, 60_000);

  it.skipIf(cannotPlantPosixInstall())('V4 counts an agent with no provider as a claude agent, as every launch does', async () => {
    const settings = { cliPaths: {}, autoCheckUpdates: true } as unknown as AppSettings;
    await scheduled(() => settings, [undefined], async tick => {
      tick();
      await passes(1);
    });
  }, 60_000);

  it('V5 logs a skip whose reason changed: an Amp no agent ran, then one an agent runs that is not installed', async () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    // No node folder on this PATH: the one that holds node can hold a real Amp.
    const ctx = ctxFor(home, {}, [path.join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    await runCliUpdatePass([{ cli: 'amp', command: 'amp', inUse: false }], ctx);
    await runCliUpdatePass([{ cli: 'amp', command: 'amp', inUse: true }], ctx);
    const lines = logLines(ctx.logFile);
    expect(lines.filter(l => / amp skipped: no agent runs it/.test(l)), lines.join('\n')).toHaveLength(1);
    expect(lines.filter(l => / amp skipped: not installed: amp not found$/.test(l)), 'the new reason was not logged').toHaveLength(1);
  });
});
