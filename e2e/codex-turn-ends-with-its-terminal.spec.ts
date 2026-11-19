import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * codex 0.170 in an agent's terminal: it starts, and its turn ends with its terminal (measured on codex-cli 0.170.0,
 * 20/11, first seen by the harness conformance run of PR #601).
 *
 * The two ways 0.170 broke a codex agent:
 * 1. It refuses to start on `-c mcp_servers.<name>.enabled=false` for a server its config.toml does not define
 *    ("Error: invalid transport in `mcp_servers.claude-mgr-telegram`", exit 1). Tars put that on every worker's
 *    line for telegram, which it stopped writing in 2.0.5: the worker died at launch and its task was typed into the
 *    bare shell.
 * 2. Its TUI hands its turns to a shared background server under CODEX_HOME that outlives the terminal: a stop killed
 *    the terminal and the turn went on, shell calls included, and two codex processes stayed up.
 *
 * A real codex binary (TARS_HARNESS_CODEX: opt-in, skipped without one) runs in a worker's terminal. Its config.toml
 * points it at the stand-in Responses endpoint below (loopback, no key, no network, no account), which asks for one
 * shell call that sleeps 20 s and then prints a marker, and answers once that call's output comes back. The spec reads:
 * 1. codex starts: the endpoint gets the task from it, with codex's shell tool;
 * 2. Tars stops the agent 3 s into that call: no request carrying a tool's output reaches the endpoint after the stop,
 *    and no process runs from the sandbox home 10 s after it;
 * 3. once Tars has quit, still none.
 * The artefact: values.json (the requests in short, the screen, what ran from the home), endpoint-requests.jsonl, the
 * app's log, reproduce.txt.
 */

const WORKER = 'eeee5555-0000-4000-8000-0000000000d7';
const MODEL = 'stand-in-coder';
const TASK = 'Run the shell command that prints the probe marker, then tell me what it printed.';
const SHELL = /^(exec_command|shell|local_shell|shell_command)$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Logged = { at: number; method?: string; url?: string; body?: Record<string, unknown> };

/** The processes whose command line names `home`, as `pid command`. */
const runningFrom = (home: string) => (process.platform === 'win32' ? [] : execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  .split('\n').map(l => l.trim()).filter(l => l.includes(home))
  .map(l => ({ pid: Number(l.split(/\s+/)[0]), command: l.replace(/^\d+\s+/, '').slice(0, 300) })));

/**
 * A Responses endpoint: to the request whose last input item carries the task (not codex's other requests, a title's
 * among them), a call to the shell tool codex offers, built from that tool's schema; to any other, a short text.
 * Streamed as codex reads it. Every request is logged, one JSON line each.
 */
function startStandIn(log: string, marker: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not JSON */ }
      fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), method: req.method, url: req.url, body })}\n`);
      const url = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stand-in' }] }));
        return;
      }
      if (req.method !== 'POST' || !url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      const input = Array.isArray(body.input) ? body.input : [];
      const tools = (Array.isArray(body.tools) ? body.tools : []) as Array<{ name?: string; parameters?: { properties?: Record<string, { type?: string }> } }>;
      const shell = tools.find(t => SHELL.test(String(t.name ?? '')));
      const line = `sleep 20; echo ${marker}`;
      const props = shell?.parameters?.properties ?? {};
      const args = props.cmd ? { cmd: line } : props.command?.type === 'array' ? { command: ['sh', '-c', line] } : { command: line };
      const asks = !!shell && JSON.stringify(input[input.length - 1] ?? '').includes(TASK);
      const id = `resp_${randomBytes(6).toString('hex')}`;
      const item = asks
        ? { type: 'function_call', id: `fc_${randomBytes(6).toString('hex')}`, call_id: `call_${randomBytes(6).toString('hex')}`, name: shell!.name, arguments: JSON.stringify(args), status: 'completed' }
        : { type: 'message', id: `msg_${randomBytes(6).toString('hex')}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Stand-in answer', annotations: [] }] };
      const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: MODEL, status: 'completed', output: [item], usage };
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      send('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
      send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
      if (asks) send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: (item as { arguments: string }).arguments });
      else send('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'Stand-in answer' });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
      send('response.completed', { type: 'response.completed', response });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise(r => server.close(() => r())) });
  }));
}

