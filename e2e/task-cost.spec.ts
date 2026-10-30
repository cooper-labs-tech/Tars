import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What a task cost, through the whole chain in the real app (PLAN-1.9.3.md,
 * item 2): a prompt typed into the lead's window opens its task; the lead hands
 * work to a worker over the API, which opens the worker's task under the
 * lead's; each comes to rest and its task ends; usage.tasks prices both from
 * the transcripts their sessions wrote, and the lead's total holds the
 * worker's. The news of the worker's end, handed back to the lead, is a task of
 * the lead's own, handed by Tars.
 *
 * Two stand-ins named `claude` (node scripts, as an npm install of Claude Code
 * is) that do what Claude Code does around a turn and nothing else: they run
 * Tars's own hook scripts from hooks/ with the JSON Claude Code gives them
 * (SessionStart, UserPromptSubmit, Stop), and write one transcript line per
 * reply, with its usage, where Claude Code writes it. Opus is priced in the
 * sandbox's catalogue at $1 a million tokens in and $2 out, marked fresh so
 * the app does not fetch another.
 */

type Task = {
  id: string; agentId: string; source: string; requesterAgentId: string | null; parentTaskId: string | null;
  text: string; outcome: string; turns: number; sessionIds: string[]; costUSD: number | null;
  totalCostUSD: number; totalPartial: boolean; durationMs: number | null;
  tokens: { input: number; output: number } | null;
};
type Report = { tasks: Task[]; notCounted: number; averages: { byAgent: Record<string, { tasks: number; costUSD: number | null }> }; agentNames: Record<string, string> };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]>; sendInput(p: { id: string; input: string }): Promise<unknown> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<Report> };
} };

const HOOKS = path.resolve('hooks');

/** The stand-in: Claude Code's hooks around each turn, and its transcript. */
const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (line) => fs.appendFileSync(path.join(process.env.HOME, 'stand-in.log'), new Date().toISOString() + ' ' + id + ' ' + line + '\n');
// Tars's own hooks, as it installs them: the .sh under bash on macOS and Linux, their Node runner on Windows.
const hookCommand = (name) => (process.platform === 'win32'
  ? [process.execPath, [path.join(HOOKS, 'tars-hook.mjs'), name.replace(/\.sh$/, '')]]
  : ['/bin/bash', [path.join(HOOKS, name)]]);
