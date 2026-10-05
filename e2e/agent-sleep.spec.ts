import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent with no turn for 30 minutes is put to sleep and woken on its own conversation when it is needed;
 * orchestrators are never put to sleep (JeanBrasse's choices 5 and 6 of 2026-10-05, RD-RAM.md 2.1), in the real app.
 *
 * Four agents, started from the window: the lead (the project's orchestrator), the worker, the busy worker (a
 * background job under its CLI) and the drafter (a half-typed line in its field). All are told to have rested for
 * 40 minutes, and the pass that runs every minute is run once:
 * - the worker is put to sleep: its CLI ends, it reads `asleep` since now, and its pane keeps its last screen;
 * - the lead, the busy worker and the drafter keep their CLI.
 * Then the worker is woken three times, each time on its own conversation (`--resume` and the session it slept in):
 * - a mouse report from its pane wakes nothing, and a key typed there does;
 * - a room message wakes it, reading `waking` with who woke it, and the message reaches the session that woke;
 * - the wake call does.
 * The run record never counts it as working, and /wait answers at once for an agent asleep.
 *
 * The CLIs are stand-ins named `claude` (node scripts, as an npm install of Claude Code is) that run Tars's own hook
 * scripts with the JSON Claude Code gives them, keep a transcript where Claude Code keeps it, and continue the
 * session `--resume` names, as Claude Code does.
 */

type Waking = { by: string; via: string; since: string };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string; waking?: Waking; launching?: boolean; output?: string[] };
type Room = { id: string; kind: string; memberIds: string[] };
type Api = { electronAPI: {
  agent: {
    start(p: { id: string; prompt: string }): Promise<unknown>;
    list(): Promise<Agent[]>;
    get(id: string): Promise<Agent>;
    sendInput(p: { id: string; input: string }): Promise<{ success: boolean }>;
    wake(id: string): Promise<{ success: boolean; error?: string }>;
  };
  bus: { listRooms(): Promise<Room[] | { rooms: Room[] }>; postMessage(p: { roomId: string; text: string; mentions?: string[] }): Promise<unknown> };
} };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
// As Claude Code: --resume <id> continues that session, in its own transcript.
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, resume: resumed === -1 ? null : args[resumed + 1], prompt: launchPrompt });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The busy worker left a job running under its CLI.
if (id === 'busy') spawn('/bin/sh', ['-c', 'exec sleep 600'], { stdio: 'ignore' });

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(300);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.search(/[\r\n]/)) !== -1) {
    const typed = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (typed.trim()) queue = queue.then(() => turn(typed));
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !String(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])).trim().startsWith('Z'); } catch { return false; }
};

