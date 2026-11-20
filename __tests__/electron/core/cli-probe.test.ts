import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { CMD_SHIM_NODE } from '../services/cli-updater-windows-fakes';
import { skipOnWindows } from '../../setup/platform-limits';

/**
 * One way for Tars to run a one-shot CLI probe (electron/core/cli-probe.ts, probeCli), so a probe never outlives its
 * give-up or the app's quit (the Audit's report on probe orphans, 20/11, read at #608's head 715455c8b). QA found four
 * orphans of PID 1, 4 to 6 h old: a codex stand-in's `--help` and `login status`, left by the create-agent spec after
 * the sandboxed app had quit within 10 s of a codex launch. probeVersion (version-probe.ts) is the model: a process
 * group of its own, the whole group SIGKILLed at its time, tracked, ended at the quit, refused once the quit began.
 *
 * How it fails, written before the code:
 *  1. (P1-P3) What a probe starts outlives its give-up: execFile's timeout signals the binary alone, never its group.
 *  2. A probe deaf to SIGTERM outlives its give-up (an interactive zsh is, measured: codex-cli.ts).
 *  3. A probe still running when the quit begins outlives it, and what it started too: nothing tracks it.
 *  4. A probe asked once the quit has begun is started.
 *  5. Over-correction: an answer in time loses its output; a failure is not told with its exit code and its words
 *     (codex's `login status` is read by its exit 1 and "Not logged in"); a binary Tars cannot start is spawned, or
 *     fails as a run that failed (callers tell CliNotRunnableError apart: gws says it).
 *  6. An answer past its cap is kept whole: the probe goes on and its memory grows (execFile's maxBuffer ended it).
 *  7. A read that answers before its process ends (a login shell whose rc file leaves a job running) waits out its
 *     whole time, or leaves what still runs after its answer.
 *  8. (P1) A codex that never answers `--help` is read twice per launch: codexAccepts reads again in the background
 *     after the launch's own read failed (#608 asks `--no-daemon` on every line).
 *  9. (P1, P2) codex's `--help` and `login status`, and the login shell's CODEX_HOME read (P3), are not ended at the
 *     quit with what they started.
 * 10. (P3) A one-shot probe of a CLI goes around probeCli (execFile, exec, execCli, a spawn of its own): codex's
 *     `--help` and `login status`, the login shells, gws's `auth status`, tailscale's `status`, `claude mcp list`.
 * 11. The quit's first pass does not end the CLI probes.
 * On Windows there is no process group: the probe's tree is ended by taskkill /T while it runs, never by its id once
 * it has exited (version-probe-windows.test.ts holds it, probeVersion being probeCli now).
 */

const ELECTRON = path.join(__dirname, '../../../electron');
const DEAF_REASON = 'Windows has no SIGTERM to be deaf to: taskkill /T /F ends the tree; this runs on macOS, Linux and CI';
const SHELL_REASON = 'Windows runs no login shell: loginShellCodexHome answers undefined there, and nothing is started';

type Pid = { role: string; pid: number; argv: string[] };

