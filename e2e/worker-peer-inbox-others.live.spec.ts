import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort, PORT_OFFSET } from './ports.mjs';

/**
 * Another session's message reaches an orchestrator and not a worker, on codex and on Qwen Code (the owner's decision
 * of 2026-11-26; worker-peer-inbox.live.spec.ts does claude). Each test runs two agents of Tars on the real CLI, both
 * in bypass, each in a project of its own, against a stand-in of the model's API (e2e/live/fake-openai-api.mjs, no
 * account): Lead, an orchestrator, and Worker. The spec, a process that is neither, sends each the message the way
 * another session of the machine would.
 *
 * codex (0.163): once each has a thread (a turn typed into it), `codex queue --thread <its id>` from the spec, in the
 * CODEX_HOME every codex of the sandbox shares. Asserted: Lead's message reaches its model; Worker's does not, in the
 * same time and twice as long again (at least 10 s more); Worker's codex runs on databases of its own (`sqlite_home`
 * on its command line, in its agent's ~/.tars/tmp folder).
 *
 * Qwen Code (0.25.2): each session lists itself under ~/.qwen/sessions; the spec posts to every inbox listed, as its
 * protocol says (qc-helper/docs/features/cross-session-protocol.md). Asserted: Lead's record has an inbox and its
 * message reaches its model; Worker's record has none and no socket of its process exists; the settings file of
 * Tars's that Worker runs with turns cross-session messaging off, and Lead's says nothing of it.
 *
 * On the build before this rule each worker takes the message, so each test fails.
 *
 * Live: E2E_LIVE=1 and the CLI on PATH (or E2E_CODEX, E2E_QWEN); macOS and Linux. The artefact: values.json (what was
 * sent and how it was answered, the requests that carried each message, the workers' command lines or settings,
 * both terminals' last rows), the stand-in's log and a screenshot.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;
const MODEL = 'stand-in-coder';
const KEY = `sk-e2e-stand-in-${'2'.repeat(24)}`;

function resolve(bin: string, named: string | undefined): string {
  const found = named || (() => { try { return execFileSync('which', [bin]).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

type Req = { proto?: string; tools?: string[]; text?: string; listening?: number };
type A = { status: string; cliRunning?: boolean; currentSessionId?: string; ptyId?: string };

/** A sandbox home with two projects, the agents Lead (orchestrator) and Worker of one provider, and the stand-in. */
async function sandbox(prefix: string, provider: 'codex' | 'qwen-code', cli: string, stubPort: number, seed: (home: string, projects: Record<string, string>) => void) {
  const home = fs.mkdtempSync(`/tmp/${prefix}-`);
  const projects = { lead: path.join(home, 'projects', 'lead'), worker: path.join(home, 'projects', 'worker') };
  for (const dir of [path.join(home, '.tars'), projects.lead, projects.worker]) fs.mkdirSync(dir, { recursive: true });
  for (const p of Object.values(projects)) execFileSync('git', ['init', '-q', p]);
  const agent = (id: string, name: string, projectPath: string, role: 'orchestrator' | 'worker') => ({
    id, name, character: 'robot', provider, status: 'idle', role, orchestratorMode: role === 'orchestrator', projectPath, skills: [], output: [],
    permissionMode: 'bypass', cliPath: cli, model: MODEL, lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify({
    version: 3, agents: [agent('lead', 'Lead', projects.lead, 'orchestrator'), agent('worker', 'Worker', projects.worker, 'worker')],
  }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify(Object.values(projects), null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', codexEnabled: true, qwenEnabled: true,
    cliPaths: { codex: cli, qwencode: cli, qwen: cli, additionalPaths: [path.dirname(cli)] },
  }, null, 2));
  seed(home, projects);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-openai-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(stubPort), FAKE_LOG, FAKE_MODEL: MODEL }, stdio: 'ignore',
  });
  const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Req).filter((r) => !r.listening) : []);
  const carrying = (word: string) => requests().filter((r) => (r.text ?? '').includes(word));
  return { home, projects, stub, requests, carrying };
}

