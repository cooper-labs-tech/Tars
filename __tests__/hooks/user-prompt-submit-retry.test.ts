import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * The one post that restores a live session's ownership.
 *
 * When Tars sends a task into an already running claude, from Slack or
 * Telegram, it clears the agent's session ownership as it arms the
 * never-started-a-turn check, because that check reads "nothing has registered
 * yet". A live session never sends a second SessionStart, so the only thing
 * that gives ownership back is this hook's status post, which the server adopts
 * because it carries no `source`.
 *
 * It was one attempt, --max-time 3, no retry. Lost, and the agent is unowned
 * and then accused ten minutes later of never having started while it is
 * working: the exact error the check exists to avoid, newly created by the
 * clearing. SessionStart already retried for the same reason.
 *
 * So this runs the real script against a real server that drops the first post.
 */

const HOOK = path.join(__dirname, '../../hooks/user-prompt-submit.sh');

let server: http.Server;
let port: number;
let received: { body: string }[] = [];
/** How many posts to kill before answering. */
let dropFirst = 0;
let scriptUnderTest: string;
/** Made in beforeAll, so a file whose tests all skip makes nothing it would not remove. */
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-'));
  server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200);
      res.end('{"ok":true}');
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ body });
      if (dropFirst > 0) {
        dropFirst--;
        // Curl gets nothing at all, which is what an unreachable API looks
        // like from inside the hook: an empty RESULT.
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;

  // The real script, with only its hardcoded port pointed at this server. The
  // substitution is asserted so the test cannot silently stop testing the
  // retry it was written for.
  const original = fs.readFileSync(HOOK, 'utf-8');
  const occurrences = original.split('http://127.0.0.1:31415').length - 1;
  expect(occurrences, 'the hook no longer names the port the way this test rewrites').toBe(1);
  scriptUnderTest = path.join(tmp, 'user-prompt-submit.sh');
  fs.writeFileSync(scriptUnderTest, original.replaceAll('http://127.0.0.1:31415', `http://127.0.0.1:${port}`));
  fs.chmodSync(scriptUnderTest, 0o755);
  // Beside it, as in the app: every hook sources the helper next to it.
  fs.copyFileSync(path.join(__dirname, '../../hooks/tars-hook.sh'), path.join(tmp, 'tars-hook.sh'));
});

afterAll(async () => {
  await new Promise<void>(r => { server.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  dropFirst = 0;
});

/** Run the hook the way Claude Code does: JSON on stdin, argv empty. */
function runHook(input: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [scriptUnderTest], {
      env: { ...process.env, CLAUDE_AGENT_ID: 'a1' },
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, code: code ?? 1 }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function submitPrompt(): Promise<void> {
  await runHook(JSON.stringify({ session_id: 'session-live-1', prompt: 'rebase onto main' }));
}

describe.skipIf(shHooksNotShipped())('the status post that restores ownership', () => {
  it('gets through on the first try when the API answers', async () => {
    await submitPrompt();

    expect(received).toHaveLength(1);
    const sent = JSON.parse(received[0].body);
    expect(sent.agent_id).toBe('a1');
    expect(sent.session_id).toBe('session-live-1');
    expect(sent.status).toBe('running');
  }, 30000);

  it('is sent again when the first one is lost', async () => {
    dropFirst = 1;

    await submitPrompt();

    // Without the retry the server sees one post, and the agent stays unowned.
    expect(received).toHaveLength(2);
  }, 30000);

  it('carries the same session id on the retry, which is what ownership needs', async () => {
    dropFirst = 1;

    await submitPrompt();

    const second = JSON.parse(received[1].body);
    expect(second.session_id).toBe('session-live-1');
    expect(second.agent_id).toBe('a1');
    // And no `source`, which is what makes the server adopt it rather than
    // treat it as a fresh registration.
    expect(second.source).toBeUndefined();
  }, 30000);

  it('gives up after the retry rather than hammering', async () => {
    dropFirst = 5;

    await submitPrompt();

    expect(received).toHaveLength(2);
  }, 30000);

  it('never fails the turn, whatever the API does', async () => {
    dropFirst = 5;

    // A hook that exits non-zero blocks the prompt. Losing a status update
    // must never cost the user their turn.
    const { stdout, code } = await runHook(JSON.stringify({ session_id: 's', prompt: 'p' }));

    expect(stdout).toContain('"continue":true');
    expect(code).toBe(0);
  }, 30000);
});
