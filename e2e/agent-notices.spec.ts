import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * Tars's notices about an agent reach the window (2.0.7; the Frontend's frames "Agent notices (2.0.7)", draft #623):
 * the main-process channel, in the real app.
 *
 * Two agents of one project:
 * - Cline Worker, on a stand-in of Cline's shape (as e2e/cline-folder-and-restart.spec.ts draws it);
 * - Claude Worker, on the recording stand-in of Claude Code (e2e/fake-clis.mjs).
 *
 * Asserted:
 * 1. The window's agent.onNotice is told as each notice is written:
 *    - Cline Worker's restart (the window's agent.restart) writes "Its conversation starts over: ...", kind
 *      conversation-restart;
 *    - a SessionStart posted for Claude Worker with the agent's token by a CLI that is not its terminal's is refused,
 *      kind session-refused.
 * 2. agent.notices() lists both, newest first, with the ids the events carried; agent.notices(id) only that agent's.
 * 3. Tars restarts: the same notices, ids and all, are still there.
 * 4. agent.markNoticesSeen(Claude Worker): agent.onNoticeSeen is told { agentId, ids, seenAt }; its notice reads seen,
 *    Cline Worker's does not; a second mark tells nothing.
 * Red on 7c3a29be6 (#620's head): the window has no agent.notices.
 * The artefact: values.json (the events, the lists before and after the restart, the mark), the app's trace.
 */

const CLINE = 'aaaa7777-0000-4000-8000-0000000000c1';
const CLAUDE = 'aaaa7777-0000-4000-8000-0000000000a1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Notice = { id: string; agentId: string; at: number; line: string; kind: string; seenAt?: number };
type Seen = { agentId: string; ids: string[]; seenAt: number };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  restart(id: string): Promise<{ success: boolean; error?: string }>;
  list(): Promise<Array<{ id: string; cliRunning?: boolean }>>;
  notices(agentId?: string): Promise<Notice[]>;
  onNotice(cb: (n: Notice) => void): () => void;
  markNoticesSeen(agentId: string, ids?: string[]): Promise<void>;
  onNoticeSeen(cb: (e: Seen) => void): () => void;
} } };
/** What the window heard, kept on the page. */
type Heard = { heard: { notices: Notice[]; seen: Seen[] } };

/** Cline's shape: a launcher whose field and footer show once up, as Tars reads its TUI (ClineProvider.upOnScreen). */
const CLINE_STAND_IN = String.raw`
const argv = process.argv.slice(2);
if (['--version', 'version', 'auth', 'mcp', 'config', '--help'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
setTimeout(() => process.stdout.write('\r\n❯ \r\nAuto-approve all disabled (Shift+Tab)\r\n'), 300);
process.stdin.resume();
`;

test.skip(process.platform === 'win32', 'the Cline stand-in is started as a POSIX script; the channel itself is the same on every system (unit tests)');

function seed(home: string): { project: string } {
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cline = path.join(bin, 'cline');
  fs.writeFileSync(cline, `#!${process.execPath}\n${CLINE_STAND_IN}`, { mode: 0o755 });
  const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
  const agent = (id: string, name: string, provider: string, cliPath: string) => ({
    id, name, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'normal',
    cliPath, createdAt: '2026-11-21T08:00:00.000Z', lastActivity: '2026-11-21T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(CLINE, 'Cline Worker', 'cline', cline), agent(CLAUDE, 'Claude Worker', 'claude', fakes.claude)], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', clineEnabled: true,
    cliPaths: { cline, claude: fakes.claude, additionalPaths: [bin, path.dirname(process.execPath)] },
  }));
  return { project };
}

async function openWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  await page.evaluate(() => {
    const w = window as unknown as Api & Heard;
    w.heard = { notices: [], seen: [] };
    w.electronAPI.agent.onNotice((n) => { w.heard.notices.push(n); });
    w.electronAPI.agent.onNoticeSeen((e) => { w.heard.seen.push(e); });
  });
  return page;
}

