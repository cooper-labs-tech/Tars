import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two of the Audit's findings on #620 (Cline as the provider `cline`), in the real app, on a stand-in of Cline's shape:
 * a node launcher that dies of the hangup, and the child it started, deaf to it (Cline's `.cline`). Each launch records
 * its command line, its CLINE_DATA_DIR, its pids and which of the agent's earlier ones still run as it starts, and
 * draws Cline's field and footer, so Tars reads its TUI as up (ClineProvider.upOnScreen).
 *
 * 1. M1: a Cline agent's own folder (`--config`, `--data-dir`, CLINE_DATA_DIR) is in Tars's userData, the sandbox's
 *    profile: never under ~/.tars-private, which no CLI is handed, nor ~/.tars, which every agent is. And a removed
 *    agent's folder, with its copy of the user's provider file, goes with it.
 * 2. L4: the window restarts the agent (what a changed setting does for a CLI that reports its turns), and the
 *    project's orchestrator hands it a task the moment its old terminal is off it, while its old tree is still ending
 *    (/dispatch, the delivery delegate_task and /run-task go through). The task must wait for the restart and go into
 *    the CLI it started (`message`), one CLI after the restart and not two, and the agent must not be in error.
 * 3. QA's gate of #620 (22/11): Cline checks for a newer version at every start and, at its exit, installs itself over
 *    the user's own global Cline (`npm update -g cline`), unless CLINE_NO_AUTO_UPDATE is 1. Every Cline launch, the first
 *    ones and the restart's, must run with it, though the user's own environment turns it back on: Tars's own (the
 *    app runs with CLINE_NO_AUTO_UPDATE=0) and the rc files of the agent's shell (each sets it to 0). Red on
 *    083b95e71: no launch has it.
 * Red on 3f799a287: the folder is ~/.tars-private/cline/<id> and stays after the removal; the task starts a CLI of its
 * own during the restart's end, whose launch then finds it and fails, the agent in error.
 *
 * The artefact: values.json (every launch's record, the answers), agents.png, and with E2E_TRACE=on the app's trace.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; error?: string };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  restart(id: string): Promise<{ success: boolean; error?: string }>;
  remove(id: string): Promise<unknown>;
  list(): Promise<Agent[]>;
} } };
type Launch = { launcher: number; child: number; argv: string[]; dataDir: string | null; oldAlive: number[]; noAutoUpdate: string | null };

const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};
/**
 * A path as the kernel reaches it, through its deepest part that exists: macOS links /var to /private/var, the spec's
 * sandbox is named through the one and the app reports its folders through the other (a TMPDIR under /var/folders,
 * the macOS default outside Tars, QA 22/11).
 */
