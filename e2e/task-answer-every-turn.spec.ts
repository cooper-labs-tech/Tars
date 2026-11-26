import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Every turn's answer is kept under its task's id, a delegated task's, a queued message's and a turn the owner typed
 * alike, and the card says what the agent works on now (2.0.7; an orchestrator's reports of 19/11 on 2.0.6: task_status
 * gave a worker's task two lines of narration as its result, get_agent_output kept an older task's text, a message
 * sent with mode 'queue' was "that agent's work now" and its answer never kept, and the card showed a brief of 17/11
 * while the agent worked on other tasks).
 *
 * The first was measured on the owner's ledger: 27 of 496 delegated claude tasks of three weeks kept a shorter answer
 * than their transcript holds now, read 31 to 634 ms after their turn's end. Claude Code writes the final message to
 * its transcript after its Stop: in the reported task, the report is stamped .590, its Stop reached Tars at .647, the
 * answer was read at .788, and the report was not on disk yet.
 *
 * A sandbox HOME with one project, its orchestrator "Lead" (no CLI: its own token makes the calls) and a worker whose
 * CLI is a stand-in named `claude`, which runs Tars's own hook scripts and writes its transcript where Claude Code
 * does, with the stop reason Claude Code gives each message.
 * - The lead delegates `LATE>>` (run-task): the worker writes two lines of narration, its Stop runs, and only then,
 *   1.5 s later, its report reaches the transcript, stamped before the Stop, as Claude Code's write queue does.
 * - While it works, the lead sends `QUEUED>>` with mode 'queue' (dispatch): it waits its turn, goes in, and answers.
 * - Then the owner types `OWNER>> ...` into the worker's terminal from the window (agent:input), and it answers.
 * Asserted:
 * 1. the delegated task's result is its report, not its narration (red on the 2.0.7 train: the narration);
 * 2. the queued message's id reads as a task that completed, with its own answer (red: `delivered`, no answer);
 * 3. once the queued message's turn has begun, the card's current task is that message, not the brief the session
 *    started on (red: the brief);
 * 4. the worker's last answer, what get_agent_output reads without a task id, is the owner's turn's (red: the
 *    delegated task's narration), and each earlier answer is still its own task's.
 * The artefact: values.json (each read as made, the prompts the stand-in got).
 */

