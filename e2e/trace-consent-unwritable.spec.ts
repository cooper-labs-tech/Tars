import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A consent to upload traces that main cannot write (the Audit's L2, found reading #599; already in #596).
 *
 * Until this fix the consent was set in memory first and its save caught every error, so on a disk main could not
 * write the window was answered ok, the notice closed on "consent given", and the uploader read the consent for
 * the rest of the run; the next start had none.
 *
 * A sandbox whose back-office address is a stand-in on loopback that records every request. The settings are
 * written through the private folder first (settings-secrets.ts, saveSettingsSplit): the spec takes its write
 * permission away, a real failing save, and gives consent through the window's own channel. Asserted:
 * 1. The answer is ok:false with main's reason (the error's code), the notice's text; the settings in memory hold
 *    no consent.
 * 2. Nothing reaches the back-office.
 * 3. A restart shows no consent, and still nothing reaches the back-office.
 * 4. With the folder writable again, consent is given, ok, and a restart keeps it.
 * The page that shows the notice is #599's; this branch drives its channel, which is what the notice reads.
 *
 * And a withdrawal that never comes back (the second test): consent given, then the private folder made 0500 and
 * "delete everything" asked. The withdrawal holds in memory at once; the settings cannot be saved, so the window is
 * told (uploadState().unsaved) and Tars tries again; with the folder writable again it holds. A restart has no
 * consent, and nothing but the deletion's own DELETE reaches the back-office after it. Until this fix the
 * withdrawal lived in memory only: the restart had the consent again and uploaded at once.
 * And a deletion that survives a quit before its bookkeeping is written (the third test, the Audit's M1 at
 * a3c07fbfa): a back-office stand-in that takes installs, blobs and batches, and answers the DELETE 503 until told
 * otherwise. Consent, an upload pass (pre-1 goes), then pre-2 recorded and still pending; then the private folder
 * made 0500 and "delete everything" asked: the DELETE fails, the settings cannot be written, and Tars is quit before
 * a retry holds. At the next start the deletion is owed again, a consent is refused until the DELETE is asked again
 * and holds, and after a new consent only a session started since is sent: pre-1 and pre-2 never go again. Until this
 * fix the start withdrew the consent and nothing else, so the new consent sent pre-2 and no DELETE was asked again.
 * And two revokes on the 0500 folder (the fourth test, the Audit's L1 and L2 at 1e9571eab). The reader token is
 * revoked: it must open /api/traces/ no more, at once and after a restart. The back-office address is emptied to stop
 * sharing: the consent must go at once, and an upload pass then sends nothing, before and after a restart. Until
 * this fix the revoke threw on the unlink and the old token kept opening the route, and the emptied address left the
 * consent and the old address in memory, where the uploader kept sending.
 * And a project opted out on the 0500 folder (the fifth test): a pass then sends nothing of it, and neither does a
 * pass after a restart. Until this fix the opt-out wrote first, was answered "nothing was changed", and the pass sent
 * that project's session.
 * The artefact: values.json with each answer, the back-office's request log, a screenshot per launch.
 */

type Traces = {
  setSettings(s: { uploadUrl?: string }): Promise<{ ok: boolean; error?: string }>;
  settings(): Promise<{ uploadUrl?: string; uploadConsentAt?: string }>;
  giveUploadConsent(): Promise<{ ok: boolean; error?: string; at?: string }>;
  deleteEverywhere(): Promise<{ ok: boolean; error?: string }>;
  uploadState(): Promise<{ unsaved?: string }>;
  rotateReaderToken(): Promise<{ token?: string; ok?: boolean; error?: string }>;
  revokeReaderToken(): Promise<{ ok: boolean; error?: string }>;
};
const traces = (app: ElectronApplication) => app.firstWindow().then(page => ({
  page,
  call: <T>(name: keyof Traces, arg?: unknown) => page.evaluate(([n, a]) => {
    const api = (window as unknown as { electronAPI: { traces: Record<string, (x?: unknown) => Promise<unknown>> } }).electronAPI.traces;
    return api[n as string](a as never);
  }, [name, arg] as const) as Promise<T>,
}));

test('a consent to upload traces that cannot be written is refused with the reason, kept nowhere, and never uploads', async () => {
  test.skip(process.platform === 'win32', 'the private folder is made unwritable with POSIX permissions');
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-consent-'));
  const privateDir = path.join(home, '.tars-private');
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  const backOffice = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, at: new Date().toISOString() });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"stand-in"}');
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31944), DOROTHY_E2E: '1' },
  });
  const settle = () => new Promise(r => setTimeout(r, 4_000));

  let app: ElectronApplication | null = null;
  try {
    // First run: the address set while the folder is writable, then the consent while it is not.
    app = await launch();
    let w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const address = await w.call<{ ok: boolean; error?: string }>('setSettings', { uploadUrl });
    expect(address, JSON.stringify(address)).toMatchObject({ ok: true });
    expect(fs.existsSync(privateDir), 'the sandbox has its private folder').toBe(true);

    fs.chmodSync(privateDir, 0o500);
    let refused: { ok: boolean; error?: string; at?: string };
    try {
      refused = await w.call('giveUploadConsent');
    } finally {
      fs.chmodSync(privateDir, 0o700);
    }
    const inMemory = await w.call<{ uploadConsentAt?: string }>('settings');
    keep({ refused, inMemoryAfterRefusal: inMemory.uploadConsentAt ?? null });
    expect(refused.ok, JSON.stringify(refused)).toBe(false);
    expect(refused.error).toMatch(/EACCES|EPERM/);
    expect(refused.error).toMatch(/nothing was changed/i);
    expect(inMemory.uploadConsentAt, 'the consent is not held in memory').toBeUndefined();
    await settle();
    await stepShot(w.page, '01-refused');
    await app.close();
    app = null;

    // A restart: no consent, and nothing has reached the back-office.
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const afterRestart = await w.call<{ uploadUrl?: string; uploadConsentAt?: string }>('settings');
    await settle();
    keep({ afterRestart: { uploadUrl: afterRestart.uploadUrl ?? null, uploadConsentAt: afterRestart.uploadConsentAt ?? null }, requestsBeforeConsent: [...requests] });
    expect(afterRestart.uploadUrl).toBe(uploadUrl);
    expect(afterRestart.uploadConsentAt, 'a restart shows no consent').toBeUndefined();
    expect(requests, 'nothing reached the back-office').toEqual([]);

    // Writable again: the consent is given, and a restart keeps it.
    const given = await w.call<{ ok: boolean; at?: string; error?: string }>('giveUploadConsent');
    expect(given, JSON.stringify(given)).toMatchObject({ ok: true });
    await stepShot(w.page, '02-given');
    await app.close();
    app = null;
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const kept = await w.call<{ uploadConsentAt?: string }>('settings');
    keep({ given, keptAfterRestart: kept.uploadConsentAt ?? null });
    expect(kept.uploadConsentAt).toBe(given.at);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    await removeHome(home);
  }
});

