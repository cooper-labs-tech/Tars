import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * One agent runs one task at a time, and a worker never orders work from another agent (2.0.4).
 *
 * The defect: a worker delegated a gate to the QA while the orchestrator's gate of the same PR ran there, and Tars
 * opened a second QA session beside the first: both worked at once. run-task never asked whether the agent was
 * already working, and the drive routes checked the caller's project, never its role.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js), run once
 * with the identity of the orchestrator `lead` and once with that of the worker `dev`, spoken to over stdio as Claude
 * Code speaks to it. Agent `oc` is a claude worker whose CLI is a stand-in named `claude` that does what Claude Code
 * does around a turn (Tars's own hook scripts, a transcript line per reply): each turn lasts RUN_S, and it records
 * every launch, prompt and answer with its pid. Since 2.0.4 a delegated task goes into the agent's own terminal, so
 * "never two sessions at work" is read from that one CLI's turns: never two at once, and all in one process. Until
 * 2.0.4 oc was an opencode agent driven over ACP by a fake ACP agent, one process per run. Agent `qa` is a worker whose terminal runs a stand-in that
 * records every byte typed into it; its turns are told through the hook route with its own token.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * a. two delegate_task calls from lead to oc at once: both return their own real result, and the second run's prompt
 *    reaches oc only after the first answered: never two sessions of oc at work together (the fake agent's log);
 *    a third task asked meanwhile is answered queued behind a task from lead, task_status says so, task_cancel takes
 *    it back, and it never runs;
 * b. dev's delegate_task and start_agent to oc are refused with the message that it asks its orchestrator, and no run
 *    starts; dev's send_message to qa, during qa's turn, is answered as a note, is typed in only once that turn
 *    ended, labelled as a note for information from dev;
 * c. the orchestrator's delegation still runs (a);
 * d. Tars's own pass still hands oc a task, and the window still starts an agent (qa).
 * e. Stopping is reserved as handing work is: dev's stop_agent on qa is refused with the message that it asks its
 *    orchestrator, and qa's CLI keeps running; lead's stop_agent on qa stops it, filed under lead.
 * g. A task behind the task in hand (the Audit's gate of #449, M1 and L3): while a task of lead's works in oc's
 *    terminal, lead's start_agent to oc is answered queued, with its id; it is not typed in beside that turn, goes in
 *    once the turn answered, and task_status by its id reads its own answer. A CLI that tells Tars nothing of its
 *    turns (nh, an opencode stand-in with no hook) given a task does not hold its agent: lead's next task to nh goes in
 *    too (H1). dev's kanban claim of a task for qa is refused, with the code of an order (M2). Until 2.0.4 the task in
 *    hand was a run over ACP and the queued one went into a terminal open beside it.
 * f. A task waiting its turn is kept across a restart, its queue paused (#536; until 2.0.5 it was in Tars's memory
 *    only): lead delegates to oc while a run of Tars's holds it, Tars quits and starts again on the same home, and
 *    lead's delegate_task says that Tars restarted and that the task is kept, paused, and goes in once the queue is
 *    resumed, never to ask for it again; task_status asked of the new Tars says it is queued; it does not run while
 *    the queue is paused, and runs once, once lead resumes oc's queue (the QA's F1 on the 2.0.5 train: the answer
 *    said "must be asked again", and an asker that followed it ran the task twice).
 * Red on f9966e6e for g (as #449 wrote it, over ACP): the task is typed into oc's terminal beside the run, the next
 * delegate_task waits behind "a turn in its terminal" until its timeout, and dev's claim is answered by the board.
 * Red on 9df7c099 (2.0.4 before #449): the two runs overlap, the worker's calls go through, the message is
 * typed into qa's turn with no label. Red on 36822724 for e and f: dev stops qa, and the delegation waits 90 s after
 * the restart, then says Tars could not be reached and the run may still be working.
 * The artefact: values.json (every tool answer, the fake agent's log, the bytes qa received, the ledger's tasks, the
 * stop and the restart), a screenshot of the Usage page, the app's trace with E2E_TRACE=on.
 */

const RUN_S = 6;
const HOLD_S = 120;

const HOOKS = path.resolve('hooks');

/**
 * oc's CLI, a stand-in named `claude`: Claude Code's hooks around each turn and its transcript, each turn RUN_S long
 * (TASK-HOLD: HOLD_S, the turn a restart of Tars cuts, with a task queued behind it), every step logged with its pid.
 */
const TURN_STAND_IN = (log: string) => String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), pid: process.pid, ...entry }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(${JSON.stringify(HOOKS)}, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const reply = (text) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(), message: { id: crypto.randomUUID(), role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
}) + '\n');
async function turn(prompt) {
  const task = (prompt.match(/TASK-[A-Z]+/) ?? ['?'])[0];
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  log({ prompt: task });
  await new Promise((r) => setTimeout(r, (task === 'TASK-HOLD' ? ${HOLD_S} : ${RUN_S}) * 1000));
  reply('answer for ' + task);
  log({ answered: task });
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'answer for ' + task });
}
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: true });
process.stdout.write('stand-in ready\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
const dashes = process.argv.indexOf('--');
if (dashes !== -1 && process.argv.slice(dashes + 1).join(' ').trim()) queue = queue.then(() => turn(process.argv.slice(dashes + 1).join(' ')));
let pasting = false;
process.stdin.on('data', (data) => {
  // Enter outside a paste ends a message: since #569 the sender line ends its own line inside its paste, as in claude.
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if ((ch !== '\r' && ch !== '\n') || pasting) { buffer += ch; continue; }
      const line = buffer;
      buffer = '';
      if (line.trim()) queue = queue.then(() => turn(line));
    }
  }
});
process.stdin.resume();
`;

/** A terminal stand-in: records every byte typed into it. */
const STAND_IN = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
  "process.stdout.write('stand-in ready\\n');",
  '',
].join('\n');

type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; requesterAgentId: string | null; source: string; outcome: string; text: string }> }> };
} };
type ToolAnswer = { text: string; isError: boolean };

/** The orchestrator MCP server with one agent's identity, as Tars hands it to that agent's CLI. */
function mcpAs(home: string, project: string, port: string, agentId: string, token: string, instance: string) {
  const mcp: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token,
      CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: instance,
    },
  });
  const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
  let buffered = '';
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve) => {
    const id = nextId++;
    replies.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    await ready;
    const reply = await rpc('tools/call', { name, arguments: args });
    return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
  return { call, kill: () => mcp.kill() };
}

for (const newInterface of [false, true]) {
  test(`one agent runs one task at a time, and a worker's orders are refused and its message is a note${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-one-task-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const turnsLog = path.join(home, 'oc-turns.jsonl');
    const ocCli = path.join(bin, 'claude');
    fs.writeFileSync(ocCli, `#!${process.execPath}\n${TURN_STAND_IN(turnsLog)}`, { mode: 0o755 });
    // nh's CLI, an opencode stand-in with no hook: it records how it was started and every byte typed into it.
    const nhFile = path.join(home, 'nh.log');
    const nhCli = path.join(bin, 'opencode');
    fs.writeFileSync(nhCli, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(nhFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.stdin.isTTY) process.stdin.setRawMode(true);\nprocess.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(nhFile)}, d));\nprocess.stdout.write('opencode ready' + String.fromCharCode(10));\n`, { mode: 0o755 });
    const nhLog = () => (fs.existsSync(nhFile) ? fs.readFileSync(nhFile, 'utf8') : '');
    const qaReceived = path.join(home, 'qa.received');
    const qaCli = path.join(home, 'qa-cli.cjs');
    fs.writeFileSync(qaCli, STAND_IN(qaReceived), { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'auto',
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', 'claude'),
      agent('oc', 'Review Agent', 'worker', 'claude', { cliPath: ocCli }),
      agent('dev', 'Dev Agent', 'worker', 'claude'),
      agent('qa', 'QA Agent', 'worker', 'claude', { cliPath: qaCli }),
      agent('nh', 'No Hook Agent', 'worker', 'opencode', { cliPath: nhCli }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31423 : 31424);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, runSeconds: RUN_S };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const ocTurns = () => (fs.existsSync(turnsLog) ? fs.readFileSync(turnsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as Array<{ at: number; pid: number; launched?: boolean; prompt?: string; answered?: string }>;
    const qaBytes = () => (fs.existsSync(qaReceived) ? fs.readFileSync(qaReceived, 'utf8') : '');

    const launch = () => launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let app: ElectronApplication = await launch();
    const servers: Array<{ kill(): void }> = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // d. The window starts qa: its terminal runs the stand-in.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'qa', prompt: '' }));
      await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'qa')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);

      const ids = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        const tokens = req(`${dist}/core/agent-tokens.js`);
        const { agents } = req(`${dist}/core/agent-manager.js`);
        const qa = agents.get('qa');
        qa.sessionRegisteredAt = new Date().toISOString();
        qa.status = 'idle';
        return {
          lead: tokens.mintRunToken('lead').token as string, dev: tokens.mintRunToken('dev').token as string,
          qa: tokens.mintAgentToken('qa') as string, tars: tokens.internalToken() as string, instance: tokens.tarsInstanceId() as string,
        };
      }, { dist });
      const api = (route: string, token: string, body?: Record<string, unknown>, as?: string) => fetch(`http://127.0.0.1:${port}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(as ? { 'X-Tars-Caller-Id': as } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(90_000),
      }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
      const lead = mcpAs(home, project, port, 'lead', ids.lead, ids.instance);
      const dev = mcpAs(home, project, port, 'dev', ids.dev, ids.instance);
      servers.push(lead, dev);

      // a, c. Two delegations from the orchestrator to oc at once, and a third asked meanwhile.
      const first = lead.call('delegate_task', { id: 'oc', prompt: 'TASK-ONE review the notes', timeoutSeconds: 120 });
      await expect.poll(() => ocTurns().filter((e) => e.prompt).length, { timeout: 30_000 }).toBe(1);
      const second = lead.call('delegate_task', { id: 'oc', prompt: 'TASK-TWO review the tests', timeoutSeconds: 120 });
      await new Promise((r) => setTimeout(r, 1000));
      const third = await api('/api/agents/oc/run-task', ids.lead, { task: 'TASK-THREE never run', answer: 'started' }, 'lead');
      const thirdId = String(third.body.taskId ?? '');
      const thirdSeen = thirdId ? await api(`/api/tasks/${thirdId}`, ids.lead, undefined, 'lead') : null;
      const thirdStatus = thirdId ? await lead.call('task_status', { taskId: thirdId }) : null;
      const thirdCancel = thirdId ? await lead.call('task_cancel', { taskId: thirdId }) : null;

      // b. The worker dev orders work: refused; its message to qa, during qa's turn, is a note.
      const devDelegate = await dev.call('delegate_task', { id: 'oc', prompt: 'TASK-DEV run the gate', timeoutSeconds: 60 });
      const devStart = await dev.call('start_agent', { id: 'oc', prompt: 'TASK-DEVSTART run the gate' });
      const session = 'e2e00000-0000-4000-8000-0000000000aa';
      const hook = (body: Record<string, unknown>) => api('/api/hooks/status', ids.qa, { agent_id: 'qa', session_id: session, ...body }, 'qa');
      await hook({ status: 'idle', source: 'startup' });
      await hook({ status: 'running', event: 'UserPromptSubmit', current_task: 'the gate of the PR' });
      const devNote = await dev.call('send_message', { id: 'qa', message: 'NOTE-MARK the PR is ready for you' });
      await new Promise((r) => setTimeout(r, 2500));
      const noteDuringTurn = qaBytes().includes('NOTE-MARK');
      await hook({ status: 'idle', hook: 'Stop' });
      await expect.poll(() => qaBytes().includes('NOTE-MARK'), { timeout: 15_000 }).toBe(true);
      const noteLine = qaBytes().split(/\r|\n|\x1b\[20[01]~/).find((l) => l.includes('NOTE-MARK')) ?? '';

      const [firstAnswer, secondAnswer] = await Promise.all([first, second]);

      // d. Tars's own pass still hands oc a task.
      const byTars = await api('/api/agents/oc/run-task', ids.tars, { task: 'TASK-TARS a check' });

      // e. A worker's stop is refused, the orchestrator's stops qa.
      const qaNow = async () => ({
        ...(await app.evaluate((_e, { dist }) => {
          const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('qa');
          return { status: a.status as string, stoppedBy: (a.stoppedBy ?? null) as string | null, stopReason: (a.stopReason ?? null) as string | null };
        }, { dist })),
        cliRunning: (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'qa')?.cliRunning ?? false,
      });
      const devStop = await dev.call('stop_agent', { id: 'qa', reason: 'my gate is done' });
      const qaAfterDevStop = await qaNow();
      const leadStop = await lead.call('stop_agent', { id: 'qa', reason: 'the e2e stops qa' });
      await expect.poll(async () => (await qaNow()).cliRunning, { timeout: 15_000 }).toBe(false).catch(() => undefined);
      const qaAfterLeadStop = await qaNow();

      const turns = ocTurns();
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      // oc's tasks, each opened by its turn in oc's terminal (task-ledger.ts).
      const runs = report.tasks.filter((t) => t.agentId === 'oc');
      keep({
        firstAnswer, secondAnswer, third, thirdSeen, thirdStatus, thirdCancel, devDelegate, devStart, devNote, noteDuringTurn, noteLine,
        byTars: { status: byTars.status, ok: byTars.body.ok, text: byTars.body.text }, ocTurns: turns, qaBytes: qaBytes(), tasks: runs,
        devStop, qaAfterDevStop, leadStop, qaAfterLeadStop,
      });
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await stepShot(page, newInterface ? 'usage-new-interface' : 'usage');

      // a. Both delegations return their own result, and oc never ran two prompts at once.
      expect.soft(firstAnswer.isError, firstAnswer.text).toBe(false);
      expect.soft(firstAnswer.text).toContain('answer for TASK-ONE');
      expect.soft(secondAnswer.isError, secondAnswer.text).toBe(false);
      expect.soft(secondAnswer.text).toContain('answer for TASK-TWO');
      const at = (key: 'prompt' | 'answered', task: string) => turns.find((e) => e[key] === task)?.at ?? NaN;
      expect.soft(at('prompt', 'TASK-TWO'), 'TASK-TWO reached oc before TASK-ONE was answered').toBeGreaterThanOrEqual(at('answered', 'TASK-ONE'));
      let inFlight = 0;
      let most = 0;
      for (const e of turns) {
        if (e.prompt) most = Math.max(most, ++inFlight);
        if (e.answered) inFlight--;
      }
      expect.soft(most, 'prompts of oc at work at once').toBe(1);
      // And all in oc's one permanent session: one process of its CLI, launched once.
      expect.soft(turns.filter((e) => e.launched).length, 'launches of oc\'s CLI').toBe(1);
      expect.soft(new Set(turns.filter((e) => e.prompt).map((e) => e.pid)).size, 'processes oc\'s tasks ran in').toBe(1);
      // The third: queued behind a task from lead, said so, cancelled, never run.
      expect.soft(third.status).toBe(200);
      expect.soft(third.body.outcome).toBe('queued');
      expect.soft(String(third.body.queuedBehind ?? '')).toContain('Project Lead');
      expect.soft((thirdSeen?.body.task as { outcome?: string } | undefined)?.outcome).toBe('queued');
      expect.soft(thirdStatus?.text ?? '').toMatch(/queued on agent oc since .*behind task .* from "Project Lead"/);
      expect.soft(thirdStatus?.text ?? '').toContain('task_status');
      expect.soft(thirdCancel?.isError ?? true, thirdCancel?.text).toBe(false);
      expect.soft(thirdCancel?.text ?? '').toContain('never started');
      expect.soft(turns.filter((e) => e.prompt === 'TASK-THREE'), 'the cancelled task ran').toEqual([]);

      // b. The worker's orders are refused, and say to ask the orchestrator; nothing of it ran.
      expect.soft(devDelegate.isError, devDelegate.text).toBe(true);
      expect.soft(devDelegate.text).toContain('Ask your orchestrator');
      expect.soft(devStart.isError, devStart.text).toBe(true);
      expect.soft(devStart.text).toContain('Ask your orchestrator');
      expect.soft(turns.filter((e) => e.prompt === 'TASK-DEV' || e.prompt === 'TASK-DEVSTART'), "the worker's tasks ran").toEqual([]);
      // Its message is a note, typed in only after qa's turn, and labelled so.
      expect.soft(devNote.isError, devNote.text).toBe(false);
      expect.soft(devNote.text).toContain('as a note for information');
      expect.soft(noteDuringTurn, 'typed into the turn').toBe(false);
      expect.soft(noteLine).toContain('Note for information from "Dev Agent"');
      expect.soft(noteLine).toContain('it is not a task');

      // d. Tars's own pass still hands work.
      expect.soft(byTars.status).toBe(200);
      expect.soft(byTars.body.text).toBe('answer for TASK-TARS');
      expect.soft(runs.map((t) => t.text).sort(), 'the runs of oc').toEqual(['TASK-ONE review the notes', 'TASK-TARS a check', 'TASK-TWO review the tests']);

      // e. The worker's stop is refused and says to ask the orchestrator; qa still runs. The orchestrator's stops it.
      expect.soft(devStop.isError, devStop.text).toBe(true);
      expect.soft(devStop.text).toContain('Ask your orchestrator');
      expect.soft(qaAfterDevStop, "qa after the worker's stop").toMatchObject({ cliRunning: true, stoppedBy: null });
      expect.soft(qaAfterDevStop.status).not.toBe('stopped');
      expect.soft(leadStop.isError, leadStop.text).toBe(false);
      expect.soft(leadStop.text).toContain('Stopped agent qa');
      expect.soft(qaAfterLeadStop, "qa after the orchestrator's stop").toMatchObject({ status: 'stopped', stoppedBy: 'Project Lead', stopReason: 'the e2e stops qa', cliRunning: false });

      // g. A task queued behind the task in hand on oc, and a CLI with no hook given two tasks.
      const gone = lead.call('delegate_task', { id: 'oc', prompt: 'TASK-GONE review the docs', timeoutSeconds: 120 });
      await expect.poll(() => ocTurns().some((e) => e.prompt === 'TASK-GONE'), { timeout: 30_000 }).toBe(true);
      const typedTask = await lead.call('start_agent', { id: 'oc', prompt: 'TASK-TYPED fix the docs' });
      await new Promise((r) => setTimeout(r, 1500));
      const typedDuringRun = ocTurns().some((e) => e.prompt === 'TASK-TYPED');
      const goneAnswer = await gone;
      await expect.poll(() => ocTurns().some((e) => e.answered === 'TASK-TYPED'), { timeout: 60_000 }).toBe(true).catch(() => undefined);
      const typedRef = /Task (t-[0-9a-f]{8}) is queued/.exec(typedTask.text)?.[1] ?? '';
      // Tars closes a task once it has read its turn's end, a moment after the stand-in logs its answer: read at once,
      // under load task_status still said running (QA-PR451.md). So it is read until it answers, 30 s at most.
      let typedStatus = null as ToolAnswer | null;
      if (typedRef) {
        await expect.poll(async () => (typedStatus = await lead.call('task_status', { taskId: typedRef })).text, { timeout: 30_000 })
          .toContain('answer for TASK-TYPED').catch(() => undefined);
      }
      const nhOne = await lead.call('delegate_task', { id: 'nh', prompt: 'TASK-NHONE read the logs', timeoutSeconds: 60 });
      const nhTwo = await lead.call('delegate_task', { id: 'nh', prompt: 'TASK-NHTWO read the tests', timeoutSeconds: 60 });
      await expect.poll(() => nhLog().includes('TASK-NHTWO'), { timeout: 30_000 }).toBe(true).catch(() => undefined);
      const devClaim = await api('/api/kanban/tasks/t_0123abcd/claim', ids.dev, { agent_id: 'qa' }, 'dev');
      keep({ g: { typedTask, typedDuringRun, goneAnswer, typedRef, typedStatus, nhOne, nhTwo, nhLog: nhLog().slice(-3000), devClaim } });
      expect.soft(typedTask.isError, typedTask.text).toBe(false);
      expect.soft(typedTask.text).toMatch(/Task t-[0-9a-f]{8} is queued on agent oc/);
      expect.soft(typedTask.text).toContain('task_status');
      expect.soft(typedDuringRun, "typed into oc's terminal beside the task in hand").toBe(false);
      expect.soft(goneAnswer.text).toContain('answer for TASK-GONE');
      const turnsNow = ocTurns();
      const atNow = (key: 'prompt' | 'answered', task: string) => turnsNow.find((e) => e[key] === task)?.at ?? NaN;
      expect.soft(atNow('prompt', 'TASK-TYPED'), 'the queued task went in once the task in hand answered').toBeGreaterThanOrEqual(atNow('answered', 'TASK-GONE'));
      expect.soft(typedStatus?.isError ?? true, typedStatus?.text).toBe(false);
      expect.soft(typedStatus?.text ?? '', 'task_status by the queued id reads its own answer').toContain('answer for TASK-TYPED');
      expect.soft(nhOne.isError, nhOne.text).toBe(false);
      expect.soft(nhOne.text).toContain("went into No Hook Agent's terminal");
      expect.soft(nhTwo.isError, nhTwo.text).toBe(false);
      expect.soft(nhTwo.text, 'the first task held an agent whose CLI says nothing of its turns').toContain("went into No Hook Agent's terminal");
      expect.soft(nhLog(), 'both tasks reached nh').toContain('TASK-NHTWO');
      expect.soft(devClaim.status, JSON.stringify(devClaim.body)).toBe(403);
      expect.soft(devClaim.body.code).toBe('worker_may_not_order');

      // f. Tars restarts while lead's task waits its turn on oc, behind a run of Tars's own.
      const hold = api('/api/agents/oc/run-task', ids.tars, { task: 'TASK-HOLD keep oc busy' }).catch((err: unknown) => ({ status: 0, body: { error: String(err) } }));
      await expect.poll(() => ocTurns().some((e) => e.prompt === 'TASK-HOLD'), { timeout: 30_000 }).toBe(true);
      let lostAt = 0;
      const lost = lead.call('delegate_task', { id: 'oc', prompt: 'TASK-LOST asked before the restart', timeoutSeconds: 120 }).then((answer) => { lostAt = Date.now(); return answer; });
      const queuedOnOc = () => app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/one-task.js`).oneTaskQueue.queued('oc').map((t: { ref: string }) => t.ref) as string[], { dist });
      await expect.poll(async () => (await queuedOnOc()).length, { timeout: 30_000 }).toBe(1);
      const [lostRef] = await queuedOnOc();
      const closedAt = Date.now();
      await app.close();
      app = await launch();
      const relaunchedAt = Date.now();
      const lostAnswer = await lost;
      const again = await app.evaluate((_e, { dist }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { lead: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      const leadAgain = mcpAs(home, project, port, 'lead', again.lead, again.instance);
      servers.push(leadAgain);
      const lostStatus = await leadAgain.call('task_status', { taskId: lostRef });
      const holdAnswer = await hold;
      // Paused: nothing goes in, the kept task included, until the queue is resumed.
      await new Promise((r) => setTimeout(r, 3_000));
      const whilePaused = ocTurns().filter((e) => e.prompt === 'TASK-LOST').length;
      const resumed = await leadAgain.call('agent_queue', { id: 'oc', action: 'resume' });
      await expect.poll(() => ocTurns().filter((e) => e.prompt === 'TASK-LOST').length, { timeout: 90_000, message: 'the kept task went in once resumed' }).toBe(1);
      await new Promise((r) => setTimeout(r, (RUN_S + 4) * 1000));
      keep({
        restart: { lostRef, lostAnswer, lostStatus, hold: { status: holdAnswer.status }, closedAt, relaunchedAt, answeredAt: lostAt, whilePaused, resumed, ocTurns: ocTurns() },
      });
      expect.soft(lostAnswer.isError, lostAnswer.text).toBe(true);
      expect.soft(lostAnswer.text).toContain('Tars restarted');
      expect.soft(lostAnswer.text).toContain(lostRef);
      expect.soft(lostAnswer.text).toContain('kept');
      expect.soft(lostAnswer.text).toContain('paused');
      expect.soft(lostAnswer.text).toContain('resumed');
      expect.soft(lostAnswer.text).not.toMatch(/never started|asked again|ask for it again/);
      expect.soft(lostAnswer.text).not.toMatch(/may still be working|could not be reached/);
      expect.soft(lostStatus.isError, lostStatus.text).toBe(false);
      expect.soft(lostStatus.text).toContain(lostRef);
      expect.soft(lostStatus.text).toContain('queued');
      expect.soft(lostStatus.text).not.toMatch(/never started|asked again/);
      expect.soft(whilePaused, 'the kept task ran while its queue was paused').toBe(0);
      expect.soft(resumed.isError, resumed.text).toBe(false);
      expect.soft(ocTurns().filter((e) => e.prompt === 'TASK-LOST').length, 'the kept task ran once, never twice').toBe(1);
    } finally {
      for (const s of servers) s.kill();
      await app.close().catch(() => undefined);
      if (fs.existsSync(turnsLog)) fs.copyFileSync(turnsLog, test.info().outputPath('oc-turns.jsonl'));
      await removeHome(home);
    }
  });
}
