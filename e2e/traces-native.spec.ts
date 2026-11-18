import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent runs an open harness on an OpenAI-compatible inference endpoint through Tars, and its session is traced
 * (native traces). The endpoint is e2e/stand-in-openai-endpoint.mjs on loopback, with a dummy key and no network.
 * Q is a qwen-code agent (the qwen stand-in of e2e/fake-clis.mjs, which talks to OPENAI_BASE_URL as Qwen Code 0.25.2
 * does with --auth-type openai); Off is another, with its traces off; Lead, the project's orchestrator, works through
 * the real mcp-orchestrator with its own identity. Asserted:
 * 1. Lead sets the endpoint's key from a drop file (endpoint_set_key): the file is gone, the key is in no view.
 * 2. Lead's task to Q reaches the endpoint through the proxy: the endpoint sees the real key, X-Session-Id and
 *    X-Agent-Id, never the terminal's token; Q's harness sees the token (`tep_`), never the key.
 * 3. Pause, not fail: the endpoint answers 503, then 429, then 200; Q's harness sees only 200s, and the window is
 *    told of the wait while it lasts.
 * 4. The stream is not buffered: Q's first chunk comes before the endpoint sends its last.
 * 5. The trace: one session for Q, one turn by Lead (an orchestrator on a closed model, so `mixed`), its requests with
 *    the held attempts and the endpoint's request ids, the tool call; nothing for Off.
 * 6. The read API: the reader token reads the session; the shared token gets 401.
 * 7. An endpoint Lead adds waits for the owner's approval, and an agent cannot be set on it until then.
 * The artefact: values.json, the stand-in's request log (headers included), the trace export, the app's log.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d7';
const Q = 'eeee5555-0000-4000-8000-0000000000e1';
const OFF = 'eeee5555-0000-4000-8000-0000000000e2';
const EP = 'ep-0e2e01';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> & {
  endpoints: { onWaiting(cb: (w: unknown) => void): () => void };
} };

