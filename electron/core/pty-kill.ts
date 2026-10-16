import { fork as nodeFork, type ChildProcess, type ForkOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { IPty } from 'node-pty';

/**
 * Ends a terminal without node-pty's `AttachConsole failed`.
 *
 * node-pty 1.1 ends a ConPTY terminal (WindowsPtyAgent.kill, inbox ConPTY)
 * by forking lib/conpty_console_list_agent.js with the shell's pid, to list
 * the processes on its console and kill them. The helper frees its own
 * console, attaches to the shell's, and throws when the shell has none left:
 * every kill of a terminal whose shell has exited, and any whose shell exits
 * in the time the fork takes to start. Measured on Windows 11 26200 with
 * node-pty 1.1.0 (2026-09-25): 3 kills of 3 exited cmd.exe printed "Error:
 * AttachConsole failed" from the fork, under Node 22 and under Electron 44
 * alike. node-pty then waits five seconds for the list and kills the shell's
 * pid anyway, a pid Windows released when that shell exited and may have
 * handed to another process since. Here the helper's throw reached stderr
 * only; openai/codex#25272 reports it as an error dialog in an Electron app,
 * which is how it reaches a user.
 *
 * So on win32, before kill() asks for that list, the terminal's agent is
 * given a list of its own: none once the shell has exited (there is no
 * console left to attach to, and no pid of its to trust); otherwise the same
 * helper, forked silently, whose failure means the shell has gone and gives
 * an empty list, and whose silence past five seconds gives the shell's pid
 * only while the shell still runs. Everything else kill() does, the pseudo
 * console, the sockets, the output worker, is node-pty's own.
 *
 * This reaches into node-pty's WindowsPtyAgent (`_agent`, its
 * `_getConsoleProcessList`, `_useConpty`, `_useConptyDll`, `_innerPid` and
 * `exitCode`), as installed at 1.1.0, and only a node-pty whose package.json
 * says 1.1.x is touched. Any other version, one whose version cannot be read,
 * any other shape, winpty, and `useConptyDll` (whose kill forks nothing) are
 * left to node-pty. darwin/linux: pty.kill(), and nothing of node-pty is read.
 */

export interface PtyKillDeps {
  platform?: NodeJS.Platform;
  fork?: (modulePath: string, args: string[], options: ForkOptions) => ChildProcess;
  /** node-pty's lib/conpty_console_list_agent.js. */
  listAgent?: string;
  /** How long the helper gets to answer, node-pty's own five seconds. */
  timeoutMs?: number;
  /** The installed node-pty's version, null when it cannot be read. Read from its package.json by default. */
  nodePtyVersion?: string | null;
}

/** The internals below are node-pty 1.1's; no other release was read. */
const HANDLED_NODE_PTY = /^1\.1\.\d+$/;

let installedVersion: string | null | undefined;

/** The installed node-pty's package.json version, read once; null when it cannot be read. */
function installedNodePtyVersion(): string | null {
  if (installedVersion !== undefined) return installedVersion;
  try {
    const manifest = path.join(path.dirname(require.resolve('node-pty')), '..', 'package.json');
    const version = (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
    installedVersion = typeof version === 'string' ? version : null;
  } catch {
    installedVersion = null;
  }
  return installedVersion;
}

interface ConptyAgent {
  _useConpty?: boolean;
  _useConptyDll?: boolean;
  _innerPid?: number;
  readonly exitCode?: number;
  _getConsoleProcessList?: () => Promise<number[]>;
}

const LIST_TIMEOUT_MS = 5_000;

export function killPty(pty: IPty, deps: PtyKillDeps = {}): void {
  if ((deps.platform ?? process.platform) === 'win32') listConsoleSafely(pty, deps);
  pty.kill();
}

/**
 * win32: whether node-pty 1.1 reports this terminal's shell still running,
 * which is while its pid is still its own (pty-manager.ts ends the tree under
 * it by that pid). False for any other terminal, and on darwin/linux.
 */
export function shellStillRuns(pty: IPty, deps: { platform?: NodeJS.Platform; nodePtyVersion?: string | null } = {}): boolean {
  if ((deps.platform ?? process.platform) !== 'win32') return false;
  const agent = inboxConptyAgent(pty, deps.nodePtyVersion);
  return agent !== null && agent.exitCode === undefined;
}

/** The agent of a node-pty 1.1 terminal on the inbox ConPTY, or null for anything else. */
function inboxConptyAgent(pty: IPty, nodePtyVersion: string | null | undefined): ConptyAgent | null {
  const version = nodePtyVersion !== undefined ? nodePtyVersion : installedNodePtyVersion();
  if (!version || !HANDLED_NODE_PTY.test(version)) return null;
  const agent = (pty as unknown as { _agent?: ConptyAgent })._agent;
  if (!agent || agent._useConpty !== true || agent._useConptyDll === true) return null;
  if (typeof agent._getConsoleProcessList !== 'function' || typeof agent._innerPid !== 'number') return null;
  return agent;
}

function listConsoleSafely(pty: IPty, deps: PtyKillDeps): void {
  const agent = inboxConptyAgent(pty, deps.nodePtyVersion);
  if (!agent) return;
  agent._getConsoleProcessList = () => consoleProcesses(agent, agent._innerPid as number, deps);
}

/**
 * The end of a quit that ended terminals.
 *
 * Killing a ConPTY terminal closes its pseudo console, and its shell exits a
 * moment later: 125 ms idle, seconds on a busy machine. node-pty waits for that
 * exit on a thread of its own, which then calls back into Node, and at quit
 * Node is being torn down by then. Measured with Electron 44 and node-pty 1.1.0,
 * 6 terminals ended at before-quit, electron.exe started directly and idle: the
 * main process outlived its `exit` event until it was killed 15 s later in 7
 * quits of 10, and the 3 others ended in 0xC0000409. In the app, 8 idle quits
 * of 16 ended in 0xC0000409 and Windows Error Reporting, which holds the dying
 * process for as long as it takes to write its report, the profile still open.
 *
 * So once the terminals are ended, the quit is held at will-quit, after the
 * windows are gone and before Node is torn down, until every terminal ended
 * here has reported its exit to the app (node-pty's `exitCode`, set by that
 * very callback), then the app exits. EXIT_WAIT_MS at most: a shell that
 * never reports costs the quit that long, and then the old race, said in the
 * log. Only node-pty 1.1's inbox ConPTY is waited for, the one read here.
 * darwin/linux: nothing is held and nothing of node-pty is read.
 */
export interface QuitHold {
  once(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  exit(code?: number): void;
}

export interface ExitWaitDeps {
  platform?: NodeJS.Platform;
  /** As PtyKillDeps.nodePtyVersion. */
  nodePtyVersion?: string | null;
  timeoutMs?: number;
  pollMs?: number;
}

const EXIT_WAIT_MS = 5_000;
const EXIT_POLL_MS = 25;

export function holdExitUntilTerminalsExit(ended: IPty[], app: QuitHold, deps: ExitWaitDeps = {}): void {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  const running = ended
    .map(pty => inboxConptyAgent(pty, deps.nodePtyVersion))
    .filter((agent): agent is ConptyAgent => agent !== null && agent.exitCode === undefined);
  if (running.length === 0) return;
  const timeoutMs = deps.timeoutMs ?? EXIT_WAIT_MS;
  app.once('will-quit', (event) => {
    event.preventDefault();
    const since = Date.now();
    const timer = setInterval(() => {
      const left = running.filter(agent => agent.exitCode === undefined);
      if (left.length > 0 && Date.now() - since < timeoutMs) return;
      clearInterval(timer);
      if (left.length > 0) {
        console.warn(`[pty] ${left.length} terminal(s) ended by the quit had not exited after ${timeoutMs} ms, exiting all the same`);
      }
      app.exit(0);
    }, deps.pollMs ?? EXIT_POLL_MS);
  });
}

function consoleProcesses(agent: ConptyAgent, shellPid: number, deps: PtyKillDeps): Promise<number[]> {
  if (agent.exitCode !== undefined) return Promise.resolve([]);
  return new Promise(resolve => {
    let helper: ChildProcess;
    try {
      helper = (deps.fork ?? nodeFork)(deps.listAgent ?? defaultListAgent(), [String(shellPid)], { silent: true });
      // No windowsHide: fork has none, and needs none. It starts process.execPath,
      // electron.exe in the app, a GUI program that opens no console window.
    } catch (err) {
      // kill() still closes the pseudo console, which ends what runs on it.
      console.warn(`[pty] could not list the processes on the console of ${shellPid}:`, err);
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      helper.kill();
      done(agent.exitCode === undefined ? [shellPid] : []);
    }, deps.timeoutMs ?? LIST_TIMEOUT_MS);
    let settled = false;
    const done = (list: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(list);
    };
    helper.on('message', message => {
      const list = (message as { consoleProcessList?: unknown } | null)?.consoleProcessList;
      done(Array.isArray(list) ? list.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0) : []);
    });
    // Read and dropped: its only words are the AttachConsole failure, which
    // means the shell has gone and there is nothing to list.
    helper.stdout?.resume();
    helper.stderr?.resume();
    helper.on('error', err => {
      console.warn(`[pty] the console list of ${shellPid} failed:`, err);
      done([]);
    });
    // After any message it sent: 'close' waits for its pipes and its channel.
    helper.on('close', () => done([]));
  });
}

function defaultListAgent(): string {
  return path.join(path.dirname(require.resolve('node-pty')), 'conpty_console_list_agent.js');
}
