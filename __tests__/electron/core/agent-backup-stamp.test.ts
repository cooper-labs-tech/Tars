import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What tells our own agents.json from a file somebody else wrote.
 *
 * saveAgents stopped reading agents.json back to make its backup and keeps the
 * generation it wrote in memory instead, using it only while the file on disk
 * is still the one that rename put there. It decides that on a stamp taken
 * right after its own rename: size, modification time and inode. If that stamp
 * ever said yes to a file somebody else wrote, the backup would hold our
 * generation and the next save would put ours on disk, so the other writer's
 * content would be gone from both files with nothing to recover it from.
 *
 * The two tests below are the two ways a foreign writer can reach that file
 * with the size unchanged, which is the case the size alone cannot catch: a
 * rewrite in place, which keeps the inode and moves the time, and a rename,
 * which moves the inode and can carry any time a tool cares to set. Each one
 * has to be recognised as foreign and backed up.
 *
 * Measured on 2026-09-18: this filesystem gives mtime a true nanosecond
 * resolution (six successive writes, six distinct values), so the time cannot
 * repeat by accident. A tool that restores timestamps through utimensat, `cp
 * -p` or `touch -r`, can reproduce one exactly, which is why the second test
 * forges it rather than trusting that nothing can.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agents-stamp-'));
const AGENTS_FILE = path.join(tmp, 'agents.json');
const BACKUP_FILE = path.join(tmp, 'agents.backup.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.7.5' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

let manager: typeof import('../../../electron/core/agent-manager');

/**
 * `touch -r from to`: gives `to` the times of `from`, to the unit the disk
 * keeps. Windows has no touch; there the tool that keeps timestamps is
 * PowerShell, whose DateTime counts the 100 ns ticks NTFS stores, so it copies
 * the time exactly. Node cannot stand in for either: fs.utimesSync takes the
 * time as a double of seconds, which at today's date is coarser than 100 ns.
 */
function touchReference(from: string, to: string): void {
  if (process.platform !== 'win32') {
    execFileSync('/usr/bin/touch', ['-r', from, to]);
    return;
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    '$from = Get-Item -LiteralPath $env:TARS_TOUCH_FROM; $to = Get-Item -LiteralPath $env:TARS_TOUCH_TO; '
      + '$to.LastWriteTimeUtc = $from.LastWriteTimeUtc; $to.LastAccessTimeUtc = $from.LastAccessTimeUtc',
  ], { env: { ...process.env, TARS_TOUCH_FROM: from, TARS_TOUCH_TO: to }, stdio: 'pipe' });
}

function agent(id: string) {
  return {
    id,
    name: `Agent ${id}`,
    status: 'idle',
    projectPath: tmp,
    output: [],
    lastActivity: '2026-09-18T00:00:00.000Z',
    provider: 'claude',
    skills: [],
  };
}

/**
 * A valid agent list that is not ours, padded to the byte length of the file
 * on disk. Padding goes in `savedAt`, which loadAgents reads and ignores, so
 * the file stays parseable and non-empty: an unparseable or empty one is
 * refused by a different branch, which is somebody else's test.
 */
function foreignOfSameLength(length: number): string {
  const build = (pad: string) => JSON.stringify({
    version: 2,
    savedAt: `written-elsewhere${pad}`,
    agents: [agent('written-elsewhere')],
  });
  let pad = '';
  while (build(pad).length < length) pad += '.';
  const foreign = build(pad);
  expect(foreign, 'the foreign file could not be padded to the same length').toHaveLength(length);
  return foreign;
}

const stampOf = (file: string) => {
  const stat = fs.statSync(file, { bigint: true });
  return { size: stat.size, mtimeNs: stat.mtimeNs, ino: stat.ino };
};

beforeEach(async () => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  manager.loadAgents();
  manager.agents.set('a1', agent('a1') as never);
  manager.saveAgents();
});

afterEach(() => {
  manager.stopAgentAutosave();
  manager.agents.clear();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the file the backup shortcut is allowed to skip reading', () => {
  it('is not a foreign rewrite in place of exactly the same length', () => {
    const ours = stampOf(AGENTS_FILE);
    const foreign = foreignOfSameLength(Number(ours.size));

    // In place: the inode and the length are the ones our rename left, so the
    // modification time is the only thing left to tell them apart.
    const handle = fs.openSync(AGENTS_FILE, 'r+');
    fs.writeSync(handle, foreign, 0, 'utf-8');
    fs.closeSync(handle);
    const after = stampOf(AGENTS_FILE);
    expect(after.size, 'the rewrite changed the length, so this proves nothing').toBe(ours.size);
    expect(after.ino, 'the rewrite changed the inode, so this proves nothing').toBe(ours.ino);

    manager.saveAgents();

    expect(fs.readFileSync(BACKUP_FILE, 'utf-8')).toBe(foreign);
  });

  it('is not a foreign file renamed in carrying our own modification time', () => {
    const ours = stampOf(AGENTS_FILE);
    const foreign = foreignOfSameLength(Number(ours.size));

    // A tool that keeps timestamps: `touch -r` goes through utimensat, which
    // sets the nanoseconds our own rename wrote. The inode is then all that
    // differs, and it has to be enough.
    const incoming = path.join(tmp, 'agents.json.from-elsewhere');
    fs.writeFileSync(incoming, foreign);
    touchReference(AGENTS_FILE, incoming);
    expect(
      stampOf(incoming).mtimeNs,
      'touch -r did not reproduce the nanoseconds, so the forgery this test needs did not happen',
    ).toBe(ours.mtimeNs);
    fs.renameSync(incoming, AGENTS_FILE);

    const after = stampOf(AGENTS_FILE);
    expect(after.size).toBe(ours.size);
    expect(after.mtimeNs, 'the rename moved the time, so this proves nothing').toBe(ours.mtimeNs);
    expect(after.ino, 'the rename kept the inode, which it cannot do').not.toBe(ours.ino);

    manager.saveAgents();

    expect(fs.readFileSync(BACKUP_FILE, 'utf-8')).toBe(foreign);
  });
});
