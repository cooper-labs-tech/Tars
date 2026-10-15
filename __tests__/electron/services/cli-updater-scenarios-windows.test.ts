import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The busy check's PowerShell query is answered from a process table: see
// cli-updater-windows-fakes.ts. cli-updater-windows.test.ts 10b asks the real one.
vi.mock('child_process', async (importOriginal) => {
  const { childProcessForTests } = await import('./cli-updater-windows-fakes');
  return childProcessForTests(await importOriginal<typeof import('child_process')>());
});

import { nativeClaudeExe, nodeAs, npmPackage, npmPrefixWith, processTable, requirePreload } from './cli-updater-windows-fakes';
import { runCliUpdatePass, updateCli, startCliUpdates, CLI_UPDATES_LOG, type CliUpdateContext } from '../../../electron/services/cli-updater';
import type { AppSettings } from '../../../electron/types';

/**
 * QA's scenarios of cli-updater-scenarios.test.ts, on the Windows layout.
 *
 * That file plants the macOS and Linux layout (a link to an extensionless
 * script, <prefix>/lib/node_modules) and skips on Windows since CI run
 * 36232894943, where its 15 layout tests ran on windows-latest for the first
 * time and the updater rightly refused the script. What it pins is not the
 * layout: the schedule (one pass at a time, one CLI at a time, the first pass
 * naming what it leaves alone), the log, the switch and the fleet at every
 * tick, and the failure paths of an npm update. Each is here with the same
 * assertions, over claude.exe copies and npm's .cmd shims (the layouts of
 * cli-updater-windows.test.ts). Its Q1, U3 and V5 plant nothing and run on
 * Windows as they are; Q5 (no lsof) is test 11 of cli-updater-windows.test.ts,
 * PowerShell being what Windows lists processes with.
 *
 * How it fails, the scenarios' own list, on Windows:
 * Q2. The first pass does not update claude, or does not name an installed
 *     CLI it leaves alone, or runs it; a tick during a pass starts a second.
 * Q3. Two CLIs of one pass run at once.
 * Q4. Two successive updates are logged as one.
 * Q8. A launcher that is gone after the update is reported as a success.
 * Q10. An install under a home reached through a link (a junction here) is
 *     taken as outside the home.
 * Q11. The log grows past 256 KB instead of moving to .1.
 * Q6. The download fails and the install runs anyway.
 * Q7. An install that left the old version in place is called an update.
 * Q9. A minor release is not taken as newer.
 * U1. A CLI is checked with "Check for updates" off, the off line is not
 *     written once, or checking does not resume once it is back on.
 * U2. npm runs for an Amp no agent uses, or not once one does.
 * V1 to V4. The switch or the fleet is read once instead of at every tick,
 *     or an agent with no provider is not counted as a claude agent.
 */

const onWindows = process.platform === 'win32';

vi.setConfig({ testTimeout: 30_000 });

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

/**
 * Preloaded into every node the tests start. As claude.exe (this run's
 * node.exe under that name) it acts as the scenarios' slow claude does, on the
 * Windows installer's layout; as codex.exe it records that it ran.
 */
const FAKE_CLIS = `
const fs = require('fs'), path = require('path');
const exe = path.basename(process.execPath).toLowerCase();
if (exe === 'codex.exe') { fs.appendFileSync(path.join(__dirname, 'codex-ran'), 'ran\\n'); process.exit(0); }
if (exe === 'claude.exe' && process.argv[1]) {
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  const log = (x) => fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(x) + '\\n');
  log(['claude-start', args.join(' '), Date.now()]);
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_MS || 0));
  const mode = process.env.FAKE_CLAUDE_MODE || 'update';
  if (args[0] === 'update' && mode === 'update') {
    const next = process.env.FAKE_NEXT || '1.0.1';
    settle(() => fs.copyFileSync(path.join(versions, current), path.join(versions, next)));
    settle(() => fs.appendFileSync(path.join(versions, next), Buffer.alloc(16 + next.length)));
    const old = launcher + '.old.' + Date.now();
    settle(() => fs.renameSync(launcher, old));
    settle(() => fs.copyFileSync(path.join(versions, next), launcher));
    try { fs.unlinkSync(old); } catch { /* running, as claude leaves it */ }
    console.log('Successfully updated from ' + current + ' to version ' + next);
  } else if (args[0] === 'update' && mode === 'current') {
    console.log('Claude Code is up to date (' + current + ')');
  } else if (args[0] === 'update' && mode === 'unlink') {
    // A running exe cannot be deleted on Windows: set aside, and nothing put back.
    settle(() => fs.renameSync(launcher, launcher + '.old.' + Date.now()));
    console.log('Successfully updated');
  }
  log(['claude-end', Date.now()]);
  process.exit(0);
}
`;