test('a withdrawal of the consent that cannot be saved holds at once, is told and tried again, and never comes back at a restart', async () => {
  test.skip(process.platform === 'win32', 'the private folder is made unwritable with POSIX permissions');
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-withdrawal-'));
  const privateDir = path.join(home, '.tars-private');
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  const backOffice = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, at: new Date().toISOString() });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"stand-in"}');
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31946), DOROTHY_E2E: '1' },
  });

  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    let w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    expect(await w.call<{ ok: boolean }>('setSettings', { uploadUrl })).toMatchObject({ ok: true });
    const given = await w.call<{ ok: boolean; at?: string }>('giveUploadConsent');
    expect(given, JSON.stringify(given)).toMatchObject({ ok: true });

    // The withdrawal, with a private folder that may not be written: it holds in memory at once, and the window is told.
    fs.chmodSync(privateDir, 0o500);
    let deleted: { ok: boolean; error?: string };
    let told: { unsaved?: string };
    let inMemory: { uploadConsentAt?: string };
    try {
      const withdrawnAt = new Date().toISOString();
      deleted = await w.call('deleteEverywhere');
      inMemory = await w.call('settings');
      told = await w.call('uploadState');
      keep({ withdrawnAt, deleted, inMemoryAfterWithdrawal: inMemory.uploadConsentAt ?? null, told: told.unsaved ?? null });
    } finally {
      fs.chmodSync(privateDir, 0o700);
    }
    expect(inMemory.uploadConsentAt, 'the withdrawal holds in memory at once').toBeUndefined();
    // Soft: the old build tells nothing, and the restart below is what shows the consent come back.
    expect.soft(told.unsaved, 'the window is told the settings could not be saved').toMatch(/EACCES|EPERM/);
    await stepShot(w.page, '01-withdrawn-unsaved');

    // Writable again: Tars tries again until it holds, and says so.
    await expect.poll(async () => (await w.call<{ unsaved?: string }>('uploadState')).unsaved ?? null, { timeout: 120_000, message: 'the withdrawal was saved on a later try' }).toBeNull();
    const before = requests.length;
    await app.close();
    app = null;

    // A restart: no consent, and nothing but a DELETE reaches the back-office.
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const afterRestart = await w.call<{ uploadConsentAt?: string }>('settings');
    await new Promise(r => setTimeout(r, 6_000));
    const uploads = requests.slice(before).filter(r => r.method !== 'DELETE');
    keep({ afterRestart: afterRestart.uploadConsentAt ?? null, requestsAfterWithdrawal: requests.slice(before) });
    await stepShot(w.page, '02-restarted');
    expect(afterRestart.uploadConsentAt, 'a restart shows no consent').toBeUndefined();
    expect(uploads, 'nothing uploaded after the withdrawal').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    await removeHome(home);
  }
});

