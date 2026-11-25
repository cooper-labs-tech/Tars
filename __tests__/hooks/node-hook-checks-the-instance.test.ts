import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Node hook runner (what Windows runs for the .sh hooks) sends its
 * terminal's token on the hook posts only to the Tars that spawned its CLI,
 * as tars-hook.sh does since upstream #212 (hook-checks-the-instance.test.ts
 * holds the .sh, which Windows does not wire). The same check: a fresh random challenge to /api/health, and the
 * token only when the answer is sha256("<TARS_INSTANCE_ID>:<challenge>").
 *
 * How it fails, the .sh test's list, asserted here on the runner, written before
 * the runner had the check (2026-09-28):
 * 1. Something other than Tars holds the port and answers /api/health: the
 *    token goes to it anyway.
 * 2. It answers with a proof it saw earlier, replayed: the challenge must be
 *    new each time, and an old proof refused.
 * 3. Nothing answers, or the answer never ends: the hook hangs, or sends the
 *    token blind.
 * 4. A CLI with no instance id in its environment sends a token it may hold
 *    to whoever answers.
 * 5. Over-correction: the Tars that spawned the CLI stops getting the token.
 * 6. The instance id itself travels, in a request the hook makes.
 * 7. The check gives up sooner than the posts do (5 s, longer than any post's
 *    3 s): a Tars whose main thread is held 2.5 or 4.5 s loses the token.
 * 8. Where the .sh sends no Authorization header at all (tars_auth prints
 *    nothing), the runner sends `Bearer ` with an empty token: a post the
 *    server reads differently from the .sh's.
 */

const RUNNER = path.join(__dirname, '../../hooks/tars-hook.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-node-hook-instance-'));
const home = path.join(tmp, 'home');
const INSTANCE = crypto.randomBytes(16).toString('hex');
const TOKEN = 'token-of-a1s-terminal';

type Mode = 'tars' | 'squatter' | 'replay' | 'silent' | 'held';
let heldMs = 0;
let mode: Mode = 'tars';
let seenProof: string | undefined;
const received: { path: string; authorization?: string; url: string }[] = [];
const hung: http.ServerResponse[] = [];
let server: http.Server;
let port: number;

const proofFor = (instance: string, challenge: string) =>
  crypto.createHash('sha256').update(`${instance}:${challenge}`).digest('hex');

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    received.push({ path: url.pathname, authorization: req.headers.authorization, url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      if (url.pathname === '/api/health') {
        const challenge = url.searchParams.get('challenge') ?? '';
        if (mode === 'silent') { hung.push(res); return; }
        if (mode === 'held') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, proof: proofFor(INSTANCE, challenge) }));
          }, heldMs);
          return;
        }
        const proof = mode === 'tars' ? proofFor(INSTANCE, challenge)
          : mode === 'replay' ? seenProof
          : proofFor('someone-else', challenge);
        if (mode === 'tars') seenProof = proof;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, proof }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  fs.mkdirSync(home, { recursive: true });
});

afterAll(async () => {
  for (const r of hung) { try { r.destroy(); } catch { /* gone */ } }
  server.closeAllConnections();
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { received.length = 0; });

/** A clean environment: nothing of the real agent this suite may run inside. */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_|DOROTHY_|GEMINI_|TARS_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, HOME: home, USERPROFILE: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, ...extra };
}

function runHook(extra: Record<string, string>): Promise<{ code: number; ms: number }> {
  const began = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, 'user-prompt-submit'], { env: hookEnv(extra), windowsHide: true });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, ms: Date.now() - began }));
    child.stdin.end(JSON.stringify({ session_id: '5b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70', prompt: 'rebase onto main' }));
  });
}
const withToken = () => received.filter(r => r.authorization && r.authorization !== 'Bearer');
const posts = () => received.filter(r => r.path.startsWith('/api/hooks/'));
const env = { CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE };

describe('the Node hook runner, before it sends its token', () => {
  it('5. sends it to the Tars that spawned its CLI', async () => {
    mode = 'tars';
    const { code } = await runHook(env);

    expect(code).toBe(0);
    expect(posts().length).toBeGreaterThan(0);
    for (const post of posts()) expect(post.authorization).toBe(`Bearer ${TOKEN}`);
  }, 30_000);

  it.each([2_500, 4_500])('7. still sends it to Tars when its main thread is held %i ms', async held => {
    mode = 'held';
    heldMs = held;
    await runHook(env);

    expect(posts().length).toBeGreaterThan(0);
    for (const post of posts()) expect(post.authorization, 'the check gave up first').toBe(`Bearer ${TOKEN}`);
  }, 30_000);

  it('1. sends it to nothing else that holds the port, and 8. sends no Authorization header', async () => {
    mode = 'squatter';
    await runHook(env);

    expect(received.some(r => r.path === '/api/health'), 'no check was made').toBe(true);
    expect(withToken(), 'the token went to the squatter').toEqual([]);
    expect(posts().length).toBeGreaterThan(0);
    for (const post of posts()) expect(post.authorization, 'tars_auth prints nothing').toBeUndefined();
  }, 30_000);

  it('2. refuses a proof replayed from an earlier check', async () => {
    mode = 'tars';
    await runHook(env);
    expect(seenProof).toBeDefined();
    received.length = 0;

    mode = 'replay';
    await runHook(env);

    expect(withToken()).toEqual([]);
    const challenges = received.filter(r => r.path === '/api/health').map(r => new URL(r.url, 'http://x').searchParams.get('challenge'));
    expect(challenges.length).toBeGreaterThan(0);
    expect(challenges.every(c => c && /^[0-9a-f]{32,64}$/.test(c))).toBe(true);
  }, 30_000);

  it('3. neither hangs nor sends it blind when the port answers nothing', async () => {
    mode = 'silent';
    const { ms, code } = await runHook(env);

    expect(code).toBe(0);
    expect(withToken()).toEqual([]);
    expect(ms, 'the hook hung on the check').toBeLessThan(15_000);
  }, 30_000);

  it('4. sends none, and asks nothing, when its CLI was given no instance id', async () => {
    mode = 'tars';
    await runHook({ CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: TOKEN });

    expect(withToken()).toEqual([]);
    expect(received.some(r => r.path === '/api/health')).toBe(false);
  }, 30_000);

  it('6. never sends the instance id itself', async () => {
    mode = 'tars';
    await runHook(env);

    expect(received.length).toBeGreaterThan(0);
    for (const r of received) expect(r.url, r.path).not.toContain(INSTANCE);
  }, 30_000);
});
