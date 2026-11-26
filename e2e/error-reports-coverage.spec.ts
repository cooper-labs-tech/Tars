import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as zlib from 'zlib';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { AddressInfo } from 'net';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Error reports in 2.0.4 (F1 to F4 of the maintainer's go of 2026-10-18, from the QA's diagnosis sentry-pipeline-1810), in
 * the real app against a stand-in of Sentry that records every envelope and answers the status it is told.
 *
 * Both shells. Started with "Send error reports" off, then turned on from the window as a user does:
 * - (F2) the log says the reports are on, with the version;
 * - (F1) an error Tars handles gives one envelope: an agent's CLI that exits at its launch, in a session the API starts
 *   (CliExitedAtLaunch), an IPC handler that faults (IpcHandlerError, its channel, the fault as its cause), an API route
 *   that answers 500 without throwing (ApiRouteError); and none of them carries what the error said (the Audit's M1 on
 *   #474): the fault leaves as its type and frames, the 500 as its route and status;
 * - (F3) an agent's tool error gives one envelope with its code, its tool and its CLI, and nothing of the agent: a worker's
 *   delegate_task, refused, through the real mcp-orchestrator with the worker's own identity;
 * - (F2) each send is logged with Sentry's status, and errorReports.last() gives the last one, a 503 included;
 * - (F4) an uncaught exception in main freezes nothing: no box is asked for, main and the window answer at once, and it
 *   leaves as before (fatal, unhandled);
 * - the kinds proven before stay: an error in the window (renderer), and the abrupt end of a killed run, at the next launch.
 * Then with the switch off: an uncaught exception in main shows no box, freezes nothing, and nothing leaves.
 *
 * No box can reach the screen: every test that throws in main first replaces dialog.showErrorBox by a recorder, and checks
 * that the recorder is in place.
 * The artefact: values.json with every envelope, every log line asserted, each answer of errorReports.last(), the
 * recorder's count and how long main took to answer.
 */

type Exception = { type?: string; value?: string; mechanism?: { type?: string; handled?: boolean } };
type Event = { level?: string; tags?: { kind?: string; process?: string }; contexts?: { tars?: Record<string, unknown> }; exception?: { values?: Exception[] } };
type Api = { electronAPI: {
  appSettings: { save(s: Record<string, unknown>): Promise<unknown> };
  project: { searchFiles(root: string, query: unknown): Promise<unknown>; searchContent(root: string, query: unknown): Promise<unknown> };
  errorReports?: { last(): Promise<{ at: string; kind: string; status: number } | null> };
} };

const NAME = 'Zephyrine';
const SECRET = 'acme-merger';

async function startFakeSentry() {
  const events: Event[] = [];
  const raw: string[] = [];
  const state = { status: 200 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
      const text = body.toString('utf8');
      raw.push(text);
      const lines = text.split('\n').filter(Boolean);
      for (let i = 1; i + 1 < lines.length; i += 2) {
        try {
          if (JSON.parse(lines[i]).type === 'event') events.push(JSON.parse(lines[i + 1]));
        } catch { /* not an event item */ }
      }
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { dsn: `http://e2epublickey@127.0.0.1:${port}/1`, events, raw, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const typesOf = (e: Event) => (e.exception?.values ?? []).map((x) => x.type);
const lastOf = (e: Event) => e.exception?.values?.at(-1);

/** The orchestrator MCP server with one agent's identity, as Tars hands it to that agent's CLI. */
function mcpAs(home: string, project: string, port: string, agentId: string, token: string, instance: string) {
  const mcp: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token,
      CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: instance,
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
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready;
    const reply = await rpc('tools/call', { name, arguments: args });
    return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
  return { call, kill: () => mcp.kill() };
}

function seed(home: string, reportsOn: boolean, newInterface: boolean) {
  const project = path.join(home, 'projects', SECRET);
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  // An agent's CLI that cannot start: it exits with code 2 at once, as codex 0.163 did on --full-auto.
  const crashCli = path.join(bin, 'claude');
  fs.writeFileSync(crashCli, '#!/bin/sh\necho "error: unexpected argument" >&2\nexit 2\n', { mode: 0o755 });
  const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
    createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', 'orchestrator'),
    agent('dev', NAME, 'worker'),
    agent('crash', 'Crashing Agent', 'worker', { cliPath: crashCli }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', errorReportsEnabled: reportsOn, newInterface,
  }));
  return { project };
}

async function boot(home: string, dsn: string, port: string, log: string[]) {
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_ERROR_REPORTS_DSN: dsn },
  });
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => log.push(...String(d).split('\n')));
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  return { app, page };
}

