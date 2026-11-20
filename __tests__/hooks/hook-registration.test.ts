import '../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The session gets registered, whatever the API is doing.
 *
 * Losing the registration is the whole failure: with no session on the agent,
 * the ownership contract in hooks-routes.ts drops every status, output and
 * task-completed post it goes on to make, and the never-started watch accuses
 * it ten minutes later while it is working. The task ran; only its result was
 * lost, which from outside is indistinguishable from a lost order.
 *
 * Two ways to lose it were found, and the second was created by the fix for
 * the first:
 *
 *  - A probe with no read deadline. `--connect-timeout` bounds the TCP
 *    handshake only, so a socket that accepts and never answers left curl
 *    blocked with no deadline at all, and the hook was killed at its timeout
 *    before it could post.
 *  - The same probe with a read deadline. Bounded at 2s against an API that
 *    was alive but answering in 3s, the hook exited early and never posted:
 *    a blocked start traded for a silent one, which is worse.
 *
 * No deadline is right, because the failure is categorical rather than
 * proportional: one millisecond over and the work is skipped entirely. So the
 * probe is gone. The POST answers "is the API there?" by doing the work, and
 * the answer lands server-side the moment the request is received: curl giving
 * up on the response does not undo it.
 *
 * These run the real scripts against real servers behaving each way.
 */

/** The 30s Tars writes into every hook entry, in claude-provider.ts. */
const HOOK_TIMEOUT_MS = 30_000;
/** Comfortably under it, so a regression shows as a failure and not a hang. */
const MUST_RETURN_WITHIN_MS = 20_000;

/**
 * POSIX by nature: the hooks are the shell scripts Tars installs for the CLIs
 * on macOS and Linux, run here through bash and curl. On the Windows CI job
 * the file never ended (01/10, run 2, the only file of 306 that did not
 * report), and Tars does not ship for Windows.
 */
const posixDescribe = describe.skipIf(process.platform === 'win32');

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hooks-'));

/** Every hook script, including the per-provider subdirectories. */
function everyHook(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.sh')) out.push({ name: prefix + entry.name, body: fs.readFileSync(full, 'utf-8') });
    }
  };
  walk(HOOKS_DIR, '');
  return out;
}

/**
 * A server that behaves badly in one specific way, and records what it
 * actually received. Reception is the moment the real server registers the
 * session, so it is what the assertions are about, not the response.
 */
function startServer(mode: 'half-open' | { slowMs: number }): Promise<{
  port: number;
  received: string[];
  close: () => Promise<void>;
}> {
  const received: string[] = [];
  const hung: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push(req.url ?? '');
      if (mode === 'half-open') {
        // Accept, read, answer nothing, hold it open.
        hung.push(res);
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }, mode.slowMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        received,
        close: () => new Promise<void>(done => {
          for (const res of hung) { try { res.destroy(); } catch { /* gone */ } }
          server.close(() => done());
        }),
      });
    });
  });
}

