import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's queue you can see, pause, reorder, cancel and keep across a stop and a restart of Tars (2.0.5, lot 2,
 * item I of the resources plan; the DB brief lot2-agent-queue-2810.md), in the real app.
 *
 * What the projects' orchestrators hit on 27 and 28/10 (their tars-feedback-2810.md): six items queued to Kotsna-QA
 * that could be neither seen, cancelled nor moved (t-cf5206bb, t-23758534 ...); task_status answering "No such task"
 * for t-9aa78b94, which Tars had announced; a "priority insert" landing behind items queued earlier; stop_agent
 * emptying the queue; every task waiting its turn lost at a restart of Tars, with no list of what was lost.
 *
 * Three agents of one project: the lead (its orchestrator), the worker, and another worker. The worker is held in a
 * long turn; while it works the lead hands it a task (run-task, delegate_task's path), a message in mode 'queue', and
 * a second task, and the other worker sends it a note, which is information and no item of the queue (the Audit's
 * H-A and M1 on #449). The ways this fails, each checked on its own (soft), so a run on the old build shows each:
 * F1 the queue cannot be read, or not in order, or without each item's id, sender, time, kind and first line; a
 *    worker reading another agent's queue sees what others sent;
 * F2 paused, an item still goes in when the turn ends; or the pause cuts the turn in progress;
 * F3 a worker cancels, moves, pauses or reads what it did not send;
 * F4 an item cannot be moved to the head, or the move does not hold;
 * F5 task_status does not know a queued message's id, or a cancelled item's;
 * F6 a stop empties the queue, or does not leave it paused, or does not say so in its answer;
 * F7 a restart of Tars loses the queue, or does not keep it paused, or the orchestrator is not told what waits;
 * F8 the window cannot read or resume it (agentQueue, preload.ts and electron.d.ts);
 * F9 resumed, the items do not go in, one at a time, in the queue's order.
 *
 * The CLIs are stand-ins named `claude` (node scripts) that run Tars's own hooks and keep a transcript, take their
 * launch prompt as Claude Code does, and, told `CALL>> <method> <path> <json>`, call Tars's API with their own
 * terminal's token and record the answer.
 */

type QueueItem = { ref: string; from?: string; requesterId?: string; queuedAt: string; how: string; title: string };
type QueueView = { agentId: string; paused?: { since: string; why: string }; items: QueueItem[] };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean; currentSessionId?: string; status: string }>>; sendInput(p: { id: string; input: string }): Promise<unknown> };
  agentQueue?: { get(id: string): Promise<QueueView>; resume(id: string): Promise<{ success: boolean }> };
} };

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
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, prompt: launchPrompt });

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  const call = /CALL>> (\S+) (\S+)(?: (.*))?$/.exec(prompt);
  if (call) {
    const answer = await fetch(process.env.CLAUDE_MGR_API_URL + call[2], {
      method: call[1], headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id },
      ...(call[1] === 'GET' ? {} : { body: call[3] || '{}' }),
    });
    let body; try { body = await answer.json(); } catch { body = null; }
    record('calls.jsonl', { method: call[1], path: call[2], status: answer.status, body });
  }
  // Held in its turn until the spec lets it go.
  if (prompt.includes('WORK>>')) {
    const release = path.join(process.env.HOME, 'release-' + id);
    while (!fs.existsSync(release)) { line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }); await sleep(300); }
  }
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
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

test.skip(process.platform === 'win32', 'the stand-ins are typed into a POSIX shell; the queue itself is platform-free and its unit tests (agent-queue-line.test.ts, agent-queue-store.test.ts) run everywhere');

