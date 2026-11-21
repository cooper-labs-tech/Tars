import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * What the live processes of this account use, read for the agents' temporary folders (agent-tmp.ts): every path a
 * process holds, its executable, its current folder and the files it has open, and every command line, which names a
 * script an interpreter loaded and closed. QA's gate of #601's stack lost codex 0.170 and Kimi to the retention while
 * it ran them (21/11): running a binary changes no date.
 *
 * Every process of the account, not only an agent's: a run escapes its agent's terminal (a daemon, a test sandbox's
 * own agents), and reading them all costs one call. Read once a unit is about to go, once per pass.
 * - macOS: one `lsof -Fn` of the account's processes (measured 21/11: 615 processes, 28,000 lines, 0.24 to 0.43 s),
 *   and `ps` for the command lines.
 * - Linux: /proc/<pid>/exe, cwd, fd/* and cmdline of each process the account may read.
 * - Windows: each process's ExecutablePath and CommandLine (CIM). Its current folder and open files are not read
 *   there: the retention moves a unit aside before deleting it, which Windows refuses while a process holds it.
 * Undefined when the read failed or did not end in its time: the retention then deletes nothing that pass.
 */

export interface InUse {
  /** Absolute paths the processes hold: executables, current folders, open files. */
  paths: string[];
  /** The processes' command lines, whole. */
  commands: string[];
}

export interface ReadOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  lsof?: string;
  ps?: string;
  powershell?: string;
  procRoot?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const deletedMark = / \(deleted\)$/;

/** The paths of lsof's field output (`-Fn`): the `n` lines that are absolute paths, whole, without lsof's ` (deleted)`. */
export function parseLsofNames(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) paths.push(line.slice(1).replace(deletedMark, ''));
  }
  return paths;
}

/**
 * Whether a process uses one of `targets` (a unit, under each of its spellings): a path it holds is the target or
 * under it, or a command line names it, followed by its end, a separator, a quote or a space; never a longer name
 * that begins the same (`/a/tool` is not `/a/tool-old`). On Windows, whatever the case and the slashes.
 */
export function usesPath(inUse: InUse, targets: string[], platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const norm = (s: string) => (win ? s.replace(/\//g, '\\').toLowerCase() : s);
  for (const raw of targets) {
    const target = norm(raw).replace(/[\\/]+$/, '');
    if (!target) continue;
    for (const p of inUse.paths) {
      const held = norm(p);
      if (held === target || held.startsWith(target + sep)) return true;
    }
    for (const c of inUse.commands) {
      const line = norm(c);
      for (let at = line.indexOf(target); at >= 0; at = line.indexOf(target, at + 1)) {
        const next = line[at + target.length];
        if (next === undefined || next === sep || /[\s"'`]/.test(next)) return true;
      }
    }
  }
  return false;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // lsof answers 1 when some process could not be read, with what it read: kept. Killed at its time, or no
      // output at all: no answer.
      if (err && ((err as { killed?: boolean }).killed || !stdout)) resolve(undefined);
      else resolve(String(stdout));
    });
  });
}

async function readMac(opts: ReadOptions, timeoutMs: number): Promise<InUse | undefined> {
  const uid = process.getuid?.();
  const [listed, lines] = await Promise.all([
    run(opts.lsof ?? '/usr/sbin/lsof', ['-w', '-n', '-P', '-Fn', ...(uid !== undefined ? ['-u', String(uid)] : [])], timeoutMs),
    run(opts.ps ?? '/bin/ps', ['-axww', '-o', 'args='], timeoutMs),
  ]);
  if (listed === undefined || lines === undefined) return undefined;
  return { paths: parseLsofNames(listed), commands: lines.split('\n').map((l) => l.trim()).filter(Boolean) };
}

async function readLinux(opts: ReadOptions, timeoutMs: number): Promise<InUse | undefined> {
  const proc = opts.procRoot ?? '/proc';
  const until = Date.now() + timeoutMs;
  let pids: string[];
  try {
    pids = (await fs.promises.readdir(proc)).filter((n) => /^\d+$/.test(n));
  } catch {
    return undefined;
  }
  const paths: string[] = [];
  const commands: string[] = [];
  const link = async (p: string) => {
    try {
      const to = await fs.promises.readlink(p);
      if (to.startsWith('/')) paths.push(to.replace(deletedMark, ''));
    } catch { /* gone, or another account's */ }
  };
  for (const pid of pids) {
    if (Date.now() > until) return undefined;
    const base = path.join(proc, pid);
    await link(path.join(base, 'exe'));
    await link(path.join(base, 'cwd'));
    try {
      for (const fd of await fs.promises.readdir(path.join(base, 'fd'))) await link(path.join(base, 'fd', fd));
    } catch { /* another account's */ }
    try {
      const line = (await fs.promises.readFile(path.join(base, 'cmdline'))).toString('utf8').split('\0').filter(Boolean).join(' ');
      if (line) commands.push(line);
    } catch { /* gone */ }
  }
  return { paths, commands };
}

async function readWindows(opts: ReadOptions, timeoutMs: number): Promise<InUse | undefined> {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { 'E ' + $_.ExecutablePath; 'C ' + $_.CommandLine }";
  const out = await run(opts.powershell ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
  if (out === undefined) return undefined;
  const paths: string[] = [];
  const commands: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const value = raw.slice(2).trim();
    if (!value) continue;
    if (raw.startsWith('E ')) paths.push(value);
    else if (raw.startsWith('C ')) commands.push(value);
  }
  return { paths, commands };
}

/** Every path and command line the account's live processes use, or undefined when they could not be read in time. */
export async function readPathsInUse(opts: ReadOptions = {}): Promise<InUse | undefined> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (platform === 'darwin') return await readMac(opts, timeoutMs);
    if (platform === 'linux') return await readLinux(opts, timeoutMs);
    if (platform === 'win32') return await readWindows(opts, timeoutMs);
  } catch { /* said below */ }
  return undefined;
}
