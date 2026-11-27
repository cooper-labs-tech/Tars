import { safeGit } from '../utils/safe-git';
import { diffLines, isBinary, linesOf } from './line-diff';
import { readBlob, snapshotWorkspace, type WorkspaceSnapshot } from './workspace-snapshot';
import type { TraceStore, StoredVersion } from './trace-store';

/**
 * What each traced turn changed in the agent's repository, and how much of it lasted (trace feature B1).
 *
 * - **Boundaries.** A request that opens a turn takes a snapshot of the agent's checkout as it arrives, before it is
 *   forwarded (workspace-snapshot.ts): the start of that turn and the end of the one before. The terminal's exit
 *   takes the last one. A turn's edits are its tools', which run after the model answers, so the snapshot taken
 *   while the request is in flight is the state before them; edits a person makes between two turns count in the
 *   turn before.
 * - **Per turn:** the start and end HEAD and tree hash, the files changed, the lines added and removed (line-diff.ts),
 *   binary and oversized files counted as files and in no line, as git counts them.
 * - **Kept locally, never exported nor uploaded:** each version of each file a turn changed, compressed in the trace
 *   store, deleted with the session (its delete, retention, the cap) and counted against the cap.
 * - **Survival.** At the session's end, each turn's added lines are followed through the later turns' diffs to the
 *   last version: survived / changed, `reverted` when it changed lines and none is left. When the session's branch is
 *   later merged into the default branch, or deleted, the default branch's version of each file is the final one,
 *   the counts are written again and the session's change sequence moves (finalize).
 * - **Unknown is null.** A snapshot that failed or ran out of time, or a version whose bytes were lost (Tars
 *   restarted between two snapshots, or the bytes kept reached their limit), makes the counts it touches null, never 0.
 * - One session's boundaries are taken in the order they came, whatever the order their snapshots end in.
 * __tests__/electron/turn-workspace.test.ts says each way this goes wrong.
 */

/** A file at a boundary: its text, absent (null), unknown (undefined), or binary or too large to read in lines. */
export type Version = string | null | undefined | { binary: string };
export interface PathHistory { path: string; versions: Version[] }

interface Norm { id: string | null; text?: string; binary?: boolean }
function norm(v: Version): Norm {
  if (v === null) return { id: null };
  if (v === undefined) return { id: '?' };
  if (typeof v === 'string') return { id: `t:${v}`, text: v };
  return { id: `b:${v.binary}`, binary: true };
}
const linesOfNorm = (n: Norm): string[] | undefined => (n.id === null ? [] : n.text !== undefined ? linesOf(n.text) : undefined);

/** Turn `k`'s files and lines: the change from boundary k to k + 1. */
export function turnStats(histories: PathHistory[], k: number): { files: number; added: number | null; removed: number | null } {
  let files = 0;
  let added = 0;
  let removed = 0;
  let unknown = false;
  for (const h of histories) {
    const a = norm(h.versions[k]);
    const b = norm(h.versions[k + 1]);
    if (a.id === b.id) continue;
    files++;
    if (a.binary || b.binary) continue;
    const la = linesOfNorm(a);
    const lb = linesOfNorm(b);
    if (!la || !lb) { unknown = true; continue; }
    const d = diffLines(la, lb);
    added += d.added;
    removed += d.removed;
  }
  return { files, added: unknown ? null : added, removed: unknown ? null : removed };
}

export interface Survival { changed: number | null; survived: number | null; reverted: boolean | null }

/**
 * Each turn's added lines followed to the final version: the last boundary's, or `final`'s when given (the default
 * branch's version of each file, null for one absent there).
 */
export function survival(histories: PathHistory[], turns: number, final?: Map<string, Version>): Survival[] {
  const out: Survival[] = [];
  for (let k = 0; k < turns; k++) {
    let changed = 0;
    let survived = 0;
    let unknown = false;
    for (const h of histories) {
      const a = norm(h.versions[k]);
      const b = norm(h.versions[k + 1]);
      if (a.id === b.id || a.binary || b.binary) continue;
      const la = linesOfNorm(a);
      const lb = linesOfNorm(b);
      if (!la || !lb) { unknown = true; continue; }
      const d = diffLines(la, lb);
      const keptNew = new Set(d.kept.map(([, j]) => j));
      // The indexes, in version k + 1, of the lines this turn added.
      let alive: number[] = [];
      for (let j = 0; j < lb.length; j++) if (!keptNew.has(j)) alive.push(j);
      changed += alive.length;
      const chain: Version[] = [...h.versions.slice(k + 1, turns + 1), ...(final ? [final.has(h.path) ? final.get(h.path) : undefined] : [])];
      let cur = norm(chain[0]);
      for (let i = 1; i < chain.length && alive.length; i++) {
        const next = norm(chain[i]);
        if (next.id === cur.id) continue;
        if (next.binary || cur.binary) { alive = []; break; }
        const from = linesOfNorm(cur);
        const to = linesOfNorm(next);
        if (!from || !to) { unknown = true; alive = []; break; }
        const map = new Map(diffLines(from, to).kept);
        alive = alive.map(j => map.get(j)).filter((j): j is number => j !== undefined);
        cur = next;
      }
      survived += alive.length;
    }
    if (unknown) out.push({ changed: null, survived: null, reverted: null });
    else if (changed === 0) out.push({ changed: 0, survived: null, reverted: false });
    else out.push({ changed, survived, reverted: survived === 0 });
  }
  return out;
}

