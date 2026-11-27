import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two Hermes agents on an inference endpoint, in Tars's own Hermes home, each in a profile of its own (the owner's
 * decision of 26/11 and the orchestrator's of 27/11). Hermes is the stand-in of e2e/fake-clis.mjs, faithful where Tars
 * depends on it (measured on Hermes Agent 0.23.4, 26 and 27/11): it takes its home from HERMES_HOME, else the user's
 * ~/.hermes; its sessions take the endpoint, the key and their MCP servers' ${VAR} from the profile's .env, never from
 * the terminal (one gateway per home serves every agent); it asks about telemetry unless its config answered; its
 * shell tool is `terminal`; it writes its turns into the profile's state.db; it refuses a --source it does not know.
 * The endpoint is e2e/stand-in-openai-endpoint.mjs on loopback. Lead, the project's orchestrator, works through the
 * real mcp-orchestrator with its own identity. Asserted:
 * 1. Each agent's Hermes runs in its own profile of ~/.tars/hermes, tagged `tool`; the user's ~/.hermes is never made.
 * 2. Its terminal holds no token: not Tars's, not the endpoint's, and no OPENAI_* variable.
 * 3. Its profile's .env is 0600 and names the three variables only; its config carries every guard (telemetry answered,
 *    no adopted login, no update check, no catalog fetch, no plugin check), so no question is left on its screen.
 * 4. Each agent's model calls carry its own proxy token (the one its .env holds), never the other's; the endpoint gets
 *    the real key on every request and never a terminal's token.
 * 5. Each agent's MCP server is that agent's: whoami answers each with its own id (another agent's token is refused).
 * 6. Each turn's end and answer are read from its profile's state.db: wait_for_agent returns the probe's answer.
 * 7. The approvals follow the mode: A (normal) manual and no --yolo; B (bypass) --yolo.
 * 8. A stopped agent's .env is gone, the other's is still there; at quit, none is left.
 * The artefact: values.json, the stand-in's request log, the stand-in Hermes's log, the app's log, a screenshot.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d8';
const A = 'ffff6666-0000-4000-8000-0000000000a1';
const B = 'ffff6666-0000-4000-8000-0000000000b2';
const EP = 'ep-0e2e02';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

/** The real binary for the opt-in run: its path (`~/.local/bin/hermes` where Hermes's installer puts it). */
const REAL = process.env.TARS_HARNESS_HERMES;

test('two Hermes agents run on an inference endpoint, each in its own profile, and never see each other\'s token', async () => {
  await hermesAgents(undefined);
});

/**
 * Opt in, on the real binary (`TARS_HARNESS_HERMES=<path>`): one agent, A. Its first start downloads Hermes's Python
 * packages into the sandbox's ~/.tars/hermes (about 135 MB from PyPI, several minutes), so the task waits for its
 * prompt. Asserted: the probe's answer read back from its state.db, its profile and 0600 .env, no ~/.hermes in the
 * sandbox, and the gateway its terminal started stopped at quit.
 */
test('a real Hermes runs a task on an inference endpoint in its own profile, and its gateway is stopped at quit', async () => {
  test.skip(!REAL, 'set TARS_HARNESS_HERMES to a hermes binary to run it (it downloads Hermes\'s packages)');
  await hermesAgents(REAL);
});

async function hermesAgents(real: string | undefined): Promise<void> {
  test.setTimeout(real ? 30 * 60_000 : 4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-hermes-agent-');
  const project = path.join(home, 'projects', 'project-h');
  const dir = path.join(home, '.tars');
  const priv = path.join(home, '.tars-private');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['hermes']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  // B works in a worktree of the project, A in the project itself: where each one's tools run is told apart. On the
  // real binary, the probe prints the folder and the variables its tool ran with.
  const bTree = path.join(project, '.worktrees', 'hermes-b');
  fs.mkdirSync(bTree, { recursive: true });
  const standin = await startStandIn({ key, log: standinLog, commandPrefix: real ? 'printf \'cwd=%s agent=%s tmp=%s\\n\' "$PWD" "$CLAUDE_AGENT_ID" "$TMPDIR"; ' : '' });
  // The real binary's one download goes through the proxy this names, when set (a logging proxy of the runner's).
  const proxy = real && process.env.TARS_HARNESS_HERMES_PROXY
    ? { HTTPS_PROXY: process.env.TARS_HARNESS_HERMES_PROXY, HTTP_PROXY: process.env.TARS_HARNESS_HERMES_PROXY, https_proxy: process.env.TARS_HARNESS_HERMES_PROXY, http_proxy: process.env.TARS_HARNESS_HERMES_PROXY, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
    : {};

  const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, character: 'robot', status: 'idle', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator', permissionMode: 'bypass' }),
    agent(A, 'Hermes A', { provider: 'hermes', model: MODEL_ID, endpointId: EP, permissionMode: 'normal', cliPath: real ?? fakes.hermes }),
    agent(B, 'Hermes B', { provider: 'hermes', model: MODEL_ID, endpointId: EP, permissionMode: 'bypass', worktreePath: bTree, cliPath: real ?? fakes.hermes }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: false, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30, sendSessionHeaders: !!real }],
  }, null, 2));
  // The endpoint's real key, where Tars keeps it: the settings' secrets, which no agent is handed.
  fs.writeFileSync(path.join(priv, 'settings-secrets.json'), JSON.stringify({ endpointKeys: { [EP]: key } }), { mode: 0o600 });

  const port = apiPort(31950);
  const dist = path.resolve('electron', 'dist');
  const hermesRoot = path.join(dir, 'hermes');
  const profile = (id: string) => path.join(hermesRoot, 'profiles', id);
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  const fakeEntries = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;
  const standinEntries = () => (fs.existsSync(standinLog) ? fs.readFileSync(standinLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown> & { headers?: Record<string, string> }>;
  const envOf = (id: string): Record<string, string> => {
    try { return Object.fromEntries(fs.readFileSync(path.join(profile(id), '.env'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch { return {}; }
  };
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', ...proxy } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    // Tars's MCP servers registered as a packaged Tars does at every start (setupMcpOrchestrator), for Hermes in its
    // own home's list: a development run finds no bundle under process.resourcesPath, the app's own
    // (e2e/opencode-pi-mcp.spec.ts does the same).
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
    const registered = JSON.parse(fs.readFileSync(path.join(hermesRoot, 'tars-mcp-servers.json'), 'utf8'));
    keep({ registered });
    expect(Object.keys(registered), "Tars's servers for Hermes").toContain('claude-mgr-orchestrator');
    const call = (group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args });

    // Lead, through the real mcp-orchestrator with its own token.
    const identity = await app.evaluate((_e, { dist, lead }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist, lead: LEAD });
    const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance },
    });
    servers.push(mcp);
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
    const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const calls: Array<{ tool: string; text: string; isError: boolean }> = [];
    const lead = async (tool: string, args: Record<string, unknown>) => {
      const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(120_000).then(() => ({ error: `${tool} gave no answer in 120 s` }) as Reply)]);
      const answer = { tool, text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      calls.push(answer);
      keep({ calls });
      return answer;
    };

    // A, then B while A's terminal is open: each started, each given the probe and WHOAMI.
    const env: Record<string, Record<string, string>> = {};
    const done: Record<string, { text: string; isError: boolean }> = {};
    for (const id of [A, B]) {
      await call('agent', 'start', { id, prompt: '' });
      if (real) {
        // The real one sets its home up first (its packages, once), then shows its prompt, `❯` (hermes_cli's prompt
        // symbol): read on its terminal's screen, as the window gets it. get_agent_output has nothing before a turn
        // ends (the first real run waited 20 minutes on it, 27/11).
        const screen = async () => ((await call('agent', 'get', id)) as { output?: string[] } | null)?.output?.join('') ?? '';
        await expect.poll(async () => (await screen()).includes('❯'), { timeout: 20 * 60_000, intervals: [5_000] }).toBe(true);
        fs.writeFileSync(test.info().outputPath(`screen-at-prompt-${id === A ? 'A' : 'B'}.txt`), await screen());
      } else {
        await expect.poll(() => fakeEntries().some(e => e.hermes && e.home === profile(id)), { timeout: 30_000 }).toBe(true);
      }
      env[id] = envOf(id);
      await lead('send_message', { id, message: `Run the probe and report what it printed.${real ? '' : ' WHOAMI'}` });
      done[id] = await lead('wait_for_agent', { id, timeoutSeconds: real ? 300 : 90 });
    }
    if (real) {
      // The real binary. Where each agent's tool ran, and with whose variables: the probe's line in each tool result
      // the endpoint got, by the agent the proxy named (X-Agent-Id). One gateway runs both, started by A's terminal.
      const probes = () => standinEntries().filter(e => e.method === 'POST' && e.headers?.['x-agent-id']).flatMap((e) => {
        const body = (typeof e.body === 'string' ? (() => { try { return JSON.parse(e.body as string); } catch { return {}; } })() : e.body) as { messages?: Array<{ role?: string; content?: unknown }> };
        return (body.messages ?? []).filter(m => m.role === 'tool').map((m) => {
          const line = /cwd=(\S*) agent=(\S*) tmp=(\S*)/.exec(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          return line ? { by: e.headers!['x-agent-id'], cwd: line[1], agentVar: line[2], tmp: line[3] } : null;
        }).filter(Boolean) as Array<{ by: string; cwd: string; agentVar: string; tmp: string }>;
      });
      const ran = probes();
      const of = (id: string) => ran.find(p => p.by === id);
      // Any process of the user, holding no token: `HERMES_HOME=<A's profile> hermes chat -q`, as anything could run it.
      const outsideLog = test.info().outputPath('outside-chat.txt');
      const outside = spawn(real, ['chat', '-q', 'Run the probe and report what it printed.', '--oneshot', '--format', 'stream-json', '--source', 'tool'], {
        cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home, HERMES_HOME: profile(A), ...proxy },
      });
      outside.stdout.on('data', (d) => fs.appendFileSync(outsideLog, d));
      outside.stderr.on('data', (d) => fs.appendFileSync(outsideLog, d));
      const outsideExit = await Promise.race([new Promise<number | null>(r => outside.on('exit', r)), sleep(300_000).then(() => 'timeout' as const)]);
      if (outsideExit === 'timeout') outside.kill();
      const fromOutside = probes().filter(p => p.cwd === home || p.cwd === fs.realpathSync(home));
      // The real binary: what it says and what it leaves, then its gateway at quit.
      const record = (() => { try { return JSON.parse(fs.readFileSync(path.join(hermesRoot, 'gateway.pid'), 'utf8')) as { pid?: number; hermes_home?: string }; } catch { return {}; } })();
      const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
      const gatewayBefore = alive(record.pid);
      // The gateway's own HERMES_HOME, which the stop now checks (the Audit's L1): read here as Tars reads it.
      const gatewayEnv = record.pid ? execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(record.pid)], { encoding: 'utf8' }) : '';
      const gatewayHome = [...gatewayEnv.matchAll(/ HERMES_HOME=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|\n|$)/g)].pop()?.[1] ?? null;
      keep({ probes: ran, outsideExit, fromOutside, gatewayHome, folders: { A: project, B: bTree } });
      expect.soft(of(A)?.cwd, "A's tool ran in A's folder").toBe(fs.realpathSync(project));
      expect.soft(of(B)?.cwd, "B's tool ran in B's folder").toBe(fs.realpathSync(bTree));
      expect.soft(of(B)?.agentVar, "B's tool had A's agent id").not.toBe(A);
      expect.soft(of(B)?.tmp && of(A)?.tmp && of(B)!.tmp === of(A)!.tmp, "B's tool had A's temporary folder").toBeFalsy();
      await page.screenshot({ path: test.info().outputPath('real-hermes-agent.png') });
      // Its gateway stopped when the last Hermes terminal ends: A stopped, it stays for B; B stopped, it goes.
      await call('agent', 'stop', A);
      await sleep(5_000);
      const afterA = alive(record.pid);
      // B, still answering after A's stop: its session ran in the gateway A's stop left alone.
      await lead('send_message', { id: B, message: 'Run the probe again and report what it printed.' });
      const bAgain = await lead('wait_for_agent', { id: B, timeoutSeconds: 300 });
      expect.soft(bAgain.text, "B's answer after A stopped").toContain(`PROBE-OK ${standin.marker}`);
      // The gateway Tars started carries no agent's identity (the reason A's stop no longer ends it).
      expect.soft(/ CLAUDE_AGENT_ID=| CLAUDE_MGR_API_TOKEN=| CLAUDE_PROJECT_PATH=/.test(gatewayEnv), 'an agent\'s variables in the gateway\'s environment').toBe(false);
      await call('agent', 'stop', B);
      await expect.poll(() => alive(record.pid), { timeout: 30_000 }).toBe(false);
      // And at quit: A started again starts a gateway again, which the quit stops.
      await call('agent', 'start', { id: A, prompt: '' });
      const screenA = async () => ((await call('agent', 'get', A)) as { output?: string[] } | null)?.output?.join('') ?? '';
      await expect.poll(async () => (await screenA()).includes('❯'), { timeout: 120_000, intervals: [2_000] }).toBe(true)
        .finally(async () => fs.writeFileSync(test.info().outputPath('screen-at-restart-A.txt'), await screenA().catch(() => '')));
      // A new gateway: its record names a live pid other than the first one's.
      const newGateway = () => { try { const p = JSON.parse(fs.readFileSync(path.join(hermesRoot, 'gateway.pid'), 'utf8')).pid; return typeof p === 'number' && p !== record.pid && alive(p) ? p : 0; } catch { return 0; } };
      await expect.poll(newGateway, { timeout: 60_000 }).toBeGreaterThan(0);
      const recordAgain = { pid: newGateway() };
      const againBefore = alive(recordAgain.pid);
      await app.close();
      app = undefined;
      await expect.poll(() => alive(recordAgain.pid), { timeout: 30_000 }).toBe(false);
      // What reached the logging proxy, when the runner names its log: PyPI only, and nothing refused.
      const proxyLog = process.env.TARS_HARNESS_HERMES_PROXY_LOG;
      const outsideHosts = proxyLog && fs.existsSync(proxyLog)
        ? fs.readFileSync(proxyLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { host?: string; refused?: string; url?: string })
          .filter(e => e.refused || !['pypi.org', 'files.pythonhosted.org'].includes(e.host ?? '')).map(e => `${e.refused ?? 'tunnel'} ${e.host ?? e.url ?? ''}`)
        : null;
      keep({ real, done, envNames: Object.keys(env[A]).sort(), record, gatewayBefore, afterA, recordAgain, againBefore, outsideHosts, leftAtQuit: fs.existsSync(path.join(profile(A), '.env')) });
      expect.soft(afterA, 'the gateway with B\'s terminal still open').toBe(true);
      expect.soft(againBefore, 'a gateway again for A restarted').toBe(true);
      if (outsideHosts) expect.soft(outsideHosts, 'requests outside PyPI, or refused').toEqual([]);
      expect.soft(done[A].text, "A's answer").toContain(`PROBE-OK ${standin.marker}`);
      expect.soft(Object.keys(env[A]).sort(), "A's .env names").toEqual(['CLAUDE_MGR_API_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
      expect.soft(fs.existsSync(path.join(profile(A), 'state.db')), "A's state.db in its profile").toBe(true);
      expect.soft(fs.existsSync(path.join(home, '.hermes')), "the sandbox's ~/.hermes").toBe(false);
      expect.soft(gatewayBefore, 'a gateway of Tars\'s home ran').toBe(true);
      // Hermes resolves its home: under macOS's /tmp the record says /private/tmp/... (27/11).
      expect.soft(record.hermes_home && fs.realpathSync(record.hermes_home), 'the gateway\'s home').toBe(fs.realpathSync(hermesRoot));
      expect.soft(fs.existsSync(path.join(profile(A), '.env')), 'a .env after the quit').toBe(false);
      return;
    }
    const launches = fakeEntries().filter(e => e.hermes);
    const launchOf = (id: string) => launches.find(e => e.home === profile(id)) as Record<string, unknown> & { scope: string[]; terminal: Record<string, boolean>; guards: Record<string, unknown>; envMode: string; source: string };
    const pidOf = (id: string) => launchOf(id)?.pid as number;
    // The stand-in's own launch line, by the same process: its argv and the question it put on screen.
    const startOf = (id: string) => fakeEntries().find(e => e.launch && e.pid === pidOf(id)) as { argv?: string[]; question?: string | null } | undefined;
    const argvOf = (id: string) => startOf(id)?.argv ?? [];
    const modelCalls = fakeEntries().filter(e => e.model === true) as Array<Record<string, unknown> & { keyHash: string; pid: number }>;
    const reached = standinEntries().filter(e => e.method === 'POST' && e.headers);
    keep({
      launches, argv: { A: argvOf(A), B: argvOf(B) }, done,
      envNames: { A: Object.keys(env[A]).sort(), B: Object.keys(env[B]).sort() },
      keyHashes: { A: env[A].OPENAI_API_KEY ? hash(env[A].OPENAI_API_KEY) : null, B: env[B].OPENAI_API_KEY ? hash(env[B].OPENAI_API_KEY) : null },
      modelCalls: modelCalls.map(c => ({ pid: c.pid, status: c.status, keyHead: c.keyHead, keyHash: c.keyHash })),
      endpointSaw: reached.map(r => ({ url: r.url, realKey: r.headers!.authorization === `Bearer ${key}`, terminalToken: JSON.stringify(r.headers).includes('tep_') })),
    });

    for (const [id, name] of [[A, 'A'], [B, 'B']] as const) {
      const l = launchOf(id);
      // 1 to 3.
      expect.soft(l, `${name}'s Hermes was started`).toBeTruthy();
      expect.soft(l?.source, `${name}'s sessions are tagged`).toBe('tool');
      expect.soft(l?.terminal, `${name}'s terminal holds a token or an OpenAI variable, or leaves the cloud metadata lookup on`).toEqual({ token: false, endpointToken: false, openaiKey: false, openaiBase: false, awsMetadataOff: true });
      expect.soft(l?.scope, `${name}'s .env names`).toEqual(['CLAUDE_MGR_API_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']);
      expect.soft(l?.envMode, `${name}'s .env mode`).toBe('600');
      expect.soft(l?.guards, `${name}'s config guards`).toMatchObject({ telemetry: true, adoptLogins: true, updates: true, modelCatalog: true, pluginChecks: true, lazyInstallsOff: true, modelsDevLocal: true, ownToolEnv: true });
      // The root the gateway resolves its own provider from (the first real start's metadata calls, 27/11).
      expect.soft((l as { root?: unknown } | undefined)?.root, 'the root\'s provider and lookups').toEqual({ customProvider: true, lazyInstallsOff: true, modelsDevLocal: true });
      expect.soft(startOf(id)?.question ?? null, `a question on ${name}'s screen`).toBeNull();
      // 4.
      const own = env[id].OPENAI_API_KEY;
      const theirs = env[id === A ? B : A].OPENAI_API_KEY;
      const calls = modelCalls.filter(c => c.pid === pidOf(id));
      expect.soft(own?.startsWith('tep_'), `${name}'s .env holds a proxy token`).toBe(true);
      expect.soft(calls.length, `${name}'s model calls`).toBeGreaterThan(0);
      expect.soft(calls.every(c => c.keyHash === hash(own ?? '')), `${name}'s model calls carried its own token`).toBe(true);
      expect.soft(calls.some(c => c.keyHash === hash(theirs ?? '')), `${name}'s model calls carried the other's token`).toBe(false);
      // 5 and 6.
      expect.soft(done[id].text, `${name}'s answer`).toContain(`PROBE-OK ${standin.marker}`);
      expect.soft(done[id].text, `${name}'s whoami`).toContain(`whoami answered: You are "Hermes ${name}" (agent id: ${id})`);
      // The other's token, written nowhere in this profile.
      const everything = fs.readdirSync(profile(id)).filter(n => fs.statSync(path.join(profile(id), n)).isFile() && n !== 'state.db').map(n => fs.readFileSync(path.join(profile(id), n), 'utf8')).join('\n');
      for (const v of [env[id === A ? B : A].OPENAI_API_KEY, env[id === A ? B : A].CLAUDE_MGR_API_TOKEN]) expect.soft(everything.includes(v ?? '\u0000'), `${name}'s profile holds the other's token`).toBe(false);
      expect.soft(fs.readFileSync(path.join(profile(id), 'config.yaml'), 'utf8'), `${name}'s config names its token by variable`).toContain('"${CLAUDE_MGR_API_TOKEN}"');
    }
    expect.soft(env[A].OPENAI_API_KEY !== env[B].OPENAI_API_KEY && env[A].CLAUDE_MGR_API_TOKEN !== env[B].CLAUDE_MGR_API_TOKEN, 'the two agents share a token').toBe(true);
    expect.soft(reached.length, 'requests reached the endpoint').toBeGreaterThan(0);
    expect.soft(reached.every(r => r.headers!.authorization === `Bearer ${key}`), 'the endpoint got the real key').toBe(true);
    expect.soft(reached.every(r => !JSON.stringify(r.headers).includes('tep_')), "the endpoint saw a terminal's token").toBe(true);
    // 7.
    expect.soft(launchOf(A)?.guards?.approvals, "A's approvals").toBe('manual');
    expect.soft(launchOf(B)?.guards?.approvals, "B's approvals").toBe('smart');
    expect.soft(argvOf(A), "A's line").not.toContain('--yolo');
    expect.soft(argvOf(B), "B's line").toContain('--yolo');
    // 1: the user's own Hermes home was never made, and no token sits at the root every profile shares.
    expect.soft(fs.existsSync(path.join(home, '.hermes')), "the user's ~/.hermes").toBe(false);
    const rootText = fs.readdirSync(hermesRoot).filter(n => fs.statSync(path.join(hermesRoot, n)).isFile()).map(n => fs.readFileSync(path.join(hermesRoot, n), 'utf8')).join('\n');
    expect.soft(/tep_|e2e-endpoint-key/.test(rootText), 'a token or key at the root').toBe(false);

    await page.screenshot({ path: test.info().outputPath('two-hermes-agents.png') });

    // 9. The gateway both share, started by Tars before their chats (core/hermes-gateway.ts): one, in Tars's Hermes
    // home, started with no agent's identity, token or project.
    const gateways = fakeEntries().filter(e => e.gateway === true) as Array<Record<string, unknown> & { home: string; envNames: string[]; pid: number }>;
    const notForTheGateway = ['CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'TARS_ENDPOINT_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'];
    const gwRecord = () => { try { return JSON.parse(fs.readFileSync(path.join(hermesRoot, 'gateway.pid'), 'utf8')).pid as number; } catch { return 0; } };
    const running = (pid: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
    const gwPid = gwRecord();
    keep({ gateways: gateways.map(g => ({ pid: g.pid, home: g.home, envNames: g.envNames })) });
    expect.soft(gateways.length, 'gateways started').toBe(1);
    expect.soft(gateways[0]?.home, 'the gateway\'s home').toBe(hermesRoot);
    expect.soft(gateways[0]?.agent ?? null, 'the gateway\'s agent id').toBeNull();
    expect.soft(notForTheGateway.filter(n => gateways[0]?.envNames.includes(n)), 'an agent\'s variables in the gateway\'s environment').toEqual([]);

    // 8. A stops: its .env goes, B's stays, the gateway stays, and B still answers; B stops, the last Hermes terminal:
    // the gateway goes; at quit, no .env is left.
    await call('agent', 'stop', A);
    await expect.poll(() => fs.existsSync(path.join(profile(A), '.env')), { timeout: 20_000 }).toBe(false);
    const bKept = fs.existsSync(path.join(profile(B), '.env'));
    await sleep(2_000);
    const gatewayAfterA = running(gwPid);
    await lead('send_message', { id: B, message: 'Run the probe again and report what it printed.' });
    const bAgain = await lead('wait_for_agent', { id: B, timeoutSeconds: 90 });
    await call('agent', 'stop', B);
    await expect.poll(() => running(gwPid), { timeout: 20_000 }).toBe(false);
    await app.close();
    app = undefined;
    const leftAtQuit = fs.readdirSync(path.join(hermesRoot, 'profiles')).filter(id => fs.existsSync(path.join(profile(id), '.env')));
    keep({ bKeptAfterAStopped: bKept, gatewayAfterA, bAgain, leftAtQuit });
    expect.soft(bKept, "B's .env after A stopped").toBe(true);
    expect.soft(gatewayAfterA, 'the gateway after A stopped').toBe(true);
    expect.soft(bAgain.text, "B's answer after A stopped").toContain(`PROBE-OK ${standin.marker}`);
    expect.soft(leftAtQuit, 'a .env after the quit').toEqual([]);
  } finally {
    for (const s of servers) s.kill();
    await app?.close().catch(() => {});
    if (fs.existsSync(fakeLog)) fs.copyFileSync(fakeLog, test.info().outputPath('fake-hermes.jsonl'));
    // The real binary: what its gateway said and recorded, before the sandbox goes (its own log of every start Tars
    // made, its record, its state, its logs). Names and states only: no profile's .env, no session.
    if (real) {
      const keepDir = test.info().outputPath('hermes-root');
      fs.mkdirSync(keepDir, { recursive: true });
      for (const rel of ['logs/tars-gateway.log', 'logs/gateway.log', 'logs/errors.log', 'gateway.pid', 'gateway_state.json', 'gateway-starts.log']) {
        const from = path.join(hermesRoot, rel);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(keepDir, rel.replace('/', '-')));
      }
    }
    await standin.close();
    await removeHome(home);
  }
}
