import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { safeGit } from '../utils/safe-git';

/**
 * A snapshot of an agent's checkout at a traced turn's start or end (trace feature B1, turn-workspace.ts): its HEAD,
 * a hash of its working tree, the dirty and untracked files included, and the bytes of what is dirty.
 *
 * It never disturbs the checkout. Every call goes through safeGit (argv, --no-optional-locks, GIT_OPTIONAL_LOCKS=0,
 * no program of the repository's) and only reads: `rev-parse`, `ls-files -s`, `diff-files --name-only`, `ls-files
 * --others --exclude-standard`, `cat-file blob`. No index refresh, no index.lock, no object written: a dirty or
 * untracked file is read and hashed here, as git would hash it (`blob <size>\0<bytes>`), never handed to
 * `git hash-object -w`. A CRLF copy of an LF blob (autocrlf), touched without a change, hashes as its blob.
 *
 * Each call is bounded (timeoutMs). A call that fails or runs out of time gives null for the whole snapshot, never an
 * empty hash or a zero. The tree hash is the sha256 of `mode id path` per file, sorted by path: a content hash of the
 * working tree, not git's tree id (which would need objects written).
 * __tests__/electron/workspace-snapshot.test.ts says each way this goes wrong.
 */

export interface WorkspaceSnapshot {
  /** HEAD's commit; null with no commit yet, or when a call failed. */
  head: string | null;
  /** sha256 of the working tree's files; null when a call failed. */
  tree: string | null;
  /**
   * Each file of the working tree and its id: git's blob id as the index has it for a clean file, the blob id of the
   * bytes for a dirty or untracked one, `large:<size>:<mtime>` for one past the size limit. Null when a call failed.
   */
  files: Map<string, string> | null;
  /** The bytes of the dirty and untracked files read, by id (within maxDirtyBytes in all). */
  contents: Map<string, Buffer>;
  /** How long it took. */
  ms: number;
}

export interface SnapshotOptions {
  /** Each git call's bound, in ms (10 s by default). */
  timeoutMs?: number;
  /** Past this a dirty file is not read: its size and time stand for it (1 MiB by default). */
  maxFileBytes?: number;
  /** The dirty bytes kept in all (16 MiB by default); past it ids are still computed, bytes not kept. */
  maxDirtyBytes?: number;
}

const blobId = (bytes: Buffer, algo: 'sha1' | 'sha256') => createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** `ls-files -s -z`: mode, id and stage per path; a path in conflict (stages 1 to 3) is read from the disk. */
function parseIndex(out: string): { entries: Map<string, { mode: string; id: string }>; conflicted: Set<string> } {
  const entries = new Map<string, { mode: string; id: string }>();
  const conflicted = new Set<string>();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, id, stage] = rec.slice(0, tab).split(' ');
    const file = rec.slice(tab + 1);
    if (stage === '0') entries.set(file, { mode, id });
    else conflicted.add(file);
  }
  return { entries, conflicted };
}

const list = (out: string) => out.split('\0').filter(Boolean);

export async function snapshotWorkspace(dir: string, opts: SnapshotOptions = {}): Promise<WorkspaceSnapshot> {
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 10_000;
  const maxFile = opts.maxFileBytes ?? 1024 * 1024;
  const maxDirty = opts.maxDirtyBytes ?? 16 * 1024 * 1024;
  const none = (): WorkspaceSnapshot => ({ head: null, tree: null, files: null, contents: new Map(), ms: Date.now() - started });
  if (!fs.existsSync(dir)) return none();
  const run = (args: string[]) => safeGit(dir, args, { timeout, maxBuffer: 256 * 1024 * 1024 });
  let head: string | null;
  let index: ReturnType<typeof parseIndex>;
  let dirty: string[];
  let untracked: string[];
  try {
    const [h, idx, diff, others] = await Promise.all([
      // No commit yet: rev-parse --verify -q exits 1 and says nothing. Out of time, it is killed: a failure.
      run(['rev-parse', '--verify', '-q', 'HEAD']).then(r => r.stdout.trim() || null, (err: { code?: unknown; killed?: boolean }) => {
        if (err.code === 1 && !err.killed) return null;
        throw err;
      }),
      run(['ls-files', '-s', '-z']),
      run(['diff-files', '--name-only', '-z']),
      run(['ls-files', '-z', '--others', '--exclude-standard']),
    ]);
    head = h;
    index = parseIndex(idx.stdout);
    dirty = list(diff.stdout);
    untracked = list(others.stdout);
  } catch {
    return none();
  }

  const algo: 'sha1' | 'sha256' = [...index.entries.values()].some(e => e.id.length === 64) || (head?.length === 64) ? 'sha256' : 'sha1';
  const files = new Map<string, string>();
  const modes = new Map<string, string>();
  for (const [file, e] of index.entries) { files.set(file, e.id); modes.set(file, e.mode); }
  const contents = new Map<string, Buffer>();
  let kept = 0;
  // A file there that cannot be read (another process holds it, as Windows lets one do): kept, its content unknown,
  // and the tree hash unknown with it. Only a file really gone (ENOENT) counts as deleted (the Audit's L3).
  let unreadable = false;
  const cannotRead = (file: string, err: unknown, st?: fs.Stats): void => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { files.delete(file); modes.delete(file); return; }
    files.set(file, `unreadable:${st?.size ?? 0}:${Math.floor(st?.mtimeMs ?? 0)}`);
    unreadable = true;
  };
  const readOne = (file: string, indexId?: string) => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(dir, file));
    } catch (err) {
      cannotRead(file, err);
      return;
    }
    if (st.isDirectory()) return; // a submodule's folder: its index entry stands
    if (st.isSymbolicLink()) {
      files.set(file, blobId(Buffer.from(fs.readlinkSync(path.join(dir, file))), algo));
      modes.set(file, '120000');
      return;
    }
    if (!modes.has(file) || modes.get(file) === '120000') modes.set(file, st.mode & 0o111 ? '100755' : '100644');
    if (st.size > maxFile) { files.set(file, `large:${st.size}:${Math.floor(st.mtimeMs)}`); return; }
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(dir, file)); } catch (err) { cannotRead(file, err, st); return; }
    let id = blobId(bytes, algo);
    if (indexId && id !== indexId && bytes.includes(13)) {
      const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      if (blobId(lf, algo) === indexId) id = indexId;
    }
    files.set(file, id);
    if (id !== indexId && !contents.has(id) && kept + bytes.length <= maxDirty) {
      contents.set(id, bytes);
      kept += bytes.length;
    }
  };
  for (const file of new Set([...dirty, ...index.conflicted])) readOne(file, index.entries.get(file)?.id);
  for (const file of untracked) readOne(file);

  const lines = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(f => `${modes.get(f) ?? '100644'} ${files.get(f)} ${f}\n`);
  const tree = unreadable ? null : createHash('sha256').update(lines.join('')).digest('hex');
  return { head, tree, files, contents, ms: Date.now() - started };
}

/** A blob's bytes from the checkout's object store, read-only (`cat-file blob`); null when it is not there. */
export async function readBlob(dir: string, id: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer | null> {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) return null;
  try {
    const r = await safeGit(dir, ['cat-file', 'blob', id], { timeout: opts.timeoutMs ?? 10_000, maxBuffer: (opts.maxBytes ?? 1024 * 1024) + 1024, encoding: 'latin1' });
    return Buffer.from(r.stdout, 'latin1');
  } catch {
    return null;
  }
}
