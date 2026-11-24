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
 * The artefact: values.json with each answer, the back-office's request log, a screenshot per launch.
 */

type Traces = {
  setSettings(s: { uploadUrl?: string }): Promise<{ ok: boolean; error?: string }>;
  settings(): Promise<{ uploadUrl?: string; uploadConsentAt?: string }>;
  giveUploadConsent(): Promise<{ ok: boolean; error?: string; at?: string }>;
  deleteEverywhere(): Promise<{ ok: boolean; error?: string }>;
  uploadState(): Promise<{ unsaved?: string }>;
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
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl },
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
