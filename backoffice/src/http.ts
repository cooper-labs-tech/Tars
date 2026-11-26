// What every route shares: the context, JSON answers, the client's address, and the two token checks.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { BlobStore } from './blobstore.ts';
import { RateLimiter } from './ratelimit.ts';
import { readSettings, type Settings } from './settings.ts';
import { bearerHash } from './tokens.ts';
import { HttpError, readRaw, decodeBody } from './body.ts';
import { LIMITS } from './config.ts';
import { clientAddress } from './addr.ts';

export interface Ctx {
  db: Db;
  cfg: Config;
  blobs: BlobStore;
  limiter: RateLimiter;
  settings(): Promise<Settings>;
  settingsChanged(): void;
}

export function makeCtx(db: Db, cfg: Config, blobs: BlobStore): Ctx {
  let cached: { s: Settings; at: number } | null = null;
  const limiter = new RateLimiter();
  return {
    db, cfg, blobs, limiter,
    async settings() {
      if (cached && Date.now() - cached.at < 5000) return cached.s;
      cached = { s: await readSettings(db), at: Date.now() };
      return cached.s;
    },
    settingsChanged() { cached = null; limiter.reset(); },
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(b.length), 'cache-control': 'no-store', ...headers });
  res.end(b);
}

export function clientAddr(ctx: Ctx, req: IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  return clientAddress(ctx.cfg.trustProxy, req.socket.remoteAddress ?? 'unknown', typeof real === 'string' ? real : undefined);
}

/**
 * Writes stop under the free-disk floor (the Audit's M1 on #597): Postgres shares the disk in the
 * documented deploy, so a full disk would take reads down too. 507 with Retry-After, which Tars's
 * uploader reads as "back off".
 */
export async function assertRoom(ctx: Ctx): Promise<void> {
  const { minFreeBytes } = await ctx.settings();
  if (ctx.blobs.free() < minFreeBytes) {
    throw new HttpError(507, 'disk_full', 'the server is below its free-disk floor and takes no writes for now', { retryAfter: 3600 });
  }
}

export async function readJson(req: IncomingMessage, wire: number, decoded: number): Promise<{ value: unknown; bytes: Buffer }> {
  const raw = await readRaw(req, wire);
  const bytes = decodeBody(raw, req.headers['content-encoding'], { wire, decoded });
  try {
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } catch {
    throw new HttpError(400, 'bad_json', 'the body is not valid JSON');
  }
}

export const smallJson = (req: IncomingMessage) => readJson(req, LIMITS.jsonWire, LIMITS.jsonWire * 8);

export interface Install { id: string; storedBytes: number; maxStoredBytes: number | null }

/** The install the token names, after its block and rate checks. */
export async function authInstall(ctx: Ctx, req: IncomingMessage): Promise<Install> {
  const hash = bearerHash(req.headers.authorization, 'install');
  if (!hash) throw new HttpError(401, 'unauthorized');
  const r = await ctx.db.query<{ id: string; blocked_at: Date | null; stored_bytes: number; max_stored_bytes: number | null; seen: boolean }>(
    `SELECT id, blocked_at, stored_bytes, max_stored_bytes, (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute') AS seen
       FROM installs WHERE token_hash = $1`, [hash]);
  const row = r.rows[0];
  if (!row) throw new HttpError(401, 'unauthorized');
  if (row.blocked_at) throw new HttpError(403, 'install_blocked');
  const s = await ctx.settings();
  const t = ctx.limiter.take(`i:${row.id}`, { perMinute: s.ratePerMinute, burst: s.burst });
  if (!t.ok) throw new HttpError(429, 'rate_limited', undefined, { retryAfter: t.retryAfter });
  if (row.seen) await ctx.db.query('UPDATE installs SET last_seen_at = now() WHERE id = $1', [row.id]);
  return { id: row.id, storedBytes: row.stored_bytes, maxStoredBytes: row.max_stored_bytes };
}

export async function authReader(ctx: Ctx, req: IncomingMessage): Promise<string> {
  const hash = bearerHash(req.headers.authorization, 'reader');
  if (!hash) throw new HttpError(401, 'unauthorized');
  const r = await ctx.db.query<{ id: string; stale: boolean }>(
    `SELECT id, (last_used_at IS NULL OR last_used_at < now() - interval '1 minute') AS stale
       FROM readers WHERE token_hash = $1 AND revoked_at IS NULL`, [hash]);
  const row = r.rows[0];
  if (!row) throw new HttpError(401, 'unauthorized');
  const t = ctx.limiter.take(`r:${row.id}`, { perMinute: 600, burst: 200 });
  if (!t.ok) throw new HttpError(429, 'rate_limited', undefined, { retryAfter: t.retryAfter });
  if (row.stale) await ctx.db.query('UPDATE readers SET last_used_at = now() WHERE id = $1', [row.id]);
  return row.id;
}

export const ms = (d: Date | null | undefined) => (d ? d.getTime() : undefined);