test('a deletion whose bookkeeping cannot be written survives a quit: owed again at the next start, and nothing recorded before it is sent', async () => {
  test.skip(process.platform === 'win32', 'the private folder is made unwritable with POSIX permissions');
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-deletion-'));
  const privateDir = path.join(home, '.tars-private');
  const project = path.join(home, 'projects', 'project-a');
  const dataDir = path.join(home, '.tars');
  for (const d of [project, dataDir]) fs.mkdirSync(d, { recursive: true });
  const AGENT = 'eeee5555-0000-4000-8000-0000000000f1';
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'T', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    provider: 'qwen-code', traces: true, createdAt: '2026-11-24T08:00:00.000Z', lastActivity: '2026-11-24T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));

  // A back-office that takes installs, blobs and batches; its DELETE answers 503 until told otherwise.
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  let deleteStatus = 503;
  let installs = 0;
  const backOffice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, at: new Date().toISOString() });
      const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/v1/installs') { installs++; answer(201, { installId: `inst-${installs}`, token: `tbi_${installs}` }); return; }
      if (req.method === 'POST' && url === '/v1/blobs/missing') answer(200, { missing: [] });
      else if (req.method === 'PUT' && url.startsWith('/v1/batches/')) answer(200, { missingBlobs: [] });
      else if (req.method === 'PUT' && url.startsWith('/v1/blobs/')) answer(201, { stored: true });
      else if (req.method === 'DELETE' && url === '/v1/installs/me') answer(deleteStatus, deleteStatus === 200 ? { deleted: { sessions: 1 } } : { error: 'unavailable' });
      else answer(404, { error: 'not_found' });
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  // The endpoint the recorded sessions name: what is sent follows the trace gate as it is at sending (since 25/11).
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    inferenceEndpoints: [{ id: 'ep-000001', name: 'E', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl },
  }, null, 2));

  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const dist = path.resolve('electron', 'dist');
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31948), DOROTHY_E2E: '1' },
  });
  // A session recorded by the app's own store, and the uploader's pass run now (in place of its 5-minute timer).
  const record = (a: ElectronApplication, traceId: string, startedAt: number) => a.evaluate((_e, o) => {
    const store = process.mainModule!.require(`${o.dist}/services/traces-runtime.js`).traceStore();
    store.openTrace({ traceId: o.traceId, projectPath: o.project, agentId: o.agent, agentName: 'T', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'E', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'open-coder-1', startedAt: o.startedAt });
    const body = (v: unknown) => Buffer.from(JSON.stringify(v));
    store.ingest({ traceId: o.traceId, agentId: o.agent, surface: 'openai_chat', startedAt: o.startedAt, endedAt: o.startedAt + 100, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${o.traceId}` }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0 });
  }, { dist, traceId, startedAt, project, agent: AGENT });
  const pass = (a: ElectronApplication) => a.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist) as Promise<{ sent: number; failed: number }>;
  const batchesOf = (from: number, id: string) => requests.slice(from).filter(r => r.method === 'PUT' && r.url?.startsWith(`/v1/batches/${id}.`));

  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    let w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    expect(await w.call<{ ok: boolean }>('giveUploadConsent')).toMatchObject({ ok: true });
    await record(app, 'pre-1', Date.now() - 120_000);
    const first = await pass(app);
    expect(first, JSON.stringify(first)).toMatchObject({ sent: 1, failed: 0 });
    await record(app, 'pre-2', Date.now() - 60_000);

    // "Delete everything" with a private folder that may not be written: the DELETE fails, nothing can be saved,
    // and Tars is quit before a retry holds.
    fs.chmodSync(privateDir, 0o500);
    try {
      const deleted = await w.call<{ ok: boolean; error?: string }>('deleteEverywhere');
      const told = await w.call<{ unsaved?: string; deletionOwed?: boolean }>('uploadState');
      keep({ deletedWhileUnwritable: deleted, toldWhileUnwritable: told });
      expect(deleted.ok, JSON.stringify(deleted)).toBe(false);
      await stepShot(w.page, '01-deleted-unsaved');
      await app.close();
      app = null;
    } finally {
      fs.chmodSync(privateDir, 0o700);
    }

    // The next start: the deletion owed again, a consent refused until it is done.
    const restartedAt = requests.length;
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const state = await w.call<{ deletionOwed?: boolean; consentAt?: string }>('uploadState');
    const refused = await w.call<{ ok: boolean; error?: string }>('giveUploadConsent');
    keep({ stateAfterRestart: state, consentAfterRestart: refused });
    expect.soft(state.deletionOwed, 'the deletion is owed again at the next start').toBe(true);
    expect.soft(refused.ok, 'a consent is refused while the deletion is owed').toBe(false);
    if (!refused.ok) {
      deleteStatus = 200;
      const again = await w.call<{ ok: boolean; error?: string }>('deleteEverywhere');
      const given = await w.call<{ ok: boolean; error?: string }>('giveUploadConsent');
      keep({ deletedAgain: again, consentAfterDelete: given });
      expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
      expect(given, JSON.stringify(given)).toMatchObject({ ok: true });
    }
    await record(app, 'post-1', Date.now() + 1_000);
    const after = await pass(app);
    await stepShot(w.page, '02-restarted');
    keep({ passAfterConsent: after, requestsAfterRestart: requests.slice(restartedAt) });
    expect(batchesOf(restartedAt, 'pre-1'), 'pre-1 is not sent again').toEqual([]);
    expect(batchesOf(restartedAt, 'pre-2'), 'pre-2, recorded before the deletion, is never sent').toEqual([]);
    expect(requests.slice(restartedAt).filter(r => r.method === 'DELETE').length, 'the DELETE is asked again').toBeGreaterThan(0);
    expect(batchesOf(restartedAt, 'post-1').length, 'a session started since is sent').toBeGreaterThan(0);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    await removeHome(home);
  }
});

test('a reader token revoked and an address emptied on a folder that cannot be written: both apply at once and never come back', async () => {
  test.skip(process.platform === 'win32', 'the private folder is made unwritable with POSIX permissions');
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-revokes-'));
  const privateDir = path.join(home, '.tars-private');
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  const backOffice = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, at: new Date().toISOString() });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"stand-in"}');
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  const port = apiPort(31950);
  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const dist = path.resolve('electron', 'dist');
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const read = async (token: string) => (await fetch(`http://127.0.0.1:${port}/api/traces/sessions`, { headers: { Authorization: `Bearer ${token}` } })).status;
  // The uploader's pass run now (in place of its 5-minute timer): with no consent it asks nothing of the back-office.
  const pass = (a: ElectronApplication) => a.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist);
  // An answer, or the error a call threw (the old build threw out of the revoke), kept as the value seen.
  const tried = async <T>(run: () => Promise<T>) => { try { return await run(); } catch (err) { return { threw: String(err) }; } };

  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    let w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    expect(await w.call<{ ok: boolean }>('setSettings', { uploadUrl })).toMatchObject({ ok: true });
    expect(await w.call<{ ok: boolean }>('giveUploadConsent')).toMatchObject({ ok: true });
    const rotated = await w.call<{ token?: string }>('rotateReaderToken');
    const token = String(rotated.token);
    expect(await read(token), 'the new token reads the traces').toBe(200);

    fs.chmodSync(privateDir, 0o500);
    try {
      const revoked = await tried(() => w.call<{ ok: boolean; error?: string }>('revokeReaderToken'));
      const readAfterRevoke = await read(token);
      const emptied = await tried(() => w.call<{ ok: boolean; error?: string }>('setSettings', { uploadUrl: '' }));
      const settingsAfter = await w.call<{ uploadUrl?: string; uploadConsentAt?: string }>('settings');
      const before = requests.length;
      await pass(app);
      keep({ revoked, readAfterRevoke, emptied, consentAfterEmptying: settingsAfter.uploadConsentAt ?? null, requestsAfterEmptying: requests.slice(before) });
      await stepShot(w.page, '01-revoked-and-emptied');
      expect.soft(readAfterRevoke, 'the revoked token opens the traces no more').toBe(401);
      expect.soft(settingsAfter.uploadConsentAt, 'the consent goes with the address').toBeUndefined();
      expect(requests.slice(before), 'nothing is sent after the address was emptied').toEqual([]);
    } finally {
      fs.chmodSync(privateDir, 0o700);
    }
    await app.close();
    app = null;

    // A restart: the token still opens nothing, and nothing is sent.
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const before = requests.length;
    await pass(app);
    const readAfterRestart = await read(token);
    const afterRestart = await w.call<{ uploadConsentAt?: string }>('settings');
    keep({ readAfterRestart, consentAfterRestart: afterRestart.uploadConsentAt ?? null, requestsAfterRestart: requests.slice(before) });
    await stepShot(w.page, '02-restarted');
    expect(readAfterRestart, 'the revoked token opens nothing after a restart').toBe(401);
    expect(afterRestart.uploadConsentAt, 'no consent after a restart').toBeUndefined();
    expect(requests.slice(before), 'nothing is sent after a restart').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    await removeHome(home);
  }
});

