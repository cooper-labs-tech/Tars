import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * A project's cap and its hours (2.0.7, services/fleet-operations.ts), in the real app, for an orchestrator that runs
 * another project's agents in a nightly window.
 *
 * project-a has its orchestrator (Lead A) and two claude workers on the recording fake (e2e/fake-clis.mjs: a turn
 * `HOLD <tag>` lasts until the spec writes release-<tag>). project-b has its orchestrator (Lead B). Each orchestrator
 * calls the real mcp-orchestrator over stdio with its own token, as its CLI would.
 *
 * The cap, asserted:
 * 1. Lead B is refused project-a's cap and hours (no allowlist yet); Lead A sets cap 1.
 * 2. Lead hands Worker One `HOLD one` (start_agent): it works. Lead hands Worker Two `HOLD two`: queued, the answer
 *    and the window's queue say "its project's cap: 1 of 1 agents at work", and Worker Two gets no CLI meanwhile.
 * 3. Worker One's turn ends: Worker Two's task goes in, after it. Never two workers `running` at once (sampled).
 *
 * The hours, asserted (the schedule's clock is a file the spec moves, DOROTHY_E2E_CLOCK_FILE; looked at every 200 ms):
 * 4. Lead A's schedule with no zone is refused; 18:00 to 04:00 UTC is set, and the window reads it, not open at 17:59.
 * 5. At 18:00 the window opens: the computer is kept awake with no agent at work (a 'prevent-app-suspension'
 *    blocker), keepAwake.state() names the window; on battery (powerMonitor made to say so, macOS and Windows) the
 *    window carries the battery warning, once.
 * 6. Worker One works (`HOLD three`). At 04:00 every queue is paused with the hours' reason, the agents at rest are
 *    stopped, Worker One is not: it waits, at work, until its turn ends, then is stopped (afterTurn).
 * 7. During the day, Lead B hands Worker Two `ECHO morning` (allowCrossProject): it waits in its queue,
 *    paused, never refused.
 * 8. Tars restarts: the hours, the cap, the last window and Worker Two's waiting task are all there.
 * 9. At 18:00 the next day, Worker Two's queue goes again and `ECHO morning` is answered.
 * The artefact: values.json (each tool's answer, the states read, the statuses sampled, the blocker's calls).
 * Red on origin/train/2.0.7 (no project_cap, no project_schedule) and on the mutant capVerdict -> undefined.
 */

const A_LEAD = 'aaaa1111-0000-4000-8000-00000000a001';
const A_W1 = 'aaaa1111-0000-4000-8000-00000000a002';
const A_W2 = 'aaaa1111-0000-4000-8000-00000000a003';
const B_LEAD = 'bbbb2222-0000-4000-8000-00000000b001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Win = { electronAPI: {
  agent: { get(id: string): Promise<{ status: string } | null> };
  agentQueue: { get(id: string): Promise<{ paused?: { why: string }; waitingFor?: string; items: Array<{ ref: string; title: string }> }> };
  fleet: { state(): Promise<{ projects: Array<Record<string, any>> }> };
  keepAwake: { state(): Promise<{ mode: string; active: boolean; working: number; scheduled?: Array<{ projectPath: string; until: string }> }> };
} };

function seed(home: string, newInterface: boolean) {
  const projectA = path.join(home, 'projects', 'project-a');
  const projectB = path.join(home, 'projects', 'project-b');
  const dir = path.join(home, '.tars');
  for (const d of [projectA, projectB, dir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
  const agent = (id: string, name: string, role: string, projectPath: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath, skills: [], permissionMode: 'bypass',
    cliPath: fakes.claude, createdAt: '2026-11-19T07:00:00.000Z', lastActivity: '2026-11-19T07:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(A_LEAD, 'Lead A', 'orchestrator', projectA), agent(A_W1, 'Worker One', 'worker', projectA), agent(A_W2, 'Worker Two', 'worker', projectA),
    agent(B_LEAD, 'Lead B', 'orchestrator', projectB),
  ]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([projectA, projectB]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: fakes.claude } }));
  return { projectA, projectB };
}

