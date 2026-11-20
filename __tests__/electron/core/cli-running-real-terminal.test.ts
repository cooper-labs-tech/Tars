import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import type * as pty from 'node-pty';
import { spawnAgentPty, cliRunningIn } from '../../../electron/core/agent-pty';
import { skipOnWindows } from '../../setup/platform-limits';

/**
 * What runs in an agent's terminal, read from a real one.
 *
 * Every other test of cliRunningIn gives node-pty's answer by hand, and gave
 * it the shape the Dashboard opens: an interactive `bash -l`, where a typed
 * command leads a process group of its own. None opened the terminal the API
 * opens, `bash -l -c "cd ... && <cli>"`, where a shell without job control
 * kept the CLI in its own group and node-pty named `bash` for the CLI's whole
 * life. So every agent the API had started read as no CLI while its claude
 * ran, the orchestrator among them, and the tests stayed green (the Audit's
 * gate of #126, 2026-09-23).
 *
 * node-pty is the real one here, under Node rather than Electron: its N-API
 * build loads in both. `/bin/sleep` stands in for the CLI, since what is read
 * is which process leads the terminal, not what that process is.
 *
 * On Linux node-pty names the process by its path (`/bin/sleep`), on macOS by
 * its name (`sleep`); cliRunningIn takes either, and so does `until`.
 */

/**
 * Windows opens neither shape: an agent's CLI is the terminal's own process
 * and a person's terminal is PowerShell, and ConPTY does not name the process
 * in front, a known limit there. What it opens there is held by
 * agent-terminal-win32.test.ts.
 */
const posixTerminal = () => skipOnWindows('these open bash terminals, the shapes Tars opens on macOS and Linux; '
  + 'Windows starts the CLI as the terminal\'s own process, held by agent-terminal-win32.test.ts');

const opened: pty.IPty[] = [];

function open(args: string[]): pty.IPty {
  const terminal = spawnAgentPty({
    binaryName: 'claude', shell: '/bin/bash', args, runsCommand: args.includes('-c'), cwd: '/tmp', cols: 80, rows: 24,
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TERM: 'xterm-256color' },
  });
  opened.push(terminal);
  return terminal;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait until node-pty names `name` in front, or fail saying what it named.
 * Generous: a login shell on a machine busy with other suites is slow to start.
 */
async function until(terminal: pty.IPty, name: string, within = 20_000): Promise<void> {
  const seen: Array<string | undefined> = [];
  for (let waited = 0; waited < within; waited += 50) {
    const now = terminal.process;
    if (now !== undefined && path.basename(now) === name) return;
    if (seen.at(-1) !== now) seen.push(now);
    await pause(50);
  }
  throw new Error(`node-pty never named ${name} in front: ${JSON.stringify(seen)}`);
}

const exited = (terminal: pty.IPty) => new Promise<void>(resolve => { terminal.onExit(() => resolve()); });

afterEach(() => {
  for (const terminal of opened.splice(0)) {
    try { terminal.kill(); } catch { /* already gone */ }
  }
});

describe.skipIf(posixTerminal())('the terminal spawnAgentSession opens', () => {
  it('names the CLI once the shell has handed it the terminal, and reads as a CLI until it ends', async () => {
    const terminal = open(['-l', '-c', "cd '/tmp' && exec '/bin/sleep' 2"]);
    const gone = exited(terminal);

    await until(terminal, 'sleep');
    expect(cliRunningIn(terminal)).toBe(true);

    await gone;
    // Gone, node-pty names nothing on macOS; on Linux it falls back to the file
    // it spawned, the shell. Neither reads as a CLI.
    const after = terminal.process;
    expect([undefined, 'bash']).toContain(after === undefined ? undefined : path.basename(after));
    expect(cliRunningIn(terminal)).toBe(false);
  }, 60_000);

  it('without the exec names the shell for the whole command, and still reads as a CLI while it runs', async () => {
    // The shape it had until 2026-09-23, and the moment before the exec in the
    // one it has now, while the shell reads its login files: only the command
    // it was handed says a CLI is on its way or running.
    //
    // macOS's /bin/bash (3.2), the shell Tars spawns, keeps itself in front of
    // that command. A newer bash, as on a Linux CI runner, execs the last
    // command of a -c list by itself, so there it takes a command after it to
    // keep the shell in front.
    const keepShell = process.platform === 'darwin' ? '' : '; :';
    const terminal = open(['-l', '-c', `cd '/tmp' && '/bin/sleep' 2${keepShell}`]);
    let running = true;
    terminal.onExit(() => { running = false; });
    const names = new Set<string>();
    const readAsNone: string[] = [];

    while (running) {
      const now = terminal.process;
      if (now) {
        names.add(path.basename(now));
        if (!cliRunningIn(terminal)) readAsNone.push(now);
      }
      await pause(50);
    }

    expect(names.has('bash'), `named ${JSON.stringify([...names])}`).toBe(true);
    expect(names.has('sleep'), 'the command led the terminal without an exec').toBe(false);
    expect(readAsNone, 'read as no CLI while its command ran').toEqual([]);
  }, 60_000);

  it('reads as no CLI once it has exited, whatever node-pty still names', async () => {
    // How this fails, written before the code (QA, main's CI on Linux): once
    // the terminal is gone node-pty names the file it spawned, `/bin/bash`,
    // where macOS names nothing. The record of a terminal handed a command
    // outlived it, so an exited terminal read as a running CLI, and a message
    // to its agent was typed into nothing instead of starting a session.
    const terminal = open(['-l', '-c', 'exit 0']);
    await exited(terminal);
    Object.defineProperty(terminal, 'process', { get: () => '/bin/bash', configurable: true });

    expect(cliRunningIn(terminal)).toBe(false);
  }, 30_000);
});

describe.skipIf(posixTerminal())('an interactive shell, as the Dashboard and a restart open one', () => {
  it('reads as no CLI at its prompt, as one while a typed command runs, and as none again after', async () => {
    const terminal = open(['-l']);

    await until(terminal, 'bash');
    expect(cliRunningIn(terminal)).toBe(false);

    terminal.write('/bin/sleep 1\r');
    await until(terminal, 'sleep');
    expect(cliRunningIn(terminal)).toBe(true);

    await until(terminal, 'bash');
    expect(cliRunningIn(terminal)).toBe(false);
  }, 60_000);
});