/** The scenarios' npm, on Windows's global layout: <prefix>\\node_modules, no lib. */
const FAKE_NPM = `
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
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
log(['npm-end', Date.now()]);
process.exit(0);
`;

let root: string;
let calls: string;
let preload: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cliupd-win-')));
  calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  preload = path.join(root, 'fake-clis.cjs');
  fs.writeFileSync(preload, FAKE_CLIS);
});

afterEach(async () => {
  processTable.mode = 'fake';
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 60_000);

const recorded = (): unknown[][] => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const logLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ctxFor(home: string, env: Record<string, string> = {}, dirs?: string[]): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    tmpDir: root,
    env: {
      USERPROFILE: home,
      HOME: home,
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: (dirs ?? [path.join(home, '.local', 'bin'), path.join(home, 'AppData', 'Roaming', 'npm'), SYSTEM32]).join(';'),
      NODE_OPTIONS: requirePreload(preload),
      FAKE_CALLS: calls,
      ...env,
    },
  };
}

/** amp.cmd over @sourcegraph/amp at `version`, in the home's %APPDATA%\npm with the scenarios' npm. The command is `amp`. */
function npmAmp(home: string, version = '0.0.1'): string {
  npmPackage(npmPrefixWith(home, FAKE_NPM), version);
  return 'amp';
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

/**
 * The environment the scheduled passes read (process.env): the suite's
 * throwaway home, a PATH narrowed to System32 so no CLI of this machine's is
 * on it (buildFullPath adds the home's own folders), and the fakes preloaded.
 */
async function withScheduledEnv(vars: Record<string, string>, body: (home: string) => Promise<void>): Promise<void> {
  const home = os.homedir();
  const keys = ['PATH', 'NODE_OPTIONS', 'FAKE_CALLS', ...Object.keys(vars)];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PATH: SYSTEM32, NODE_OPTIONS: requirePreload(preload), FAKE_CALLS: calls }, vars);
  try {
    await body(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(path.join(home, '.local'), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

describe.skipIf(!onWindows)('QA #119: the schedule, on Windows', () => {
  it('Q2 first pass updates claude and names an installed CLI it leaves alone; a tick during a pass starts nothing; the next tick runs', async () => {
    await withScheduledEnv({ SLOW_MS: '1500', FAKE_NEXT: '1.0.1', FAKE_CLAUDE_MODE: 'update' }, async home => {
      nativeClaudeExe(home, '1.0.0');
      nodeAs(path.join(home, '.local', 'bin', 'codex.exe'));
      const codexRan = path.join(root, 'codex-ran');
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
      expect(one.filter(l => / amp skipped: no agent runs it, so Tars does not check it$/.test(l))).toHaveLength(1);

      Object.assign(process.env, { SLOW_MS: '0', FAKE_CLAUDE_MODE: 'current' });
      tick.fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / claude unchanged 1\.0\.1: Claude Code is up to date/.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      await sleep(300);
      expect(recorded().filter(c => c[0] === 'claude-start')).toHaveLength(2);
      expect(logLines(CLI_UPDATES_LOG).filter(l => / codex /.test(l))).toHaveLength(1);
    });
  }, 60_000);

  it('Q3 runs one CLI at a time within a pass', async () => {
    const home = path.join(root, 'home');
    nativeClaudeExe(home);
    const amp = npmAmp(home, '0.0.1');
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }, { cli: 'amp', command: amp }], ctxFor(home, { SLOW_MS: '1200', FAKE_LATEST: '0.0.1' }));
    const c = recorded();
    const claudeEnd = c.find(x => x[0] === 'claude-end')![1] as number;
    const npmStart = c.find(x => x[0] === 'npm-start')![3] as number;
    expect(npmStart).toBeGreaterThanOrEqual(claudeEnd);
  });
});

