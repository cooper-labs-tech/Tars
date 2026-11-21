import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diskUsage } from '../../../electron/platform/disk-usage';

/**
 * What a folder takes on the disk, without du (electron/platform/disk-usage.ts).
 * Settings, System lists each folder no agent owns with its size, which
 * orphan-folders.ts asked `du -sk`: Windows has no du on a user's PATH (only a
 * Git Bash shell puts Git's on it), and every folder read 0 KB there, the
 * confirm saying "Remove these 3 folders, 0 KB, for good?" (orphan-folders.spec.ts,
 * 2026-10-07).
 *
 * How it fails, written before the code:
 * 1. A folder reads 0, or only what lies at its top, a nested file left out.
 * 2. A file is counted twice, or for less than it holds.
 * 3. A link is followed out of the folder (a junction on Windows), and what
 *    it points to is counted, as du never does.
 * 4. A folder that is gone, or cannot be read, throws instead of counting nothing.
 */

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-disk-usage-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (p: string, bytes: number) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 120));
};

describe('diskUsage', () => {
  it('1, 2. counts every file under the folder, nested ones too, each once', async () => {
    const dir = path.join(root, 'orphan');
    file(path.join(dir, 'big.bin'), 300_000);
    file(path.join(dir, 'node_modules', 'x', 'small.bin'), 100_000);
    const bytes = await diskUsage(dir);
    expect(bytes).toBeGreaterThanOrEqual(400_000);
    expect(bytes).toBeLessThan(600_000);
  });

  it('3. follows no link out of the folder', async () => {
    const dir = path.join(root, 'orphan');
    const outside = path.join(root, 'outside');
    file(path.join(dir, 'small.bin'), 100_000);
    file(path.join(outside, 'huge.bin'), 2_000_000);
    // A junction on Windows, which needs no privilege; a link to a folder elsewhere.
    fs.symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const bytes = await diskUsage(dir);
    expect(bytes).toBeGreaterThanOrEqual(100_000);
    expect(bytes).toBeLessThan(1_000_000);
  });

  it('4. counts nothing for a folder that is gone, and does not throw', async () => {
    await expect(diskUsage(path.join(root, 'gone'))).resolves.toBe(0);
  });
});
