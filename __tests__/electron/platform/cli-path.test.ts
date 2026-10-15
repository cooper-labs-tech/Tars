import { describe, it, expect, afterEach, vi } from 'vitest';
import { cliPathProblem } from '../../../electron/platform/cli-path';
import type { FsProbe } from '../../../electron/platform/fs-probe';
import { POSIX_ROOT, type PosixEntry } from './posix-fake-disk';

/**
 * The CLI an agent names for a new agent (create_agent's cliPath, 2.0.2), on each platform Tars runs on
 * (JeanBrasse, 2026-10-13: "Pour chaque modification, fait en sorte que ça tourne sur macos, windows et linux").
 *
 * How it fails, written before the code (2026-10-14):
 * 1. A cliPath Tars could not start is taken: the agent is made, and its launch fails later with no reason.
 * 2. darwin and linux: a relative path, a missing file, a folder or a file without an execute bit passes;
 *    or an absolute executable file is refused.
 * 3. win32 read as macOS: a .exe refused for its missing execute bit, or a file Windows does not start (an npm
 *    sh shim, a .ps1) taken; a relative path (bin\codex.exe), a drive-relative one (C:codex.exe) or an NTFS
 *    stream (codex.exe:evil) taken; a UNC path refused; a .cmd that is no npm shim taken. Tars starts a CLI
 *    on win32 the way electron/platform/cli-binary.ts resolves it, and the check must agree with it.
 * 4. The platform read once at import, or from the host: the rule must be the one of process.platform.
 * 5. Added on 2026-10-15, when Nexarion434 ran these on Windows: the host read for the platform, by the rule or by
 *    its cases. The darwin and linux rule calling a C:\ path absolute because the host does; or a case built from
 *    os.tmpdir() and the host's disk, which on a Windows host gave the darwin and linux cases a C:\ path and no
 *    execute bit. Each case builds its paths for its own platform, on a disk in memory: posix-fake-disk.ts for
 *    darwin and linux, an FsProbe for win32.
 */

const posixDisk = vi.hoisted(() => new Map<string, PosixEntry>());
vi.mock('fs', async (importOriginal) => (await import('./posix-fake-disk')).onPosixDisk(await importOriginal<typeof import('fs')>(), posixDisk));

const exe = `${POSIX_ROOT}/my-cli`;
const plain = `${POSIX_ROOT}/plain`;
const unbitted = `${POSIX_ROOT}/tool.exe`;
posixDisk
  .set(POSIX_ROOT, { kind: 'dir', mode: 0o755 })
  .set(exe, { kind: 'file', mode: 0o755 })
  .set(plain, { kind: 'file', mode: 0o644 })
  .set(unbitted, { kind: 'file', mode: 0o644 });

const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...real, value: platform });
}
afterEach(() => Object.defineProperty(process, 'platform', real));

describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('2. takes an absolute path to a file with an execute bit, and says why otherwise', () => {
    onPlatform(platform);
    expect(cliPathProblem(exe)).toBeNull();
    expect(cliPathProblem('my-cli')).toMatch(/absolute/);
    expect(cliPathProblem('./bin/my-cli')).toMatch(/absolute/);
    expect(cliPathProblem(`${POSIX_ROOT}/missing`)).toMatch(/no file/);
    expect(cliPathProblem(POSIX_ROOT)).toMatch(/not a file/);
    expect(cliPathProblem(plain)).toMatch(/not executable/);
    expect(cliPathProblem('')).toMatch(/absolute/);
    expect(cliPathProblem(42)).toMatch(/absolute/);
  });

  it('5. calls a Windows path relative, whatever the host', () => {
    onPlatform(platform);
    expect(cliPathProblem('C:\\tools\\my-cli')).toMatch(/absolute/);
  });
});

describe('on win32', () => {
  // An in-memory disk, as cli-binary.test.ts gives the resolver: Windows paths do not exist on the host.
  const files: Record<string, string> = {
    'C:\\tools\\codex.exe': '',
    'C:\\tools\\script.ps1': 'Write-Host hi',
    'C:\\tools\\notes.cmd': '@echo off\r\necho not an npm shim\r\n',
    '\\\\server\\share\\codex.exe': '',
  };
  const disk: FsProbe = {
    isFile: (p) => p in files,
    readFile: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return files[p];
    },
  };
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('3. takes what Tars starts on Windows: a .exe by drive or UNC path, or a name PATHEXT completes', () => {
    onPlatform('win32');
    expect(cliPathProblem('C:\\tools\\codex.exe', disk, env)).toBeNull();
    expect(cliPathProblem('\\\\server\\share\\codex.exe', disk, env)).toBeNull();
    expect(cliPathProblem('C:\\tools\\codex', disk, env)).toBeNull();
  });

  it("3. refuses what it does not start, with the resolver's reason", () => {
    onPlatform('win32');
    for (const [cliPath, why] of [
      ['bin\\codex.exe', /absolute/],
      ['codex.exe', /absolute/],
      ['C:codex.exe', /absolute/],
      ['C:\\tools\\codex.exe:evil', /absolute/],
      ['C:\\tools\\script.ps1', /not a Windows executable|not \.ps1|\.exe, \.com/],
      ['C:\\tools\\missing.exe', /No C:\\tools\\missing\.exe/],
      ['C:\\tools\\notes.cmd', /shim/],
    ] as const) {
      expect(cliPathProblem(cliPath, disk, env), cliPath).toMatch(why);
    }
  });
});

describe('the platform it reads', () => {
  it('4. is process.platform at the call, not the host', () => {
    onPlatform('darwin');
    expect(cliPathProblem(unbitted)).toMatch(/not executable/);
    onPlatform('win32');
    expect(cliPathProblem(unbitted, { isFile: () => false, readFile: () => '' }, {})).toMatch(/absolute/);
  });
});