/** The window's and the main process's handles on the two agents. */
function handles(app: ElectronApplication, page: Page) {
  const agentOf = (id: string) => page.evaluate((i) => (window as unknown as { electronAPI: { agent: { get(id: string): Promise<A> } } }).electronAPI.agent.get(i), id);
  const start = (id: string) => page.evaluate((i) => (window as unknown as { electronAPI: { agent: { start(a: unknown): Promise<unknown> } } }).electronAPI.agent.start({ id: i, prompt: '' }), id);
  const screenOf = (id: string) => app.evaluate((_e, [dist, id]) => {
    const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
    const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get(id);
    const pty = a?.ptyId ? (req(`${dist}/core/pty-manager.js`).ptyProcesses as Map<string, unknown>).get(a.ptyId) : undefined;
    const { terminalText } = req(`${dist}/core/terminal-mirror.js`) as { terminalText(p: unknown): string[] | undefined };
    return (terminalText(pty) ?? []).filter((l) => l.trim()).slice(-8);
  }, [DIST, id] as const);
  const type = (id: string, text: string) => app.evaluate((_e, [dist, id, text]) => {
    const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
    const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get(id);
    const { ptyProcesses, writeProgrammaticInput } = req(`${dist}/core/pty-manager.js`) as { ptyProcesses: Map<string, unknown>; writeProgrammaticInput: (p: unknown, t: string, s: boolean) => unknown };
    return a?.ptyId ? writeProgrammaticInput(ptyProcesses.get(a.ptyId), text, true) : null;
  }, [DIST, id, text] as const);
  return { agentOf, start, screenOf, type };
}

/** Stops what a CLI left running under the sandbox home (codex's daemon and its git fetches), by PID, each checked. */
function stopLeftovers(home: string): number[] {
  const stopped: number[] = [];
  for (const line of execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].includes(home)) continue;
    const pid = Number(m[1]);
    const now = (() => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)]).toString(); } catch { return ''; } })();
    if (now.includes(home)) { try { process.kill(pid); stopped.push(pid); } catch { /* gone */ } }
  }
  return stopped;
}

const env = (stub: number) => ({
  NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1',
  TARS_E2E_OPENAI_KEY: KEY, OPENAI_BASE_URL: `http://127.0.0.1:${stub}/v1`, OPENAI_API_KEY: KEY, OPENAI_MODEL: MODEL,
});

