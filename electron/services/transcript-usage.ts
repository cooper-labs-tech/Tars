import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { createHash } from 'crypto';
import { priceFor, catalogSync } from './model-catalog';

/**
 * Token usage read from the Claude Code transcripts themselves.
 *
 * Claude Code only writes ~/.claude/stats-cache.json for some account types;
 * without it the Usage page had no tokens and therefore no cost at all. Every
 * assistant message in ~/.claude/projects/**\/*.jsonl carries its own usage
 * block, so the numbers are right there: that is what this reads.
 */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** 1h cache writes cost 2x base, 5m writes 1.25x, kept apart to price them */
  cacheCreation1hTokens: number;
  cacheCreation5mTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface TranscriptUsage {
  modelUsage: Record<string, ModelUsage>;
  /**
   * How many transcripts could not be read on this pass, and therefore
   * contributed nothing.
   *
   * This feeds billing. A file that fails to open or parse used to be skipped
   * in silence, which shows up as a smaller bill rather than as a gap: the one
   * error that looks like good news and so never gets reported. Whoever renders
   * these numbers is expected to say the figure is incomplete when this is not
   * zero, rather than present it as the total.
   */
  unreadable?: number;
  /**
   * `costUSD` is the day priced from that day's own tokens, cache included.
   * `tokensByModel` stays input+output only, which is why the number has to
   * travel with it: the Usage page used to rebuild the day's cost by
   * multiplying those tokens by an all-time blended $/token rate, and a day
   * whose cache-read-to-output ratio differed from the all-time average came
   * out anywhere from 80% under to 157% over. Cache reads are the bill here -
   * 1.08bn read tokens against 1.5m output tokens on this author's history -
   * and they were not in the daily map at all.
   */
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
    /** Per model, split the way the bill is: what went in, what came out, and
     *  what was read from or written to cache. `tokensByModel` above stays
     *  input+output so nothing that already read it changes meaning. */
    breakdownByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    /** How many replies that model sent that day. One API response is written
     *  as several transcript lines sharing a message id, so this counts
     *  distinct ids rather than lines: counting lines roughly doubles it. */
    messagesByModel: Record<string, number>;
    costUSD: number;
    /** The same cost split by the model that answered: each turn's own price,
     *  1h and 5m cache writes apart, added to its model. Summed over models it
     *  is `costUSD`; summed over days it is `modelUsage[model].costUSD`, less
     *  the turns that carry no timestamp and so belong to no day. It has to be
     *  split here: `breakdownByModel` keeps cache writes as one number, so
     *  pricing it again downstream cannot tell a 2x write from a 1.25x one. */
    costByModel: Record<string, number>;
    /** The day's cost by the account each session ran on, as the status line
     *  writes it into token-stats.json (TARS_CLAUDE_ACCOUNT); '' for a session
     *  that names none. Summed over accounts it is `costUSD`. */
    costByAccount: Record<string, number>;
  }>;
  /**
   * The last 48 hours, by the hour each turn was made in, in the same shape as
   * a day. `hour` is when the hour starts, in milliseconds since the epoch.
   * The Usage page could not show the last 24 hours (JeanBrasse, 01/10): the days
   * were all there was, so at 09:00 the choice was today since midnight or
   * today and all of yesterday. The hours of a rolling 24 hours are those with
   * `hour` past now minus a day.
   */
  hourlyModelTokens: Array<{
    hour: number;
    tokensByModel: Record<string, number>;
    breakdownByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
    messagesByModel: Record<string, number>;
    costUSD: number;
    costByModel: Record<string, number>;
    costByAccount: Record<string, number>;
  }>;
  /**
   * The provider each model ran under, taken from its sessions: the status
   * line writes every session's provider into token-stats.json, and a
   * transcript is named after its session. The page guessed it from the
   * model's name, and an OpenRouter or Ollama model came out as Claude at $0
   * (the Audit, AUDIT-USAGE-COMPTES.md). Only models some session speaks for
   * are here; a model that ran under several, under the one that ran most of
   * its replies.
   */
  providerByModel: Record<string, string>;
  /** Most recent day with real activity */
  lastComputedDate: string | null;
}

