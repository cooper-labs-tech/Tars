import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Receipts, send modes, the ceiling for delegated runs, and delegated results
 * that survive a restart (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 items 1 to 4; PR B,
 * the proof of row B), in the real app.
 *
 * Stand-in CLIs record every byte typed into them. Requests go through the API
 * with each asker's own token, as the MCP tools send them; a worker's turns are
 * told through the hook route with its own token, as Claude Code's hooks do.
 * Each asker has the powers that hand work since 2.0.4 (core/one-task.ts): the
 * first is the project's orchestrator, and a second one the runner of one of
 * its chats (chats.json, written by `runner` below).
 * A delegated task goes into the target's own terminal (2.0.4): there, a stand-in
 * named `claude` runs Tars's hook scripts around each turn and writes its answer
 * where Claude Code keeps its transcript.
 *
 * Asserted:
 * 1. one clientRequestId sent three times (two at once, one after): one batch
 *    of keystrokes, one request queued, one task in the ledger, and the two
 *    retries answered with the first outcome;
 * 2. the same id with another text: `clientRequestId_conflict`, nothing typed;
 * 3. the receipts file, in ~/.tars-private, holds the id and none of the text;
 * 4. `steer` into a codex worker: `not_steerable`, nothing typed;
 * 5. `steer` into a worker busy with another asker's work: refused;
 * 6. `queue` into a worker in a turn: nothing typed until the turn ends;
 * 7. a task delegated by an agent in plan mode to a target in bypass goes into
 *    the target's terminal marked so, and one delegated by an agent in bypass
 *    goes in unmarked. Until 2.0.4 this read the session mode of a run over ACP
 *    (held to plan, its exit refused or cut: EXIT-ASK, EXIT-FORCE): no task is
 *    run over ACP any more, the target works in its own mode, and the mark asks,
 *    it does not bind (SECURITY.md: the maintainer decided on 2026-10-18 that a
 *    delegated task runs in the permission mode of the agent that receives it);
 * 8. a message from an agent in plan mode to a worker in bypass is marked so;
 * 9. after a relaunch, the task's result (its transcript's final message) is read from the ledger by its id, and
 *    by the clientRequestId it was sent with; another agent reads nothing.
 * The artefact: values.json with every answer, the bytes each stand-in
 * received, the ledger's tasks, and the receipts file itself.
 */

type Agent = { id: string; cliRunning?: boolean };
type Task = { id: string; agentId: string; requesterAgentId: string | null; source: string; outcome: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> };
  usage: { tasks(p: { sinceDays: number }): Promise<{ tasks: Task[] }> };
} };
type Answer = { status: number; body: Record<string, unknown> };

const STAND_IN = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
  "process.stdout.write('stand-in ready\\n');",
  '',
].join('\n');

const HOOKS = path.resolve('hooks');