test('a project opted out on a folder that cannot be written: nothing of it is sent, before or after a restart', async () => {
  test.skip(process.platform === 'win32', 'the private folder is made unwritable with POSIX permissions');
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trace-optout-'));
  const privateDir = path.join(home, '.tars-private');
  const projectA = path.join(home, 'projects', 'project-a');
  const projectB = path.join(home, 'projects', 'project-b');
  const dataDir = path.join(home, '.tars');
  for (const d of [projectA, projectB, dataDir]) fs.mkdirSync(d, { recursive: true });
  const AGENT = 'eeee5555-0000-4000-8000-0000000000f2';
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'T', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: projectA, skills: [],
    provider: 'qwen-code', traces: true, createdAt: '2026-11-25T08:00:00.000Z', lastActivity: '2026-11-25T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([projectA, projectB]));

  // A back-office that takes installs, blobs and batches.
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  const backOffice = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, at: new Date().toISOString() });
      const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/v1/installs') answer(201, { installId: 'inst-1', token: 'tbi_1' });
      else if (req.method === 'POST' && url === '/v1/blobs/missing') answer(200, { missing: [] });
      else if (req.method === 'PUT' && url.startsWith('/v1/batches/')) answer(200, { missingBlobs: [] });
      else if (req.method === 'PUT' && url.startsWith('/v1/blobs/')) answer(201, { stored: true });
      else answer(404, { error: 'not_found' });
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', resolve));
  const uploadUrl = `http://127.0.0.1:${(backOffice.address() as { port: number }).port}`;
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    inferenceEndpoints: [{ id: 'ep-000001', name: 'E', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] }],
    traces: { projects: [projectA, projectB], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl },
  }, null, 2));

  const values: Record<string, unknown> = { uploadUrl };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const dist = path.resolve('electron', 'dist');
  const launch = () => launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31952), DOROTHY_E2E: '1' },
  });
  const record = (a: ElectronApplication, traceId: string, projectPath: string) => a.evaluate((_e, o) => {
    const store = process.mainModule!.require(`${o.dist}/services/traces-runtime.js`).traceStore();
    const startedAt = Date.now();
    store.openTrace({ traceId: o.traceId, projectPath: o.projectPath, agentId: o.agent, agentName: 'T', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'E', endpointBaseUrl: 'http://127.0.0.1:9/v1', model: 'open-coder-1', startedAt });
    const body = (v: unknown) => Buffer.from(JSON.stringify(v));
    store.ingest({ traceId: o.traceId, agentId: o.agent, surface: 'openai_chat', startedAt, endedAt: startedAt + 100, status: 200, contentType: 'application/json',
      requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${o.traceId}` }] }),
      responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      attempts: 1, heldMs: 0 });
  }, { dist, traceId, projectPath, agent: AGENT });
  const pass = (a: ElectronApplication) => a.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist) as Promise<{ sent: number; failed: number }>;
  const sentOf = (from: number, id: string) => requests.slice(from).filter(r => r.method === 'PUT' && r.url?.startsWith(`/v1/batches/${id}.`));

  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    let w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    expect(await w.call<{ ok: boolean }>('giveUploadConsent')).toMatchObject({ ok: true });
    await record(app, 'a-1', projectA);

    // Project A opted out on a private folder that may not be written, then a pass, then a quit before a write holds.
    fs.chmodSync(privateDir, 0o500);
    const from = requests.length;
    try {
      const optedOut = await w.call<{ ok: boolean; unsaved?: string; error?: string }>('setSettings', { projects: [projectB] });
      const passed = await pass(app);
      keep({ optedOut, passWhileUnsaved: passed, requestsWhileUnsaved: requests.slice(from) });
      await stepShot(w.page, '01-opted-out-unsaved');
      expect.soft(optedOut, 'the opt-out applied, answered with its unsaved note').toMatchObject({ ok: true });
      expect(sentOf(from, 'a-1'), 'nothing of project A is sent after its opt-out').toEqual([]);
      await app.close();
      app = null;
    } finally {
      fs.chmodSync(privateDir, 0o700);
    }

    // The next start: still nothing of project A.
    const restartedAt = requests.length;
    app = await launch();
    w = await traces(app);
    await w.page.waitForLoadState('domcontentloaded');
    const afterRestart = await pass(app);
    const settingsAfter = await w.call<{ uploadConsentAt?: string }>('settings');
    keep({ passAfterRestart: afterRestart, consentAfterRestart: settingsAfter.uploadConsentAt ?? null, requestsAfterRestart: requests.slice(restartedAt) });
    await stepShot(w.page, '02-restarted');
    expect(sentOf(restartedAt, 'a-1'), 'nothing of project A is sent after a restart').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(requests, null, 2));
    await new Promise<void>(resolve => backOffice.close(() => resolve()));
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o700);
    await removeHome(home);
  }
});
