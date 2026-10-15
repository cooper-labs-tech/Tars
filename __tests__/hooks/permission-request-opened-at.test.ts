import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * permission-request.sh says when the dialog opened (the Audit's re-check of
 * #174). Tars took the post's arrival for that moment: a post a busy Tars
 * handled after the refusal made the refusal look older than the dialog, and
 * the agent stayed deaf until its next turn.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. The post carries no time of its own.
 * 2. The time is taken with a BSD-only or GNU-only `date` flag, and is missing
 *    or wrong on the other system (JeanBrasse: "l'app doit rester compatible linux").
 */

const HOOK = path.join(__dirname, '../../hooks/permission-request.sh');
const received: Array<Record<string, unknown>> = [];
let server: http.Server;
let port = 0;
/** Made in beforeAll, so a file whose tests all skip makes nothing it would not remove. */
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-opened-at-'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { if (req.url === '/api/hooks/status') received.push(JSON.parse(raw)); res.end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(shHooksNotShipped())('permission-request.sh', () => {
  it('1, 2. sends when the dialog opened, in milliseconds, taken by the script itself', async () => {
    received.length = 0;
    const before = Date.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/bin/bash', [HOOK], { env: { ...process.env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_AGENT_ID: 'a1', HOME: tmp } });
      child.stdout.resume(); child.stderr.resume();
      child.on('error', reject); child.on('exit', () => resolve());
      child.stdin.end(JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    });
    const after = Date.now();

    expect(received).toHaveLength(1);
    const openedAt = received[0].opened_at as number;
    expect(typeof openedAt).toBe('number');
    expect(openedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(openedAt).toBeLessThanOrEqual(after);
    expect(received[0]).toMatchObject({ status: 'waiting', waiting_reason: 'permission' });
  });
});
