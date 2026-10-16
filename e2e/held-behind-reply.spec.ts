import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A message to an idle agent goes in, whatever its mounted panel answers the terminal (bug-held-forever-05-10.md:
 * three agents idle at their prompt, a message held for each for 2 h 20 to 2 h 40).
 *
 * The CLI is a stand-in named `claude` (a node script, as an npm install of Claude Code is) that asks the terminal for
 * its background colour, `ESC ] 11 ; ? ST`, the query Claude Code 2.1.289 carries. The panel mounted on the Dashboard
 * is an xterm, which answers it (`ESC ] 11 ; rgb:.... ST`), and the panel passed what xterm answers on to the main
 * process as if it were typed. Read as keys, that answer made the field's draft unknown, and every message after it
 * waited for a person to send or clear a field that was empty. Then a room message to the agent, at rest: it must reach
 * the CLI, and the agent must not read running before it does.
 *
 * The answer is sent through agent:input by the spec itself, in both endings, as the panel sent it: the panels no
 * longer pass it on (#316), and this spec is the main process's own guard, which any other sender of agent:input meets.
 */

type Agent = { id: string; status: string; cliRunning?: boolean };
type Room = { id: string; kind: string; memberIds: string[] };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> };
  bus: { listRooms(): Promise<Room[] | { rooms: Room[] }>; postMessage(p: { roomId: string; text: string; mentions?: string[] }): Promise<unknown> };
} };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const log = (o) => fs.appendFileSync(process.env.HOME + '/stand-in.jsonl', JSON.stringify({ at: Date.now(), ...o }) + '\n');
// Its session registers as Claude Code's does, through Tars's own hook: until then, Tars types nothing into it.
// Windows runs that hook through the Node runner, macOS and Linux through bash.
const sid = crypto.randomUUID();
const [hookRunner, ...hookArgs] = process.platform === 'win32'
  ? [process.execPath, path.join(HOOKS, 'tars-hook.mjs'), 'session-start']
  : ['/bin/bash', path.join(HOOKS, 'session-start.sh')];
spawnSync(hookRunner, hookArgs, {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'startup' }), env: process.env, timeout: 20000,
});
process.stdin.setRawMode(true);
process.stdout.write('stand-in ready\r\n> ');
process.stdin.on('data', (d) => log({ stdin: d.toString() }));
// As Claude Code asks: the background colour, terminated by ST. Twice, a moment apart, as a redraw would.
setTimeout(() => { process.stdout.write('\x1b]11;?\x1b\\'); log({ asked: 'OSC 11' }); }, 3000);
setTimeout(() => { process.stdout.write('\x1b]11;?\x07'); log({ asked: 'OSC 11 BEL' }); }, 5000);
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a message to an idle agent goes in after its panel answered the terminal's colour query", async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-held-'));
  const project = path.join(home, 'projects', 'held');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows,
  // `claude.cmd` running `claude.cjs` there, as npm's shim runs Claude Code's .js.
  const script = path.join(bin, process.platform === 'win32' ? 'claude.cjs' : 'claude');
  const cli = writeNodeCli(script, `const HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`);
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'worker', name: 'Held Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-05T08:00:00.000Z', lastActivity: '2026-10-05T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const standIn = path.join(home, 'stand-in.jsonl');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31466), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI, null, { timeout: 120_000 });
    // Every chunk the panel sends to the main process, recorded before the handler gets it.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __rec: unknown[] };
      g.__rec = [];
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
      const h = handlers.get('agent:input')!;
      handlers.set('agent:input', async (event: unknown, ...args: unknown[]) => {
        g.__rec.push((args[0] as { input?: string })?.input);
        return h(event, ...args);
      });
    });
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());

    // Its panel on the Dashboard, and the agent started from it.
    const start = page.locator('button[title^="Start "]').first();
    await expect.poll(() => start.count(), { timeout: 120_000 }).toBeGreaterThan(0);
    await start.click();
    await expect.poll(async () => (await list()).find((a) => a.id === 'worker')?.cliRunning, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => !!(await list()).find((a) => a.id === 'worker' && (a as { currentSessionId?: string }).currentSessionId), { timeout: 60_000 }).toBe(true);
    // The two queries asked, and the panel's answers come back.
    await expect.poll(() => lines(standIn).filter((l) => l.asked).length, { timeout: 30_000 }).toBe(2);
    await new Promise((r) => setTimeout(r, 2_000));
    // The answer, as a panel passed it on before #316, in both endings.
    for (const reply of ['\x1b]11;rgb:0f0f/0f0f/0f0f\x1b\\', '\x1b]11;rgb:0f0f/0f0f/0f0f\x07']) {
      await page.evaluate((input) => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } })
        .electronAPI.agent.sendInput({ id: 'worker', input }), reply);
    }
    const fromPanel = await app.evaluate(() => (globalThis as unknown as { __rec: string[] }).__rec);
    const answers = lines(standIn).filter((l) => l.stdin).map((l) => l.stdin as string);

    // A room message to the agent, at rest.
    const rooms = await page.evaluate(() => (window as unknown as Api).electronAPI.bus.listRooms());
    const room = (Array.isArray(rooms) ? rooms : rooms.rooms).find((r) => r.kind === 'project' && r.memberIds.includes('worker'))!;
    await page.evaluate((r) => (window as unknown as Api).electronAPI.bus.postMessage({ roomId: r, text: 'HELD>> run the gate', mentions: ['worker'] }), room.id);
    const typedIn = await expect.poll(() => lines(standIn).some((l) => typeof l.stdin === 'string' && l.stdin.includes('HELD>> run the gate')), { timeout: 20_000 })
      .toBe(true).then(() => true, () => false);
    const statusAfter = (await list()).find((a) => a.id === 'worker')?.status;

    recordValues({ fromPanel, answers, typedIn, statusAfter, standIn: lines(standIn) });
    expect(fromPanel.some((c) => /\x1b\]11;rgb:/.test(c)), 'the answer reached the main process as typed input').toBe(true);
    expect(typedIn, 'the room message reached the CLI').toBe(true);
  } finally {
    await app.close();
  }
});
