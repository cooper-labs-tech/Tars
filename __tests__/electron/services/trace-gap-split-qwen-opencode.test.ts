// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * The tool calls of Qwen Code's and opencode's sessions, read from their own logs (trace feature C1, part 2, 27/11),
 * for the gap of each traced request (part 1, #688: codex and pi).
 *
 * What they write, measured on 27/11 (the real CLIs in an isolated bench against a stand-in endpoint asking for two
 * commands in one answer, 0.8 s exit 0 and 0.4 s exit 3):
 * - Qwen Code 0.25.2, in its chat file (~/.qwen/projects/<folder>/chats/<session>.jsonl, `qwenTranscriptPath`):
 *   - a `system` line, subtype `ui_telemetry`, whose `systemPayload.uiEvent` is `qwen-code.tool_call`: `call_id`,
 *     `started_at_ms`, `duration_ms`, `success`, `decision` (`accept`, `auto_accept`, `modify`, `reject`: a cancel is a
 *     reject, read in its bundle), `status`;
 *   - a `tool_result` line: `toolCallResult` with `callId`, `status`, and for a shell call `resultDisplay` with
 *     `exitCode`, `outcome` (`completed`, `failed`, `cancelled`) and `truncated`;
 *   - it ran the two commands one after the other.
 * - opencode 1.19.6, in its SQLite store (<XDG data home, else ~/.local/share>/opencode/opencode.db): a `part` row per
 *   call (`session_id`, `time_updated`, `data`), its data `{ type: 'tool', callID, state: { status, metadata: { exit,
 *   truncated }, time: { start, end } } }`; a `session` row with the `directory` it ran in and its `time_created`. It
 *   ran the two commands at once.
 *
 * How it fails, written before the code:
 *  1. Qwen's lines are not read: the call's start, time, decision and success from its telemetry line; its exit code,
 *     cut output and status from its result line; a rejected call is not denied, a failed one not failed.
 *  2. Qwen's calls, run one after the other, are placed from their lines' times rather than from `started_at_ms`.
 *  3. opencode's parts are not read: the call's id, start, end, exit and cut output; an `error` part is not failed; a
 *     part still `running` reads as ended (a time is made up for it).
 *  4. Another session is read: Qwen's file of another session id; opencode's session of another folder, or one begun
 *     before the traced session.
 *  5. Something is read twice (each pass from the start), or a last line still being written is read half.
 *  6. A pass reads without bound: a whole large file at once (at most 1 MiB a file a pass), every row at once (at most
 *     500 a pass, the rest next time).
 *  7. opencode's database is opened for writing: a pass changes it, or creates its journal files.
 *  8. A file or a database that is not there, or a database without these tables (another version), throws or stops
 *     the pass for the other sessions.
 *  9. A session that ended is dropped at once, so the lines its harness writes as it exits are lost; or it is followed
 *     for ever.
 * 10. A line or a row that is no tool call is read as one.
 * 11. (Found by the E2E, 27/11, before its fix.) The agent's folder is named through a link (macOS's /tmp is
 *     /private/tmp): Qwen Code names its chat folder after its real working folder, so a file looked for under the
 *     folder as Tars names it is never found.
 * 12. (Found by the E2E, 27/11, before its fix.) Qwen's result line gives no time of its own, so it cannot be put on
 *     the session it happened in, and the call's exit code and cut are lost: it carries the time it was written.
 * 13. (Found reading the code, 27/11, before its fix.) opencode's database, locked by a write (a store not in WAL mode),
 *     holds a pass on Tars's main thread for the driver's own wait, 5 s: a pass waits a moment at most, reads nothing,
 *     and the next pass reads what is there.
 * 14. (The Audit of #692, 28/11; measured.) opencode 1.19.6 keeps its store in WAL mode, and its clean close removes
 *     the -wal and -shm: a read-only open then makes them again and leaves them behind (better-sqlite3 opens no
 *     `immutable` URI). A store closed so must not be opened; one opencode runs must be read beside its writer, which
 *     never meets SQLITE_BUSY for it.
 * 15. (The Audit of #692.) Qwen's chat file is found from the session id the agent's own hooks posted: an id with a
 *     separator or a dot-dot leads the path outside ~/.qwen, and that file is read.
 * 16. (The Audit of #678.) A Qwen Code or opencode time with a fraction leaves as one, and the back office refuses the
 *     batch: a call's time is a whole number.
 * 17. (The Audit of #692, 28/11.) opencode's clean exit moves its last rows into the store and removes the -wal: the
 *     rows written after the last pass (the last request's call, in the session's last 2 s) sit in a store 14 leaves
 *     unopened, the grace reads nothing, and the last request's toolMs is null. Read after the session's end from a
 *     copy in Tars's temporary folder, the copy may be left there (its read failing too), be opened where opencode's
 *     store is, or be made again at every pass of the grace for a store that has not changed.
 * 18. (The Audit of #692, 28/11.) A crash, or a removal that failed, leaves a copy of opencode's whole store (every
 *     session's messages and tool output) in the temporary folder for good. The follower's first pass removes the
 *     copies older than a few minutes; it may remove none, a fresh one (a copy in use, another Tars's), or a folder
 *     that is not one of its copies.
 * 19. (The Audit of #692; measured on 28/11.) Node clones a file only on the Linux file systems that can (on APFS,
 *     which `cp -c` clones in 3 ms, its copy of 256 MB took 0.4 to 0.8 s), so the copy is byte by byte on Tars's main
 *     thread, however big the store: past OPENCODE_COPY_BYTES_MAX it must not be made at all (the last request's
 *     toolMs stays null), and under it it must.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

import { opencodeToolPartOf, qwenToolPartOf, toolCallAt, toolCallRecordOf, type ToolCallPart } from '../../../electron/services/tool-calls';
import {
  HarnessToolLogs, ENDED_GRACE_MS, QWEN_PASS_BYTES_MAX, OPENCODE_PASS_ROWS_MAX, type FollowedSession,
  type HarnessToolLogsDeps,
} from '../../../electron/services/harness-tool-logs';
import { qwenTranscriptPath } from '../../../electron/services/qwen-code';

let root: string;
let home: string;
let dataHome: string;
let folder: string;
/** Tars's temporary folder, where a copy of opencode's store is read. */
let tmp: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-c1b-'));
  home = path.join(root, 'home');
  dataHome = path.join(root, 'data');
  folder = path.join(root, 'project');
  tmp = path.join(root, 'tmp');
  for (const d of [home, dataHome, folder, tmp]) fs.mkdirSync(d, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Qwen Code 0.25.2's two lines for one call, in the shapes measured on 27/11. */
function qwenTelemetry(at: number, callId: string, o: { started: number; ms: number; success: boolean; decision?: string }): string {
  return JSON.stringify({
    uuid: 'u', parentUuid: null, sessionId: 's', timestamp: new Date(at).toISOString(), type: 'system', subtype: 'ui_telemetry', cwd: '/x', version: '0.25.2',
    systemPayload: { uiEvent: {
      'event.name': 'qwen-code.tool_call', 'event.timestamp': new Date(at).toISOString(), call_id: callId, function_name: 'run_shell_command',
      function_args: '{"command":"secret-command --token"}', duration_ms: o.ms, started_at_ms: o.started, status: o.success ? 'success' : 'error',
      execution_status: o.success ? 'success' : 'error', success: o.success, decision: o.decision ?? 'auto_accept', prompt_id: 'p', response_id: 'r',
    } },
  });
}
function qwenResult(at: number, callId: string, o: { status: string; exit?: number | null; outcome?: string; truncated?: boolean }): string {
  return JSON.stringify({
    uuid: 'v', parentUuid: 'u', sessionId: 's', timestamp: new Date(at).toISOString(), type: 'tool_result', cwd: '/x', version: '0.25.2',
    message: { role: 'user', parts: [{ functionResponse: { id: callId, name: 'run_shell_command', response: { output: 'secret output' } } }] },
    toolCallResult: {
      callId, status: o.status, executionStatus: o.status,
      ...(o.exit !== undefined ? { resultDisplay: { type: 'shell_result', version: 1, directory: '/x', exitCode: o.exit, signal: null, pid: null, outcome: o.outcome ?? 'completed', output: 'secret output', text: '', error: null, truncated: o.truncated ?? false } } : {}),
    },
  });
}

/** opencode 1.19.6's tool part, as measured on 27/11. */
function opencodePart(callId: string, s: { status: string; start: number; end?: number; exit?: number; truncated?: boolean }): Record<string, unknown> {
  return {
    type: 'tool', tool: 'bash', callID: callId,
    state: {
      status: s.status, input: { command: 'secret-command --token' }, ...(s.status === 'completed' || s.status === 'error' ? { output: 'secret output' } : {}),
      ...(s.exit !== undefined ? { metadata: { output: 'secret output', exit: s.exit, truncated: s.truncated ?? false } } : {}),
      title: 'secret-command', time: { start: s.start, ...(s.end !== undefined ? { end: s.end } : {}) },
    },
  };
}

describe('Qwen Code lines', () => {
  it('1 and 2: the telemetry line gives the call\'s start, time, decision and success; the result its exit, cut and status', () => {
    const t = Date.parse('2026-11-27T18:09:52.351Z');
    expect(qwenToolPartOf(qwenTelemetry(t, 'call_a', { started: t - 883, ms: 883, success: true }))).toEqual({ callId: 'call_a', startedAt: t - 883, wallMs: 883 });
    expect(qwenToolPartOf(qwenTelemetry(t, 'call_b', { started: t - 421, ms: 421, success: false }))).toEqual({ callId: 'call_b', startedAt: t - 421, wallMs: 421, failed: true });
    expect(qwenToolPartOf(qwenTelemetry(t, 'call_c', { started: t, ms: 0, success: false, decision: 'reject' }))).toEqual({ callId: 'call_c', startedAt: t, wallMs: 0, denied: true, failed: true });
    expect(qwenToolPartOf(qwenResult(t, 'call_a', { status: 'success', exit: 0 }))).toEqual({ callId: 'call_a', outputAt: t, exit: 0 });
    expect(qwenToolPartOf(qwenResult(t, 'call_b', { status: 'error', exit: 3, outcome: 'failed', truncated: true }))).toEqual({ callId: 'call_b', outputAt: t, exit: 3, failed: true, truncated: true });
    // A call that is no shell: no exit code.
    expect(qwenToolPartOf(qwenResult(t, 'call_d', { status: 'success' }))).toEqual({ callId: 'call_d', outputAt: t });
    // 12. The result line alone can be put on the session it happened in: it has a time.
    expect(toolCallAt(qwenToolPartOf(qwenResult(t, 'call_a', { status: 'success', exit: 0 }))!)).toBe(t);
    const merged = [qwenTelemetry(t, 'call_b', { started: t - 421, ms: 421, success: false }), qwenResult(t, 'call_b', { status: 'error', exit: 3, outcome: 'failed', truncated: true })]
      .map(l => qwenToolPartOf(l)!).reduce((a, b) => ({ ...b, ...a }));
    expect(toolCallRecordOf(merged)).toEqual({ toolCallId: 'call_b', exit: 3, ms: 421, denied: false, timedOut: false, failed: true, truncated: true });
    expect(JSON.stringify(merged)).not.toMatch(/secret/);
  });

  it('10: any other line is no call', () => {
    for (const line of ['', 'nope', JSON.stringify({ type: 'user', message: { role: 'user', parts: [{ text: 'hi' }] } }),
      JSON.stringify({ type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': 'qwen-code.api_response', duration_ms: 106 } } }),
      JSON.stringify({ type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { 'event.name': 'qwen-code.tool_call' } } }),
      JSON.stringify({ type: 'tool_result', toolCallResult: { status: 'success' } })]) expect(qwenToolPartOf(line), line).toBeNull();
  });
});

describe('opencode parts', () => {
  it('3: a completed part gives its id, span, exit and cut; an error part is failed; a running part has no end', () => {
    const t = 1795803072706;
    expect(opencodeToolPartOf(opencodePart('call_x', { status: 'completed', start: t, end: t + 835, exit: 0 }))).toEqual({ callId: 'call_x', itemStartedAt: t, itemEndedAt: t + 835, exit: 0 });
    expect(opencodeToolPartOf(opencodePart('call_y', { status: 'completed', start: t + 5, end: t + 438, exit: 3, truncated: true })))
      .toEqual({ callId: 'call_y', itemStartedAt: t + 5, itemEndedAt: t + 438, exit: 3, failed: true, truncated: true });
    expect(opencodeToolPartOf(opencodePart('call_z', { status: 'error', start: t, end: t + 12 }))).toEqual({ callId: 'call_z', itemStartedAt: t, itemEndedAt: t + 12, failed: true });
    const running = opencodeToolPartOf(opencodePart('call_r', { status: 'running', start: t }))!;
    expect(running).toEqual({ callId: 'call_r', itemStartedAt: t });
    expect(toolCallRecordOf(running).ms, 'a running call has no time yet').toBeNull();
    expect(JSON.stringify(opencodeToolPartOf(opencodePart('call_x', { status: 'completed', start: t, end: t + 835, exit: 0 })))).not.toMatch(/secret/);
  });

  it('10: any other part is no call', () => {
    for (const d of [null, 'text', {}, { type: 'text', text: 'hi' }, { type: 'step-finish', reason: 'stop' }, { type: 'tool', state: { status: 'completed' } }]) expect(opencodeToolPartOf(d), JSON.stringify(d)).toBeNull();
  });
});

/** A follower over throwaway folders, its notes kept. */
function follower(list: () => FollowedSession[], sessionIdOf: (agentId: string) => string | undefined = () => undefined, over: Partial<HarnessToolLogsDeps> = {}) {
  const noted: Array<{ agentId: string; part: ToolCallPart }> = [];
  const logs = new HarnessToolLogs({ sessions: list, sessionIdOf, note: (agentId, part) => noted.push({ agentId, part }), homeDir: () => home, dataHome: () => dataHome, tmpDir: () => tmp, ...over });
  return { logs, noted };
}

describe('the follower, Qwen Code', () => {
  it('4 and 5: reads the agent\'s own session file, each byte once, a half-written last line when it is whole', () => {
    const t = Date.now();
    const s: FollowedSession = { traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t - 1000 };
    const { logs, noted } = follower(() => [s], () => 'sess-1');
    const file = qwenTranscriptPath(folder, 'sess-1', home);
    const other = qwenTranscriptPath(folder, 'sess-0', home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(other, `${qwenTelemetry(t, 'call_other', { started: t, ms: 5, success: true })}\n`);
    const line = qwenTelemetry(t, 'call_a', { started: t - 883, ms: 883, success: true });
    fs.writeFileSync(file, `${line}\n${qwenResult(t, 'call_a', { status: 'success', exit: 0 }).slice(0, 40)}`);
    logs.tick();
    expect(noted.map(n => n.part.callId)).toEqual(['call_a']);
    fs.appendFileSync(file, `${qwenResult(t, 'call_a', { status: 'success', exit: 0 }).slice(40)}\n`);
    logs.tick();
    logs.tick();
    expect(noted.map(n => [n.agentId, n.part.callId, n.part.exit])).toEqual([['q', 'call_a', undefined], ['q', 'call_a', 0]]);
  });

  it(`6: a pass reads at most ${1024 * 1024} bytes of a file, the rest on the next`, () => {
    expect(QWEN_PASS_BYTES_MAX).toBe(1024 * 1024);
    const t = Date.now();
    const s: FollowedSession = { traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t - 1000 };
    const { logs, noted } = follower(() => [s], () => 'sess-1');
    const file = qwenTranscriptPath(folder, 'sess-1', home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const filler = JSON.stringify({ type: 'assistant', message: { role: 'model', parts: [{ text: 'x'.repeat(4096) }] } });
    const lines = Array.from({ length: 400 }, () => filler);
    lines.push(qwenTelemetry(t, 'call_late', { started: t, ms: 1, success: true }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    logs.tick();
    expect(noted.length, 'the call past the first MiB waits').toBe(0);
    logs.tick();
    expect(noted.map(n => n.part.callId)).toEqual(['call_late']);
  });

  it('11: a folder named through a link is read under its real path, where Qwen Code names its chat folder', () => {
    const t = Date.now();
    const real = path.join(root, 'real-project');
    const link = path.join(root, 'project-link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { logs, noted } = follower(() => [{ traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder: link, startedAt: t - 1000 }], () => 'sess-1');
    const file = qwenTranscriptPath(fs.realpathSync(link), 'sess-1', home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${qwenTelemetry(t, 'call_real', { started: t, ms: 4, success: true })}\n`);
    logs.tick();
    expect(noted.map(n => n.part.callId)).toEqual(['call_real']);
  });

  it('8: no session id, or no file, is nothing, and no throw', () => {
    const t = Date.now();
    const { logs, noted } = follower(() => [{ traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t }], () => undefined);
    expect(() => logs.tick()).not.toThrow();
    const second = follower(() => [{ traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t }], () => 'never-written');
    expect(() => second.logs.tick()).not.toThrow();
    expect([...noted, ...second.noted]).toEqual([]);
  });
});

/** opencode's store, with the tables and columns 1.19.6 has that the follower reads. */
function opencodeDb(): { db: Database.Database; file: string } {
  const file = path.join(dataHome, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  return { db, file };
}

describe('the follower, opencode', () => {
  it('4, 5 and 7: reads the parts of the sessions begun in the agent\'s folder since its start, each once, read-only', () => {
    const t = Date.now();
    const s: FollowedSession = { traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 };
    const { db, file } = opencodeDb();
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_mine', 'p', folder, 't', t - 500, t);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_before', 'p', folder, 't', t - 60_000, t);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_elsewhere', 'p', path.join(root, 'other'), 't', t - 500, t);
    const put = db.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)');
    put.run('p1', 'm1', 'ses_mine', t, t + 10, JSON.stringify(opencodePart('call_x', { status: 'running', start: t })));
    put.run('p2', 'm1', 'ses_before', t, t + 10, JSON.stringify(opencodePart('call_old', { status: 'completed', start: t, end: t + 5, exit: 0 })));
    put.run('p3', 'm1', 'ses_elsewhere', t, t + 10, JSON.stringify(opencodePart('call_far', { status: 'completed', start: t, end: t + 5, exit: 0 })));
    put.run('p4', 'm1', 'ses_mine', t, t + 11, JSON.stringify({ type: 'text', text: 'not a call' }));
    db.close();
    for (const f of fs.readdirSync(path.dirname(file))) if (f !== 'opencode.db') fs.rmSync(path.join(path.dirname(file), f));
    const before = fs.statSync(file).mtimeMs;
    const { logs, noted } = follower(() => [s]);
    logs.tick();
    logs.tick();
    expect(noted.map(n => [n.agentId, n.part.callId, n.part.itemEndedAt])).toEqual([['o', 'call_x', undefined]]);
    expect(fs.statSync(file).mtimeMs, 'the database is not written').toBe(before);
    expect(fs.readdirSync(path.dirname(file)).sort(), 'no journal made').toEqual(['opencode.db']);
    // The part completes: read again, once.
    const again = new Database(file);
    again.prepare('UPDATE part SET time_updated = ?, data = ? WHERE id = ?').run(t + 900, JSON.stringify(opencodePart('call_x', { status: 'completed', start: t, end: t + 835, exit: 0 })), 'p1');
    again.close();
    logs.tick();
    logs.tick();
    expect(noted.map(n => [n.part.callId, n.part.itemEndedAt])).toEqual([['call_x', undefined], ['call_x', t + 835]]);
  });

  it(`6: a pass reads at most ${500} rows, the rest on the next`, () => {
    expect(OPENCODE_PASS_ROWS_MAX).toBe(500);
    const t = Date.now();
    const { db } = opencodeDb();
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_mine', 'p', folder, 't', t - 500, t);
    const put = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 620; i++) put.run(`p${i}`, 'm', 'ses_mine', t, t + i, JSON.stringify(opencodePart(`c${i}`, { status: 'completed', start: t, end: t + 1, exit: 0 })));
    db.close();
    const { logs, noted } = follower(() => [{ traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 }]);
    logs.tick();
    expect(noted.length).toBe(500);
    logs.tick();
    expect(noted.length).toBe(620);
    expect(new Set(noted.map(n => n.part.callId)).size).toBe(620);
  });

  it('13: a database locked by a write holds a pass a moment at most, and the next pass reads it', () => {
    const t = Date.now();
    const { db } = opencodeDb();
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_mine', 'p', folder, 't', t - 500, t);
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'm', 'ses_mine', t, t + 1, JSON.stringify(opencodePart('call_l', { status: 'completed', start: t, end: t + 3, exit: 0 })));
    db.exec('BEGIN EXCLUSIVE');
    const { logs, noted } = follower(() => [{ traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 }]);
    const began = Date.now();
    expect(() => logs.tick()).not.toThrow();
    expect(Date.now() - began, 'the pass waited on the lock').toBeLessThan(1000);
    expect(noted).toEqual([]);
    db.exec('COMMIT');
    db.close();
    logs.tick();
    expect(noted.map(n => n.part.callId)).toEqual(['call_l']);
  });

  it('8: no database, or one without these tables, is nothing, and the other sessions are still read', () => {
    const t = Date.now();
    const qwenSession: FollowedSession = { traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t - 1000 };
    const oc: FollowedSession = { traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 };
    const file = qwenTranscriptPath(folder, 'sess-1', home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${qwenTelemetry(t, 'call_q', { started: t, ms: 3, success: true })}\n`);
    const { logs, noted } = follower(() => [oc, qwenSession], () => 'sess-1');
    expect(() => logs.tick()).not.toThrow();
    fs.mkdirSync(path.join(dataHome, 'opencode'), { recursive: true });
    new Database(path.join(dataHome, 'opencode', 'opencode.db')).exec('CREATE TABLE other (x INTEGER)');
    expect(() => logs.tick()).not.toThrow();
    expect(noted.map(n => n.part.callId)).toEqual(['call_q']);
  });
});

describe('opencode\'s WAL store', () => {
  /** A store in WAL mode, as opencode 1.19.6 keeps it, with one call of the agent's session; its writer left open. */
  function walStore(t: number): { file: string; writer: Database.Database } {
    const file = path.join(dataHome, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    writer.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('ses_mine', 'p', folder, 't', t - 500, t);
    writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'm', 'ses_mine', t, t + 1, JSON.stringify(opencodePart('call_w', { status: 'completed', start: t, end: t + 5, exit: 0 })));
    return { file, writer };
  }

  it('14: closed cleanly (no -wal) while its session runs, it is not opened, and no file is made beside it', () => {
    const t = Date.now();
    const { file, writer } = walStore(t);
    writer.close();
    expect(fs.readdirSync(path.dirname(file)), 'opencode\'s clean close').toEqual(['opencode.db']);
    const { logs, noted } = follower(() => [{ traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 }]);
    logs.tick();
    expect(fs.readdirSync(path.dirname(file)), 'no -wal or -shm left behind').toEqual(['opencode.db']);
    expect(noted).toEqual([]);
  });

  it('14: while opencode runs, it is read beside its writer, which never meets SQLITE_BUSY', () => {
    const t = Date.now();
    const { writer } = walStore(t);
    const { logs, noted } = follower(() => [{ traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 }]);
    let busy = 0;
    const put = writer.prepare('INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 40; i++) {
      logs.tick();
      try { put.run(`q${i}`, 'm', 'ses_mine', t, t + 10 + i, JSON.stringify(opencodePart(`call_${i}`, { status: 'completed', start: t, end: t + 1, exit: 0 }))); } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_BUSY') busy++; else throw err;
      }
    }
    logs.tick();
    writer.close();
    expect(busy).toBe(0);
    expect(noted.map(n => n.part.callId)).toContain('call_w');
    expect(new Set(noted.map(n => n.part.callId)).size).toBe(41);
  });

  it('17: after its session ended, the rows its clean exit moved into the store are read once, from a copy deleted at once', () => {
    const t = Date.now();
    const { file, writer } = walStore(t);
    const s: FollowedSession = { traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000 };
    const { logs, noted } = follower(() => [s]);
    logs.tick();
    // Within one 2 s pass: the last request's call, its answer, and opencode's clean exit, which removes the -wal.
    writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p2', 'm', 'ses_mine', t + 10, t + 20, JSON.stringify(opencodePart('call_last', { status: 'completed', start: t + 10, end: t + 19, exit: 0 })));
    writer.close();
    expect(fs.readdirSync(path.dirname(file)), 'opencode\'s clean exit').toEqual(['opencode.db']);
    s.endedAt = Date.now();
    logs.tick();
    expect(noted.map(n => n.part.callId)).toEqual(['call_w', 'call_last']);
    expect(fs.readdirSync(path.dirname(file)), 'nothing beside opencode\'s store').toEqual(['opencode.db']);
    expect(fs.readdirSync(tmp), 'the copy deleted').toEqual([]);
    // The store unchanged, the grace's next pass copies nothing: Tars's temporary folder is not touched again.
    const old = Math.floor(t / 1000) - 60;
    fs.utimesSync(tmp, old, old);
    logs.tick();
    expect(fs.statSync(tmp).mtimeMs, 'no second copy').toBe(old * 1000);
    expect(noted).toHaveLength(2);
  });

  it('17: a copy whose read fails (a store of another version) is deleted all the same', () => {
    const t = Date.now();
    const file = path.join(dataHome, 'opencode', 'opencode.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER)');
    writer.close();
    const { logs, noted } = follower(() => [{ traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000, endedAt: t }]);
    logs.tick();
    expect(noted).toEqual([]);
    expect(fs.readdirSync(tmp), 'the copy deleted').toEqual([]);
    expect(fs.readdirSync(path.dirname(file)), 'nothing beside opencode\'s store').toEqual(['opencode.db']);
  });

  it('19: past the bound, an ended session\'s closed store is not copied at all; under it, it is', () => {
    const t = Date.now();
    const { file, writer } = walStore(t);
    writer.close();
    const size = fs.statSync(file).size;
    const s: FollowedSession = { traceId: 'tr2', agentId: 'o', harness: 'opencode', folder, startedAt: t - 1000, endedAt: t };
    const over = follower(() => [s], undefined, { copyBytesMax: size - 1 });
    const old = Math.floor(t / 1000) - 60;
    fs.utimesSync(tmp, old, old);
    over.logs.tick();
    expect(fs.statSync(tmp).mtimeMs, 'no copy made, not even a folder for it').toBe(old * 1000);
    expect(over.noted).toEqual([]);
    const under = follower(() => [s], undefined, { copyBytesMax: size });
    under.logs.tick();
    expect(under.noted.map(n => n.part.callId)).toEqual(['call_w']);
    expect(fs.readdirSync(tmp), 'the copy deleted').toEqual([]);
    expect(fs.readdirSync(path.dirname(file)), 'nothing beside opencode\'s store').toEqual(['opencode.db']);
  });
});

describe('the copies of opencode\'s store', () => {
  it('18: the first pass removes the copies a crash left, older than the limit, by their own name only', () => {
    // An hour old: past the few minutes a copy can be in use (it lives for one pass), however the limit is set.
    const old = Math.floor(Date.now() / 1000) - 3600;
    const made = (name: string, at?: number) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'opencode.db'), 'every session of opencode');
      if (at !== undefined) fs.utimesSync(d, at, at);
    };
    made('tars-opencode-AbC123', old);
    made('tars-opencode-Fresh1');
    made('tars-opencode-old', old);
    made('tars-run-AbC123', old);
    const { logs } = follower(() => []);
    logs.tick();
    expect(fs.readdirSync(tmp).sort()).toEqual(['tars-opencode-Fresh1', 'tars-opencode-old', 'tars-run-AbC123']);
  });
});

describe('Qwen\'s session id', () => {
  it('15: an id with a separator or a dot-dot reads nothing, never a file outside ~/.qwen', () => {
    const t = Date.now();
    // Where a crafted id would lead: ~/.qwen/projects/<folder>/chats/<id>.jsonl, four folders up, is the home.
    fs.writeFileSync(path.join(home, 'outside.jsonl'), `${qwenTelemetry(t, 'call_out', { started: t, ms: 1, success: true })}\n`);
    for (const id of ['../../../../outside', 'a/b', 'a\\b', '..']) {
      const { logs, noted } = follower(() => [{ traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t - 1000 }], () => id);
      logs.tick();
      expect(noted, JSON.stringify(id)).toEqual([]);
    }
  });
});

describe('whole numbers', () => {
  it('16: Qwen Code\'s and opencode\'s times with fractions leave as whole numbers', () => {
    const t = Date.now();
    const q = qwenToolPartOf(qwenTelemetry(t, 'call_q', { started: t + 0.4, ms: 883.6, success: true }))!;
    expect(toolCallRecordOf(q).ms).toBe(884);
    const o = opencodeToolPartOf(opencodePart('call_o', { status: 'completed', start: t + 0.25, end: t + 835.7, exit: 0 }))!;
    expect(toolCallRecordOf(o).ms).toBe(835);
  });
});

describe('ended sessions', () => {
  it(`9: are followed for ${30_000} ms after their end, for what the harness writes as it exits, then dropped`, () => {
    expect(ENDED_GRACE_MS).toBe(30_000);
    const t = Date.now();
    let now = t;
    const s: FollowedSession = { traceId: 'tr1', agentId: 'q', harness: 'qwen-code', folder, startedAt: t - 5000, endedAt: t - 1000 };
    const noted: string[] = [];
    const logs = new HarnessToolLogs({ sessions: () => [s], sessionIdOf: () => 'sess-1', note: (_a, p) => noted.push(p.callId), homeDir: () => home, dataHome: () => dataHome, now: () => now });
    const file = qwenTranscriptPath(folder, 'sess-1', home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${qwenTelemetry(t - 1500, 'call_exit', { started: t - 1600, ms: 100, success: true })}\n`);
    logs.tick();
    expect(noted).toEqual(['call_exit']);
    fs.appendFileSync(file, `${qwenTelemetry(t, 'call_later', { started: t, ms: 1, success: true })}\n`);
    now = t - 1000 + 30_001;
    logs.tick();
    expect(noted, 'past the grace, no longer read').toEqual(['call_exit']);
  });
});
