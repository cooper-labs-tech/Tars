import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseLsofNames, readPathsInUse, usesPath } from '../../../electron/services/paths-in-use';

/**
 * What the live processes use, read for the agents' temporary folders (agent-tmp.ts, 17 to 23): every path a process
 * of this account holds (its executable, its current folder, its open files), and every command line.
 *
 * How it can fail, written before the code (21/11, QA's gate of #601's stack lost codex 0.170 and Kimi to the
 * retention while it ran them):
 * P1. A process's current folder is not read (macOS: lsof's cwd; Linux: /proc/<pid>/cwd).
 * P2. A file a process holds open is not read (macOS: lsof; Linux: /proc/<pid>/fd).
 * P3. The executable a process runs is not read (macOS: lsof's txt; Linux: /proc/<pid>/exe; Windows: the process's
 *     ExecutablePath).
 * P4. A script an interpreter loaded and closed is not read: its command line names it (ps; /proc/<pid>/cmdline;
 *     Windows: CommandLine).
 * P5. A read that never ends holds the pass: it gives up after its time and answers nothing (undefined), which the
 *     pass takes as "delete nothing".
 * P6. lsof's field output misread: a name that is no path (a socket, a pipe, `->`) taken for one, a path with spaces
 *     cut, the ` (deleted)` mark kept.
 * P7. A path or a command compared by prefix: `/a/tool` in use keeps `/a/tool-old`; on Windows, case or slashes
 *     telling the same path apart.
 * P8. (the Audit's I-4 on #627) macOS's APFS is case-insensitive by default (measured here 21/11: `MixedCase.txt` is
 *     found as `mixedcase.txt`): a command line spelling a unit with other capitals names it, and was compared case
 *     by case. On macOS case is not compared; on a case-sensitive volume that can only keep more.
 */

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.pid) try { process.kill(c.pid); } catch { /* gone */ }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("lsof's field output (P6)", () => {
  it('gives the paths alone, whole, without the deleted mark', () => {
    const out = [
      'p123', 'fcwd', 'n/Users/a/.tars/tmp/ab/t/work dir', 'ftxt', 'n/Users/a/.tars/tmp/ab/t/tool/bin/codex',
      'f3', 'n/dev/null', 'f4', 'n->0x1234abcd', 'f5', 'npipe', 'f6', 'n/private/tmp/gone.txt (deleted)',
      'f7', 'n127.0.0.1:31415->127.0.0.1:52000', 'p124', 'fcwd', 'n/', '',
    ].join('\n');
    expect(parseLsofNames(out)).toEqual([
      '/Users/a/.tars/tmp/ab/t/work dir', '/Users/a/.tars/tmp/ab/t/tool/bin/codex', '/dev/null', '/private/tmp/gone.txt', '/',
    ]);
  });
});

describe('a path in use, under a folder (P7)', () => {
  it('is the folder or under it, never a prefix of another name', () => {
    const inUse = { paths: ['/a/t/tool/bin/x'], commands: ['node /a/t/cli/run.js --serve', 'cat "/a/t/quoted/f"', 'ls /a/t/end'] };
    expect(usesPath(inUse, ['/a/t/tool'])).toBe(true);
    expect(usesPath(inUse, ['/a/t/tool/bin/x'])).toBe(true);
    expect(usesPath(inUse, ['/a/t/too'])).toBe(false);
    expect(usesPath(inUse, ['/a/t/cli'])).toBe(true);
    expect(usesPath(inUse, ['/a/t/quoted'])).toBe(true);
    expect(usesPath(inUse, ['/a/t/end'])).toBe(true);
    expect(usesPath({ paths: ['/a/t/tool-old/x'], commands: ['cat /a/t/tool-old/x'] }, ['/a/t/tool'])).toBe(false);
    expect(usesPath({ paths: [], commands: [] }, ['/a/t/tool'])).toBe(false);
  });

  it('P8. on macOS, whatever the case; on Linux, case by case', () => {
    const inUse = { paths: ['/Users/Demo/.tars/tmp/ab/t/Tool/bin/x'], commands: ['node /users/demo/.tars/tmp/ab/t/CLI/run.js'] };
    expect(usesPath(inUse, ['/Users/Demo/.tars/tmp/ab/t/tool'], 'darwin')).toBe(true);
    expect(usesPath(inUse, ['/Users/Demo/.tars/tmp/ab/t/cli'], 'darwin')).toBe(true);
    expect(usesPath(inUse, ['/Users/Demo/.tars/tmp/ab/t/tool'], 'linux')).toBe(false);
    expect(usesPath(inUse, ['/Users/Demo/.tars/tmp/ab/t/to'], 'darwin')).toBe(false);
  });

  it('on Windows, whatever the case or the slashes', () => {
    const inUse = { paths: ['C:\\Users\\Demo\\.tars\\tmp\\ab\\t\\Tool\\bin\\codex.exe'], commands: ['node c:/users/demo/.tars/tmp/ab/t/cli/run.js'] };
    expect(usesPath(inUse, ['c:\\users\\demo\\.tars\\tmp\\ab\\t\\tool'], 'win32')).toBe(true);
    expect(usesPath(inUse, ['C:\\Users\\Demo\\.tars\\tmp\\ab\\t\\cli'], 'win32')).toBe(true);
    expect(usesPath(inUse, ['C:\\Users\\Demo\\.tars\\tmp\\ab\\t\\to'], 'win32')).toBe(false);
  });
});

describe('the live processes, read from the system (P1 to P4)', () => {
  it("reads a process's executable and current folder, a file one holds open, and a script named on a command line", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-paths-in-use-')));
    dirs.push(dir);
    const work = path.join(dir, 'work');
    const held = path.join(dir, 'held', 'data.txt');
    const script = path.join(dir, 'scripts', 'hold.js');
    for (const d of [work, path.dirname(held), path.dirname(script)]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(held, 'x');
    fs.writeFileSync(script, `const fs = require('fs'); fs.openSync(${JSON.stringify(held)}, 'r'); process.stdout.write('ready\\n'); setInterval(() => {}, 1e9);`);
    // An executable of its own, run from the folder (macOS and Linux; Windows reads it the same way, ExecutablePath).
    const posix = process.platform !== 'win32';
    const exe = path.join(dir, 'tool', 'bin', 'sleepy');
    if (posix) {
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.copyFileSync(fs.existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep', exe);
      fs.chmodSync(exe, 0o755);
      children.push(spawn(exe, ['60'], { cwd: work, stdio: 'ignore' }));
    }
    const holder = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(holder);
    await new Promise<void>((resolve) => holder.stdout!.on('data', () => resolve()));

    const inUse = await readPathsInUse();

    expect(inUse).toBeDefined();
    expect(usesPath(inUse!, [path.join(dir, 'scripts')]), 'the script named on a command line').toBe(true);
    if (posix) {
      expect(usesPath(inUse!, [path.dirname(exe)]), 'the executable').toBe(true);
      expect(usesPath(inUse!, [work]), 'the current folder').toBe(true);
      expect(usesPath(inUse!, [path.dirname(held)]), 'the open file').toBe(true);
    }
    expect(usesPath(inUse!, [path.join(dir, 'nothing-here')])).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('P5. gives up on a read that never ends, and answers nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-paths-in-use-slow-'));
    dirs.push(dir);
    const slow = path.join(dir, 'lsof');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const started = Date.now();
    expect(await readPathsInUse({ lsof: slow, timeoutMs: 500 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
