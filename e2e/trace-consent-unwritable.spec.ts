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
