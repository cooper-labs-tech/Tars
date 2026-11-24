import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { startGeminiStandIn, GEMINI_MODEL_ID } from './stand-in-gemini-endpoint.mjs';
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
 * Every harness's home is the sandbox's (CODEX_HOME, KIMI_CODE_HOME, PI_CODING_AGENT_DIR handed to Tars here): one
 * exported by the shell that runs the spec was inherited, and the sandboxed Tars wrote that home and its harness ran on
 * that login (the Audit's L2 on #608). The files Tars writes in such a home are checked to be left as they were.
 *
 * gemini and grok take no endpoint of Tars's: each runs on its own model setting, as a user sets it, in the sandbox
 * (measured on 23/11, gemini 0.70.0 and grok 1.0.92). gemini on a stand-in of Gemini's API
 * (e2e/stand-in-gemini-endpoint.mjs) through GOOGLE_GEMINI_BASE_URL, its key set from the window (cliKeys, under
 * GEMINI_API_KEY) and its auth type gemini-api-key in its settings, as `/auth` leaves it; grok on the OpenAI stand-in as
 * a custom model of its config.toml. Their tool round is a call to Tars's own MCP: whoami, directly for gemini
 * (mcp_<server>_whoami), through grok's tool search for grok (search_tool, then use_tool), and the final answer is
 * `PROBE-OK <marker>` only when its result names the agent from Tars's API, `(agent id: <id>), worker of project`: the
 * call reached Tars with the agent's own identity. On top of the steps above, each:
 * 6. opens on no question of its own: no folder trust, no sign-in (gemini's --skip-trust, grok's --trust);
 * 7. ends its turn as Tars sees it: the agent back at rest once the task is answered (its hooks);
 * 8. grok only: its Claude compatibility off (GROK_CLAUDE_HOOKS_ENABLED=0), so the claude hooks of ~/.claude/settings.json
 *    never run in its terminal: a hook of the user's own there (SessionStart, writing a file) has not run once the agent
 *    has started and answered; and Tars's hooks fire once, one SessionStart of the agent's in Tars's hook log per start.
 *    Measured on 1.0.92 (24/11): grok runs a command named in both ~/.grok/hooks and ~/.claude/settings.json once and
 *    two different ones twice, so Tars's own hooks, the same scripts in both files, cannot double; the user's can run.
 * Every binary run is isolated, its --version included: the sandbox's HOME, TMPDIR and XDG folders, npm's prefix and cache
 * in sinks of the sandbox, and an `open`/`xdg-open` first on its PATH that records and opens nothing (asserted unused).
 *
 * Opt-in, as the live CLI matrix is: TARS_HARNESS_<ID>=<binary> names the binary of each harness to run
 * (TARS_HARNESS_KIMI_CODE, TARS_HARNESS_CODEX, TARS_HARNESS_PI, TARS_HARNESS_GEMINI, TARS_HARNESS_GROK); a harness
 * with none is skipped, and says so.
 * The artefact, per harness: values.json (each step's answer, the endpoint's requests in short, the harness's screen at
 * its start and after each task), endpoint-requests.jsonl, the app's logs, the agent's whole
 * screen of each run of Tars (screen-<run>.txt: why a harness that exits at once exited), reproduce.txt.
 */

/** `via`: Tars's endpoint (the default), Gemini's API through its stand-in, or the harness's own custom model. */
type Harness = { id: string; provider: string; pathKey: string; env: string; via?: 'endpoint' | 'gemini-api' | 'own-model'; enabled?: string; hooksOnce?: boolean };
const HARNESSES: Harness[] = [
  { id: 'kimi-code', provider: 'kimi-code', pathKey: 'kimi', env: 'TARS_HARNESS_KIMI_CODE' },
  { id: 'codex', provider: 'codex', pathKey: 'codex', env: 'TARS_HARNESS_CODEX' },
  { id: 'pi', provider: 'pi', pathKey: 'pi', env: 'TARS_HARNESS_PI' },
  { id: 'gemini', provider: 'gemini', pathKey: 'gemini', env: 'TARS_HARNESS_GEMINI', via: 'gemini-api', enabled: 'geminiEnabled' },
  { id: 'grok', provider: 'grok', pathKey: 'grok', env: 'TARS_HARNESS_GROK', via: 'own-model', enabled: 'grokEnabled', hooksOnce: true },
];

const LEAD = 'dddd4444-0000-4000-8000-0000000000c1';
const WORKER = 'eeee5555-0000-4000-8000-0000000000c2';
const EP = 'ep-0c0f01';
const TASK = 'Run the shell command that prints the probe marker, then tell me what it printed.';
/** What only Tars's API puts in whoami's answer for the worker: its id with its role. */
const IDENTITY = `(agent id: ${WORKER}), worker of project`;
/** The environment of a binary run outside Tars (its --version): the sandbox's home and folders, npm in sinks. */
const isolatedEnv = (home: string, shim: string): NodeJS.ProcessEnv => ({
  PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, TMPDIR: path.join(home, 'tmp'), LANG: 'en_US.UTF-8',
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
  XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
  npm_config_prefix: path.join(home, 'npm-sink'), npm_config_cache: path.join(home, 'npm-cache'),
});
/** An `open` and an `xdg-open` that record what they were asked and open nothing. */
function writeOpenShim(home: string): { dir: string; log: string } {
  const dir = path.join(home, 'shim');
  const log = path.join(home, 'opened.log');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
  return { dir, log };
}
/** A terminal's text, its escapes taken out: what the artefact keeps of the harness's screen. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The files Tars writes in a harness's home, for each home the runner may have exported: never Tars's to write here. */
const RUNNER_HOME_FILES: Array<[string, string[]]> = [['CODEX_HOME', ['config.toml']], ['KIMI_CODE_HOME', ['mcp.json']], ['PI_CODING_AGENT_DIR', ['mcp.json', 'trust.json']]];
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
    const via = h.via ?? 'endpoint';
    const standin = via === 'gemini-api'
      ? await startGeminiStandIn({ key, log: standinLog, expect: IDENTITY })
      : await startStandIn({ key, log: standinLog, ...(via === 'own-model' ? { mcp: { tool: /whoami/i, expect: IDENTITY } } : {}) });
    fs.writeFileSync(test.info().outputPath('reproduce.txt'),
      `${h.env}=${bin} npx playwright test e2e/harness-conformance.spec.ts -g '${h.id}'\n`);
    const shim = writeOpenShim(home);
    for (const d of ['tmp', '.config', path.join('.local', 'share'), path.join('.local', 'state'), '.cache', 'npm-sink', 'npm-cache']) fs.mkdirSync(path.join(home, d), { recursive: true });
    // The harness's own model setting, as its user leaves it: gemini signed in with an API key (`/auth`), grok with a
    // custom model of its config.toml. Nothing of Tars's: Tars adds its own beside it.
    if (via === 'gemini-api') {
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' } },
        general: { disableAutoUpdate: true, disableUpdateNag: true, enableAutoUpdate: false },
        privacy: { usageStatisticsEnabled: false },
      }, null, 2));
    }
    if (via === 'own-model') {
      fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
      fs.writeFileSync(path.join(home, '.grok', 'config.toml'), [
        // `cli.auto_update`, the key grok 1.0.92 reads (`grok inspect` calls a top-level `auto_update` unrecognized).
        '[cli]', 'auto_update = false', '', '[models]', 'default = "standin"', '', '[model.standin]', `model = "${MODEL_ID}"`,
        `base_url = "${standin.baseUrl}"`, 'name = "Stand-in"', `api_key = "${key}"`, '', '[features]', 'telemetry = false', '',
      ].join('\n'));
      // A claude hook of the user's own, which Tars keeps beside its own in ~/.claude/settings.json: grok's Claude
      // compatibility would run it in the agent's terminal (check 8).
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `printf 'ran\\n' >> '${path.join(home, 'user-claude-hook.log')}'` }] }] },
      }, null, 2));
    }
    const userClaudeHookRan = () => fs.existsSync(path.join(home, 'user-claude-hook.log'));

    const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
      createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
      agent(WORKER, 'Worker', {
        provider: h.provider, role: 'worker', cliPath: bin,
        ...(via === 'endpoint' ? { model: MODEL_ID, endpointId: EP, traces: false } : via === 'gemini-api' ? { model: GEMINI_MODEL_ID } : {}),
      }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
      cliPaths: { [h.pathKey]: bin, additionalPaths: [shim.dir, path.dirname(bin)] },
      ...(h.enabled ? { [h.enabled]: true } : {}),
      ...(via === 'endpoint' ? { inferenceEndpoints: [{ id: EP, name: 'Stand-in host', baseUrl: standin.baseUrl, allowTraces: false, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }] } : {}),
    }, null, 2));
    const drop = path.join(dir, 'endpoint-keys');
    fs.mkdirSync(drop, { recursive: true });

    const port = apiPort(31950);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { harness: h.id, bin, version: (() => { try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000, cwd: home, env: isolatedEnv(home, shim.dir) }).trim(); } catch { return null; } })() };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const requests = () => (fs.existsSync(standinLog) ? fs.readFileSync(standinLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ url?: string; method?: string; body?: unknown }>;
    const posts = () => requests().filter(r => r.method === 'POST');
    const short = () => posts().map(r => ({ url: r.url, carriesMarker: JSON.stringify(r.body ?? '').includes(standin.marker) }));
    // The SessionStarts of the worker's in Tars's hook log (hooks/session-start.sh writes one line per run of it).
    const hookLog = path.join(dir, 'logs', 'hooks.log');
    const sessionStarts = () => (fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8') : '').split('\n').filter((l) => l.includes(`SESSION_START hook. AGENT_ID=${WORKER}`)).length;

    // One run of Tars, with Lead's MCP: `run` gets Lead's tool caller and the window's API.
    const withTars = async (label: string, run: (lead: (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>, api: <T>(g: string, n: string, ...a: unknown[]) => Promise<T>) => Promise<void>) => {
      let app: ElectronApplication | undefined;
      let mcp: ChildProcessWithoutNullStreams | undefined;
      let keepScreen: (() => Promise<void>) | undefined;
      try {
        app = await launchSandboxed(electron, home, { env: {
          NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
          CODEX_HOME: path.join(home, '.codex'), KIMI_CODE_HOME: path.join(home, '.kimi-code'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
          // The rest of a harness's folders in the sandbox too, whatever the runner exports, and npm in sinks.
          XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
          XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
          npm_config_prefix: path.join(home, 'npm-sink'), npm_config_cache: path.join(home, 'npm-cache'),
          ...(via === 'gemini-api' ? { GOOGLE_GEMINI_BASE_URL: standin.baseUrl } : {}),
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
        if (via !== 'endpoint') {
          // Tars's MCP servers registered in the harness's own configuration before its CLI starts, as a packaged Tars
          // does at every start (setupMcpOrchestrator), and as the CLI matrix does: a development run finds no bundle
          // under process.resourcesPath, the app's own, and registered none (the first run of 24/11: grok's tool search
          // found "No MCP tools are available in this session").
          const resources = path.join(home, 'resources');
          fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
          fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
          fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
          await app.evaluate(async (_e, { resources, dist }) => {
            const was = process.resourcesPath;
            Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
            try {
              await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
            } finally {
              Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
            }
          }, { resources, dist });
        }
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

    const runnerBefore = runnerHomeFiles();
    try {
      await withTars('first', async (lead, api) => {
        if (via === 'endpoint') {
          fs.writeFileSync(path.join(drop, 'stand-in.key'), `${key}\n`);
          const setKey = await lead('endpoint_set_key', { id: EP, key_file: 'stand-in.key' });
          keep({ setKey });
          expect(setKey.isError, `endpoint_set_key: ${setKey.text}`).toBe(false);
        } else if (via === 'gemini-api') {
          // Its key from the window, as a user sets it (Settings, under GEMINI_API_KEY): never on a line or in a file it reads.
          const setKey = await api<{ success: boolean; error?: string }>('cliKeys', 'set', 'gemini', { key });
          keep({ setKey });
          expect(setKey.success, `cliKeys.set gemini: ${setKey.error}`).toBe(true);
        }

        // 1. It starts.
        await api('agent', 'start', { id: WORKER, prompt: '' });
        await expect.poll(async () => !!(await api<{ cliRunning?: boolean } | null>('agent', 'get', WORKER))?.cliRunning, { timeout: 60_000, message: 'its CLI runs in the agent\'s terminal' }).toBe(true);

        const screenOf = async () => plain(((await api<{ output?: string[] } | null>('agent', 'get', WORKER))?.output ?? []).join('')).slice(-4000);
        if (via !== 'endpoint') await sleep(8000); // its screen drawn, a question of its own included, before it is read
        keep({ screenAtStart: await screenOf() });
        // 6. No question of its own on its screen: a task typed into one is lost to it.
        if (via !== 'endpoint') expect.soft(await screenOf(), 'it opens on no question of its own (folder trust, sign-in)').not.toMatch(/Do you trust|trust the contents|How would you like to authenticate|Select Auth/i);
        // 2. Delegated to, answered with its own final answer, after a real tool round.
        const delegated = await lead('delegate_task', { id: WORKER, prompt: TASK, timeoutSeconds: 200, clientRequestId: `e2e-conformance-${h.id}-1` });
        // The ledger's task, as delegate_task names it at the end of its answer (`task <id>`): a UUID once its turn ran,
        // the request's `t-xxxxxxxx` while it waits.
        const taskId = /\btask ((?:t-[0-9a-f]{8})|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(delegated.text)?.[1];
        // What Tars knows of the agent and its tasks at that moment, for a run that goes wrong.
        const view = (a: Record<string, unknown> | null) => a && Object.fromEntries(['status', 'currentSessionId', 'resumableSessionId', 'lastTurnStartedAt', 'sessionRegisteredAt', 'requestedBy', 'taskQueue', 'currentTask'].map((k) => [k, a[k]]));
        const ledger = async () => ((await api<{ tasks?: Array<Record<string, unknown>> }>('usage', 'tasks', { sinceDays: 1 }))?.tasks ?? []).filter((t) => t.agentId === WORKER);
        keep({ delegated, taskId, requests: short(), screenAfterTask: await screenOf(), workerAfterTask: view(await api('agent', 'get', WORKER)), ledgerAfterTask: await ledger() });
        expect.soft(delegated.text, 'delegate_task returns the harness\'s final answer').toContain(`PROBE-OK ${standin.marker}`);
        // The shell round's proof: the marker came back in a tool result. The MCP round's is whoami's answer, below: the
        // marker never travels there (the first gemini run of 24/11 failed this line with its answer right).
        if (via === 'endpoint') expect.soft(posts().some((r, i) => i > 0 && JSON.stringify(r.body ?? '').includes(standin.marker)), 'the tool\'s result reached the endpoint').toBe(true);

        // 3 and 4. The ledger and the agent's output, by the task's id.
        expect(taskId, 'delegate_task names its task').toBeTruthy();
        const status = await lead('task_status', { taskId });
        const output = await lead('get_agent_output', { id: WORKER, taskId });
        keep({ status, output });
        expect.soft(status.text, 'task_status: completed').toMatch(/completed/i);
        expect.soft(status.text, 'task_status: the answer').toContain(`PROBE-OK ${standin.marker}`);
        expect.soft(output.text, 'get_agent_output: the answer').toContain(`PROBE-OK ${standin.marker}`);
        if (via !== 'endpoint') {
          // The reply through Tars's MCP, with the agent's own identity: whoami's result, as the endpoint received it.
          expect.soft(posts().some((r) => JSON.stringify(r.body ?? '').includes(IDENTITY)), 'whoami answered for the worker, from Tars').toBe(true);
          // 7. The turn's end, as Tars sees it: the agent back at rest.
          let rest: unknown;
          for (let i = 0; i < 60; i++) {
            rest = (await api<{ status?: string } | null>('agent', 'get', WORKER))?.status;
            if (rest !== 'running') break;
            await sleep(500);
          }
          keep({ statusAfterTask: rest });
          expect.soft(rest, 'the agent at rest once its task is answered').toBe('idle');
        }
        if (h.hooksOnce) keep({ sessionStartsFirst: sessionStarts() });
        if (h.hooksOnce) expect.soft(sessionStarts(), '8. one SessionStart of the agent\'s for its one start: each hook fired once').toBe(1);
        if (h.hooksOnce) keep({ userClaudeHookRan: userClaudeHookRan() });
        if (h.hooksOnce) expect.soft(userClaudeHookRan(), '8. the user\'s own claude hook never ran in the agent\'s grok session').toBe(false);
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
        // gemini and grok put a side question of their own (a title, who speaks next) around a turn: the first request
        // of the resumed turn is the one carrying tools.
        const firstOfTurn = via === 'endpoint' ? after[0] : after.find((r) => JSON.stringify(r.body ?? '').includes('"tools"')) ?? after[0];
        expect.soft(JSON.stringify(firstOfTurn?.body ?? ''), 'its first request carries the first task\'s history').toContain(standin.marker);
        expect.soft(again.text, 'the second delegation is answered').toContain('PROBE-OK');
        if (h.hooksOnce) keep({ sessionStartsSecond: sessionStarts() });
        if (h.hooksOnce) expect.soft(sessionStarts(), '8. one more SessionStart for the second start, not two').toBe(2);
      });
    } finally {
      // The homes the runner exported were left as they were.
      const runnerAfter = runnerHomeFiles();
      keep({ runnerHomes: Object.keys(runnerBefore), runnerHomesChanged: Object.keys(runnerBefore).filter((f) => runnerAfter[f] !== runnerBefore[f]) });
      for (const file of Object.keys(runnerBefore)) expect.soft(runnerAfter[file], `${file}, in a home the runner exported, left as it was`).toBe(runnerBefore[file]);
      const opened = fs.existsSync(shim.log) ? fs.readFileSync(shim.log, 'utf8').trim() : '';
      keep({ opened });
      expect.soft(opened, 'nothing asked to open a browser or a file').toBe('');
      await standin.close();
      await removeHome(home);
    }
  });
}