/** How far back the hours go: a rolling day, and the day before it to compare. */
const HOURLY_WINDOW_MS = 48 * 3_600_000;

export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
}

/** Used only when the live catalogue has never been reachable. */
const FALLBACK: Record<string, Pricing> = {
  fable: { input: 10, output: 50, cacheRead: 1, cache5m: 12.5, cache1h: 20 },
  mythos: { input: 10, output: 50, cacheRead: 1, cache5m: 12.5, cache1h: 20 },
  opus: { input: 5, output: 25, cacheRead: 0.5, cache5m: 6.25, cache1h: 10 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cache5m: 3.75, cache1h: 6 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cache5m: 1.25, cache1h: 2 },
};

/**
 * Live price for a model. models.dev publishes input/output/cache_read and the
 * 5m cache_write; the 1h write is 2x base where the 5m one is 1.25x, which is
 * how Anthropic prices both, so it is derived rather than guessed.
 */
export function pricingFor(modelId: string): Pricing {
  const live = priceFor(modelId, 'claude');
  if (live && typeof live.input === 'number' && typeof live.output === 'number') {
    const input = live.input;
    return {
      input,
      output: live.output,
      cacheRead: live.cache_read ?? input * 0.1,
      cache5m: live.cache_write ?? input * 1.25,
      cache1h: input * 2,
    };
  }
  const id = modelId.toLowerCase();
  for (const key of Object.keys(FALLBACK)) {
    if (id.includes(key)) return FALLBACK[key];
  }
  return FALLBACK.sonnet;
}

/** The raw counts on one usage block. */
export interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  write1h: number;
  write5m: number;
  searches: number;
}

const COUNT_KEYS: Array<keyof Counts> = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'write1h', 'write5m', 'searches',
];

/** What `a` adds on top of `b`, never negative. */
export function diff(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = Math.max(0, a[k] - b[k]);
  return out;
}

export function add(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

function isZero(c: Counts): boolean {
  return COUNT_KEYS.every(k => c[k] === 0);
}

export function costOf(price: Pricing, c: Counts): number {
  return (
    (c.input / 1e6) * price.input +
    (c.output / 1e6) * price.output +
    (c.cacheRead / 1e6) * price.cacheRead +
    (c.write5m / 1e6) * price.cache5m +
    (c.write1h / 1e6) * price.cache1h
  );
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreation5mTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  };
}

/** Every *.jsonl under ~/.claude/projects, at any depth. */
function listTranscripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Where Claude Code writes its transcripts: ~/.claude/projects, and with a
 * CLAUDE_CONFIG_DIR the projects/ under it as well. All the usage of a user's
 * own CLAUDE_CONFIG_DIR was missing (the Audit, AUDIT-USAGE-COMPTES.md: a
 * reply of 5000/500 written there did not appear). The same folder under two
 * names, as an account folder's projects/ links to ~/.claude's, is walked once.
 */
