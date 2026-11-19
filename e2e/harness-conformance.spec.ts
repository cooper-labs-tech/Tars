import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Harness conformance: one run per harness, the same steps for each, so a harness ships only once delegate_task,
 * task_status and get_agent_output behave on it as on every other (19/11, more harnesses).
 *
 * A real harness binary runs its TUI in an agent's terminal, on an OpenAI-compatible endpoint through Tars: the
 * stand-in of e2e/stand-in-openai-endpoint.mjs on loopback, a dummy key, no network, no token spent. On a request
 * with no tool result yet it asks the harness's own shell tool to print a marker; on the request carrying the result
 * it answers `PROBE-OK <marker>`. Lead, the project's orchestrator, works the agent through the real mcp-orchestrator
 * with its own identity. Each harness passes the same steps:
 * 1. starts: its CLI runs in the agent's terminal;
 * 2. delegate_task returns the harness's own final answer, `PROBE-OK <marker>`, and the endpoint saw the tool's
 *    result carry the marker: a real tool round on the wire;
 * 3. task_status reads that task completed, with the same answer;
 * 4. get_agent_output with that taskId gives the same answer;
 * 5. resume: Tars quits and starts again, the agent's first start continues its session (the endpoint's first new
 *    request already carries the marker of step 2 in its history), and a second delegation is answered.
 *
 * Opt-in, as the live CLI matrix is: TARS_HARNESS_<ID>=<binary> names the binary of each harness to run
 * (TARS_HARNESS_KIMI_CODE, TARS_HARNESS_CODEX, TARS_HARNESS_PI); a harness with none is skipped, and says so.
 * The artefact, per harness: values.json (each step's answer, the endpoint's requests in short, the harness's screen at
 * its start and after each task), endpoint-requests.jsonl, the app's logs, reproduce.txt.
 */

type Harness = { id: string; provider: string; pathKey: string; env: string };
const HARNESSES: Harness[] = [
  { id: 'kimi-code', provider: 'kimi-code', pathKey: 'kimi', env: 'TARS_HARNESS_KIMI_CODE' },
  { id: 'codex', provider: 'codex', pathKey: 'codex', env: 'TARS_HARNESS_CODEX' },
  { id: 'pi', provider: 'pi', pathKey: 'pi', env: 'TARS_HARNESS_PI' },
];