test('an agent with no turn for 30 minutes is put to sleep, keeps its screen, and wakes on its own conversation', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-sleep-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker'), agent('busy', 'Busy Worker'), agent('drafter', 'Drafter'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const promptsFile = path.join(home, 'prompts.jsonl');
  const port = apiPort(31496);
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const api = () => (window as unknown as Api).electronAPI;
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
    const byId = async () => Object.fromEntries((await list()).map((a) => [a.id, a]));
    void api;

    for (const id of ['lead', 'worker', 'busy', 'drafter']) {
      await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    }
    await expect.poll(async () => (await list()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(4);
    // A half-typed line in the drafter's field, left there.
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'drafter', input: 'half a thought' }));
    await expect.poll(() => {
      const busyPid = lines(launchesFile).find((l) => l.id === 'busy')?.pid;
      return !!busyPid && String(execFileSync('ps', ['-A', '-o', 'ppid=,command='])).split('\n').some((l) => l.trim().startsWith(`${busyPid} `) && /sleep 600/.test(l));
    }, { timeout: 30_000, message: 'the busy worker has its job' }).toBe(true);
    const firstLaunch = Object.fromEntries(lines(launchesFile).map((l) => [l.id, l]));

    /** Every agent rested 40 minutes, then the pass that runs every minute, once. */
    const restAndCheck = () => app.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
      for (const a of agents.values()) {
        a.statusSince = fortyMinutesAgo;
        a.lastTurnStartedAt = undefined;
        a.workHandedAt = undefined;
      }
      return req(`${dist}/services/agent-sleep.js`).checkSleep();
    }, { dist });

    // ── Put to sleep ──
    const checked = await restAndCheck();
    const asleep = await byId();
    const screen = (await get('worker')).output?.join('') ?? '';
    const runState = JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'run-state.json'), 'utf8'));
    await expect.poll(() => alive(firstLaunch.worker.pid), { timeout: 15_000, message: 'the worker\'s CLI ended' }).toBe(false);
    const token = fs.readFileSync(path.join(dir, 'api-token'), 'utf8').trim();
    const wait = await fetch(`http://127.0.0.1:${port}/api/agents/worker/wait?timeout=30`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()) as { status: string; asleepSince?: string };
    recordValues({ checked, statuses: Object.fromEntries(Object.values(asleep).map((a) => [a.id, a.status])), workerAsleepSince: asleep.worker.asleepSince, screenHasWorker: screen.includes('SCREEN-OF-worker'), wait });

    expect(asleep.worker.status).toBe('asleep');
    expect(Date.now() - Date.parse(asleep.worker.asleepSince!)).toBeLessThan(60_000);
    expect(asleep.worker.cliRunning).toBe(false);
    expect(screen, 'the pane keeps the last screen of the CLI it slept in').toContain(`SCREEN-OF-worker session ${firstLaunch.worker.sid}`);
    expect(asleep.lead.status, 'an orchestrator is never put to sleep').not.toBe('asleep');
    expect(asleep.busy.status, 'a job under its CLI would die with it').not.toBe('asleep');
    expect(asleep.drafter.status, 'its half-typed line would be lost').not.toBe('asleep');
    for (const id of ['lead', 'busy', 'drafter']) expect(alive(firstLaunch[id].pid), id).toBe(true);
    expect(runState.working.map((w: { agentId: string }) => w.agentId)).not.toContain('worker');
    expect(wait.status).toBe('asleep');

    /** The worker's launches after the first, in order. */
    const wakes = () => lines(launchesFile).filter((l) => l.id === 'worker').slice(1);
    const sessionUp = async (n: number) => {
      await expect.poll(() => wakes().length, { timeout: 30_000 }).toBe(n);
      await expect.poll(async () => {
        const w = await get('worker');
        return `${w.status} ${w.cliRunning} ${!!w.waking} ${w.currentSessionId === firstLaunch.worker.sid}`;
      }, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed) true false true$/);
    };

    // ── A mouse report wakes nothing; a key does ──
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'worker', input: '\x1b[<0;12;7M\x1b[<0;12;7m\x1b[I' }));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(wakes(), 'a click in the pane woke it').toHaveLength(0);
    expect((await get('worker')).status).toBe('asleep');
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.sendInput({ id: 'worker', input: 'x' }));
    const byKey = await get('worker');
    await sessionUp(1);

    // ── A room message ──
    await restAndCheck();
    expect((await get('worker')).status).toBe('asleep');
    const rooms = await page.evaluate(() => (window as unknown as Api).electronAPI.bus.listRooms());
    const room = (Array.isArray(rooms) ? rooms : rooms.rooms).find((r) => r.kind === 'project' && r.memberIds.includes('worker'))!;
    await page.evaluate((r) => (window as unknown as Api).electronAPI.bus.postMessage({ roomId: r, text: 'ROOM>> rebuild the docs', mentions: ['worker'] }), room.id);
    const byRoom = await get('worker');
    await sessionUp(2);
    await expect.poll(() => lines(promptsFile).filter((p) => p.id === 'worker' && p.prompt.includes('ROOM>> rebuild the docs')).length, { timeout: 30_000 }).toBe(1);
    const roomPrompt = lines(promptsFile).find((p) => p.id === 'worker' && p.prompt.includes('ROOM>>'));

    // ── The wake call ──
    await restAndCheck();
    expect((await get('worker')).status).toBe('asleep');
    const woke = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.wake('worker'));
    const byCall = await get('worker');
    await sessionUp(3);
    const notAsleep = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.wake('lead'));

    recordValues({ wakes: wakes(), byKey: byKey.waking ?? byKey.status, byRoom: byRoom.waking ?? byRoom.status, byCall: byCall.waking ?? byCall.status, woke, notAsleep, roomPrompt });
    for (const w of wakes()) {
      expect(w.resume, 'woken on its own conversation').toBe(firstLaunch.worker.sid);
      expect(w.prompt, 'nothing typed for it').toBe('');
    }
    // Who woke it and how, while it woke (or already up, if its session beat the read).
    for (const [seen, via] of [[byKey, 'key'], [byRoom, 'chat'], [byCall, 'wake']] as const) {
      if (seen.waking) expect(seen.waking).toMatchObject({ via });
      else expect(seen.status).not.toBe('asleep');
    }
    expect(roomPrompt.sid).toBe(firstLaunch.worker.sid);
    expect(woke).toEqual({ success: true });
    expect(notAsleep.success).toBe(false);
    // The others never left their first CLI.
    expect(lines(launchesFile).filter((l) => l.id !== 'worker')).toHaveLength(3);
  } finally {
    await app.close().catch(() => { /* gone */ });
  }
});
