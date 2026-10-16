import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A file this account cannot read, or a folder it cannot add a file to, for
 * the tests about a read or a write that fails, and what gives it back.
 *
 * macOS and Linux: the mode, then `restoreMode`, as those tests always did.
 * Windows has no mode bits: chmod only sets the read-only attribute, which a
 * folder ignores, and which leaves a file readable while refusing writes and a
 * rename over it, so a test built on it sees nothing fail, or a failure it
 * never meant to cause. There an access control entry denies this account the
 * one right in question (icacls), and nothing more: a file denied its data
 * still gives its size, times and id and can still be replaced, as with mode
 * 0000; a folder denied new files still lists and still reads. The failure
 * there is EPERM where POSIX says EACCES.
 */

const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');

function deny(target: string, rights: string): () => void {
  const account = os.userInfo().username;
  execFileSync(ICACLS, [target, '/deny', `${account}:(${rights})`], { stdio: 'pipe' });
  return () => {
    execFileSync(ICACLS, [target, '/remove:d', account], { stdio: 'pipe' });
  };
}

/** `file` unreadable: mode 0000, or on Windows its data denied (RD). */
export function makeUnreadable(file: string, restoreMode = 0o644): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o000);
    return () => fs.chmodSync(file, restoreMode);
  }
  return deny(file, 'RD');
}

/** No new file in `dir`: mode 0500, or on Windows adding a file denied (WD). */
export function makeUnwritable(dir: string, restoreMode = 0o700): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o500);
    return () => fs.chmodSync(dir, restoreMode);
  }
  return deny(dir, 'WD');
}

/**
 * `file` in `folder` cannot be removed. macOS and Linux: the folder at 0555,
 * as this test always did. Windows has no mode bits, and a read-only folder
 * still lets its children go: there access control entries deny this account
 * deleting the file and the folder deleting its children, since either one
 * alone still lets the file go (measured 2026-10-07). The failure there is
 * EPERM where POSIX says EACCES.
 */
export function makeUnremovable(folder: string, file: string): () => void {
  if (process.platform !== 'win32') {
    fs.chmodSync(folder, 0o555);
    return () => fs.chmodSync(folder, 0o755);
  }
  const restoreFile = deny(file, 'DE');
  const restoreFolder = deny(folder, 'DC');
  return () => {
    restoreFolder();
    restoreFile();
  };
}

/**
 * `file` unreadable to every process, whatever its privileges, until the
 * returned function is called: on Windows another process holds it open with
 * no sharing (FileShare.None), so each open for its data fails with a sharing
 * violation (EBUSY in Node), and sharing is enforced whatever the privileges.
 * The access control entry of makeUnreadable was not enough there: on CI's
 * windows-latest, whose account is an administrator, the E2E app read a file
 * denied that way and priced its turn (run 36242089925), while the unit tests'
 * own reads of one were refused. The first version of this holder did no
 * better there (run 36245102646, 22.5k tokens again): a PowerShell statement
 * list goes on after a failed open, so it said 'held' holding nothing, which
 * it does here too when another process has the file open. It now fails with
 * the reason when it cannot hold the file within 15 s, and the file is read
 * once from this process before the test relies on it being unreadable. That
 * check caught the next run (36248702474): the file read while the holder had
 * said 'held'. The holder now also locks the file's whole length, and no longer
 * waits on its stdin, which it had no need of; it is ended by its handle.
 * macOS and Linux: mode 0000, as makeUnreadable.
 */
export async function holdUnreadable(file: string, restoreMode = 0o644): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const restore = makeUnreadable(file, restoreMode);
    return async () => restore();
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Held only once the open has succeeded: an open that throws ends the
  // holder with its reason and never says it holds (a bare statement list
  // went on to print 'held' after a failed open). Tried again for up to 15 s,
  // since whatever scans a file just written may hold it for a moment.
  const script = "$ErrorActionPreference = 'Stop'; $until = (Get-Date).AddSeconds(15); "
    + "while ($true) { try { $f = [IO.File]::Open($env:TARS_HOLD_FILE, 'Open', 'Read', 'None'); break } "
    + "catch { if ((Get-Date) -gt $until) { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }; Start-Sleep -Milliseconds 100 } }; "
    // Its whole length locked as well, a second barrier in case an open gets
    // past the sharing mode (run 36248702474: the file read while 'held').
    // Then it sleeps until it is ended: nothing waits on stdin, which a host
    // may hand to a child already closed.
    + "$f.Lock(0, [Math]::Max([long]1, $f.Length)); "
    + "[Console]::Out.WriteLine('held ' + $PID); [Console]::Out.Flush(); Start-Sleep -Seconds 3600";
  const holder = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, TARS_HOLD_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let said = '';
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on('data', chunk => { said += String(chunk); if (said.includes('held')) resolve(); });
    holder.stderr!.on('data', chunk => { said += String(chunk); });
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error(`the process holding ${file} exited (${code}) before it held it: ${said.trim()}`)));
  });
  // Ended through its own handle, which closes the file and its lock.
  const release = () => new Promise<void>(resolve => {
    if (holder.exitCode !== null || holder.signalCode !== null) return resolve();
    holder.once('exit', () => resolve());
    holder.kill();
  });
  // The premise, checked here before a test relies on it: a file this very
  // process can still read is not one the app will fail to.
  let stillReadable = true;
  try { fs.readFileSync(file); } catch { stillReadable = false; }
  if (stillReadable) {
    const running = holder.exitCode === null && holder.signalCode === null;
    await release();
    throw new Error(`${file} could still be read while another process held it with no sharing and a lock `
      + `(holder ${running ? 'still running' : `exited ${holder.exitCode ?? holder.signalCode}`}, it said: ${said.trim()})`);
  }
  return release;
}
