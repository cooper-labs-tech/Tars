import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Start, wake and stop live in a Dashboard terminal's menu, no longer in its header (JeanBrasse, 22/10: rarely used,
 * and risky where it was, beside fullscreen in every panel at once). Frame: `Dashboard header (2.0.5) · start, wake
 * and stop in the ··· menu`. The Agents page cards keep their buttons.
 *
 * Two agents run a stand-in for claude with Tars's own hooks (the one of agent-asleep-ui). On the Dashboard, in the
 * shell as it was and in the new interface, the worker's panel shows no start, wake or stop button; its menu starts
 * it, stops it, starts it again, and once the sleep pass has put it to sleep, wakes it on its own conversation. Each
 * by a click on the menu's item; each read back from main (cliRunning, the session, the launches the stand-in logs).
 *
 * The artefact: what each menu offered and what main said after each click, in values.json, and a screenshot of each.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string; waking?: Waking };
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
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, resume: resumed === -1 ? null : args[resumed + 1], prompt: launchPrompt });
// Tars's own hooks, as it installs them: the .sh under bash on macOS and Linux, their Node runner on Windows.
const hookCommand = (name) => (process.platform === 'win32'
  ? [process.execPath, [path.join(HOOKS, 'tars-hook.mjs'), name.replace(/\.sh$/, '')]]
  : ['/bin/bash', [path.join(HOOKS, name)]]);
const hook = (name, payload) => spawnSync(...hookCommand(name), {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id }, body: JSON.stringify(body),
});
async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  if (id === 'lead' && prompt.includes('TELL>>')) {
    const answer = await api('/api/agents/worker/message', { message: 'MSG>> the docs are yours' });
    record('calls.jsonl', { status: answer.status });
  }
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(300);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
process.stdin.setRawMode(true);
(async () => {
  // Woken, it takes its time to come up, as a real claude resuming a long conversation does.
  if (resumed !== -1) await sleep(4000);
  hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
  process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
  let buffer = '';
  let queue = Promise.resolve();
  if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
  process.stdin.on('data', (data) => {
    for (const ch of data.toString().replace(/\x1b\[20[01]~/g, '')) {
      if (ch === '\r') {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else buffer += ch;
    }
  });
})();
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`a dashboard terminal starts, stops and wakes from its menu, with no such button in its header${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-header-menu-'));
    const project = path.join(fs.realpathSync(home), 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const cli = writeNodeCli(path.join(bin, process.platform === 'win32' ? 'claude.cjs' : 'claude'), `const HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`);
    const agent = (id: string, name: string, role = 'worker') => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('worker', 'Build Worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const launchesFile = path.join(home, 'launches.jsonl');
    const dist = path.resolve('electron', 'dist');
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31544 : 31543), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      const panel = page.locator('[data-agent-panel="worker"]');
      const actions = /^(start|stop|wake)\b/;
      const menu = async (step: string) => {
        await panel.getByRole('button', { name: 'Panel actions', exact: true }).click();
        const items = await panel.locator('[aria-label="Panel actions"] + div button').allInnerTexts();
        seen[`menu-${step}`] = items;
        return items;
      };
      const pick = (name: string | RegExp) => panel.getByRole('button', { name, exact: typeof name === 'string' }).click();

    /** Every agent rested 40 minutes, and the pass that runs every minute, until it puts the worker to sleep. */
    const sleepWorker = async () => {
      await expect.poll(async () => {
        const checked = await app.evaluate(async (_e, { dist, windows }) => {
          const req = process.mainModule!.require;
          const { agents } = req(`${dist}/core/agent-manager.js`);
          const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
          for (const a of agents.values()) { a.statusSince = fortyMinutesAgo; a.lastTurnStartedAt = undefined; a.workHandedAt = undefined; }
          // Windows has no process table for the pass to read (agent-sleep.ts
          // reads ps: there it refuses every agent). It is
          // handed the one ps shows on macOS for these stand-ins, each CLI its
          // terminal's own process with nothing under it, so that what this spec
          // is about, an asleep agent's window and its wakes through the
          // Windows launch, is proven there too.
          const { ptyProcesses } = req(`${dist}/core/pty-manager.js`);
          const read = windows ? {
            procs: async () => [...agents.values()].filter((a) => a.ptyId && ptyProcesses.has(a.ptyId))
              .map((a) => ({ pid: ptyProcesses.get(a.ptyId).pid, ppid: process.pid, stat: 'S', age: 2400, command: 'node claude' })),
          } : undefined;
          return req(`${dist}/services/agent-sleep.js`).checkSleep(undefined, read) as Promise<Array<{ agentId: string; slept: boolean }>>;
        }, { dist, windows: process.platform === 'win32' });
        return checked.find((o) => o.agentId === 'worker')?.slept ?? (await get('worker')).status;
      }, { timeout: 30_000, intervals: [500] }).toBe(true);
      await expect.poll(async () => (await get('worker')).status).toBe('asleep');
    };

      // The header: no start, wake or stop button, the menu closed.
      await expect(panel).toBeVisible({ timeout: 90_000 });
      await expect(panel.getByRole('button', { name: actions }), 'no start, wake or stop in the header').toHaveCount(0);
      await stepShot(page, `${tag}-01-header`);

      // Start, from the menu.
      expect((await menu('idle'))[0]).toBe('start claude');
      await stepShot(page, `${tag}-02-menu-start`);
      await pick('start claude');
      await expect.poll(async () => { const a = await get('worker'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
      const firstSid = lines(launchesFile).find((l) => l.id === 'worker')!.sid as string;

      // Stop, from the menu.
      expect((await menu('running'))[0]).toBe('stop');
      await pick('stop');
      await expect.poll(async () => (await get('worker')).cliRunning === true, { timeout: 30_000 }).toBe(false);
      seen.afterStop = await get('worker');

      // Start again, then asleep: wake, from the menu, on its own conversation.
      expect((await menu('stopped'))[0]).toBe('start claude');
      await pick('start claude');
      await expect.poll(async () => { const a = await get('worker'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
      await sleepWorker();
      await expect(panel.getByRole('button', { name: actions }), 'asleep, still no button in the header').toHaveCount(0);
      expect((await menu('asleep'))[0]).toBe('wake');
      await stepShot(page, `${tag}-03-menu-wake`);
      const launches = lines(launchesFile).filter((l) => l.id === 'worker').length;
      await pick('wake');
      await expect.poll(() => lines(launchesFile).filter((l) => l.id === 'worker').length, { timeout: 30_000 }).toBe(launches + 1);
      await expect.poll(async () => { const w = await get('worker'); return `${w.status} ${w.cliRunning} ${!!w.waking}`; }, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed) true false$/);
      seen.wokeOn = lines(launchesFile).filter((l) => l.id === 'worker').at(-1)!.resume;
      seen.firstSid = firstSid;
      await stepShot(page, `${tag}-04-awake`);
      recordValues(seen);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
