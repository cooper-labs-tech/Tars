// Blobs on disk, one file per hash: <dataDir>/<aa>/<bb>/<hash>.zst, zstd-compressed.
//
// Why a folder and not the database or an object store: blobs are immutable and addressed by their
// hash, so a plain file is all they need. Keeping them out of Postgres keeps the database small,
// so its dumps, vacuums and restores stay fast, and the blob folder is backed up incrementally
// (a file never changes once written). One VPS needs no object store; moving to an S3-compatible
// one later means rewriting the four functions below.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, rmSync, existsSync, statfsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class BlobStore {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  pathOf(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad hash');
    return join(this.dir, hash.slice(0, 2), hash.slice(2, 4), `${hash}.zst`);
  }

  has(hash: string): boolean { return existsSync(this.pathOf(hash)); }

  /** Writes atomically: a temporary file, fsync, then rename, so a crash never leaves half a blob. */
  put(hash: string, zstdBytes: Buffer): void {
    const p = this.pathOf(hash);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, zstdBytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }

  get(hash: string): Buffer | null {
    try { return readFileSync(this.pathOf(hash)); } catch { return null; }
  }

  remove(hash: string): void { rmSync(this.pathOf(hash), { force: true }); }

  /** Free bytes on the blob store's disk. */
  free(): number {
    const s = statfsSync(this.dir);
    return s.bavail * s.bsize;
  }
}
