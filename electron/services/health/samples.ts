import * as fs from 'fs';
import { writeSecretFileSync } from '../../utils/secret-file';

/**
 * The health samples Tars keeps on this machine (2.0.3, monitoring option 2):
 * one every 5 minutes (monitor.ts), 24 hours of them, in a bounded file under
 * ~/.dorothy: numbers, with the names of Tars's own calls and pages, no
 * content, no file path, no name. They leave only attached to the report of an
 * abrupt end, or when the user sends a diagnostic (error-reports).
 *
 * The file is in ~/.dorothy, which every agent may write: whatever is read
 * back is rebuilt field by field from what a sample may hold (cleanSample),
 * never passed on as it was found, so a line an agent or a broken write left
 * cannot carry a name, a path or a conversation out.
 */

export interface SlowCall {
  /** An IPC channel's name, `usage:tasks`. */
  channel: string;
  /** Its slowest answer in the window, in ms. */
  ms: number;
}

export interface HealthSample {
  /** Epoch ms. */
  at: number;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  /** The event loop's delay over the window, from perf_hooks. */
  loopP50Ms: number;
  loopP95Ms: number;
  /** The slowest IPC handlers of the window, three at most. */
  slowest: SlowCall[];
  agents: number;
  running: number;
  /** The path of the page the window showed, `/usage`; null when unknown or not a bare path. */
  page: string | null;
}

export const HEALTH_KEEP_MS = 24 * 3_600_000;
/** 24 hours at one sample every 5 minutes is about 80 KB; three times that leaves room and caps a runaway. */
export const HEALTH_MAX_BYTES = 256 * 1024;
const SLOWEST = 3;
/** A clock set back makes a sample look ahead of now: past this, it is not kept. */
const FUTURE_SLACK_MS = 3_600_000;

const CHANNEL = /^[A-Za-z][A-Za-z0-9:._-]{0,63}$/;
/** A bare path of the app's own routes: lowercase words, no query, no dot, at most 64 characters. */
const PAGE = /^\/(?:[a-z0-9-]+\/?){0,6}$/;

const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const round = (v: number) => Math.round(v * 10) / 10;

/** The sample as it may be kept and sent: every field checked, nothing else copied; null when a number is not one. */
export function cleanSample(raw: unknown): HealthSample | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const numbers = ['at', 'heapUsedMb', 'heapTotalMb', 'rssMb', 'loopP50Ms', 'loopP95Ms', 'agents', 'running'] as const;
  const out: Record<string, number> = {};
  for (const key of numbers) {
    const v = amount(r[key]);
    if (v === null) return null;
    out[key] = key === 'at' || key === 'agents' || key === 'running' ? Math.round(v) : round(v);
  }
  const slowest: SlowCall[] = [];
  for (const call of Array.isArray(r.slowest) ? r.slowest : []) {
    const c = call as Record<string, unknown> | null;
    const ms = amount(c?.ms);
    if (typeof c?.channel === 'string' && CHANNEL.test(c.channel) && ms !== null && slowest.length < SLOWEST) {
      slowest.push({ channel: c.channel, ms: Math.round(ms) });
    }
  }
  const page = typeof r.page === 'string' && r.page.length <= 64 && PAGE.test(r.page) ? r.page : null;
  return {
    at: out.at, heapUsedMb: out.heapUsedMb, heapTotalMb: out.heapTotalMb, rssMb: out.rssMb,
    loopP50Ms: out.loopP50Ms, loopP95Ms: out.loopP95Ms, slowest, agents: out.agents, running: out.running, page,
  };
}

function inWindow(sample: HealthSample, now: number): boolean {
  return sample.at >= now - HEALTH_KEEP_MS && sample.at <= now + FUTURE_SLACK_MS;
}

/**
 * What a sample may name when it leaves: the channels this Tars registered,
 * the app's pages. The file is in ~/.dorothy, which agents may write: a line
 * that passes cleanSample holds words in a channel's or a page's pattern,
 * which are only kept when they are one of these.
 */
export interface Vocabulary {
  channels: ReadonlySet<string>;
  pages: ReadonlySet<string>;
}

export function onlyKnown(sample: HealthSample, known: Vocabulary): HealthSample {
  return {
    ...sample,
    slowest: sample.slowest.filter((c) => known.channels.has(c.channel)),
    page: sample.page !== null && known.pages.has(sample.page) ? sample.page : null,
  };
}

/**
 * The samples of the last 24 hours, oldest first; none when the file is
 * missing or unreadable. With `known`, only the words it holds: what leaves.
 */
export function readSamples(file: string, now = Date.now(), known?: Vocabulary): HealthSample[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HealthSample[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const sample = cleanSample(parsed);
    if (sample && inWindow(sample, now)) out.push(known ? onlyKnown(sample, known) : sample);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Adds a sample, then keeps the file to 24 hours and to its size, the oldest dropped first. Never throws. */
export function appendSample(file: string, sample: HealthSample, now = Date.now()): void {
  const clean = cleanSample(sample);
  if (!clean || !inWindow(clean, now)) return;
  const kept = [...readSamples(file, now), clean];
  const lines = kept.map((s) => JSON.stringify(s));
  let bytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
  while (bytes > HEALTH_MAX_BYTES && lines.length > 1) bytes -= Buffer.byteLength(lines.shift()!) + 1;
  try {
    // 0600 on macOS and Linux; on Windows, born closed to every account but
    // the user's and SYSTEM, once main.ts names the file at startup.
    writeSecretFileSync(file, `${lines.join('\n')}\n`);
  } catch (err) {
    console.warn('[health] could not write a sample:', (err as Error).message);
  }
}
