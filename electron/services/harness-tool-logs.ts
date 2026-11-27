import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { qwenTranscriptPath } from './qwen-code';
import { opencodeToolPartOf, qwenToolPartOf, type ToolCallPart } from './tool-calls';

/**
 * The tool calls of the traced sessions of Qwen Code and opencode, read from their own logs (trace feature C1, part 2,
 * 27/11), for each request's gap: codex's and pi's come through the watchers that already follow their logs
 * (codex-sessions.ts, pi-sessions.ts); these two harnesses have none, so they are followed here, on one timer, while
 * a traced session of theirs runs and for ENDED_GRACE_MS after its end (what a harness writes as it exits).
 *
 * - **Qwen Code** writes its chat to ~/.qwen/projects/<folder>/chats/<session>.jsonl (`qwenTranscriptPath`), the
 *   session the agent's hooks named. Each byte is read once, at most QWEN_PASS_BYTES_MAX a file a pass; a last line
 *   still being written waits for its end.
 * - **opencode** keeps its sessions in SQLite, <XDG data home, else ~/.local/share>/opencode/opencode.db (the same
 *   rule on every system: it uses xdg-basedir; measured on macOS only). It is opened read-only, and only the parts of
 *   the sessions begun in the agent's folder since its traced session started are read, at most OPENCODE_PASS_ROWS_MAX a
 *   pass, each row once more each time it changes (a running call, then its end).
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
  now?: () => number;
}

/** How long a session is still read after its end: what its harness writes as it exits. */
export const ENDED_GRACE_MS = 30_000;
/** The most of a Qwen Code chat file a pass reads. */
export const QWEN_PASS_BYTES_MAX = 1024 * 1024;
/** The most rows of opencode's database a pass reads, for one session. */
export const OPENCODE_PASS_ROWS_MAX = 500;
/** A session of opencode begun this much before the traced session is still its own (clocks, the launch). */
const OPENCODE_START_SLACK_MS = 1000;

export class HarnessToolLogs {
  private files = new Map<string, { offset: number; partial: string }>();
  private cursors = new Map<string, { at: number; id: string }>();

  constructor(private deps: HarnessToolLogsDeps) {}

  /** One pass over every followed session; never throws. */
  tick(): void {
    const now = (this.deps.now ?? Date.now)();
    for (const s of this.deps.sessions()) {
      if (s.endedAt !== undefined && now - s.endedAt > ENDED_GRACE_MS) {
        this.cursors.delete(s.traceId);
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

  private readQwen(s: FollowedSession): void {
    const sessionId = this.deps.sessionIdOf(s.agentId);
    if (!sessionId) return;
    const file = qwenTranscriptPath(s.folder, sessionId, (this.deps.homeDir ?? os.homedir)());
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
    const db = new Database(file, { readonly: true, fileMustExist: true });
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
    } finally {
      db.close();
    }
  }
}

function defaultDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function realpathOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}