/** A stand-in CLI in node: it notes its pid, then runs `body`. On Windows, behind npm's .cmd shim, as an npm install. */
function standIn(body: string): { bin: string; dir: string; pids: () => Pid[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cli-probe-'));
  const script = [
    "const fs = require('fs'); const { spawn } = require('child_process');",
    "const note = (role, pid) => fs.appendFileSync(__filename + '.pids', JSON.stringify({ role, pid, argv: process.argv.slice(2) }) + '\\n');",
    "note('probe', process.pid);",
    // A child of its own, deaf to SIGTERM, as a daemon a CLI starts: only its group, or its tree, reaches it.
    "const child = () => { const c = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); note('child', c.pid); };",
    'const hang = () => setInterval(() => {}, 1000);',
    body,
    '',
  ].join('\n');
  let bin = path.join(dir, 'stand-in');
  let mark = bin;
  if (process.platform === 'win32') {
    mark = path.join(dir, 'stand-in.js');
    fs.writeFileSync(mark, script);
    bin = path.join(dir, 'stand-in.cmd');
    fs.writeFileSync(bin, CMD_SHIM_NODE('stand-in.js'));
  } else {
    fs.writeFileSync(bin, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  }
  const pids = () => (fs.existsSync(`${mark}.pids`) ? fs.readFileSync(`${mark}.pids`, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Pid) : []);
  return { bin, dir, pids };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await settle(50)) if (ok()) return;
  throw new Error(`never: ${what}`);
}
/** Every process the stand-in noted is gone within `ms`, else the test fails, having ended them by their pids. */
async function allGone(pids: () => Pid[], ms = 3_000): Promise<Pid[]> {
  for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (pids().every(p => !alive(p.pid))) return [];
  const left = pids().filter(p => alive(p.pid));
  for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  return left;
}

async function fresh() {
  vi.resetModules();
  const quit = await import('../../../electron/core/quit-state');
  const probe = await import('../../../electron/core/cli-probe');
  const codex = await import('../../../electron/providers/codex-cli');
  const exec = await import('../../../electron/providers/cli-exec');
  return { quit, probe, codex, exec };
}

describe('a one-shot probe of a CLI', () => {
  it('1. given up on, it ends with what it started', async () => {
    const { probe } = await fresh();
    const s = standIn('child(); hang();');
    try {
      // Its time long enough for the stand-in and its child to be running when it comes, even under a load of 25 (an
      // 800 ms one ended a stand-in that had not yet started, and the case held nothing).
      const began = Date.now();
      const answer = probe.probeCli(s.bin, ['--help'], { timeoutMs: 6_000 }).then(() => null, (err: unknown) => err);
      await until('the stand-in and its child started', () => s.pids().length === 2, 6_000);
      expect(await answer).toMatchObject({ reason: 'timeout' });
      expect(Date.now() - began).toBeLessThan(15_000);
      expect(s.pids().map(p => p.role).sort()).toEqual(['child', 'probe']);
      expect(await allGone(s.pids), 'left running after its give-up').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(skipOnWindows(DEAF_REASON))('2. deaf to SIGTERM, it still ends at its give-up', async () => {
    const { probe } = await fresh();
    const s = standIn("process.on('SIGTERM', () => {}); hang();");
    try {
      // Running, and deaf, when its time comes: see case 1.
      const answer = probe.probeCli(s.bin, ['--help'], { timeoutMs: 6_000 }).then(() => null, (err: unknown) => err);
      await until('the stand-in started', () => s.pids().length === 1, 6_000);
      expect(await answer).toMatchObject({ reason: 'timeout' });
      expect(await allGone(s.pids), 'a probe deaf to SIGTERM outlived its give-up').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('3, 4. running when the quit begins, it ends with what it started; asked after, it is not started', async () => {
    const { quit, probe } = await fresh();
    const s = standIn('child(); hang();');
    try {
      const answer = probe.probeCli(s.bin, ['login', 'status'], { timeoutMs: 30_000 }).then(() => 'answered', (err: { reason?: string }) => err.reason);
      await until('the stand-in and its child started', () => s.pids().length === 2);
      probe.endCliProbes();
      expect(await answer).toBe('quit');
      expect(await allGone(s.pids), 'left running after the quit').toEqual([]);
      quit.beginQuit();
      await expect(probe.probeCli(s.bin, ['--help'], { timeoutMs: 5_000 })).rejects.toThrow(/quitting/);
      await settle(300);
      expect(s.pids().length, 'a probe was started during the quit').toBe(2);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('5. an answer in time is read whole; a failure is told with its exit code and its words; a missing binary is not run', async () => {
    const { probe, exec } = await fresh();
    const s = standIn([
      "if (process.argv[2] === 'login') { console.log('Not logged in'); process.exit(1); }",
      "process.stdout.write('codex-cli 0.170.0\\n'); process.stderr.write('a warning\\n');",
    ].join('\n'));
    try {
      await expect(probe.probeCli(s.bin, ['--version'], { timeoutMs: 10_000 })).resolves.toEqual({ stdout: 'codex-cli 0.170.0\n', stderr: 'a warning\n' });
      await expect(probe.probeCli(s.bin, ['login', 'status'], { timeoutMs: 10_000 })).rejects.toMatchObject({ reason: 'exit', code: 1, stdout: 'Not logged in\n' });
      // Windows resolves the name before any spawn (CliNotRunnableError); macOS and Linux start it as given, and the
      // spawn fails (ENOENT), as execFile did.
      const missing = await probe.probeCli(path.join(s.dir, 'no-such-cli'), ['--help'], { timeoutMs: 10_000 }).then(() => null, (err: unknown) => err);
      if (process.platform === 'win32') expect(missing).toBeInstanceOf(exec.CliNotRunnableError);
      else expect(missing).toMatchObject({ code: 'ENOENT' });
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('6. an answer past its cap ends the probe', async () => {
    const { probe } = await fresh();
    const s = standIn("const line = 'x'.repeat(1023) + '\\n'; const write = () => { while (process.stdout.write(line)); }; process.stdout.on('drain', write); write();");
    try {
      await expect(probe.probeCli(s.bin, ['--help'], { timeoutMs: 15_000, maxBuffer: 256 * 1024 })).rejects.toMatchObject({ reason: 'too-long' });
      expect(await allGone(s.pids), 'a probe past its cap went on').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('7. answered as soon as its answer is there, and what still runs after it ends', async () => {
    const { probe } = await fresh();
    const s = standIn("child(); process.stdout.write('noise\\n__MARK__=/somewhere\\n'); hang();");
    try {
      const began = Date.now();
      const read = await probe.probeCli(s.bin, ['-ilc', 'x'], { timeoutMs: 15_000, until: (out: string) => /__MARK__=.*\n/.test(out) });
      expect(read.stdout).toContain('__MARK__=/somewhere');
      expect(Date.now() - began, 'the read waited out its time').toBeLessThan(8_000);
      expect(await allGone(s.pids), 'left running after its answer').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("codex's probes (P1, P2, and the login shell's CODEX_HOME read)", () => {
  it('8. a codex that never answers --help is read once per launch, not again in the background', async () => {
    const { codex, probe } = await fresh();
    const s = standIn('child(); hang();');
    const helps = () => s.pids().filter(p => p.role === 'probe' && p.argv[0] === '--help').length;
    try {
      // The launch's own read (prepareLaunch), seen to start, and given no answer.
      const read = codex.readCodexFlags(s.bin, 30_000);
      await until("the launch's own --help started", () => helps() === 1);
      probe.endCliProbes();
      expect(await read).toBeUndefined();
      // The line, built with the stable flags: no read of its own.
      const accepts = codex.codexAccepts(s.bin);
      expect(accepts('--no-daemon')).toBe(false);
      expect(accepts('--approve-for-me')).toBe(false);
      // Long enough for a second read's stand-in to have noted itself, even under load.
      for (const end = Date.now() + 5_000; Date.now() < end && helps() < 2;) await settle(100);
      expect(helps(), 'a second --help was read').toBe(1);
      expect(await allGone(s.pids)).toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("9. codex's --help and login status end at the quit with what they started", async () => {
    const { codex, probe } = await fresh();
    const s = standIn('child(); hang();');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cli-probe-home-'));
    try {
      const flags = codex.readCodexFlags(s.bin);
      const signedIn = codex.codexSignedIn(s.bin, home);
      await until('both probes and their children started', () => s.pids().length === 4);
      probe.endCliProbes();
      expect(await flags).toBeUndefined();
      expect(await signedIn).toBeUndefined();
      expect(await allGone(s.pids), 'left running after the quit').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(skipOnWindows(SHELL_REASON))("9. the login shell's CODEX_HOME read ends at the quit with what it started", async () => {
    const { codex, probe } = await fresh();
    const s = standIn('child(); hang();');
    try {
      const read = codex.loginShellCodexHome(s.bin, 'darwin', 30_000);
      await until('the shell and its child started', () => s.pids().length === 2);
      probe.endCliProbes();
      expect(await read).toBeUndefined();
      expect(await allGone(s.pids), 'left running after the quit').toEqual([]);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('in the app', () => {
  it('10. every one-shot probe of a CLI goes through probeCli', () => {
    const PROBES = [
      /'--help'\]/, /'login',\s*'status'/, /'-ilc'/, /'auth',\s*'status',\s*'--json'/, /auth status --json/,
      /'status',\s*'--json'/, /'serve',\s*'status'/, /'mcp',\s*'list'/, /['"`]claude mcp list['"`]/,
    ];
    const around: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'dist') walk(p); continue; }
        if (!e.name.endsWith('.ts') || p.endsWith(path.join('core', 'cli-probe.ts'))) continue;
        fs.readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (PROBES.some(re => re.test(line)) && !line.includes('probeCli(')) around.push(`${path.relative(ELECTRON, p)}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    walk(ELECTRON);
    expect(around).toEqual([]);
  });

  it("11. main.ts's first quit pass ends the CLI probes", () => {
    const file = path.join(ELECTRON, 'main.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.ES2022, true);
    let first: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (first) return;
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'runShutdownSteps' && ts.isArrayLiteralExpression(node.arguments[0])) {
        first = node.arguments[0].elements.map(e => (ts.isArrayLiteralExpression(e) && ts.isStringLiteral(e.elements[0]) ? e.elements[0].text : '?'));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(first).toContain('endCliProbes');
  });
});
