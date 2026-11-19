// The operator's pages, /admin. Two locks, either of which holds alone:
// 1. an access proxy in front (Cloudflare Access), whose signed assertion is checked here when
//    configured, so an origin reached around the proxy still refuses;
// 2. the app's own login: an scrypt-hashed password, a session cookie (HttpOnly, SameSite=Strict,
//    Secure over https), a CSRF token on every form, and the Origin of every POST checked.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Ctx, clientAddr } from './http.ts';
import { HttpError, readRaw } from './body.ts';
import { verifyPassword } from './password.ts';
import { verifyAccessJwt, AccessKeys } from './access-jwt.ts';
import { mintToken } from './tokens.ts';
import { writeSettings, type Settings } from './settings.ts';
import { deleteInstall, sweep } from './purge.ts';

const SESSION_HOURS = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let accessKeys: AccessKeys | null = null;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
const when = (d: Date | null | undefined) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

function secure(ctx: Ctx) { return (ctx.cfg.publicOrigin ?? '').startsWith('https://'); }
function cookieName(ctx: Ctx) { return secure(ctx) ? '__Host-tbo' : 'tbo'; }

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers,
  });
  res.end(html);
}
function redirect(res: ServerResponse, to: string, headers: Record<string, string> = {}) {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', ...headers });
  res.end();
}

const CSS = `body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#1b1b1b;background:#f6f6f4}
@media(prefers-color-scheme:dark){body{color:#e8e8e6;background:#141414}table,input,select,button{color:inherit;background:#1f1f1f}}
nav{display:flex;gap:16px;padding:12px 24px;border-bottom:1px solid #8884;align-items:center}nav a{color:inherit}
main{padding:16px 24px;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #8883;text-align:left;vertical-align:top}
form.inline{display:inline}input,select,button{font:inherit;padding:4px 8px;border:1px solid #8886;border-radius:4px}code{word-break:break-all}
.note{padding:8px 12px;border:1px solid #8886;border-radius:4px;margin:8px 0}`;

function layout(title: string, body: string, csrf?: string): string {
  const nav = csrf
    ? `<nav><strong>Trace back-office</strong><a href="/admin">Overview</a><a href="/admin/installs">Installs</a><a href="/admin/readers">Readers</a>
       <a href="/admin/settings">Settings</a><a href="/admin/deletions">Deletions</a>
       <form class="inline" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Sign out</button></form></nav>`
    : '<nav><strong>Trace back-office</strong></nav>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${nav}<main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readRaw(req, 64 * 1024);
  return new URLSearchParams(raw.toString('utf8'));
}

function expectedOrigin(ctx: Ctx, req: IncomingMessage): string {
  return ctx.cfg.publicOrigin ?? `http://${req.headers.host ?? ''}`;
}

async function accessCheck(ctx: Ctx, req: IncomingMessage): Promise<void> {
  if (!ctx.cfg.access) return;
  const token = String(req.headers['cf-access-jwt-assertion'] ?? '');
  accessKeys ??= new AccessKeys(ctx.cfg.access.issuer);
  const opts = { issuer: ctx.cfg.access.issuer, audience: ctx.cfg.access.audience };
  let ok = token ? verifyAccessJwt(token, await accessKeys.get(), opts) : null;
  if (token && !ok) ok = verifyAccessJwt(token, await accessKeys.get(true), opts); // keys may have rotated
  if (!ok) throw new HttpError(403, 'forbidden', 'the access proxy did not vouch for this request');
}

function sessionId(ctx: Ctx, req: IncomingMessage): string | null {
  const name = cookieName(ctx);
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name && v && /^[A-Za-z0-9_-]{43}$/.test(v)) return v;
  }
  return null;
}