/** dialog.showErrorBox replaced by a recorder, checked in place: no modal box can reach the screen from here on. */
async function recordBoxes(app: ElectronApplication) {
  const ready = await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __e2eBoxes?: string[] };
    g.__e2eBoxes = [];
    const recorder = (title: string, content: string) => { g.__e2eBoxes!.push(`${title}: ${String(content).split('\n')[1] ?? ''}`); };
    dialog.showErrorBox = recorder;
    const viaRequire = (process as unknown as { mainModule: NodeJS.Module }).mainModule.require('electron').dialog;
    viaRequire.showErrorBox = recorder;
    viaRequire.showErrorBox('probe', 'probe\nthe recorder is in place');
    return g.__e2eBoxes.length === 1 && dialog.showErrorBox === recorder;
  });
  expect(ready, 'the box recorder is in place before anything throws in main').toBe(true);
  await app.evaluate(() => { (globalThis as unknown as { __e2eBoxes: string[] }).__e2eBoxes.length = 0; });
}
const boxes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __e2eBoxes: string[] }).__e2eBoxes.slice());

/** An uncaught exception in main, from a timer, then how long main and the window take to answer. */
async function throwInMain(app: ElectronApplication, page: Page, message: string) {
  await app.evaluate((_e, text) => { setTimeout(() => { throw new Error(text); }, 0); }, message);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 300));
  await app.evaluate(() => 1 + 1);
  const mainMs = Date.now() - t0;
  const t1 = Date.now();
  await page.evaluate(() => (window as unknown as { electronAPI: { appSettings: { get(): Promise<unknown> } } }).electronAPI.appSettings.get());
  return { mainMs, windowMs: Date.now() - t1 };
}

