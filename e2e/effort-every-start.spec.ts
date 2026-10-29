import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { startFakeRelay } from '../__tests__/fixtures/fake-tars-relay';

/**
 * Every start of an agent's CLI runs at that agent's own effort (JeanBrasse, 2026-10-13: "la moitié du temps les agents se
 * réveillent avec le mauvais niveau d'effort par rapport à leur paramètre", and nothing tested it), in the real app.
 *
 * Six agents, each at its own level: the lead (the orchestrator) at max, and workers at low, medium, high and xhigh,
 * and one only ever handed a delegated task, at high. Each path that starts a CLI is driven once, and the effort the
 * CLI received is read from the argv the stand-in records (`--effort <level>`, as Claude Code takes it):
 * 1. a start from the window, for the five terminals;
 * 2. a restart (agent:restart), which continues the conversation under a new id;
 * 3. an effort changed in the agent's settings (agent:update), which restarts it at the new level;
 * 4. a wake from sleep (#322);
 * 5. the launch of the orchestrator for the user's Telegram message through Hermes (the relay), the orchestrator not
 *    running (until 2.0.5, Tars's own bot made it);
 * 6. a chat's runner, at its orchestrator's effort (#379's rule);
 * 7. a delegated task (run-task) to an agent whose CLI is not running: its permanent session is started with the
 *    task (2.0.4). Until 2.0.4 this read the effort a run over ACP set on its adapter; no task is run over ACP now;
 * 8. the resume after a crash: Tars and every CLI killed by PID mid-turn, then Tars started again.
 * Each check is soft, so one run names every path that loses the effort.
 *
 * The CLIs are stand-ins named `claude` (node scripts, as an npm install of Claude Code is) that run Tars's own hook
 * scripts, write their transcript where Claude Code does, continue the session `--resume` names (a new one with
 * `--fork-session`), and record each launch's argv.
 */

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
record('launches.jsonl', { pid: process.pid, sid, resume: flag('--resume'), fork: forked, effort: flag('--effort'), argv: args });
record('tokens.jsonl', { token: process.env.CLAUDE_MGR_API_TOKEN || null });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  // A turn told to hold runs until the CLI is killed: what a crash finds.
  if (prompt.includes('HOLD>>')) { while (true) await sleep(1000); }
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
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
      } else if (ch === '\x7f') buffer = buffer.slice(0, -1);
      else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

