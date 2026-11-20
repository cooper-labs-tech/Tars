import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * The files some processes hold open, by their real paths (platform/open-files.ts): what tells Tars that a new codex
 * session is the one the agent's own codex writes, when its first message does not say (services/codex-sessions.ts,
 * the Audit's M1 on #465). Measured on codex-cli 0.163.0: codex holds its rollout open from its first line to its
 * end, at rest included.
 *
 * The ways it fails:
 * 1. A file a process holds open not found: macOS's lsof names it by its real path (/private/var, not /var), and
 *    Linux's /proc/<pid>/fd links to it the way its kernel spells it.
 * 2. A file nobody holds, or one another process holds, said held: a session that is not the agent's is then bound.
 * 3. A process that is gone, or a pid that is no process, taken for an error: the others asked with it go unread.
 * 4. Windows, where no tool lists a process's files, answered as "none open": that reads as "the agent's codex does
 *    not hold this" when nobody can know. It is said unknown, undefined, and so is a reading that failed.
 * 5. lsof's lines misread: `p<pid>`, `f<fd>`, `n<name>`, a name with spaces in it, a deleted file's "(deleted)".
 */

import { filesOpenBy, namesFromLsof } from '../../../electron/platform/open-files';

let holders: ChildProcess[] = [];
afterEach(() => {
  for (const child of holders) child.kill();
  holders = [];
});

/** A process that opens `file` for appending and keeps it open, as codex keeps its rollout. */
async function holding(file: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'a'); process.stdout.write('open\\n'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`the holder exited (${code})`)));
  });
  return child;
}

const unix = process.platform === 'darwin' || process.platform === 'linux';

describe('the files a process holds open', () => {
  it.skipIf(!unix)('1, 2. the file it holds, by its real path, and not one it does not hold', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-open-files-'));
    const held = path.join(dir, 'rollout a.jsonl');
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(other, '');
    const child = await holding(held);
    const open = await filesOpenBy([child.pid!]);
    expect(open).toBeDefined();
    expect(open!.has(fs.realpathSync(held))).toBe(true);
    expect(open!.has(fs.realpathSync(other))).toBe(false);
  });

  it.skipIf(!unix)('2. what another process holds is not this one\'s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-open-files-'));
    const theirs = path.join(dir, 'theirs.jsonl');
    await holding(theirs);
    const mine = await holding(path.join(dir, 'mine.jsonl'));
    const open = await filesOpenBy([mine.pid!]);
    expect(open!.has(fs.realpathSync(theirs))).toBe(false);
  });

  it.skipIf(!unix)('3. a pid that is no process, beside one that is, takes nothing from the other', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-open-files-'));
    const held = path.join(dir, 'held.jsonl');
    const child = await holding(held);
    const gone = spawnSync(process.execPath, ['-e', '0']).pid!;
    const open = await filesOpenBy([gone, child.pid!]);
    expect(open!.has(fs.realpathSync(held))).toBe(true);
    expect(await filesOpenBy([gone])).toEqual(new Set());
  });

  it('4. on Windows: unknown, never "none"', async () => {
    expect(await filesOpenBy([process.pid], 'win32')).toBeUndefined();
  });

  it("5. lsof's -F lines: the names, spaces and all", () => {
    const out = ['p4242', 'fcwd', 'n/Users/me/projects/demo', 'f3', 'n/private/var/x/sessions/2026/10/18/rollout a b.jsonl', 'f4',
      'n/dev/ttys004', 'f5', 'n/tmp/gone.txt (deleted)', ''].join('\n');
    expect(namesFromLsof(out)).toEqual(['/Users/me/projects/demo', '/private/var/x/sessions/2026/10/18/rollout a b.jsonl', '/dev/ttys004', '/tmp/gone.txt (deleted)']);
  });
});
