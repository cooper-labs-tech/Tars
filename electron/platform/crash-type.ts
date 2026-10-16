import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { childEnv } from './child-env';
import { isPlainAbsolute } from './cli-binary';
import { envValue } from './path-env';
import type { Env } from './fs-probe';

/**
 * What the OS named the crash of a run that ended abruptly, read without its
 * memory (2.0.3, monitoring option 1; services/health/abrupt-end.ts). Tars
 * starts no crash handler of its own (no native dumps, services/error-reports),
 * so its crash reaches the OS's.
 *
 * - darwin: the newest `Tars-*.ips` in ~/Library/Logs/DiagnosticReports
 *   written since that run started, of Tars's own bundle: its exception type
 *   (`EXC_BREAKPOINT`), and nothing else of it. An .ips is a JSON header line
 *   (app_name, bundleID...), then the report as JSON.
 * - linux: systemd-coredump's record of the newest crash since that run
 *   started, of this user and of Tars's own executable
 *   (`coredumpctl --json=short list`): its signal's name (`SIGTRAP`). The core
 *   is never read. Without systemd-coredump, none: Ubuntu's apport writes
 *   nothing for a program it did not install.
 * - win32: the newest event 1000 (Application Error) of the Application log
 *   since that run started, of Tars's own executable, which Windows Error
 *   Reporting writes for a program that crashed: its exception code, named
 *   (`EXCEPTION_BREAKPOINT`). Read by the Windows PowerShell under
 *   %SystemRoot%.
 *
 * Null when there is none, or the answer is not what the OS writes; never
 * throws. Linux and Windows run a program, so the read is asynchronous.
 */

const BUNDLE_ID = 'xyz.cooperlabs.tars';
const CRASH_TYPE = /^[A-Z][A-Z0-9_]{2,39}$/;
/** A report is a few hundred kilobytes; past this it is not what macOS writes. */
const MAX_REPORT = 8 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;

/** A program's output, or null when it is missing, fails or takes too long. */
export type ReadOutput = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string | null>;