type Agent = { id: string; kind?: string; chatId?: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Launch = { id: string; pid: number; sid: string; resume: string | null; fork: boolean; effort: string | null; argv: string[] };
type Answer = Record<string, unknown>;
const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Each agent's own level. */
const EFFORT: Record<string, string> = { lead: 'max', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', dl: 'high' };

function seedProject(home: string) {
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  fs.mkdirSync(project, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com', HOME: home };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  git(home, 'init', '-q', '--bare', origin);
  git(home, 'init', '-q', '-b', 'main', project);
  fs.writeFileSync(path.join(project, 'README.md'), 'demo\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'main');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  return project;
}

test('every start of an agent\'s CLI runs at that agent\'s own effort: window, restart, settings, wake, bot, chat, delegated task, crash', async () => {
  test.setTimeout(480_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-effort-'));
  const project = seedProject(home);
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal', effort: EFFORT[id],
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Lead', 'orchestrator'), agent('low', 'Low Worker'), agent('medium', 'Medium Worker'),
    agent('high', 'High Worker'), agent('xhigh', 'Xhigh Worker'), agent('dl', 'Delegated Worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  // The relay to the user's Hermes: the tars-relay plugin's stand-in.
  const hermes = await startFakeRelay('e2e-hermes-token');
  // The stand-in first on every launch's PATH (the bots take the binary from it).
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] },
    hermesRelayEnabled: true,
    // E2E_NEW_INTERFACE=1: the same run in the new interface's shell.
    newInterface: process.env.E2E_NEW_INTERFACE === '1',
  }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const launchesOf = (id: string) => lines<Launch>(launchesFile).filter((l) => l.id === id);
  const port = apiPort(31438);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, newInterface: process.env.E2E_NEW_INTERFACE === '1' };
  /** What each path started, with the effort the CLI received and the agent's own. */
  const seen: Array<{ path: string; agent: string; received: string | null; own: string }> = [];
  const keep = () => { values.seen = seen; recordValues(values); };
  const check = (pathName: string, id: string, received: string | null, own = EFFORT[id]) => {
    seen.push({ path: pathName, agent: id, received, own });
    keep();
    expect.soft(received, `${pathName}: ${id} received --effort ${received} instead of its own ${own}`).toBe(own);
  };

  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '20' },
  });
  const open = async (app: ElectronApplication) => {
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    // The shell this run is in (E2E_NEW_INTERFACE=1: the new interface's).
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(process.env.E2E_NEW_INTERFACE === '1' ? 1 : 0, { timeout: 30_000 });
    const call = (ns: string, name: string, ...args: unknown[]) => page.evaluate(([ns, name, args]) => {
      const api = (window as unknown as { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<Answer>>> }).electronAPI;
      return api[ns as string][name as string](...(args as unknown[]));
    }, [ns, name, args] as const);
    const fleet = async () => await call('agent', 'list') as unknown as Agent[];
    const agentOf = async (id: string) => (await fleet()).find((a) => a.id === id);
    return { page, call, fleet, agentOf };
  };
  /** The next launch of an agent after `n`, once its CLI holds a session. */
  const nextLaunch = async (id: string, n: number, agentOf: (id: string) => Promise<Agent | undefined>) => {
    await expect.poll(() => launchesOf(id).length, { timeout: 60_000, message: `${id} was launched again` }).toBeGreaterThan(n);
    const next = launchesOf(id)[n];
    await expect.poll(async () => (await agentOf(id))?.currentSessionId ?? null, { timeout: 60_000 }).toBe(next.sid);
    return next;
  };

  let app = await launch();
  try {
    const { call, fleet, agentOf } = await open(app);
    const atRest = (id: string) => expect.poll(async () => (await agentOf(id))?.status, { timeout: 30_000 }).toMatch(/^(idle|completed|waiting)$/);

    // ── 1. A start from the window ──
    for (const id of ['lead', 'low', 'medium', 'high', 'xhigh']) await call('agent', 'start', { id, prompt: '' });
    await expect.poll(async () => (await fleet()).filter((a) => a.cliRunning && a.currentSessionId).length, { timeout: 90_000 }).toBe(5);
    for (const id of ['lead', 'low', 'medium', 'high', 'xhigh']) check('window start', id, launchesOf(id)[0].effort);

    // ── 2. A restart ──
    await atRest('high');
    expect(await call('agent', 'restart', 'high')).toMatchObject({ success: true });
    check('restart', 'high', (await nextLaunch('high', 1, agentOf)).effort);

    // ── 3. The effort changed in the agent's settings ──
    await atRest('medium');
    expect(await call('agent', 'update', { id: 'medium', effort: 'max' })).toMatchObject({ success: true });
    EFFORT.medium = 'max';
    check('settings changed', 'medium', (await nextLaunch('medium', 1, agentOf)).effort);

    // ── 4. Asleep, then woken ──
    await atRest('low');
    const restAndCheck = () => app.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
      const low = agents.get('low');
      low.statusSince = fortyMinutesAgo;
      low.lastTurnStartedAt = undefined;
      low.workHandedAt = undefined;
      return req(`${dist}/services/agent-sleep.js`).checkSleep() as Promise<Array<{ agentId: string; slept: boolean; why?: string }>>;
    }, { dist });
    await expect.poll(async () => (await restAndCheck()).find((o) => o.agentId === 'low')?.slept ?? false, { timeout: 30_000, intervals: [500] }).toBe(true);
    await expect.poll(async () => (await agentOf('low'))?.status, { timeout: 15_000 }).toBe('asleep');
    expect(await call('agent', 'wake', 'low')).toMatchObject({ success: true });
    check('wake from sleep', 'low', (await nextLaunch('low', 1, agentOf)).effort);

    // ── 5. The user's Telegram message, through Hermes, starts the orchestrator ──
    await atRest('lead');
    await call('agent', 'stop', 'lead');
    await expect.poll(async () => (await agentOf('lead'))?.cliRunning ?? false, { timeout: 30_000 }).toBe(false);
    const leadLaunches = launchesOf('lead').length;
    await app.evaluate((_e, { dist, port, token }) => {
      const req = process.mainModule!.require;
      req(`${dist}/services/hermes-config.js`).writeHermesConnection({ mode: 'local', localPort: port, authMode: 'token', token });
    }, { dist, port: hermes.port, token: hermes.token });
    hermes.projectMessage('demo', 'TG>> what is left for the release?');
    await expect.poll(() => launchesOf('lead').length, { timeout: 60_000, message: 'the relay started the orchestrator' }).toBeGreaterThan(leadLaunches);
    check('Telegram through Hermes', 'lead', launchesOf('lead')[leadLaunches].effort);
    await atRest('lead');

    // ── 6. A chat's runner, at its orchestrator's effort ──
    const chat = await call('chat', 'create', { projectPath: project, title: 'Release' }) as unknown as { id: string };
    expect(await call('chat', 'send', { chatId: chat.id, text: 'CHAT>> hello', clientRequestId: 'e2e-chat' })).toMatchObject({ success: true });
    await expect.poll(async () => (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chat.id)?.id ?? null, { timeout: 60_000 }).not.toBeNull();
    const runner = (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chat.id)!;
    await expect.poll(() => launchesOf(runner.id).length, { timeout: 60_000 }).toBeGreaterThan(0);
    check('chat runner', runner.id, launchesOf(runner.id)[0].effort, EFFORT.lead);
    values.runnerId = runner.id;

    // ── 7. A delegated task, its agent's CLI not running: its session started with the task ──
    const leadToken = lines<{ id: string; token: string | null }>(path.join(home, 'tokens.jsonl')).filter((l) => l.id === 'lead' && l.token).at(-1)!.token!;
    const handed = await fetch(`http://127.0.0.1:${port}/api/agents/dl/run-task`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
      body: JSON.stringify({ task: 'DELEGATED>> review the notes', answer: 'started' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Answer }));
    values.delegated = handed;
    await expect.poll(() => launchesOf('dl').length, { timeout: 60_000, message: 'the delegated task started the agent\'s session' }).toBeGreaterThan(0);
    check('delegated task', 'dl', launchesOf('dl')[0].effort);
    await atRest('dl');

    // ── 8. A crash mid-turn, then Tars started again ──
    await atRest('xhigh');
    await call('agent', 'sendInput', { id: 'xhigh', input: 'HOLD>> the long migration\r' });
    await expect.poll(async () => (await agentOf('xhigh'))?.status, { timeout: 30_000 }).toBe('running');
    await new Promise((r) => setTimeout(r, 1_500));
    values.beforeCrash = Object.fromEntries((await fleet()).map((a) => [a.id, a.status]));
    keep();
    const killed = [app.process().pid!, ...lines<Launch>(launchesFile).map((l) => l.pid)];
    for (const pid of killed) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ } }
    await new Promise((r) => setTimeout(r, 2_000));
  } catch (err) {
    keep();
    await app.close().catch(() => undefined);
    await hermes.close();
    throw err;
  }

  const crashedAt = lines<Launch>(launchesFile).length;
  app = await launch();
  try {
    const { agentOf } = await open(app);
    await expect.poll(() => lines<Launch>(launchesFile).slice(crashedAt).some((l) => l.id === 'xhigh'), { timeout: 90_000, message: 'the agent cut mid-turn was resumed' }).toBe(true);
    const resumed = lines<Launch>(launchesFile).slice(crashedAt);
    values.resumedAfterCrash = resumed.map((l) => ({ id: l.id, effort: l.effort, resume: l.resume }));
    for (const l of resumed) check('resume after a crash', l.id, l.effort, EFFORT[l.id] ?? EFFORT.lead);
    await expect.poll(async () => (await agentOf('xhigh'))?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
  } finally {
    keep();
    await app.close();
    await hermes.close();
  }
});