test('codex 0.170 starts in a worker\'s terminal, and its turn ends when Tars stops the agent', async () => {
  const bin = process.env.TARS_HARNESS_CODEX ?? '';
  test.skip(!bin || !fs.existsSync(bin), 'TARS_HARNESS_CODEX names no codex binary: skipped');
  test.setTimeout(6 * 60_000);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-codex-stop-'));
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  const codexHome = path.join(home, '.codex');
  for (const d of [project, dir, codexHome]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const log = test.info().outputPath('endpoint-requests.jsonl');
  const marker = `TARS-PROBE-${randomBytes(4).toString('hex')}`;
  const standin = await startStandIn(log, marker);
  fs.writeFileSync(test.info().outputPath('reproduce.txt'),
    `npx tsc -p electron/tsconfig.json\nTARS_HARNESS_CODEX=${bin} npx playwright test e2e/codex-turn-ends-with-its-terminal.spec.ts\n`);
  // codex's own config, as a user's holds one: a model provider, and no server named telegram (Tars wrote none since
  // 2.0.5). The folder's trust is Tars's to write, at the launch.
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    `model = "${MODEL}"`, 'model_provider = "standin"', '',
    '[model_providers.standin]', 'name = "Stand-in"', `base_url = "${standin.baseUrl}"`, 'wire_api = "responses"', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: WORKER, name: 'Cody', character: 'robot', status: 'idle', provider: 'codex', role: 'worker', permissionMode: 'bypass',
    projectPath: project, skills: [], cliPath: bin, createdAt: '2026-11-20T08:00:00.000Z', lastActivity: '2026-11-20T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex: bin, additionalPaths: [path.dirname(bin)] },
  }, null, 2));

  const values: Record<string, unknown> = { bin, version: (() => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); } catch { return null; } })() };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Logged[];
  const posts = () => requests().filter(r => r.method === 'POST');
  const carriesOutput = (r: Logged) => JSON.stringify(r.body?.input ?? '').includes('function_call_output');
  const short = () => posts().map(r => ({ at: r.at, url: r.url, carriesTask: JSON.stringify(r.body?.input ?? '').includes(TASK), carriesOutput: carriesOutput(r) }));

  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31960), DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    const agent = () => api<{ cliRunning?: boolean; output?: string[]; status?: string } | null>('agent', 'get', WORKER);
    const screen = async () => plain(((await agent())?.output ?? []).join(''));

    // 1. codex starts, and the task reaches the endpoint from it.
    await api('agent', 'start', { id: WORKER, prompt: TASK });
    try {
      await expect.poll(() => posts().some(r => JSON.stringify(r.body?.input ?? '').includes(TASK) && /exec_command|shell/.test(JSON.stringify(r.body?.tools ?? ''))),
        { timeout: 90_000, message: 'the task reached the endpoint from codex' }).toBe(true);
    } finally {
      keep({ requestsAtStart: short(), screenAtStart: (await screen()).slice(-6000) });
    }

    // 2. Stopped 3 s into its 20 s shell call: its turn ends with its terminal.
    await sleep(3000);
    const stoppedAt = Date.now();
    await api('agent', 'stop', WORKER);
    await expect.poll(async () => !!(await agent())?.cliRunning, { timeout: 30_000 }).toBe(false);
    await sleep(25_000);
    const afterStop = posts().filter(r => r.at > stoppedAt && carriesOutput(r));
    // Tars itself still runs here, its Electron with the sandbox home in its arguments: everything else counts.
    const leftAfterStop = runningFrom(home).filter(p => !p.command.includes(`${path.sep}node_modules${path.sep}electron${path.sep}dist${path.sep}`));
    keep({ stoppedAt, requestsAfterStop: short().filter(r => r.at > stoppedAt), leftAfterStop, screenAfterStop: (await screen()).slice(-6000) });
    expect.soft(afterStop, 'a tool\'s output reached the endpoint after the agent was stopped: its turn went on').toEqual([]);
    expect.soft(leftAfterStop, 'what still ran from the sandbox home 25 s after the stop').toEqual([]);
  } finally {
    await app?.close();
    // 3. And once Tars has quit. What is found is stopped by its pid once noted, so a red run leaves nothing behind.
    let left = runningFrom(home);
    for (let i = 0; i < 20 && left.length; i++) { await sleep(500); left = runningFrom(home); }
    keep({ leftAfterQuit: left });
    for (const p of left) { try { process.kill(p.pid); } catch { /* gone */ } }
    expect.soft(left, 'what still ran from the sandbox home once Tars had quit').toEqual([]);
    await standin.close();
    await removeHome(home);
  }
});