test('an open harness runs on an inference endpoint through Tars, held while the endpoint pauses, and its session is traced', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-traces-native-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog, failFirst: [503, 429], chunkDelayMs: 300 });

  const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
    agent(Q, 'Q', { provider: 'qwen-code', model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes['qwen-code'] }),
    agent(OFF, 'Off', { provider: 'qwen-code', model: MODEL_ID, endpointId: EP, traces: false, cliPath: fakes['qwen-code'] }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }, null, 2));

  const port = apiPort(31940);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  const fakeEntries = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;
  const standinEntries = () => (fs.existsSync(standinLog) ? fs.readFileSync(standinLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown> & { headers?: Record<string, string>; body?: Record<string, unknown> }>;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    // What the window is told while a request is held.
    await page.evaluate(() => {
      const w = window as unknown as Api & { __waits: unknown[] };
      w.__waits = [];
      w.electronAPI.endpoints.onWaiting((waits) => { w.__waits.push(waits); });
    });

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

    // 1. The key, from the drop file.
    const drop = path.join(dir, 'endpoint-keys');
    fs.mkdirSync(drop, { recursive: true });
    fs.writeFileSync(path.join(drop, 'remote.key'), `${key}\n`);
    const setKey = await lead('endpoint_set_key', { id: EP, key_file: 'remote.key' });
    const views = await api<Array<Record<string, unknown>>>('endpoints', 'list');
    keep({ setKey, views });
    expect.soft(setKey.isError, `endpoint_set_key: ${setKey.text}`).toBe(false);
    expect.soft(fs.existsSync(path.join(drop, 'remote.key')), 'the drop file is still there').toBe(false);
    expect.soft(views.find(v => v.id === EP)?.keySet, 'the key is not set').toBe(true);
    expect.soft(JSON.stringify(views), 'a view holds the key').not.toContain(key);

    // 2 to 4. Lead's task to Q, through the proxy, held while the endpoint pauses.
    await page.evaluate((id) => ((window as unknown as Api).electronAPI.agent.start as (p: unknown) => Promise<unknown>)({ id, prompt: '' }), Q);
    await expect.poll(async () => fakeEntries().some(e => e.launch && e.agent === Q), { timeout: 30_000 }).toBe(true);
    const sent = await lead('send_message', { id: Q, message: 'Run the probe and report what it printed.' });
    const done = await lead('wait_for_agent', { id: Q, timeoutSeconds: 90 });
    const launch = fakeEntries().find(e => e.launch && e.agent === Q);
    const modelCalls = fakeEntries().filter(e => e.model && e.agent === Q);
    const reached = standinEntries().filter(e => e.method === 'POST' && e.headers);
    const answered = standinEntries().filter(e => e.answered !== undefined);
    const waitsSeen = await page.evaluate(() => (window as unknown as { __waits: unknown[] }).__waits);
    keep({ sent, done, launch, modelCalls, endpointSaw: reached.map(r => ({ url: r.url, auth: r.headers!.authorization === `Bearer ${key}`, session: r.headers!['x-session-id'], agent: r.headers!['x-agent-id'], tokenSeen: JSON.stringify(r.headers).includes('tep_') })), answered, waitsSeen });
    expect.soft((launch?.argv as string[] | undefined) ?? [], "Q's launch").toEqual(expect.arrayContaining(['--auth-type', 'openai']));
    expect.soft(done.text, "Q's answer").toContain(`PROBE-OK ${standin.marker}`);
    expect.soft(modelCalls.map(c => c.status), "what Q's harness saw").toEqual([200, 200]);
    expect.soft(modelCalls.every(c => c.keyHead === 'tep_'), "Q's harness holds the terminal's token").toBe(true);
    expect.soft(answered.map(a => a.answered), 'what the endpoint answered').toEqual([503, 429, 200, 200]);
    expect.soft(reached.every(r => r.headers!.authorization === `Bearer ${key}`), 'the endpoint got the real key').toBe(true);
    expect.soft(reached.every(r => !JSON.stringify(r.headers).includes('tep_')), "the endpoint saw a terminal's token").toBe(true);
    expect.soft(new Set(reached.map(r => r.headers!['x-agent-id'])), 'X-Agent-Id').toEqual(new Set([Q]));
    expect.soft(reached.every(r => /^tr_/.test(String(r.headers!['x-session-id']))), 'X-Session-Id').toBe(true);
    const statuses = (waitsSeen as Array<Array<{ agentId: string; lastStatus?: number }>>).flat().filter(w => w.agentId === Q).map(w => w.lastStatus);
    expect.soft(statuses, 'the window was told of the wait').toEqual(expect.arrayContaining([503, 429]));
    const lastSent = answered.filter(a => a.answered === 200).map(a => Number(a.lastChunkAt));
    const firstGot = modelCalls.map(c => Number(c.firstChunkAt));
    expect.soft(firstGot[0] < lastSent[0], `the first chunk came at ${firstGot[0]}, the last was sent at ${lastSent[0]}: buffered`).toBe(true);

    // Off, traces off: it reaches the endpoint, and nothing is recorded.
    await page.evaluate((id) => ((window as unknown as Api).electronAPI.agent.start as (p: unknown) => Promise<unknown>)({ id, prompt: '' }), OFF);
    await expect.poll(async () => fakeEntries().some(e => e.launch && e.agent === OFF), { timeout: 30_000 }).toBe(true);
    await lead('send_message', { id: OFF, message: 'Run the probe too.' });
    const offDone = await lead('wait_for_agent', { id: OFF, timeoutSeconds: 90 });
    keep({ offDone });

    // 5. The trace.
    await expect.poll(async () => (await api<{ sessions: Array<{ requestCount: number }> }>('traces', 'list', {})).sessions[0]?.requestCount ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const list = await api<{ sessions: Array<Record<string, unknown> & { traceId: string }>; totals: Record<string, number> }>('traces', 'list', {});
    const session = await api<{ session: Record<string, unknown>; turns: Array<Record<string, unknown> & { requests: Array<Record<string, unknown>> }> }>('traces', 'session', list.sessions[0]?.traceId);
    keep({ list, session });
    expect.soft(list.sessions.map(s => s.agentId), 'the sessions traced').toEqual([Q]);
    expect.soft(session.session, 'the session').toMatchObject({ harness: 'qwen-code', model: MODEL_ID, endpointId: EP, mixed: true, unknownTurns: 0, requestCount: 2 });
    expect.soft(session.turns.map(t => [t.author, t.toolCalls]), 'its turn').toEqual([['orchestrator', 1]]);
    const requests = session.turns[0]?.requests ?? [];
    expect.soft(requests.map(r => r.attempts), 'the attempts of each request').toEqual([3, 1]);
    expect.soft(requests.every(r => /^standin-/.test(String(r.upstreamRequestId))), "the endpoint's request ids").toBe(true);
    expect.soft(Number(requests[0]?.heldMs), 'the time held').toBeGreaterThanOrEqual(1500);
    const messages = await api<{ input: Array<{ role: string; parts: Array<{ kind: string; text?: string }> }>; output: unknown[] }>('traces', 'requestMessages', requests[1]?.requestId);
    expect.soft(JSON.stringify(messages.input), 'the tool result in the trace').toContain(standin.marker);
    const exported = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return [...req(`${dist}/services/trace-export.js`).traceExportLines(req(`${dist}/services/traces-runtime.js`).traceStore(), {})] as string[];
    }, { dist });
    fs.writeFileSync(test.info().outputPath('traces-export.jsonl'), `${exported.join('\n')}\n`);
    expect.soft(exported.join('\n'), 'the export holds the key').not.toContain(key);

    // 6. The read API.
    const { token: reader } = await api<{ token: string }>('traces', 'rotateReaderToken');
    const read = await fetch(`http://127.0.0.1:${port}/api/traces/sessions`, { headers: { Authorization: `Bearer ${reader}` } });
    const readBody = await read.json() as { sessions: Array<{ traceId: string }> };
    const doc = await fetch(`http://127.0.0.1:${port}/api/traces/sessions/${list.sessions[0]?.traceId}`, { headers: { Authorization: `Bearer ${reader}` } }).then(r => r.json()) as { requests: Array<{ upstream_request_id: string }> };
    const shared = fs.readFileSync(path.join(home, '.tars-private', 'api-token'), 'utf8').trim();
    const refused = await fetch(`http://127.0.0.1:${port}/api/traces/sessions`, { headers: { Authorization: `Bearer ${shared}` } });
    keep({ readStatus: read.status, read: readBody, doc: { requests: doc.requests?.length }, sharedStatus: refused.status });
    expect.soft(read.status, 'the reader token').toBe(200);
    expect.soft(readBody.sessions.map(s => s.traceId), 'what the reader reads').toEqual([list.sessions[0]?.traceId]);
    expect.soft(doc.requests?.map(r => r.upstream_request_id).every(id => /^standin-/.test(id)), 'the join ids in the session document').toBe(true);
    expect.soft(refused.status, 'the shared token on the traces').toBe(401);

    // 7. An endpoint an agent adds waits for the owner.
    const added = await lead('endpoint_add', { name: 'Another host', base_url: 'http://192.0.2.10:9000/v1' });
    const after = await api<Array<Record<string, unknown>>>('endpoints', 'list');
    const another = after.find(v => v.name === 'Another host');
    const moved = await page.evaluate(({ id, ep }) => ((window as unknown as Api).electronAPI.agent.update as (p: unknown) => Promise<unknown>)({ id, endpointId: ep, model: 'any' }), { id: OFF, ep: String(another?.id) }) as { success: boolean; error?: string };
    keep({ added, another, moved });
    expect.soft(added.text, 'endpoint_add').toContain('approval');
    expect.soft(another, 'the added endpoint').toMatchObject({ approved: false, changedBy: { agentId: LEAD } });
    expect.soft(moved.success, 'an agent set on an endpoint not approved').toBe(false);
    expect.soft(moved.error, 'why').toMatch(/approve/);
  } finally {
    for (const s of servers) s.kill();
    await app?.close().catch(() => {});
    await standin.close();
    await removeHome(home);
  }
});