const LEAD = 'dddd4444-0000-4000-8000-0000000000c1';
const WORKER = 'eeee5555-0000-4000-8000-0000000000c2';
const EP = 'ep-0c0f01';
const TASK = 'Run the shell command that prints the probe marker, then tell me what it printed.';
/** A terminal's text, its escapes taken out: what the artefact keeps of the harness's screen. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

for (const h of HARNESSES) {
  test(`harness conformance: ${h.id} is delegated to, answers, is read back and resumes as every harness`, async () => {
    const bin = process.env[h.env] ?? '';
    test.skip(!bin || !fs.existsSync(bin), `${h.env} names no binary of ${h.id}: skipped`);
    test.setTimeout(10 * 60_000);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-conformance-${h.id}-`));
    const project = path.join(home, 'projects', 'project-a');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    const standinLog = test.info().outputPath('endpoint-requests.jsonl');
    const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
    const standin = await startStandIn({ key, log: standinLog });
    fs.writeFileSync(test.info().outputPath('reproduce.txt'),
      `${h.env}=${bin} npx playwright test e2e/harness-conformance.spec.ts -g '${h.id}'\n`);

    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
      createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
      agent(WORKER, 'Worker', { provider: h.provider, role: 'worker', model: MODEL_ID, endpointId: EP, traces: false, cliPath: bin }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
      cliPaths: { [h.pathKey]: bin, additionalPaths: [path.dirname(bin)] },
      inferenceEndpoints: [{ id: EP, name: 'Stand-in host', baseUrl: standin.baseUrl, allowTraces: false, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    }, null, 2));
    const drop = path.join(dir, 'endpoint-keys');
    fs.mkdirSync(drop, { recursive: true });

    const port = apiPort(31950);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { harness: h.id, bin, version: (() => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); } catch { return null; } })() };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const requests = () => (fs.existsSync(standinLog) ? fs.readFileSync(standinLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ url?: string; method?: string; body?: unknown }>;
    const posts = () => requests().filter(r => r.method === 'POST');
    const short = () => posts().map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) }));

    // One run of Tars, with Lead's MCP: `run` gets Lead's tool caller and the window's API.
    const withTars = async (label: string, run: (lead: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>, api: <T>(g: string, n: string, ...a: unknown[]) => Promise<T>) => Promise<void>) => {
      let app: ElectronApplication | undefined;
      let mcp: ChildProcessWithoutNullStreams | undefined;
      try {
        app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
        const appLog = test.info().outputPath(`app-${label}.log`);
        app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
        app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
        const page: Page = await app.firstWindow();
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
        const api = <T>(group: string, name: string, ...args: unknown[]) =>
          page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
        const identity = await app.evaluate((_e, { dist, lead }) => {
          const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
          return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string };
        }, { dist, lead: LEAD });
        mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
          env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance },
        });
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
        const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const lead = async (tool: string, args: Record<string, unknown>) => {
          const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(240_000).then(() => ({ error: `${tool} gave no answer in 240 s` }) as Reply)]);
          return { text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
        };
        await run(lead, api);
      } finally {
        mcp?.kill();
        await app?.close();
      }
    };

    try {
      await withTars('first', async (lead, api) => {
        fs.writeFileSync(path.join(drop, 'stand-in.key'), `${key}\n`);
        const setKey = await lead('endpoint_set_key', { id: EP, key_file: 'stand-in.key' });
        keep({ setKey });
        expect(setKey.isError, `endpoint_set_key: ${setKey.text}`).toBe(false);

        // 1. It starts.
        await api('agent', 'start', { id: WORKER, prompt: '' });
        await expect.poll(async () => !!(await api<{ cliRunning?: boolean } | null>('agent', 'get', WORKER))?.cliRunning, { timeout: 60_000, message: 'its CLI runs in the agent\'s terminal' }).toBe(true);

        const screenOf = async () => plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')).slice(-4000);
        keep({ screenAtStart: await screenOf() });
        // 2. Delegated to, answered with its own final answer, after a real tool round.
        const delegated = await lead('delegate_task', { id: WORKER, prompt: TASK, timeoutSeconds: 200, clientRequestId: `e2e-conformance-${h.id}-1` });
        const taskId = /\bt-[0-9a-f]{8}\b/.exec(delegated.text)?.[0];
        // What Tars knows of the agent and its tasks at that moment, for a run that goes wrong.
        const view = (a: Record<string, unknown> | null) => a && Object.fromEntries(['status', 'currentSessionId', 'resumableSessionId', 'lastTurnStartedAt', 'sessionRegisteredAt', 'requestedBy', 'taskQueue', 'currentTask'].map((k) => [k, a[k]]));
        const ledger = async () => ((await api<{ tasks?: Array<Record<string, unknown>> }>('usage', 'tasks', { sinceDays: 1 }))?.tasks ?? []).filter((t) => t.agentId === WORKER);
        keep({ delegated, taskId, requests: short(), screenAfterTask: await screenOf(), workerAfterTask: view(await api('agent', 'get', WORKER)), ledgerAfterTask: await ledger() });
        expect.soft(delegated.text, 'delegate_task returns the harness\'s final answer').toContain(`PROBE-OK ${standin.marker}`);
        expect.soft(posts().some((r, i) => i > 0 && JSON.stringify(r.body ?? '').includes(standin.marker)), 'the tool\'s result reached the endpoint').toBe(true);

        // 3 and 4. The ledger and the agent's output, by the task's id.
        expect(taskId, 'delegate_task names its task').toBeTruthy();
        const status = await lead('task_status', { taskId });
        const output = await lead('get_agent_output', { id: WORKER, taskId });
        keep({ status, output });
        expect.soft(status.text, 'task_status: completed').toMatch(/completed/i);
        expect.soft(status.text, 'task_status: the answer').toContain(`PROBE-OK ${standin.marker}`);
        expect.soft(output.text, 'get_agent_output: the answer').toContain(`PROBE-OK ${standin.marker}`);
      });

      // 5. Tars quits and starts again; the agent's first start continues its session.
      const before = posts().length;
      await withTars('second', async (lead, api) => {
        await api('agent', 'start', { id: WORKER, prompt: '' });
        await expect.poll(async () => !!(await api<{ cliRunning?: boolean } | null>('agent', 'get', WORKER))?.cliRunning, { timeout: 60_000 }).toBe(true);
        const again = await lead('delegate_task', { id: WORKER, prompt: TASK, timeoutSeconds: 200, clientRequestId: `e2e-conformance-${h.id}-2` });
        keep({ screenAfterResume: plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')).slice(-4000) });
        const after = posts().slice(before);
        keep({ again, resumedRequests: after.map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) })) });
        expect.soft(after.length, 'the resumed session reached the endpoint').toBeGreaterThan(0);
        expect.soft(JSON.stringify(after[0]?.body ?? ''), 'its first request carries the first task\'s history').toContain(standin.marker);
        expect.soft(again.text, 'the second delegation is answered').toContain('PROBE-OK');
      });
    } finally {
      await standin.close();
      await removeHome(home);
    }
  });
}
