import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The banner above an agent's terminal (design PR #451, on #453's contract: taskBanner on agent:list, agent:task
 * pushed, agent:task-stop): who gave the task in hand, since when, its first line, the tasks that wait behind it, and
 * stop task, which ends that task only.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server run with the identity Tars hands agent `lead`.
 * Agent `dev` is a claude agent whose CLI is a stand-in that does what Claude Code does around a turn (its hooks, its
 * transcript); a SLOW task holds its turn until Esc, which writes the interrupt into the transcript, as Claude Code does.
 *
 * Asserted, once with the classic shell and once with the new interface, on the Dashboard:
 * 1. lead delegates a SLOW task to dev, then a second SLOW one: dev's panel shows the banner, from Project Lead, with the
 *    first task's first line and "1 waiting", and the list it opens names the second task and who gave it; the list
 *    closes again. A banner 560 px wide or more says "Task from" (the frames' wide layout: its width is the pane's, the
 *    padding not taken off), and stop task is drawn as the panel header's stop: 11 px, not in the main ink;
 * 2. stop task ends that task only: the turn is interrupted and the session stays. Then the banner is the second task's
 *    own: its first line, from Project Lead, since the time that task went in; and no banner shows the first task;
 * 3. stop task on the second, once its turn runs: the banner goes.
 * Red on main (d96be134): no banner is drawn, though agent:list carries it. Point 2 red on the QA's mutant of the banner
 * that shows the first task it saw and never a later one (TaskBanner.tsx.mutant2, qa-451-1810): the QA's gate found it
 * green when point 2 read the first banner, whose open list held the second task. Point 1's width and stop task red
 * on 714f4add (the container measured inside the padding; stop task the app's small Button).
 * The artefact: values.json (the banner and the list as read, the tool answers, the stand-in's log), the screenshots.
 */

const HOOKS = path.resolve('hooks');
const LONG = 'unused';

/** Claude Code around each turn: its hooks, and one transcript line per reply, with text and usage. */
const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, sid, pid: process.pid, ...entry }) + '\n');
const hook = (name, payload) => {
  const out = spawnSync('/bin/bash', [path.join(HOOKS, name)], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }),
    env: process.env, timeout: 20000, encoding: 'utf8',
  });
  log({ hook: name, exit: out.status });
};
let n = 0;
const reply = (text, input, output) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', requestId: 'req_' + id + '_' + (++n), timestamp: new Date().toISOString(),
  message: { id: 'msg_' + id + '_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output } },
}) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopNow = null;
async function turn(prompt) {
  log({ turn: prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\n');
  reply('Reading it now.', 100000, 0);
  if (prompt.includes('SLOW')) {
    // Held until Esc, as a long turn is: Claude Code then writes the interrupt into the transcript and runs no Stop hook.
    const stopped = await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 90000); stopNow = () => { clearTimeout(t); resolve(true); }; });
    stopNow = null;
    if (stopped) {
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
      log({ interrupted: prompt });
      return;
    }
  }
  reply('Task done: the tests pass.', 200000, 50000);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: process.argv.slice(2) });
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
const dashes = process.argv.indexOf('--');
if (dashes !== -1 && process.argv.slice(dashes + 1).join(' ').trim()) queue = queue.then(() => turn(process.argv.slice(dashes + 1).join(' ')));
let pasting = false;
process.stdin.on('data', (data) => {
  if (data.toString() === '\x1b') { log({ esc: true }); stopNow?.(); return; }
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

type Banner = { task: { ref: string; from: string; startedAt: string; firstLine: string } | null; waiting: Array<{ ref: string; from: string; firstLine: string }> };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; lastTurnStartedAt?: string; taskBanner?: Banner };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]>; get(id: string): Promise<Agent | null> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; source: string; requesterAgentId: string | null; outcome: string; sessionIds: string[]; costUSD: number | null }> }> };
} };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`the banner above an agent's terminal shows its task, who gave it, what waits, and stops that task only${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-task-banner-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst LONG = ${JSON.stringify(LONG)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal', cliPath: claude,
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('dev', 'Build Agent', 'worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31447 : 31433);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const pageErrors: string[] = [];

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
      await expect.poll(async () => { const a = await get('dev'); return !!(a?.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
      const devSession = (await get('dev'))!.currentSessionId;

      const identity = await app.evaluate((_e, { dist }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { token: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
          CLAUDE_AGENT_ID: 'lead', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
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
        mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      const tool = async (name: string, args: Record<string, unknown>) => {
        const reply = await rpc('tools/call', { name, arguments: args });
        return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      };
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      // 1. A SLOW task in hand, a second one waiting: the banner says both.
      const first = tool('delegate_task', { id: 'dev', prompt: 'SLOW review the release notes', timeoutSeconds: 240, clientRequestId: `e2e-banner-1-${newInterface}` });
      await expect.poll(() => lines(path.join(home, 'stand-in.jsonl')).filter((e) => typeof e.turn === 'string' && e.turn.includes('SLOW')).length, { timeout: 60_000 }).toBe(1);
      const second = tool('delegate_task', { id: 'dev', prompt: 'SLOW run the tests', timeoutSeconds: 240, clientRequestId: `e2e-banner-2-${newInterface}` });
      await expect.poll(async () => (await get('dev'))?.taskBanner?.waiting.length ?? 0, { timeout: 30_000 }).toBe(1);
      const banner = page.locator('[data-task-banner]').filter({ hasText: 'SLOW review the release notes' });
      await expect.soft(banner, 'the banner shows the task in hand').toBeVisible({ timeout: 20_000 });
      const count = banner.getByRole('button', { name: /1 waiting/ });
      const seen: Record<string, unknown> = { bannerText: (await banner.count()) ? await banner.innerText() : null };
      const list = page.getByRole('list', { name: 'Tasks waiting' });
      if (await count.count()) {
        await count.click();
        seen.listText = (await list.count()) ? await list.innerText() : null;
      }
      await stepShot(page, '01-banner-one-waiting');
      expect.soft(String(seen.bannerText ?? ''), 'who gave it').toContain('Project Lead');
      expect.soft(String(seen.listText ?? ''), 'the list names the waiting task').toContain('run the tests');
      // Closed again before stop task: open, the first banner's list holds the second task's line.
      if (await count.count()) await count.click();
      await expect.soft(list, 'the list closes again').toHaveCount(0);
      // The frames' widths are the pane's: 560 px and up, "Task from ... since 14:02 · 4 min".
      seen.bannerWidth = (await banner.boundingBox())?.width ?? null;
      if ((seen.bannerWidth as number) >= 560) {
        await expect.soft(banner.getByText('Task', { exact: true }), 'a banner 560 px wide or more says "Task from"').toBeVisible();
      }
      // stop task as the panel header draws its stop: 11 px, and not in the main ink the task's first line is in.
      const stopButton = banner.getByRole('button', { name: 'stop task' });
      seen.stopTask = await stopButton.evaluate((el) => {
        const line = el.closest('[data-task-banner]')?.querySelector('p[title]');
        return { fontSize: getComputedStyle(el).fontSize, color: getComputedStyle(el).color, lineColor: line ? getComputedStyle(line).color : null };
      }).catch(() => null);
      const stopStyle = seen.stopTask as { fontSize: string; color: string; lineColor: string | null } | null;
      expect.soft(stopStyle?.fontSize, 'stop task at 11 px, as the header\'s stop').toBe('11px');
      expect.soft(stopStyle && stopStyle.color !== stopStyle.lineColor, 'stop task in the grey of the header\'s stop, not the main ink').toBe(true);
      keep({ seen, devSession });

      // 2. stop task: that task only. The turn ends, the session stays, the waiting task goes in.
      // Clicked once its turn runs, as Tars asks: a task typed into the terminal whose turn the CLI has not yet
      // reported (its UserPromptSubmit hook) is refused, "its turn not begun: stop it once its turn runs"
      // (services/task-banner.ts). The classic shell's run of 18/10 21:43 clicked 0.3 s before that hook.
      const slowAt = Date.parse(lines(path.join(home, 'stand-in.jsonl')).find((e) => typeof e.turn === 'string' && e.turn.includes('SLOW'))?.at ?? '');
      await expect.poll(async () => Date.parse((await get('dev'))?.lastTurnStartedAt ?? '') >= slowAt, { timeout: 30_000 }).toBe(true);
      if (await banner.count()) await banner.getByRole('button', { name: 'stop task' }).click();
      // The second task's own banner, not the first's: its first line, who gave it and since when.
      const nextLine = page.locator('[data-task-banner] p[title="SLOW run the tests"]');
      await expect(nextLine, 'the second task is in hand, in a banner of its own').toBeVisible({ timeout: 30_000 });
      // `has` reads its locator inside each banner: the first line's own selector, not the page-wide one.
      const next = page.locator('[data-task-banner]').filter({ has: page.locator('p[title="SLOW run the tests"]') });
      await expect.soft(page.locator('[data-task-banner] p[title="SLOW review the release notes"]'), 'no banner shows the first task').toHaveCount(0);
      const inHand = (await get('dev'))?.taskBanner?.task ?? null;
      const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
      const afterStop = { text: await next.innerText(), label: await next.getAttribute('aria-label'), task: inHand };
      keep({ afterStop });
      await stepShot(page, '02-next-task-in-hand');
      expect.soft(inHand?.firstLine, 'the task in hand is the second one').toBe('SLOW run the tests');
      expect.soft(afterStop.label, 'the second task\'s sender').toBe('Task from Project Lead');
      expect.soft(afterStop.text, 'the second task\'s time, when it went in').toContain(inHand ? clock(inHand.startedAt) : 'no task in hand');
      const one = await first;
      keep({ one });
      expect.soft(lines(path.join(home, 'stand-in.jsonl')).some((e) => e.esc === true), 'Esc reached the terminal').toBe(true);
      expect.soft((await get('dev'))?.currentSessionId, 'the session stays').toBe(devSession);

      // 3. stop task on the second once its turn runs: the banner goes.
      const secondAt = () => Date.parse(lines(path.join(home, 'stand-in.jsonl')).find((e) => typeof e.turn === 'string' && e.turn.includes('SLOW run the tests'))?.at ?? '');
      await expect.poll(async () => { const at = secondAt(); return !Number.isNaN(at) && Date.parse((await get('dev'))?.lastTurnStartedAt ?? '') >= at; }, { timeout: 30_000 }).toBe(true);
      if (await next.count()) await next.getByRole('button', { name: 'stop task' }).click();
      const two = await second;
      await expect.soft(page.locator('[data-task-banner]'), 'no task, no banner').toHaveCount(0, { timeout: 30_000 });
      keep({ two, standIn: lines(path.join(home, 'stand-in.jsonl')), pageErrors });
      expect.soft(pageErrors, 'no page error').toEqual([]);
    } finally {
      mcp?.kill();
      await app.close();
      removeHome(home);
    }
  });
}