test('codex: another session\'s queued message reaches an orchestrator and not a worker, which runs on databases of its own', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and codex');
  test.skip(process.platform === 'win32', 'macOS and Linux');
  const CODEX = resolve('codex', process.env.E2E_CODEX);
  test.skip(!CODEX, 'no codex: set E2E_CODEX or put codex on PATH');
  test.setTimeout(6 * 60_000);
  const STUB = 31980 + PORT_OFFSET;
  const nonce = randomBytes(3).toString('hex');
  const { home, projects, stub, requests, carrying } = await sandbox('tars-peer-codex', 'codex', CODEX, STUB, (home, projects) => {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      `model = "${MODEL}"`, 'model_provider = "stand-in"', 'check_for_update_on_startup = false', '',
      '[model_providers.stand-in]', 'name = "Stand-in"', `base_url = "http://127.0.0.1:${STUB}/v1"`, 'env_key = "TARS_E2E_OPENAI_KEY"', 'wire_api = "responses"', '',
      ...Object.values(projects).flatMap((p) => [p, fs.realpathSync(p)]).flatMap((p) => [`[projects."${p}"]`, 'trust_level = "trusted"', '']),
      // The two orchestrator-only servers, as a machine that ran 2.0.4 has them, off: a worker's codex is started with
      // `-c mcp_servers.<name>.enabled=false` for each (services/mcp-roles.ts), and codex 0.163 refuses to start on
      // that for a server its config does not have ("invalid transport"), as on a fresh CODEX_HOME. That is not what
      // this spec is about: reported apart.
      ...['claude-mgr-telegram', 'dorothy-x'].flatMap((name) => [`[mcp_servers.${name}]`, 'command = "true"', 'enabled = false', '']),
    ].join('\n'));
  });
  const values: Record<string, unknown> = { codex: CODEX, version: execFileSync(CODEX, ['--version']).toString().trim(), nonce, tmpdir: process.env.TMPDIR ?? null };
  /** Each agent's thread: the rollout of codex's sessions whose cwd is its project. */
  const threadOf = (project: string): string | null => {
    const found: string[] = [];
    const walk = (d: string) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) found.push(p); } } catch { /* none yet */ } };
    walk(path.join(home, '.codex', 'sessions'));
    for (const file of found) {
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
        if ([project, fs.realpathSync(project)].includes(meta?.payload?.cwd)) return meta.payload.id ?? null;
      } catch { /* being written */ }
    }
    return null;
  };
  try {
    const app = await launchSandboxed(electron, home, { env: { ...env(STUB), DOROTHY_API_PORT: apiPort(31441) } });
    let lastWords: () => Promise<unknown> = async () => null;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      const { agentOf, start, screenOf, type } = handles(app, page);
      lastWords = async () => ({ lead: await screenOf('lead'), worker: await screenOf('worker') });
      values.started = {};
      for (const id of ['lead', 'worker']) {
        (values.started as Record<string, unknown>)[id] = await start(id);
        await expect.poll(async () => (await agentOf(id)).cliRunning === true, { timeout: 90_000, message: `${id}'s codex runs` }).toBe(true);
        await expect.poll(async () => (await screenOf(id)).join('\n'), { timeout: 90_000, message: `${id}'s codex at its prompt` }).toMatch(/›/);
      }
      // A thread for each: a turn typed into it, as Tars types a task.
      for (const id of ['lead', 'worker'] as const) {
        expect(await type(id, `say hi TASK-${id}-${nonce}`)).not.toBeNull();
        await expect.poll(() => carrying(`TASK-${id}-${nonce}`).length, { timeout: 90_000, message: `${id}'s turn reached the model` }).toBeGreaterThan(0);
        await expect.poll(() => threadOf(projects[id]), { timeout: 30_000, message: `${id}'s thread` }).not.toBeNull();
      }
      const threads = { lead: threadOf(projects.lead)!, worker: threadOf(projects.worker)! };
      values.threads = threads;
      const workerLine = execFileSync('ps', ['-axo', 'command=']).toString().split('\n').find((l) => l.includes('sqlite_home=') && l.includes(home)) ?? '';
      values.workerSqliteHome = workerLine.match(/sqlite_home=("[^"]*"|\S+)/)?.[1]?.replace(home, '<home>') ?? null;
      expect(values.workerSqliteHome, 'the worker\'s codex on the shared databases').toMatch(/<home>\/\.tars\/tmp\/[0-9a-f]{10}\/codex/);
      const leadLine = execFileSync('ps', ['-axo', 'command=']).toString().split('\n').filter((l) => l.includes(home) && l.includes(projects.lead));
      values.leadSqliteHome = leadLine.some((l) => l.includes('sqlite_home=')) ? 'set' : 'shared';
      recordValues(values);

      const queue = (thread: string, text: string) => {
        try {
          return { out: execFileSync(CODEX, ['queue', '--thread', thread, '--message', text], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, '.codex') }, timeout: 60_000 }).toString().trim() };
        } catch (err) { return { error: String((err as { stderr?: Buffer }).stderr ?? err).slice(0, 300) }; }
      };
      const TO_LEAD = `QUEUED-TO-LEAD-${nonce}`;
      const TO_WORKER = `QUEUED-TO-WORKER-${nonce}`;
      values.queued = { worker: queue(threads.worker, `${TO_WORKER} a message from another session`), lead: queue(threads.lead, `${TO_LEAD} a message from another session`) };
      recordValues(values);
      const t0 = Date.now();
      await expect.poll(() => carrying(TO_LEAD).length, { timeout: 90_000, message: 'the queued message reached the orchestrator\'s model' }).toBeGreaterThan(0);
      const took = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(10_000, 2 * took)));
      values.carried = { lead: carrying(TO_LEAD).length, worker: carrying(TO_WORKER).length, waitedMs: Math.max(10_000, 2 * took) + took };
      values.screens = await lastWords();
      recordValues(values);
      await stepShot(page, 'codex-after-queue');
      expect(carrying(TO_WORKER), 'a queued message from another session reached the worker\'s model').toEqual([]);
    } finally {
      values.atEnd = await lastWords().catch((err) => String(err));
      values.requests = requests().map((r) => ({ proto: r.proto, tools: r.tools?.length }));
      recordValues(values);
      await app.close();
    }
  } finally {
    stub.kill();
    values.stoppedLeftovers = stopLeftovers(home);
    recordValues(values);
    await removeHome(home);
  }
});