const HOOKS = path.resolve('hooks');
const REPORT = `## Report\n\nThe migration is written and reversible, and both queries have their index. ${'Detail. '.repeat(40)}`;

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
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o, at) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: at || new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, prompt: launchPrompt });

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  let n = 0;
  const message = (text, stop) => ({ type: 'assistant', message: { id: 'msg-' + sid + '-' + (++n) + '-' + Date.now(), role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } });
  const says = (text, stop = 'tool_use') => line(message(text, stop));
  let last = 'done';
  let late = null;
  if (prompt.includes('LATE>>')) {
    // Narration between tool calls, then the report, stamped now and written after the Stop.
    says('Let me read the schema first.');
    await sleep(300);
    says('Now writing the migration.');
    await sleep(2500);
    late = { record: message(REPORT, 'end_turn'), at: new Date().toISOString() };
    last = REPORT;
  } else if (prompt.includes('QUEUED>>')) {
    says('The queued answer.', 'end_turn');
    last = 'The queued answer.';
  } else if (prompt.includes('OWNER>>')) {
    says('The owner answer.', 'end_turn');
    last = 'The owner answer.';
  } else {
    says('done', 'end_turn');
  }
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: last });
  if (late) {
    await sleep(1500);
    line(late.record, late.at);
  }
  line({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
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
type Task = { id: string; outcome: string; result?: string };
type Worker = { status: string; currentTask?: string; lastAnswer?: { taskId: string; result: string } };

test.skip(process.platform === 'win32', 'the stand-in runs Tars\'s bash hooks; the reader is platform-free and its unit tests run everywhere');

for (const newInterface of [false, true]) {
  test(`every turn keeps its own answer, and the card says the task in hand${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-every-answer-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(bin, 'claude');
    fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst REPORT = ${JSON.stringify(REPORT)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role = 'worker') => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('w', 'Worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31532 + (newInterface ? 1 : 0));
    const dist = path.resolve('electron', 'dist');
    const seen: Record<string, unknown> = { newInterface };
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      const token = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        return req(`${dist}/core/agent-tokens.js`).mintAgentToken('lead') as string;
      }, { dist });
      const api = async (method: string, route: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return await res.json() as Record<string, unknown>;
      };
      const until = async <T>(what: string, read: () => Promise<T | undefined>, ms = 60_000): Promise<T> => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
          const got = await read();
          if (got !== undefined) return got;
        }
        throw new Error(`never: ${what}`);
      };
      const ended = async (ref: string) => {
        let task: Task | undefined;
        for (const end = Date.now() + 120_000; Date.now() < end;) {
          task = (await api('GET', `/api/tasks/${ref}?wait=20`)).task as Task | undefined;
          if (task && !['queued', 'starting', 'running'].includes(task.outcome)) return task;
        }
        return task;
      };
      const prompts = () => lines(path.join(home, 'prompts.jsonl')) as Array<{ prompt: string }>;

      // 1. Delegated: the session starts on it, and its report reaches the transcript after its Stop.
      const late = await api('POST', '/api/agents/w/run-task', { task: 'LATE>> write the migration', answer: 'started' });
      seen.late = late;
      await until('the delegated turn began', async () => (prompts().some((p) => p.prompt.includes('LATE>>')) ? true : undefined));
      // 2. A message sent to wait for the worker's rest, as send_message with mode 'queue' sends it.
      const queued = await api('POST', '/api/agents/w/dispatch', { message: 'QUEUED>> and the index on orders', mode: 'queue' });
      seen.queued = queued;
      expect(queued.queued, JSON.stringify(queued)).toBe(true);
      const lateTask = await ended(String(late.taskId));
      seen.lateTask = lateTask;

      // 3. The card, once the queued message's turn has begun in the session the brief started.
      await until('the queued turn began', async () => (prompts().some((p) => p.prompt.includes('QUEUED>>')) ? true : undefined));
      const queuedTask = await ended(String(queued.queuedTask));
      seen.queuedTask = queuedTask;
      const card = (await api('GET', '/api/agents/w')).agent as Worker;
      seen.cardAfterQueued = { status: card.status, currentTask: card.currentTask };

      // 4. The owner types a line into the worker's terminal from the window, key by key.
      await page.evaluate(async () => {
        const send = (input: string) => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } })
          .electronAPI.agent.sendInput({ id: 'w', input });
        for (const ch of 'OWNER>> one more check') await send(ch);
        await send('\r');
      });
      await until('the owner\'s turn began', async () => (prompts().some((p) => p.prompt.includes('OWNER>>')) ? true : undefined));
      const worker = await until('the owner\'s turn kept its answer', async () => {
        const w = (await api('GET', '/api/agents/w')).agent as Worker;
        return w.lastAnswer?.result === 'The owner answer.' ? w : undefined;
      }, 30_000).catch(async () => (await api('GET', '/api/agents/w')).agent as Worker);
      const lateAgain = (await api('GET', `/api/tasks/${String(late.taskId)}`)).task as Task;
      const queuedAgain = (await api('GET', `/api/tasks/${String(queued.queuedTask)}`)).task as Task;
      Object.assign(seen, { lastAnswer: worker.lastAnswer, lateAgain, queuedAgain, prompts: prompts() });

      expect.soft(lateTask?.outcome).toBe('completed');
      expect.soft(lateTask?.result).toBe(REPORT);
      expect.soft(queuedTask?.outcome).toBe('completed');
      expect.soft(queuedTask?.result).toBe('The queued answer.');
      expect.soft(card.currentTask ?? '').toContain('QUEUED>>');
      expect.soft(worker.lastAnswer?.result).toBe('The owner answer.');
      expect.soft(worker.lastAnswer?.taskId).not.toBe(lateTask?.id);
      expect.soft(lateAgain.result).toBe(REPORT);
      expect.soft(queuedAgain.result).toBe('The queued answer.');
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
