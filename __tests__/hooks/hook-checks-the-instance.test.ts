import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * A hook sends its terminal's token only to the Tars that spawned its CLI
 * (the Audit's table on a3d7c125, #11).
 *
 * A hook posts to 127.0.0.1:31415 with the token of its terminal. When Tars is
 * down, or restarting, whatever holds that port gets the token: any process of
 * any account on the machine may listen there. So Tars mints an instance id
 * per run, hands it to each CLI in its environment beside the token
 * (TARS_INSTANCE_ID), and the hook first asks the port to prove it knows it:
 * it sends a fresh random challenge to /api/health, and only sends its token
 * when the answer is sha256("<instance id>:<challenge>").
 *
 * How it fails, written before the code (2026-09-24):
 * 1. Something other than Tars holds the port and answers /api/health: the
 *    token goes to it anyway.
 * 2. It answers with a proof it saw earlier, replayed: the challenge must be
 *    new each time, and an old proof refused.
 * 3. Nothing answers, or the answer never ends: the hook hangs, or sends the
 *    token blind.
 * 4. A CLI with no instance id in its environment (started outside Tars, or by
 *    a Tars from before this) sends a token it may hold to whoever answers.
 * 5. Over-correction: the Tars that spawned the CLI stops getting the token,
 *    and every status of its agents freezes.
 * 6. The instance id itself travels: in a request the hook makes, or in the
 *    server's answer, where anyone could read it and prove to be Tars later.
 * 7. (the Audit's gate of #212) The check gives up sooner than the posts do:
 *    it waited 2 s and a post waits 3 s, so a Tars whose main thread was held
 *    2.5 s (a transcript scan takes 2.7 s, the Usage page 4.15 s) lost the
 *    token, and the post was refused: a Stop lost, the agent left running.
 *    The check waits 5 s, longer than any post: held up to that, Tars still
 *    gets its token, where a post without the check would have given up.
 *
 * The real hook scripts and their helper, with only the port pointed at a
 * server here that plays Tars, or plays the squatter.
 */

const HOOKS = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-instance-'));
const home = path.join(tmp, 'home');
const INSTANCE = crypto.randomBytes(16).toString('hex');
const TOKEN = 'token-of-a1s-terminal';

type Mode = 'tars' | 'squatter' | 'replay' | 'silent' | 'held';
/** How long a held Tars takes to answer the check. */
let heldMs = 0;
let mode: Mode = 'tars';
let seenProof: string | undefined;
const received: { path: string; authorization?: string; url: string }[] = [];
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
        if (mode === 'silent') return; // never answers
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
  for (const name of ['user-prompt-submit.sh', 'tars-hook.sh']) {
    const original = fs.readFileSync(path.join(HOOKS, name), 'utf-8');
    fs.writeFileSync(path.join(tmp, name), original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`), { mode: 0o755 });
  }
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { received.length = 0; });

function runHook(env: Record<string, string>): Promise<{ code: number; ms: number }> {
  const began = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(tmp, 'user-prompt-submit.sh')], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, ms: Date.now() - began }));
    child.stdin.end(JSON.stringify({ session_id: '5b0c6a1e-7d7f-4c1e-9b1a-2f3c4d5e6f70', prompt: 'rebase onto main' }));
  });
}
const withToken = () => received.filter(r => r.authorization && r.authorization !== 'Bearer ');
const env = { CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: TOKEN, TARS_INSTANCE_ID: INSTANCE };

// The Node runner's side of the same list: node-hook-checks-the-instance.test.ts.
describe.skipIf(shHooksNotShipped())('a hook, before it sends its token', () => {
  it('5. sends it to the Tars that spawned its CLI', async () => {
    mode = 'tars';
    await runHook(env);

    const posts = received.filter(r => r.path.startsWith('/api/hooks/'));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.authorization).toBe(`Bearer ${TOKEN}`);
  }, 30_000);

  it.each([2_500, 4_500])('7. still sends it to Tars when its main thread is held %i ms', async held => {
    mode = 'held';
    heldMs = held;
    await runHook(env);

    const posts = received.filter(r => r.path.startsWith('/api/hooks/'));
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.authorization, 'the check gave up first').toBe(`Bearer ${TOKEN}`);
  }, 30_000);

  it('1. sends it to nothing else that holds the port', async () => {
    mode = 'squatter';
    await runHook(env);

    expect(received.some(r => r.path === '/api/health'), 'no check was made').toBe(true);
    expect(withToken(), 'the token went to the squatter').toEqual([]);
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
    expect(challenges.every(c => c && /^[0-9a-f]{32,64}$/.test(c))).toBe(true);
  }, 30_000);

  it('3. neither hangs nor sends it blind when the port answers nothing', async () => {
    mode = 'silent';
    const { ms } = await runHook(env);

    expect(withToken()).toEqual([]);
    expect(ms, 'the hook hung on the check').toBeLessThan(15_000);
  }, 30_000);

  it('4. sends none when its CLI was given no instance id', async () => {
    mode = 'tars';
    await runHook({ CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_TOKEN: TOKEN });

    expect(withToken()).toEqual([]);
  }, 30_000);

  it('6. never sends the instance id itself', async () => {
    mode = 'tars';
    await runHook(env);

    for (const r of received) expect(r.url, r.path).not.toContain(INSTANCE);
  }, 30_000);
});
