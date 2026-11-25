import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * A notification reaches Tars with the words the CLI wrote, and nothing after.
 *
 * notification.sh quoted its title and message with `echo "$X" | jq -Rs .`:
 * echo ends the text with a newline and `jq -Rs` keeps it, so every
 * notification Tars received ended in a "\n" the CLI never sent. on-stop.sh
 * has always used printf. The real script runs here and posts to a local
 * server, which keeps the body it was sent.
 */

const HOOK = path.join(__dirname, '../../hooks/notification.sh');
const received: Array<{ url: string; body: Record<string, unknown> }> = [];
let server: http.Server;
let port = 0;
/** Made in beforeAll, so a file whose tests all skip makes nothing it would not remove. */
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-notification-hook-'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received.push({ url: req.url || '', body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function notify(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  received.length = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [HOOK], {
      env: { ...process.env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_AGENT_ID: 'a1', HOME: tmp },
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
  const post = received.find(r => r.url === '/api/hooks/notification');
  expect(post, 'the hook posted no notification').toBeTruthy();
  return post!.body;
}

describe.skipIf(shHooksNotShipped())('notification.sh', () => {
  it('sends the title and the message exactly as the CLI wrote them', async () => {
    const body = await notify({
      session_id: 's1', notification_type: 'permission_prompt',
      title: 'Claude Code', message: 'Claude needs your permission to use Bash',
    });

    expect(body.title).toBe('Claude Code');
    expect(body.message).toBe('Claude needs your permission to use Bash');
  });

  it('keeps what is inside the message, line breaks and quotes included', async () => {
    const body = await notify({
      session_id: 's1', notification_type: 'idle_prompt',
      title: 'Waiting', message: 'first line\nsecond "quoted" line',
    });

    expect(body.message).toBe('first line\nsecond "quoted" line');
  });
});