for (const newInterface of [false, true]) {
  test(`an agent's queue is seen, paused, reordered, cancelled, and kept across a stop and a restart${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-queue-${newInterface ? 'ni' : 'classic'}-`));
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
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker'), agent('other', 'Other Worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31508 + (newInterface ? 1 : 0));
    const seen: Record<string, unknown> = { newInterface };
    const soft = expect.soft;
    const callsOf = (who: string) => lines(path.join(home, 'calls.jsonl')).filter((c) => c.id === who);
    const promptsOf = (who: string) => lines(path.join(home, 'prompts.jsonl')).filter((p) => p.id === who).map((p) => String(p.prompt));

    const boot = async () => {
      const app = await launchSandboxed(electron, home, {
        env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
      });
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      return { app, page };
    };
    let { app, page } = await boot();
    try {
      const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      const type = (id: string, input: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.sendInput(p), { id, input });
      const start = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
      const up = (ids: string[]) => expect.poll(async () => (await list()).filter((a) => ids.includes(a.id) && a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(ids.length);
      /** An agent's call through its own terminal, and its recorded answer. */
      const call = async (who: string, method: string, route: string, body?: unknown) => {
        const before = callsOf(who).length;
        await type(who, `CALL>> ${method} ${route}${body === undefined ? '' : ` ${JSON.stringify(body)}`}\r`);
        await expect.poll(() => callsOf(who).length, { timeout: 30_000, message: `${who}'s call ${method} ${route}` }).toBe(before + 1);
        return callsOf(who)[before] as { status: number; body: Record<string, unknown> };
      };

      for (const id of ['lead', 'worker', 'other']) await start(id);
      await up(['lead', 'worker', 'other']);

      // The worker, held in a turn.
      await type('worker', 'WORK>> hold\r');
      await expect.poll(() => promptsOf('worker').some((p) => p.includes('WORK>>')), { timeout: 20_000 }).toBe(true);

      // What waits for it: two tasks and a message from the lead, a note from the other worker.
      const a = await call('lead', 'POST', '/api/agents/worker/run-task', { task: 'TASK-A the first task', answer: 'started' });
      const b = await call('lead', 'POST', '/api/agents/worker/dispatch', { message: 'MSG-B a queued message', mode: 'queue' });
      const c = await call('lead', 'POST', '/api/agents/worker/run-task', { task: 'TASK-C the third task', answer: 'started' });
      const d = await call('other', 'POST', '/api/agents/worker/dispatch', { message: 'NOTE-D a note from the other worker' });
      const refA = String(a.body.taskId), refC = String(c.body.taskId);
      const refB = String(b.body.queuedTask ?? b.body.taskRef), refD = String(d.body.queuedTask ?? d.body.taskRef);
      seen.handed = { a: a.body, b: b.body, c: c.body, d: d.body };

      // ── F1: the queue, in order, with what each item is ──
      const byLead = await call('lead', 'GET', '/api/agents/worker/queue');
      const items = ((byLead.body?.items ?? []) as QueueItem[]);
      seen.queueByLead = byLead.body;
      soft(byLead.status, 'F1: the queue can be read').toBe(200);
      soft(items.map((i) => i.ref), 'F1: in the order it was handed, the note no item of it').toEqual([refA, refB, refC]);
      soft(items.map((i) => i.how), 'F1: how each goes in').toEqual(['task', 'message', 'task']);
      soft(items.map((i) => i.from), 'F1: who sent each').toEqual(['Project Lead', 'Project Lead', 'Project Lead']);
      soft(items.every((i) => !Number.isNaN(Date.parse(i.queuedAt))), 'F1: since when').toBe(true);
      soft(items[0]?.title, 'F1: its first line').toBe('TASK-A the first task');
      const byOther = await call('other', 'GET', '/api/agents/worker/queue');
      soft(byOther.status, 'F1: a worker may read it').toBe(200);
      soft(((byOther.body?.items ?? []) as QueueItem[]).map((i) => i.ref), 'F1: a worker sees only what it sent').toEqual([]);

      // ── F2: paused, nothing goes in at the end of the turn; the turn itself is not cut ──
      const paused = await call('lead', 'POST', '/api/agents/worker/queue/pause', { reason: 'hold everything' });
      soft(paused.status, 'F2: the queue can be paused').toBe(200);
      fs.writeFileSync(path.join(home, 'release-worker'), '');
      await expect.poll(() => lines(path.join(home, 'prompts.jsonl')).filter((p) => p.id === 'worker').length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, 5_000));
      seen.workerPromptsWhilePaused = promptsOf('worker');
      soft(promptsOf('worker').filter((p) => /TASK-A|MSG-B|TASK-C/.test(p)), 'F2: nothing went in while paused').toEqual([]);

      // ── F3: a worker acts on what it sent, and only on that ──
      const otherCancelsA = await call('other', 'POST', `/api/tasks/${refA}/cancel`, {});
      const otherMovesA = await call('other', 'POST', `/api/tasks/${refA}/move`, {});
      const otherPauses = await call('other', 'POST', '/api/agents/worker/queue/resume', {});
      seen.workerRights = { otherCancelsA: otherCancelsA.status, otherMovesA: otherMovesA.status, otherPauses: otherPauses.status, refD };
      soft(otherCancelsA.status, 'F3: a worker cannot cancel what it did not send').toBe(403);
      soft(otherMovesA.status, 'F3: nor move it').toBe(403);
      soft(otherPauses.status, 'F3: nor resume the queue').toBe(403);

      // ── F4: the third task to the head; the message cancelled ──
      const moved = await call('lead', 'POST', `/api/tasks/${refC}/move`, {});
      soft(moved.status, 'F4: an item moves to the head').toBe(200);
      const cancelB = await call('lead', 'POST', `/api/tasks/${refB}/cancel`, {});
      soft(cancelB.status, 'the lead cancels its own message').toBe(200);
      const afterMove = await call('lead', 'GET', '/api/agents/worker/queue');
      soft(((afterMove.body?.items ?? []) as QueueItem[]).map((i) => i.ref), 'F4: the order holds').toEqual([refC, refA]);

      // ── F5: task_status knows every id it gave ──
      const statusB = await call('lead', 'GET', `/api/tasks/${refB}`);
      const statusA = await call('lead', 'GET', `/api/tasks/${refA}`);
      seen.status = { a: statusA.body, b: statusB.body };
      soft(statusB.status, 'F5: task_status knows a queued message').toBe(200);
      soft((statusA.body?.task as { outcome?: string } | undefined)?.outcome, 'F5: a queued task reads queued').toBe('queued');

      // ── F6: a stop keeps the queue, paused, and says so ──
      const stop = await call('lead', 'POST', '/api/agents/worker/stop', { reason: 'saving memory' });
      seen.stop = stop.body;
      soft(stop.body?.queueKept, 'F6: the stop says what it kept').toBe(2);
      const afterStop = await call('lead', 'GET', '/api/agents/worker/queue');
      soft(((afterStop.body?.items ?? []) as QueueItem[]).map((i) => i.ref), 'F6: the queue is kept').toEqual([refC, refA]);
      soft((afterStop.body as QueueView | undefined)?.paused?.why, 'F6: paused').toBeTruthy();

      // ── F7: a restart of Tars keeps it, paused, and tells the orchestrator ──
      await app.close();
      ({ app, page } = await boot());
      const view = await page.evaluate(async () => (window as unknown as Api).electronAPI.agentQueue?.get('worker'));
      seen.afterRestart = view;
      soft(view?.items.map((i) => i.ref), 'F7 and F8: kept across the restart, read by the window').toEqual([refC, refA]);
      soft(view?.paused, 'F7: paused').toBeTruthy();
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'lead', prompt: '' }));
      await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).some((x) => x.id === 'lead' && x.cliRunning), { timeout: 90_000 }).toBe(true);
      await soft.poll(() => promptsOf('lead').some((p) => p.includes(refC) && p.includes(refA) && /paused/i.test(p)), { timeout: 30_000, message: 'F7: the orchestrator is told what waits' }).toBe(true);

      // ── F9: resumed, they go in one at a time, in the queue's order ──
      const resumed = await page.evaluate(async () => (window as unknown as Api).electronAPI.agentQueue?.resume('worker'));
      soft(resumed?.success, 'F8: the window resumes it').toBe(true);
      await soft.poll(() => promptsOf('worker').filter((p) => /TASK-A|TASK-C/.test(p)).map((p) => (p.includes('TASK-C') ? 'C' : 'A')), { timeout: 60_000, message: 'F9: in the queue\'s order' }).toEqual(['C', 'A']);
      seen.workerPrompts = promptsOf('worker');
      seen.leadPrompts = promptsOf('lead');
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
    }
  });
}
