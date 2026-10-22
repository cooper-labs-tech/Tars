import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A Hermes gateway's conversation, as the real one answers it: measured on 21/10 and 22/10 against
 * Hermes 0.21.5 (tag v2026.9.24) and a 0.22.2 canary, in throwaway HERMES_HOMEs behind the basic
 * sign-in, with Tars's own compiled transport and a fake model (the bench of PR "one Hermes session").
 *
 * - The sign-in: /auth/password-login sets the session cookies; every other route but /api/status
 *   wants them; /api/auth/ws-ticket mints a single-use ticket each WebSocket presents.
 * - The conversation, /api/ws, JSON-RPC 2.0: `session.create` answers a runtime id and a stored id and
 *   writes no row until a message lands; `session.resume` of a stored id answers a runtime id for it
 *   (the same session: no row added), and of an id the gateway does not have answers
 *   `4007 session not found` on 0.21.5 where the canary makes an empty session under that id;
 *   `prompt.submit` answers `streaming`, then the turn's events arrive as notifications
 *   ({method: 'event', params: {type, session_id, payload}}), `message.complete` last; a runtime id
 *   the gateway does not know answers `4001 session not found`; `session.interrupt` answers
 *   `interrupted`.
 * - The terminal, /api/pty (what Tars 2.0.3 and main used): every socket with a new `attach` token
 *   starts a new chat TUI, which resumes the session its channel's marker names, after a
 *   `{"type":"resume","id":...}` text frame, or else starts a new session of its own. A detached
 *   terminal lives `ptyTtlMs` (the dashboard's 30 minutes); on the canary, reaping it discards its
 *   channel's marker.
 * - A cron run is a session of its own, always: `cron_{job}_{YYYYMMDD_HHMMSS}` (cron/scheduler.py).
 *
 * `rows` is the state database: it survives `restart()`, which forgets what a gateway process holds
 * in memory (live sessions, terminals, markers, tickets) and closes every socket.
 */

export type HermesFlavour = '0.21.5' | '0.22';

export interface GatewayRow {
  id: string;
  source: 'tool' | 'tui' | 'cron';
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface GatewayEvent {
  at: number;
  kind: string;
  detail?: Record<string, unknown>;
}

export interface FakeHermesGateway {
  url: string;
  port: number;
  /** Every session the gateway holds, oldest first. */
  rows(): GatewayRow[];
  /** Every request, method call and terminal the gateway saw. */
  events: GatewayEvent[];
  /** What a sleep does to the client's sockets: closed, while the gateway keeps what it holds. */
  dropSockets(): void;
  /** A gateway restart: the state database stays, the process's memory goes. */
  restart(): void;
  /** A gateway, or a proxy before it, that does not take the conversation's WebSocket. */
  refuseConversation(on: boolean): void;
  /** The next prompt's socket closes before its answer, as a network change mid-turn. */
  dropNextTurn(): void;
  /** A session deleted on the gateway (DELETE /api/sessions/{id}, or by hand). */
  deleteSession(id: string): void;
  close(): Promise<void>;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A server side WebSocket, text and binary frames, enough for one JSON-RPC peer or one terminal. */
class Socket {
  private buf = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private opcode = 0;
  closed = false;
  onText: (text: string) => void = () => {};
  onClose: () => void = () => {};

  constructor(private readonly raw: Duplex) {
    raw.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    raw.on('close', () => this.ended());
    raw.on('error', () => this.ended());
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private drain(): void {
    while (this.buf.length >= 2) {
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.buf[maskAt + (i % 4)];
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.frame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0) { this.opcode = opcode; this.parts = []; }
      this.parts.push(payload);
      if (!fin) continue;
      payload = Buffer.concat(this.parts);
      this.parts = [];
      this.onText(payload.toString('utf-8'));
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const n = payload.length;
    let head: Buffer;
    if (n < 126) head = Buffer.from([0x80 | opcode, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.raw.write(Buffer.concat([head, payload]));
  }

  sendText(text: string): void { this.frame(0x1, Buffer.from(text, 'utf-8')); }
  sendBytes(text: string): void { this.frame(0x2, Buffer.from(text, 'utf-8')); }

  close(): void {
    if (this.closed) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch { /* already gone */ }
    this.raw.end();
    this.ended();
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
const hex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');

export async function startFakeHermesGateway(opts: {
  flavour: HermesFlavour;
  /** The assistant's final text for a turn, numbered from 1 across the whole gateway. */
  reply?: (prompt: string, turn: number) => string;
  /** How long a detached terminal lives: the dashboard's 30 minutes, shortened. */
  ptyTtlMs?: number;
  /** How long a turn takes before its answer. */
  replyDelayMs?: number;
}): Promise<FakeHermesGateway> {
  const reply = opts.reply ?? ((_p, n) => JSON.stringify({ say: `Check-in number ${n}: nothing to report.`, action: null }));
  const ttl = opts.ptyTtlMs ?? 30 * 60_000;
  const delay = opts.replyDelayMs ?? 50;
  const events: GatewayEvent[] = [];
  const note = (kind: string, detail?: Record<string, unknown>) => { events.push({ at: Date.now(), kind, ...(detail ? { detail } : {}) }); };

  const rows = new Map<string, GatewayRow>();
  let turns = 0;
  const cookie = hex(16);
  // What a gateway process holds in memory.
  let tickets = new Set<string>();
  let live = new Map<string, string>(); // runtime id -> stored id
  let markers = new Map<string, string>(); // terminal channel -> stored id
  let terminals = new Map<string, { channel: string; stored: string; socket: Socket | null; reap?: NodeJS.Timeout }>();
  const sockets = new Set<Socket>();
  let refusing = false;
  let dropping = false;
  const jobs = new Map<string, { prompt: string; runs: string[] }>();

  const row = (id: string, source: GatewayRow['source']): GatewayRow => {
    let r = rows.get(id);
    if (!r) { r = { id, source, messages: [] }; rows.set(id, r); }
    return r;
  };
  const answer = (stored: string, source: GatewayRow['source'], prompt: string): string => {
    const r = row(stored, source);
    turns += 1;
    const text = reply(prompt, turns);
    r.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
    return text;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(String(req.url), 'http://gateway.test');
    const send = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = (() => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } })();
      note('http', { method: req.method, path: url.pathname });
      if (url.pathname === '/api/status') {
        return send(200, { version: opts.flavour === '0.21.5' ? '0.21.5' : '0.22.2', auth_required: true, auth_flows: ['cookie'], auth_providers: ['basic'], gateway_state: 'running' });
      }
      if (url.pathname === '/auth/password-login' && req.method === 'POST') {
        return send(200, { ok: true }, { 'Set-Cookie': [`hermes_session_at=${cookie}; Path=/; HttpOnly`, `hermes_session_rt=${cookie}.rt; Path=/; HttpOnly`] });
      }
      if (!String(req.headers.cookie ?? '').includes(`hermes_session_at=${cookie}`)) return send(401, { detail: 'Unauthorized' });
      if (url.pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
        const ticket = hex(16);
        tickets.add(ticket);
        return send(200, { ticket, ttl_seconds: 30 });
      }
      if (url.pathname === '/api/config') return send(200, { agent: { reasoning_effort: 'medium' } });
      if (url.pathname === '/api/model/options') return send(200, { provider: 'custom', model: 'fake-model', providers: [] });
      if (url.pathname === '/api/cron/jobs' && req.method === 'GET') return send(200, { jobs: [...jobs.keys()].map(id => ({ id })) });
      if (url.pathname === '/api/cron/jobs' && req.method === 'POST') {
        const id = hex(6);
        jobs.set(id, { prompt: String(body.prompt ?? ''), runs: [] });
        note('cron', { create: id });
        return send(200, { id, name: body.name, schedule: body.schedule });
      }
      const job = /^\/api\/cron\/jobs\/([^/]+)(?:\/(trigger|runs))?$/.exec(url.pathname);
      if (job && jobs.has(job[1])) {
        const j = jobs.get(job[1])!;
        if (!job[2] && req.method === 'PUT') { j.prompt = String(body.updates?.prompt ?? j.prompt); note('cron', { update: job[1] }); return send(200, { id: job[1] }); }
        if (job[2] === 'trigger') {
          const run = `cron_${job[1]}_${stamp()}`;
          j.runs.unshift(run);
          note('cron', { trigger: job[1], run });
          setTimeout(() => answer(run, 'cron', j.prompt), delay);
          return send(200, { ok: true });
        }
        if (job[2] === 'runs') return send(200, { runs: j.runs.map(id => ({ id, status: 'ok' })) });
      }
      const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
      if (messages) {
        const r = rows.get(decodeURIComponent(messages[1]));
        return r ? send(200, { messages: r.messages }) : send(404, { detail: 'Session not found' });
      }
      return send(404, { detail: 'Not Found' });
    });
  });

  server.on('upgrade', (req, raw: Duplex) => {
    const url = new URL(String(req.url), 'http://gateway.test');
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!tickets.delete(ticket)) {
      raw.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (refusing && url.pathname === '/api/ws') {
      note('ws-refused');
      raw.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key'] ?? '') + GUID).digest('base64');
    raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const socket = new Socket(raw);
    sockets.add(socket);
    if (url.pathname === '/api/ws') conversation(socket);
    else if (url.pathname === '/api/pty') terminal(socket, url.searchParams);
    else socket.close();
  });

  function conversation(socket: Socket): void {
    note('ws', {});
    socket.onClose = () => { sockets.delete(socket); };
    socket.onText = text => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(text); } catch { return; }
      const params = msg.params ?? {};
      const ok = (result: unknown) => socket.sendText(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      const fail = (code: number, message: string) => socket.sendText(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));
      note('rpc', { method: msg.method, ...params, text: undefined });
      const info = { model: 'fake-model', provider: 'custom' };
      if (msg.method === 'session.create') {
        const runtime = hex(4);
        const stored = `${stamp()}_${hex(3)}`;
        live.set(runtime, stored);
        return ok({ session_id: runtime, stored_session_id: stored, info });
      }
      if (msg.method === 'session.resume') {
        const stored = String(params.session_id ?? '');
        const held = [...live].find(([, s]) => s === stored)?.[0];
        if (held) return ok({ session_id: held, session_key: stored, info });
        if (!rows.has(stored)) {
          if (opts.flavour === '0.21.5') return fail(4007, 'session not found');
          row(stored, 'tool');
        }
        const runtime = hex(4);
        live.set(runtime, stored);
        return ok({ session_id: runtime, session_key: stored, info });
      }
      if (msg.method === 'prompt.submit') {
        const runtime = String(params.session_id ?? '');
        const stored = live.get(runtime);
        if (!stored) return fail(4001, 'session not found');
        ok({ status: 'streaming' });
        if (dropping) { dropping = false; note('turn-dropped'); socket.close(); return; }
        const prompt = String(params.text ?? '');
        setTimeout(() => {
          if (socket.closed || live.get(runtime) !== stored) return;
          const text = answer(stored, 'tool', prompt);
          const event = (type: string, payload: unknown) => socket.sendText(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: runtime, payload } }));
          event('message.start', {});
          event('message.delta', { text: text.slice(0, 10) });
          event('message.complete', { text, status: 'complete' });
        }, delay);
        return;
      }
      if (msg.method === 'session.interrupt') {
        return live.has(String(params.session_id ?? '')) ? ok({ status: 'interrupted' }) : fail(4001, 'session not found');
      }
      return fail(-32601, `unknown method: ${msg.method}`);
    };
  }

  function terminal(socket: Socket, q: URLSearchParams): void {
    const channel = q.get('channel') ?? '';
    const attach = q.get('attach') ?? '';
    const explicit = q.get('resume') || null;
    const key = `${attach}\0${explicit ?? ''}`;
    let t = terminals.get(key);
    const created = !t;
    if (!t) {
      const marked = explicit ? null : markers.get(channel) ?? null;
      if (marked) socket.sendText(JSON.stringify({ type: 'resume', id: marked }));
      const stored = explicit ?? marked ?? `${stamp()}_${hex(3)}`;
      markers.set(channel, stored);
      t = { channel, stored, socket };
      terminals.set(key, t);
    }
    if (t.reap) clearTimeout(t.reap);
    t.socket = socket;
    note('pty', { channel, created, stored: t.stored });
    const held = t;
    let typed = '';
    let pasting = false;
    socket.sendBytes('\x1b[2J\x1b[H Hermes is ready\r\n');
    socket.onText = data => {
      if (/^\x1b\[RESIZE:\d+;\d+\]$/.test(data)) return;
      let rest = data;
      if (rest.includes('\x1b[200~')) { pasting = true; rest = rest.slice(rest.indexOf('\x1b[200~') + 6); }
      if (pasting) {
        const end = rest.indexOf('\x1b[201~');
        typed += end >= 0 ? rest.slice(0, end) : rest;
        if (end >= 0) pasting = false;
        return;
      }
      if (rest === '\r' && typed) {
        const prompt = typed;
        typed = '';
        if (dropping) { dropping = false; note('turn-dropped'); socket.close(); return; }
        socket.sendBytes('[pasted text]\r\n');
        setTimeout(() => { if (!socket.closed) socket.sendBytes(`\r\n${answer(held.stored, 'tui', prompt)}\r\n`); }, delay);
      }
    };
    socket.onClose = () => {
      sockets.delete(socket);
      if (held.socket !== socket) return;
      held.socket = null;
      held.reap = setTimeout(() => {
        terminals.delete(key);
        // The canary's active-session cleanup: the marker goes with the terminal that wrote it.
        if (opts.flavour === '0.22' && markers.get(held.channel) === held.stored) markers.delete(held.channel);
        note('pty-reaped', { channel: held.channel });
      }, ttl);
    };
  }

  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const forget = () => {
    for (const s of [...sockets]) s.close();
    for (const t of terminals.values()) if (t.reap) clearTimeout(t.reap);
  };
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    rows: () => [...rows.values()].map(r => ({ ...r, messages: [...r.messages] })),
    events,
    dropSockets: () => { note('drop-sockets'); for (const s of [...sockets]) s.close(); },
    restart: () => {
      note('restart');
      forget();
      tickets = new Set();
      live = new Map();
      markers = new Map();
      // The cookies stay good: they are signed with the gateway's configured secret.
      terminals = new Map();
    },
    refuseConversation: (on: boolean) => { refusing = on; },
    dropNextTurn: () => { dropping = true; },
    deleteSession: (id: string) => {
      note('deleted', { id });
      rows.delete(id);
      for (const [runtime, stored] of [...live]) if (stored === id) live.delete(runtime);
    },
    close: async () => {
      forget();
      await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
    },
  };
}
