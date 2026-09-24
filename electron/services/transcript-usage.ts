import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { StringDecoder } from 'string_decoder';
import { priceFor } from './model-catalog';

/**
 * Token usage read from the Claude Code transcripts themselves: every assistant
 * message in ~/.claude/projects/**\/*.jsonl carries its usage block, where
 * ~/.claude/stats-cache.json exists only for some account types.
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
   * Transcripts that could not be read on this pass, and so contributed
   * nothing. This feeds billing: skipped in silence, a failure reads as a
   * smaller bill. Whoever renders the numbers says they are incomplete when
   * this is not zero.
   */
  unreadable?: number;
  /**
   * Per day. `costUSD` is the day priced from its own tokens, cache included,
   * since `tokensByModel` stays input+output: rebuilding a day from those at an
   * all-time blended rate came out 80% under to 157% over, cache reads being
   * most of the bill (1.08bn read against 1.5m output tokens here).
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
    /** The same cost per answering model, each turn priced with its 1h and 5m
     *  cache writes apart: split here, since `breakdownByModel` keeps writes as
     *  one number. Summed over models, `costUSD`; over days, the model's
     *  `costUSD` less the turns with no timestamp. */
    costByModel: Record<string, number>;
  }>;
  /** Most recent day with real activity */
  lastComputedDate: string | null;
}