/** A POST to the app's API, as a hook's curl posts it. */
function post(port: string, route: string, token: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: route, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test("Tars's notices about an agent reach the window, live, kept across a restart, and marked seen", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-notices-'));
  const { project } = seed(home);
  const port = apiPort(31373);
  const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' };
  const dist = path.resolve('electron', 'dist');
  const errors: string[] = [];
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let app = await launchSandboxed(electron, home, { env });
  try {
    let page = await openWindow(app, errors);
    const heard = () => page.evaluate(() => (window as unknown as Heard).heard);
    const notices = (id?: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.notices(id), id);
    const markSeen = (id: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.markNoticesSeen(id), id);
    const start = (id: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
    const running = (id: string) => expect.poll(async () => {
      const agents = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      return agents.find((a) => a.id === id)?.cliRunning ?? false;
    }, { timeout: 30_000, message: `${id} never ran` }).toBe(true);

    // 1a. Cline Worker's restart: its conversation starts over, as Cline cannot fork. A session of its own to continue
    // first, as Cline keeps one in its folder's sessions.db (providers/cline-cli.ts, clineSessionOf): written from the
    // app's own process, whose better-sqlite3 is built for it, and named on the agent as its hooks would have.
    await start(CLINE);
    await running(CLINE);
    const clineSession = await app.evaluate((_e, { dist, id, project }) => {
      const req = process.mainModule!.require;
      const cline = req(`${dist}/providers/cline-cli.js`);
      const p = req('path');
      const Database = req('better-sqlite3');
      const sessionId = '1732171234567_abcde';
      const dir = p.join(cline.clineAgentDir(id), 'data', 'db');
      req('fs').mkdirSync(dir, { recursive: true });
      const db = new Database(p.join(dir, 'sessions.db'));
      db.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT, cwd TEXT)');
      db.prepare('INSERT INTO sessions (session_id, cwd) VALUES (?, ?)').run(sessionId, project);
      db.close();
      const agent = req(`${dist}/core/agent-manager.js`).agents.get(id);
      agent.resumableSessionId = cline.clineUuidOf(sessionId);
      return { sessionId, uuid: agent.resumableSessionId as string };
    }, { dist, id: CLINE, project });
    keep({ clineSession });
    const restarted = await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.restart(id), CLINE);
    keep({ restarted });
    expect(restarted).toMatchObject({ success: true });
    await expect.poll(async () => (await heard()).notices.filter((n) => n.agentId === CLINE).length, { timeout: 30_000 }).toBe(1);

    // 1b. A SessionStart for Claude Worker, with its token, from a CLI that is not its terminal's: refused.
    await start(CLAUDE);
    await running(CLAUDE);
    await sleep(1_500);
    const token = await app.evaluate((_e, { dist, id }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintAgentToken(id) as string, { dist, id: CLAUDE });
    const refused = await post(port, '/api/hooks/status', token, {
      agent_id: CLAUDE, session_id: crypto.randomUUID(), status: 'idle', source: 'startup', cli_pid: String(process.pid),
    });
    keep({ refused });
    expect(JSON.parse(refused.body)).toMatchObject({ success: false, foreign: true });
    await expect.poll(async () => (await heard()).notices.filter((n) => n.agentId === CLAUDE).length, { timeout: 30_000 }).toBe(1);

    const events = (await heard()).notices;
    keep({ events });
    const restart = events.find((n) => n.agentId === CLINE)!;
    const refusal = events.find((n) => n.agentId === CLAUDE)!;
    expect(restart).toMatchObject({ kind: 'conversation-restart', line: expect.stringMatching(/^Its conversation starts over: Cline cannot fork a session/) });
    expect(refusal).toMatchObject({ kind: 'session-refused', line: expect.stringMatching(/^Refused a session \(/) });
    for (const n of [restart, refusal]) {
      expect(n.line).not.toContain('[Tars]');
      expect(n.seenAt).toBeUndefined();
    }

    // 2. Listed newest first, with the events' ids; one agent's alone.
    const listed = await notices();
    const clineOnly = await notices(CLINE);
    keep({ listed, clineOnly });
    expect(listed).toEqual([refusal, restart]);
    expect(clineOnly).toEqual([restart]);

    // 3. Tars restarts: the same notices.
    await app.close();
    app = await launchSandboxed(electron, home, { env });
    page = await openWindow(app, errors);
    const afterRestart = await notices();
    keep({ afterRestart });
    expect(afterRestart).toEqual([refusal, restart]);

    // 4. Marked seen: told, read seen, the other agent's not; a second mark tells nothing.
    await markSeen(CLAUDE);
    await expect.poll(async () => (await heard()).seen.length, { timeout: 10_000 }).toBe(1);
    const seen = (await heard()).seen[0];
    const afterSeen = await notices();
    keep({ seen, afterSeen });
    expect(seen).toMatchObject({ agentId: CLAUDE, ids: [refusal.id] });
    expect(afterSeen.find((n) => n.id === refusal.id)?.seenAt).toBe(seen.seenAt);
    expect(afterSeen.find((n) => n.id === restart.id)?.seenAt).toBeUndefined();
    await markSeen(CLAUDE);
    await sleep(500);
    expect((await heard()).seen).toHaveLength(1);
    keep({ errors });
    expect(errors).toEqual([]);
  } finally {
    recordValues(values);
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
