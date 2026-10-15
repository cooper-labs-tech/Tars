import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars stops abruptly while its agents work, and starts again (RD-REDEMARRAGE.md, 2.2 and 2.3; JeanBrasse's yes of
 * 2026-10-05), in the real app.
 *
 * Before the crash: the lead, typed into by hand, hands a quick task to the helper and a long one to the worker, and
 * stays in its turn. The helper finishes, so the note that it did waits for the lead's rest. The worker is cut in the
 * middle of a Bash call. A room message to the busy lead waits in the journal. The sleeper was started and rests.
 * Then Tars and every CLI are killed (SIGKILL, by PID), as a crash or a power cut leaves them.
 *
 * After the restart: the lead and the worker are started again on their own conversations (--resume) with Tars's
 * note, the worker's naming the Bash call, the lead's naming whom it still had work handed to; nothing of their last
 * request is sent again; the helper and the sleeper are not started. At the lead's first rest it gets, once each,
 * the note owed from before the restart (the helper finished), the room message, and then the worker's end, since the
 * worker's delegation link was bound to its new terminal. The worker keeps its temporary folder. A clean quit then
 * marks the run as ended, and nothing is left owed.
 *
 * The CLIs are stand-ins named `claude` (node scripts, as an npm install of Claude Code is) that run Tars's own hook
 * scripts from hooks/ with the JSON Claude Code gives them, write their transcript where Claude Code writes it, and
 * take a launch prompt as Claude Code does, after `--`.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Room = { id: string; kind: string; memberIds: string[] };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]>; sendInput(p: { id: string; input: string }): Promise<unknown> };
  bus: { listRooms(): Promise<Room[] | { rooms: Room[] }>; postMessage(p: { roomId: string; text: string; mentions?: string[] }): Promise<unknown> };
} };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const args = process.argv.slice(2);
// Tars hands the task after \`--\` (promptOperand, providers/cli-provider.ts), and nothing else there.
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, argv: args, prompt: launchPrompt, TMPDIR: process.env.TMPDIR, resume: args.includes('--resume') });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
let n = 0;
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const reply = (text) => line({ type: 'assistant', requestId: 'r' + (++n), timestamp: new Date().toISOString(), message: { id: id + '-m' + n, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id }, body: JSON.stringify(body),
});
const forever = () => new Promise(() => undefined);

