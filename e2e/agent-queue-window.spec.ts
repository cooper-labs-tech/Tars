import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent's queue in its panel (2.0.5, lot 2, item I; frames `Agent queue (2.0.5) · in its panel` and `· states`,
 * design PR 535), on the Database Engineer's queue (the `agentQueue` channel the frames' notes ask for). Red until
 * that backend is stacked under the window.
 *
 * The real app on a sandbox HOME, the real orchestrator MCP server with the identity Tars hands agent `lead`, and agent
 * `dev` on the stand-in of Claude Code that task-banner.spec.ts uses (a SLOW task holds its turn until Esc).
 *
 * How it can fail, written before the code:
 * 1. the waiting list has no pause, no cancel, no move to the head, or offers them although this Tars has no queue
 *    behind them;
 * 2. move to the head does not change the order the tasks will run in;
 * 3. cancel goes without asking once, or asked and kept still cancels, or cancels another task, or the asker is not
 *    told (its delegate_task answers that it was cancelled);
 * 4. pause lets a task go in when the task in hand ends; the task in hand is touched by a pause;
 * 5. paused and nothing in hand, the panel shows nothing of what waits;
 * 6. resume does not let the next task go in;
 * 7. an uncaught error in the page.
 * Asserted once with the classic shell and once with the new interface, on the Dashboard.
 * The artefact: values.json (the list as read at each step, the tool answers, the stand-in's log), the screenshots.
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
process.stdin.on('data', (data) => {
  if (data.toString() === '\x1b') { log({ esc: true }); stopNow?.(); return; }
  buffer += data.toString();
  let end;
  while ((end = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (line.trim()) queue = queue.then(() => turn(line));
  }
});
process.stdin.resume();
`;

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; lastTurnStartedAt?: string; taskBanner?: { task: { firstLine: string } | null; waiting: Array<{ firstLine: string }> } };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<Agent | null> } } };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`an agent's queue in its panel: move to the head, cancel once asked, pause keeps a task from going in, resume lets it${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-queue-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst LONG = ${JSON.stringify(LONG)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal', cliPath: claude,
      createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('dev', 'Build Agent', 'worker')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31566 : 31565);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const pageErrors: string[] = [];
    const tag = newInterface ? 'new-' : '';

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const hasQueue = await page.evaluate(() => Boolean((window.electronAPI as unknown as { agentQueue?: unknown }).agentQueue));
      keep({ hasQueue });
      expect(hasQueue, 'this Tars has the queue\'s channel (the Database Engineer\'s, lot 2 item I)').toBe(true);
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
      await expect.poll(async () => { const a = await get('dev'); return !!(a?.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);

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
      const turns = () => lines(path.join(home, 'stand-in.jsonl')).filter((e) => typeof e.turn === 'string').map((e) => e.turn as string);

      // A task in hand, two waiting behind it.
      const first = tool('delegate_task', { id: 'dev', prompt: 'SLOW review the release notes', timeoutSeconds: 360, clientRequestId: `e2e-queue-1-${newInterface}` });
      await expect.poll(() => turns().filter((t) => t.includes('SLOW review')).length, { timeout: 60_000 }).toBe(1);
      const second = tool('delegate_task', { id: 'dev', prompt: 'SLOW run the tests', timeoutSeconds: 360, clientRequestId: `e2e-queue-2-${newInterface}` });
      const third = tool('delegate_task', { id: 'dev', prompt: 'SLOW write the changelog', timeoutSeconds: 360, clientRequestId: `e2e-queue-3-${newInterface}` });
      await expect.poll(async () => (await get('dev'))?.taskBanner?.waiting.length ?? 0, { timeout: 30_000 }).toBe(2);

      // 1. The list and its controls.
      const banner = page.locator('[data-task-banner]').filter({ hasText: 'SLOW review the release notes' });
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await banner.getByRole('button', { name: /2 waiting/ }).click();
      const list = page.getByRole('list', { name: 'Tasks waiting' });
      const order = async () => list.getByRole('listitem').evaluateAll((els) => els.map((e) => e.querySelector('[data-first-line]')?.textContent ?? ''));
      await expect(list).toBeVisible();
      keep({ before: await order() });
      expect(await order()).toEqual(['SLOW run the tests', 'SLOW write the changelog']);
      const queuePanel = page.locator('[data-queue-list]');
      await expect(queuePanel.getByRole('button', { name: 'pause' })).toBeVisible();
      await stepShot(page, `${tag}1-list`);

      // 2. Move the third to the head.
      await list.getByRole('listitem').nth(1).getByRole('button', { name: 'Move to the head' }).click();
      await expect.poll(order, { timeout: 15_000 }).toEqual(['SLOW write the changelog', 'SLOW run the tests']);
      await expect.poll(async () => (await get('dev'))?.taskBanner?.waiting.map((w) => w.firstLine), { timeout: 15_000 }).toEqual(['SLOW write the changelog', 'SLOW run the tests']);

      // 3. Cancel asks once; keep keeps it; cancel it cancels that one only, and its asker is told.
      const tests = list.getByRole('listitem').filter({ hasText: 'SLOW run the tests' });
      await tests.getByRole('button', { name: 'Cancel' }).click();
      await expect(queuePanel.getByText(/Cancel this task\?/)).toBeVisible();
      await queuePanel.getByRole('button', { name: 'keep' }).click();
      expect(await order()).toEqual(['SLOW write the changelog', 'SLOW run the tests']);
      await tests.getByRole('button', { name: 'Cancel' }).click();
      await queuePanel.getByRole('button', { name: 'cancel it' }).click();
      await expect.poll(order, { timeout: 15_000 }).toEqual(['SLOW write the changelog']);
      const two = await second;
      keep({ two });
      expect(two.text).toMatch(/cancel/i);
      await stepShot(page, `${tag}2-moved-cancelled`);

      // 4. Pause, then stop the task in hand: nothing goes in.
      await queuePanel.getByRole('button', { name: 'pause' }).click();
      await expect(queuePanel.getByRole('button', { name: 'resume' })).toBeVisible({ timeout: 15_000 });
      const slowAt = Date.parse(lines(path.join(home, 'stand-in.jsonl')).find((e) => typeof e.turn === 'string' && e.turn.includes('SLOW review'))?.at ?? '');
      await expect.poll(async () => Date.parse((await get('dev'))?.lastTurnStartedAt ?? '') >= slowAt, { timeout: 30_000 }).toBe(true);
      await banner.getByRole('button', { name: 'stop task' }).click();
      await first;
      await page.waitForTimeout(8_000);
      keep({ turnsWhilePaused: turns() });
      expect(turns().some((t) => t.includes('SLOW write the changelog')), 'paused: nothing went in').toBe(false);

      // 5. Paused, nothing in hand: the panel still says what waits.
      const strip = page.locator('[data-queue-strip]');
      await expect(strip).toBeVisible({ timeout: 15_000 });
      await expect(strip).toContainText('1 waiting');
      await expect(strip).toContainText(/paused/i);
      await stepShot(page, `${tag}3-paused-strip`);

      // 6. Resume: the next goes in.
      await strip.getByRole('button', { name: 'resume' }).click();
      await expect.poll(() => turns().some((t) => t.includes('SLOW write the changelog')), { timeout: 60_000 }).toBe(true);
      await expect(page.locator('[data-task-banner]').filter({ hasText: 'SLOW write the changelog' })).toBeVisible({ timeout: 30_000 });
      await stepShot(page, `${tag}4-resumed`);
      const next = page.locator('[data-task-banner]').filter({ hasText: 'SLOW write the changelog' });
      await expect.poll(async () => Date.parse((await get('dev'))?.lastTurnStartedAt ?? '') > slowAt, { timeout: 30_000 }).toBe(true);
      await next.getByRole('button', { name: 'stop task' }).click();
      keep({ three: await third, standIn: lines(path.join(home, 'stand-in.jsonl')) });

      // 7.
      keep({ pageErrors });
      expect(pageErrors).toEqual([]);
    } finally {
      mcp?.kill();
      await app.close();
      removeHome(home);
    }
  });
}
