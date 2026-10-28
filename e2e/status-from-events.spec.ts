import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's status is what its CLI says, and the sleep acts on it (the DB brief of 28/10, item B of the
 * resources plan), in the real app.
 *
 * Measured on 28/10 with Tars 2.0.4 and 19 live agents (reports/db-status-and-sleep-2810.md):
 * - Kotsna-QA's Stop reached Tars at 19:23:30.659Z, Tars typed the next queued task in the same millisecond and
 *   read it `running`; the CLI never took it (no UserPromptSubmit, nothing in its transcript). Tars showed it
 *   running at its prompt for 42 minutes and its six queued tasks waited for an end of turn that had come.
 * - Parallel-Frontend's claude exited mid-turn on 25/10 23:24:26Z (no Stop; SessionEnd's post never landed) and
 *   left its shell in the terminal: Tars read it `running` for two days.
 * - agents.json writes every `running` agent as `idle` with the running's own statusSince: 15 of 19 working
 *   agents read idle there, and an orchestrator nearly stopped them on it.
 * - The turns task notifications start do send UserPromptSubmit (114 of 116 on 25 to 27/10); what goes missing
 *   is a post, and then nothing reads the CLI's own record of the turn, its transcript.
 *
 * The ways this can fail, each driven below:
 * F1 a turn the CLI started on its own (a background task's notification), whose start post never reached Tars,
 *    reads `idle` while the transcript records it working;
 * F2 a message Tars typed that the CLI never took leaves the agent `running` at its prompt, for good, and whoever
 *    sent it is never told it did not run (or is told it finished, or the session's next turn of its own is
 *    reported to it as that task's end);
 * F3 a CLI that died mid-turn and left its shell reads `running` with no CLI, for good;
 * F4 a working agent reads `idle` in agents.json;
 * F5 an agent at rest past the (shortened) delay is not put to sleep, or a working one is;
 * F6 why the sleep pass left an agent awake is computed and thrown away: nothing the window or the Audit can read;
 * F7 (regression net) a plain turn, whose hooks all land, no longer reads running then idle.
 *
 * The CLIs are stand-ins named `claude` (node scripts, as an npm install of Claude Code is) that run Tars's own
 * hook scripts with the JSON Claude Code gives them and keep a transcript where and as Claude Code keeps it: a
 * user entry for a prompt, assistant entries while it works, and `system`/`turn_duration` once the turn ended.
 */

type SleepHeld = { why: string; at: string };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string; sleepHeld?: SleepHeld };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  list(): Promise<Agent[]>;
  get(id: string): Promise<Agent>;
  sendInput(p: { id: string; input: string }): Promise<{ success: boolean }>;
} } };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
record('launches.jsonl', { pid: process.pid, sid });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id }, body: JSON.stringify(body),
});
const said = (text) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const ended = () => { hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' }); line({ type: 'system', subtype: 'turn_duration', durationMs: 1 }); };
/** Working for ms: an assistant entry every 300 ms, as a turn's tool calls and answers are. */
const work = async (ms) => { for (const end = Date.now() + ms; Date.now() < end;) { said('working'); await sleep(300); } };

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  // A message the CLI never takes (F2): typed into its field, no turn, nothing written.
  if (prompt.includes('LOST>>')) return;
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  // The lead, told to, sends the worker a message the worker's CLI will not take, as send_message does.
  if (prompt.includes('TELL>>')) {
    const answer = await api('/api/agents/' + prompt.split('TELL>>')[1].trim() + '/message', { message: 'LOST>> the docs are yours' });
    record('calls.jsonl', { status: answer.status, body: await answer.json() });
  }
  // A long turn (F5's working agent).
  if (prompt.includes('WORK>>')) await work(Number(prompt.split('WORK>>')[1]) || 1000);
  // The CLI dies mid-turn (F3): no Stop, no SessionEnd, the shell it was typed into stays.
  if (prompt.includes('CRASH>>')) { said('working'); process.exit(1); }
  said('done');
  await sleep(200);
  ended();
  // A background task this turn started ends after it, and its notification starts a turn of its own (F1); that
  // turn's UserPromptSubmit post never reaches Tars (here: never made), as a post lost under load.
  if (prompt.includes('NOTE>>')) {
    await sleep(1500);
    line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' } });
    record('notified.jsonl', { sid });
    await work(Number(prompt.split('NOTE>>')[1]) || 8000);
    said('done');
    ended();
    record('notified-done.jsonl', { sid });
  }
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test.skip(process.platform === 'win32', 'the stand-ins are typed into a POSIX shell and the sleep pass reads ps, which Windows has none of (agent-sleep.ts); on Windows the terminal is the CLI, so a CLI that dies ends its terminal (F3 is the PTY exit there). The status rules themselves read the transcript and are platform-free: __tests__/electron/services/status-truth.test.ts runs them everywhere');

// Both shells, the classic one and the new interface (JeanBrasse's rule of 16/10).
for (const newInterface of [false, true]) {
test(`the status follows the CLI's own record, and the sleep acts on it${newInterface ? ' (new interface)' : ''}`, async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-status-${newInterface ? 'ni' : 'classic'}-`));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
  });
  const ids = ['lead', 'noted', 'lost', 'crashed', 'worker', 'resting'];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', 'orchestrator'), agent('noted', 'Noted Worker'), agent('lost', 'Lost Message Worker'),
    agent('crashed', 'Crashed Worker'), agent('worker', 'Busy Worker'), agent('resting', 'Resting Worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
  const port = apiPort(31506 + (newInterface ? 1 : 0));
  // The status pass every 500 ms (its grace is four passes: 2 s), the sleep after 45 s of rest: every scenario below
  // starts within the first seconds, so none of their agents can fall asleep before its own check.
  const SLEEP_AFTER_MS = 45_000;

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_STATUS_EVERY_MS: '500', DOROTHY_SLEEP_AFTER_MS: String(SLEEP_AFTER_MS) },
  });
  // The main process's log, the `[status]`, `[sleep]` and `[hooks]` lines among it, kept with the run.
  const mainLog = fs.createWriteStream(test.info().outputPath('main.log'));
  app.process().stdout?.on('data', (d) => mainLog.write(d));
  app.process().stderr?.on('data', (d) => mainLog.write(d));
  const seen: Record<string, unknown> = { newInterface };
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
    const type = (id: string, input: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.sendInput(p), { id, input });
    const saved = () => Object.fromEntries((JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).agents as Agent[]).map((a) => [a.id, a.status]));
    const facts = async (id: string) => {
      const a = await get(id) as Agent & Record<string, unknown>;
      return Object.fromEntries(['status', 'statusSince', 'lastTurnStartedAt', 'workHandedAt', 'currentSessionId', 'cliRunning', 'statusReconciled', 'sleepHeld', 'asleepSince'].map((k) => [k, a[k]]));
    };

    for (const id of ids) await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(ids.length);

    // Each failure is checked softly, so a run on the old build says which of them it shows, not only the first.
    const soft = expect.soft;
    const prompted = (id: string, word: string) => expect.poll(() => lines(path.join(home, 'prompts.jsonl')).some((p) => p.id === id && p.prompt.includes(word)), { timeout: 30_000 }).toBe(true);

    // Every scenario starts now, side by side.
    await type('worker', 'WORK>>150000\r');
    await type('crashed', 'CRASH>> now\r');
    await type('noted', 'run it in the background NOTE>>20000\r');
    for (const id of ['resting', 'lost']) await type(id, 'hello\r');

    // ── F7: a plain turn reads running, then idle ──
    for (const id of ['resting', 'lost']) {
      await prompted(id, 'hello');
      await expect.poll(async () => (await get(id)).status, { timeout: 20_000 }).toBe('idle');
    }

    // ── F1: a turn a task notification started, its start post lost ──
    await expect.poll(() => lines(path.join(home, 'notified.jsonl')).length, { timeout: 30_000 }).toBe(1);
    await soft.poll(async () => (await get('noted')).status, { timeout: 8_000, message: 'F1: the notification\'s turn reads running' }).toBe('running');
    seen.notedDuringItsTurn = await facts('noted');
    await expect.poll(() => lines(path.join(home, 'notified-done.jsonl')).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await get('noted')).status, { timeout: 10_000, message: 'idle once its Stop came' }).toBe('idle');

    // ── F2: a message Tars typed that the CLI never took ──
    await type('lead', 'TELL>> lost\r');
    await expect.poll(() => lines(path.join(home, 'calls.jsonl')).length, { timeout: 30_000 }).toBe(1);
    await prompted('lost', 'LOST>>');
    seen.lostRightAfter = await facts('lost');
    // Ten minutes in production (twenty passes), 10 s here: a slow UserPromptSubmit is not a message never taken.
    await soft.poll(async () => (await get('lost')).status, { timeout: 25_000, message: 'F2: back at its prompt, it reads idle' }).toBe('idle');
    seen.lost = await facts('lost');
    // Its sender, the lead, is told it never ran, and never that it finished.
    const toLead = () => lines(path.join(home, 'prompts.jsonl')).filter((p) => p.id === 'lead').map((p) => String(p.prompt));
    await soft.poll(() => toLead().some((p) => /Lost Message Worker.*never ran what you asked of it/.test(p)), { timeout: 15_000, message: 'F2: the sender is told it never ran' }).toBe(true);
    seen.toLead = toLead();
    soft(toLead().some((p) => /Lost Message Worker.*has finished its turn/.test(p)), 'F2: never told it finished').toBe(false);
    // A later turn of the same session, of its own (the owner types in it), is no end of that task: the note spent
    // the link (the Audit's M1 on #524).
    await type('lost', 'carry on\r');
    await prompted('lost', 'carry on');
    await expect.poll(async () => (await get('lost')).status, { timeout: 20_000 }).toBe('idle');
    await new Promise((r) => setTimeout(r, 3_000));
    seen.toLeadAfterOwnTurn = toLead();
    soft(toLead().some((p) => /Lost Message Worker.*has finished its turn/.test(p)), 'F2: its next turn is not reported as the task\'s end').toBe(false);

    // ── F3: a CLI that died mid-turn and left its shell ──
    await prompted('crashed', 'CRASH>>');
    await expect.poll(async () => (await get('crashed')).cliRunning, { timeout: 20_000 }).toBe(false);
    await soft.poll(async () => (await get('crashed')).status, { timeout: 15_000, message: 'F3: no running without a CLI' }).not.toBe('running');
    seen.crashed = await facts('crashed');

    // ── F4: a working agent reads running, on disk too (agents.json is written within 30 s of a change) ──
    expect((await get('worker')).status).toBe('running');
    await soft.poll(() => saved().worker, { timeout: 45_000, message: 'F4: agents.json says running' }).toBe('running');

    // ── F5 and F6: the resting agent sleeps past the delay; the working one never does, and says why ──
    await soft.poll(async () => (await get('resting')).status, { timeout: SLEEP_AFTER_MS * 2, message: 'F5: at rest past the delay, it sleeps' }).toBe('asleep');
    seen.resting = await facts('resting');
    const working = await get('worker');
    seen.worker = await facts('worker');
    expect(working.status, 'F5: a working agent is never put to sleep').toBe('running');
    soft(working.sleepHeld?.why, 'F6: why it stays awake can be read').toBe('not-at-rest');
    // F2's agent was never working: at rest past the delay, it sleeps too (its sender was told to ask again).
    await soft.poll(async () => (await get('lost')).status, { timeout: SLEEP_AFTER_MS * 2, message: 'F5: the agent F2 left at its prompt sleeps' }).toBe('asleep');
    seen.lostLater = await facts('lost');
    // The orchestrator never sleeps, and says so; the CLI that died is no CLI.
    const lead = await get('lead');
    seen.lead = await facts('lead');
    expect(lead.status).not.toBe('asleep');
    soft(lead.sleepHeld?.why, 'F6: an orchestrator says why').toBe('orchestrator');
    soft((await get('crashed')).sleepHeld?.why, 'F6: no CLI to put to sleep').toBe('no-cli');
    seen.final = Object.fromEntries((await list()).map((a) => [a.id, { status: a.status, sleepHeld: a.sleepHeld }]));
    seen.saved = saved();
  } finally {
    recordValues(seen);
    await app.close().catch(() => { /* gone */ });
    mainLog.end();
  }
});
}