/** The fake CLIs' log: every launch, turn and answer, by agent. */
function fakeLog(home: string): Array<Record<string, unknown>> {
  const file = path.join(home, 'fake-cli.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const said = (home: string, agent: string, key: 'holding' | 'answer', value: string) =>
  fakeLog(home).find((e) => e.agent === agent && String(e[key] ?? '').includes(value));

/** An orchestrator's own mcp-orchestrator over stdio, with its own token, as its CLI starts it. */
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

async function openWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
  return page;
}

const win = (page: Page) => ({
  status: (id: string) => page.evaluate((i) => (window as unknown as Win).electronAPI.agent.get(i).then((a) => a?.status), id),
  queue: (id: string) => page.evaluate((i) => (window as unknown as Win).electronAPI.agentQueue.get(i), id),
  fleet: (project: string) => page.evaluate(async (p) => (await (window as unknown as Win).electronAPI.fleet.state()).projects.find((x) => x.projectPath === p), project),
  awake: () => page.evaluate(() => (window as unknown as Win).electronAPI.keepAwake.state()),
});

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';

  test(`a project's cap holds a worker's task in its queue, and lets it in when a place frees${shell}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-fleet-cap-${newInterface ? 'ni' : 'classic'}-`));
    const { projectA } = seed(home, newInterface);
    const port = apiPort(31530 + (newInterface ? 1 : 0));
    const values: Record<string, unknown> = { newInterface, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const errors: string[] = [];
    const servers: ChildProcessWithoutNullStreams[] = [];
    const app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    let sampling = true;
    try {
      const page = await openWindow(app, errors);
      const w = win(page);
      const lead = await orchestratorTools(app, port, home, A_LEAD, projectA, servers);
      const leadB = await orchestratorTools(app, port, home, B_LEAD, path.join(home, 'projects', 'project-b'), servers);

      // 1. Who sets it.
      const refusedCap = await leadB('project_cap', { cap: 3, project: projectA });
      const refusedHours = await leadB('project_schedule', { action: 'set', project: projectA, start: '18:00', stop: '04:00', timeZone: 'UTC' });
      const set = await lead('project_cap', { cap: 1 });
      keep({ refusedCap, refusedHours, set });
      expect(refusedCap.isError).toBe(true);
      expect(refusedCap.text).toMatch(/Only the project's own orchestrator/);
      expect(refusedHours.isError).toBe(true);
      expect(set.isError).toBe(false);
      expect(await w.fleet(projectA)).toMatchObject({ cap: { cap: 1, setBy: 'Lead A' } });

      // The workers' statuses, sampled until the end: never two running at once.
      const samples: Array<{ at: number; w1?: string; w2?: string }> = [];
      const sampler = (async () => {
        while (sampling) {
          samples.push({ at: Date.now(), w1: await w.status(A_W1).catch(() => undefined), w2: await w.status(A_W2).catch(() => undefined) });
          await sleep(150);
        }
      })();

      // 2. One works; the second waits for the cap.
      const first = await lead('start_agent', { id: A_W1, prompt: 'HOLD one' });
      await expect.poll(() => !!said(home, A_W1, 'holding', 'one'), { timeout: 60_000 }).toBe(true);
      const second = await lead('start_agent', { id: A_W2, prompt: 'HOLD two' });
      keep({ first, second });
      expect(first.isError).toBe(false);
      expect(second.isError).toBe(false);
      expect(second.text).toMatch(/its project's cap: 1 of 1 agents at work/);
      const waiting = await w.queue(A_W2);
      keep({ waiting });
      expect(waiting.items).toHaveLength(1);
      expect(waiting.waitingFor).toBe("its project's cap: 1 of 1 agents at work");
      await sleep(3_000);
      expect(said(home, A_W2, 'holding', 'two')).toBeUndefined();
      expect(fakeLog(home).some((e) => e.agent === A_W2)).toBe(false);

      // 3. A place frees: the second goes in, after the first's answer.
      fs.writeFileSync(path.join(home, 'release-one'), '');
      await expect.poll(() => !!said(home, A_W2, 'holding', 'two'), { timeout: 60_000 }).toBe(true);
      const oneEnded = said(home, A_W1, 'answer', 'held one')!;
      const twoBegan = said(home, A_W2, 'holding', 'two')!;
      keep({ oneEnded, twoBegan });
      expect(Date.parse(String(twoBegan.t))).toBeGreaterThanOrEqual(Date.parse(String(oneEnded.t)));
      expect((await w.queue(A_W2)).items).toHaveLength(0);
      fs.writeFileSync(path.join(home, 'release-two'), '');
      await expect.poll(() => !!said(home, A_W2, 'answer', 'held two'), { timeout: 60_000 }).toBe(true);
      sampling = false;
      await sampler;
      const both = samples.filter((s) => s.w1 === 'running' && s.w2 === 'running');
      keep({ samples: samples.length, bothRunning: both });
      expect(samples.some((s) => s.w1 === 'running')).toBe(true);
      expect(samples.some((s) => s.w2 === 'running')).toBe(true);
      expect(both).toEqual([]);

      const cleared = await lead('project_cap', { cap: null });
      keep({ cleared });
      expect((await w.fleet(projectA))?.cap).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      sampling = false;
      for (const s of servers) s.kill();
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });

  test(`a project's hours open, keep awake, stop each agent after its turn, hold the day's work across a restart, and resume${shell}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-fleet-hours-${newInterface ? 'ni' : 'classic'}-`));
    const { projectA, projectB } = seed(home, newInterface);
    const clock = path.join(home, 'clock.txt');
    const at = (iso: string) => fs.writeFileSync(clock, iso);
    at('2026-11-19T17:59:00.000Z');
    const port = apiPort(31532 + (newInterface ? 1 : 0));
    const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_SCHEDULE_EVERY_MS: '200', DOROTHY_E2E_CLOCK_FILE: clock };
    const values: Record<string, unknown> = { newInterface, home, platform: process.platform };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const errors: string[] = [];
    const servers: ChildProcessWithoutNullStreams[] = [];
    let app: ElectronApplication = await launchSandboxed(electron, home, { env });
    try {
      // Electron's blocker, recorded; on battery, where Electron is what Tars reads (macOS, Windows).
      await app.evaluate(({ powerSaveBlocker, powerMonitor }) => {
        const g = globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown }> };
        g.__e2eBlocker = [];
        const start = powerSaveBlocker.start.bind(powerSaveBlocker);
        const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
        powerSaveBlocker.start = ((type: Parameters<typeof start>[0]) => { const id = start(type); g.__e2eBlocker.push({ call: 'start', arg: type }); return id; }) as typeof start;
        powerSaveBlocker.stop = ((id: number) => { g.__e2eBlocker.push({ call: 'stop', arg: id }); return stop(id); }) as typeof stop;
        powerMonitor.isOnBatteryPower = () => true;
      });
      const blocker = () => app.evaluate(() => (globalThis as unknown as { __e2eBlocker: Array<{ call: string; arg: unknown }> }).__e2eBlocker);
      let page = await openWindow(app, errors);
      let w = win(page);
      const lead = await orchestratorTools(app, port, home, A_LEAD, projectA, servers);

      // 4. Set, the zone said.
      const noZone = await lead('project_schedule', { action: 'set', start: '18:00', stop: '04:00' });
      const set = await lead('project_schedule', { action: 'set', start: '18:00', stop: '04:00', timeZone: 'UTC' });
      keep({ noZone, set });
      expect(noZone.isError).toBe(true);
      expect(noZone.text).toMatch(/timeZone is required/);
      expect(set.isError).toBe(false);
      const before = await w.fleet(projectA);
      expect(before).toMatchObject({ schedule: { line: 'every day from 18:00 to 04:00 UTC', setBy: 'Lead A', next: { open: false, start: '2026-11-19T18:00:00.000Z' } } });
      expect(before?.window).toBeUndefined();
      expect(await w.awake()).not.toHaveProperty('scheduled');

      // 5. 18:00: open, awake with nobody at work, warned once.
      at('2026-11-19T18:00:05.000Z');
      await expect.poll(async () => (await w.fleet(projectA))?.window?.openedAt, { timeout: 15_000 }).toBe('2026-11-19T18:00:05.000Z');
      await expect.poll(() => w.awake(), { timeout: 10_000 }).toMatchObject({ active: true, working: 0, scheduled: [{ projectPath: projectA, until: '2026-11-20T04:00:00.000Z' }] });
      expect((await blocker()).map((c) => `${c.call}:${c.call === 'start' ? c.arg : ''}`)).toEqual(['start:prevent-app-suspension']);
      await sleep(1_500);
      const opened = await w.fleet(projectA);
      keep({ opened, awakeOpen: await w.awake() });
      if (process.platform !== 'linux') expect(opened?.window?.warnings.filter((x: { kind: string }) => x.kind === 'battery')).toHaveLength(1);

      // 6. Worker One works across the stop.
      const three = await lead('start_agent', { id: A_W1, prompt: 'HOLD three' });
      keep({ three });
      await expect.poll(() => !!said(home, A_W1, 'holding', 'three'), { timeout: 60_000 }).toBe(true);
      at('2026-11-20T04:00:05.000Z');
      await expect.poll(async () => (await w.fleet(projectA))?.window?.closedAt, { timeout: 15_000 }).toBe('2026-11-20T04:00:05.000Z');
      await expect.poll(() => w.status(A_W2), { timeout: 10_000 }).toBe('stopped');
      const closing = await w.fleet(projectA);
      keep({ closing });
      expect(closing?.window?.stopping).toEqual([{ id: A_W1, agent: 'Worker One' }]);
      expect((await w.queue(A_W1)).paused?.why).toMatch(/outside its project's hours \(every day from 18:00 to 04:00 UTC\)/);
      expect((await w.queue(A_W2)).paused?.why).toMatch(/outside its project's hours/);
      await sleep(2_000);
      expect(await w.status(A_W1)).toBe('running');
      expect(said(home, A_W1, 'answer', 'held three')).toBeUndefined();

      // 7. Work handed during the day waits, never refused.
      const leadB = await orchestratorTools(app, port, home, B_LEAD, projectB, servers);
      const morning = await leadB('start_agent', { id: A_W2, prompt: 'ECHO morning', allowCrossProject: true });
      keep({ morning });
      expect(morning.isError).toBe(false);
      expect(morning.text).toMatch(/its queue, paused: outside its project's hours \(every day from 18:00 to 04:00 UTC\)/);
      await expect.poll(async () => (await w.queue(A_W2)).items.map((i) => i.title), { timeout: 10_000 }).toEqual(['ECHO morning']);

      // Worker One's turn ends: it is stopped, after it.
      fs.writeFileSync(path.join(home, 'release-three'), '');
      await expect.poll(() => w.status(A_W1), { timeout: 30_000 }).toBe('stopped');
      // The record is written once the stop is over (its terminal and what it started ended), a moment after the status.
      await expect.poll(async () => (await w.fleet(projectA))?.window?.stopping, { timeout: 30_000 }).toEqual([]);
      const closed = await w.fleet(projectA);
      keep({ closed, awakeClosed: await w.awake(), blockerCalls: await blocker() });
      expect(said(home, A_W1, 'answer', 'held three')).toBeDefined();
      expect(closed?.window?.stopping).toEqual([]);
      expect(closed?.window?.stopped.find((s: { id: string }) => s.id === A_W1)).toMatchObject({ agent: 'Worker One', afterTurn: true });
      await expect.poll(() => w.awake(), { timeout: 10_000 }).not.toHaveProperty('scheduled');

      // 8. Tars restarts during the day.
      for (const s of servers.splice(0)) s.kill();
      await app.close();
      app = await launchSandboxed(electron, home, { env });
      page = await openWindow(app, errors);
      w = win(page);
      const afterRestart = await w.fleet(projectA);
      const queued = await w.queue(A_W2);
      keep({ afterRestart, queuedAfterRestart: queued });
      expect(afterRestart).toMatchObject({ schedule: { line: 'every day from 18:00 to 04:00 UTC' }, window: { closedAt: '2026-11-20T04:00:05.000Z' } });
      expect(queued.items.map((i) => i.title)).toEqual(['ECHO morning']);
      expect(queued.paused?.why).toMatch(/outside its project's hours/);

      // 9. 18:00 the next day: the day's work goes in.
      at('2026-11-20T18:00:05.000Z');
      await expect.poll(async () => (await w.fleet(projectA))?.window?.start, { timeout: 15_000 }).toBe('2026-11-20T18:00:00.000Z');
      await expect.poll(() => !!said(home, A_W2, 'answer', 'echo morning'), { timeout: 60_000 }).toBe(true);
      const nextNight = await w.fleet(projectA);
      keep({ nextNight });
      expect(nextNight?.window?.resumed).toEqual(expect.arrayContaining(['Worker One', 'Worker Two']));
      expect(errors).toEqual([]);
    } finally {
      for (const s of servers) s.kill();
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
