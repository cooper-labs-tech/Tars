import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What the OS named the crash of a run that ended abruptly, read without its
 * memory (2.0.3, monitoring option 1; services/health/abrupt-end.ts).
 *
 * - darwin: the newest `Tars-*.ips` in ~/Library/Logs/DiagnosticReports
 *   written since that run started, of Tars's own bundle: its exception type
 *   (`EXC_BREAKPOINT`), and nothing else of it. An .ips is a JSON header line
 *   (app_name, bundleID...), then the report as JSON.
 * - linux, win32: none. Neither writes such a report without the process's
 *   memory (a core dump, a minidump), which never leaves the machine.
 */

const BUNDLE_ID = 'xyz.cooperlabs.tars';
const CRASH_TYPE = /^[A-Z][A-Z0-9_]{2,39}$/;
/** A report is a few hundred kilobytes; past this it is not what macOS writes. */
const MAX_REPORT = 8 * 1024 * 1024;

export function crashTypeSince(
  since: number,
  platform: NodeJS.Platform = process.platform,
  dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports'),
): string | null {
  if (platform !== 'darwin') return null;
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
