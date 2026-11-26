import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort, PORT_OFFSET } from './ports.mjs';

/**
 * Another session's message reaches an orchestrator and not a worker (the owner's decision of 2026-11-26: "garder pour
 * les orchestrateurs").
 *
 * Claude Code (2.1.224 and later) opens an inbox socket for each session, under its CLAUDE_CODE_TMPDIR, which Tars sets
 * to the agent's own ~/.tars/tmp/<short id>/c. Any process of the user's can post there on macOS and Linux; a session
 * that prompts for permissions takes a post that attests no mode as a user turn (measured on 2.1.332). Here two agents
 * of Tars on the real claude, both in normal mode, each in a project of its own, against a stand-in of the Messages
 * API (e2e/live/fake-messages-api.mjs): Lead, an orchestrator, and Worker. The spec, a process that is neither,
 * posts a line to each inbox, as another session of the machine would.
 *
 * Asserted:
 * 1. Lead's post reaches its model (a request carries its words);
 * 2. Worker's does not, in the same time and twice as long again (at least 10 s more), and its screen shows neither
 *    the post nor a dialog about it;
 * 3. Worker's model is offered neither ListAgents nor SendMessage; Lead's is offered both;
 * 4. Worker's claude runs with the setting on its own command line, and the user's ~/.claude/settings.json never
 *    holds it.
 * On the build before this rule (or with workerPeerFlags returning nothing), 2, 3 and 4 fail: the worker takes the post.
 *
 * Live: E2E_LIVE=1 and a native claude; macOS and Linux (on Windows the inbox is a named pipe and needs its token).
 * The artefact: values.json (each post and its answer, the requests that carried a post, the tools each model was
 * offered, Worker's command line, both screens' last rows), the stand-in's log and a screenshot.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;
const STUB = 31982 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'1'.repeat(80)}-BBBBBBBB`;
const MODEL = 'claude-opus-5-5';

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

/** The agent's inbox: the one socket under its CLAUDE_CODE_TMPDIR's cc-socks (services/agent-tmp.ts, shortIdOf). */
function inboxOf(home: string, agentId: string): string | null {
  const dir = path.join(home, '.tars', 'tmp', createHash('sha256').update(agentId).digest('hex').slice(0, 10), 'c', 'cc-socks');
  try {
    const socks = fs.readdirSync(dir).filter((f) => f.endsWith('.sock'));
    return socks.length === 1 ? path.join(dir, socks[0]) : null;
  } catch {
    return null;
  }
}