async function turn(prompt) {
  record('prompts.jsonl', { prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  if (id === 'lead' && prompt.includes('DELEGATE>>')) {
    const quick = await api('/api/agents/helper/message', { message: 'QUICK>> tidy the changelog' });
    const long = await api('/api/agents/worker/message', { message: 'LONG>> build the release' });
    record('calls.jsonl', { quick: quick.status, long: long.status });
    return forever();
  }
  if (id === 'worker' && prompt.includes('LONG>>')) {
    line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'building' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm run release' } }] } });
    return forever();
  }
  reply('done: ' + prompt.slice(0, 40));
  await sleep(300);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

hook('session-start.sh', { hook_event_name: 'SessionStart', source: args.includes('--resume') ? 'resume' : 'startup' });
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf('\r')) !== -1) {
    const typed = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (typed.trim()) queue = queue.then(() => turn(typed));
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('after an abrupt stop, the working agents are resumed with a note, the resting ones sleep, and what was owed is given once', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-resume-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const privateDir = path.join(home, '.tars-private');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker'), agent('helper', 'Helper'), agent('sleeper', 'Sleeper'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const promptsFile = path.join(home, 'prompts.jsonl');

  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31467), DOROTHY_E2E: '1' },
  });
  const pageOf = async (app: Awaited<ReturnType<typeof launch>>) => {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    return page;
  };

  // ── Before the crash ──
  const app = await launch();
  const page = await pageOf(app);
  const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
  for (const id of ['lead', 'worker', 'helper', 'sleeper']) {
    await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
  }
  await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(4);
  await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'lead', input: 'DELEGATE>> ship 1.9.3\r' }));
  // The helper done, the worker inside its Bash call, the lead in its turn.
  await expect.poll(async () => {
    const byId = Object.fromEntries((await list()).map((a) => [a.id, a.status]));
    return [byId.lead, byId.worker, byId.helper, byId.sleeper].join(',');
  }, { timeout: 60_000 }).toMatch(/^running,running,(idle|waiting|completed),(idle|waiting)$/);
  // A room message to the busy lead: it waits in the journal.
  const rooms = await page.evaluate(() => (window as unknown as Api).electronAPI.bus.listRooms());
  const room = (Array.isArray(rooms) ? rooms : rooms.rooms).find((r) => r.kind === 'project' && r.memberIds.includes('lead'))!;
  await page.evaluate((r) => (window as unknown as Api).electronAPI.bus.postMessage({ roomId: r, text: 'ROOM>> the gate is green', mentions: ['lead'] }), room.id);
  // What is owed reaches the disk a moment after it is owed.
  await expect.poll(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(privateDir, 'carry-over.json'), 'utf8')).notes.map((n: { childId: string }) => n.childId);
    } catch { return []; }
  }, { timeout: 15_000 }).toEqual(['helper']);
  await new Promise((r) => setTimeout(r, 1_500));
  const before = { launches: lines(launchesFile), runState: JSON.parse(fs.readFileSync(path.join(privateDir, 'run-state.json'), 'utf8')) };

  // ── The crash: Tars and every CLI, by PID ──
  const killed = [app.process().pid!, ...before.launches.map((l) => l.pid as number)];
  for (const pid of killed) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ } }
  await new Promise((r) => setTimeout(r, 2_000));

  // ── After it ──
  const again = await launch();
  try {
    const page2 = await pageOf(again);
    const list2 = () => page2.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const launchesAfter = () => lines(launchesFile).slice(before.launches.length);
    await expect.poll(() => launchesAfter().map((l) => l.id).sort().join(','), { timeout: 90_000 }).toBe('lead,worker');
    // The lead's first rest: the carried note, the room message, then the worker's end.
    const promptsOf = (who: string) => lines(promptsFile).filter((p) => p.id === who).map((p) => p.prompt as string);
    await expect.poll(() => promptsOf('lead').some((p) => /Helper/.test(p) && /before Tars restarted/.test(p)), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => promptsOf('lead').some((p) => p.includes('ROOM>> the gate is green')), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => promptsOf('lead').some((p) => /Build Worker/.test(p) && /finished its turn|is now idle/.test(p)), { timeout: 60_000 }).toBe(true);
    // Nobody at rest was started, a while later still.
    await new Promise((r) => setTimeout(r, 5_000));
    const after = launchesAfter();
    const leadPrompts = promptsOf('lead');
    const values = {
      killed, before, after,
      prompts: lines(promptsFile),
      statusesAfter: (await list2()).map((a) => [a.id, a.status, a.cliRunning]),
      carryOverAfter: JSON.parse(fs.readFileSync(path.join(privateDir, 'carry-over.json'), 'utf8')),
    };
    recordValues(values);

    const lead = after.find((l) => l.id === 'lead')!;
    const worker = after.find((l) => l.id === 'worker')!;
    expect(lead.resume && worker.resume).toBe(true);
    expect(worker.prompt).toMatch(/^\[Tars\] Tars stopped abruptly at \d\d:\d\d/);
    expect(worker.prompt).toMatch(/"Bash" was running: its outcome is unknown/);
    expect(worker.prompt).toContain(worker.TMPDIR);
    expect(worker.TMPDIR).toBe(before.launches.find((l) => l.id === 'worker').TMPDIR);
    expect(lead.prompt).toMatch(/"Build Worker" \(resumed too\)/);
    // The helper's link was spent when its end became news: that news is the note carried across the restart.
    expect(lead.prompt).not.toMatch(/Helper/);
    for (const resumed of [lead, worker]) expect(resumed.prompt).not.toMatch(/DELEGATE>>|LONG>>|ship 1\.9\.3|build the release/);
    expect(after.filter((l) => l.id === 'helper' || l.id === 'sleeper')).toEqual([]);
    expect(leadPrompts.filter((p) => /Helper/.test(p) && /before Tars restarted/.test(p))).toHaveLength(1);
    expect(leadPrompts.filter((p) => p.includes('ROOM>> the gate is green'))).toHaveLength(1);
    expect(values.carryOverAfter.notes).toEqual([]);
  } finally {
    await again.close();
  }
  const ended = JSON.parse(fs.readFileSync(path.join(privateDir, 'run-state.json'), 'utf8'));
  recordValues({ runStateAfterQuit: ended });
  expect(ended.cleanExit).toBe(true);
  expect(ended.resumed.sort()).toEqual(['lead', 'worker']);
  // Out of every agent's reach (the Audit's gate of #310): nothing of either in ~/.dorothy, each 0600.
  expect(['run-state.json', 'carry-over.json'].filter((f) => fs.existsSync(path.join(dir, f)))).toEqual([]);
  expect(['run-state.json', 'carry-over.json'].map((f) => fs.statSync(path.join(privateDir, f)).mode & 0o777)).toEqual([0o600, 0o600]);
});
