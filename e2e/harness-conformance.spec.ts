import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { delegateOnceUp, versionEnv } from './conformance-helpers.mjs';
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
 * 6. restart: the window restarts the agent (what applying new settings does too), which forks its session: the CLI
 *    goes on under a new session with the earlier turns, and a third delegation is answered from it (the Audit's M1 on
 *    #613: opencode's reader bound the session the fork left, and the task waited out its timeout).
 * A delegation answered "still starting ... Send it again in a moment" (nothing typed, its TUI not drawn yet, past the
 * 20 s a sender waits) is sent again, as an orchestrator does, four times at most: Kilo 7.8.27 drew its bar 13 to 47 s
 * after it started on a loaded machine (20/11).
 * Every harness's home is the sandbox's (CODEX_HOME, KIMI_CODE_HOME, PI_CODING_AGENT_DIR handed to Tars here): one
 * exported by the shell that runs the spec was inherited, and the sandboxed Tars wrote that home and its harness ran on
 * that login (the Audit's L2 on #608). The files Tars writes in such a home are checked to be left as they were.
 *
 * Opt-in, as the live CLI matrix is: TARS_HARNESS_<ID>=<binary> names the binary of each harness to run
 * (TARS_HARNESS_KIMI_CODE, TARS_HARNESS_CODEX, TARS_HARNESS_PI, TARS_HARNESS_OPENCODE, TARS_HARNESS_KILO,
 * TARS_HARNESS_GOOSE); a harness with none is skipped, and says so. A harness whose tokens Tars reads (opencode, Kilo,
 * Goose) also has them in its task's ledger entry. Goose runs with every GOOSE_* of the runner's blanked (an empty one
 * reads as unset, measured: GOOSE_PATH_ROOT would move its folders out of the sandbox), its keyring and telemetry off.
 * The artefact, per harness: values.json (each step's answer, the endpoint's requests in short, the harness's screen at
 * its start and after each task), endpoint-requests.jsonl, the app's logs, the agent's whole
 * screen of each run of Tars (screen-<run>.txt: why a harness that exits at once exited), reproduce.txt.
 */

/** `tokens`: a harness whose tokens Tars reads (its task's ledger entry carries them). */
type Harness = { id: string; provider: string; pathKey: string; env: string; tokens?: boolean };
const HARNESSES: Harness[] = [
  { id: 'kimi-code', provider: 'kimi-code', pathKey: 'kimi', env: 'TARS_HARNESS_KIMI_CODE' },
  { id: 'codex', provider: 'codex', pathKey: 'codex', env: 'TARS_HARNESS_CODEX' },
  { id: 'pi', provider: 'pi', pathKey: 'pi', env: 'TARS_HARNESS_PI' },
  { id: 'opencode', provider: 'opencode', pathKey: 'opencode', env: 'TARS_HARNESS_OPENCODE', tokens: true },
  { id: 'kilo', provider: 'kilo', pathKey: 'kilo', env: 'TARS_HARNESS_KILO', tokens: true },
  { id: 'goose', provider: 'goose', pathKey: 'goose', env: 'TARS_HARNESS_GOOSE', tokens: true },
];

/** For Goose: the runner's own settings of it blanked, and no keychain nor telemetry from the sandbox. */
const gooseEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith('GOOSE_')).map((name) => [name, ''])),
  GOOSE_DISABLE_KEYRING: '1', GOOSE_TELEMETRY_ENABLED: 'false',
});