/** One post, as another session sends it: a user line on the socket, then whatever the inbox answers before it closes. */
function post(socket: string, text: string): Promise<{ answer: string; error?: string }> {
  return new Promise((resolve) => {
    let answer = '';
    const s = net.connect(socket);
    const done = (error?: string) => { s.destroy(); resolve({ answer: answer.trim(), ...(error ? { error } : {}) }); };
    s.on('connect', () => s.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`));
    s.on('data', (d) => { answer += String(d); });
    s.on('error', (e) => done(String((e as NodeJS.ErrnoException).code ?? e)));
    s.on('close', () => done());
    setTimeout(() => done(), 4_000);
  });
}

test('another session\'s message reaches an orchestrator and is refused by a worker, whose model has no tool to reach one', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.skip(process.platform === 'win32', 'the inbox is a named pipe on Windows, its token required');
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  test.setTimeout(6 * 60_000);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const nonce = randomBytes(3).toString('hex');
  const TO_LEAD = `PEER-TO-LEAD-${nonce}`;
  const TO_WORKER = `PEER-TO-WORKER-${nonce}`;

  // /tmp, not os.tmpdir(): the CLI's cwd is its physical path, and a socket's path must stay short.
  const home = fs.mkdtempSync('/tmp/tars-peer-live-');
  const projects = { lead: path.join(home, 'projects', 'lead'), worker: path.join(home, 'projects', 'worker') };
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), projects.lead, projects.worker]) fs.mkdirSync(dir, { recursive: true });
  for (const p of Object.values(projects)) execFileSync('git', ['init', '-q', p]);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const seededSettings = JSON.stringify({ tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2);
  fs.writeFileSync(settingsFile, seededSettings);
  const version = path.basename(CLAUDE);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    // ~/.tars too: every agent has it as an added folder, and in normal mode claude asks whether to trust a folder it
    // has not worked in ("Yes, add it"), a question nothing answers in an agent's terminal.
    projects: Object.fromEntries([...Object.values(projects), path.join(home, '.tars')].flatMap((p) => [[p, trusted], [fs.realpathSync(p), trusted]])),
  }, null, 2));
  const agent = (id: string, name: string, projectPath: string, role: 'orchestrator' | 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, orchestratorMode: role === 'orchestrator', projectPath, skills: [], output: [],
    permissionMode: 'normal', cliPath: CLAUDE, model: MODEL, lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify({
    version: 3, agents: [agent('lead', 'Lead', projects.lead, 'orchestrator'), agent('worker', 'Worker', projects.worker, 'worker')],
  }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify(Object.values(projects), null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: CLAUDE } }, null, 2));

  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG }, stdio: 'ignore',
  });
  type Req = { full?: string; last?: string; side?: boolean; tools?: string[]; deferred?: string[] };
  const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Req) : []);
  const carrying = (word: string) => requests().filter((r) => !r.side && (r.full ?? '').includes(word));
  const values: Record<string, unknown> = { claude: CLAUDE, nonce, platform: process.platform, tmpdir: process.env.TMPDIR ?? null };
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31439), DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    });
    /** Both agents' terminals and records as the run ends, kept whether it passed or not. */
    let lastWords: () => Promise<unknown> = async () => null;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      type A = { status: string; currentSessionId?: string; cliRunning?: boolean };
      const agentOf = (id: string) => page.evaluate((i) => (window as unknown as { electronAPI: { agent: { get(id: string): Promise<A> } } }).electronAPI.agent.get(i), id);
      const start = (id: string) => page.evaluate((i) => (window as unknown as { electronAPI: { agent: { start(a: unknown): Promise<unknown> } } }).electronAPI.agent.start({ id: i, prompt: '' }), id);
      const running = (id: string) => expect.poll(async () => { const a = await agentOf(id); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 90_000, message: `${id} runs` }).toBe(true);
      /** The agent's screen, as Tars's mirror of its terminal holds it: its last non-blank rows. */
      const screenOf = (id: string) => app.evaluate((_e, [dist, id]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get(id);
        const pty = a?.ptyId ? (req(`${dist}/core/pty-manager.js`).ptyProcesses as Map<string, unknown>).get(a.ptyId) : undefined;
        const { dialogOnScreen, terminalText } = req(`${dist}/core/terminal-mirror.js`) as { dialogOnScreen(p: unknown): boolean; terminalText(p: unknown): string[] | undefined };
        return { dialog: dialogOnScreen(pty), text: (terminalText(pty) ?? []).filter((l) => l.trim()).slice(-8) };
      }, [DIST, id] as const);
      const tyPe = (id: string, text: string) => app.evaluate((_e, [dist, id, text]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get(id);
        const { ptyProcesses, writeProgrammaticInput } = req(`${dist}/core/pty-manager.js`) as { ptyProcesses: Map<string, unknown>; writeProgrammaticInput: (p: unknown, t: string, s: boolean) => unknown };
        return a?.ptyId ? writeProgrammaticInput(ptyProcesses.get(a.ptyId), text, true) : null;
      }, [DIST, id, text] as const);
      lastWords = async () => ({
        screens: { lead: await screenOf('lead'), worker: await screenOf('worker') },
        agents: { lead: await agentOf('lead'), worker: await agentOf('worker') },
      });

      const started: Record<string, unknown> = {};
      values.started = started;
      for (const id of ['lead', 'worker']) {
        started[id] = await start(id);
        await running(id);
      }
      await expect.poll(() => [inboxOf(home, 'lead'), inboxOf(home, 'worker')].every(Boolean), { timeout: 30_000, message: 'both inboxes open' }).toBe(true);
      values.inboxes = { lead: inboxOf(home, 'lead')!.replace(home, '<home>'), worker: inboxOf(home, 'worker')!.replace(home, '<home>') };
      // Both idle at their prompt before anything is posted.
      for (const id of ['lead', 'worker']) await expect.poll(async () => (await agentOf(id)).status, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed)$/);

      // 4. The worker's own command line, and nothing written for it into the user's settings.
      const workerPid = Number(path.basename(inboxOf(home, 'worker')!, '.sock'));
      const workerCommand = execFileSync('ps', ['-o', 'command=', '-p', String(workerPid)]).toString().trim();
      values.workerCommand = workerCommand.replace(home, '<home>');
      expect(workerCommand).toContain('"crossSessionInbound":"refuse"');
      // Tars writes its hooks and status line there at launch; never this.
      expect(fs.readFileSync(settingsFile, 'utf8')).not.toContain('crossSessionInbound');

      // 1, 2. A post to each, from this process: neither of them.
      values.posts = {
        lead: await post(inboxOf(home, 'lead')!, `${TO_LEAD} a message from another session`),
        worker: await post(inboxOf(home, 'worker')!, `${TO_WORKER} a message from another session`),
      };
      recordValues(values);
      const t0 = Date.now();
      await expect.poll(() => carrying(TO_LEAD).length, { timeout: 90_000, message: 'the post reached the orchestrator\'s model' }).toBeGreaterThan(0);
      const took = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(10_000, 2 * took)));
      values.carried = { lead: carrying(TO_LEAD).length, worker: carrying(TO_WORKER).length, waitedMs: Math.max(10_000, 2 * took) + took };
      values.screens = { lead: await screenOf('lead'), worker: await screenOf('worker') };
      recordValues(values);
      await stepShot(page, 'after-posts');
      // The inbox writes nothing back on the connection, delivered or refused (measured on 2.1.332): the posts' answers
      // are kept, and the proof is what reached each model.
      expect(carrying(TO_WORKER), 'a post from another session reached the worker\'s model').toEqual([]);
      expect((values.screens as { worker: { dialog: boolean } }).worker.dialog, 'the worker shows a dialog about the post').toBe(false);
      expect(JSON.stringify((values.screens as { worker: { text: string[] } }).worker.text)).not.toContain(TO_WORKER);

      // 3. The tools each model is offered, or listed to load with ToolSearch (SendMessage is one of those on 2.1.332,
      // and a turn a peer's post started carries no such list): a turn typed into each.
      const toolsOf = (r: Req) => [...(r.tools ?? []), ...(r.deferred ?? [])];
      const typedTurn = async (id: string, tag: string) => {
        await expect.poll(async () => (await agentOf(id)).status, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed)$/);
        expect(await tyPe(id, `LINES 1 ${tag}`)).not.toBeNull();
        await expect.poll(() => carrying(tag).length, { timeout: 90_000, message: `${id}'s typed turn reached the model` }).toBeGreaterThan(0);
        return toolsOf(carrying(tag)[0]);
      };
      const workerTools = await typedTurn('worker', `wtools${nonce}`);
      const leadTools = await typedTurn('lead', `ltools${nonce}`);
      values.tools = { worker: workerTools, lead: leadTools };
      recordValues(values);
      expect(workerTools.length, 'the stand-in logged no tool').toBeGreaterThan(0);
      expect(workerTools).not.toContain('ListAgents');
      expect(workerTools).not.toContain('SendMessage');
      expect(leadTools).toEqual(expect.arrayContaining(['ListAgents', 'SendMessage']));
    } finally {
      values.atEnd = await lastWords().catch((err) => String(err));
      values.requests = requests().map((r) => ({ last: r.last, side: r.side, tools: r.tools?.length }));
      recordValues(values);
      await app.close();
    }
  } finally {
    stub.kill();
    // removeHome retries: a real claude can write ~/.claude.json after app.close() (the QA's Info on #404).
    await removeHome(home);
  }
});