const readOutput: ReadOutput = (file, args, env) => new Promise((resolve) => {
  execFile(file, args, { env, timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => resolve(err ? null : String(stdout)));
});

/** What a test hands in instead of this machine: the program runner, the executable's name, the user, the environment. */
export interface CrashTypeDeps {
  read?: ReadOutput;
  exe?: string;
  uid?: number;
  env?: Env;
}

export async function crashTypeSince(
  since: number,
  platform: NodeJS.Platform = process.platform,
  dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports'),
  deps: CrashTypeDeps = {},
): Promise<string | null> {
  try {
    if (platform === 'darwin') return macCrashType(since, dir);
    if (platform === 'linux') {
      return await linuxCrashType(since, deps.read ?? readOutput, deps.exe ?? path.posix.basename(process.execPath), deps.uid ?? process.getuid?.());
    }
    if (platform === 'win32') {
      return await windowsCrashType(since, deps.read ?? readOutput, deps.exe ?? path.win32.basename(process.execPath), deps.env ?? (process.env as Env));
    }
  } catch {
    // Never throws: the report goes without the type.
  }
  return null;
}

function macCrashType(since: number, dir: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^Tars-.*\.ips$/.test(n));
  } catch {
    return null;
  }
  const recent = names
    .map((n) => {
      try {
        const stat = fs.statSync(path.join(dir, n));
        return stat.isFile() && stat.size <= MAX_REPORT && stat.mtimeMs >= since ? { n, at: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { n: string; at: number } => !!x)
    .sort((a, b) => b.at - a.at);
  for (const { n } of recent) {
    const type = exceptionTypeOf(path.join(dir, n));
    if (type) return type;
  }
  return null;
}

function exceptionTypeOf(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    if (newline === -1) return null;
    const header = JSON.parse(text.slice(0, newline)) as { bundleID?: unknown };
    if (header?.bundleID !== BUNDLE_ID) return null;
    const body = JSON.parse(text.slice(newline + 1)) as { exception?: { type?: unknown } };
    const type = body?.exception?.type;
    return typeof type === 'string' && CRASH_TYPE.test(type) ? type : null;
  } catch {
    return null;
  }
}

/** Linux's numbers, whatever the host: a crash is named by what the kernel sent. */
const LINUX_SIGNALS: Record<number, string> = {
  4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV', 31: 'SIGSYS',
};

async function linuxCrashType(since: number, read: ReadOutput, exe: string, uid: number | undefined): Promise<string | null> {
  const out = await read('coredumpctl', ['--json=short', '--no-pager', `--since=@${Math.floor(since / 1000)}`, 'list']);
  if (!out) return null;
  const rows: unknown = JSON.parse(out);
  if (!Array.isArray(rows)) return null;
  const ours = rows
    .filter((r): r is { time: number; uid: number; exe: string; sig: number } => !!r && typeof r === 'object'
      && Number.isSafeInteger(r.sig) && typeof r.exe === 'string' && typeof r.time === 'number' && Number.isSafeInteger(r.uid))
    // coredumpctl's time is in microseconds.
    .filter((r) => r.uid === uid && path.posix.basename(r.exe) === exe && r.time / 1000 >= since)
    .sort((a, b) => b.time - a.time);
  if (!ours.length) return null;
  const name = LINUX_SIGNALS[ours[0].sig] ?? `SIG${ours[0].sig}`;
  return CRASH_TYPE.test(name) ? name : null;
}

/** The exception codes a crash of Tars's can carry, by the names Windows gives them. */
const WINDOWS_EXCEPTIONS: Record<string, string> = {
  c0000005: 'EXCEPTION_ACCESS_VIOLATION',
  '80000003': 'EXCEPTION_BREAKPOINT',
  c000001d: 'EXCEPTION_ILLEGAL_INSTRUCTION',
  c0000094: 'EXCEPTION_INT_DIVIDE_BY_ZERO',
  c00000fd: 'EXCEPTION_STACK_OVERFLOW',
  c0000374: 'STATUS_HEAP_CORRUPTION',
  c0000409: 'STATUS_STACK_BUFFER_OVERRUN',
  c0000602: 'STATUS_FAIL_FAST_EXCEPTION',
};

const EVENT_SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
  + '$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:TARS_SINCE).LocalDateTime; '
  + "@(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $since } "
  + '-MaxEvents 20 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ '
  + 'app = [string]$_.Properties[0].Value; code = [string]$_.Properties[6].Value; at = $_.TimeCreated.ToUniversalTime().ToString(\'o\') } }) '
  + '| ConvertTo-Json -Compress';

async function windowsCrashType(since: number, read: ReadOutput, exe: string, env: Env): Promise<string | null> {
  const configured = envValue(env, 'SystemRoot', 'win32');
  const systemRoot = configured && isPlainAbsolute(configured) ? configured : 'C:\\Windows';
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const childEnvironment = { ...childEnv(file, env, 'win32'), TARS_SINCE: String(since) } as unknown as NodeJS.ProcessEnv;
  const out = await read(file, ['-NoProfile', '-NonInteractive', '-Command', EVENT_SCRIPT], childEnvironment);
  if (!out || !out.trim()) return null;
  const parsed: unknown = JSON.parse(out.replace(/^\uFEFF/, ''));
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  // As on macOS, the newest that is what the OS writes: an event whose code is not an exception code is passed over.
  const ours = rows
    .filter((r): r is { app: string; code: string; at: string } => !!r && typeof r === 'object'
      && typeof r.app === 'string' && typeof r.code === 'string' && typeof r.at === 'string')
    .map((r) => ({ app: r.app, code: r.code.trim().toLowerCase().replace(/^0x/, ''), ms: Date.parse(r.at) }))
    .filter((r) => /^[0-9a-f]{8}$/.test(r.code) && r.app.toLowerCase() === exe.toLowerCase() && r.ms >= since)
    .sort((a, b) => b.ms - a.ms);
  if (!ours.length) return null;
  return WINDOWS_EXCEPTIONS[ours[0].code] ?? `EXCEPTION_${ours[0].code.toUpperCase()}`;
}
