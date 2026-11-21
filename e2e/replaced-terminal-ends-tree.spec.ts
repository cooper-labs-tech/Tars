import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A terminal Tars replaces ends with everything its CLI started, before the next one opens, in the real app.
 *
 * Found by Backend-5 in Cline's conformance (#620): a restart hung up its terminal, which ended Cline's node
 * launcher and left the .cline it waits on orphaned and stopped, holding the agent's folder, after Tars had quit.
 * #620 ends a restart's terminal with its tree; a provider change (core/agent-update.ts) and a start that replaces a
 * stale terminal (killStalePty, before ipc-handlers.ts's agent:start opens the next) still gave it the hangup alone.
 *
 * The CLI here is a stand-in in Cline's shape: a node launcher, which dies of the hangup, and the child it started,
 * deaf to SIGHUP and SIGTERM. Each launch records the two pids, and which of the agent's earlier ones still run as it
 * starts. Two gemini agents, started from the window:
 * 1. the first gets a new provider (agent.update, the Agents page's save): once the update answers, nothing of its
 *    old CLI may run;
 * 2. the second's terminal goes stale, a gemini key set from the window since it opened (cliKeys.set), and the window
 *    starts it again: its new CLI must start with nothing of the old one running, and nothing of it may be left;
 * 3. the third gets a new provider, and the project's orchestrator hands it a task the moment its old terminal is
 *    off it, while its old tree is still ending (/dispatch, the delivery delegate_task and /run-task go through,
 *    with the orchestrator's own token): the task must wait for that end, then start the agent's new CLI with
 *    nothing of the old one running, the agent not in error (the Audit's L4 on #620, on this path).
 * Red on main 58f2863b4: the launcher dies, its child runs on, adopted by launchd. Scenario 3 is red on 5db1c2dc1
 * too, the tree ended but out of the senders' sight: the task's CLI started while the old child still ran.
 *
 * The artefact: values.json (every launch's record, the answers, when each old tree was gone), the Agents page once
 * both are done (agents.png), and with E2E_TRACE=on the app's trace.
 */

type Agent = { id: string; status: string; provider?: string; cliRunning?: boolean };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; update(p: Record<string, unknown>): Promise<{ success: boolean; error?: string }>; list(): Promise<Agent[]> };
  cliKeys: { set(id: string, patch: Record<string, unknown>): Promise<{ success: boolean; error?: string }> };
} };
type Launch = { launcher: number; child: number; oldAlive: number[]; at: number };

const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};

/** Cline's shape: a launcher that dies of the hangup, and the child it waits on, deaf to it. */
const STAND_IN = (records: string) => String.raw`
const fs = require('fs'), path = require('path'), { spawn, execFileSync } = require('child_process');
const argv = process.argv.slice(2);
// Registration calls (mcp add, --version...) answer and leave: only a session records.
if (['mcp', '--version', 'version', 'login', 'auth', 'config', 'extensions', '--help'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
const file = path.join(${JSON.stringify(records)}, (process.env.CLAUDE_AGENT_ID || 'unknown') + '.jsonl');
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};
const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const oldAlive = before.flatMap((r) => [r.launcher, r.child]).filter(alive);
const child = spawn('/bin/sh', ['-c', 'trap "" HUP TERM; exec sleep 300'], { stdio: 'ignore' });
fs.appendFileSync(file, JSON.stringify({ launcher: process.pid, child: child.pid, oldAlive, at: Date.now() }) + '\n');
process.stdout.write('launcher ready\n');
process.stdin.resume();
`;

test.skip(process.platform === 'win32', 'the stand-in is a POSIX process group read through ps; on Windows endTerminalTree ends the tree with taskkill /T while the shell runs (pty-manager.ts endTreeBeforeConsole), which this spec does not drive');

test('a provider change and a start that replaces a stale terminal end what its CLI started, before the next one opens', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-replaced-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  const records = path.join(home, 'launches');
  for (const d of [project, dir, bin, records]) fs.mkdirSync(d, { recursive: true });
  const cliPaths: Record<string, string> = {};
  for (const cli of ['gemini', 'codex']) {
    cliPaths[cli] = path.join(bin, cli);
    fs.writeFileSync(cliPaths[cli], `#!${process.execPath}\n${STAND_IN(records)}`, { mode: 0o755 });
  }
  const agent = (id: string, name: string) => ({
    id, name, character: 'robot', provider: 'gemini', status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'normal', cliPath: cliPaths.gemini, createdAt: '2026-11-21T08:00:00.000Z', lastActivity: '2026-11-21T08:00:00.000Z',
  });
  // The lead is the project's orchestrator: only Tars, the window and an orchestrator hand another agent work (#449).
  const lead = { ...agent('o1', 'Project Lead'), role: 'orchestrator' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('p1', 'Provider Change'), agent('s1', 'Stale Start'), agent('d1', 'Task Meanwhile'), lead], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { ...cliPaths, additionalPaths: [bin] },
    geminiEnabled: true, codexEnabled: true,
  }));
  const port = apiPort(31370);
  const dist = path.resolve('electron', 'dist');
  const launches = (id: string): Launch[] => {
    const file = path.join(records, `${id}.jsonl`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch) : [];
  };
  const pidsOf = (l: Launch | undefined) => (l ? [l.launcher, l.child] : []);
  /** How long after `since` none of `pids` ran, within 5 s; null if some still did. */
  const goneAfter = async (pids: number[], since: number) => {
    for (const until = Date.now() + 5_000; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
      if (!pids.some(alive)) return Date.now() - since;
    }
    return null;
  };

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const start = (id: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
    const running = async (id: string, n: number) => {
      await expect.poll(() => launches(id).length, { timeout: 30_000, message: `launch ${n} of ${id} never ran` }).toBe(n);
      await expect.poll(async () => (await list()).find((a) => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    };

    // 1. A new provider, from the window, while the CLI runs.
    await start('p1');
    await running('p1', 1);
    const p1Old = pidsOf(launches('p1')[0]);
    const updateAt = Date.now();
    const updated = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.update({ id: 'p1', provider: 'codex' }));
    const updateMs = Date.now() - updateAt;
    const p1AtAnswer = p1Old.filter(alive);
    const p1GoneMs = await goneAfter(p1Old, updateAt);
    keep({ updated, updateMs, p1Launches: launches('p1'), p1AliveAtAnswer: p1AtAnswer, p1GoneMs });

    // 2. A key set since the terminal opened: it is stale, and the next start replaces it.
    await start('s1');
    await running('s1', 1);
    const s1Old = pidsOf(launches('s1')[0]);
    const keySet = await page.evaluate(() => (window as unknown as Api).electronAPI.cliKeys.set('gemini', { key: 'e2e-gemini-key-replaced-terminal-0123456789' }));
    const startAt = Date.now();
    const restarted = await start('s1');
    const startMs = Date.now() - startAt;
    await expect.poll(() => launches('s1').length, { timeout: 30_000, message: 'the start that replaced the terminal launched nothing' }).toBe(2);
    const s1GoneMs = await goneAfter(s1Old, startAt);
    keep({ keySet, restarted, startMs, s1Launches: launches('s1'), s1GoneMs });

    // 3. A new provider, and a task handed over while the old tree is still ending.
    await start('d1');
    await running('d1', 1);
    const d1Old = pidsOf(launches('d1')[0]);
    const token = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
    }, { dist });
    const taskAt = Date.now();
    await page.evaluate(() => {
      const w = window as unknown as Api & { pendingUpdate?: Promise<unknown> };
      w.pendingUpdate = w.electronAPI.agent.update({ id: 'd1', provider: 'codex' });
    });
    await expect.poll(async () => (await list()).find((a) => a.id === 'd1')?.cliRunning, { timeout: 10_000, intervals: [20] }).toBe(false);
    const offAgentMs = Date.now() - taskAt;
    const d1AliveAtTask = d1Old.filter(alive);
    const dispatched = await fetch(`http://127.0.0.1:${port}/api/agents/d1/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      body: JSON.stringify({ message: 'Carry on with the review of the parser.' }),
      signal: AbortSignal.timeout(30_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const dispatchMs = Date.now() - taskAt;
    const d1Updated = await page.evaluate(() => (window as unknown as { pendingUpdate: Promise<unknown> }).pendingUpdate);
    await expect.poll(() => launches('d1').length, { timeout: 30_000, message: 'the task started no CLI' }).toBe(2);
    const d1GoneMs = await goneAfter(d1Old, taskAt);
    const d1Seen = (await list()).find((a) => a.id === 'd1');
    keep({ d1Updated, offAgentMs, d1AliveAtTask, dispatched, dispatchMs, d1Launches: launches('d1'), d1GoneMs, d1Seen });

    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await stepShot(page, 'agents');
    keep({ agents: await list(), pageErrors });

    expect(updated.success, JSON.stringify(updated)).toBe(true);
    expect(p1AtAnswer, 'the provider change answered while its old CLI, or what its launcher started, still ran').toEqual([]);
    expect(p1GoneMs, 'the old CLI, or what its launcher started, outlived the provider change').not.toBeNull();
    expect(keySet.success, JSON.stringify(keySet)).toBe(true);
    expect(launches('s1')[1].oldAlive, 'the new CLI started while the old one, or what its launcher started, still ran').toEqual([]);
    expect(s1GoneMs, 'the old CLI, or what its launcher started, outlived the start that replaced its terminal').not.toBeNull();
    expect(d1AliveAtTask.length, 'the task was not handed over while the old tree was ending: the case proves nothing').toBeGreaterThan(0);
    expect(dispatched.status, JSON.stringify(dispatched)).toBe(200);
    expect(launches('d1')[1].oldAlive, 'the task started the new CLI while the old one, or what its launcher started, still ran').toEqual([]);
    expect(d1GoneMs).not.toBeNull();
    expect(d1Seen?.status).not.toBe('error');
    expect(pageErrors).toEqual([]);
  } finally {
    for (const id of ['p1', 's1', 'd1', 'unknown']) {
      for (const pid of launches(id).flatMap(pidsOf)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    await app.close().catch(() => { /* gone */ });
  }
});
