import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skipOnWindows } from '../../setup/platform-limits';

/**
 * The CLI calls Tars makes outside an agent's terminal that #616's probeCli (core/cli-probe.ts) does not cover yet,
 * measured against its head cb20f994f (27/11): the kanban's one-shot `claude -p`, and the synchronous `mcp add` and
 * `mcp remove` of claude, codex, gemini and grok (execCliSync).
 *
 * How it fails, written before the code:
 *  1. The kanban's `claude -p` outlives the quit, with what it started: it goes through a shell's `exec`, so nothing
 *     tracks it and endCliProbes never reaches it.
 *  2. Given up at its 30 s, it leaves what it started: exec's timeout signals /bin/sh alone, never its group.
 *  3. It is started once the quit has begun.
 *  4. Over-correction: routed, the request no longer reaches claude as one argument, byte for byte, through the
 *     provider's own command line, or the answer is not read (kanban-generate.test.ts holds both, and the fallback).
 *  5. A synchronous CLI call (execCliSync: `mcp add`, `mcp remove`) has no time. A CLI that hangs freezes the main
 *     thread, which paints the window and pumps every terminal, for good.
 *  6. Over-correction: a caller's own time is overridden, or an answer in time changes.
 *  7. (the Audit's L1 on #661) The bound sends SIGTERM only, and execFileSync returns once its child has exited: a
 *     CLI deaf to SIGTERM holds the main thread until it ends by itself. A grandchild holding the output is reached
 *     by nothing: a synchronous call makes no process group, so it lives on (measured by the Audit). No `mcp add` or
 *     `mcp remove` of the four CLIs starts one.
 * On Windows there is no process group: probeCli ends the tree with taskkill /T while it runs (cli-probe.test.ts and
 * version-probe-windows.test.ts hold it). The kanban's stand-in below is a node script started by its shebang, so 1
 * to 3 run on macOS and Linux; 5 and 6 run everywhere.
 */

const SHEBANG_REASON = 'the stand-in claude is started by its shebang through /bin/sh; on Windows the kanban goes through probeCli by argv, and its tree ends by taskkill /T (cli-probe.test.ts)';

type Pid = { role: string; pid: number };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await settle(50)) if (ok()) return;
  throw new Error(`never: ${what}`);
}

const dirs: string[] = [];
let fakePath = '';
vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: () => fakePath }));

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in `claude` on the PATH Tars builds: it notes its pid, starts a child deaf to SIGTERM, and never answers. */
function hangingClaude(): { pids: () => Pid[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-gaps-'));
  dirs.push(dir);
  const notes = path.join(dir, 'pids.jsonl');
  fs.writeFileSync(path.join(dir, 'claude'), [
    `#!${process.execPath}`,
    "const fs = require('fs'); const { spawn } = require('child_process');",
    `const note = (role, pid) => fs.appendFileSync(${JSON.stringify(notes)}, JSON.stringify({ role, pid }) + '\\n');`,
    "note('claude', process.pid);",
    // The bench's folder on its line, so that a leftover is known as this test's.
    `const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", ${JSON.stringify(dir)}], { stdio: 'ignore' });`,
    "note('child', c.pid);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), { mode: 0o755 });
  fakePath = [dir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  return { pids: () => (fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Pid) : []) };
}

/** Every noted process gone within `ms`; else the test fails, having ended them by their pids. */
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
  const kanban = await import('../../../electron/utils/kanban-generate');
  const exec = await import('../../../electron/providers/cli-exec');
  return { quit, probe, kanban, exec };
}

const PROJECTS = [{ path: '/work/demo', name: 'demo' }];

describe("the kanban's one-shot claude -p", () => {
  it.skipIf(skipOnWindows(SHEBANG_REASON))('1. running when the quit begins, it ends with what it started, and the request still becomes a task', async () => {
    const { probe, kanban } = await fresh();
    const claude = hangingClaude();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const task = kanban.generateTaskFromPrompt('Ship the thing', PROJECTS);
      await until('claude and its child started', () => claude.pids().length === 2);
      probe.endCliProbes();
      expect(await Promise.race([task.then(t => t.title), settle(5_000).then(() => 'still waiting on claude')])).toBe('Ship the thing');
      expect(await allGone(claude.pids), 'left running after the quit').toEqual([]);
    } finally {
      await allGone(claude.pids, 0);
    }
  }, 20_000);

  it.skipIf(skipOnWindows(SHEBANG_REASON))('3. asked once the quit has begun, nothing is started and the request still becomes a task', async () => {
    const { quit, kanban } = await fresh();
    const claude = hangingClaude();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      quit.beginQuit();
      const task = kanban.generateTaskFromPrompt('Ship the thing', PROJECTS);
      expect(await Promise.race([task.then(t => t.title), settle(5_000).then(() => 'still waiting on claude')])).toBe('Ship the thing');
      await settle(500);
      expect(claude.pids()).toEqual([]);
    } finally {
      await allGone(claude.pids, 0);
    }
  }, 20_000);
});

describe('a synchronous CLI call (execCliSync)', () => {
  /** A CLI that hangs, as node and a script so that every platform starts it alike; it gives up by itself at 26 s. */
  function hangingScript(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-gaps-sync-'));
    dirs.push(dir);
    const script = path.join(dir, 'hang.js');
    fs.writeFileSync(script, 'setTimeout(() => process.exit(0), 26_000);\n');
    return script;
  }

  it('5. a CLI that hangs is given up on in its time, and the caller told, not waited on for good', async () => {
    const { exec } = await fresh();
    const script = hangingScript();
    const began = Date.now();
    expect(() => exec.execCliSync(process.execPath, [script, 'mcp', 'add', 'x'], { encoding: 'utf-8', stdio: 'pipe' })).toThrow();
    expect(Date.now() - began, 'waited past its time').toBeLessThan(24_000);
  }, 40_000);

  it('6. a caller\'s own time is kept, and an answer in time is read as before', async () => {
    const { exec } = await fresh();
    const script = hangingScript();
    const began = Date.now();
    expect(() => exec.execCliSync(process.execPath, [script], { encoding: 'utf-8', stdio: 'pipe', timeout: 1_000 })).toThrow();
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(exec.execCliSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf-8', stdio: 'pipe' })).toBe('ok');
  }, 20_000);

  it('7. a CLI deaf to SIGTERM is ended at its time too, not waited on until it ends by itself', async () => {
    const { exec } = await fresh();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-gaps-deaf-'));
    dirs.push(dir);
    const script = path.join(dir, 'deaf.js');
    // Deaf to SIGTERM, and gone by itself at 12 s, so that the old bound's run ends too.
    fs.writeFileSync(script, "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 12_000);\n");
    const began = Date.now();
    expect(() => exec.execCliSync(process.execPath, [script, 'mcp', 'add', 'x'], { encoding: 'utf-8', stdio: 'pipe', timeout: 1_000 })).toThrow();
    expect(Date.now() - began, 'waited for a CLI deaf to SIGTERM').toBeLessThan(6_000);
  }, 30_000);
});
