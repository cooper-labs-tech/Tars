import '../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shHooksNotShipped } from '../setup/platform-limits';

/**
 * on-stop.sh tells Tars what the agent left waiting at its rest (QA's gate of #322). Claude Code 2.1.289 hands the
 * Stop hook `session_crons` (a ScheduleWakeup of /loop, a CronCreate) and `background_tasks` (a background Agent,
 * a background Bash). Both live inside the CLI: no process shows a timer, and a background agent shows none on
 * Linux. An agent waiting on one was put to sleep after 30 minutes, its CLI ended, and the timer died with it.
 *
 * How it fails, written before the code:
 * 1. The idle post says nothing of them, so Tars cannot know.
 * 2. A finished background task is counted as waiting, and the agent never sleeps.
 * 3. A Stop hook from a claude that sends neither field is read as "nothing waits", where nothing is known.
 */

const HOOK = path.join(__dirname, '../../hooks/on-stop.sh');
const received: Array<Record<string, unknown>> = [];
let server: http.Server;
let port = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-on-stop-pending-'));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { if (req.url === '/api/hooks/status') received.push(JSON.parse(raw)); res.end('{}'); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

async function stop(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  received.length = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [HOOK], { env: { ...process.env, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_AGENT_ID: 'a1', HOME: tmp } });
    child.stdout.resume(); child.stderr.resume();
    child.on('error', reject); child.on('exit', () => resolve());
    child.stdin.end(JSON.stringify({ session_id: 's1', stop_hook_active: false, last_assistant_message: 'done', ...input }));
  });
  expect(received).toHaveLength(1);
  return received[0];
}

describe.skipIf(shHooksNotShipped())('on-stop.sh', () => {
  it('1. counts the crons and the background tasks still running at the rest', async () => {
    const post = await stop({
      session_crons: [{ id: 'loop1', schedule: '0 * * * *', recurring: false, prompt: '/loop watch the CI' }],
      background_tasks: [
        { id: 'a1b2', type: 'local_agent', status: 'running', description: 'audit the docs' },
        { id: 'b3', type: 'local_bash', status: 'pending' },
      ],
    });
    expect(post).toMatchObject({ status: 'idle', pending: { crons: 1, background: 2 } });
  });

  it('2. leaves out the background tasks that are over', async () => {
    const post = await stop({
      session_crons: [],
      background_tasks: ['completed', 'failed', 'killed', 'stopped', 'error'].map((status, i) => ({ id: `t${i}`, status })),
    });
    expect(post).toMatchObject({ status: 'idle', pending: { crons: 0, background: 0 } });
  });

  it('3. says nothing of them when the CLI sent neither field, or not as lists', async () => {
    expect(await stop({})).not.toHaveProperty('pending');
    expect(await stop({ session_crons: 'x', background_tasks: { a: 1 } })).not.toHaveProperty('pending');
  });
});
