import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * permission-request.sh says what the dialog asks, not only that there is one
 * (AgentStatus.waitingOn, #159: "allow npx playwright test?").
 *
 * How it fails, written before the code (2026-09-24):
 * 1. It posts `waiting_reason: permission` and nothing else, so Tars cannot
 *    say what the agent waits on.
 * 2. It builds the JSON by pasting shell strings into it: a command with a
 *    quote or a newline breaks the body, and the status post is lost with it.
 * 3. A question (AskUserQuestion, which reaches this hook too: 24 times in
 *    the hooks log on 2026-09-24) goes up without its question.
 */

const HOOK = path.join(__dirname, '../../hooks/permission-request.sh');
const received: Array<{ url: string; body: Record<string, unknown> }> = [];
let server: http.Server;
let port = 0;
/** Made in beforeAll, so a file whose tests all skip makes nothing it would not remove. */
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-permission-hook-'));
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

async function ask(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  const post = received.find(r => r.url === '/api/hooks/status');
  expect(post, 'the hook posted no status').toBeTruthy();
  return post!.body;
}

describe.skipIf(shHooksNotShipped())('permission-request.sh, with a large input (the gate of #172)', () => {
  // The whole tool_input went to curl as one argument: a Write of 1.5 MB never
  // reached Tars (argument list too long: macOS takes about 1 MB, Linux 128 KB
  // for one argument), and the agent stayed running with no dialog recorded.
  it('reaches Tars with a 2 MB Write, keeping only what names the dialog, and not the content', async () => {
    const body = await ask({
      session_id: 's1', tool_name: 'Write',
      tool_input: { file_path: '/repo/big.txt', content: 'x'.repeat(2 * 1024 * 1024) },
    });

    expect(body).toMatchObject({ status: 'waiting', waiting_reason: 'permission', tool_name: 'Write' });
    expect((body.tool_input as { file_path: string }).file_path).toBe('/repo/big.txt');
    expect((body.tool_input as { content?: string }).content).toBeUndefined();
    expect(JSON.stringify(body).length).toBeLessThan(16 * 1024);
  });

  it('cuts a very long command, and keeps a question\'s words', async () => {
    const long = await ask({ session_id: 's1', tool_name: 'Bash', tool_input: { command: `echo ${'y'.repeat(300 * 1024)}` } });
    const command = (long.tool_input as { command: string }).command;
    expect(command.startsWith('echo yyy')).toBe(true);
    expect(command.length).toBeLessThanOrEqual(1000);

    const q = await ask({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which port?', options: [{ label: 'a'.repeat(5000) }] }] } });
    expect((q.tool_input as { questions: Array<{ question: string; options?: unknown }> }).questions).toEqual([{ question: 'Which port?' }]);
  });
});

describe.skipIf(shHooksNotShipped())('permission-request.sh', () => {
  it('sends the tool and its input with the waiting status', async () => {
    const body = await ask({
      session_id: 's1', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
      tool_input: { command: 'npx playwright test', description: 'Run the suite' },
    });

    expect(body).toMatchObject({ agent_id: 'a1', session_id: 's1', status: 'waiting', waiting_reason: 'permission' });
    expect(body.tool_name).toBe('Bash');
    // Only what names the dialog: the rest of a tool's input can be a whole file.
    expect(body.tool_input).toEqual({ command: 'npx playwright test' });
  });

  it('keeps quotes and line breaks in the input without breaking the post', async () => {
    const command = 'git commit -m "a \\"quoted\\" line"\necho \'done\'';
    const body = await ask({ session_id: 's1', tool_name: 'Bash', tool_input: { command } });

    expect(body.status).toBe('waiting');
    expect((body.tool_input as { command: string }).command).toBe(command);
  });

  it('sends a question with its question', async () => {
    const body = await ask({
      session_id: 's1', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which port should the sandbox use?', header: 'Port', options: [] }] },
    });

    expect(body.tool_name).toBe('AskUserQuestion');
    expect((body.tool_input as { questions: Array<{ question: string }> }).questions[0].question)
      .toBe('Which port should the sandbox use?');
  });
});
