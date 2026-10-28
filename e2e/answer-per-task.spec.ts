import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each task keeps its whole answer (2.0.5; the DB brief fix-answer-per-task-2810.md, the orchestrators' feedback of
 * 28/10: task_status gave 1212's orchestrator "Saving the durable lessons to memory" where the report was), in the
 * real app.
 *
 * A sandbox HOME with one project, its orchestrator "Lead" (no CLI: its own token makes the calls) and a worker whose
 * CLI is a stand-in named `claude`, which runs Tars's own hook scripts and writes its transcript where Claude Code
 * does. The lead hands the worker two tasks at once, as delegate_task does: the first goes in, the second waits its
 * turn and goes in the moment the first ends.
 * - Task 1's turn writes a line of narration, its report, a memory note (a Write, then "Saving the durable lessons to
 *   memory."), then "Done.".
 * - Task 2's turn writes "The second answer.".
 * Asserted, by each task's id, once both ended: task 1's answer is its report, then the memory note and "Done.", and
 * not its narration; task 2's is its own; and the worker's last answer (what get_agent_output reads without a task id)
 * is task 2's, though its hooks' copy was replaced. Once with the classic interface, once with the new one. The
 * artefact: values.json (each answer as read, and the prompts the stand-in got).
 */

const HOOKS = path.resolve('hooks');
const REPORT = `## Report\n\nPR #658 updated: the migration is reversible, and both queries got their index. ${'Detail. '.repeat(60)}`;

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
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, prompt: launchPrompt });
let busy = false;

async function turn(prompt) {
  busy = true;
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  let n = 0;
  const says = (text) => line({ type: 'assistant', message: { id: 'msg-' + sid + '-' + (++n) + '-' + Date.now(), role: 'assistant', content: [{ type: 'text', text }] } });
  let last = 'done';
  // A turn that writes its report, then a memory note, then a closing line: what 1212's orchestrator met on 28/10.
  if (prompt.includes('REPORT>>')) {
    says('Let me look at the migration.');
    says(REPORT);
    line({ type: 'assistant', message: { id: 'msg-tool-' + Date.now(), role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mem', name: 'Write', input: { file_path: 'memory/MEMORY.md', content: 'x' } }] } });
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mem', content: 'ok' }] }, toolUseResult: {} });
    says('Saving the durable lessons to memory.');
    says('Done.');
    last = 'Done.';
  } else if (prompt.includes('SECOND>>')) {
    says('The second answer.');
    last = 'The second answer.';
  } else {
    says('done');
  }
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: last });
  line({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
  busy = false;
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
// A launch prompt it drops: it sits at its prompt, idle, and says so.
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) { record('typed.jsonl', { sid, busy, prompt: typed }); queue = queue.then(() => turn(typed)); }
      } else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
type Task = { id: string; outcome: string; result?: string };

test.skip(process.platform === 'win32', 'the stand-in is typed into a POSIX shell; the rule is platform-free and its unit tests run everywhere');

for (const newInterface of [false, true]) {
  test(`each task keeps its whole answer, its report and what followed it${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-answer-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(bin, 'claude');
    fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst REPORT = ${JSON.stringify(REPORT)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role = 'worker') => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('w', 'Worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31514 + (newInterface ? 1 : 0));
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
      const first = await api('POST', '/api/agents/w/run-task', { task: 'REPORT>> ship the migration', answer: 'started' });
      const second = await api('POST', '/api/agents/w/run-task', { task: 'SECOND>> and the next item', answer: 'started' });
      seen.handed = { first, second };
      const ended = async (ref: string) => {
        let task: Task | undefined;
        for (const until = Date.now() + 120_000; Date.now() < until;) {
          task = (await api('GET', `/api/tasks/${ref}?wait=20`)).task as Task | undefined;
          if (task && !['queued', 'starting', 'running'].includes(task.outcome)) return task;
        }
        return task;
      };
      const one = await ended(String(first.taskId));
      const two = await ended(String(second.taskId));
      // Asked again after both: the first's answer is still its own.
      const oneAgain = (await api('GET', `/api/tasks/${String(first.taskId)}`)).task as Task;
      const worker = (await api('GET', '/api/agents/w')).agent as { lastAnswer?: { taskId: string; result: string }; lastCleanOutput?: string };
      Object.assign(seen, { one, two, oneAgain, lastAnswer: worker.lastAnswer, lastCleanOutput: worker.lastCleanOutput, prompts: lines(path.join(home, 'prompts.jsonl')) });

      expect(one?.outcome).toBe('completed');
      expect(two?.outcome).toBe('completed');
      expect(one?.result).toBe(`${REPORT}\n\nSaving the durable lessons to memory.\n\nDone.`);
      expect(oneAgain.result).toBe(one?.result);
      expect(two?.result).toBe('The second answer.');
      expect(worker.lastAnswer?.result).toBe('The second answer.');
      expect(worker.lastAnswer?.taskId).toBe(two?.id);
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
