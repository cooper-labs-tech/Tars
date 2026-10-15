import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A durable temporary folder per agent, in the real app (RD-REDEMARRAGE.md, 2.1): an agent's CLI is handed
 * ~/.dorothy/tmp/<short id>/t as TMPDIR and .../c as CLAUDE_CODE_TMPDIR, not the folder macOS empties at boot, and
 * what it leaves there is still there after Tars starts again. The retention runs at launch (15 s after, in a
 * development run): a deleted agent's folder untouched for 8 days goes, with a line in the log. Of an agent whose CLI
 * runs (#384): an entry of its t/ untouched for a day goes, with its own line in the log; the folder of the session it
 * runs or would resume, in c/, stays however old; and so does claude's messaging socket in c/cc-socks, dated its
 * start and never touched, while a server listens on it (the Audit's M1 and QA's M2 on #384).
 *
 * The CLI is a stand-in named `claude` (a node script, as an npm install of Claude Code is) that writes the two
 * variables it was given into a file, and a file into its TMPDIR. The socket is a real one, listened on by a node
 * process started in c/cc-socks, as claude listens on its own.
 */

type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const shortIdOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 10);
const DAY = 86_400_000;
const LIVE_SESSION = '0f1e2d3c-4b5a-4968-8776-655443322110';

test("an agent's CLI gets a temporary folder under ~/.dorothy/tmp that outlives Tars, and the retention keeps it to 7 days", async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-tmp-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const seen = path.join(home, 'env-seen.jsonl');
  // writeNodeCli: the script itself on macOS and Linux; on Windows npm's shim
  // beside it, which Tars reads through only to a .js script, hence the .cjs there.
  const cli = writeNodeCli(path.join(bin, process.platform === 'win32' ? 'claude.cjs' : 'claude'), [
    "const fs = require('fs'), path = require('path');",
    `fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ id: process.env.CLAUDE_AGENT_ID, TMPDIR: process.env.TMPDIR, CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR }) + '\\n');`,
    "if (process.env.TMPDIR) fs.writeFileSync(path.join(process.env.TMPDIR, 'scratch-' + Date.now() + '.txt'), 'kept');",
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'worker', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
    // The conversation it would resume: its folder in c/ is the session's, kept however old.
    resumableSessionId: LIVE_SESSION,
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  // Before the first launch: a deleted agent's folder untouched for 8 days; of the worker, an 8-day-old file in t/,
  // its live session's folder in c/ as old, and claude's messaging socket, listened on, as old.
  const tmpRoot = path.join(dir, 'tmp');
  const old = new Date(Date.now() - 8 * DAY);
  const workerRoot = path.join(tmpRoot, shortIdOf('worker'));
  const gone = path.join(tmpRoot, shortIdOf('deleted-agent'), 't', 'left-behind.txt');
  const workerOld = path.join(workerRoot, 't', 'old-but-live.txt');
  const sessionFolder = path.join(workerRoot, 'c', 'claude-501', project.replace(/[^A-Za-z0-9]/g, '-'), LIVE_SESSION);
  const sessionFile = path.join(sessionFolder, 'scratchpad', 'notes.md');
  for (const file of [gone, workerOld, sessionFile]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  const socks = path.join(workerRoot, 'c', 'cc-socks');
  fs.mkdirSync(socks, { recursive: true });
  const socket = path.join(socks, '4242.sock');
  // No socket file on Windows: Node listens there on named pipes only, never on a path in a folder.
  const withSocket = process.platform !== 'win32';
  // Listened on by its relative name, from its own folder: a socket's path holds at most 104 bytes, and this one
  // under the system's temporary folder is longer.
  const listener = withSocket ? spawn(process.execPath, ['-e', "require('net').createServer().listen('4242.sock', () => console.log('listening')); setInterval(() => {}, 1e9);"], { cwd: socks, stdio: ['ignore', 'pipe', 'inherit'] }) : null;
  if (listener) {
    await new Promise<void>((resolve, reject) => {
      listener.stdout!.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
      listener.on('exit', (code) => reject(new Error(`the socket's listener exited with ${code}`)));
    });
    fs.lutimesSync(socket, old, old);
  }
  for (const p of [
    gone, path.dirname(gone), path.dirname(path.dirname(gone)), workerOld, path.dirname(workerOld),
    sessionFile, path.dirname(sessionFile), sessionFolder, path.dirname(sessionFolder), path.dirname(path.dirname(sessionFolder)), socks,
    path.join(workerRoot, 'c'),
  ]) fs.utimesSync(p, old, old);

  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31468), DOROTHY_E2E: '1', DOROTHY_TMP_RETENTION_FIRST_MS: '15000' },
  });
  const startWorker = async (app: Awaited<ReturnType<typeof launch>>) => {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'worker', prompt: '' }));
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).some((a) => a.id === 'worker' && a.cliRunning), { timeout: 60_000 }).toBe(true);
  };
  const seenLines = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  try {
    let app = await launch();
    try {
      await startWorker(app);
      await expect.poll(() => seenLines().length, { timeout: 30_000 }).toBe(1);
      // The retention's first pass, a few seconds after the launch, while the worker's CLI runs.
      await expect.poll(() => fs.existsSync(path.join(tmpRoot, shortIdOf('deleted-agent'))), { timeout: 30_000 }).toBe(false);
      await expect.poll(() => fs.existsSync(workerOld), { timeout: 30_000 }).toBe(false);
    } finally {
      await app.close();
    }
    // Still listened on after the pass: a client connects, by the same relative name.
    let socketAnswers = false;
    if (withSocket) try {
      execFileSync(process.execPath, ['-e', "const c = require('net').connect('4242.sock'); c.on('connect', () => { c.end(); process.exit(0); }); c.on('error', () => process.exit(1));"], { cwd: socks, timeout: 10_000 });
      socketAnswers = true;
    } catch { /* refused, or no socket */ }

    const [first] = seenLines();
    const expectedT = path.join(tmpRoot, shortIdOf('worker'), 't');
    const expectedC = path.join(tmpRoot, shortIdOf('worker'), 'c');
    const firstScratch = fs.readdirSync(expectedT).filter((n) => n.startsWith('scratch-'));
    const modes = [path.dirname(expectedT), expectedT, expectedC].map((d) => (fs.statSync(d).mode & 0o777).toString(8));

    // Tars again, on the same home: the same folder, what the CLI left still there.
    app = await launch();
    try {
      await startWorker(app);
      await expect.poll(() => seenLines().length, { timeout: 30_000 }).toBe(2);
    } finally {
      await app.close();
    }
    const second = seenLines()[1];
    const log = fs.existsSync(path.join(dir, 'logs', 'agent-tmp.log')) ? fs.readFileSync(path.join(dir, 'logs', 'agent-tmp.log'), 'utf8') : '';
    const values = {
      first, second, modes, firstScratch,
      scratchAfterRelaunch: fs.readdirSync(expectedT).filter((n) => n.startsWith('scratch-')),
      deletedAgentFolder: fs.existsSync(path.join(tmpRoot, shortIdOf('deleted-agent'))),
      liveAgentsOldFile: fs.existsSync(workerOld),
      liveSessionFolder: fs.existsSync(sessionFile),
      socket: fs.existsSync(socket),
      socketAnswers,
      log,
    };
    recordValues(values);

    expect(first).toEqual({ id: 'worker', TMPDIR: expectedT, CLAUDE_CODE_TMPDIR: expectedC });
    expect(second).toEqual(first);
    // POSIX mode bits, which Windows has none of: Node reads 666 for any folder there (measured).
    if (process.platform !== 'win32') expect(modes).toEqual(['700', '700', '700']);
    expect(firstScratch).toHaveLength(1);
    expect(values.scratchAfterRelaunch).toEqual(expect.arrayContaining(firstScratch));
    expect(values.deletedAgentFolder).toBe(false);
    expect(values.liveAgentsOldFile, 'the worker ran when the pass came: its t/ entry untouched for a day goes').toBe(false);
    expect(values.liveSessionFolder, 'the folder of the session it would resume stays, however old').toBe(true);
    if (withSocket) expect(values.socket, 'claude\'s messaging socket stays while a server listens on it').toBe(true);
    if (withSocket) expect(values.socketAnswers, 'and still answers').toBe(true);
    expect(log).toMatch(new RegExp(`removed .*${shortIdOf('deleted-agent')}.*untouched for 7 days`));
    expect(log).toMatch(/removed .*old-but-live\.txt.*untouched for a day, its agent running/);
  } finally {
    listener?.kill();
  }
});
