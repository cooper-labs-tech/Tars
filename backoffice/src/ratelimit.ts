// A token bucket per key, in memory: one server process, so one map. A restart refills every
// bucket, which only ever lets an install send a burst early.
export interface RateConfig { perMinute: number; burst: number }
export type Take = { ok: true } | { ok: false; retryAfter: number };

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  take(key: string, cfg: RateConfig): Take {
    const now = this.now();
    const perMs = cfg.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: cfg.burst, at: now };
    b.tokens = Math.min(cfg.burst, b.tokens + (now - b.at) * perMs);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const wait = perMs > 0 ? (1 - b.tokens) / perMs : 60_000;
    return { ok: false, retryAfter: Math.max(1, Math.ceil(wait / 1000)) };
  }

  /** Drops every bucket: after the operator changes the limits, each starts full under the new ones. */
  reset(): void { this.buckets.clear(); }

  /** Forgets buckets idle for an hour, so the map does not grow with every address ever seen. */
  sweep(): void {
    const cut = this.now() - 3_600_000;
    for (const [k, b] of this.buckets) if (b.at < cut) this.buckets.delete(k);
  }
}