export interface RecorderDeps {
  store: TraceStore;
  snapshot?: (dir: string) => Promise<WorkspaceSnapshot>;
  readBlob?: (dir: string, id: string) => Promise<Buffer | null>;
  /** Tests: held before a boundary's counts, to show a slow one keeps its place. */
  delay?: (boundary: number) => Promise<void>;
  now?: () => number;
}

interface Live {
  /** The next boundary's index. */
  next: number;
  /** The boundaries' counts and writes, in the order the boundaries came. */
  chain: Promise<void>;
  /** The previous boundary's snapshot and folder, once its counts ran. */
  last?: { at: number; snap: WorkspaceSnapshot; dir: string; failed: boolean };
  /** The paths changed since the session began. */
  touched: Set<string>;
}

/** What a stored version reads as: its text, absent, unknown, or binary. */
export function versionOf(v: StoredVersion | null): Version {
  if (v === null) return null;
  if (v.binary) return { binary: v.id };
  return v.text;
}

export class WorkspaceRecorder {
  private readonly live = new Map<string, Live>();
  private readonly snap: (dir: string) => Promise<WorkspaceSnapshot>;
  private readonly blob: (dir: string, id: string) => Promise<Buffer | null>;
  private readonly now: () => number;

  constructor(private readonly deps: RecorderDeps) {
    this.snap = deps.snapshot ?? ((dir) => snapshotWorkspace(dir));
    this.blob = deps.readBlob ?? ((dir, id) => readBlob(dir, id));
    this.now = deps.now ?? Date.now;
  }

  private session(traceId: string): Live {
    let l = this.live.get(traceId);
    if (!l) { l = { next: 0, chain: Promise.resolve(), touched: new Set() }; this.live.set(traceId, l); }
    return l;
  }

  /** A turn began at `at`: its start, and the end of the turn before. Resolves once the snapshot is taken. */
  turnStarted(traceId: string, at: number, dir: string | undefined): Promise<void> {
    return this.boundary(traceId, at, dir, 'turn');
  }

  /** The session ended: the last turn's end, then each turn's survival. Resolves once the snapshot is taken. */
  sessionEnded(traceId: string, at: number, dir: string | undefined): Promise<void> {
    return this.boundary(traceId, at, dir, 'end');
  }

  /** Every boundary of the session counted and written. */
  async idle(traceId: string): Promise<void> {
    await this.live.get(traceId)?.chain;
  }

  private boundary(traceId: string, at: number, dir: string | undefined, kind: 'turn' | 'end'): Promise<void> {
    const l = this.session(traceId);
    const index = l.next++;
    const taken = dir ? this.snap(dir) : Promise.resolve<WorkspaceSnapshot>({ head: null, tree: null, files: null, contents: new Map(), ms: 0 });
    l.chain = l.chain.then(async () => {
      const snap = await taken;
      await this.deps.delay?.(index);
      await this.count(traceId, l, index, at, snap, dir, kind);
    }).catch((err) => {
      console.error(`[traces] a turn's workspace was not recorded: ${(err as Error).message}`);
    });
    if (kind === 'end') {
      const ended = l.chain;
      void ended.then(() => { if (this.live.get(traceId) === l) this.live.delete(traceId); });
    }
    return taken.then(() => undefined, () => undefined);
  }

  /** A version's text, binary mark or nothing, from the snapshot's bytes or the checkout's object store. */
  private async version(snap: WorkspaceSnapshot, dir: string, id: string | undefined): Promise<StoredVersion | null> {
    if (id === undefined) return null;
    if (id.startsWith('large:')) return { id, binary: true };
    const bytes = snap.contents.get(id) ?? await this.blob(dir, id);
    if (!bytes) return { id };
    if (isBinary(bytes)) return { id, binary: true };
    return { id, text: bytes.toString('utf8') };
  }