for (const newInterface of [false, true]) {
  test(`an error Tars handles, an agent's tool error and an uncaught exception each give one report, and silence is readable${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const sentry = await startFakeSentry();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-reports-'));
    const { project } = seed(home, false, newInterface);
    const port = apiPort(newInterface ? 31512 : 31511);
    const version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string;
    const log: string[] = [];
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more, { events: sentry.events }); recordValues(values); };
    const servers: Array<{ kill(): void }> = [];
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await boot(home, sentry.dsn, port, log));
      await recordBoxes(app);
      const api = <T>(fn: (a: Api['electronAPI']) => Promise<T>) => page.evaluate(`(${fn.toString()})(window.electronAPI)`) as Promise<T>;

      // ── Turned on from the window, as a user does (F2: the line that says so) ──
      await api((a) => a.appSettings.save({ errorReportsEnabled: true }));
      await expect.soft.poll(() => log.find((l) => l.includes('[error-reports] error reports on')) ?? '', { timeout: 30_000, message: 'the line that says the reports are on' })
        .toContain(`[error-reports] error reports on, tars@${version}`);
      // The window's own reports start with its next load.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      keep({ startLine: log.find((l) => l.includes('[error-reports] error reports on')) });

      const ids = await app.evaluate((_e, { dist }) => {
        const tokens = (process as unknown as { mainModule: NodeJS.Module }).mainModule.require(`${dist}/core/agent-tokens.js`);
        return { dev: tokens.mintRunToken('dev').token as string, tars: tokens.internalToken() as string, instance: tokens.tarsInstanceId() as string };
      }, { dist: path.resolve('electron', 'dist') });

      // ── F1: an agent's CLI that exits at its launch, in a session the API starts (its terminal is the CLI) ──
      const started = await fetch(`http://127.0.0.1:${port}/api/agents/crash/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ids.tars}` },
        body: JSON.stringify({ prompt: 'start' }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      await expect.soft.poll(() => sentry.events.filter((e) => typesOf(e).includes('CliExitedAtLaunch')).length, { timeout: 30_000, message: 'one report of the CLI that exited at its launch' }).toBe(1);
      const cliExit = sentry.events.find((e) => typesOf(e).includes('CliExitedAtLaunch'));
      expect.soft(lastOf(cliExit ?? {})?.value ?? '').toMatch(/^claude exited with code 2, [\d.]+ s after its launch$/);
      expect.soft(lastOf(cliExit ?? {})?.mechanism).toEqual({ type: 'tars.handled', handled: true });
      keep({ started, cliExit });

      // ── F1: an IPC handler that faults (a number where its query is a string) ──
      const ipcAnswer = await page.evaluate((root) => (window as unknown as Api).electronAPI.project.searchFiles(root, 42).then(() => 'answered', (e: Error) => String(e)), project);
      await expect.soft.poll(() => sentry.events.filter((e) => typesOf(e).includes('IpcHandlerError')).length, { timeout: 30_000, message: 'one report of the IPC handler that faulted' }).toBe(1);
      const ipcFault = sentry.events.find((e) => typesOf(e).includes('IpcHandlerError'));
      expect.soft(typesOf(ipcFault ?? {})).toEqual(['TypeError', 'IpcHandlerError']);
      expect.soft(lastOf(ipcFault ?? {})?.value).toBe('project:search-files');
      expect.soft(ipcFault?.exception?.values?.[0]?.value, "the fault's own words").toBe('(message not sent)');
      keep({ ipcAnswer, ipcFault });

      // ── F1: an API route that answers 500 without throwing ──
      const shared = fs.readFileSync(path.join(home, '.tars-private', 'api-token'), 'utf8').trim();
      const vault = await fetch(`http://127.0.0.1:${port}/api/vault/documents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shared}` },
        body: JSON.stringify({ title: { not: 'a string' }, content: 'x' }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
      expect(vault.status).toBe(500);
      await expect.soft.poll(() => sentry.events.filter((e) => typesOf(e).includes('ApiRouteError')).length, { timeout: 30_000, message: 'one report of the 500' }).toBe(1);
      const api500 = sentry.events.find((e) => typesOf(e).includes('ApiRouteError'));
      expect.soft(lastOf(api500 ?? {})?.value, "the route and status, never the route's error").toBe('POST /api/vault/documents answered 500');
      keep({ vault, api500 });

      // ── F3: a worker's delegate_task, refused, through the real MCP server with the worker's own identity ──
      const dev = mcpAs(home, project, port, 'dev', ids.dev, ids.instance);
      servers.push(dev);
      const refused = await dev.call('delegate_task', { id: 'lead', prompt: `TASK for Acme: merge ${SECRET}`, timeoutSeconds: 30 });
      expect(refused.isError, refused.text).toBe(true);
      await expect.soft.poll(() => sentry.events.filter((e) => e.tags?.kind === 'agent-tool').length, { timeout: 30_000, message: "one report of the agent's tool error" }).toBe(1);
      const toolError = sentry.events.find((e) => e.tags?.kind === 'agent-tool');
      expect.soft(toolError?.contexts?.tars).toEqual({ code: '403 worker_may_not_order', tool: 'delegate_task', cli: 'claude' });
      keep({ refused, toolError });

      // ── F2: each send logged with Sentry's status, and the last one for the window, a 503 included ──
      const sentLines = () => log.filter((l) => /\[error-reports\] sent an? [a-z-]+ report: HTTP \d+/.test(l));
      expect.soft(sentLines().length, 'a line per report sent').toBeGreaterThanOrEqual(4);
      const last = () => api((a) => a.errorReports?.last() ?? Promise.resolve(undefined));
      await expect.soft.poll(last, { timeout: 15_000, message: 'the last report, for the window' }).toMatchObject({ kind: 'agent-tool', status: 200 });
      const lastBefore = await last();
      sentry.state.status = 503;
      await page.evaluate((root) => (window as unknown as Api).electronAPI.project.searchContent(root, 7).then(() => 'answered', (e: Error) => String(e)), project);
      await expect.soft.poll(() => log.some((l) => l.includes('report: HTTP 503')), { timeout: 30_000, message: 'the 503 logged' }).toBe(true);
      await expect.soft.poll(last, { timeout: 15_000, message: "the last report's 503, for the window" }).toMatchObject({ kind: 'handled', status: 503 });
      const lastAfter = await last();
      sentry.state.status = 200;
      keep({ sentLines: sentLines(), lastBefore, lastAfter });

      // ── The window's own error, as before ──
      await page.evaluate(() => { setTimeout(() => { throw new Error('E2E: an error in the window'); }, 0); });
      await expect.soft.poll(() => sentry.events.filter((e) => e.tags?.process === 'renderer').length, { timeout: 30_000, message: "the window's error" }).toBe(1);

      // ── F4: an uncaught exception in main, with the reports on ──
      const before = sentry.events.length;
      const answered = await throwInMain(app, page, 'E2E: an uncaught exception in main, reports on');
      expect.soft(answered.mainMs, 'main answered at once').toBeLessThan(5_000);
      expect.soft(answered.windowMs, 'the window answered at once').toBeLessThan(5_000);
      await expect.soft.poll(() => sentry.events.slice(before).filter((e) => lastOf(e)?.value === 'E2E: an uncaught exception in main, reports on').length, { timeout: 30_000, message: 'the uncaught exception reported' }).toBe(1);
      const fatal = sentry.events.find((e) => lastOf(e)?.value === 'E2E: an uncaught exception in main, reports on');
      expect.soft(fatal?.level).toBe('fatal');
      expect.soft(lastOf(fatal ?? {})?.mechanism?.handled).toBe(false);
      // The SDK waits for its flush (2 s) before it would show its box: past it, nothing asked.
      await page.waitForTimeout(4_000);
      expect.soft(await boxes(app), 'no box asked for').toEqual([]);
      expect.soft(log.some((l) => l.includes('[uncaught]') && l.includes('E2E: an uncaught exception in main, reports on'))).toBe(true);
      keep({ answered, fatal, boxesAfterThrow: await boxes(app) });

      // ── Nothing of the agent or its task in any of it, nor of its project in its tool error. The code runs from the
      // worktree under the real home, which the app, on its sandbox home, does not know as one: frames name it here,
      // not in a packaged Tars, so the user's name is not looked for ──
      for (const text of sentry.raw) {
        expect.soft(text).not.toContain(home);
        expect.soft(text).not.toContain(NAME);
        expect.soft(text).not.toContain('Acme');
        // What the handled errors said (the Audit's M1 on #474): the fault's message, the route's error.
        expect.soft(text).not.toContain('toLowerCase');
        expect.soft(text).not.toContain(String((vault.body as { error?: string }).error ?? 'none'));
      }
      for (const text of sentry.raw.filter((t) => t.includes('"agent-tool"'))) {
        expect.soft(text).not.toContain(SECRET);
        expect.soft(text).not.toContain(project);
      }
      await stepShot(page, newInterface ? 'reports-on-new-interface' : 'reports-on');

      // ── The abrupt end, as before: a kill, then the next launch ──
      for (const server of servers.splice(0)) server.kill();
      process.kill(app.process().pid!, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 2_000));
      ({ app, page } = await boot(home, sentry.dsn, port, log));
      await expect.soft.poll(() => sentry.events.filter((e) => e.tags?.kind === 'abrupt-end').length, { timeout: 30_000, message: 'the abrupt end reported' }).toBe(1);
      keep({ abruptEnd: sentry.events.find((e) => e.tags?.kind === 'abrupt-end'), log: log.filter((l) => /\[error-reports\]|\[uncaught\]/.test(l)) });
    } finally {
      for (const server of servers) server.kill();
      await app?.close().catch(() => undefined);
      await sentry.close();
      await removeHome(home);
    }
  });

  test(`with the switch off, an uncaught exception in main shows no box, freezes nothing, and nothing leaves${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const sentry = await startFakeSentry();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-reports-off-'));
    seed(home, false, newInterface);
    const port = apiPort(newInterface ? 31514 : 31513);
    const log: string[] = [];
    let app: ElectronApplication | undefined;
    try {
      let page: Page;
      ({ app, page } = await boot(home, sentry.dsn, port, log));
      await recordBoxes(app);
      const answered = await throwInMain(app, page, 'E2E: an uncaught exception in main, reports off');
      expect(answered.mainMs, 'main answered at once').toBeLessThan(5_000);
      expect(answered.windowMs, 'the window answered at once').toBeLessThan(5_000);
      await page.waitForTimeout(4_000);
      expect(await boxes(app), 'no box asked for').toEqual([]);
      expect(log.some((l) => l.includes('[uncaught]') && l.includes('E2E: an uncaught exception in main, reports off'))).toBe(true);
      expect(sentry.raw).toEqual([]);
      recordValues({ newInterface, answered, boxes: await boxes(app), sent: sentry.raw, log: log.filter((l) => /\[uncaught\]/.test(l)) });
    } finally {
      await app?.close().catch(() => undefined);
      await sentry.close();
      await removeHome(home);
    }
  });
}