test('Qwen Code: another session\'s message reaches an orchestrator, and a worker lists no inbox at all', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and qwen');
  test.skip(process.platform === 'win32', 'macOS and Linux');
  const QWEN = resolve('qwen', process.env.E2E_QWEN);
  test.skip(!QWEN, 'no qwen: set E2E_QWEN or put qwen on PATH');
  test.setTimeout(6 * 60_000);
  const STUB = 31979 + PORT_OFFSET;
  const nonce = randomBytes(3).toString('hex');
  const { home, stub, requests, carrying } = await sandbox('tars-peer-qwen', 'qwen-code', QWEN, STUB, (home) => {
    fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
    fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({
      security: { auth: { selectedType: 'openai' } }, model: { name: MODEL }, general: { enableAutoUpdate: false },
    }, null, 2));
  });
  const values: Record<string, unknown> = { qwen: QWEN, nonce, tmpdir: process.env.TMPDIR ?? null };
  type Rec = { pid: number; cwd: string; sessionId: string; ipcPath?: string; ipcToken?: string };
  const records = (): Rec[] => {
    const dir = path.join(home, '.qwen', 'sessions');
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Rec; } catch { return null; } }).filter((r): r is Rec => !!r);
    } catch { return []; }
  };
  const recordOf = (project: string) => records().find((r) => [project, fs.realpathSync(project)].includes(r.cwd));
  /** One message, as another session sends it: the auth line with the record's token, then the user frame. */
  const post = (r: Rec, text: string) => new Promise<Record<string, unknown>>((done) => {
    if (!r.ipcPath) return done({ noInbox: true });
    const s = net.connect(r.ipcPath);
    s.on('connect', () => s.end(`${[
      ...(r.ipcToken ? [JSON.stringify({ msgV: 1, type: 'auth', token: r.ipcToken })] : []),
      JSON.stringify({ msgV: 1, msgId: randomUUID(), type: 'user', fromName: 'another-session', fromMode: 'bypass', toSessionId: r.sessionId, priority: 'next', message: { role: 'user', content: text } }),
    ].join('\n')}\n`));
    s.on('error', (e) => done({ error: String((e as NodeJS.ErrnoException).code ?? e) }));
    s.on('close', () => done({ sent: true }));
    setTimeout(() => { s.destroy(); done({ timeout: true }); }, 5_000);
  });
  try {
    const app = await launchSandboxed(electron, home, { env: { ...env(STUB), DOROTHY_API_PORT: apiPort(31443) } });
    let lastWords: () => Promise<unknown> = async () => null;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      const { agentOf, start, screenOf } = handles(app, page);
      lastWords = async () => ({ lead: await screenOf('lead'), worker: await screenOf('worker') });
      values.started = {};
      for (const id of ['lead', 'worker']) {
        (values.started as Record<string, unknown>)[id] = await start(id);
        await expect.poll(async () => (await agentOf(id)).cliRunning === true, { timeout: 90_000, message: `${id}'s qwen runs` }).toBe(true);
      }
      const projects = { lead: path.join(home, 'projects', 'lead'), worker: path.join(home, 'projects', 'worker') };
      await expect.poll(() => !!(recordOf(projects.lead) && recordOf(projects.worker)), { timeout: 90_000, message: 'both sessions listed' }).toBe(true);
      const lead = recordOf(projects.lead)!;
      const worker = recordOf(projects.worker)!;
      const sockets: string[] = [];
      const walk = (d: string) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isSocket()) sockets.push(p); } } catch { /* gone */ } };
      walk(home);
      values.records = { lead: { pid: lead.pid, inbox: !!lead.ipcPath, token: !!lead.ipcToken }, worker: { pid: worker.pid, inbox: !!worker.ipcPath, token: !!worker.ipcToken } };
      values.workerSockets = sockets.filter((s) => path.basename(s).startsWith(`${worker.pid}`) && s.includes('qwen-socks')).map((s) => s.replace(home, '<home>'));
      const settingsOf = (id: string) => JSON.parse(fs.readFileSync(path.join(home, '.tars', 'qwen-code', 'agents', `${id}.json`), 'utf8')).agents ?? null;
      values.settings = { lead: settingsOf('lead'), worker: settingsOf('worker') };
      recordValues(values);
      expect(values.settings).toEqual({ lead: null, worker: { crossSessionMessaging: false } });
      expect(lead.ipcPath, 'the orchestrator lists no inbox').toBeTruthy();
      expect(worker.ipcPath, 'the worker lists an inbox').toBeFalsy();
      expect(values.workerSockets, 'a socket of the worker\'s process').toEqual([]);

      const TO_LEAD = `PEER-TO-LEAD-${nonce}`;
      const TO_WORKER = `PEER-TO-WORKER-${nonce}`;
      values.posts = { lead: await post(lead, `${TO_LEAD} a message from another session`), worker: await post(worker, `${TO_WORKER} a message from another session`) };
      recordValues(values);
      const t0 = Date.now();
      await expect.poll(() => carrying(TO_LEAD).length, { timeout: 90_000, message: 'the message reached the orchestrator\'s model' }).toBeGreaterThan(0);
      const took = Date.now() - t0;
      await new Promise((r) => setTimeout(r, Math.max(10_000, 2 * took)));
      values.carried = { lead: carrying(TO_LEAD).length, worker: carrying(TO_WORKER).length, waitedMs: Math.max(10_000, 2 * took) + took };
      values.screens = await lastWords();
      recordValues(values);
      await stepShot(page, 'qwen-after-posts');
      expect(carrying(TO_WORKER), 'a message from another session reached the worker\'s model').toEqual([]);
    } finally {
      values.atEnd = await lastWords().catch((err) => String(err));
      values.requests = requests().map((r) => ({ proto: r.proto, tools: r.tools?.length }));
      recordValues(values);
      await app.close();
    }
  } finally {
    stub.kill();
    values.stoppedLeftovers = stopLeftovers(home);
    recordValues(values);
    await removeHome(home);
  }
});