  private async count(traceId: string, l: Live, index: number, at: number, snap: WorkspaceSnapshot, dir: string | undefined, kind: 'turn' | 'end'): Promise<void> {
    const store = this.deps.store;
    const failed = !snap.files;
    store.addWorkspacePoint(traceId, { index, at, kind, head: snap.head, tree: snap.tree, ms: snap.ms, failed });
    const prev = l.last;
    if (prev) {
      // The turn that began at the previous boundary ends here.
      let stats: { files: number | null; added: number | null; removed: number | null } = { files: null, added: null, removed: null };
      if (!failed && !prev.failed && dir) {
        const changed: string[] = [];
        for (const p of new Set([...prev.snap.files!.keys(), ...snap.files!.keys()])) {
          if (prev.snap.files!.get(p) !== snap.files!.get(p)) changed.push(p);
        }
        const histories: PathHistory[] = [];
        for (const p of changed) {
          const before = await this.version(prev.snap, prev.dir, prev.snap.files!.get(p));
          const after = await this.version(snap, dir, snap.files!.get(p));
          if (!l.touched.has(p)) store.addWorkspaceVersion(traceId, index - 1, p, before);
          store.addWorkspaceVersion(traceId, index, p, after);
          l.touched.add(p);
          histories.push({ path: p, versions: [versionOf(before), versionOf(after)] });
        }
        stats = turnStats(histories, 0);
      }
      store.setTurnWorkspace(traceId, prev.at, {
        startHead: prev.snap.head, startTree: prev.snap.tree, endHead: snap.head, endTree: snap.tree,
        files: stats.files, linesAdded: stats.added, linesRemoved: stats.removed,
      });
    }
    if (kind === 'turn') {
      store.setTurnWorkspace(traceId, at, { startHead: snap.head, startTree: snap.tree });
      l.last = { at, snap, dir: dir ?? '', failed };
      return;
    }
    // The session's end: every turn's survival, to its last version.
    l.last = undefined;
    this.writeSurvival(traceId, undefined, 'session_end');
  }

  /** Survival over the stored versions, to the last boundary or to `final`; null for a turn across a failed one. */
  private writeSurvival(traceId: string, final: Map<string, Version> | undefined, basis: 'session_end' | 'merged' | 'deleted'): boolean {
    const store = this.deps.store;
    const points = store.workspacePoints(traceId);
    const turnStarts = points.filter(p => p.kind === 'turn');
    const turns = turnStarts.length;
    if (!turns) return false;
    const histories = store.workspaceHistories(traceId).map(h => ({ path: h.path, versions: h.versions.map(versionOf) }));
    const results = survival(histories, turns, final);
    const lastFailed = points.map(p => p.failed);
    const rows = turnStarts.map((t, k) => {
      // A failed boundary at or after this turn's end: its lines cannot be followed.
      const blind = lastFailed.slice(k).some(Boolean);
      const s = blind ? { changed: null, survived: null, reverted: null } : results[k];
      return { startedAt: t.at, changedLines: s.changed, survivedLines: s.survived, reverted: s.reverted };
    });
    return store.setSurvival(traceId, rows, basis, this.now());
  }

  /**
   * After the session: whether its branch was merged into the default branch, or deleted, and if so its survival
   * measured on the default branch's files. 'open' while the branch lives unmerged; 'done' when measured before;
   * 'default-branch' for a session on the default branch; 'unknown' when git could not tell.
   */
  async finalize(traceId: string, dir: string): Promise<'open' | 'merged' | 'deleted' | 'done' | 'default-branch' | 'no-branch' | 'unknown'> {
    const store = this.deps.store;
    const s = store.session(traceId);
    if (!s) return 'unknown';
    const branch = s.outcome?.branch;
    const head = s.outcome?.head;
    if (!branch || !head || branch === 'HEAD') return 'no-branch';
    if (store.workspaceTurns(traceId).some(t => t.survivalBasis === 'merged' || t.survivalBasis === 'deleted')) return 'done';
    const git = (args: string[]) => safeGit(dir, args, { timeout: 10_000 });
    const ok = (args: string[]) => git(args).then(() => true, (e: { code?: unknown; killed?: boolean }) => (e.code === 1 && !e.killed ? false : Promise.reject(e)));
    try {
      let ref = await git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).then(r => r.stdout.trim(), () => '');
      if (!ref) {
        for (const name of ['main', 'master']) if (await ok(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) { ref = name; break; }
      }
      if (!ref) return 'unknown';
      if (branch === ref || `origin/${branch}` === ref) return 'default-branch';
      const exists = await ok(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      const merged = await ok(['merge-base', '--is-ancestor', head, ref]);
      if (exists && !merged) return 'open';
      const paths = store.workspaceHistories(traceId).map(h => h.path);
      const final = new Map<string, Version>(paths.map(p => [p, null]));
      if (paths.length) {
        const listed = await git(['ls-tree', '-z', ref, '--', ...paths]);
        for (const rec of listed.stdout.split('\0').filter(Boolean)) {
          const tab = rec.indexOf('\t');
          const [, type, id] = rec.slice(0, tab).split(' ');
          const p = rec.slice(tab + 1);
          if (type !== 'blob') continue;
          const bytes = await this.blob(dir, id);
          final.set(p, bytes === null ? undefined : isBinary(bytes) ? { binary: id } : bytes.toString('utf8'));
        }
      }
      const basis = merged ? 'merged' : 'deleted';
      this.writeSurvival(traceId, final, basis);
      return basis;
    } catch {
      return 'unknown';
    }
  }
}