async function currentSession(ctx: Ctx, req: IncomingMessage): Promise<{ csrf: string; idHash: Buffer } | null> {
  const id = sessionId(ctx, req);
  if (!id) return null;
  const idHash = createHash('sha256').update(id).digest();
  const r = await ctx.db.query<{ csrf: string }>('SELECT csrf FROM admin_sessions WHERE id_hash = $1 AND expires_at > now()', [idHash]);
  return r.rows[0] ? { csrf: r.rows[0].csrf, idHash } : null;
}

export async function admin(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  await accessCheck(ctx, req);
  if (!ctx.cfg.ownerPasswordHash) {
    return send(res, 503, layout('Closed', '<p>No owner password is set (BACKOFFICE_OWNER_PASSWORD_HASH). The pages stay closed until one is.</p>'));
  }
  const path = url.pathname;
  const post = req.method === 'POST';
  if (post && req.headers.origin !== expectedOrigin(ctx, req)) throw new HttpError(403, 'forbidden', 'cross-origin form');

  if (path === '/admin/login') return login(ctx, req, res, post);
  const s = await currentSession(ctx, req);
  if (!s) return redirect(res, '/admin/login');
  let f: URLSearchParams | null = null;
  if (post) {
    f = await form(req);
    if (f.get('csrf') !== s.csrf) throw new HttpError(403, 'forbidden', 'the form is stale; reload the page');
  }
  const flash = url.searchParams.get('msg') ? `<p class="note">${esc(url.searchParams.get('msg'))}</p>` : '';

  if (path === '/admin' && !post) return send(res, 200, layout('Overview', flash + (await overview(ctx)), s.csrf));
  if (path === '/admin/installs' && !post) return send(res, 200, layout('Installs', flash + (await installs(ctx, s.csrf)), s.csrf));
  if (path === '/admin/readers' && !post) return send(res, 200, layout('Readers', flash + (await readers(ctx, s.csrf)), s.csrf));
  if (path === '/admin/settings' && !post) return send(res, 200, layout('Settings', flash + (await settingsPage(ctx, s.csrf)), s.csrf));
  if (path === '/admin/deletions' && !post) return send(res, 200, layout('Deletions', flash + (await deletions(ctx)), s.csrf));
  if (!post || !f) throw new HttpError(404, 'not_found');

  if (path === '/admin/logout') {
    await ctx.db.query('DELETE FROM admin_sessions WHERE id_hash = $1', [s.idHash]);
    return redirect(res, '/admin/login', { 'set-cookie': `${cookieName(ctx)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure(ctx) ? '; Secure' : ''}` });
  }
  if (path === '/admin/readers') {
    const name = (f.get('name') ?? '').trim().slice(0, 80);
    if (!name) return redirect(res, '/admin/readers?msg=' + encodeURIComponent('Give the reader a name.'));
    const id = randomUUID();
    const { token, hash } = mintToken('reader');
    await ctx.db.query('INSERT INTO readers (id, name, token_hash) VALUES ($1, $2, $3)', [id, name, hash]);
    // Shown once, in this answer only: never in a URL, never stored.
    return send(res, 200, layout('Reader created', `<p>The token for <strong>${esc(name)}</strong>. Copy it now: it is shown once, and only its hash is kept.</p>
      <p><code id="new-token">${esc(token)}</code></p><p data-reader="${esc(id)}"><a href="/admin/readers">Back to readers</a></p>`, s.csrf));
  }
  let m = /^\/admin\/readers\/([0-9a-f-]{36})\/revoke$/.exec(path);
  if (m && UUID.test(m[1]!)) {
    await ctx.db.query('UPDATE readers SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [m[1]]);
    return redirect(res, '/admin/readers?msg=' + encodeURIComponent('Revoked. The token opens nothing from now on.'));
  }
  m = /^\/admin\/installs\/([0-9a-f-]{36})\/(block|unblock|delete|quota)$/.exec(path);
  if (m && UUID.test(m[1]!)) {
    const [, id, action] = m;
    if (action === 'block') await ctx.db.query('UPDATE installs SET blocked_at = now() WHERE id = $1', [id]);
    if (action === 'unblock') await ctx.db.query('UPDATE installs SET blocked_at = NULL WHERE id = $1', [id]);
    if (action === 'quota') {
      const v = (f.get('maxStoredMiB') ?? '').trim();
      const n = v === '' ? null : Number(v);
      if (n !== null && !(Number.isSafeInteger(n) && n >= 0)) return redirect(res, '/admin/installs?msg=' + encodeURIComponent('The quota is a whole number of MiB, or empty for the default.'));
      await ctx.db.query('UPDATE installs SET max_stored_bytes = $2 WHERE id = $1', [id, n === null ? null : n * 1024 * 1024]);
    }
    if (action === 'delete') {
      if (f.get('confirm') !== id) return redirect(res, '/admin/installs?msg=' + encodeURIComponent('Type the install id to confirm the deletion.'));
      const d = await deleteInstall(ctx, id!, 'operator');
      return redirect(res, '/admin/deletions?msg=' + encodeURIComponent(`Deleted, receipt ${d.receipt}.`));
    }
    return redirect(res, '/admin/installs?msg=' + encodeURIComponent('Done.'));
  }
  if (path === '/admin/settings') {
    const cur = await ctx.settings();
    const num = (k: string, fallback: number) => (f!.get(k) === null ? fallback : Number(f!.get(k)));
    const next: Settings = {
      retentionDays: num('retentionDays', cur.retentionDays),
      registration: (f.get('registration') ?? cur.registration) as Settings['registration'],
      maxStoredBytes: f.get('maxStoredMiB') === null ? cur.maxStoredBytes : Number(f.get('maxStoredMiB')) * 1024 * 1024,
      minFreeBytes: f.get('minFreeMiB') === null ? cur.minFreeBytes : Number(f.get('minFreeMiB')) * 1024 * 1024,
      ratePerMinute: num('ratePerMinute', cur.ratePerMinute),
      burst: num('burst', cur.burst),
      registrationsPerHourPerAddress: num('registrationsPerHourPerAddress', cur.registrationsPerHourPerAddress),
      registrationsPerHour: num('registrationsPerHour', cur.registrationsPerHour),
    };
    const err = await writeSettings(ctx.db, next);
    ctx.settingsChanged();
    return redirect(res, '/admin/settings?msg=' + encodeURIComponent(err ?? 'Saved.'));
  }
  if (path === '/admin/retention/run') {
    const r = await sweep(ctx);
    return redirect(res, '/admin/settings?msg=' + encodeURIComponent(`Retention ran: ${r.sessions} sessions, ${r.blobs} blobs and ${r.installs} idle installs removed.`));
  }
  throw new HttpError(404, 'not_found');
}

async function login(ctx: Ctx, req: IncomingMessage, res: ServerResponse, post: boolean): Promise<void> {
  const page = (msg = '') => layout('Sign in', `${msg ? `<p class="note">${esc(msg)}</p>` : ''}
    <form method="post" action="/admin/login">${hidden(randomBytes(16).toString('base64url'))}
    <label>Password <input type="password" name="password" autocomplete="current-password" autofocus required></label> <button>Sign in</button></form>`);
  if (!post) return send(res, 200, page());
  // Per address (clientAddr believes X-Real-IP from the local proxy only, addr.ts), and in all,
  // so that no source of addresses, however many, gets more than 30 tries an hour.
  const mine = ctx.limiter.take(`login:${clientAddr(ctx, req)}`, { perMinute: 1 / 3, burst: 5 });
  const t = mine.ok ? ctx.limiter.take('login:*', { perMinute: 0.5, burst: 10 }) : mine;
  if (!t.ok) return send(res, 429, page(`Too many attempts. Try again in ${t.retryAfter} s.`), { 'retry-after': String(t.retryAfter) });
  const f = await form(req);
  if (!(await verifyPassword(f.get('password') ?? '', ctx.cfg.ownerPasswordHash!))) return send(res, 401, page('Wrong password.'));
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  await ctx.db.query(`INSERT INTO admin_sessions (id_hash, csrf, expires_at) VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`,
    [createHash('sha256').update(id).digest(), csrf]);
  redirect(res, '/admin', {
    'set-cookie': `${cookieName(ctx)}=${id}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; SameSite=Strict${secure(ctx) ? '; Secure' : ''}`,
  });
}

async function overview(ctx: Ctx): Promise<string> {
  const c = (await ctx.db.query(`SELECT
      (SELECT count(*)::int FROM installs) AS installs,
      (SELECT count(*)::int FROM installs WHERE last_seen_at > now() - interval '7 days') AS active,
      (SELECT count(*)::int FROM installs WHERE blocked_at IS NOT NULL) AS blocked,
      (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM requests) AS requests,
      (SELECT count(*)::int FROM blobs) AS blobs,
      (SELECT coalesce(sum(stored_size), 0) FROM blobs) AS blob_bytes,
      (SELECT count(*)::int FROM readers WHERE revoked_at IS NULL) AS readers,
      pg_database_size(current_database()) AS db_bytes`)).rows[0];
  const days = (await ctx.db.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
      (SELECT count(*)::int FROM batches WHERE received_at >= d AND received_at < d + interval '1 day') AS batches,
      (SELECT coalesce(sum(bytes), 0) FROM batches WHERE received_at >= d AND received_at < d + interval '1 day') AS bytes,
      (SELECT count(*)::int FROM sessions WHERE received_at >= d AND received_at < d + interval '1 day') AS sessions
    FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d ORDER BY d DESC`)).rows;
  const s = await ctx.settings();
  return `<table><tbody>
    <tr><th>Installs</th><td>${c.installs} (${c.active} seen in 7 days, ${c.blocked} blocked)</td></tr>
    <tr><th>Sessions</th><td>${c.sessions}</td></tr><tr><th>Requests</th><td>${c.requests}</td></tr>
    <tr><th>Blobs</th><td>${c.blobs}, ${mib(c.blob_bytes)} MiB on disk</td></tr>
    <tr><th>Database</th><td>${mib(c.db_bytes)} MiB</td></tr>
    <tr><th>Free disk (blob store)</th><td>${mib(ctx.blobs.free())} MiB</td></tr>
    <tr><th>Readers</th><td>${c.readers} active</td></tr>
    <tr><th>Retention</th><td>${s.retentionDays} days; registration ${esc(s.registration)}</td></tr></tbody></table>
    <h2>Last 14 days</h2><table><thead><tr><th>Day (UTC)</th><th>Batches</th><th>Batch MiB</th><th>New or changed sessions</th></tr></thead><tbody>
    ${days.map((d) => `<tr><td>${d.day}</td><td>${d.batches}</td><td>${mib(d.bytes)}</td><td>${d.sessions}</td></tr>`).join('')}</tbody></table>`;
}

async function installs(ctx: Ctx, csrf: string): Promise<string> {
  const s = await ctx.settings();
  const rows = (await ctx.db.query(`SELECT i.*, (SELECT count(*)::int FROM sessions WHERE install_id = i.id) AS sessions
      FROM installs i ORDER BY coalesce(i.last_seen_at, i.created_at) DESC LIMIT 500`)).rows;
  if (!rows.length) return '<p>No install has registered yet.</p>';
  return `<table><thead><tr><th>Install</th><th>Client</th><th>Registered</th><th>Last seen</th><th>Sessions</th><th>Stored / quota (MiB)</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td><code>${esc(r.id)}</code>${r.blocked_at ? '<br><strong>blocked</strong>' : ''}</td>
    <td>${esc(r.client_name)} ${esc(r.client_version)} ${esc(r.platform)}</td><td>${when(r.created_at)}</td><td>${when(r.last_seen_at)}</td>
    <td>${r.sessions}</td><td>${mib(r.stored_bytes)} / ${mib(r.max_stored_bytes ?? s.maxStoredBytes)}</td>
    <td><form class="inline" method="post" action="/admin/installs/${esc(r.id)}/${r.blocked_at ? 'unblock' : 'block'}">${hidden(csrf)}<button>${r.blocked_at ? 'Unblock' : 'Block'}</button></form>
      <form class="inline" method="post" action="/admin/installs/${esc(r.id)}/quota">${hidden(csrf)}<input name="maxStoredMiB" size="6" placeholder="default" value="${r.max_stored_bytes === null ? '' : r.max_stored_bytes / 1024 / 1024}"><button>Set quota</button></form>
      <form class="inline" method="post" action="/admin/installs/${esc(r.id)}/delete">${hidden(csrf)}<input name="confirm" size="10" placeholder="type its id"><button>Delete all its data</button></form></td></tr>`).join('')}
  </tbody></table>`;
}

async function readers(ctx: Ctx, csrf: string): Promise<string> {
  const rows = (await ctx.db.query('SELECT id, name, created_at, last_used_at, revoked_at FROM readers ORDER BY created_at DESC')).rows;
  return `<p>A reader token opens the read API (<code>/v1/read/*</code>) and nothing else. It is shown once when created.</p>
  <form method="post" action="/admin/readers">${hidden(csrf)}<label>Name <input name="name" maxlength="80" required></label> <button>Create a reader token</button></form>
  <table><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${when(r.created_at)}</td><td>${when(r.last_used_at)}</td><td>${r.revoked_at ? `revoked ${when(r.revoked_at)}` : 'active'}</td>
    <td>${r.revoked_at ? '' : `<form class="inline" method="post" action="/admin/readers/${esc(r.id)}/revoke">${hidden(csrf)}<button>Revoke</button></form>`}</td></tr>`).join('')}
  </tbody></table>`;
}

async function settingsPage(ctx: Ctx, csrf: string): Promise<string> {
  const s = await ctx.settings();
  const field = (name: string, label: string, value: number) => `<p><label>${label} <input name="${name}" value="${value}" inputmode="numeric" required></label></p>`;
  return `<form method="post" action="/admin/settings">${hidden(csrf)}
    ${field('retentionDays', 'Keep sessions for (days)', s.retentionDays)}
    <p><label>Registration <select name="registration"><option value="open"${s.registration === 'open' ? ' selected' : ''}>open</option>
      <option value="closed"${s.registration === 'closed' ? ' selected' : ''}>closed</option></select></label></p>
    ${field('maxStoredMiB', 'Default quota per install (MiB)', Math.round(s.maxStoredBytes / 1024 / 1024))}
    ${field('minFreeMiB', 'Stop writes when the disk has less free than (MiB)', Math.round(s.minFreeBytes / 1024 / 1024))}
    ${field('ratePerMinute', 'Requests per minute per install', s.ratePerMinute)}
    ${field('burst', 'Burst', s.burst)}
    ${field('registrationsPerHourPerAddress', 'Registrations per hour per address', s.registrationsPerHourPerAddress)}
    ${field('registrationsPerHour', 'Registrations per hour in all', s.registrationsPerHour)}
    <p><button>Save</button></p></form>
    <form method="post" action="/admin/retention/run">${hidden(csrf)}<button>Run retention now</button></form>`;
}

async function deletions(ctx: Ctx): Promise<string> {
  const rows = (await ctx.db.query('SELECT * FROM deletion_log ORDER BY at DESC LIMIT 500')).rows;
  if (!rows.length) return '<p>No deletion yet.</p>';
  return `<p>Every deletion, with its counts. Readers are told through <code>/v1/read/deletions</code>.</p>
  <table><thead><tr><th>When</th><th>Receipt</th><th>Install</th><th>Why</th><th>What</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${when(r.at)}</td><td><code>${esc(r.receipt)}</code></td><td><code>${esc(r.install_id)}</code></td><td>${esc(r.reason)}</td>
    <td>${esc(Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', '))}</td></tr>`).join('')}</tbody></table>`;
}
