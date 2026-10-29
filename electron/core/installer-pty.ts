import * as os from 'os';
import * as pty from 'node-pty';
import { spawnPty } from './pty-spawn';
import type { BrowserWindow } from 'electron';
import { toLaunch, LaunchError, type DirectLaunch, type Env } from '../platform';
import { refuseWhileQuitting } from './quit-state';

/**
 * The skill and plugin installers on Windows: each program started by its
 * argv in the terminal the renderer shows, never through a shell. On darwin and linux these do nothing and the
 * handlers in ipc-handlers.ts run as they always have.
 *
 * Why no shell there: `npx` is npx.cmd, which ConPTY cannot start by name;
 * PowerShell 5.1 has no `&&` and cmd.exe takes no `-c`; and a .cmd goes
 * through cmd.exe, which re-reads % ^ &. toLaunch reads the npm shims through
 * to node and their script instead (platform/cli-binary.ts).
 */

/** One word for the POSIX grammar toLaunch reads (platform/posix-words.ts), whatever it holds. */
function posixQuote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

type Size = { cols?: number; rows?: number };

function spawnStep(step: DirectLaunch, size: Size): pty.IPty {
  // Not once the quit has begun: a chained step would outlive Tars (quit-state.ts).
  refuseWhileQuitting('installer step');
  return spawnPty(step.file, step.commandLine, {
    name: 'xterm-256color',
    cols: size.cols || 80,
    rows: size.rows || 24,
    cwd: step.cwd,
    env: step.env as { [key: string]: string },
  });
}

/**
 * `npx <args>` as the terminal's process on win32, in the home directory, or
 * undefined elsewhere (the handler spawns npx itself). Throws a LaunchError
 * when Windows cannot start npx as it is installed.
 */
export function spawnSkillInstallerOnWindows(npxArgs: string[], size: Size, env: Env): pty.IPty | undefined {
  const start = toLaunch(['npx', ...npxArgs].map(posixQuote).join(' '), os.homedir(), env);
  return start.platform === 'win32' ? spawnStep(start, size) : undefined;
}

/**
 * A plugin install on win32: its programs one after the other in the one
 * terminal the renderer knows by `id`, the next only once the one before
 * exited 0, as `&&` did, and none after plugin:install-kill took the
 * terminal away. The handler's answer, or undefined elsewhere (the handler
 * runs the command through the shell itself).
 *
 * `command` is one of the handler's INSTALL_SHAPES: words of safe characters
 * joined by ` && `, or a slash command, which goes to claude as one argument
 * as `claude "<command>"` passed it.
 */
export function startPluginInstallOnWindows(
  id: string,
  command: string,
  size: Size,
  env: Env,
  terminals: Map<string, pty.IPty>,
  getMainWindow: () => BrowserWindow | null,
): { id: string } | { error: string } | undefined {
  const steps = command.startsWith('/') ? [`claude ${posixQuote(command)}`] : command.split(' && ');
  let starts;
  try {
    starts = steps.map(step => toLaunch(step, os.homedir(), env));
  } catch (err) {
    if (!(err instanceof LaunchError)) throw err;
    return { error: err.message };
  }
  if (starts[0].platform !== 'win32') return undefined;
  runSteps(id, starts as DirectLaunch[], 0, size, terminals, getMainWindow);
  return { id };
}

function runSteps(
  id: string,
  steps: DirectLaunch[],
  at: number,
  size: Size,
  terminals: Map<string, pty.IPty>,
  getMainWindow: () => BrowserWindow | null,
): void {
  const ptyProcess = spawnStep(steps[at], size);
  terminals.set(id, ptyProcess);

  ptyProcess.onData((data) => {
    getMainWindow()?.webContents.send('plugin:pty-data', { id, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    // Still the install's terminal: plugin:install-kill has not taken it away.
    const current = terminals.get(id) === ptyProcess;
    if (current && exitCode === 0 && at + 1 < steps.length) {
      try {
        runSteps(id, steps, at + 1, size, terminals, getMainWindow);
        return;
      } catch (err) {
        // The quit has begun, or ConPTY refused the spawn: the install ends
        // here, as a step that failed, and nothing is thrown out of node-pty's
        // exit callback, where no caller would catch it.
        console.warn(`[installer] ${id}: step ${at + 2} of ${steps.length} not started:`, err);
        getMainWindow()?.webContents.send('plugin:pty-exit', { id, exitCode: 1 });
        terminals.delete(id);
        return;
      }
    }
    getMainWindow()?.webContents.send('plugin:pty-exit', { id, exitCode });
    if (current) terminals.delete(id);
  });
}