const hook = (name, payload) => {
  const out = spawnSync(...hookCommand(name), {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }),
    env: process.env, timeout: 20000, encoding: 'utf8',
  });
  log(name + ' exit ' + out.status);
};
let n = 0;
const reply = (input, output) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', requestId: 'req_' + id + '_' + (++n), timestamp: new Date().toISOString(),
  message: { id: 'msg_' + id + '_' + n, model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output } },
}) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(prompt) {
  log('turn: ' + JSON.stringify(prompt));
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  const at = prompt.indexOf('DELEGATE>>');
  if (id === 'lead' && at !== -1) {
    reply(1000000, 0);
    const res = await fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/worker/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id },
      body: JSON.stringify({ message: prompt.slice(at + 10).trim() }),
    });
    log('message to worker: ' + res.status + ' ' + (await res.text()));
    await sleep(5000);
    reply(0, 500000);
  } else if (id === 'worker') {
    reply(3000000, 0);
    await sleep(1000);
  } else {
    reply(250000, 0);
  }
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
// A launch with a task hands it after \`--\` (promptOperand), as Claude Code takes it: its first turn.
const dashes = process.argv.indexOf('--');
if (dashes !== -1 && process.argv.slice(dashes + 1).join(' ').trim()) queue = queue.then(() => turn(process.argv.slice(dashes + 1).join(' ')));
let pasting = false;
process.stdin.on('data', (data) => {
  // Enter outside a paste ends a message: since #569 the sender line ends its own line inside its paste, as in claude.
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      // \r in raw mode; \n for what was typed before raw mode was set, which the line discipline turned into one.
      if ((ch !== '\r' && ch !== '\n') || pasting) { buffer += ch; continue; }
      const line = buffer;
      buffer = '';
      if (line.trim()) queue = queue.then(() => turn(line));
    }
  }
});
process.stdin.resume();
`;

test('a task handed on is priced under the task it was handed for, from the transcripts, through usage.tasks', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-task-cost-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // writeNodeCli: the script itself on macOS and Linux; on Windows npm's shim beside it, which Tars reads through
  // only to a .js script, hence the .cjs there.
  const cli = writeNodeCli(path.join(bin, process.platform === 'win32' ? 'claude.cjs' : 'claude'), `const HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`);
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role,
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-04T08:00:00.000Z', lastActivity: '2026-10-04T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify({
    anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  fs.writeFileSync(path.join(dir, 'model-catalog.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31496), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const tasks = () => page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));

    for (const id of ['lead', 'worker']) {
      await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    }
    // Registered: each stand-in's SessionStart reached the app.
    await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 60_000 }).toBe(2);
    expect((await tasks()).tasks).toEqual([]);

    // Typed by hand into the lead's window.
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'lead', input: 'DELEGATE>> review the build\r' }));

    // Its task, the worker's under it, and the news handed back: three tasks, all ended.
    await expect.poll(async () => {
      const r = await tasks();
      return r.tasks.length === 3 && r.tasks.every((t) => t.outcome !== 'running');
    }, { timeout: 90_000, intervals: [1000] }).toBe(true);

    const report = await tasks();
    const lead = report.tasks.find((t) => t.agentId === 'lead' && t.source === 'terminal')!;
    const worker = report.tasks.find((t) => t.agentId === 'worker')!;
    const news = report.tasks.find((t) => t.agentId === 'lead' && t.source !== 'terminal')!;
    const sessions = Object.fromEntries((await list()).map((a) => [a.id, a.currentSessionId]));
    recordValues({ report, sessions, standIn: fs.readFileSync(path.join(home, 'stand-in.log'), 'utf8').split('\n') });

    expect(lead).toMatchObject({
      text: 'DELEGATE>> review the build', outcome: 'completed', turns: 1, sessionIds: [sessions.lead],
      costUSD: 2, tokens: { input: 1_000_000, output: 500_000 }, totalCostUSD: 5, totalPartial: false,
    });
    expect(worker).toMatchObject({
      source: 'agent', requesterAgentId: 'lead', parentTaskId: lead.id, text: 'review the build',
      outcome: 'completed', sessionIds: [sessions.worker], costUSD: 3, totalCostUSD: 3,
    });
    expect(news).toMatchObject({ source: 'tars', outcome: 'completed', costUSD: 0.25, parentTaskId: null });
    expect(lead.durationMs).toBeGreaterThanOrEqual(5000);
    expect(report.notCounted).toBe(0);
    expect(report.averages.byAgent.worker).toMatchObject({ tasks: 1, costUSD: 3 });
    expect(report.agentNames).toMatchObject({ lead: 'Project Lead', worker: 'Build Worker' });

    // Kept: the ledger on disk holds them, for the next launch.
    const ledger = fs.readFileSync(path.join(dir, 'task-ledger.jsonl'), 'utf8');
    for (const t of [lead, worker, news]) expect(ledger).toContain(t.id);
    // Their text where no agent is handed it (JeanBrasse, 05/10): ~/.tars-private, the owner's alone.
    expect(ledger).not.toContain('review the build');
    const texts = path.join(home, '.tars-private', 'task-texts.jsonl');
    expect(fs.readFileSync(texts, 'utf8')).toContain('review the build');
    // POSIX mode bits, which Windows has none of (Node reads 666 there).
    if (process.platform !== 'win32') expect(fs.statSync(texts).mode & 0o777).toBe(0o600);
  } finally {
    await app.close();
  }
});
