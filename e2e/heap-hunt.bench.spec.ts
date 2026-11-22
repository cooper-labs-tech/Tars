import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A bench, not a test of the product (the crash of 2026-10-13 00:26): does the
 * main process's heap grow under a working fleet, and what holds it.
 *
 * Six stand-in CLIs named `claude`, three fullscreen (alternate screen, SGR
 * mouse, a redrawn frame four times a second) and three inline (colored log
 * lines, the scrollback growing), each running a turn every six seconds
 * through Tars's own hooks (prompt, two tool uses, stop) and writing its
 * transcript as Claude Code does. The window shows the Dashboard, so every
 * terminal's output reaches a panel. The main process's heap is sampled every
 * 30 s and snapshotted (v8.writeHeapSnapshot) at three points.
 * HEAP_HUNT_MINUTES sets the length (default 16).
 *
 * Out of every suite (playwright.config.ts): run on purpose with
 * `HEAP_HUNT_OUT=<dir> TARS_HEAP_BENCH=1 npx playwright test --project=bench e2e/heap-hunt.bench.spec.ts`.
 */

const HOOKS = path.resolve('hooks');
/** Where the samples and snapshots go: HEAP_HUNT_OUT, else this run's own output folder. */
const outDir = () => process.env.HEAP_HUNT_OUT ?? test.info().outputPath();
const MINUTES = Number(process.env.HEAP_HUNT_MINUTES ?? 16);
/** Megabytes each stand-in's transcript starts with, as a long Claude session's does (0: none). */
const SEED_MB = Number(process.env.HEAP_HUNT_SEED_MB ?? 0);

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const full = process.env.CLAUDE_AGENT_ID.startsWith('full');
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
fs.writeFileSync(transcript, '');
if (SEED_MB > 0) {
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(4000) } }) + '\n';
  const block = filler.repeat(256);
  const fd = fs.openSync(transcript, 'a');
  for (let written = 0; written < SEED_MB * 1e6; written += block.length) fs.writeSync(fd, block);
  fs.writeSync(fd, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'seeded' }] } }) + '\n');
  fs.closeSync(fd);
}
process.env.CLAUDE_PID = String(process.pid);
const hook = (name, payload) => new Promise((resolve) => {
  const child = spawn('/bin/bash', [path.join(HOOKS, name)], { env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('close', resolve); child.on('error', resolve);
  child.stdin.end(JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }));
});
const word = () => crypto.randomBytes(3).toString('hex');
let n = 0;
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const cols = () => process.stdout.columns || 120;
const rows = () => process.stdout.rows || 40;
function frame() {
  let s = '\x1b[H';
  for (let r = 0; r < rows() - 1; r++) {
    let l = '';
    while (l.length < cols() - 12) l += '\x1b[3' + (r % 7 + 1) + 'm' + word() + ' \x1b[0m';
    s += l.slice(0, cols() - 1) + '\x1b[K\r\n';
  }
  return s + '\x1b[J> working ' + n;
}
function logLines() {
  let s = '';
  for (let i = 0; i < 3; i++) s += '\x1b[2m' + new Date().toISOString() + '\x1b[0m \x1b[32m' + word() + '\x1b[0m ' + word().repeat(12) + '\r\n';
  return s;
}
async function turn() {
  n += 1;
  const prompt = 'task ' + n + ' ' + word();
  await hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, message: { role: 'user', content: prompt } });
  for (let i = 0; i < 2; i++) {
    await hook('post-tool-use.sh', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo ' + word() } });
    line({ type: 'assistant', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid, requestId: 'r' + n + i,
      message: { id: 'm' + n + i, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: word().repeat(80) }, { type: 'tool_use', id: 't' + n + i, name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40000, cache_creation_input_tokens: 800 } } });
  }
  await hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done ' + n });
}
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' }).then(() => {
  if (full) process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
  setInterval(() => process.stdout.write(full ? frame() : logLines()), 250);
  const loop = () => turn().then(() => setTimeout(loop, 6000));
  setTimeout(loop, 2000);
});
process.stdin.resume();
`;

test('the main process heap under a working fleet', async () => {
  test.skip(process.env.TARS_HEAP_BENCH !== '1', 'a bench: TARS_HEAP_BENCH=1 and --project=bench');
  test.setTimeout((MINUTES + 6) * 60_000);
  const OUT = outDir();
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-heap-hunt-'));
  const project = path.join(home, 'projects', 'fleet');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst SEED_MB = ${SEED_MB};\n${STAND_IN}`, { mode: 0o755 });
  const ids = ['full-1', 'full-2', 'full-3', 'inline-1', 'inline-2', 'inline-3'];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(ids.map((id) => ({
    id, name: id, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31455), DOROTHY_E2E: '1' },
  });
  const samples: Array<{ t: number; heapUsed: number; external: number; arrayBuffers: number; rss: number }> = [];
  const snapshots: string[] = [];
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    for (const id of ids) {
      await page.evaluate((agentId) => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: agentId, prompt: '' }), id);
    }
    const t0 = Date.now();
    const sample = async () => {
      const m = await app.evaluate(() => process.memoryUsage());
      samples.push({ t: Math.round((Date.now() - t0) / 1000), heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss });
      fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples, null, 1));
    };
    const snap = async (label: string) => {
      const file = path.join(OUT, `main-${label}.heapsnapshot`);
      await app.evaluate((_e, f) => (process as unknown as { mainModule: { require(m: string): { writeHeapSnapshot(f: string): string } } }).mainModule.require('v8').writeHeapSnapshot(f), file);
      snapshots.push(file);
    };
    const marks = [2, Math.round(MINUTES / 2) + 1, MINUTES];
    for (let minute = 0, s = 0; minute <= MINUTES; s += 1) {
      await sample();
      if (s % 2 === 0 && marks.includes(minute)) await snap(`${String(minute).padStart(2, '0')}m`);
      await page.waitForTimeout(30_000);
      if (s % 2 === 1) minute += 1;
    }
    recordValues({ samples, snapshots });
    expect(samples.length).toBeGreaterThan(4);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
