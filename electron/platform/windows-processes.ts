import * as path from 'path';
import { execFile } from 'child_process';
import { childEnv } from './child-env';
import { isPlainAbsolute } from './cli-binary';
import { envValue } from './path-env';
import type { Env } from './fs-probe';

/**
 * The process list on Windows, which has no `ps`: what the sleep and the stall
 * passes read there (services/stall-watch.ts, readProcesses). Until it, both
 * read nothing on Windows: no idle agent was put to sleep and no frozen one
 * marked stalled.
 *
 * Read from Win32_Process by the Windows PowerShell under a plain absolute
 * %SystemRoot% (C:\Windows otherwise), never one the PATH finds; without a
 * profile, input or the PSModulePath of a PowerShell 7 parent (child-env.ts);
 * in UTF-8, so an accent in a user's folder survives; with no console window,
 * powershell.exe being a console program and Tars a window one. Each process
 * gives its id, its parent's, its age and its command line, or its name when
 * it has none (System, a protected process).
 *
 * Windows never reparents: a process keeps the id of the one that started it
 * after that one ends, and the id goes to whatever starts next. A parent
 * younger than its child is not its parent, and that link is dropped
 * (ppid 0): a stranger left by a dead process whose id an agent's CLI now has
 * would otherwise read as a tool at work under it, and the agent would never
 * sleep nor be seen stalled. Ages come in milliseconds for that comparison.
 *
 * Not measured on a Windows machine yet (the parity program's P7): how long a
 * read takes there, and which children claude.exe keeps at rest.
 */

/** A process as Windows lists it: no state, since Windows keeps no zombie. `age` in seconds. */
export type WindowsProcess = { pid: number; ppid: number; age?: number; command: string };

/** A read of a few hundred processes takes about a second; one that hangs is given up. */
const READ_TIMEOUT_MS = 20_000;

const SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $now = Get-Date; '
  + 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine,Name | ForEach-Object { '
  + '[pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; '
  + 'a = $(if ($_.CreationDate) { [long](($now - $_.CreationDate).TotalMilliseconds) } else { $null }); '
  + 'c = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }) } } | ConvertTo-Json -Compress';

export function windowsProcessListCommand(env: Env): {
  file: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; windowsHide: true; timeout: number; maxBuffer: number };
} {
  const root = envValue(env, 'SystemRoot', 'win32');
  const systemRoot = root && isPlainAbsolute(root) ? root : 'C:\\Windows';
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    file,
    args: ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
    // Through unknown: Env and Next's ProcessEnv (which requires NODE_ENV) do not overlap.
    options: { env: childEnv(file, env, 'win32') as unknown as NodeJS.ProcessEnv, windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  };
}

type Row = { p: number; pp: number; a: number | null; c: string };

const isRow = (row: unknown): row is Row => {
  const r = row as Partial<Row> | null;
  return !!r && Number.isSafeInteger(r.p) && Number.isSafeInteger(r.pp) && typeof r.c === 'string'
    && (r.a === null || r.a === undefined || typeof r.a === 'number');
};

/** What the command prints, read; undefined when it is not the list. */
export function parseWindowsProcessList(out: string): WindowsProcess[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRow);
  const ageMs = new Map(rows.map((row) => [row.p, typeof row.a === 'number' && row.a >= 0 ? row.a : undefined]));
  return rows.map((row) => {
    const own = ageMs.get(row.p);
    const parents = ageMs.get(row.pp);
    const reused = own !== undefined && parents !== undefined && parents < own;
    return { pid: row.p, ppid: reused ? 0 : row.pp, age: own === undefined ? undefined : Math.floor(own / 1000), command: row.c };
  });
}

/** The processes running now, or undefined when Windows could not be read. */
export function readWindowsProcesses(env: Env = process.env as Env): Promise<WindowsProcess[] | undefined> {
  const { file, args, options } = windowsProcessListCommand(env);
  return new Promise((done) => {
    execFile(file, args, options, (err, stdout) => done(err ? undefined : parseWindowsProcessList(String(stdout))));
  });
}
