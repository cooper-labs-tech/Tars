import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { qwenTranscriptPath } from './qwen-code';
import { transcriptRoots } from '../utils/resume-session';
import { opencodeToolPartOf, qwenToolPartOf, type ToolCallPart } from './tool-calls';

/**
 * The tool calls of the traced sessions of Qwen Code and opencode, read from their own logs (trace feature C1, part 2,
 * 27/11), for each request's gap: codex's and pi's come through the watchers that already follow their logs
 * (codex-sessions.ts, pi-sessions.ts); these two harnesses have none, so they are followed here, on one timer, while
 * a traced session of theirs runs and for ENDED_GRACE_MS after its end (what a harness writes as it exits).
 *
 * - **Qwen Code** writes its chat to ~/.qwen/projects/<folder>/chats/<session>.jsonl (`qwenTranscriptPath`), the
 *   session the agent's hooks named, the folder its real working folder. Each byte is read once, at most QWEN_PASS_BYTES_MAX a file a pass; a last line
 *   still being written waits for its end.
 * - **opencode** keeps its sessions in SQLite, <XDG data home, else ~/.local/share>/opencode/opencode.db (the same
 *   rule on every system: it uses xdg-basedir; measured on macOS only). It is opened read-only, and only the parts of
 *   the sessions begun in the agent's folder since its traced session started are read, at most OPENCODE_PASS_ROWS_MAX a
 *   pass, each row once more each time it changes (a running call, then its end). Once opencode has exited cleanly,
 *   the store itself is never opened: after the session's end it is read once from a copy, deleted at once, for a store
 *   of OPENCODE_COPY_BYTES_MAX at most; a copy a crash left behind is removed at the next start.
 *
 * Read only, from the harness's own folders, never its configuration; a file or a database that is missing, or one
 * of another version, is nothing, and the other sessions are still read.
 */

export interface FollowedSession {
  traceId: string;
  agentId: string;
  harness: string;
  /** The folder the agent works in: its worktree, else its project. */
  folder: string;
  startedAt: number;
  endedAt?: number;
}

export interface HarnessToolLogsDeps {
  /** The traced sessions now open, and those that ended lately. */
  sessions: () => FollowedSession[];
  /** Qwen Code: the session the agent's hooks named, its chat file's name. */
  sessionIdOf: (agentId: string) => string | undefined;
  /** Production: traces-runtime.ts noteToolCall, which files the call on the session it happened in. */
  note: (agentId: string, part: ToolCallPart) => void;
  homeDir?: () => string;
  dataHome?: () => string;
  /** Where a copy of opencode's store, closed cleanly, is read: os.tmpdir() in the app. */
  tmpDir?: () => string;
  /** Tests only: OPENCODE_COPY_BYTES_MAX. */
  copyBytesMax?: number;
  now?: () => number;
}

/** How long a session is still read after its end: what its harness writes as it exits. */
export const ENDED_GRACE_MS = 30_000;
/** The most of a Qwen Code chat file a pass reads. */
export const QWEN_PASS_BYTES_MAX = 1024 * 1024;
/** The most rows of opencode's database a pass reads, for one session. */
export const OPENCODE_PASS_ROWS_MAX = 500;
/** How long a pass waits on opencode's database while a write holds it. */
const OPENCODE_LOCK_WAIT_MS = 50;
/** A session of opencode begun this much before the traced session is still its own (clocks, the launch). */
const OPENCODE_START_SLACK_MS = 1000;
/**
 * The biggest store copied after its session's end. The copy is byte by byte on Tars's main thread wherever Node makes
 * no clone (measured on 28/11 on APFS, under Node 22 and Electron 44: 64 MB in 0.05 to 0.21 s, 256 MB in 0.36 to 0.82 s).
 */
export const OPENCODE_COPY_BYTES_MAX = 64 * 1024 * 1024;
/** A copy's folder this old is no copy in use (one lives for one pass, a moment): the first pass removes it. */
export const OPENCODE_COPY_SWEEP_AGE_MS = 5 * 60_000;
const OPENCODE_COPY_PREFIX = 'tars-opencode-';

export class HarnessToolLogs {
  private files = new Map<string, { offset: number; partial: string }>();
  private cursors = new Map<string, { at: number; id: string }>();
  /** The store as each ended session's copy was read (its time and size): the same store is not copied again. */
  private copied = new Map<string, string>();
  private swept = false;

  constructor(private deps: HarnessToolLogsDeps) {}

  /** One pass over every followed session; never throws. */
  tick(): void {
    const now = (this.deps.now ?? Date.now)();
    if (!this.swept) {
      this.swept = true;
      this.sweepCopies(now);
    }
    for (const s of this.deps.sessions()) {
      if (s.endedAt !== undefined && now - s.endedAt > ENDED_GRACE_MS) {
        this.cursors.delete(s.traceId);
        this.copied.delete(s.traceId);
        continue;
      }
      try {
        if (s.harness === 'qwen-code') this.readQwen(s);
        else if (s.harness === 'opencode') this.readOpencode(s);
      } catch (err) {
        console.warn(`[traces] ${s.harness}'s log not read for ${s.traceId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The copies of opencode's store that a crash, or a removal that failed, left in the temporary folder: each one holds
   * every session's messages and tool output. Removed at the first pass after Tars starts, each by its own folder's name,
   * once older than OPENCODE_COPY_SWEEP_AGE_MS (another Tars, sharing the folder, may be reading a fresh one).
   */
  private sweepCopies(now: number): void {
    const tmp = (this.deps.tmpDir ?? os.tmpdir)();
    let names: string[];
    try { names = fs.readdirSync(tmp); } catch { return; }
    for (const name of names) {
      if (!OPENCODE_COPY_NAME.test(name)) continue;
      const dir = path.join(tmp, name);
      try {
        const st = fs.lstatSync(dir);
        if (st.isDirectory() && now - st.mtimeMs >= OPENCODE_COPY_SWEEP_AGE_MS) fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[traces] a copy of opencode's store not removed, ${dir}: ${(err as Error).message}`);
      }
    }
  }

