/**
 * The round trip to an inference endpoint and the offset between its clock and ours, from the Server-Timing header
 * (W3C Server Timing) the endpoint sends on every response, errors included:
 *
 * - `recv;desc="<epoch ms>"`: when the endpoint read the request, integer Unix ms on its clock (t2);
 * - `send;desc="<epoch ms>"`: when it began sending the response's headers, on the same clock (t3);
 * - `queue;dur=<ms>`: its wait for a free slot (the full wait on a 429, 0 on its other errors);
 * - `upstream;dur=<ms>`: from the slot to its model server's headers; absent when it answered by itself.
 *
 * With t1 when the proxy sent the request and t4 when the response's headers came, on our clock:
 * offset = ((t2 - t1) + (t3 - t4)) / 2 and round trip = (t4 - t1) - (t3 - t2). The offset's error is at most half the
 * round trip. A metric of another name is ignored, the first of a known name counts, and a value that is absent or
 * malformed is null, never 0. A negative round trip (the endpoint's t2 to t3 read longer than our t1 to t4, which
 * integer milliseconds or a clock running at another rate can do) is kept as measured; a session's summary leaves it
 * out. An endpoint whose send is before its recv says nothing usable. The Date header (one-second precision) is never
 * used. Server-side TTFT and total time are not derived here: that is the reader's work.
 */

export interface ServerTimingMetrics { recv: number | null; send: number | null; queue: number | null; upstream: number | null }
export interface RequestTiming { rttMs: number | null; clockOffsetMs: number | null; queueMs: number | null; upstreamMs: number | null }

/** RFC 9110's tchar. */
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

interface Metric { name: string; params: Record<string, string> }

/** The header's metrics, each with its parameters; a metric whose syntax is broken is dropped, never half read. */
function metricsOf(text: string): Metric[] {
  const out: Metric[] = [];
  const n = text.length;
  let i = 0;
  const skipSpace = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
  const token = () => { const start = i; while (i < n && TCHAR.test(text[i])) i++; return text.slice(start, i); };
  /** A quoted string from its opening quote, its escapes undone; null when it never closes. */
  const quoted = (): string | null => {
    i++;
    let s = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        if (i + 1 >= n) return null;
        s += text[i + 1];
        i += 2;
      } else if (c === '"') {
        i++;
        return s;
      } else {
        s += c;
        i++;
      }
    }
    return null;
  };
  /** On to the next metric: past the next comma outside a quoted string. */
  const nextMetric = () => {
    while (i < n && text[i] !== ',') {
      if (text[i] === '"') { if (quoted() === null) { i = n; return; } } else i++;
    }
    i++;
  };
  while (i < n) {
    skipSpace();
    const name = token();
    if (!name) { nextMetric(); continue; }
    const params: Record<string, string> = {};
    let ok = true;
    skipSpace();
    while (ok && i < n && text[i] === ';') {
      i++;
      skipSpace();
      const key = token().toLowerCase();
      skipSpace();
      if (!key || text[i] !== '=') { ok = false; break; }
      i++;
      skipSpace();
      const value = text[i] === '"' ? quoted() : token() || null;
      if (value === null) { ok = false; break; }
      if (!(key in params)) params[key] = value;
      skipSpace();
    }
    if (ok && i < n && text[i] !== ',') ok = false;
    if (ok) { out.push({ name, params }); i++; } else nextMetric();
  }
  return out;
}

const epochMs = (v: string | undefined): number | null => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
const durationMs = (v: string | undefined): number | null => (v !== undefined && /^\d{1,9}(\.\d{1,6})?$/.test(v) ? Number(v) : null);

/** The four metrics of a Server-Timing header (or the headers Node gives as a list); null for each one not read. */
export function parseServerTiming(value: string | string[] | undefined): ServerTimingMetrics {
  const text = Array.isArray(value) ? value.join(', ') : value ?? '';
  const first = new Map<string, Record<string, string>>();
  for (const m of metricsOf(text)) if (!first.has(m.name)) first.set(m.name, m.params);
  return {
    recv: epochMs(first.get('recv')?.desc),
    send: epochMs(first.get('send')?.desc),
    queue: durationMs(first.get('queue')?.dur),
    upstream: durationMs(first.get('upstream')?.dur),
  };
}

/** A request's timing: `sentAt` (t1) when the proxy sent it, `headersAt` (t4) when the response's headers came. */
export function requestTiming(value: string | string[] | undefined, sentAt: number, headersAt: number): RequestTiming {
  const m = parseServerTiming(value);
  const usable = m.recv !== null && m.send !== null && m.send >= m.recv && Number.isFinite(sentAt) && Number.isFinite(headersAt);
  return {
    rttMs: usable ? (headersAt - sentAt) - (m.send! - m.recv!) : null,
    clockOffsetMs: usable ? ((m.recv! - sentAt) + (m.send! - headersAt)) / 2 : null,
    queueMs: m.queue,
    upstreamMs: m.upstream,
  };
}

/**
 * A session's summary of its requests' timings: the median of the round trips, and the offset of the request whose
 * round trip was the shortest (the tightest bound on it). A negative round trip is left out of both; with no sample
 * both are null.
 */
export function sessionTiming(samples: Array<{ rttMs: number | null; clockOffsetMs: number | null }>): { rttMedianMs: number | null; clockOffsetMs: number | null } {
  const good = samples.filter((s): s is { rttMs: number; clockOffsetMs: number } => typeof s.rttMs === 'number' && s.rttMs >= 0 && typeof s.clockOffsetMs === 'number');
  if (!good.length) return { rttMedianMs: null, clockOffsetMs: null };
  const rtts = good.map(s => s.rttMs).sort((a, b) => a - b);
  const mid = Math.floor(rtts.length / 2);
  const median = rtts.length % 2 ? rtts[mid] : (rtts[mid - 1] + rtts[mid]) / 2;
  const fastest = good.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
  return { rttMedianMs: median, clockOffsetMs: fastest.clockOffsetMs };
}