/** A stand-in named `claude` that records what is typed into it and answers each line as a turn, hooks and transcript. */
const TURN_STAND_IN = (file: string) => String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(${JSON.stringify(HOOKS)}, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const turn = (prompt) => {
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { id: crypto.randomUUID(), role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'reviewed' }] } }) + '\n');
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'reviewed' });
};
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let buffer = '';
process.stdin.on('data', (d) => {
  fs.appendFileSync(${JSON.stringify(file)}, d);
  buffer += d.toString();
  let end;
  while ((end = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (line.trim()) turn(line);
  }
});
process.stdout.write('stand-in ready\n');
`;

function sandbox(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const received = (id: string) => path.join(home, `${id}.received`);
  const cliFor = (id: string) => {
    const cli = path.join(home, `${id}-cli.cjs`);
    fs.writeFileSync(cli, STAND_IN(received(id)), { mode: 0o755 });
    return cli;
  };
  const read = (id: string) => (fs.existsSync(received(id)) ? fs.readFileSync(received(id), 'utf8') : '');
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'auto',
    projectPath: project, skills: [], cliPath: cliFor(id),
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  /**
   * chats.json with one chat, #2, run by `runnerId`, and the project's inbox:
   * Main was deleted, so the orchestrator runs no chat, and what cuts its work
   * is refused as another asker's (worker_busy_for_other_requester), as
   * before 2.0.4 when the askers were workers.
   */
  const runner = (chatId: string, runnerId: string, title: string) => {
    const at = '2026-10-12T08:00:00.000Z';
    fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [project]: 2 }, chats: [{
      id: chatId, projectPath: project, number: 2, title, titleSource: 'user', runnerId, sessionIds: [], pinned: false,
      snoozedUntil: null, settledAt: null, inbox: true, createdAt: at, updatedAt: at, lastActivityAt: at,
    }] }, null, 2));
    return { kind: 'chat', chatId };
  };
  const seed = (agents: object[], settings: Record<string, unknown> = {}) => {
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      // E2E_NEW_INTERFACE=1: the same run in the new interface's shell.
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface: process.env.E2E_NEW_INTERFACE === '1', ...settings,
    }));
  };
  return { home, project, dir, bin, read, agent, runner, seed };
}

async function open(home: string, port: string, ids: string[]) {
  const dist = path.resolve('electron', 'dist');
  const app = await launchSandboxed(electron, home, {
    // A chat's runner started takes a slot: room for it whatever this machine's memory (services/chats.ts, chatLimitOf).
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '20' },
  });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  // The shell this run is in (E2E_NEW_INTERFACE=1: the new interface's).
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(process.env.E2E_NEW_INTERFACE === '1' ? 1 : 0, { timeout: 30_000 });
  const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
  for (const id of ids) {
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
    await expect.poll(async () => (await list()).find(a => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
  }
  /** Each stand-in's session up (it has no hooks), at rest, and a token for each agent named. */
  const tokensFor = (all: string[]) => app.evaluate((_e, { dist, ids, all }) => {
    const req = process.mainModule!.require;
    const { agents } = req(`${dist}/core/agent-manager.js`);
    const tokens: Record<string, string> = {};
    for (const id of all) {
      const a = agents.get(id);
      if (ids.includes(id)) { a.sessionRegisteredAt = new Date().toISOString(); a.status = 'idle'; }
      tokens[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
    }
    return tokens;
  }, { dist, ids, all });
  const tasks = () => page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 })).then(r => r.tasks);
  return { app, page, dist, tokensFor, tasks };
}

function client(port: string, tokens: () => Record<string, string>) {
  const call = (method: 'GET' | 'POST', route: string, as: string, body?: Record<string, unknown>): Promise<Answer> =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens()[as]}`, 'X-Tars-Caller-Id': as },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
  return { post: (route: string, as: string, body: Record<string, unknown>) => call('POST', route, as, body), get: (route: string, as: string) => call('GET', route, as) };
}

const count = (text: string, marker: string) => text.split(marker).length - 1;

