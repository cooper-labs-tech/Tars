import * as fs from 'fs';
import * as path from 'path';

/**
 * A harness's compactions, as it logs them itself (trace feature C2), measured on fenced real binaries on 27/11:
 *
 * - **codex 0.163** writes a `compacted` line in its rollout (`$CODEX_HOME/sessions/<y>/<m>/<d>/rollout-...-<session
 *   id>.jsonl`), naming its compaction call's response (`compaction_response_id`), between `token_usage_record` lines
 *   that carry each call's `response_id` and prompt (`usage.input_tokens`): the prompt before is the last record before
 *   the line that is not the compaction call's, the prompt after the first record after it. Kind `compact`.
 * - **Qwen Code 0.25.2** writes a `chat_compression` system line in its transcript
 *   (`~/.qwen/projects/<cwd, non-alphanumerics as ->/chats/<session>.jsonl`), with the prompt's tokens before and after
 *   (`originalTokenCount`, `newTokenCount`) and its status (1: compressed). Kind `summarize`: it asks the model for a
 *   state snapshot of the chat.
 *
 * Read only, from the agent's own folders, bounded and asynchronously: codex's one rollout named by the session's own
 * id (a safe id only), in the days the session spans; Qwen Code's one transcript of the agent's folder that overlaps
 * the session, looked for among the 64 most recently written, none when two overlap (which one is this session's cannot
 * be told); a file over `maxBytes` is not read. A malformed line is skipped.
 */

export interface HarnessCompaction {
  at: number;
  kind: 'compact' | 'summarize' | 'truncate';
  /** The prompt's tokens before and after, as the harness counted them. */
  before?: number;
  after?: number;
}

/** A file read at most (8 MiB): a rollout or a transcript this long is not read. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** The transcripts of a folder looked at, at most, the newest first; and the names listed before that, at most. */
const MAX_CANDIDATES = 64;
const MAX_LISTED = 5000;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function linesOf(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(asObj(JSON.parse(line))); } catch { /* a malformed line: skipped */ }
  }
  return out;
}

const timeOf = (l: Json): number | undefined => {
  const t = typeof l.timestamp === 'string' ? Date.parse(l.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Codex's compactions in one rollout's text. */
export function codexCompactions(text: string): HarnessCompaction[] {
  const lines = linesOf(text);
  const out: HarnessCompaction[] = [];
  lines.forEach((l, i) => {
    if (l.type !== 'compacted') return;
    const at = timeOf(l);
    if (at === undefined) return;
    const call = asObj(l.payload).compaction_response_id;
    let before: number | undefined;
    for (let k = i - 1; k >= 0 && before === undefined; k--) {
      const p = asObj(lines[k].payload);
      if (lines[k].type === 'token_usage_record' && p.response_id !== call) before = num(asObj(p.usage).input_tokens);
    }
    let after: number | undefined;
    for (let k = i + 1; k < lines.length && after === undefined; k++) {
      if (lines[k].type === 'compacted') break;
      if (lines[k].type === 'token_usage_record') after = num(asObj(asObj(lines[k].payload).usage).input_tokens);
    }
    out.push({ at, kind: 'compact', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  });
  return out;
}

/** Qwen Code's compactions in one transcript's text: the compressions it made, not the ones it gave up. */
export function qwenCompactions(text: string): HarnessCompaction[] {
  const out: HarnessCompaction[] = [];
  for (const l of linesOf(text)) {
    if (l.type !== 'system' || l.subtype !== 'chat_compression') continue;
    const info = asObj(asObj(l.systemPayload).info);
    const at = timeOf(l);
    if (at === undefined || info.compressionStatus !== 1) continue;
    const before = num(info.originalTokenCount);
    const after = num(info.newTokenCount);
    out.push({ at, kind: 'summarize', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  }
  return out;
}

/** A file's text when it is a file of at most `maxBytes`, else null. Read off the main thread (fs.promises). */
async function readBounded(file: string, maxBytes: number): Promise<string | null> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** The names of a folder that end so, the most recently written first, `limit` at most; none when it cannot be read. */
async function newestFirst(folder: string, suffix: string, limit: number): Promise<Array<{ name: string; mtimeMs: number }>> {
  let names: string[];
  try { names = (await fs.promises.readdir(folder)).filter(n => n.endsWith(suffix)).slice(0, MAX_LISTED); } catch { return []; }
  const stated = await Promise.all(names.map(async (name) => {
    try {
      const st = await fs.promises.stat(path.join(folder, name));
      return st.isFile() ? { name, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null;
    }
  }));
  return stated.filter((s): s is { name: string; mtimeMs: number } => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** The local dates a session spans, a day either side, as codex names its folders. */
function daysOf(startedAt: number, endedAt: number): string[][] {
  const out: string[][] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let t = startedAt - 86_400_000; t <= endedAt + 86_400_000 && out.length < 40; t += 86_400_000) {
    const d = new Date(t);
    out.push([String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())]);
  }
  return out;
}

/**
 * A session's compactions from its harness's own log, or none. Asynchronous and bounded (the Audit's I-4 on #687): the
 * files are listed, stated and read through fs.promises, so a session's end never holds the main process on them.
 */
export async function readHarnessCompactions(o: {
  harness: string; codexHome?: string; qwenHome?: string; cwd?: string; nativeSessionId?: string;
  startedAt: number; endedAt: number; maxBytes?: number;
}): Promise<HarnessCompaction[]> {
  const maxBytes = o.maxBytes ?? MAX_LOG_BYTES;
  const within = (c: HarnessCompaction) => c.at >= o.startedAt - 60_000 && c.at <= o.endedAt + 60_000;
  if (o.harness === 'codex') {
    if (!o.codexHome || !o.nativeSessionId || !SAFE_SESSION_ID.test(o.nativeSessionId)) return [];
    for (const day of daysOf(o.startedAt, o.endedAt)) {
      const folder = path.join(o.codexHome, 'sessions', ...day);
      let names: string[];
      try { names = await fs.promises.readdir(folder); } catch { continue; }
      const name = names.find(n => n.startsWith('rollout-') && n.endsWith(`-${o.nativeSessionId}.jsonl`));
      if (!name) continue;
      const text = await readBounded(path.join(folder, name), maxBytes);
      return text === null ? [] : codexCompactions(text).filter(within);
    }
    return [];
  }
  if (o.harness === 'qwen-code') {
    if (!o.qwenHome || !o.cwd) return [];
    const chats = path.join(o.qwenHome, 'projects', o.cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
    // The most recently written first (the Audit's I-3 on #687): in a folder of many chats, this session's is among
    // the newest, whatever order the folder lists its names in.
    const listed = await newestFirst(chats, '.jsonl', MAX_CANDIDATES);
    // The transcripts written to since the session began, and begun before it ended.
    const overlapping: Array<{ text: string }> = [];
    for (const { name, mtimeMs } of listed) {
      if (mtimeMs < o.startedAt) break;
      const text = await readBounded(path.join(chats, name), maxBytes);
      if (text === null) return [];
      const first = linesOf(text.slice(0, 64 * 1024).split('\n')[0] ?? '')[0];
      const begun = first ? timeOf(first) : undefined;
      if (begun !== undefined && begun > o.endedAt) continue;
      overlapping.push({ text });
    }
    if (overlapping.length !== 1) return [];
    return qwenCompactions(overlapping[0].text).filter(within);
  }
  return [];
}
