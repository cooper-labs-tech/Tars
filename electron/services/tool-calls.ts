/**
 * Each tool call of a traced session, read from the harness's own log (trace feature C1, 27/11): when it ran, how long,
 * its exit code, and whether it was denied, timed out, failed, or had its output cut before the harness sent it back.
 * A record holds ids, numbers and flags only: never a command, never an output (what is read of them is their size).
 *
 * What each harness writes, and how it was learned:
 * - **codex 0.170.0**, measured on 27/11 (a real run in an isolated bench, a stand-in endpoint asking for two calls at
 *   once, a failing one, a long output and one that returns while its process runs):
 *   - each command's end is an `event_msg` `item_completed` whose item is a `CommandExecution`: its id is the call's
 *     id, with `exit_code`, `status` (`completed`, `failed`, and `declined` in codex's own type), the output codex kept
 *     (`aggregated_output`, at most 64 KiB), and the event's `started_at_ms` and `completed_at_ms`;
 *   - what it sends back is a `function_call_output` (or `custom_tool_call_output`, apply_patch's) line: "Wall time: X
 *     seconds", then "Process exited with code N" (apply_patch: "Exit code: N"), or "Process running with session ID
 *     N" for a call that returned to the model while its process ran, then the output after "Output:";
 *   - a call that returned while running later ends as `failed`, exit -1, when its process ends or codex quits: its
 *     time is until it returned (the wall time), and it has no exit code;
 *   - a response's calls run at once, and their output lines are written together when the last one ends, so a
 *     call's own time is its command's, never its output line's.
 * - **pi 1.3.0 and 1.5.2**, read in their code (@earendil-works/pi-agent-core agent-loop.js, pi-coding-agent
 *   tools/bash.js): a `toolResult` message line with `toolCallId`, `durationMs` (timed around the tool's run; absent for
 *   a call blocked or refused before it ran), `isError`, its text (bash: "Command exited with code N", "Command timed
 *   out after N seconds", "Command aborted") and `details.truncation` (`totalBytes`, `outputBytes`). A response's calls
 *   run at once by default, all started once the assistant line that asked for them is written, and their results
 *   are written together at the end: a call is placed from that assistant line (`batchAt`), its length its own.
 */

/** What one line says of a call; the halves of a call (codex: its command's end, its output line) merge. */
export interface ToolCallPart {
  callId: string;
  /** codex: the command's own start and end. */
  itemStartedAt?: number;
  itemEndedAt?: number;
  /** pi: when the batch it was part of started (the assistant line that asked for it). */
  startedAt?: number;
  /** How long it ran by the harness's own count (codex's wall time, pi's durationMs). */
  wallMs?: number;
  /** When its output line was written (codex). */
  outputAt?: number;
  /** codex: it returned to the model while its process still ran. */
  running?: boolean;
  exit?: number;
  denied?: boolean;
  timedOut?: boolean;
  failed?: boolean;
  /** codex: the bytes of output it kept, and the bytes it sent back. */
  keptBytes?: number;
  sentBytes?: number;
  /** pi: the bytes it cut, as it counts them. */
  truncatedBytes?: number;
  /** The harness says it cut the output, whether or not it says how much. */
  truncated?: boolean;
}

/** A call, as it leaves the machine: ids, numbers, exit codes and flags. */
export interface ToolCallRecord {
  toolCallId: string;
  /** Its process's exit code; null when it has none (no process, or it had not ended when the call returned). */
  exit: number | null;
  /** How long it ran; null when the log does not say. */
  ms: number | null;
  denied: boolean;
  timedOut: boolean;
  failed: boolean;
  /** Whether the harness cut its output before sending it back. */
  truncated: boolean;
  /** The bytes it cut, when the harness counts them (codex, pi); never guessed. */
  truncatedBytes?: number;
}

/** At most this many calls per request leave; the rest are counted (`toolCallsOmitted`). */
export const TOOL_CALLS_PER_REQUEST_MAX = 64;

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parse(line: string): Json | null {
  if (!line || line[0] !== '{') return null;
  try {
    return objectOf(JSON.parse(line));
  } catch {
    return null;
  }
}

/** A parsed line, when it is an object: what the readers below take. */
function objectOf(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null;
}

/** The flags and numbers of a part, the false and absent ones left out. */
function partOf(p: ToolCallPart): ToolCallPart {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== false)) as unknown as ToolCallPart;
}

/** One line of a codex rollout, read for its tool calls; null for any other line. */
export function codexToolPartOf(line: string): ToolCallPart | null {
  return codexToolPartOfEntry(parse(line));
}