interface Pricing {
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
function pricingFor(modelId: string): Pricing {
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
interface Counts {
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
function diff(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = Math.max(0, a[k] - b[k]);
  return out;
}

function add(a: Counts, b: Counts): Counts {
  const out = {} as Counts;
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

function isZero(c: Counts): boolean {
  return COUNT_KEYS.every(k => c[k] === 0);
}

function costOf(model: string, c: Counts): number {
  const price = pricingFor(model);
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
 * The memo, keyed by the home it was computed for: unkeyed, two homes within
 * the sixty seconds were handed each other's numbers. `fileCache` needs no key,
 * being keyed by absolute path.
 */
let cache: { at: number; homeDir: string; value: TranscriptUsage } | null = null;

/** Bumped by clearTranscriptUsageCache, so a scan that started before a clear
 *  cannot write its result into the memo afterwards. Without it, "clear" meant
 *  "clear, unless something is already running". */
let generation = 0;
const CACHE_TTL = 60_000;

/** One API response, as a transcript line records it. */
interface TurnEntry {
  /** `${message.id}:${requestId}`, the identity of one API response. */
  key: string;
  model: string;
  /** Local calendar day, or null when the line carried no usable timestamp. */
  date: string | null;
  counts: Counts;
}

/**
 * The turns one file holds, not their totals: resuming a session replays its
 * messages into a new transcript under the same ids, so deduplication stays
 * global (66 files, 116 MB here: about 0.8 MB held against a 467 ms parse).
 */
type FileContribution = TurnEntry[];

/**
 * What each transcript contributes, keyed on (mtimeMs, size) so a file is
 * parsed once: re-parsing every .jsonl on each miss held the main thread 450
 * to 700 ms (451 MB, 1698 files here), once a minute while a Usage, Agents or
 * Projects tab was open, and a closed session's transcript never changes.
 */
const fileCache = new Map<string, { mtimeMs: number; size: number; value: FileContribution }>();

/**
 * `YYYY-MM-DD` in the machine's own timezone: costs are read by a person who
 * means their own day, and the UTC day is wrong for everyone east of Greenwich.
 */
function localDateKey(isoTimestamp: string): string | null {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The file, 4 MB at a time with a breath between chunks: readFileSync on the
 * 65 MB transcript here held the main thread 165 ms, the worst pause once all
 * else was sliced. The decoder keeps whole a UTF-8 character that straddles a
 * chunk boundary.
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

/** The turns one transcript file holds; the caller deduplicates across files. */
async function readTranscript(file: string): Promise<FileContribution | null> {
  const turns: FileContribution = [];

  // Null, not an empty list: a file that would not open is not a transcript
  // without usage, and reading it as one turns a failure into a smaller bill.
  const content = await readFileInSlices(file);
  if (content === null) return null;

  // Walked rather than split: `split('\n')` on the 65 MB transcript is one more
  // atomic 59 ms; walking spends it a breath at a time.
  let lines = 0;
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    const line = newline === -1 ? content.slice(start) : content.slice(start, newline);
    start = newline === -1 ? content.length : newline + 1;
    if ((++lines & 1023) === 0) await breatheIfDue();
    if (!line.includes('"usage"')) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;

    const message = entry.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!message || !usage) continue;

    const model = typeof message.model === 'string' ? message.model : null;
    if (!model || model === '<synthetic>') continue;
    // A transcript's model id is attacker-influenceable and is used as an object
    // key downstream, so the three that would reach Object.prototype are dropped.
    if (model === '__proto__' || model === 'constructor' || model === 'prototype') continue;

    const split = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
    const counts: Counts = {
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheWrite,
      write1h: Number(split?.ephemeral_1h_input_tokens) || 0,
      write5m: Number(split?.ephemeral_5m_input_tokens) || (split ? 0 : cacheWrite),
      searches: Number(
        (usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests,
      ) || 0,
    };

    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
    turns.push({
      key: `${message.id ?? ''}:${entry.requestId ?? ''}`,
      model,
      // The user's day: slicing the ISO/Z timestamp gave the UTC one, every bar
      // a day out east of Greenwich against the chart's local labels.
      date: timestamp ? localDateKey(timestamp) : null,
      counts,
    });
  }

  return turns;
}

/** The file's contribution, parsed only if it has changed since last time. */
async function contributionFor(file: string): Promise<FileContribution | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;

  const value = await readTranscript(file);
  // Only a real parse is remembered. Caching a failure would turn one bad read
  // into a permanently missing file.
  if (value) fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/**
 * The scan yields to the loop so the window keeps painting: 1826 transcripts
 * (883 MB) held the main thread 2775 ms the first time and 2.6 to 3.3 s at
 * every memo expiry, a freeze three callers could trigger (the Usage page and
 * either bot's /stats). The awaits sit between files, never inside one's
 * arithmetic, so the totals are the same.
 */
const BREATH_MS = 8;
let lastBreath = 0;

/** Hand the loop back if this pass has held it longer than a frame: timed, not
 *  counted in files, as sizes are skewed (a 65 MB transcript made a 25-file
 *  slice 604 ms). */
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
  const scan = scanTranscripts(homeDir).finally(() => { inFlight.delete(homeDir); });
  inFlight.set(homeDir, scan);
  return scan;
}

async function scanTranscripts(homeDir: string): Promise<TranscriptUsage> {
  // Which generation this scan belongs to. A clear that happens while it runs
  // makes its result stale before it exists, and it must not be memoised.
  const startedAt = generation;

  const root = path.join(homeDir, '.claude', 'projects');
  // Null-prototype: a transcript's model id is attacker-influenceable, and
  // `modelUsage[model] ||= …` on a plain object would let "__proto__" write
  // onto Object.prototype inside the main process.
  const modelUsage: Record<string, ModelUsage> = Object.create(null);
  const dailyMap = new Map<string, Record<string, number>>();
  type Split = { input: number; output: number; cacheRead: number; cacheWrite: number };
  const dailyBreakdown = new Map<string, Record<string, Split>>();
  const dailyCost = new Map<string, number>();
  const dailyCostByModel = new Map<string, Record<string, number>>();
  /** How many replies came back each day, per model. Counted off the same
   *  dedup key as the tokens: one API response is written as several lines
   *  sharing a message id, so counting turns would roughly double every day. */
  const dailyMessages = new Map<string, Record<string, number>>();
  let lastComputedDate: string | null = null;

  // One API response is several lines (one per content block) under one message
  // id and requestId, the earlier ones with a partial usage block: each key's
  // contribution is topped up, rather than counted per line (doubling costs) or
  // taken from the first line (279,904 output tokens, $7.00, lost here). Global,
  // not per file: a resumed session replays under the same ids.
  const applied = new Map<string, Counts>();

  const files = listTranscripts(root);
  let unreadable = 0;
  lastBreath = Date.now();
  for (const file of files) {
    await breatheIfDue();
    const turns = await contributionFor(file);
    // Counted, not skipped in silence: see `unreadable` on TranscriptUsage.
    if (!turns) { unreadable += 1; continue; }

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

      const bucket = (modelUsage[turn.model] ||= emptyUsage());
      bucket.inputTokens += delta.input;
      bucket.outputTokens += delta.output;
      bucket.cacheReadInputTokens += delta.cacheRead;
      bucket.cacheCreationInputTokens += delta.cacheWrite;
      bucket.cacheCreation1hTokens += delta.write1h;
      bucket.cacheCreation5mTokens += delta.write5m;
      bucket.webSearchRequests += delta.searches;

      const cost = costOf(turn.model, delta);
      bucket.costUSD += cost;

      if (turn.date) {
        const day = dailyMap.get(turn.date) ?? Object.create(null);
        day[turn.model] = (day[turn.model] || 0) + delta.input + delta.output;
        dailyMap.set(turn.date, day);

        const split = dailyBreakdown.get(turn.date) ?? Object.create(null);
        const cell = split[turn.model] ?? (split[turn.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        cell.input += delta.input;
        cell.output += delta.output;
        cell.cacheRead += delta.cacheRead;
        cell.cacheWrite += delta.cacheWrite;
        dailyBreakdown.set(turn.date, split);
        // The day priced from its own tokens, cache reads and writes included.
        dailyCost.set(turn.date, (dailyCost.get(turn.date) ?? 0) + cost);
        const costs = dailyCostByModel.get(turn.date) ?? Object.create(null);
        costs[turn.model] = (costs[turn.model] || 0) + cost;
        dailyCostByModel.set(turn.date, costs);

        if (isNewMessage) {
          const count = dailyMessages.get(turn.date) ?? Object.create(null);
          count[turn.model] = (count[turn.model] || 0) + 1;
          dailyMessages.set(turn.date, count);
        }

        if (!lastComputedDate || turn.date > lastComputedDate) lastComputedDate = turn.date;
      }
    }
  }

  // A transcript that has been deleted must stop contributing, and must not sit
  // in the map forever.
  if (fileCache.size > files.length) {
    const live = new Set(files);
    for (const key of fileCache.keys()) if (!live.has(key)) fileCache.delete(key);
  }

  const value: TranscriptUsage = {
    modelUsage: { ...modelUsage },
    dailyModelTokens: Array.from(dailyMap.entries())
      .map(([date, tokensByModel]) => ({
        date,
        tokensByModel: { ...tokensByModel },
        breakdownByModel: { ...(dailyBreakdown.get(date) ?? {}) },
        messagesByModel: { ...(dailyMessages.get(date) ?? {}) },
        costUSD: dailyCost.get(date) ?? 0,
        costByModel: { ...(dailyCostByModel.get(date) ?? {}) },
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    lastComputedDate,
    unreadable,
  };

  // Returned to whoever asked either way: they asked before the clear, and
  // these numbers were true then. Only the memo is refused, so the next caller
  // reads the world as it is now rather than as it was.
  if (generation === startedAt) cache = { at: Date.now(), homeDir, value };
  return value;
}

/**
 * Drops both memos so a test or a refresh sees fresh numbers, the per-file map
 * too: a fixture rewritten in the same millisecond to the same length would
 * otherwise give back the old parse.
 */
export function clearTranscriptUsageCache(): void {
  generation += 1;
  cache = null;
  fileCache.clear();
  // And the scan in progress: left behind, a caller that did not await could be
  // handed another home's figures.
  inFlight.clear();
}