const real = (p: string): string => {
  const rest: string[] = [];
  let head = path.resolve(p);
  while (!fs.existsSync(head) && path.dirname(head) !== head) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(fs.realpathSync(head), ...rest);
};
const inside = (child: string, parent: string) => {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Cline's shape: a launcher that dies of the hangup, its child deaf to it; its field and footer drawn once up. */
const STAND_IN = (records: string) => String.raw`
const fs = require('fs'), path = require('path'), { spawn, execFileSync } = require('child_process');
const argv = process.argv.slice(2);
if (['--version', 'version', 'auth', 'mcp', 'config', '--help'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
const file = path.join(${JSON.stringify(records)}, (process.env.CLAUDE_AGENT_ID || 'unknown') + '.jsonl');
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim().startsWith('Z'); } catch { return false; }
};
const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const oldAlive = before.flatMap((r) => [r.launcher, r.child]).filter(alive);
const child = spawn('/bin/sh', ['-c', 'trap "" HUP TERM; exec sleep 300'], { stdio: 'ignore' });
fs.appendFileSync(file, JSON.stringify({ launcher: process.pid, child: child.pid, argv, dataDir: process.env.CLINE_DATA_DIR || null, oldAlive, noAutoUpdate: process.env.CLINE_NO_AUTO_UPDATE ?? null }) + '\n');
setTimeout(() => process.stdout.write('\r\n❯ \r\nAuto-approve all disabled (Shift+Tab)\r\n'), 300);
process.stdin.resume();
`;

test.skip(process.platform === 'win32', 'the stand-in is a POSIX process group read through ps; on Windows endTerminalTree ends the tree with taskkill /T while the shell runs, which this spec does not drive');

test("a Cline agent's folder is Tars's own and goes with it; a task sent during its restart waits for it", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cline-folder-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  const records = path.join(home, 'launches');
  for (const d of [project, dir, bin, records]) fs.mkdirSync(d, { recursive: true });
  // 3. The user's own shell turns Cline's update back on, in every rc file a login shell of the agent's reads.
  for (const rc of ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile']) {
    fs.writeFileSync(path.join(home, rc), 'export CLINE_NO_AUTO_UPDATE=0\n');
  }
  const cline = path.join(bin, 'cline');
  fs.writeFileSync(cline, `#!${process.execPath}\n${STAND_IN(records)}`, { mode: 0o755 });
  // The user's own Cline provider, which each agent's folder gets a copy of.
  const usersSettings = path.join(home, '.cline', 'data', 'settings');
  fs.mkdirSync(usersSettings, { recursive: true });
  fs.writeFileSync(path.join(usersSettings, 'providers.json'), JSON.stringify({ version: 1, lastUsedProvider: 'anthropic', providers: { anthropic: { settings: { provider: 'anthropic', apiKey: 'sk-e2e-users-own' } } } }));
  const agent = (id: string, name: string, provider = 'cline', role = 'worker') => ({
    id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
    ...(provider === 'cline' ? { cliPath: cline } : {}), createdAt: '2026-11-21T08:00:00.000Z', lastActivity: '2026-11-21T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('c1', 'Cline Worker'), agent('c2', 'Cline Removed'), agent('o1', 'Project Lead', 'claude', 'orchestrator')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', clineEnabled: true,
    cliPaths: { cline, additionalPaths: [bin, path.dirname(process.execPath)] },
  }));
  const port = apiPort(31371);
  const dist = path.resolve('electron', 'dist');
  const userData = path.join(home, 'electron-profile');
  const launches = (id: string): Launch[] => {
    const file = path.join(records, `${id}.jsonl`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch) : [];
  };
  const flag = (l: Launch | undefined, name: string) => (l ? l.argv[l.argv.indexOf(name) + 1] : undefined);
  const pidsOf = (l: Launch | undefined) => (l ? [l.launcher, l.child] : []);

  const app = await launchSandboxed(electron, home, {
    // 3. And so does Tars's own environment, which a terminal inherits.
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', CLINE_NO_AUTO_UPDATE: '0' },
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

    // 1. M1: where its folder is, and that it goes with it.
    await start('c1');
    await running('c1', 1);
    await start('c2');
    await running('c2', 1);
    const first = launches('c1')[0];
    const folders = { config: flag(first, '--config'), data: flag(first, '--data-dir'), env: first.dataDir };
    const c2Folder = flag(launches('c2')[0], '--config');
    const removed = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.remove('c2'));
    const c2FolderLeft = !!c2Folder && fs.existsSync(c2Folder);
    keep({ folders, userData, c2Folder, removed, c2FolderLeft, privateCline: fs.existsSync(path.join(home, '.tars-private', 'cline')) });

    // 2. L4: a restart, and a task handed over while its old tree is still ending.
    const token = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
    }, { dist });
    const old = pidsOf(launches('c1')[0]);
    const at = Date.now();
    await page.evaluate(() => {
      const w = window as unknown as Api & { pendingRestart?: Promise<unknown> };
      w.pendingRestart = w.electronAPI.agent.restart('c1');
    });
    await expect.poll(async () => (await list()).find((a) => a.id === 'c1')?.cliRunning, { timeout: 10_000, intervals: [20] }).toBe(false);
    const aliveAtTask = old.filter(alive);
    const dispatched = await fetch(`http://127.0.0.1:${port}/api/agents/c1/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'o1' },
      body: JSON.stringify({ message: 'Carry on with the review of the parser.' }),
      signal: AbortSignal.timeout(30_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const dispatchMs = Date.now() - at;
    const restarted = await page.evaluate(() => (window as unknown as { pendingRestart: Promise<unknown> }).pendingRestart);
    await expect.poll(() => launches('c1').length, { timeout: 30_000, message: 'the restart launched nothing' }).toBeGreaterThanOrEqual(2);
    // Time for a second CLI to show up, were one started beside the restart's.
    await new Promise((r) => setTimeout(r, 3_000));
    const seen = (await list()).find((a) => a.id === 'c1');
    keep({ aliveAtTask, dispatched, dispatchMs, restarted, c1Launches: launches('c1'), seen });

    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await stepShot(page, 'agents');
    keep({ pageErrors });

    for (const [what, folder] of Object.entries(folders)) {
      expect(folder, what).toBeTruthy();
      expect(inside(folder!, path.join(userData, 'cline', 'c1')), `${what}, ${folder}, is not the agent's folder in Tars's userData`).toBe(true);
      expect(inside(folder!, path.join(home, '.tars-private')), `${what} is under ~/.tars-private, which no CLI is handed`).toBe(false);
      expect(inside(folder!, dir), `${what} is under ~/.tars, which every agent is handed`).toBe(false);
    }
    expect(c2FolderLeft, 'a removed agent\'s Cline folder, with its copy of the user\'s provider file, stayed').toBe(false);
    expect(aliveAtTask.length, 'the task was not handed over while the old tree was ending: the case proves nothing').toBeGreaterThan(0);
    expect(dispatched.status, JSON.stringify(dispatched)).toBe(200);
    expect(dispatched.body.mode, 'the task started a CLI of its own beside the restart instead of going into the one it started').toBe('message');
    expect(launches('c1'), 'a second CLI was started beside the restart\'s').toHaveLength(2);
    expect(launches('c1')[1].oldAlive, 'the restart\'s CLI started while the old one still ran').toEqual([]);
    // 3. Cline's own update off for every launch: c1's first and its restart's, and c2's.
    const updates = { c1: launches('c1').map((l) => l.noAutoUpdate), c2: launches('c2').map((l) => l.noAutoUpdate) };
    keep({ noAutoUpdate: updates });
    expect(updates, "a Cline agent's terminal left Cline free to install itself over the user's global Cline").toEqual({ c1: ['1', '1'], c2: ['1'] });
    expect(seen?.status, seen?.error).not.toBe('error');
    expect(pageErrors).toEqual([]);
  } finally {
    for (const id of ['c1', 'c2', 'unknown']) {
      for (const pid of launches(id).flatMap(pidsOf)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    await app.close().catch(() => { /* gone */ });
  }
});