/** The same, from the line already parsed: the watcher parses each line once, for its tool call and its event. */
export function codexToolPartOfEntry(value: unknown): ToolCallPart | null {
  const entry = objectOf(value);
  if (!entry) return null;
  const p = asObj(entry.payload);
  if (entry.type === 'event_msg' && p.type === 'item_completed') {
    const item = asObj(p.item);
    if (item.type !== 'CommandExecution' || typeof item.id !== 'string' || !item.id) return null;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined;
    return partOf({
      callId: item.id,
      itemStartedAt: num(p.started_at_ms),
      itemEndedAt: num(p.completed_at_ms),
      exit: num(item.exit_code),
      denied: item.status === 'declined',
      failed: item.status === 'failed',
      keptBytes: output === undefined ? undefined : Buffer.byteLength(output),
    });
  }
  if (entry.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
    if (typeof p.call_id !== 'string' || !p.call_id) return null;
    const output = typeof p.output === 'string' ? p.output : '';
    const head = output.split('\nOutput:\n')[0];
    const wall = /^Wall time: ([0-9.]+) seconds?$/m.exec(head);
    const exit = /^(?:Process exited with code|Exit code:) (-?\d+)$/m.exec(head);
    const marker = output.indexOf('\nOutput:\n');
    const at = Date.parse(typeof entry.timestamp === 'string' ? entry.timestamp : '');
    return partOf({
      callId: p.call_id,
      outputAt: Number.isFinite(at) ? at : undefined,
      wallMs: wall ? Math.round(Number(wall[1]) * 1000) : undefined,
      running: /^Process running with session ID /m.test(head),
      exit: exit ? Number(exit[1]) : undefined,
      sentBytes: marker >= 0 ? Buffer.byteLength(output.slice(marker + '\nOutput:\n'.length)) : undefined,
    });
  }
  return null;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'shell', 'powershell', 'pwsh', 'cmd']);

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content.map(c => (asObj(c).type === 'text' && typeof asObj(c).text === 'string' ? String(asObj(c).text) : '')).join('')
    : typeof content === 'string' ? content : '';
}

/** One line of a pi session file, read for its tool calls: a batch's start, a call's result, or null. */
export function piToolLineOf(line: string): { batchAt: number } | { part: ToolCallPart } | null {
  return piToolLineOfEntry(parse(line));
}

/** The same, from the line already parsed: the watcher parses each line once, for its tool call and its event. */
export function piToolLineOfEntry(value: unknown): { batchAt: number } | { part: ToolCallPart } | null {
  const entry = objectOf(value);
  if (!entry || entry.type !== 'message') return null;
  const m = asObj(entry.message);
  if (m.role === 'assistant') {
    if (!Array.isArray(m.content) || !m.content.some(c => asObj(c).type === 'toolCall')) return null;
    const at = Date.parse(typeof entry.timestamp === 'string' ? entry.timestamp : '');
    return Number.isFinite(at) ? { batchAt: at } : null;
  }
  if (m.role !== 'toolResult' || typeof m.toolCallId !== 'string' || !m.toolCallId) return null;
  const text = textOf(m.content);
  const failed = m.isError === true;
  const ran = num(m.durationMs) !== undefined;
  const exited = /Command exited with code (-?\d+)\s*$/.exec(text);
  const timedOut = /Command timed out after [0-9.]+ seconds?\s*$/.test(text);
  const shell = typeof m.toolName === 'string' && SHELLS.has(m.toolName);
  const cut = asObj(asObj(m.details).truncation);
  const total = num(cut.totalBytes);
  const kept = num(cut.outputBytes);
  return {
    part: partOf({
      callId: m.toolCallId,
      wallMs: num(m.durationMs),
      exit: exited ? Number(exited[1]) : shell && ran && !failed ? 0 : undefined,
      // Blocked or refused before it ran: pi times only what runs.
      denied: !ran && failed,
      timedOut,
      failed,
      truncated: cut.truncated === true,
      truncatedBytes: cut.truncated === true && total !== undefined && kept !== undefined && total > kept ? total - kept : undefined,
    }),
  };
}

/** Two parts of one call as one: what the later says adds to the earlier, and a fact said once is kept. */
export function mergeToolCall(a: ToolCallPart | undefined, b: ToolCallPart): ToolCallPart {
  return { ...b, ...partOf(a ?? b) };
}

/** When a call began and how long it took the turn: its interval, or undefined when the log does not say. */
export function toolCallSpan(p: ToolCallPart): { start: number; ms: number } | undefined {
  const r = toolCallRecordOf(p);
  if (r.ms === null) return undefined;
  const start = p.itemStartedAt ?? p.startedAt ?? (p.outputAt !== undefined ? p.outputAt - r.ms : undefined);
  // A call that took no time (denied before it ran) takes none wherever it was.
  if (start === undefined) return r.ms === 0 ? { start: 0, ms: 0 } : undefined;
  return { start, ms: r.ms };
}

/** The record a call's merged parts make. */
export function toolCallRecordOf(p: ToolCallPart): ToolCallRecord {
  // Its time: until it returned, for a call that returned while its process ran; else its command's own span, else the
  // harness's count; none for a call denied before it ran.
  const span = p.itemStartedAt !== undefined && p.itemEndedAt !== undefined ? p.itemEndedAt - p.itemStartedAt : undefined;
  const ms = p.running ? p.wallMs : span ?? p.wallMs ?? (p.denied ? 0 : undefined);
  // Whole numbers only leave (the back office refuses a batch for a fraction): a log may write times with fractions.
  const exit = p.running || !Number.isInteger(p.exit) || p.exit === -1 ? null : p.exit!;
  const bytes = p.truncatedBytes ?? (p.keptBytes !== undefined && p.sentBytes !== undefined && p.keptBytes > p.sentBytes ? p.keptBytes - p.sentBytes : undefined);
  const cut = bytes === undefined ? undefined : Math.round(bytes);
  return {
    toolCallId: p.callId, exit, ms: ms === undefined ? null : Math.max(0, Math.round(ms)),
    denied: p.denied === true, timedOut: p.timedOut === true, failed: !p.running && p.failed === true,
    truncated: p.truncated === true || !!cut,
    ...(cut ? { truncatedBytes: cut } : {}),
  };
}

/** The time a part says the call happened at, to tell it belongs to a session. */
export function toolCallAt(p: ToolCallPart): number | undefined {
  return p.itemStartedAt ?? p.startedAt ?? p.outputAt ?? p.itemEndedAt;
}
