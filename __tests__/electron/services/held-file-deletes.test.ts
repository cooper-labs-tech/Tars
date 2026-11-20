import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

import { deleteMemoryFile } from '../../../electron/services/memory-service';
import { disableStatusLine } from '../../../electron/utils/statusline';
import { dataPath } from '../../../electron/constants';

/**
 * The two deletes a user asks for and sees fail, while another program still
 * holds the file for a moment (an antivirus, the indexer, an editor that has
 * it open with no delete sharing, as .NET opens by default):
 * - the Memory page's delete (deleteMemoryFile), which answered "EBUSY:
 *   resource busy or locked" for a file that was free a moment later;
 * - turning the status line off (disableStatusLine), whose delete of
 *   ~/.tars/rate-limits.json threw out of the Settings save, so the save
 *   answered failure although the settings had been written.
 *
 * How it can fail, written before the change:
 * 1. a hold that ends inside the retry budget still fails the delete, and the
 *    user sees the error;
 * 2. the call reports success and the file is still there;
 * 3. the test proves nothing: the file was not held yet when the delete ran
 *    (each delete starts only once the holder says it holds the file, and a
 *    witness shows the plain delete refused under the same hold).
 *
 * The hold is a real handle, opened by PowerShell with FileShare.None, and
 * let go 150 ms after the delete may start: well inside the 1 s budget even
 * when the full suite loads the machine and PowerShell wakes late (500 ms
 * overran it once, the file still held at the end).
 */

const holders: ChildProcess[] = [];

/** PowerShell holding `file` with no sharing for `ms` after it says ready; resolves once it holds it. */
function hold(file: string, ms: number): Promise<ChildProcess> {
  const script = [
    `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'None')`,
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    `Start-Sleep -Milliseconds ${ms}`,
    '$f.Close()',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  holders.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('ready')) resolve(child); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`the holder exited (${code}) before it held the file`)));
  });
}

afterEach(async () => {
  await Promise.all(holders.splice(0).map(c => new Promise<void>(r => (c.exitCode !== null ? r() : c.once('exit', () => r())))));
});

const plainUnlink = (file: string) => {
  try { fs.unlinkSync(file); return 'deleted'; } catch (e) { return (e as NodeJS.ErrnoException).code; }
};

describe.runIf(process.platform === 'win32')('a delete the user asked for, while another program holds the file (win32)', () => {
  it('1, 2, 3. the Memory page deletes a memory file once the holder lets go', async () => {
    const dir = path.join(os.homedir(), '.claude', 'projects', 'C--p', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'note.md');
    const witness = path.join(dir, 'witness.md');
    fs.writeFileSync(file, '# note\n');
    fs.writeFileSync(witness, '# witness\n');

    await hold(witness, 300);
    expect(plainUnlink(witness)).toBe('EBUSY');

    await hold(file, 150);
    expect(deleteMemoryFile(file)).toEqual({ success: true });
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  it('1, 2, 3. turning the status line off deletes the rate limits file once the holder lets go', async () => {
    const rateLimits = dataPath('rate-limits.json');
    const witness = dataPath('rate-limits.witness.json');
    fs.mkdirSync(path.dirname(rateLimits), { recursive: true });
    fs.writeFileSync(rateLimits, '{"five_hour":{"used_percentage":12}}\n');
    fs.writeFileSync(witness, '{}\n');

    await hold(witness, 300);
    expect(plainUnlink(witness)).toBe('EBUSY');

    await hold(rateLimits, 150);
    expect(() => disableStatusLine()).not.toThrow();
    expect(fs.existsSync(rateLimits)).toBe(false);
  }, 30_000);
});
