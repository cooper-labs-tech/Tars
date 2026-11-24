import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * A project's hours and its cap, set in its panel in Projects (#603, on #593's engine), with the E2E clocks: the
 * schedule's clock is a file the spec moves (DOROTHY_E2E_CLOCK_FILE, looked at every 200 ms), and the computer is said
 * to be on battery (powerMonitor, as #593's own spec does), Electron's keep-awake blocker recorded.
 * project-a: its orchestrator (Lead A) and two workers on the recording fake claude (e2e/fake-clis.mjs: a turn
 * `HOLD <tag>` lasts until the spec writes release-<tag>). Lead A calls the real mcp-orchestrator with its own token.
 *
 * How it can fail, written before it ran (QA, 19/11):
 * 1. A project's panel has no hours and no cap, or does not say there are none.
 * 2. Hours set in the window (18:00 to 04:00, UTC) are not saved as set, or the panel does not say they are closed
 *    until 18:00 UTC and who set them.
 * 3. A cap set in the window (1) is not saved, or the panel does not say who set it.
 * 4. At 18:00 (the clock moved), the panel does not say the hours are open and keep the computer awake; the window's
 *    record does not carry the battery warning in main's words; Settings, General, does not name the project's hours
 *    in Keep this computer awake.
 * 5. With the cap at 1, a second worker's task is not held, or the window does not say it waits for its project's cap.
 * 6. Clearing the hours while they are open: the record does not say the window ended by clearing, nobody stopped.
 * 7. An uncaught error in the page.
 * In the classic shell and in the new interface's.
 * Red on #593's head (474f3ab02), which has no panel for them: 1 finds none.
 * The artefact: values.json (fleet.state and keepAwake.state at each step, the tools' answers, the blocker's calls).
 */

const A_LEAD = 'aaaa1111-0000-4000-8000-00000000c001';
const A_W1 = 'aaaa1111-0000-4000-8000-00000000c002';
const A_W2 = 'aaaa1111-0000-4000-8000-00000000c003';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Fleet = { projectPath: string; schedule?: { line: string; setBy: string; next: { open: boolean } }; cap?: { cap: number; setBy: string }; window?: { openedAt?: string; closedAt?: string; cleared?: boolean; warnings: Array<{ kind: string; text: string }> } };

for (const newInterface of [false, true]) {
  test(`a project's hours and cap set in its panel, opened by the clock on battery, a task held by the cap, the hours cleared${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(5 * 60_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-fleet-window-'));
    const projectA = path.join(home, 'projects', 'project-a');
    const dir = path.join(home, '.tars');
    for (const d of [projectA, dir]) fs.mkdirSync(d, { recursive: true });
    const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: projectA, skills: [], permissionMode: 'bypass',
      cliPath: fakes.claude, createdAt: '2026-11-19T07:00:00.000Z', lastActivity: '2026-11-19T07:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(A_LEAD, 'Lead A', 'orchestrator'), agent(A_W1, 'Worker One', 'worker'), agent(A_W2, 'Worker Two', 'worker')]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([projectA]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: fakes.claude } }));
    const clock = path.join(home, 'clock.txt');
    const at = (iso: string) => fs.writeFileSync(clock, iso);
    at('2026-11-19T17:59:00.000Z');
    const port = apiPort(newInterface ? 31947 : 31946);
    const values: Record<string, unknown> = { newInterface, platform: process.platform };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];
    const servers: ChildProcessWithoutNullStreams[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_SCHEDULE_EVERY_MS: '200', DOROTHY_E2E_CLOCK_FILE: clock } });
      await app.evaluate(({ powerSaveBlocker, powerMonitor }) => {
        const g = globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown }> };
        g.__e2eBlocker = [];
        const start = powerSaveBlocker.start.bind(powerSaveBlocker);
        const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
        powerSaveBlocker.start = ((type: Parameters<typeof start>[0]) => { const id = start(type); g.__e2eBlocker.push({ call: 'start', arg: type }); return id; }) as typeof start;
        powerSaveBlocker.stop = ((id: number) => { g.__e2eBlocker.push({ call: 'stop', arg: id }); return stop(id); }) as typeof stop;
        powerMonitor.isOnBatteryPower = () => true;
      });
      const page: Page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      const api = <T>(group: string, name: string, ...args: unknown[]) =>
        page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;
      const fleet = async () => (await api<{ projects: Fleet[] }>('fleet', 'state')).projects.find(p => p.projectPath === projectA);
      const awake = () => api<{ active: boolean; working: number; scheduled?: Array<{ projectPath: string; until: string }> }>('keepAwake', 'state');
      const blocker = () => app!.evaluate(() => (globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown }> }).__e2eBlocker);

      // 1. project-a's panel: no hours, no cap.
      const openPanel = async () => {
        await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
        await page.locator(`[data-project-card="${projectA}"]`).getByRole('button', { name: 'open', exact: true }).click({ timeout: 60_000 });
        await expect(page.locator('[data-project-fleet]')).toBeVisible({ timeout: 30_000 });
      };
      await openPanel();
      const hours = page.locator('[data-fleet-hours]');
      const cap = page.locator('[data-fleet-cap]');
      keep({ before: await fleet(), hoursBefore: await hours.innerText(), capBefore: await cap.innerText() });
      expect.soft(await cap.innerText(), 'no cap yet').toContain('no cap: every worker may work at once');
      await stepShot(page, `${tag}1-no-hours-no-cap`);

      // 2. Hours, 18:00 to 04:00 UTC.
      await hours.getByLabel('Start').fill('18:00');
      await hours.getByLabel('Stop').fill('04:00');
      await hours.getByRole('radio', { name: 'UTC', exact: true }).click();
      await hours.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(hours).toContainText('closed · opens 19/11 at 18:00 UTC', { timeout: 15_000 });
      const setHours = await fleet();
      keep({ setHours, hoursSet: await hours.innerText() });
      expect.soft(setHours?.schedule, 'the hours saved').toMatchObject({ line: 'every day from 18:00 to 04:00 UTC', next: { open: false } });
      expect.soft(await hours.innerText(), 'who set them').toMatch(/set by \S/);

      // 3. Cap 1.
      await cap.getByLabel('Cap').fill('1');
      await cap.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(cap).toContainText(/set by \S/, { timeout: 15_000 });
      const setCap = await fleet();
      keep({ setCap, capSet: await cap.innerText() });
      expect.soft(setCap?.cap, 'the cap saved').toMatchObject({ cap: 1 });
      await stepShot(page, `${tag}2-hours-and-cap-set`);

      // 4. 18:00: open, awake, the battery warning in main's words; Settings names the hours.
      at('2026-11-19T18:00:05.000Z');
      await expect(hours).toContainText('open now · until 04:00 UTC · keeps this computer awake', { timeout: 20_000 });
      const record = page.locator('[data-fleet-window="open"]');
      await expect(record).toContainText('THIS WINDOW · 19/11 18:00 TO 20/11 04:00', { timeout: 15_000 });
      const opened = await fleet();
      const battery = (opened?.window?.warnings ?? []).filter(x => x.kind === 'battery');
      if (process.platform !== 'linux') {
        await expect(record).toContainText(battery[0]?.text ?? 'battery', { timeout: 10_000 });
      }
      const awakeOpen = await awake();
      await stepShot(page, `${tag}3-open-on-battery`);
      keep({ opened, recordOpen: await record.innerText(), awakeOpen, blocker: await blocker() });
      if (process.platform !== 'linux') expect.soft(battery, 'the battery warning, once').toHaveLength(1);
      expect.soft(awakeOpen, 'kept awake by the hours').toMatchObject({ active: true, scheduled: [{ projectPath: projectA, until: '2026-11-20T04:00:00.000Z' }] });
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText(/project-a's hours, until /).first()).toBeVisible({ timeout: 30_000 });
      keep({ settingsAwake: await page.getByText(/project-a's hours, until /).first().innerText() });

      // 5. The cap at work: Worker One holds a turn, Worker Two's task waits for the cap.
      const lead = await orchestratorTools(app, port, home, A_LEAD, projectA, servers);
      const one = await lead('start_agent', { id: A_W1, prompt: 'HOLD one' });
      await expect.poll(() => !!said(home, A_W1, 'holding', 'one'), { timeout: 60_000 }).toBe(true);
      const two = await lead('start_agent', { id: A_W2, prompt: 'HOLD two' });
      const queued = await api<{ waitingFor?: string }>('agentQueue', 'get', A_W2);
      keep({ one, two, queued });
      expect.soft(two.text, "the second task's answer").toMatch(/its project's cap: 1 of 1 agents at work/);
      expect.soft(queued.waitingFor, 'what it waits for').toMatch(/its project's cap: 1 of 1 agents at work/);
      // The banner under Worker Two's terminal (TaskBanner), in its window, opened from its card in Agents.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Worker Two', { exact: true }).first().click({ timeout: 60_000 });
      const banner = page.getByText(/its project's cap: 1 of 1 agents at work/).first();
      await expect(banner).toBeVisible({ timeout: 30_000 });
      keep({ banner: await banner.innerText() });
      await stepShot(page, `${tag}4-waiting-for-the-cap`);
      fs.writeFileSync(path.join(home, 'release-one'), '');
      await expect.poll(() => !!said(home, A_W2, 'holding', 'two'), { timeout: 60_000 }).toBe(true);
      fs.writeFileSync(path.join(home, 'release-two'), '');

      // 6. The hours cleared while open: the window ended by clearing, nobody stopped.
      await openPanel();
      await hours.getByRole('button', { name: 'clear the hours', exact: true }).click();
      const last = page.locator('[data-fleet-window="last"]');
      await expect(last).toContainText('the hours were cleared, nobody was stopped and no queue paused', { timeout: 20_000 });
      const cleared = await fleet();
      await stepShot(page, `${tag}5-cleared`);
      keep({ cleared, recordCleared: await last.innerText() });
      expect.soft(cleared?.schedule, 'no hours left').toBeUndefined();

      // 7.
      keep({ errors });
      expect(errors).toEqual([]);
    } finally {
      for (const s of servers) s.kill();
      await app?.close().catch(() => {});
      await removeHome(home);
    }
  });
}

/** The fake CLIs' log: every launch, turn and answer, by agent. */
function fakeLog(home: string): Array<Record<string, unknown>> {
  const file = path.join(home, 'fake-cli.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const said = (home: string, agent: string, key: 'holding' | 'answer', value: string) =>
  fakeLog(home).find((e) => e.agent === agent && String(e[key] ?? '').includes(value));

/** An orchestrator's own mcp-orchestrator over stdio, with its own token, as its CLI starts it (as #593's spec does). */
async function orchestratorTools(app: ElectronApplication, port: string, home: string, agentId: string, projectPath: string, servers: ChildProcessWithoutNullStreams[]) {
  const dist = path.resolve('electron', 'dist');
  const id = await app.evaluate((_e, { dist, agentId }) => {
    const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
    return { token: tokens.mintRunToken(agentId).token as string, instance: tokens.tarsInstanceId() as string };
  }, { dist, agentId });
  const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: id.token, CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: projectPath, TARS_INSTANCE_ID: id.instance },
  });
  servers.push(mcp);
  const replies = new Map<number, (msg: Reply) => void>();
  let buffered = '';
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const n = nextId++; replies.set(n, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return async (tool: string, args: Record<string, unknown>) => {
    const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(120_000).then(() => ({ error: `${tool} gave no answer in 120 s` }) as Reply)]);
    return { tool, args, text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
}