function transcriptRoots(homeDir: string): string[] {
  const roots = [path.join(homeDir, '.claude', 'projects')];
  const own = process.env.CLAUDE_CONFIG_DIR;
  if (own) roots.push(path.join(own, 'projects'));
  const seen = new Set<string>();
  return roots.filter((root) => {
    let real = root;
    try {
      real = fs.realpathSync(root);
    } catch { /* absent: it lists nothing */ }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** What the status line writes about each session, in ~/.dorothy/token-stats.json. */
function sessionsFile(homeDir: string): string {
  return path.join(homeDir, '.dorothy', 'token-stats.json');
}

/**
 * The provider and the account of each session, by session id. A transcript is
 * named after its session, so this is how a reply is filed under who ran it.
 * The file is written by a shell script any agent can run, so only short plain
 * strings are taken from it, and never a name that would reach Object.prototype.
 */
function sessionsOf(homeDir: string): Map<string, { provider: string; account: string }> {
  const sessions = new Map<string, { provider: string; account: string }>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sessionsFile(homeDir), 'utf-8'));
  } catch {
    return sessions;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sessions;
  const plain = (v: unknown) => (typeof v === 'string' && v.length <= 64 && !FORBIDDEN_KEYS.has(v) ? v : '');
  for (const [sid, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    sessions.set(sid, { provider: plain(e.provider), account: plain(e.account) });
  }
  return sessions;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The memo, and which home it was computed for.
 *
 * `homeDir` is a parameter of the scan, but the memo was module scope and
 * unkeyed, so two different homes inside the sixty second window handed each
 * other their numbers. Production never noticed, since every caller passes
 * os.homedir(), and the tests avoided it by clearing in a beforeEach: a guard
 * on the calling side for a trap set on the called side. The key is here now,
 * so the protection does not depend on remembering it.
 *
 * `fileCache` needs no key: it is keyed by absolute path already.
 */
let cache: {
  at: number;
  homeDir: string;
  value: TranscriptUsage;
  /** The transcripts it was computed from (fingerprintOf), and the catalogue that priced them. */
  fingerprint: string;
  catalog: unknown;
} | null = null;

/** Bumped by clearTranscriptUsageCache, so a scan that started before a clear
 *  cannot write its result into the memo afterwards. Without it, "clear" meant
 *  "clear, unless something is already running". */
let generation = 0;
const CACHE_TTL = 60_000;

/**
 * What one transcript file contributes, remembered so it is parsed once.
 *
 * The whole walk used to re-read and re-parse every .jsonl under
 * ~/.claude/projects on each cache miss: measured at 450 to 700ms against 451MB
 * across 1698 files on the author's machine, synchronously on the main process,
 * once a minute for as long as a Usage, Agents or Projects tab is open. Every
 * PTY's output handler, every other IPC call and the local HTTP server stall
 * for that whole time, and the cost only grows because Tars never prunes old
 * transcripts.
 *
 * Almost all of that work is re-reading files that cannot have changed: a
 * closed session's transcript is finished forever. Keyed on (mtimeMs, size), a
 * file is parsed once and its contribution reused, so the recurring cost falls
 * to a stat per file plus a real parse of only the session still being written.
 *
 * The first run after a launch still pays full price on the main thread. Moving
 * the walk to a worker is the remaining half of this and is not done here.
 */
interface TurnEntry {
  /** `${message.id}:${requestId}`, the identity of one API response. */
  key: string;
  model: string;
  /** Local calendar day, or null when the line carried no usable timestamp. */
  date: string | null;
  /** When the line was written, in whole minutes since the epoch, or null:
   *  a number that small is held in the object itself, where milliseconds
   *  took a heap number for every turn (10 MB on JeanBrasse's 2.7 GB of
   *  transcripts, measured with the hours added). */
  minute: number | null;
  counts: Counts;
}

/**
 * The turns one file holds, not their totals.
 *
 * Totals cannot be cached per file: resuming a session replays earlier messages
 * into a NEW transcript, so the same message id appears in two files and
 * counting both would double it. Deduplication has to stay global, which means
 * what a file contributes is its list of turns, and the merge decides what is
 * new. Measured on the author's machine: 66 files, 116MB, 9359 usage lines,
 * 4895 distinct messages, about 0.8MB held here against a 467ms parse.
 */
type FileContribution = TurnEntry[];

/**
 * And read by what it gained: a live transcript only grows, and it was read
 * again whole whenever its size changed, every live session's each time the
 * 60 s memo ran out while a page asked claude:getData every 10 s (830 MB of
 * live transcripts on the night of the 2026-10-13 crash). `offset` is where
 * its last whole line ends; a file that shrank or was replaced (another inode)
 * is read from its start.
 */
const fileCache = new Map<string, { ino: number; offset: number; lines: number; mtimeMs: number; size: number; value: FileContribution }>();

/**
 * `YYYY-MM-DD` in the machine's own timezone.
 *
 * Costs are read by a person who means their own calendar day. A turn at 01:00
 * local in Tbilisi is 21:00 UTC the day before; counting it as yesterday makes
 * "what did I spend today" wrong for everyone east of Greenwich.
 */
function localDateKey(isoTimestamp: string): string | null {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One string for each day and each model, shared by every turn that names it.
 * Each turn held its own copy, parsed out of its line: hundreds of thousands
 * of identical strings on JeanBrasse's transcripts.
 */
const sharedStrings = new Map<string, string>();
function shared<T extends string | null>(value: T): T {
  if (value === null) return value;
  const known = sharedStrings.get(value);
  if (known !== undefined) return known as T;
  sharedStrings.set(value, value);
  return value;
}

/**
 * The turns one transcript file holds.
 *
 * No aggregation here: the caller deduplicates across files, because a resumed
 * session replays its earlier messages into a new transcript and both copies
 * carry the same message id.
 */
/**
 * The file, in chunks, with a breath between them.
 *
 * readFileSync on the largest transcript here, 65 MB, is 165 ms the main
 * thread cannot be interrupted in, and it was the whole of the worst pause
 * once everything around it had been sliced. Four megabytes at a time is about
 * ten. The decoder is what makes chunking safe: a UTF-8 character can straddle
 * a boundary, and cutting one in half would corrupt the line it sits in.
 */
async function readFileInSlices(file: string): Promise<string | null> {
  const CHUNK = 4 * 1024 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let content = '';
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (read <= 0) break;
      content += decoder.write(buffer.subarray(0, read));
      await breatheIfDue();
    }
    return content + decoder.end();
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** One API response's line, as read from a transcript: its identity, model, time and counts. */
export interface UsageLine {
  /** `${message.id}:${requestId}`. */
  key: string;
  model: string;
  /** The line's ISO timestamp, or null. */
  timestamp: string | null;
  counts: Counts;
}

/**
 * Every usage line of a transcript, in order, or null when the file would not
 * open. Read in slices, with breaths, for the reasons readFileInSlices gives.
 */
export async function readUsageLines(file: string): Promise<UsageLine[] | null> {
  // Null, not an empty list. An empty list is a transcript that holds no
  // usage, which is a fact; a file that would not open is not, and returning
  // one as the other is how a failure turns into a smaller bill.
  const content = await readFileInSlices(file);
  if (content === null) return null;
  const out: UsageLine[] = [];

  // Walked rather than split: `split('\n')` on the 65 MB transcript is one
  // more atomic 59 ms, building thirty thousand strings before the loop can
  // begin. Walking spends the same time, a breath at a time.
  let lines = 0;
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const line = newline === -1 ? content.slice(start) : content.slice(start, newline);
    start = newline === -1 ? content.length : newline + 1;
    if ((++lines & 1023) === 0) await breatheIfDue();
    const usage = usageLineOf(line);
    if (usage) out.push(usage);
  }
  return out;
}

/** One transcript line's usage, or null when it holds none. */
function usageLineOf(line: string): UsageLine | null {
  if (!line.includes('"usage"')) return null;

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;

  const message = entry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!message || !usage) return null;

  const model = typeof message.model === 'string' ? message.model : null;
  if (!model || model === '<synthetic>') return null;
  // A transcript's model id is attacker-influenceable and is used as an object
  // key downstream, so the three that would reach Object.prototype are dropped.
  if (model === '__proto__' || model === 'constructor' || model === 'prototype') return null;

  const split = usage.cache_creation as Record<string, unknown> | undefined;
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  return {
    key: `${message.id ?? ''}:${entry.requestId ?? ''}`,
    model,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    counts: {
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite,
      write1h: Number(split?.ephemeral_1h_input_tokens) || 0,
      write5m: Number(split?.ephemeral_5m_input_tokens) || (split ? 0 : cacheWrite),
      searches: Number(
        (usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests,
      ) || 0,
    },
  };
}

/** A usage line as a file's contribution holds it. */
function contributionOf({ key, model, timestamp, counts }: UsageLine): FileContribution[number] {
  const at = timestamp ? Date.parse(timestamp) : NaN;
  return {
    key,
    model: shared(model),
    // The user's day, not UTC's. Transcript timestamps are ISO/Z, so slicing
    // the first ten characters gave the UTC date while the chart labelled its
    // bars with the local one, putting every bar a day out east of Greenwich.
    date: timestamp ? shared(localDateKey(timestamp)) : null,
    minute: Number.isNaN(at) ? null : Math.floor(at / 60_000),
    counts,
  };
}

/** The file's contribution, reading only what it gained since last time. */
async function contributionFor(file: string): Promise<FileContribution | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  // Grown, the same file: read from where it was. Anything else (shrunk,
  // replaced, rewritten to the same size with a new date) is read whole.
  const from = hit && hit.ino === stat.ino && stat.size > hit.size && hit.size >= hit.offset
    ? hit
    : { ino: stat.ino, offset: 0, lines: 0, mtimeMs: 0, size: 0, value: [] as FileContribution };
  const gained = await readGainedTurns(file, from.offset, stat.size);
  // Only a real read is remembered. Caching a failure would turn one bad read
  // into a permanently missing file.
  if (!gained) return null;
  const value = gained.turns.length ? [...from.value, ...gained.turns] : from.value;
  fileCache.set(file, { ino: stat.ino, offset: from.offset + gained.consumed, lines: from.lines + gained.lines, mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/**
 * The usage lines of a transcript's bytes from `from` to `to`, by slices of
 * four megabytes with breaths, as readFileInSlices reads, and how many bytes
 * of whole lines that was. A line still being written waits for its end; a
 * last line with no newline after it is taken when it parses whole. Shared
 * with task-cost.ts, which reads the same transcripts the same way.
 */
export async function readGainedUsageLines(file: string, from: number, to: number): Promise<{ usage: UsageLine[]; consumed: number; lines: number } | null> {
  const CHUNK = 4 * 1024 * 1024;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const usage: UsageLine[] = [];
  let consumed = 0;
  let lines = 0;
  const take = (text: string) => {
    for (const line of text.split('\n')) {
      lines += 1;
      const found = usageLineOf(line);
      if (found) usage.push(found);
    }
  };
  try {
    let position = from;
    let pending = Buffer.alloc(0);
    while (position < to) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, to - position));
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      pending = pending.length ? Buffer.concat([pending, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      // A newline byte is never inside a character of several bytes.
      const end = pending.lastIndexOf(0x0a);
      if (end !== -1) {
        take(pending.toString('utf8', 0, end));
        consumed += end + 1;
        pending = pending.subarray(end + 1);
      }
      await breatheIfDue();
    }
    if (pending.length) {
      const last = pending.toString('utf8');
      let whole = false;
      try { JSON.parse(last); whole = true; } catch { /* still being written */ }
      if (whole) { take(last); consumed += pending.length; }
    }
    return { usage, consumed, lines };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The turns of a transcript's bytes from `from` to `to`, and how many bytes of whole lines that was. */
async function readGainedTurns(file: string, from: number, to: number): Promise<{ turns: FileContribution; consumed: number; lines: number } | null> {
  const gained = await readGainedUsageLines(file, from, to);
  return gained && { turns: gained.usage.map(contributionOf), consumed: gained.consumed, lines: gained.lines };
}

/**
 * The scan, in slices, off the thread that draws.
 *
 * Measured on this machine before any of this: 1826 transcripts, 883 MB, and
 * 2775 ms of unbroken synchronous work on the main thread the first time, then
 * 2656 to 3270 ms every time the memo expired, because the per-file cache
 * spares the parsing and not the walking or the adding up. For those seconds
 * the window painted nothing and answered nothing: a freeze, not a delay, and
 * one that three callers can trigger, the Usage page and /stats from either
 * bot.
 *
 * So it yields. Every SLICE files it hands the loop back, which is what keeps
 * the window alive while this runs. The totals are identical either way: the
 * awaits are inserted between files, never inside the arithmetic of one.
 */
const BREATH_MS = 8;
let lastBreath = 0;

/** Hand the loop back if this pass has held it longer than a frame.
 *
 *  Measured by time rather than by file count, because the corpus is skewed:
 *  1826 transcripts, 16 of them over 10 MB and the largest 65 MB, so a slice of
 *  twenty-five files was 604 ms whenever a big one fell inside it. */
async function breatheIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastBreath < BREATH_MS) return;
  lastBreath = now;
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** The scan in progress, if any. Three callers share one: the page and both
 *  bots asking at once used to mean three full passes over 883 MB. */
const inFlight = new Map<string, Promise<TranscriptUsage>>();

export function computeTranscriptUsage(homeDir = os.homedir()): Promise<TranscriptUsage> {
  if (cache && cache.homeDir === homeDir && Date.now() - cache.at < CACHE_TTL) {
    return Promise.resolve(cache.value);
  }
  const running = inFlight.get(homeDir);
  if (running) return running;
  const scan = refresh(homeDir).finally(() => { inFlight.delete(homeDir); });
  inFlight.set(homeDir, scan);
  return scan;
}

/**
 * What the transcripts are now: each one's path, time and size, in order. Two
 * passes that would read the same files agree on it, and a transcript added,
 * deleted, grown or rewritten changes it. A stat per file, 14 to 39 ms on
 * JeanBrasse's 1826 transcripts, where the adding up it can spare is 0.2 to 0.5 s.
 */
async function fingerprintOf(homeDir: string): Promise<string> {
  const hash = createHash('sha1');
  lastBreath = Date.now();
  // Who ran each session decides where its replies are filed: a provider or an
  // account written after a pass must be picked up by the next one.
  try {
    const stat = fs.statSync(sessionsFile(homeDir));
    hash.update(`sessions\0${stat.mtimeMs}\0${stat.size}\n`);
  } catch {
    hash.update('sessions\0none\n');
  }
  for (const file of transcriptRoots(homeDir).flatMap(listTranscripts).sort()) {
    await breatheIfDue();
    try {
      const stat = fs.statSync(file);
      hash.update(`${file}\0${stat.mtimeMs}\0${stat.size}\n`);
    } catch {
      hash.update(`${file}\0gone\n`);
    }
  }
  return hash.digest('hex');
}

/**
 * Past the minute, the memo is kept while no transcript moved and the
 * catalogue is the one that priced it: its time is renewed, and nothing is
 * added up again. The memo was rebuilt every minute a page polled, all night,
 * for numbers that could not have changed. Anything else is the scan, and so
 * is a memo that could not read a transcript: a file made readable again keeps
 * its time and its size, and a failure is never remembered (contributionFor).
 */
async function refresh(homeDir: string): Promise<TranscriptUsage> {
  // Which generation this pass belongs to. A clear that happens while it runs
  // makes its result stale before it exists, and it must not be memoised.
  const startedAt = generation;
  const catalog = catalogSync();
  const fingerprint = await fingerprintOf(homeDir);
  const kept = cache;
  if (kept && kept.homeDir === homeDir && kept.fingerprint === fingerprint && kept.catalog === catalog && !kept.value.unreadable) {
    if (generation === startedAt) cache = { ...kept, at: Date.now() };
    return kept.value;
  }
  return scanTranscripts(homeDir, { startedAt, fingerprint, catalog });
}

async function scanTranscripts(
  homeDir: string,
  { startedAt, fingerprint, catalog }: { startedAt: number; fingerprint: string; catalog: unknown },
): Promise<TranscriptUsage> {
  // A model's price, looked up once for this scan. costOf asked the catalogue
  // at every turn, and priceFor walks every model it lists when the id is
  // dated: about 608 thousand walks on JeanBrasse's transcripts, and with no
  // catalogue in memory yet (a first launch, offline) a failed read of the
  // cache file at each. The adding up took 5 to 16 s that way. Kept for the
  // scan only, so the next one prices from the catalogue as it is then.
  const prices = new Map<string, Pricing>();
  const priceOf = (model: string): Pricing => {
    let price = prices.get(model);
    if (!price) {
      price = pricingFor(model);
      prices.set(model, price);
    }
    return price;
  };
  // Null-prototype: a transcript's model id is attacker-influenceable, and
  // `modelUsage[model] ||= …` on a plain object would let "__proto__" write
  // onto Object.prototype inside the main process.
  const modelUsage: Record<string, ModelUsage> = Object.create(null);
  /** A day or an hour, added up the same way. `messagesByModel` counts replies
   *  off the same dedup key as the tokens: one API response is written as
   *  several lines sharing a message id, so counting turns would roughly double
   *  every day. */
  type Split = { input: number; output: number; cacheRead: number; cacheWrite: number };
  type Bucket = {
    tokensByModel: Record<string, number>;
    breakdownByModel: Record<string, Split>;
    messagesByModel: Record<string, number>;
    costUSD: number;
    costByModel: Record<string, number>;
    costByAccount: Record<string, number>;
  };
  const bucket = <K>(map: Map<K, Bucket>, key: K): Bucket => {
    let b = map.get(key);
    if (!b) {
      b = { tokensByModel: Object.create(null), breakdownByModel: Object.create(null), messagesByModel: Object.create(null),
        costUSD: 0, costByModel: Object.create(null), costByAccount: Object.create(null) };
      map.set(key, b);
    }
    return b;
  };
  const addTo = (b: Bucket, model: string, delta: Counts, cost: number, isNewMessage: boolean, account: string) => {
    b.tokensByModel[model] = (b.tokensByModel[model] || 0) + delta.input + delta.output;
    const cell = b.breakdownByModel[model] ?? (b.breakdownByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    cell.input += delta.input;
    cell.output += delta.output;
    cell.cacheRead += delta.cacheRead;
    cell.cacheWrite += delta.cacheWrite;
    // Priced from its own tokens, cache reads and cache writes included,
    // rather than left to be reconstructed downstream from input+output alone.
    b.costUSD += cost;
    b.costByModel[model] = (b.costByModel[model] || 0) + cost;
    b.costByAccount[account] = (b.costByAccount[account] || 0) + cost;
    if (isNewMessage) b.messagesByModel[model] = (b.messagesByModel[model] || 0) + 1;
  };
  const days = new Map<string, Bucket>();
  const hours = new Map<number, Bucket>();
  const since = Date.now() - HOURLY_WINDOW_MS;
  const sessions = sessionsOf(homeDir);
  /** Replies per provider, per model, to say which provider ran a model. */
  const providerReplies = new Map<string, Map<string, number>>();
  let lastComputedDate: string | null = null;

  // One API response is written as several lines, one per content block, all
  // carrying the same message id and requestId, and counting them all would
  // roughly double every cost on the page. But the earlier lines carry a
  // *partial* usage block: the final line is the one with the whole
  // output_tokens count. Keeping the first and skipping the rest threw away
  // 279,904 output tokens ($7.00) of the author's history. So: remember what
  // each key has already contributed and top it up.
  //
  // This stays global rather than per file, because a resumed session replays
  // its earlier messages into a new transcript under the same ids.
  const applied = new Map<string, Counts>();

  const files = transcriptRoots(homeDir).flatMap(listTranscripts);
  let unreadable = 0;
  lastBreath = Date.now();
  const contributions: Array<{ file: string; mtimeMs: number; turns: FileContribution }> = [];
  for (const file of files) {
    await breatheIfDue();
    const turns = await contributionFor(file);
    // Counted, not skipped in silence: see `unreadable` on TranscriptUsage.
    if (!turns) { unreadable += 1; continue; }
    contributions.push({ file, mtimeMs: fileCache.get(file)?.mtimeMs ?? 0, turns });
  }
  // Oldest first: a resumed or forked session replays earlier replies into its
  // own transcript, and a reply is filed under the session that wrote it first.
  // The totals do not depend on the order.
  contributions.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { file, turns } of contributions) {
    await breatheIfDue();
    const session = sessions.get(path.basename(file, '.jsonl'));
    const account = session?.account ?? '';
    for (const turn of turns) {
      let delta = turn.counts;
      // A key seen for the first time is a reply that has not been counted
      // yet; the later lines of the same response top up its tokens without
      // being another message.
      let isNewMessage = true;
      if (turn.key !== ':') {
        const prev = applied.get(turn.key);
        if (prev) {
          isNewMessage = false;
          delta = diff(turn.counts, prev);
          if (isZero(delta)) continue;
          applied.set(turn.key, add(prev, delta));
        } else {
          applied.set(turn.key, turn.counts);
        }
      }

      const modelBucket = (modelUsage[turn.model] ||= emptyUsage());
      modelBucket.inputTokens += delta.input;
      modelBucket.outputTokens += delta.output;
      modelBucket.cacheReadInputTokens += delta.cacheRead;
      modelBucket.cacheCreationInputTokens += delta.cacheWrite;
      modelBucket.cacheCreation1hTokens += delta.write1h;
      modelBucket.cacheCreation5mTokens += delta.write5m;
      modelBucket.webSearchRequests += delta.searches;

      const cost = costOf(priceOf(turn.model), delta);
      modelBucket.costUSD += cost;

      if (turn.date) {
        addTo(bucket(days, turn.date), turn.model, delta, cost, isNewMessage, account);
        if (!lastComputedDate || turn.date > lastComputedDate) lastComputedDate = turn.date;
      }
      if (turn.minute !== null && turn.minute * 60_000 >= since) {
        addTo(bucket(hours, Math.floor(turn.minute / 60) * 3_600_000), turn.model, delta, cost, isNewMessage, account);
      }
      if (isNewMessage && session?.provider) {
        const byProvider = providerReplies.get(turn.model) ?? new Map<string, number>();
        byProvider.set(session.provider, (byProvider.get(session.provider) ?? 0) + 1);
        providerReplies.set(turn.model, byProvider);
      }
    }
  }

  // A transcript that has been deleted must stop contributing, and must not sit
  // in the map forever.
  if (fileCache.size > files.length) {
    const live = new Set(files);
    for (const key of fileCache.keys()) if (!live.has(key)) fileCache.delete(key);
  }

  const plain = (b: Bucket) => ({
    tokensByModel: { ...b.tokensByModel },
    breakdownByModel: { ...b.breakdownByModel },
    messagesByModel: { ...b.messagesByModel },
    costUSD: b.costUSD,
    costByModel: { ...b.costByModel },
    costByAccount: { ...b.costByAccount },
  });
  const providerByModel: Record<string, string> = Object.create(null);
  for (const [model, byProvider] of providerReplies) {
    providerByModel[model] = [...byProvider.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  const value: TranscriptUsage = {
    modelUsage: { ...modelUsage },
    dailyModelTokens: Array.from(days.entries())
      .map(([date, b]) => ({ date, ...plain(b) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourlyModelTokens: Array.from(hours.entries())
      .map(([hour, b]) => ({ hour, ...plain(b) }))
      .sort((a, b) => a.hour - b.hour),
    providerByModel: { ...providerByModel },
    lastComputedDate,
    unreadable,
  };

  // Returned to whoever asked either way: they asked before the clear, and
  // these numbers were true then. Only the memo is refused, so the next caller
  // reads the world as it is now rather than as it was.
  if (generation === startedAt) cache = { at: Date.now(), homeDir, value, fingerprint, catalog };
  return value;
}

/** Test seam: the 60 s memo runs out, what is known of each file stays (as after a minute). */
export function expireTranscriptUsageMemo(): void {
  generation += 1;
  cache = null;
  inFlight.clear();
}

/**
 * Drops both memos so a test or a refresh sees fresh numbers.
 *
 * The per-file map has to go too: a test that rewrites a fixture within the
 * same millisecond and to the same length would otherwise be handed the old
 * parse, since (mtimeMs, size) is all that identifies it.
 */
export function clearTranscriptUsageCache(): void {
  generation += 1;
  cache = null;
  fileCache.clear();
  // The scan in progress went with them. This function says it clears the
  // cache and used to leave this behind: harmless while every caller awaited,
  // and a wrong billing figure the day one did not, handed over from another
  // home with nothing to say where it came from.
  inFlight.clear();
}