const LEAD = 'dddd4444-0000-4000-8000-0000000000c1';
const WORKER = 'eeee5555-0000-4000-8000-0000000000c2';
const EP = 'ep-0c0f01';
const TASK = 'Run the shell command that prints the probe marker, then tell me what it printed.';
/** A terminal's text, its escapes taken out: what the artefact keeps of the harness's screen. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The files Tars writes in a harness's home, for each home the runner may have exported: never Tars's to write here. */
const RUNNER_HOME_FILES: Array<[string, string[]]> = [['CODEX_HOME', ['config.toml']], ['KIMI_CODE_HOME', ['mcp.json']], ['PI_CODING_AGENT_DIR', ['mcp.json', 'trust.json']], ['XDG_CONFIG_HOME', [path.join('opencode', 'opencode.json'), path.join('kilo', 'kilo.json')]]];
const runnerHomeFiles = () => Object.fromEntries(RUNNER_HOME_FILES.flatMap(([name, files]) => {
  const dir = process.env[name]?.trim();
  return dir ? files.map((f) => [path.join(dir, f), fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null]) : [];
}));
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
    // The harnesses' homes, the sandbox's: given to the sandboxed Tars, and to the version read below, since a harness
    // may write its folders at any start (for a bare --version, measured 20/11: opencode 1.19.6 makes ~/.config/opencode,
    // ~/.local/share/opencode, ~/.local/state/opencode and ~/.cache/opencode, Kilo 7.8.27 the same four of its own).
    const harnessHomes = {
      CODEX_HOME: path.join(home, '.codex'), KIMI_CODE_HOME: path.join(home, '.kimi-code'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    };
    const version = (() => {
      try {
        fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
        return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000, cwd: project, env: versionEnv(process.env, { home, tmp: path.join(home, 'tmp'), harnessHomes }) }).trim();
      } catch { return null; }
    })();
    const values: Record<string, unknown> = { harness: h.id, bin, version };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const requests = () => (fs.existsSync(standinLog) ? fs.readFileSync(standinLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ url?: string; method?: string; body?: unknown }>;
    const posts = () => requests().filter(r => r.method === 'POST');
    const short = () => posts().map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) }));

    // One run of Tars, with Lead's MCP: `run` gets Lead's tool caller and the window's API.
    const withTars = async (label: string, run: (lead: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>, api: <T>(g: string, n: string, ...a: unknown[]) => Promise<T>) => Promise<void>) => {
      let app: ElectronApplication | undefined;
      let mcp: ChildProcessWithoutNullStreams | undefined;
      let keepScreen: (() => Promise<void>) | undefined;
      try {
        app = await launchSandboxed(electron, home, { env: {
          NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', ...harnessHomes,
          ...(h.id === 'goose' ? gooseEnv() : {}),
        } });
        const appLog = test.info().outputPath(`app-${label}.log`);
        app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
        app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
        const page: Page = await app.firstWindow();
        await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
        const api = <T>(group: string, name: string, ...args: unknown[]) =>
          page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
        keepScreen = async () => fs.writeFileSync(test.info().outputPath(`screen-${label}.txt`),
          plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')));
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
        await keepScreen?.().catch(() => undefined);
        mcp?.kill();
        await app?.close();
      }
    };

    // delegate_task, sent again while Tars answers that the CLI is still starting (conformance-helpers.mjs).
    type Lead = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
    const delegate = (lead: Lead, step: number) =>
      delegateOnceUp(lead, { id: WORKER, prompt: TASK, timeoutSeconds: 200, requestId: `e2e-conformance-${h.id}-${step}` });

    const runnerBefore = runnerHomeFiles();
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
        const delegated = await delegate(lead, 1);
        // The ledger's task, as delegate_task names it at the end of its answer (`task <id>`): a UUID once its turn ran,
        // the request's `t-xxxxxxxx` while it waits.
        const taskId = /\btask ((?:t-[0-9a-f]{8})|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(delegated.text)?.[1];
        // What Tars knows of the agent and its tasks at that moment, for a run that goes wrong.
        const view = (a: Record<string, unknown> | null) => a && Object.fromEntries(['status', 'currentSessionId', 'resumableSessionId', 'lastTurnStartedAt', 'sessionRegisteredAt', 'requestedBy', 'taskQueue', 'currentTask'].map((k) => [k, a[k]]));
        const ledger = async () => ((await api<{ tasks?: Array<Record<string, unknown>> }>('usage', 'tasks', { sinceDays: 1 }))?.tasks ?? []).filter((t) => t.agentId === WORKER);
        const ledgerAfterTask = await ledger();
        keep({ delegated, taskId, requests: short(), screenAfterTask: await screenOf(), workerAfterTask: view(await api('agent', 'get', WORKER)), ledgerAfterTask });
        // A harness whose tokens Tars reads: the task's ledger entry carries them (the stand-in answers 120 in, 100 cached).
        // Its usage is posted just after its turn's end: read until it is filed, or 15 s.
        if (h.tokens) {
          await expect.poll(async () => JSON.stringify(await ledger()), { timeout: 15_000, message: "the task's tokens, in its ledger entry" }).toMatch(/"input":\s*[1-9]/);
          keep({ ledgerWithTokens: await ledger() });
        }
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
        const again = await delegate(lead, 2);
        keep({ screenAfterResume: plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')).slice(-4000) });
        const after = posts().slice(before);
        keep({ again, resumedRequests: after.map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) })) });
        expect.soft(after.length, 'the resumed session reached the endpoint').toBeGreaterThan(0);
        expect.soft(JSON.stringify(after[0]?.body ?? ''), 'its first request carries the first task\'s history').toContain(standin.marker);
        expect.soft(again.text, 'the second delegation is answered').toContain('PROBE-OK');

        // 6. The window restarts the agent, which forks its session: answered from the fork, with the earlier history.
        const sessionBeforeRestart = (await api<{ currentSessionId?: string } | null>('agent', 'get', WORKER))?.currentSessionId;
        const beforeRestart = posts().length;
        await api('agent', 'restart', WORKER);
        await expect.poll(async () => !!(await api<{ cliRunning?: boolean } | null>('agent', 'get', WORKER))?.cliRunning, { timeout: 60_000 }).toBe(true);
        const restarted = await delegate(lead, 3);
        const sessionAfterRestart = (await api<{ currentSessionId?: string } | null>('agent', 'get', WORKER))?.currentSessionId;
        const afterRestart = posts().slice(beforeRestart);
        keep({
          restarted, sessionBeforeRestart, sessionAfterRestart,
          screenAfterRestart: plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')).slice(-4000),
          restartRequests: afterRestart.map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) })),
        });
        expect.soft(restarted.text, 'after a restart, the third delegation is answered').toContain('PROBE-OK');
        expect.soft(afterRestart.length, 'the restarted session reached the endpoint').toBeGreaterThan(0);
        expect.soft(JSON.stringify(afterRestart[0]?.body ?? ''), 'its first request carries the earlier history').toContain(standin.marker);
        expect.soft(sessionAfterRestart, 'the agent is on the fork, a session of its own').not.toBe(sessionBeforeRestart);
      });
    } finally {
      // The homes the runner exported were left as they were.
      const runnerAfter = runnerHomeFiles();
      keep({ runnerHomes: Object.keys(runnerBefore), runnerHomesChanged: Object.keys(runnerBefore).filter((f) => runnerAfter[f] !== runnerBefore[f]) });
      for (const file of Object.keys(runnerBefore)) expect.soft(runnerAfter[file], `${file}, in a home the runner exported, left as it was`).toBe(runnerBefore[file]);
      await standin.close();
      await removeHome(home);
    }
  });
}