  private readQwen(s: FollowedSession): void {
    const sessionId = this.deps.sessionIdOf(s.agentId);
    // Posted by the agent's own hooks, then joined into a path: no separator, no dot-dot (the Audit of #692).
    if (!sessionId || !SESSION_ID.test(sessionId)) return;
    // Qwen Code names its chat folder after its real working folder (macOS's /tmp is /private/tmp): every spelling of
    // the folder is tried, as every reader of a transcript does (transcriptRoots).
    const homeDir = (this.deps.homeDir ?? os.homedir)();
    const file = transcriptRoots(s.folder).map(f => qwenTranscriptPath(f, sessionId, homeDir)).find(f => fs.existsSync(f));
    if (!file) return;
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    const state = this.files.get(file) ?? { offset: 0, partial: '' };
    if (size <= state.offset) { this.files.set(file, state); return; }
    const length = Math.min(size - state.offset, QWEN_PASS_BYTES_MAX);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, length, state.offset); } finally { fs.closeSync(fd); }
    state.offset += length;
    const lines = (state.partial + buf.toString('utf8')).split('\n');
    state.partial = lines.pop() ?? '';
    this.files.set(file, state);
    for (const line of lines) {
      const part = qwenToolPartOf(line);
      if (part) this.deps.note(s.agentId, part);
    }
  }

  private readOpencode(s: FollowedSession): void {
    const file = path.join((this.deps.dataHome ?? defaultDataHome)(), 'opencode', 'opencode.db');
    if (!fs.existsSync(file)) return;
    if (!walClosed(file)) { this.readOpencodeRows(file, s); return; }
    // Closed cleanly, a WAL store has no -wal: opening it, even read-only, makes the -wal and the -shm and leaves them
    // behind (better-sqlite3 opens no `immutable` URI; measured on 28/11), so it is never opened. While its session
    // runs, an opencode that is not running writes nothing new. After the session's end, the rows of its last moments,
    // written since the last pass and moved into the store by its clean exit, are read from a copy in Tars's own
    // temporary folder, deleted at once, and only once for a store that has not changed since (the Audit of #692).
    if (s.endedAt === undefined) return;
    const st = fs.statSync(file);
    const seen = `${st.mtimeMs}:${st.size}`;
    if (this.copied.get(s.traceId) === seen) return;
    this.copied.set(s.traceId, seen);
    // Node clones a file only on the Linux file systems that can: elsewhere, APFS included, the copy is byte by byte,
    // on Tars's main thread (measured on 28/11). Past the bound it is not made, and the last request's toolMs stays null.
    if (st.size > (this.deps.copyBytesMax ?? OPENCODE_COPY_BYTES_MAX)) return;
    const dir = fs.mkdtempSync(path.join((this.deps.tmpDir ?? os.tmpdir)(), OPENCODE_COPY_PREFIX));
    try {
      const copy = path.join(dir, 'opencode.db');
      fs.copyFileSync(file, copy, fs.constants.COPYFILE_FICLONE);
      this.readOpencodeRows(copy, s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private readOpencodeRows(file: string, s: FollowedSession): void {
    // A moment at most on a lock (a store not in WAL mode, mid-write): never the driver's 5 s on Tars's main thread.
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: OPENCODE_LOCK_WAIT_MS });
    try {
      const folders = [...new Set([s.folder, realpathOr(s.folder)])];
      const cursor = this.cursors.get(s.traceId) ?? { at: -1, id: '' };
      const rows = db.prepare(`SELECT p.id AS id, p.time_updated AS at, p.data AS data FROM part p JOIN session s ON s.id = p.session_id
        WHERE s.directory IN (${folders.map(() => '?').join(', ')}) AND s.time_created >= ?
          AND (p.time_updated > ? OR (p.time_updated = ? AND p.id > ?)) AND json_extract(p.data, '$.type') = 'tool'
        ORDER BY p.time_updated, p.id LIMIT ?`)
        .all(...folders, s.startedAt - OPENCODE_START_SLACK_MS, cursor.at, cursor.at, cursor.id, OPENCODE_PASS_ROWS_MAX) as Array<{ id: string; at: number; data: string }>;
      for (const r of rows) {
        let data: unknown;
        try { data = JSON.parse(r.data); } catch { continue; }
        const part = opencodeToolPartOf(data);
        if (part) this.deps.note(s.agentId, part);
      }
      if (rows.length) this.cursors.set(s.traceId, { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id });
    } catch (err) {
      // Locked: read on the next pass, where the cursor left it.
      if ((err as { code?: string }).code !== 'SQLITE_BUSY') throw err;
    } finally {
      db.close();
    }
  }
}

/** A session id that may go into a file's name: what Tars's own session ids are (chats.ts). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Whether a SQLite store is in WAL mode (its header's byte 18 is 2) with no -wal beside it: no writer has it open. */
function walClosed(file: string): boolean {
  const header = Buffer.alloc(20);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
  return header[18] === 2 && !fs.existsSync(`${file}-wal`);
}

/** The name mkdtemp gives a copy's folder: the prefix and six letters or digits, nothing wider. */
const OPENCODE_COPY_NAME = /^tars-opencode-[A-Za-z0-9]{6}$/;

function defaultDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function realpathOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