describe.skipIf(!onWindows)('QA #119: what the log says, on Windows', () => {
  it('Q4 logs two successive updates, one per pass', async () => {
    const home = path.join(root, 'home');
    nativeClaudeExe(home);
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.1' }));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_NEXT: '1.0.2' }));
    const lines = logLines(path.join(root, 'cli-updates.log'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('claude updated 1.0.1 to 1.0.2');
  });

  it('Q8 reports a launcher that is gone after the update as a failure', async () => {
    const home = path.join(root, 'home');
    nativeClaudeExe(home);
    const r = await updateCli('claude', 'claude', ctxFor(home, { FAKE_CLAUDE_MODE: 'unlink' }));
    expect(r.outcome).toBe('failed');
  });

  it('Q10 finds an install under a home reached through a junction', async () => {
    const real = path.join(root, 'real-home');
    nativeClaudeExe(real);
    const alias = path.join(root, 'alias-home');
    // A junction: the link to a folder any Windows account may make (decision D4).
    fs.symlinkSync(real, alias, 'junction');
    const r = await updateCli('claude', 'claude', ctxFor(alias, {}, [path.join(alias, '.local', 'bin'), SYSTEM32]));
    expect(r.outcome).toBe('updated');
  });

  it('Q11 moves a log past 256 KB to .1 and starts a new one', async () => {
    const home = path.join(root, 'home');
    nativeClaudeExe(home);
    const log = path.join(root, 'cli-updates.log');
    fs.writeFileSync(log, 'x'.repeat(256 * 1024 + 1));
    await runCliUpdatePass([{ cli: 'claude', command: 'claude' }], ctxFor(home, { FAKE_CLAUDE_MODE: 'current' }));
    expect(fs.statSync(`${log}.1`).size).toBe(256 * 1024 + 1);
    expect(logLines(log)).toHaveLength(1);
  });
});

describe.skipIf(!onWindows)('QA #119: Amp paths the PR tests do not reach, on Windows', () => {
  it('Q6 installs nothing when the download fails', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(home, '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'download-fails' }));
    expect(r.outcome).toBe('failed');
    expect(r.detail).toContain('downloading @sourcegraph/amp@0.0.2');
    expect(recorded().some(c => c[0] === 'npm-start' && c[2] === 'global')).toBe(false);
  });

  it('Q7 does not call an install that left the old version in place an update', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(home, '0.0.1');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.0.2', FAKE_NPM_MODE: 'no-change' }));
    expect(r.outcome).toBe('failed');
  });

  it('Q9 takes a minor release as newer', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(home, '0.0.5');
    const r = await updateCli('amp', amp, ctxFor(home, { FAKE_LATEST: '0.1.0' }));
    expect(r).toMatchObject({ outcome: 'updated', from: '0.0.5', to: '0.1.0' });
  });
});

