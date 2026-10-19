import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A delegated run's token, in a file only its owner reads, for its MCP servers (delegate.ts, mcpServersFor): in a
 * folder of its own, mode 0700 as mkdtemp makes it (on Windows, inside the user's own temporary folder), so that two
 * runs of one agent never share one, and removed with the run. The folder names the Tars that made it, so that what a
 * crash leaves is told apart from another Tars's run under way (sweepRunTokenFolders).
 */
export const RUN_TOKEN_FOLDER_PREFIX = `tars-run-${process.pid}-`;

export function writeRunTokenFile(token: string, tmp: string = os.tmpdir()): { file: string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(tmp, RUN_TOKEN_FOLDER_PREFIX));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
  return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A folder from before folders named their Tars is left for this long: it may be a run's under way. */
const UNNAMED_AFTER_MS = 60 * 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Another account's process: there, and none of this Tars's business.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * At Tars's start, the run token folders a run left behind: one that ended before its `finally`, or a Tars that
 * crashed or was killed (the Audit's L1 on #458). The token inside is dead, run tokens living in Tars's memory
 * only, but the folder is not Tars's to leave. Kept: another Tars's folder while that Tars runs (a sandbox, a second
 * profile), and one from before folders named their Tars, until it is an hour old. Returns how many went.
 */
export function sweepRunTokenFolders(tmp: string = os.tmpdir()): number {
  let names: string[];
  try { names = fs.readdirSync(tmp); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const m = /^tars-run-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(name);
    if (!m) continue;
    const dir = path.join(tmp, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const pid = m[1] === undefined ? undefined : Number(m[1]);
    if (pid !== undefined && pid !== process.pid && alive(pid)) continue;
    if (pid === undefined && Date.now() - stat.mtimeMs < UNNAMED_AFTER_MS) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* gone meanwhile, or not ours to remove */ }
  }
  return removed;
}
