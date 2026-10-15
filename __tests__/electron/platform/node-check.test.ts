import { describe, it, expect } from 'vitest';

import { nodeMissing } from '../../../electron/platform/node-check';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * Whether Tars says, at launch, that Node is missing on Windows.
 *
 * On win32 Tars's hooks run as `node "<runner>" <event>` (utils/hook-command.ts)
 * and its MCP servers as `node <bundle>` (utils/mcp-node.ts). With a native
 * claude.exe and no Node, the CLI starts, no session registers, the bundled
 * tools do not start, and Tars said nothing (QA on #358).
 *
 * How it fails, written before the code (2026-10-13):
 * 1. darwin/linux: anything said, or a disk access.
 * 2. win32: nothing said when no node.exe is on the PATH.
 * 3. win32: something said when node.exe is on the PATH.
 * 4. win32: a node.exe in a relative PATH entry (the current folder) counts.
 * 5. win32: a node.cmd, or a folder named node.exe, counts.
 * 6. What is said names neither what to do nor what stops working.
 */

function fakeFs(files: string[]): FsProbe & { asked: string[] } {
  const asked: string[] = [];
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    asked,
    isFile(p) {
      asked.push(p);
      return set.has(p.toLowerCase());
    },
    readFile() {
      throw new Error('not read');
    },
  };
}

describe('nodeMissing', () => {
  it('says nothing on darwin and linux, and asks the disk nothing (1)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const fs = fakeFs([]);
      expect(nodeMissing({ PATH: '/usr/bin' }, platform, fs)).toBeNull();
      expect(fs.asked).toEqual([]);
    }
  });

  it('says so on win32 when no node.exe is on the PATH (2, 6)', () => {
    const said = nodeMissing({ PATH: 'C:\\Windows\\System32' }, 'win32', fakeFs([]));
    expect(said).not.toBeNull();
    expect(said!.message).toMatch(/Node\.js/);
    expect(said!.detail).toMatch(/status/);
    expect(said!.detail).toMatch(/nodejs\.org/);
    expect(said!.detail).toMatch(/restart Tars/);
  });

  it('says nothing on win32 when node.exe is on the PATH (3)', () => {
    const fs = fakeFs(['C:\\Program Files\\nodejs\\node.exe']);
    expect(nodeMissing({ Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs' }, 'win32', fs)).toBeNull();
  });

  it('does not count a node.exe in a relative PATH entry (4)', () => {
    expect(nodeMissing({ PATH: '.;bin' }, 'win32', fakeFs(['.\\node.exe', 'bin\\node.exe', 'node.exe']))).not.toBeNull();
  });

  it('counts only a file named node.exe (5)', () => {
    expect(nodeMissing({ PATH: 'C:\\a' }, 'win32', fakeFs(['C:\\a\\node.cmd']))).not.toBeNull();
  });
});
