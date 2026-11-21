import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What a running agent uses in its temporary folder stays (QA's gate of #601's stack, 21/11 02:18 UTC).
 *
 * The retention (services/agent-tmp.ts) deleted an entry of a running agent's t/ that nothing had changed for a day.
 * Running a binary changes no date: QA's t/codex-0170 (380 MB) and t/kimi-2.6.3 went while its gate ran them, and the
 * conformance skipped codex and Kimi. An entry a live process uses (its executable, its current folder, a file it
 * holds open, a path its command line names) is kept now; one nothing uses still goes after a day.
 *
 * The worker's CLI is a stand-in `claude` (a node script) that starts, from its TMPDIR, a copy of node kept in
 * t/tool/bin, and a process whose current folder is t/workdir, both running as the CLI does. Once both run, every
 * entry of t/ is dated two days back, the copy of node included (its access time too, which its run moved: the
 * process alone must keep it). The retention's first pass comes 30 s after the launch (DOROTHY_TMP_RETENTION_FIRST_MS).
 * Asserted, once it has removed t/stale:
 * 1. t/tool, whose executable runs, is kept;
 * 2. t/workdir, a process's current folder, is kept;
 * 3. t/stale, which nothing uses, is removed, with its line in agent-tmp.log;
 * 4. both processes still run.
 * Red on main (58f2863b4): t/tool and t/workdir go with t/stale, "untouched for a day, its agent running".
 * The artefact: values.json (t/ before and after, the log, the processes).
 */

type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const shortIdOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 10);
const DAY = 86_400_000;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("what a running agent uses in its temporary folder is kept, and what nothing uses still goes", async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-tmp-in-use-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const pidsFile = path.join(home, 'started.json');

  // The worker's t/, as an earlier run left it: a tool installed there, a folder it works in, and an old file.
  const t = path.join(dir, 'tmp', shortIdOf('worker'), 't');
  const tool = path.join(t, 'tool', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const workdir = path.join(t, 'workdir');
  const stale = path.join(t, 'stale', 'old.txt');
  for (const d of [path.dirname(tool), workdir, path.dirname(stale)]) fs.mkdirSync(d, { recursive: true });
  // A clone where the disk makes one (APFS), a copy elsewhere.
  fs.copyFileSync(process.execPath, tool, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(workdir, 'notes.txt'), 'notes');
  fs.writeFileSync(stale, 'nothing uses me');

  const cli = writeNodeCli(path.join(bin, process.platform === 'win32' ? 'claude.cjs' : 'claude'), [
    "const fs = require('fs'), path = require('path'), { spawn } = require('child_process');",
    'const t = process.env.TMPDIR;',
    `const tool = path.join(t, 'tool', 'bin', ${JSON.stringify(path.basename(tool))});`,
    "const a = spawn(tool, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });",
    "const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { cwd: path.join(t, 'workdir'), stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ tool: a.pid, workdir: b.pid, TMPDIR: t }));`,
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'worker', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-11-01T08:00:00.000Z', lastActivity: '2026-11-01T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const list = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
  const values: Record<string, unknown> = { platform: process.platform, before: list(t) };
  const started: { tool?: number; workdir?: number; TMPDIR?: string } = {};
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31534), DOROTHY_E2E: '1', DOROTHY_TMP_RETENTION_FIRST_MS: '30000' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'worker', prompt: '' }));
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).some((a) => a.id === 'worker' && a.cliRunning), { timeout: 60_000 }).toBe(true);
    await expect.poll(() => fs.existsSync(pidsFile), { timeout: 20_000 }).toBe(true);
    Object.assign(started, JSON.parse(fs.readFileSync(pidsFile, 'utf8')));
    expect(started.TMPDIR, "the worker's TMPDIR").toBe(t);
    await expect.poll(() => alive(started.tool!) && alive(started.workdir!), { timeout: 10_000 }).toBe(true);

    // Every entry of t/ two days old, the tool's access time included (its run moved it).
    const old = new Date(Date.now() - 2 * DAY);
    for (const p of [tool, path.dirname(tool), path.dirname(path.dirname(tool)), path.join(workdir, 'notes.txt'), workdir, stale, path.dirname(stale)]) fs.utimesSync(p, old, old);
    values.datedAt = new Date().toISOString();

    // The first pass, while the worker's CLI and both processes run.
    await expect.poll(() => fs.existsSync(path.dirname(stale)), { timeout: 60_000 }).toBe(false);
    const log = path.join(dir, 'logs', 'agent-tmp.log');
    Object.assign(values, {
      after: list(t),
      log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
      started,
      stillRunning: { tool: alive(started.tool!), workdir: alive(started.workdir!) },
    });
    recordValues(values);

    expect.soft(fs.existsSync(tool), "the tool the worker's process runs was deleted").toBe(true);
    expect.soft(fs.existsSync(path.join(workdir, 'notes.txt')), "the folder a process of the worker works in was deleted").toBe(true);
    expect.soft(values.log as string, 'the stale entry has no line in the log').toMatch(/removed [^\n]*stale/);
    expect.soft(values.stillRunning, 'a process of the worker stopped').toEqual({ tool: true, workdir: true });
  } finally {
    await app.close();
    for (const pid of [started.tool, started.workdir]) if (pid && alive(pid)) try { process.kill(pid); } catch { /* gone */ }
    await removeHome(home);
  }
});
