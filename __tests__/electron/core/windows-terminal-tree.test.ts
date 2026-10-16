import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
// The quit holds the app's exit for the terminals' own (pty-kill.ts): an app that records it.
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), app: { once: vi.fn(), exit: vi.fn() } }));
vi.setConfig({ testTimeout: 30_000 });

import { endAllTerminals, endTerminalTree, ptyProcesses, quickPtyProcesses, skillPtyProcesses, pluginPtyProcesses } from '../../../electron/core/pty-manager';
import { killPty } from '../../../electron/core/pty-kill';
import type { IPty } from 'node-pty';

/**
 * A stop and a quit end an agent terminal's whole process tree on Windows.
 *
 * Closing a ConPTY terminal's pseudo console ends what is attached to that
 * console. A process the CLI's tools started detached, with no console (a
 * server started in the background, PowerShell's Start-Process), is not
 * attached, and is not in the job Node and Bun put their children in (libuv
 * ends those with their parent, measured): it outlived the stop and the quit.
 * Real processes here: the stand-in terminal's shell is a node process, and
 * its kill() ends that process alone, as closing the console ends what is on
 * it; under it, a detached hidden child that writes its pid and waits.
 *
 * How it fails, written before the code (2026-10-13):
 * 1. Witness: the console closed alone (killPty) leaves the hidden child
 *    running. Unless it does, the cases below prove nothing.
 * 2. A stop (endTerminalTree) leaves the hidden child running.
 * 3. A quit (endAllTerminals) leaves an agent's, a skill runner's or a plugin
 *    runner's hidden child running.
 * 4. The tree is ended after the console is closed: the shell is gone by
 *    then, and taskkill finds no tree to walk.
 * 5. A terminal whose shell has exited has its pid handed to taskkill: Windows
 *    may have given that id to another process, which would be ended with
 *    its own children.
 * 6. The user's own shell panel (a quick terminal) has its jobs ended at
 *    quit: as on macOS and Linux, only the shell goes.
 */

const onWindows = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-win-tree-'));
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) { try { process.kill(pid); } catch { /* gone */ } }
  for (const map of [ptyProcesses, quickPtyProcesses, skillPtyProcesses, pluginPtyProcesses]) map.clear();
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !cond();) await new Promise(r => setTimeout(r, 50));
  return cond();
};

/**
 * A terminal as node-pty 1.1's inbox ConPTY: `_agent` with its shell's pid and
 * the exit code node-pty sets when that shell's exit is delivered. The shell
 * starts a hidden child that writes its pid into `<file>` and waits.
 */
async function terminal(): Promise<{ pty: IPty; shell: ChildProcess; hidden: number }> {
  const file = path.join(tmp, `hidden-${Math.random().toString(36).slice(2)}`);
  const childSource = `require('fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1e9);`;
  const shellSource = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { detached: true, windowsHide: true, stdio: 'ignore' }); setInterval(() => {}, 1e9);`;
  const shell = spawn(process.execPath, ['-e', shellSource], { stdio: 'ignore' });
  started.push(shell.pid!);
  expect(await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '')).toBe(true);
  const hidden = Number(fs.readFileSync(file, 'utf8'));
  started.push(hidden);
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const agent = {
    _useConpty: true,
    _innerPid: shell.pid!,
    exitCode: undefined as number | undefined,
    _getConsoleProcessList: () => Promise.resolve([shell.pid!]),
  };
  shell.on('exit', (code) => {
    agent.exitCode = code ?? 0;
    for (const cb of [...exits]) cb({ exitCode: code ?? 0 });
  });
  const pty = {
    pid: shell.pid!,
    _agent: agent,
    // Closing the console: what is on it ends, the shell; the hidden child is on none.
    kill: () => { try { process.kill(shell.pid!); } catch { /* gone */ } },
    onExit: (cb: (e: { exitCode: number }) => void) => { exits.push(cb); return { dispose: () => exits.splice(exits.indexOf(cb), 1) }; },
  } as unknown as IPty;
  return { pty, shell, hidden };
}

describe.runIf(onWindows)('an agent terminal ended on Windows', () => {
  it('1. witness: closing the console alone leaves the hidden child running', async () => {
    const t = await terminal();
    killPty(t.pty);
    expect(await until(() => !alive(t.shell.pid!))).toBe(true);
    await new Promise(r => setTimeout(r, 500));
    expect(alive(t.hidden), 'the hidden child ended with the console: this file proves nothing').toBe(true);
  });

  it('2, 4. a stop ends the shell and everything under it', async () => {
    const t = await terminal();
    await endTerminalTree(t.pty);
    expect(await until(() => !alive(t.shell.pid!) && !alive(t.hidden))).toBe(true);
  });

  it("3. a quit ends an agent's, a skill runner's and a plugin runner's trees", async () => {
    const ts = [await terminal(), await terminal(), await terminal()];
    ptyProcesses.set('a', ts[0].pty);
    skillPtyProcesses.set('s', ts[1].pty);
    pluginPtyProcesses.set('p', ts[2].pty);
    await endAllTerminals(1_000);
    for (const t of ts) expect(await until(() => !alive(t.shell.pid!) && !alive(t.hidden))).toBe(true);
  });

  it('5. hands no exited shell\'s pid to taskkill: the process that holds that id now goes on', async () => {
    const t = await terminal();
    // The shell has exited as far as node-pty knows, and its id names a live process with a child.
    (t.pty as unknown as { _agent: { exitCode?: number } })._agent.exitCode = 0;
    await endTerminalTree(t.pty);
    await new Promise(r => setTimeout(r, 500));
    expect(alive(t.hidden)).toBe(true);
  });

  it("6. leaves the jobs of the user's own shell panel at quit", async () => {
    const t = await terminal();
    quickPtyProcesses.set('q', t.pty);
    await endAllTerminals(1_000);
    expect(await until(() => !alive(t.shell.pid!))).toBe(true);
    expect(alive(t.hidden)).toBe(true);
  });
});
