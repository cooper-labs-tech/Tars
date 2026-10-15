import type { PathLike, StatSyncOptions } from 'fs';

/**
 * A POSIX disk in memory, for the darwin and linux rule of electron/platform/cli-path.ts, which asks the disk
 * through fs.statSync and fs.accessSync, with no probe to inject. Its cases built their files under os.tmpdir()
 * and asked the host's disk: on a Windows host that is a C:\ path, which no POSIX rule calls absolute, on a disk
 * with no execute bit (Nexarion434, 2026-10-15). win-fake-disk.ts is the Windows one.
 *
 * Give onPosixDisk to vi.mock('fs'). Paths under POSIX_ROOT answer from the table, whatever the host: a missing
 * one is ENOENT, and access() refuses a bit the entry's mode grants nobody (EACCES). Every other path is the
 * real fs's.
 */
export const POSIX_ROOT = '/opt/tars-cli';

export interface PosixEntry {
  kind: 'file' | 'dir';
  mode: number;
}

const failure = (code: string, syscall: string, p: string) =>
  Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: p });

export function onPosixDisk(real: typeof import('fs'), table: Map<string, PosixEntry>): typeof import('fs') {
  const ours = (p: PathLike) => String(p) === POSIX_ROOT || String(p).startsWith(`${POSIX_ROOT}/`);
  const statSync = (p: PathLike, options?: StatSyncOptions) => {
    if (!ours(p)) return real.statSync(p, options);
    const entry = table.get(String(p));
    if (!entry) {
      if (options?.throwIfNoEntry === false) return undefined;
      throw failure('ENOENT', 'stat', String(p));
    }
    return { isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'dir', isSymbolicLink: () => false, mode: entry.mode };
  };
  const accessSync = (p: PathLike, mode: number = real.constants.F_OK) => {
    if (!ours(p)) return real.accessSync(p, mode);
    const entry = table.get(String(p));
    if (!entry) throw failure('ENOENT', 'access', String(p));
    // Each bit asked must be granted to someone: owner, group or other.
    for (const [bit, anyone] of [[real.constants.R_OK, 0o444], [real.constants.W_OK, 0o222], [real.constants.X_OK, 0o111]]) {
      if (mode & bit && !(entry.mode & anyone)) throw failure('EACCES', 'access', String(p));
    }
  };
  return { ...real, statSync: statSync as typeof real.statSync, accessSync };
}