describe.skipIf(!onWindows)('one switch, and only the CLIs the fleet runs (JeanBrasse, 2026-09-23), on Windows', () => {
  it('U1 checks no CLI while "Check for updates" is off, says so once, and checks again once it is back on', async () => {
    await withScheduledEnv({ FAKE_NEXT: '1.0.1' }, async home => {
      nativeClaudeExe(home, '1.0.0');
      const settings = { cliPaths: {}, autoCheckUpdates: false } as unknown as AppSettings;
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(() => settings, () => ['claude']));

      timeouts[0].fn();
      intervals[0].fn();
      await sleep(500);
      expect(recorded(), 'a CLI was checked with the switch off').toEqual([]);
      expect(logLines(CLI_UPDATES_LOG).filter(l => / all off: "Check for updates" is off in Settings/.test(l))).toHaveLength(1);

      settings.autoCheckUpdates = true;
      intervals[0].fn();
      await vi.waitFor(() => expect(logLines(CLI_UPDATES_LOG).some(l => / claude updated 1\.0\.0 to 1\.0\.1: /.test(l))).toBe(true), { timeout: 20_000, interval: 100 });
      // Q2 wrote that line to the same log already: the claude this test's
      // pass ran, in this test's own record, is what shows the switch let it
      // through. Waiting for it also keeps the pass from outliving the test
      // and its fakes (seen once: a pass run after the fakes were removed).
      await vi.waitFor(() => expect(recorded().filter(c => c[0] === 'claude-end')).toHaveLength(1), { timeout: 20_000, interval: 100 });
      await sleep(500);
    });
  }, 60_000);

  it('U2 leaves an installed Amp alone on a fleet with no Amp agent, and updates it once one runs it', async () => {
    const home = path.join(root, 'home');
    const amp = npmAmp(home, '0.0.1');
    const ctx = ctxFor(home, { FAKE_LATEST: '0.0.2' });

    const [unused] = await runCliUpdatePass([{ cli: 'amp', command: amp, inUse: false }], ctx);
    expect(unused).toMatchObject({ outcome: 'skipped', detail: 'no agent runs it, so Tars does not check it' });
    expect(recorded(), 'npm was run for an Amp no agent uses').toEqual([]);

    const [used] = await runCliUpdatePass([{ cli: 'amp', command: amp, inUse: true }], ctx);
    expect(used.outcome).not.toBe('skipped');
    expect(recorded().length).toBeGreaterThan(0);
  });
});

/** QA #140's cases, on Windows: see cli-updater-scenarios.test.ts for why each step waits for its pass. */
describe.skipIf(!onWindows)('QA #140: the switch at every tick, and the fleet at every tick, on Windows', () => {
  const runs = () => recorded().filter(c => c[0] === 'claude-end').length;
  const count = (re: RegExp) => logLines(CLI_UPDATES_LOG).filter(l => re.test(l)).length;
  const OFF = / all off: "Check for updates" is off in Settings, so no CLI is checked$/;
  const NOT_RUN = / claude skipped: no agent runs it, so Tars does not check it$/;

  async function passes(n: number) {
    await vi.waitFor(() => expect(runs()).toBe(n), { timeout: 20_000, interval: 100 });
    await sleep(500);
  }

  async function scheduled(getSettings: () => AppSettings, fleet: Array<string | undefined>, body: (tick: () => void) => Promise<void>) {
    await withScheduledEnv({ FAKE_CLAUDE_MODE: 'current' }, async home => {
      nativeClaudeExe(home, '1.0.0');
      const { timeouts, intervals } = captureTimers(() => startCliUpdates(getSettings, () => fleet as never));
      let fired = false;
      await body(() => { (fired ? intervals[0] : timeouts[0]).fn(); fired = true; });
    });
  }

  it('V1 checks again at the next tick once the switch is back on, counted by the CLI it runs', async () => {
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

  it('V2 stops at the next tick when the switch is turned off after a pass, says so once, and resumes when it is back on', async () => {
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

  it('V3 leaves an installed claude alone once no agent runs it, says so, and checks it again when one does', async () => {
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

  it('V4 counts an agent with no provider as a claude agent, as every launch does', async () => {
    const settings = { cliPaths: {}, autoCheckUpdates: true } as unknown as AppSettings;
    await scheduled(() => settings, [undefined], async tick => {
      tick();
      await passes(1);
    });
  }, 60_000);
});