test('a retried request is sent once, a reused id with another text is refused, and the send modes hold', async () => {
  test.setTimeout(300_000);
  const s = sandbox('tars-e2e-receipts-');
  s.seed([
    s.agent('w1', 'Worker'), s.agent('o1', 'Lead', { role: 'orchestrator' }), s.agent('b1', 'Bot', s.runner('b0b0b0b0-0000-4000-8000-000000000002', 'b1', 'Bot')),
    s.agent('cx', 'Codex Worker', { provider: 'codex' }),
  ]);
  const port = apiPort(31455);
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const step = (name: string) => { times[name] = Date.now() - t0; };
  const { app, tokensFor, tasks } = await open(s.home, port, ['w1', 'o1', 'b1', 'cx']);
  step('opened');
  const values: Record<string, unknown> = { times, newInterface: process.env.E2E_NEW_INTERFACE === '1' };
  try {
    const tokens = await tokensFor(['w1', 'o1', 'b1', 'cx']);
    const { post } = client(port, () => tokens);
    const session = 'e2e00000-0000-4000-8000-0000000000b1';
    const hook = (body: Record<string, unknown>) => post('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: session, ...body });
    await hook({ status: 'idle', source: 'startup' });

    // 1. One id, three sends: two at once, as a timeout and its retry overlap, then a third.
    const send = { message: 'RCPT-ALPHA review #280', clientRequestId: 'cr-e2e-0001' };
    const [first, second] = await Promise.all([post('/api/agents/w1/dispatch', 'o1', send), post('/api/agents/w1/dispatch', 'o1', send)]);
    const third = await post('/api/agents/w1/dispatch', 'o1', send);
    step('sent3');
    await expect.poll(() => s.read('w1').includes('RCPT-ALPHA'), { timeout: 20_000 }).toBe(true);
    // Time for a second batch to land, were one on its way.
    await new Promise(r => setTimeout(r, 3_000));
    const typed = s.read('w1').split(/\r|\n|\x1b\[20[01]~/).find(l => l.includes('RCPT-ALPHA')) ?? '';
    const worker = () => app.evaluate((_e, { dist }) => {
      const w = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1');
      return { queue: (w.taskQueue ?? []).map((r: { ref: string; requesterAgentId: string }) => [r.ref, r.requesterAgentId]), requestedBy: w.requestedBy ?? null };
    }, { dist: path.resolve('electron', 'dist') });
    values.retried = { first, second, third, typed, alphaTyped: count(s.read('w1'), 'RCPT-ALPHA'), worker: await worker() };
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(count(s.read('w1'), 'RCPT-ALPHA')).toBe(1);
    const answers = [first.body, second.body, third.body];
    expect(answers.filter(a => a.duplicate === true)).toHaveLength(2);
    expect(new Set(answers.map(a => a.taskRef)).size).toBe(1);
    expect((await worker()).queue).toEqual([[first.body.taskRef ?? second.body.taskRef, 'o1']]);

    // Its turn: one task in the ledger, asked by o1.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: typed });
    await expect.poll(async () => (await tasks()).filter(t => t.agentId === 'w1').length, { timeout: 10_000 }).toBe(1);
    step('ledger');

    // 5. Steer into a worker busy with another asker's work.
    const busy = await post('/api/agents/w1/dispatch', 'b1', { message: 'RCPT-STEER-OTHER stop that', mode: 'steer' });
    values.steerOther = busy;
    step('steerOther');
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('worker_busy_for_other_requester');

    // 6. Queue into the worker in its turn: nothing typed until the turn ends.
    const queued = await post('/api/agents/w1/dispatch', 'b1', { message: 'RCPT-GAMMA after you', mode: 'queue' });
    await new Promise(r => setTimeout(r, 2_500));
    const gammaDuringTurn = count(s.read('w1'), 'RCPT-GAMMA');
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => count(s.read('w1'), 'RCPT-GAMMA'), { timeout: 15_000 }).toBe(1);
    step('queued');
    values.queued = { answer: queued, gammaDuringTurn };
    expect(queued.status).toBe(200);
    expect(queued.body.queued).toBe(true);
    expect(gammaDuringTurn).toBe(0);

    // 2. The same id, another text.
    const conflict = await post('/api/agents/w1/dispatch', 'o1', { message: 'RCPT-BETA something else', clientRequestId: 'cr-e2e-0001' });
    await new Promise(r => setTimeout(r, 1_500));
    values.conflict = conflict;
    step('conflict');
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('clientRequestId_conflict');
    expect(s.read('w1')).not.toContain('RCPT-BETA');

    // 4. Steer into a CLI Tars cannot interrupt.
    const steer = await post('/api/agents/cx/dispatch', 'o1', { message: 'RCPT-STEER-CODEX now', mode: 'steer' });
    await new Promise(r => setTimeout(r, 1_500));
    values.steerCodex = steer;
    step('steerCodex');
    expect(steer.status).toBe(409);
    expect(steer.body.code).toBe('not_steerable');
    expect(s.read('cx')).not.toContain('RCPT-STEER-CODEX');

    // 3. The receipts: in ~/.tars-private, the id, none of the text.
    const receipts = path.join(s.home, '.tars-private', 'request-receipts.jsonl');
    const raw = fs.existsSync(receipts) ? fs.readFileSync(receipts, 'utf8') : '';
    fs.writeFileSync(test.info().outputPath('request-receipts.jsonl'), raw);
    values.receipts = { lines: raw.split('\n').filter(Boolean).length, mode: fs.existsSync(receipts) ? (fs.statSync(receipts).mode & 0o777).toString(8) : null };
    expect(raw).toContain('cr-e2e-0001');
    expect(raw).not.toMatch(/RCPT-|review #280|after you/);
    expect(fs.statSync(receipts).mode & 0o777).toBe(0o600);
    values.ledger = await tasks();
  } finally {
    values.received = { w1: s.read('w1'), cx: s.read('cx') };
    recordValues(values);
    await app.close();
  }
});

test('a task delegated from plan mode is marked so in the target\'s terminal, a narrower sender is marked, and its result outlives a relaunch', async () => {
  test.setTimeout(300_000);
  const s = sandbox('tars-e2e-ceiling-');
  const ocCli = path.join(s.bin, 'claude');
  const ocReceived = path.join(s.home, 'oc.received');
  fs.writeFileSync(ocCli, `#!${process.execPath}\n${TURN_STAND_IN(ocReceived)}`, { mode: 0o755 });
  s.seed([
    s.agent('p1', 'Planner', { permissionMode: 'plan', role: 'orchestrator' }),
    s.agent('by', 'Builder', { permissionMode: 'bypass', ...s.runner('b0b0b0b0-0000-4000-8000-000000000003', 'by', 'Build') }),
    s.agent('wb', 'Bypass Worker', { permissionMode: 'bypass' }),
    s.agent('oc', 'Review Agent', { permissionMode: 'bypass', cliPath: ocCli }),
  ]);
  const port = apiPort(31454);
  const values: Record<string, unknown> = { newInterface: process.env.E2E_NEW_INTERFACE === '1' };
  // Since #507 the sender line and the body are two pastes into one field: the markers go before the lines are cut.
  const ocLines = () => (fs.existsSync(ocReceived) ? fs.readFileSync(ocReceived, 'utf8') : '').replace(/\x1b\[20[01]~/g, '').split(/\r|\n/).filter(Boolean);

  // Builder is not started: a chat's runner takes its orchestrator's mode at its launch (services/chat-runners.ts),
  // and this needs an asker in bypass beside one in plan. It asks through the API with its own token, as before.
  let opened = await open(s.home, port, ['p1', 'wb', 'oc']);
  let taskId = '';
  try {
    // Not oc: its hooks post with its terminal's own token, which a token minted here would replace (401).
    const tokens = await opened.tokensFor(['p1', 'by', 'wb']);
    const { post } = client(port, () => tokens);

    // 7. Delegated from plan mode: into oc's own terminal, marked so; from bypass mode: unmarked.
    const planned = await post('/api/agents/oc/run-task', 'p1', { task: 'TASK-PLAN review the notes', clientRequestId: 'cr-acp-plan-1' });
    const bypassed = await post('/api/agents/oc/run-task', 'by', { task: 'TASK-BYPASS review the notes' });
    const planLine = ocLines().find((l) => l.includes('TASK-PLAN')) ?? '';
    const bypassLine = ocLines().find((l) => l.includes('TASK-BYPASS')) ?? '';
    values.runs = { planned, bypassed, planLine, bypassLine };
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ ok: true, outcome: 'completed', text: 'reviewed' });
    expect(planLine).toMatch(/^Message from agent "Planner" \("p1"\), task t-[0-9a-f]{8}: \(sender in plan mode, you in bypass mode\) TASK-PLAN review the notes$/);
    expect(bypassed.status).toBe(200);
    expect(bypassed.body).toMatchObject({ ok: true, text: 'reviewed' });
    expect(bypassLine).toContain('TASK-BYPASS review the notes');
    expect(bypassLine).not.toContain('(sender in');
    taskId = String(planned.body.taskId ?? '');
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // 8. A message from plan mode to a worker in bypass carries the mark.
    const marked = await post('/api/agents/wb/dispatch', 'p1', { message: 'MARK-ME build it' });
    await expect.poll(() => s.read('wb').includes('MARK-ME'), { timeout: 20_000 }).toBe(true);
    // The sender line and the body are two pastes into one field since #507: the markers go before the lines are cut.
    const line = s.read('wb').replace(/\x1b\[20[01]~/g, '').split(/\r|\n/).find(l => l.includes('MARK-ME')) ?? '';
    values.marked = { answer: marked, line };
    expect(line).toMatch(/^Message from agent "Planner" \("p1"\), task t-[0-9a-f]{8}: \(sender in plan mode, you in bypass mode\) MARK-ME build it$/);
  } finally {
    await opened.app.close();
  }

  // 9. Relaunched: the result is read from the ledger.
  opened = await open(s.home, port, []);
  try {
    const tokens = await opened.tokensFor(['p1', 'by']);
    const { get } = client(port, () => tokens);
    const byId = await get(`/api/tasks/${taskId}`, 'p1');
    const byRequest = await get('/api/tasks?clientRequestId=cr-acp-plan-1', 'p1');
    const stranger = await get(`/api/tasks/${taskId}`, 'by');
    values.afterRelaunch = { byId, byRequest, stranger };
    expect(byId.status).toBe(200);
    expect(byId.body.task).toMatchObject({ id: taskId, agentId: 'oc', requesterAgentId: 'p1', outcome: 'completed', stopReason: 'end_turn', result: 'reviewed' });
    expect(byRequest.status).toBe(200);
    expect((byRequest.body.task as { id?: string } | undefined)?.id).toBe(taskId);
    expect(stranger.status).toBe(404);
  } finally {
    recordValues(values);
    await opened.app.close();
  }
});
