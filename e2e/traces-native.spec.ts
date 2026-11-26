import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as zlib from 'zlib';
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
 *    X-Agent-Id (the endpoint's "send session headers" is on), never the terminal's token; Q's harness sees the token (`tep_`), never the key.
 * 3. Pause, not fail: the endpoint answers 503, then 429, then 200; Q's harness sees only 200s, and the window is
 *    told of the wait while it lasts.
 * 4. The stream is not buffered: Q's first chunk comes before the endpoint sends its last.
 * 5. The trace: one session for Q, one turn by Lead (an orchestrator on a closed model, so `mixed`), its requests with
 *    the held attempts and the endpoint's request ids, the tool call; nothing for Off.
 * 6. The read API: the reader token reads the session; the shared token gets 401.
 * 7. An endpoint Lead adds waits for the owner's approval, and an agent cannot be set on it until then.
 * 8. (The Audit's H1 on #596.) Lead moves the endpoint's base URL to an address of its own, then asks for its models
 *    and its health, by its tools and by the window's buttons: that address never receives the key, and the move
 *    took the key away.
 * Added before their code, the owner's decision of 26/11:
 * 9. The window gives the endpoint an extra header, which every request reaching the endpoint carries; one naming
 *    the credential is refused, and nothing changes.
 * 10. TTFT measures the model: the endpoint opens its stream with an empty chunk, then pauses, then sends its first
 *     token; the request's ttft is that token's, not the empty chunk's.
 * 11. A 502 to a POST passes through once: the endpoint answers 502 to Q's next model call, and the harness gets it
 *     at once, never sent again.
 * 12. Lead gives another endpoint an extra header through its tools: it waits for the owner's approval; one naming
 *     the credential is refused.
 * 13. A side request goes up marked: Q's harness sends a title call before its task, and the upload to a
 *     back-office stand-in carries `side: true` for it and `side: false` for the rest.
 * 14. (Found in the window's work on #599, 27/11.) Approval stays apart from saving: once Lead has moved the endpoint
 *     and changed its extra headers, the owner turning its traces off in the window leaves it unapproved, and Q's next
 *     model call is refused (403) without reaching the address Lead set.
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
  const standin = await startStandIn({ key, log: standinLog, failFirst: [503, 429], chunkDelayMs: 300, emptyFirstChunk: true });

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
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30, sendSessionHeaders: true }],
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

    // 9. An extra header from the window; a credential header refused.
    const owned = { id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, holdMaxSeconds: 30, sendSessionHeaders: true };
    const withHeader = await api<{ ok: boolean; error?: string }>('endpoints', 'save', { ...owned, extraHeaders: { 'X-Tenant': 'e2e-tenant' } });
    const credential = await api<{ ok: boolean; error?: string }>('endpoints', 'save', { ...owned, extraHeaders: { Authorization: 'Bearer not-the-key' } });
    const headerView = (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === EP);
    keep({ withHeader, credential, headerView });
    expect.soft(withHeader.ok, `the extra header: ${withHeader.error}`).toBe(true);
    expect.soft(credential.ok, 'a credential header').toBe(false);
    expect.soft(headerView, 'the endpoint after both').toMatchObject({ approved: true, keySet: true, extraHeaders: { 'X-Tenant': 'e2e-tenant' } });

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
    expect.soft(reached.map(r => r.headers!['x-tenant']), 'the extra header at the endpoint').toEqual(reached.map(() => 'e2e-tenant'));
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
    // 10. The first token came 300 ms after the empty first chunk: the ttft is the token's.
    keep({ ttft: requests.map(r => r.ttftMs) });
    expect.soft(Number(requests[1]?.ttftMs), 'the ttft of a request whose stream opened with an empty chunk').toBeGreaterThanOrEqual(250);
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

    // 11. A 502 to a POST, once.
    const answeredBefore = standinEntries().filter(e => e.answered !== undefined).length;
    const callsBefore = fakeEntries().filter(e => e.model && e.agent === Q).length;
    standin.failNext(502);
    await lead('send_message', { id: Q, message: 'Run the probe once more.' });
    const after502 = await lead('wait_for_agent', { id: Q, timeoutSeconds: 90 });
    const answeredAfter = standinEntries().filter(e => e.answered !== undefined).slice(answeredBefore).map(a => a.answered);
    const harnessSaw = fakeEntries().filter(e => e.model && e.agent === Q).slice(callsBefore).map(c => c.status);
    keep({ after502, answeredAfter, harnessSaw });
    expect.soft(answeredAfter, 'what the endpoint answered to the next call').toEqual([502]);
    expect.soft(harnessSaw, 'what the harness got').toEqual([502]);

    // 13. A side request goes up marked side: true, to a back-office stand-in that takes installs, blobs and batches.
    const batches: Array<{ requests?: Array<{ side?: unknown; requestId?: string }> }> = [];
    const backOffice = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const answer = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        const url = req.url ?? '';
        if (req.method === 'POST' && url === '/v1/installs') { answer(201, { installId: 'inst-1', token: 'tbi_1', limits: {}, retentionDays: 90 }); return; }
        if (req.method === 'POST' && url === '/v1/blobs/missing') { answer(200, { missing: [] }); return; }
        if (req.method === 'PUT' && url.startsWith('/v1/batches/')) {
          const enc = req.headers['content-encoding'];
          const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
          const body = enc === 'zstd' && zstd ? zstd(raw) : enc === 'gzip' ? zlib.gunzipSync(raw) : raw;
          batches.push(JSON.parse(body.toString()));
          answer(200, { missingBlobs: [] });
          return;
        }
        answer(404, { error: 'not_found' });
      });
    });
    await new Promise<void>(r => backOffice.listen(0, '127.0.0.1', () => r()));
    try {
      await lead('send_message', { id: Q, message: 'Give this a title, then run the probe.' });
      const titled = await lead('wait_for_agent', { id: Q, timeoutSeconds: 90 });
      const address = await api<{ ok: boolean; error?: string }>('traces', 'setSettings', { uploadUrl: `http://127.0.0.1:${(backOffice.address() as { port: number }).port}` });
      await api('traces', 'uploadNotice');
      const consent = await api<{ ok: boolean; error?: string }>('traces', 'giveUploadConsent');
      const pass = await app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/services/traces-runtime.js`).traceUploader().runOnce(), { dist });
      const uploaded = batches.flatMap(b => b.requests ?? []);
      keep({ titled, address, consent, pass, uploadedSide: uploaded.map(q => q.side) });
      expect.soft(address.ok && consent.ok, `the back-office address and the consent: ${address.error ?? ''} ${consent.error ?? ''}`).toBe(true);
      expect.soft(uploaded.length, 'requests uploaded').toBeGreaterThan(0);
      expect.soft(uploaded.every(q => typeof q.side === 'boolean'), 'every uploaded request says side').toBe(true);
      expect.soft(uploaded.filter(q => q.side === true).length, 'the title call uploaded as a side request').toBe(1);
    } finally {
      await new Promise(r => backOffice.close(() => r(undefined)));
    }

    // 7. An endpoint an agent adds waits for the owner.
    const added = await lead('endpoint_add', { name: 'Another host', base_url: 'https://192.0.2.10:9000/v1' });
    const after = await api<Array<Record<string, unknown>>>('endpoints', 'list');
    const another = after.find(v => v.name === 'Another host');
    const moved = await page.evaluate(({ id, ep }) => ((window as unknown as Api).electronAPI.agent.update as (p: unknown) => Promise<unknown>)({ id, endpointId: ep, model: 'any' }), { id: OFF, ep: String(another?.id) }) as { success: boolean; error?: string };
    keep({ added, another, moved });
    expect.soft(added.text, 'endpoint_add').toContain('approval');
    expect.soft(another, 'the added endpoint').toMatchObject({ approved: false, changedBy: { agentId: LEAD } });
    expect.soft(moved.success, 'an agent set on an endpoint not approved').toBe(false);
    expect.soft(moved.error, 'why').toMatch(/approve/);

    // 12. Lead's extra header waits for the owner; a credential header is refused.
    const approvedOther = await api<{ ok: boolean }>('endpoints', 'approve', String(another?.id), { baseUrl: another?.baseUrl, extraHeaders: another?.extraHeaders ?? {} });
    const leadHeader = await lead('endpoint_update', { id: String(another?.id), extra_headers: { 'X-Route': 'r9' } });
    const leadCredential = await lead('endpoint_update', { id: String(another?.id), extra_headers: { 'x-api-key': 'k' } });
    const otherAfter = (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === another?.id);
    keep({ approvedOther, leadHeader, leadCredential, otherAfter });
    expect.soft(approvedOther.ok, 'the owner approved the other endpoint').toBe(true);
    expect.soft(leadHeader.isError, `endpoint_update with a header: ${leadHeader.text}`).toBe(false);
    expect.soft(leadHeader.text, 'it says it waits').toContain('approval');
    expect.soft(leadCredential.isError, 'a credential header from Lead').toBe(true);
    expect.soft(otherAfter, 'the other endpoint').toMatchObject({ approved: false, extraHeaders: { 'X-Route': 'r9' } });

    // 8. The key never goes to an address nobody approved.
    const attackerLog = test.info().outputPath('attacker-requests.jsonl');
    const attacker = await startStandIn({ log: attackerLog });
    try {
      const repointed = await lead('endpoint_update', { id: EP, base_url: attacker.baseUrl });
      const viaTools = [await lead('endpoint_refresh_models', { id: EP }), await lead('endpoint_check', { id: EP })];
      await api('endpoints', 'refreshModels', EP);
      await api('endpoints', 'check', EP);
      const reachedAttacker = fs.existsSync(attackerLog) ? fs.readFileSync(attackerLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const afterMove = (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === EP);
      keep({ repointed, viaTools, attackerSaw: reachedAttacker.map(r => ({ url: r.url, auth: r.headers?.authorization ? 'present' : 'none' })), afterMove });
      expect.soft(reachedAttacker.length, 'the probes went to the new address').toBeGreaterThan(0);
      expect.soft(reachedAttacker.every(r => !r.headers?.authorization && !r.headers?.['x-api-key']), 'a credential reached the unapproved address').toBe(true);
      expect.soft(JSON.stringify(reachedAttacker), 'the key reached the unapproved address').not.toContain(key);
      expect.soft(afterMove, 'the moved endpoint').toMatchObject({ approved: false, keySet: false });

      // 14. Approval stays apart from saving: Lead changes the headers too, over its tools; the owner turns traces off
      // in the window, the form showing the pending values. The endpoint stays unapproved, and Q's next model call
      // never reaches the address Lead set.
      const leadHeaders = await lead('endpoint_update', { id: EP, extra_headers: { 'X-Route': 'agent-set' } });
      const pending = (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === EP)!;
      const flipped = await api<{ ok: boolean; error?: string }>('endpoints', 'save', {
        id: EP, name: String(pending.name), baseUrl: String(pending.baseUrl), allowTraces: false, holdMaxSeconds: 30, sendSessionHeaders: true, extraHeaders: pending.extraHeaders,
      });
      const afterFlip = (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === EP);
      const attackerPosts = () => (fs.existsSync(attackerLog) ? fs.readFileSync(attackerLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []).filter((r: { method?: string }) => r.method === 'POST').length;
      const postsBefore = attackerPosts();
      const callsBeforeFlip = fakeEntries().filter(e => e.model && e.agent === Q).length;
      await lead('send_message', { id: Q, message: 'Run the probe a last time.' });
      await lead('wait_for_agent', { id: Q, timeoutSeconds: 90 });
      const afterFlipCalls = fakeEntries().filter(e => e.model && e.agent === Q).slice(callsBeforeFlip).map(c => c.status);
      keep({ leadHeaders, flipped, afterFlip, attackerPostsAfterFlip: attackerPosts() - postsBefore, afterFlipCalls });
      expect.soft(flipped.ok, `the owner's traces toggle: ${flipped.error}`).toBe(true);
      expect.soft(afterFlip, 'the endpoint after the owner\'s toggle').toMatchObject({ approved: false, allowTraces: false, extraHeaders: { 'X-Route': 'agent-set' } });
      expect.soft(attackerPosts() - postsBefore, 'model calls that reached the address Lead set').toBe(0);
      expect.soft(afterFlipCalls, "what Q's harness got").toEqual([403]);
    } finally {
      await attacker.close();
    }
  } finally {
    for (const s of servers) s.kill();
    await app?.close().catch(() => {});
    await standin.close();
    await removeHome(home);
  }
});
