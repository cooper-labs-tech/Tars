import { execFile } from 'child_process';
import * as fs from 'fs';

/**
 * Is the CLI that asks to register a session the one Tars launched in the
 * agent's terminal?
 *
 * A CLI run from inside an agent's terminal, a `claude -p` from its Bash tool,
 * inherits the agent's whole environment: CLAUDE_AGENT_ID, the terminal's
 * token and Tars's hooks. Its SessionStart named it the agent's session, its
 * Stop marked the agent done with its answer, and the real session's posts
 * were dropped as stale from then on (measured on 2026-10-13, claude 2.1.296).
 * Nothing in the environment can tell the two apart, since the nested CLI
 * inherits all of it; where the process sits can. Claude Code hands its hooks
 * CLAUDE_PID, its own pid (the nested claude's hook saw the nested pid), and
 * the CLI Tars launched is the terminal's process itself (its shell exec'd it:
 * the agent's claude had Tars as its parent) or that process's child (a shell
 * that ran a compound command). Anything deeper was started by something in
 * the terminal, not by Tars.
 *
 * Accepted as before, since there is nothing to compare: a post that names no
 * CLI (Gemini, a claude that does not set CLAUDE_PID), an agent with no
 * terminal Tars knows of, and on Windows any CLI but the terminal's own
 * process, whose parent there is no `ps` to read. Refused: a pid that is not
 * one, and a parent that cannot be read.
 */
export async function isTerminalsOwnCli(
  terminalPid: number | undefined,
  cliPid: unknown,
  deps: { platform?: NodeJS.Platform; parentPid?: (pid: number) => Promise<number | undefined>; execLaunch?: boolean } = {},
): Promise<boolean> {
  const atOnce = ownCliAtOnce(terminalPid, cliPid, deps.platform, deps.execLaunch);
  if (atOnce !== undefined) return atOnce;
  try {
    return (await (deps.parentPid ?? parentPid)(asPid(cliPid)!)) === terminalPid;
  } catch {
    return false;
  }
}

/**
 * isTerminalsOwnCli's answer when it needs no `ps`, undefined when it does:
 * the registration route stays synchronous for every CLI the terminal runs
 * itself, which is the agent's claude as Tars launches it.
 */
export function ownCliAtOnce(terminalPid: number | undefined, cliPid: unknown, platform: NodeJS.Platform = process.platform, execLaunch = false): boolean | undefined {
  if (cliPid === undefined || cliPid === null || cliPid === '') return true;
  const pid = asPid(cliPid);
  if (pid === undefined) return false;
  if (terminalPid === undefined) return true;
  if (pid === terminalPid) return true;
  // The exec launch: the terminal's process is the CLI, and its children are
  // its own tools, a claude its Bash tool started among them (the Audit's L1).
  if (execLaunch) return false;
  if (platform === 'win32') return true;
  return undefined;
}

/** The largest pid any of the platforms Tars runs on hands out (Linux's pid_max ceiling, 2^22). */
const MAX_PID = 4_194_304;

/** A pid as a hook posts it (a number, or its digits), or undefined for anything else. */
export function asPid(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9][0-9]{0,6}$/.test(text)) return undefined;
  const pid = Number(text);
  return pid <= MAX_PID ? pid : undefined;
}

/**
 * A live process's parent pid; undefined when it is gone or cannot be read.
 * On Linux from /proc/<pid>/stat first, which needs no binary (a minimal Linux
 * has no `ps`: every typed-in agent's session was refused there, the Audit's
 * L2), then `ps` on macOS and wherever /proc cannot be read.
 */
export async function parentPid(
  pid: number,
  deps: { platform?: NodeJS.Platform; readProcStat?: (pid: number) => string | undefined; ps?: (pid: number) => Promise<number | undefined> } = {},
): Promise<number | undefined> {
  if ((deps.platform ?? process.platform) === 'linux') {
    const stat = (deps.readProcStat ?? readProcStat)(pid);
    const parent = stat === undefined ? undefined : parentPidFromProcStat(stat);
    if (parent !== undefined) return parent;
  }
  try {
    return await (deps.ps ?? parentPidFromPs)(pid);
  } catch {
    return undefined;
  }
}

/**
 * The parent in a /proc/<pid>/stat line, `pid (comm) state ppid ...`. The
 * command name may hold spaces and parentheses, so the fields are counted
 * after its last closing one.
 */
export function parentPidFromProcStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(')');
  if (close === -1) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  return asPid(fields[1]);
}

function readProcStat(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
}

function parentPidFromPs(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? undefined : asPid(String(stdout).trim()));
    });
  });
}