/** The real script, with only its hardcoded port pointed at a test server. */
function scriptUnderTest(name: string, port: number): string {
  const original = fs.readFileSync(path.join(HOOKS_DIR, name), 'utf-8');
  const occurrences = original.split('http://127.0.0.1:31415').length - 1;
  expect(occurrences, `${name} no longer names the port the way this test rewrites`).toBeGreaterThan(0);
  const out = path.join(tmp, `${port}-${name}`);
  fs.writeFileSync(out, original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`));
  fs.chmodSync(out, 0o755);
  // Beside it, as in the app: every hook sources the helper next to it.
  fs.copyFileSync(path.join(HOOKS_DIR, 'tars-hook.sh'), path.join(tmp, 'tars-hook.sh'));
  return out;
}

/** Run a hook the way Claude Code does, and kill it where Claude Code would. */
function runHook(name: string, port: number, stdin: unknown): Promise<{ ms: number; killed: boolean }> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('/bin/bash', [scriptUnderTest(name, port)], {
      env: { ...process.env, CLAUDE_AGENT_ID: 'hook-test-agent', CLAUDE_PROJECT_PATH: tmp, HOME: tmp },
    });
    // No listener means the pipe fills and the script blocks on its own writes.
    child.stdout.resume();
    child.stderr.resume();
    const killer = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
    let settled = false;
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const ms = Date.now() - started;
      resolve({ ms, killed: ms >= HOOK_TIMEOUT_MS });
    });
    child.stdin.end(JSON.stringify(stdin));
  });
}

/** As runHook, but keeping stdout: the hook's answer to the CLI is a contract. */
function runHookCapturing(name: string, port: number, stdin: unknown): Promise<{ ms: number; out: string }> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('/bin/bash', [scriptUnderTest(name, port)], {
      env: { ...process.env, CLAUDE_AGENT_ID: 'hook-test-agent', CLAUDE_PROJECT_PATH: tmp, HOME: tmp },
    });
    let out = '';
    child.stdout.on('data', d => { out += String(d); });
    child.stderr.resume();
    child.on('exit', () => resolve({ ms: Date.now() - started, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

/** A port nothing is listening on, so every call is refused at once. */
async function deadPort(): Promise<number> {
  const api = await startServer({ slowMs: 0 });
  await api.close();
  return api.port;
}

const SESSION = { session_id: 'hook-test-session', cwd: tmp, source: 'startup', prompt: 'go' };

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

posixDescribe('an API that is alive but slow still gets the registration', () => {
  // The regression the bounded probe introduced. Well past any deadline a
  // probe could reasonably be given, and past the 3s the POST itself allows,
  // so this fails for a probe at 2s and at 5s alike.
  for (const slowMs of [3_000, 5_000, 8_000]) {
    it(`registers when /api answers in ${slowMs}ms`, async () => {
      const api = await startServer({ slowMs });
      try {
        const { ms, killed } = await runHook('session-start.sh', api.port, SESSION);

        expect(
          api.received.filter(u => u === '/api/hooks/status').length,
          'the registration POST never reached the server',
        ).toBeGreaterThan(0);
        expect(killed).toBe(false);
        expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
      } finally {
        await api.close();
      }
    }, 60_000);
  }

  it('posts the moment it is asked, rather than after the answer comes back', async () => {
    // Why removing the probe is safe: registration is an effect on receipt.
    // The server has the POST in hand long before it replies, so curl's own
    // deadline governs whether the hook hears back, not whether it happened.
    const api = await startServer({ slowMs: 8_000 });
    try {
      const started = Date.now();
      let sawPostAt = Infinity;
      const poll = setInterval(() => {
        if (api.received.includes('/api/hooks/status') && sawPostAt === Infinity) {
          sawPostAt = Date.now() - started;
        }
      }, 10);

      await runHook('session-start.sh', api.port, SESSION);
      clearInterval(poll);

      expect(sawPostAt).toBeLessThan(2_000);
    } finally {
      await api.close();
    }
  }, 60_000);
});

posixDescribe('an API that accepts and never answers does not swallow the session', () => {
  it('session-start still posts, and returns inside the hook timeout', async () => {
    const api = await startServer('half-open');
    try {
      const { ms, killed } = await runHook('session-start.sh', api.port, SESSION);

      expect(api.received).toContain('/api/hooks/status');
      expect(killed, `session-start.sh was killed at the ${HOOK_TIMEOUT_MS}ms hook timeout`).toBe(false);
      expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
    } finally {
      await api.close();
    }
  }, 60_000);

  it.each(['user-prompt-submit.sh', 'permission-request.sh', 'notification.sh', 'session-end.sh'])(
    '%s returns too, so the whole lifecycle survives it',
    async name => {
      const api = await startServer('half-open');
      try {
        const { ms, killed } = await runHook(name, api.port, SESSION);

        expect(killed).toBe(false);
        expect(ms).toBeLessThan(MUST_RETURN_WITHIN_MS);
      } finally {
        await api.close();
      }
    },
    60_000,
  );
});

posixDescribe('the properties that keep it that way', () => {
  it('gates no hook behind a check that can skip its work', () => {
    // The shape of both failures, asserted directly: an early `exit` guarded by
    // a curl means whatever that hook exists to send is conditional on a
    // request that can time out. There is no deadline that makes that safe,
    // because the cost of overrunning it is the whole post rather than a delay.
    for (const { name, body } of everyHook()) {
      const lines = body.replace(/\\\n/g, ' ').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*#/.test(line)) return;
        if (!/(^|[;&|(]|\s)curl\s+-/.test(line)) return;
        // A curl used as a condition, with the following few lines bailing out.
        if (!/^\s*if\s/.test(line)) return;
        const block = lines.slice(i, i + 5).join('\n');
        expect(
          /\bexit\s+\d/.test(block),
          `${name} decides whether to do its work from a curl that can time out: ${line.trim().slice(0, 80)}`,
        ).toBe(false);
      });
    }
  });

  it('bounds every call, in every hook, including the per-provider ones', () => {
    // The probe is where this was noticed, not where the property lives. Any
    // curl with no read deadline can hang its hook to the timeout, and the
    // ones that post are the ones carrying the session's ownership and its
    // output. Walking the tree rather than the top directory: hooks/gemini/
    // had five unbounded calls that a flat readdir never looked at.
    const hooks = everyHook();
    expect(hooks.some(h => h.name.includes('/')), 'the per-provider hooks are not being walked').toBe(true);

    for (const { name, body } of hooks) {
      // Join backslash continuations: nearly every POST here spans lines, and
      // reading them one at a time would look bounded when it is not.
      for (const call of body.replace(/\\\n/g, ' ').split('\n')) {
        // An invocation, not the word: `curl` at a command position followed
        // by a flag. Comments and the "curl result:" log lines are prose.
        if (/^\s*#/.test(call)) continue;
        if (!/(^|[;&|(]|\s)curl\s+-/.test(call)) continue;
        expect(
          call.includes('--max-time'),
          `${name} makes a curl with no read deadline: ${call.trim().slice(0, 80)}`,
        ).toBe(true);
      }
    }
  });

  it('leaves every hook a worst case that fits inside its own timeout', () => {
    // The deadlines and the timeout are one budget, and nothing linked them.
    // A hook whose calls can outlast the 30s Tars allows is killed mid-way,
    // which for session-start means the registration POST never completes and
    // the session starts unowned: the exact failure this branch closed, walked
    // back in through a value someone raised for a good local reason.
    for (const { name, body } of everyHook()) {
      const waits = [...body.matchAll(/--max-time\s+(\d+)/g)].map(m => Number(m[1]));
      const sleeps = [...body.matchAll(/^\s*sleep\s+(\d+)/gm)].map(m => Number(m[1]));
      // Every call taking its full deadline: an upper bound, since several sit
      // on branches that cannot all be taken.
      const worstMs = [...waits, ...sleeps].reduce((a, b) => a + b, 0) * 1000;

      expect(
        worstMs,
        `${name} can take ${worstMs}ms, and Tars kills it at ${HOOK_TIMEOUT_MS}ms`,
      ).toBeLessThan(HOOK_TIMEOUT_MS);
    }
  });
});


/**
 * Tars not running at all, which is the ordinary case for these scripts.
 *
 * The probe existed to make this cheap: one refused connection and the hook
 * returned. Deleting it was right, but it moved the cost from one call to
 * every call in the script, and nothing measured what that came to. Refused
 * connections are immediate, so the answer is the retry's own sleep rather
 * than any network wait, but that is a fact about the current script and not
 * a law: an added call with no deadline, or a longer backoff, lands here
 * first, on the startup path of every session the user opens.
 *
 * Measured on this machine, with nothing listening: 1.5s for session-start,
 * against the 30s Claude Code allows it. The bound below is generous enough
 * for a loaded CI box and still an order of magnitude under the timeout.
 */
const NO_API_BUDGET_MS = 8_000;

posixDescribe('an API that is not running', () => {
  const HOOKS = ['session-start.sh', 'user-prompt-submit.sh', 'notification.sh',
                 'permission-request.sh', 'session-end.sh'];

  it.each(HOOKS)('%s costs little when every call is refused', async name => {
    const port = await deadPort();

    const { ms } = await runHookCapturing(name, port, SESSION);

    expect(ms, `${name} took ${ms}ms with no API to talk to`).toBeLessThan(NO_API_BUDGET_MS);
  }, 60_000);

  it.each(HOOKS)('%s still answers the CLI in the shape it expects', async name => {
    // stdout is a contract: Claude Code parses it. A script that falls through
    // its error paths and prints a curl diagnostic, or half a JSON document,
    // is not a slow hook, it is a broken one. Nothing asserted this while the
    // probe was doing the returning.
    const port = await deadPort();

    const { out } = await runHookCapturing(name, port, SESSION);

    const text = out.trim();
    if (text === '') return;
    expect(() => JSON.parse(text), `${name} wrote non-JSON to stdout: ${text.slice(0, 120)}`).not.toThrow();
    expect(JSON.parse(text)).toHaveProperty('continue');
  }, 60_000);
});
