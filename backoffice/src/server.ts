// The trace back-office server: one Node process, plain node:http, behind a local TLS proxy.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.ts';
import { connect, pending } from './db.ts';
import { BlobStore } from './blobstore.ts';
import { makeCtx, json, type Ctx } from './http.ts';
import { HttpError } from './body.ts';
import { register, me, deleteMe, deleteOneSession, missingBlobs, putBlob, putBatch } from './ingest.ts';
import { listSessions, listDeletions, getSession, findRequests, getBlob } from './read.ts';
import { admin } from './admin.ts';
import { sweep } from './purge.ts';

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const p = url.pathname;
  const m = req.method ?? 'GET';
  let x: RegExpExecArray | null;
  if (p === '/healthz' && m === 'GET') {
    await ctx.db.query('SELECT 1');
    return json(res, 200, { ok: true });
  }
  if (p === '/admin' || p.startsWith('/admin/')) return admin(ctx, req, res, url);
  if (p === '/v1/installs' && m === 'POST') return register(ctx, req, res);
  if (p === '/v1/installs/me' && m === 'GET') return me(ctx, req, res);
  if (p === '/v1/installs/me' && m === 'DELETE') return deleteMe(ctx, req, res);
  if ((x = /^\/v1\/sessions\/([^/]+)$/.exec(p)) && m === 'DELETE') return deleteOneSession(ctx, req, res, decodeURIComponent(x[1]!));
  if (p === '/v1/blobs/missing' && m === 'POST') return missingBlobs(ctx, req, res);
  if ((x = /^\/v1\/blobs\/([^/]+)$/.exec(p)) && m === 'PUT') return putBlob(ctx, req, res, x[1]!);
  if ((x = /^\/v1\/batches\/([^/]+)$/.exec(p)) && m === 'PUT') return putBatch(ctx, req, res, decodeURIComponent(x[1]!));
  if (p === '/v1/read/sessions' && m === 'GET') return listSessions(ctx, req, res, url);
  if ((x = /^\/v1\/read\/sessions\/([^/]+)\/([^/]+)$/.exec(p)) && m === 'GET') return getSession(ctx, req, res, x[1]!, decodeURIComponent(x[2]!));
  if (p === '/v1/read/deletions' && m === 'GET') return listDeletions(ctx, req, res, url);
  if (p === '/v1/read/requests' && m === 'GET') return findRequests(ctx, req, res, url);
  if ((x = /^\/v1\/read\/blobs\/([^/]+)$/.exec(p)) && m === 'GET') return getBlob(ctx, req, res, x[1]!);
  throw new HttpError(404, 'not_found');
}

async function main() {
  const cfg = loadConfig();
  const db = connect();
  const behind = await pending(db);
  if (behind.length) {
    console.error(`the database schema is behind: ${behind.join(', ')} not applied. Run: node src/cli.ts migrate up`);
    process.exit(2);
  }
  const ctx = makeCtx(db, cfg, new BlobStore(cfg.dataDir));
  const server = createServer({ requestTimeout: 120_000, headersTimeout: 30_000 }, (req, res) => {
    route(ctx, req, res).catch((e: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) {
        const { retryAfter, ...extra } = e.extra as { retryAfter?: number };
        return json(res, e.status, { error: e.code, ...(e.message !== e.code ? { message: e.message } : {}), ...extra },
          retryAfter ? { 'retry-after': String(retryAfter) } : {});
      }
      // Never the error's text to the client: it could hold a query or a path.
      console.error(`${req.method} ${req.url?.split('?')[0]}: ${(e as Error)?.stack ?? e}`);
      json(res, 500, { error: 'internal' });
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    const a = server.address();
    const port = a && typeof a === 'object' ? a.port : cfg.port;
    console.log(`trace back-office listening on http://${cfg.host}:${port}`);
  });
  const timers: NodeJS.Timeout[] = [setInterval(() => ctx.limiter.sweep(), 600_000)];
  if (cfg.retentionSweepMs > 0) {
    timers.push(setInterval(() => sweep(ctx).catch((e) => console.error(`retention sweep: ${e.message}`)), cfg.retentionSweepMs));
  }
  const stop = () => {
    for (const t of timers) clearInterval(t);
    server.close(() => db.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
