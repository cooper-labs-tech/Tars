import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Deletions reach every copy: a traced session deleted in Tars, by its owner in the Traces page or by the retention
 * sweep, is listed for the trace reader on the loopback read API (GET /api/traces/deletions, the back-office's
 * deletions feed's shape), and one that was uploaded is deleted at the back-office too (DELETE /v1/sessions/{id}).
 *
 * A sandbox with one traced agent, its project and endpoint opted in, retention at 30 days, and a back-office
 * stand-in on loopback that takes installs, blobs and batches, records every request, and refuses the first
 * per-session delete with a 503 (Retry-After: 1). Sessions are recorded by the app's own store (the proxy that
 * normally records them is not the subject); the uploader's pass and the hourly sweep are run now, in place of their
 * timers.
 *
 * How it can fail, written before it ran (27/11):
 * 1. A session the owner deletes from the Traces page is not listed by the deletions route, or is listed under
 *    another reason than `user`.
 * 2. A session the retention sweep removes is not listed, or not as `retention`.
 * 3. The route opens to another credential than the reader's token (the shared token, none), or a deletion carries
 *    more than its id, its reason and its time.
 * 4. Read again from the cursor it gave, the route gives a deletion twice; after a restart the cursor is lost.
 * 5. A session uploaded and then deleted here (by the owner, by retention) is never deleted at the back-office; one
 *    never uploaded is asked for there; a session still kept is.
 * 6. The per-session delete the back-office refused (503) is lost, or not sent again after a restart; or one it took
 *    is sent again.
 * 7. An uncaught error in the page.
 * The artefact: values.json (the route's pages, the passes, the requests the back-office saw), the back-office's
 * request log, a screenshot per step, the app's log.
 */

const AGENT = 'eeee5555-0000-4000-8000-0000000000f7';
const DAY = 86_400_000;
type Deletion = { sessionId: string; reason: string; at: number };
type Feed = { deletions: Deletion[]; nextCursor: string; more: boolean };

test('a session deleted here, by its owner or by retention, is listed for the reader and deleted at the back-office too', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-deletions-'));
  const project = path.join(home, 'projects', 'project-a');
  const dataDir = path.join(home, '.tars');
  for (const d of [project, dataDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'T', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    provider: 'qwen-code', traces: true, createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));

  // The back-office stand-in: the first per-session delete answers 503 with Retry-After: 1, the next ones 200.
  const requests: Array<{ method?: string; url?: string; auth: boolean; status: number; at: string }> = [];
  let refuseNextDelete = true;
  const backOffice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        requests.push({ method: req.method, url, auth: /^Bearer tbi_/.test(String(req.headers.authorization ?? '')), status, at: new Date().toISOString() });
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url === '/v1/installs') answer(201, { installId: 'inst-1', token: 'tbi_e2e' });
      else if (req.method === 'POST' && url === '/v1/blobs/missing') answer(200, { missing: [] });
      else if (req.method === 'PUT' && url.startsWith('/v1/blobs/')) answer(201, { stored: true });
      else if (req.method === 'PUT' && url.startsWith('/v1/batches/')) answer(200, { missingBlobs: [] });
      else if (req.method === 'DELETE' && url.startsWith('/v1/sessions/')) {
        if (refuseNextDelete) { refuseNextDelete = false; answer(503, { error: 'unavailable' }, { 'Retry-After': '1' }); }
        else answer(200, { deleted: { sessions: 1 }, deletedAt: Date.now(), receipt: 'del_e2e' });
      } else answer(404, { error: 'not_found' });
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    inferenceEndpoints: [{ id: 'ep-000001', name: 'E', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl },
  }, null, 2));

  const port = apiPort(31966);
  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const dist = path.resolve('electron', 'dist');
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/traces`, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const runtime = `${dist}/services/traces-runtime.js`;
  // A session recorded by the app's own store, ended at `endedAt`.
  const record = (a: ElectronApplication, traceId: string, agentName: string, startedAt: number, endedAt: number) => a.evaluate((_e, o) => {
    const store = process.mainModule!.require(o.runtime).traceStore();
    store.openTrace({ traceId: o.traceId, projectPath: o.project, agentId: o.agent, agentName: o.agentName, harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'E', model: 'open-coder-1', startedAt: o.startedAt });
    const body = (v: unknown) => Buffer.from(JSON.stringify(v));
    store.ingest({ traceId: o.traceId, agentId: o.agent, surface: 'openai_chat', startedAt: o.startedAt, endedAt: o.startedAt + 100, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${o.traceId}` }], tools: [{ type: 'function', function: { name: 'bash' } }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0 });
    store.endTrace(o.traceId, o.endedAt);
  }, { runtime, traceId, agentName, startedAt, endedAt, project, agent: AGENT });
  const pass = (a: ElectronApplication) => a.evaluate((_e, r) => process.mainModule!.require(r).traceUploader().runOnce(), runtime) as Promise<{ sent: number; failed: number; skipped?: string }>;
  const sweep = (a: ElectronApplication) => a.evaluate((_e, r) => { process.mainModule!.require(r).sweepTraces(); }, runtime);
  const feed = async (token: string | null, cursor?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/traces/deletions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) as Feed | null };
  };
  const deletesAsked = (from = 0) => requests.slice(from).filter(r => r.method === 'DELETE' && r.url?.startsWith('/v1/sessions/'));
  const opened = async (a: ElectronApplication): Promise<Page> => {
    const page = await a.firstWindow();
    listenForErrors(page, errors);
    await page.waitForLoadState('domcontentloaded');
    return page;
  };

  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    let page = await opened(app);
    const call = <T>(name: string, arg?: unknown) => page.evaluate(([n, x]) => (window as unknown as { electronAPI: { traces: Record<string, (v?: unknown) => Promise<unknown>> } }).electronAPI.traces[n as string](x), [name, arg] as const) as Promise<T>;
    expect(await call<{ ok: boolean }>('giveUploadConsent'), 'the consent to upload').toMatchObject({ ok: true });
    const token = String((await call<{ token?: string }>('rotateReaderToken')).token);
    const now = Date.now();
    await record(app, 'del-user', 'Deleted by its owner', now - 3 * 60_000, now - 2 * 60_000);
    await record(app, 'del-expired', 'Past its days', now - 41 * DAY, now - 40 * DAY);
    await record(app, 'kept', 'Kept', now - 5 * 60_000, now - 4 * 60_000);
    const sent = await pass(app);
    expect(sent, JSON.stringify(sent)).toMatchObject({ sent: 3, failed: 0 });
    await record(app, 'local-only', 'Never sent', now - 60_000, now - 30_000);

    // 1. The owner deletes two sessions in the Traces page, one sent and one never sent.
    await page.goto(`${DEV_URL}/traces`, { waitUntil: 'domcontentloaded' });
    for (const id of ['del-user', 'local-only']) {
      const row = page.locator(`[data-trace-session="${id}"]`);
      await row.click({ timeout: 30_000 });
      await row.getByRole('button', { name: 'delete', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Delete this session?' });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(row, `${id} gone from the page`).toHaveCount(0, { timeout: 15_000 });
    }
    await stepShot(page, '01-deleted-in-the-page');
    // 2. The hourly sweep, run now: retention takes the session ended 40 days ago.
    await sweep(app);

    // 3. The reader's feed, and the credentials that are not the reader's.
    const sharedToken = fs.readFileSync(path.join(home, '.tars-private', 'api-token'), 'utf8').trim();
    const first = await feed(token);
    const shared = await feed(sharedToken);
    const none = await feed(null);
    const again = await feed(token, first.body?.nextCursor);
    keep({ feedFirst: first, feedShared: shared.status, feedNone: none.status, feedAgain: again });
    expect(first.status, 'the reader reads the deletions').toBe(200);
    const listed = (first.body?.deletions ?? []).map(d => `${d.sessionId}:${d.reason}`).sort();
    expect(listed, 'the deletions listed, with their reasons').toEqual(['del-expired:retention', 'del-user:user', 'local-only:user']);
    for (const d of first.body?.deletions ?? []) expect.soft(Object.keys(d).sort(), 'a deletion carries its id, reason and time only').toEqual(['at', 'reason', 'sessionId']);
    expect.soft(shared.status, 'the shared token reads no deletion').toBe(401);
    expect.soft(none.status, 'no token reads no deletion').toBe(401);
    expect.soft(again.body?.deletions, 'read again from its cursor: nothing twice').toEqual([]);

    // 5 and 6. The pass: the refused delete stays owed, and Tars is quit with it owed.
    const beforeRefused = requests.length;
    const refused = await pass(app);
    keep({ passRefused: refused, askedRefused: deletesAsked(beforeRefused) });
    expect.soft(deletesAsked(beforeRefused).map(r => r.status), 'one delete asked, refused').toEqual([503]);
    await app.close();
    app = null;

    // The restart's own pass (traces-runtime.ts, at start) may send them before the spec's: counted from before it.
    const beforeRestart = requests.length;
    app = await launch();
    page = await opened(app);
    const afterRestart = await pass(app);
    for (const end = Date.now() + 20_000; deletesAsked(beforeRestart).length < 2 && Date.now() < end;) await new Promise(r => setTimeout(r, 250));
    const asked = deletesAsked(beforeRestart);
    const once = await pass(app);
    const feedAfterRestart = await feed(token, first.body?.nextCursor);
    keep({ passAfterRestart: afterRestart, askedAfterRestart: asked, passOnce: once, askedOnce: deletesAsked(beforeRestart).length, feedAfterRestart });
    await page.goto(`${DEV_URL}/traces`, { waitUntil: 'domcontentloaded' });
    await stepShot(page, '02-after-restart');
    const deletedThere = asked.map(r => decodeURIComponent(String(r.url).slice('/v1/sessions/'.length))).sort();
    expect(deletedThere, 'the sessions sent and deleted here are deleted at the back-office, and only those').toEqual(['del-expired', 'del-user']);
    expect.soft(asked.every(r => r.auth && r.status === 200), "each with the install's token, taken").toBe(true);
    expect.soft(deletesAsked(beforeRestart).length, 'a delete the back-office took is not asked again').toBe(2);
    expect.soft(feedAfterRestart.body?.deletions, 'the cursor read before the restart: nothing twice').toEqual([]);
    expect.soft(requests.some(r => r.url?.includes('local-only') || r.url?.includes('/v1/sessions/kept')), 'a session never sent, or kept, asked for').toBe(false);
    keep({ errors });
    expect(errors, 'uncaught errors in the page').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    await removeHome(home);
  }
});
