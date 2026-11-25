import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The traces window's states (#599 on #596), each where the owner meets it: what main could not do, said beside the
 * control that asked it, in main's own words, and gone once main has done it. QA's single pass for both PRs (t-dc5ca0d1).
 *
 * Main's sentences are never typed here. They are read from main while the spec runs: the answer of the same call asked
 * again on the same folder (a refusal changes nothing, so it answers the same), the upload state's `unsaved` and
 * `unsavedKind`, the notice's `onlyAfter`, or the answer main's own handler gives an endpoint it does not hold. The
 * window's own fixed words (the deletion taken at a start, "consent given") are read from its source file. What the spec
 * types itself is the error it makes a handler throw (ENOSPC), and the reason the window gives for it.
 *
 * How it can fail, written before it ran (QA, 25/11):
 * a. A preview main could not build is not said in the preview's dialog, or Try again does not build it.
 * b. A notice main could not read is not said under the consent's state, the notice opens anyway, or the line stays
 *    once the notice is read.
 * c. After two deletions the notice says the first one's moment (onlyAfter read before the change).
 * d. A consent main could not write is answered as given, or its refusal is not said, word for word, on the
 *    back-office's error line ([data-backoffice-error]).
 * e. A change main holds but could not write is not said on the upload view ([data-upload-unsaved]), or the line
 *    stays once main has written it.
 * f. An endpoint main refuses to remove for a reason of its own is not said in its notice, or the plain question
 *    comes back ([data-endpoint-remove-refused]).
 * g. A grant main could not write (traces turned on for an endpoint) is not said under its row
 *    ([data-endpoint-row-error]), or reads as a revoke held.
 * h. After a deletion the upload says the sessions sent before it ([data-upload-status], SENT "0 since the deletion"),
 *    or still says "0 since the deletion" once a session went after it.
 * i. A deletion Tars took at a start is not said as such after a restart ([data-deletion-owed-why]), or one the user
 *    asked in the view is said as taken at a start.
 * j. Given up, a deletion taken at a start is not said under the upload line ([data-deletion-by-start]), or a
 *    deletion asked in the view is said as taken at a start.
 * k. A removal of sessions main refuses (traces:remove throwing) is not said in the dialog that asked it, in each of
 *    the three: the sessions list, one session, the storage ([data-remove-refused]); or the dialog closes.
 * l. A reader token main could not make or revoke is not said in its dialog, in main's sentence when main answered
 *    and as a failed call when the call itself failed ([data-token-refused]).
 * m. A back-office address main refuses, or a save whose call fails, is not said on its line ([data-backoffice-error]).
 * n. A revoke main holds but could not write is not said beside the control that asked it, in main's words, until
 *    main writes it: a project's switch, a pair removed, closed models left out, traces turned off for each of two
 *    endpoints (one note under each row), an endpoint removed.
 * o. The consent line says main's note ([data-consent-line="held"]) for a note other than 'consent-held'
 *    ('revoke-comes-back', 'owed'), does not say it for 'consent-held', or does not say the consent is given again
 *    once main has written the revoke.
 * And an uncaught error, or a console error, in the page.
 * The artefact: values.json (each step's values as asserted, main's words as read), a screenshot per step, the
 * back-office stand-in's request log. Reproduce: `npx playwright test e2e/traces-window-states.spec.ts --retries=0`.
 */

const onWindows = process.platform === 'win32';
const POSIX = 'the private folder is made unwritable with POSIX permissions';
/** A step that needs POSIX permissions, passed on Windows and said so in the report (the test's other steps still run). */
const posixOnly = (step: string) => {
  if (!onWindows) return false;
  test.info().annotations.push({ type: 'skipped step', description: `${step}: ${POSIX}` });
  return true;
};
const dist = path.resolve('electron', 'dist');
const AGENT = 'eeee5555-0000-4000-8000-0000000000e1';
const GIB = 1024 ** 3;
/** The reason the window gives for the ENOSPC the spec makes a handler throw ("ENOSPC: no space left on device, write"). */
const FULL = 'no space left on device';
const ENDPOINT = { id: 'ep-000001', name: 'E', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] };

/** The window's own fixed words, read from its source rather than typed again here. */
const uploadViewSource = fs.readFileSync(path.resolve('src', 'components', 'Traces', 'UploadView.tsx'), 'utf8');
const TAKEN_AT_START = /const TAKEN_AT_START = '([^']+)';/.exec(uploadViewSource)?.[1] ?? '';
const CONSENT_GIVEN = /word: `(consent given) \$\{dayClockOf/.exec(uploadViewSource)?.[1] ?? '';

/** The window's day and minute (src/lib/traces-format.ts dayClockOf): dd/mm hh:mm, in this machine's time zone. */
const dayClock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** Main's reason with its closing stop taken off, as the window ends it with one stop of its own (clauseOf). */
const clause = (s: string) => s.trim().replace(/[.\s]+$/, '');

type UnsavedKind = 'consent-held' | 'revoke-comes-back' | 'owed';
type UploadState = { unsaved?: string; unsavedKind?: UnsavedKind; consentAt?: string; deletionOwed?: boolean; deletionBy?: 'you' | 'start'; registered?: boolean; sentSessions?: number; lastUploadAt?: number };
type Settings = { uploadUrl?: string; uploadConsentAt?: string; uploadDeletedAt?: number; uploadDeletionBy?: string; projects?: string[]; excludeClosedModels?: boolean };
type Answer = { ok?: boolean; error?: string; unsaved?: string; token?: string; at?: string };
type EndpointView = { id: string; name: string; baseUrl: string; allowTraces: boolean; holdMaxSeconds?: number; sendSessionHeaders?: boolean; allowPlainHttp?: boolean };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

/** A window call, as the page makes it. */
const call = <T>(page: Page, group: string, name: string, ...args: unknown[]) =>
  page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;
const upload = (page: Page) => call<UploadState>(page, 'traces', 'uploadState');
const settings = (page: Page) => call<Settings>(page, 'traces', 'settings');

/**
 * Main's own handler for a channel replaced in place (as traces-window.spec.ts 5b and 5e do), then put back:
 * 'throw' fails every call as a full disk does; { answerFor } answers every call with what main's own handler answers
 * those arguments, so the window is handed main's words.
 */
const wrap = (app: ElectronApplication, channel: string, how: 'throw' | 'put back' | { answerFor: unknown[] }) => app.evaluate(({ ipcMain }, { channel, how }) => {
  const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
  const g = globalThis as Record<string, unknown>;
  const kept = (g.__tarsQaStates ??= {}) as Record<string, (...a: unknown[]) => unknown>;
  if (how === 'put back') {
    if (kept[channel]) handlers.set(channel, kept[channel]);
    delete kept[channel];
    return null;
  }
  const real = kept[channel] ?? handlers.get(channel);
  if (!real) throw new Error(`no ${channel} handler to wrap`);
  kept[channel] = real;
  if (how === 'throw') {
    handlers.set(channel, () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); });
    return null;
  }
  return Promise.resolve(real({}, ...how.answerFor)).then((answer) => { handlers.set(channel, () => answer); return answer; });
}, { channel, how }) as Promise<unknown>;

/** A session recorded by the app's own store (as trace-consent-unwritable.spec.ts records them). */
const record = (app: ElectronApplication, o: { traceId: string; project: string; startedAt: number }) => app.evaluate((_e, o) => {
  const store = process.mainModule!.require(`${o.dist}/services/traces-runtime.js`).traceStore();
  store.openTrace({ traceId: o.traceId, projectPath: o.project, agentId: o.agent, agentName: 'T', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'E', endpointBaseUrl: 'http://127.0.0.1:9/v1', model: 'open-coder-1', startedAt: o.startedAt });
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  store.ingest({ traceId: o.traceId, agentId: o.agent, surface: 'openai_chat', startedAt: o.startedAt, endedAt: o.startedAt + 100, status: 200, contentType: 'application/json',
    requestBody: body({ model: 'open-coder-1', messages: [{ role: 'user', content: `the task of ${o.traceId}` }] }),
    responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    attempts: 1, heldMs: 0 });
}, { ...o, dist, agent: AGENT });
/** The uploader's pass, run now in place of its 5-minute timer. */
const pass = (app: ElectronApplication) => app.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist) as Promise<{ sent: number; failed: number }>;

/** A back-office stand-in on loopback that takes installs, blobs and batches; its DELETE answers what the spec says. */
async function backOffice() {
  const requests: Array<{ method?: string; url?: string; at: string }> = [];
  let deleteStatus = 503;
  let installs = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    deleteAnswers: (status: number) => { deleteStatus = status; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A sandbox home: two projects (git repositories), the recording agent, and the settings the test names. */
function sandbox(prefix: string, settingsOf: (p: { a: string; b: string }) => Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-${prefix}-`));
  const dataDir = path.join(home, '.tars');
  const a = path.join(home, 'projects', 'project-a');
  const b = path.join(home, 'projects', 'project-b');
  for (const d of [a, b, dataDir]) fs.mkdirSync(d, { recursive: true });
  for (const p of [a, b]) execFileSync('git', ['init', '-q', p]);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'T', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: a, skills: [],
    provider: 'qwen-code', traces: true, createdAt: '2026-11-25T08:00:00.000Z', lastActivity: '2026-11-25T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([a, b]));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ...settingsOf({ a, b }) }, null, 2));
  return { home, a, b, privateDir: path.join(home, '.tars-private') };
}

const launch = (home: string, port: string) => launchSandboxed(electron, home, {
  env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
});
async function windowOf(app: ElectronApplication, errors: string[]): Promise<Page> {
  const page = await app.firstWindow();
  listenForErrors(page, errors);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  return page;
}
async function openUpload(page: Page) {
  await page.goto(`${DEV_URL}/traces?view=upload`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Back-office address'), 'the upload view has read its settings').toBeEnabled({ timeout: 60_000 });
}
async function openEndpoints(page: Page) {
  await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByText('AI & Providers', { exact: true }).first().click({ timeout: 60_000 });
  await page.getByText('Inference endpoints', { exact: true }).first().click({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'add an endpoint', exact: true })).toBeVisible({ timeout: 30_000 });
}
const backOfficeBox = (page: Page) => page.getByRole('region', { name: 'Back-office', exact: true });
const uploadBox = (page: Page) => page.getByRole('region', { name: 'Upload', exact: true });
const deletionBox = (page: Page) => page.getByRole('region', { name: 'Delete everything this Tars sent', exact: true });
const noticeOf = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Upload what I opt in', exact: true }) });
const endpointRow = (page: Page, name: string) => page.locator(`[data-endpoint="${name}"]`);
/** "Delete everything this Tars sent" (or "Delete again" while one is owed), confirmed in its dialog. */
async function deleteInView(page: Page) {
  await deletionBox(page).getByRole('button', { name: /^(Delete everything this Tars sent|Delete again)$/ }).click();
  await page.getByRole('dialog').filter({ hasText: 'Delete everything this Tars sent?' }).getByRole('button', { name: 'Delete everything', exact: true }).click({ timeout: 15_000 });
}

test.beforeAll(() => {
  // The window's fixed words this spec reads from its source: a source that no longer holds them fails here, not later.
  expect(TAKEN_AT_START, 'TAKEN_AT_START read from UploadView.tsx').not.toBe('');
  expect(CONSENT_GIVEN, '"consent given" read from UploadView.tsx').toBe('consent given');
});

test('the upload view says what main could not do where it was asked: a preview not built, the notice not read, a consent and an address not saved', async () => {
  test.setTimeout(5 * 60_000);
  const office = await backOffice();
  const s = sandbox('traces-states-upload', ({ a }) => ({
    inferenceEndpoints: [ENDPOINT],
    traces: { projects: [a], capBytes: GIB, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: office.url },
  }));
  const values: Record<string, unknown> = { uploadUrl: office.url };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  let app: ElectronApplication | null = null;
  try {
    app = await launch(s.home, apiPort(31954));
    const page = await windowOf(app, errors);
    await record(app, { traceId: 'up-1', project: s.a, startedAt: Date.now() - 60_000 });
    await openUpload(page);

    await test.step('a. a preview main could not build is said in its dialog, and Try again builds it', async () => {
      await wrap(app!, 'traces:preview', 'throw');
      await page.getByRole('button', { name: 'Preview a session', exact: true }).first().click();
      const failed = page.getByRole('dialog').filter({ hasText: 'No session previewed' });
      await expect(failed).toContainText(`not previewed: ${FULL}. Try again builds it again.`, { timeout: 15_000 });
      await expect(page.locator('[data-upload-preview]'), 'no document while main could not build it').toHaveCount(0);
      const box = await failed.innerText();
      await stepShot(page, 'a1-preview-not-built');
      await wrap(app!, 'traces:preview', 'put back');
      await failed.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.locator('[data-upload-preview]'), 'Try again builds it').toBeVisible({ timeout: 15_000 });
      await stepShot(page, 'a2-preview-built');
      keep({ a: { box } });
      expect(box, "Electron's or the system's words").not.toMatch(/Error invoking remote method|ENOSPC/);
      await page.getByRole('dialog').filter({ has: page.locator('[data-upload-preview]') }).getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(page.locator('[data-upload-preview]')).toHaveCount(0);
    });

    await test.step('b. a notice main could not read is said under the consent, the notice stays closed, and the next read opens it', async () => {
      await wrap(app!, 'traces:uploadNotice', 'throw');
      await page.getByRole('button', { name: 'What leaves this computer', exact: true }).first().click();
      const line = backOfficeBox(page).getByText(`notice not read: ${FULL}. What leaves this computer reads it again.`, { exact: true });
      await expect(line).toBeVisible({ timeout: 15_000 });
      await expect(noticeOf(page), 'the notice opened without being read').toHaveCount(0);
      await stepShot(page, 'b1-notice-not-read');
      await wrap(app!, 'traces:uploadNotice', 'put back');
      await page.getByRole('button', { name: 'What leaves this computer', exact: true }).first().click();
      await expect(noticeOf(page)).toBeVisible({ timeout: 15_000 });
      await expect(line, 'the line once the notice is read').toHaveCount(0);
      keep({ b: { readAgain: true } });
      await noticeOf(page).getByRole('button', { name: 'Not now', exact: true }).click();
    });

    await test.step('d. a consent main could not write is refused, said in main\'s words, and nothing is given', async () => {
      if (posixOnly('d')) return;
      expect(fs.existsSync(s.privateDir), 'the sandbox has its private folder').toBe(true);
      await page.getByRole('button', { name: 'What leaves this computer', exact: true }).first().click();
      await expect(noticeOf(page)).toBeVisible({ timeout: 15_000 });
      fs.chmodSync(s.privateDir, 0o500);
      let again: Answer;
      try {
        await noticeOf(page).getByRole('button', { name: 'Upload what I opt in', exact: true }).click();
        await expect(page.locator('[data-backoffice-error]')).toBeVisible({ timeout: 15_000 });
        // The same refusal, asked again on the same folder: a refusal changes nothing, so main answers it the same.
        again = await call<Answer>(page, 'traces', 'giveUploadConsent');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
      }
      const said = await page.locator('[data-backoffice-error]').innerText();
      const after = await settings(page);
      await stepShot(page, 'd-consent-unwritable');
      keep({ d: { mainSays: again, said, consentAfter: after.uploadConsentAt ?? null } });
      expect(again.ok, JSON.stringify(again)).toBe(false);
      await expect(page.locator('[data-backoffice-error]'), "main's refusal, word for word").toHaveText(String(again.error));
      expect(after.uploadConsentAt, 'a consent kept').toBeUndefined();
      await expect(noticeOf(page), 'the notice, answered').toHaveCount(0);
      await expect(backOfficeBox(page), 'the consent line').not.toContainText(CONSENT_GIVEN);
    });

    await test.step('m. a back-office address main refuses, and a save whose call fails, are said on the address\'s line', async () => {
      const address = page.getByLabel('Back-office address');
      const publicHttp = 'http://203.0.113.10/traces';
      await address.fill(publicHttp);
      await address.press('Enter');
      // Main's refusal, asked again: it refuses before it changes anything.
      const refusal = await call<Answer>(page, 'traces', 'setSettings', { uploadUrl: publicHttp, uploadAllowPlainHttp: false });
      expect(refusal.ok, JSON.stringify(refusal)).toBe(false);
      await expect(page.locator('[data-backoffice-error]'), "main's refusal, word for word").toHaveText(String(refusal.error), { timeout: 15_000 });
      await stepShot(page, 'm1-address-refused');
      await address.press('Escape');
      await expect(page.locator('[data-backoffice-error]'), 'Escape takes the address back').toHaveCount(0);

      await wrap(app!, 'traces:setSettings', 'throw');
      await address.fill('http://127.0.0.1:9/elsewhere');
      await address.press('Enter');
      await expect(page.locator('[data-backoffice-error]')).toHaveText(`not saved: ${FULL}. Enter tries again, Escape goes back.`, { timeout: 15_000 });
      const kept = await settings(page);
      await stepShot(page, 'm2-save-call-failed');
      await wrap(app!, 'traces:setSettings', 'put back');
      await address.press('Escape');
      keep({ m: { refusal, addressKept: kept.uploadUrl } });
      expect(kept.uploadUrl, 'the address saved by a call that failed').toBe(office.url);
    });

    keep({ errors, backOffice: office.requests });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(office.requests, null, 2));
    await office.close();
    if (fs.existsSync(s.privateDir)) fs.chmodSync(s.privateDir, 0o700);
    await removeHome(s.home);
  }
});

test('a removal main refuses is said in each of the three dialogs that ask it, and a reader token main could not make or revoke in its own', async () => {
  test.setTimeout(5 * 60_000);
  const s = sandbox('traces-states-remove', ({ a }) => ({
    inferenceEndpoints: [ENDPOINT],
    traces: { projects: [a], capBytes: GIB, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }));
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const count = async (page: Page) => (await call<{ totals: { count: number } }>(page, 'traces', 'list', {})).totals.count;
  let app: ElectronApplication | null = null;
  try {
    app = await launch(s.home, apiPort(31956));
    const page = await windowOf(app, errors);
    for (const [i, id] of ['rm-1', 'rm-2', 'rm-3'].entries()) await record(app, { traceId: id, project: s.a, startedAt: Date.now() - (3 - i) * 60_000 });
    await page.goto(`${DEV_URL}/traces`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-trace-session]')).toHaveCount(3, { timeout: 60_000 });

    /** The dialog's own button (its label, as the window says it), clicked with traces:remove throwing. */
    const refusedIn = async (dialog: Locator, shot: string) => {
      const button = dialog.getByRole('button', { name: /^Delete/ }).last();
      const label = (await button.innerText()).trim();
      await button.click();
      await expect(dialog.locator('[data-remove-refused]')).toHaveText(`not deleted: ${FULL}. ${label} tries again.`, { timeout: 15_000 });
      await expect(dialog, 'the dialog stays').toBeVisible();
      await stepShot(page, shot);
      return { label, said: await dialog.locator('[data-remove-refused]').innerText(), sessions: await count(page) };
    };

    await test.step('k1. the sessions list: delete what these show', async () => {
      await wrap(app!, 'traces:remove', 'throw');
      await page.getByRole('button', { name: 'delete what these show', exact: true }).click();
      const seen = await refusedIn(page.getByRole('dialog').filter({ hasText: /Delete \d+ sessions?\?/ }), 'k1-list-refused');
      keep({ k1: seen });
      expect(seen.sessions, 'nothing removed').toBe(3);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    });

    await test.step('k2. one session: its delete, then the same delete once main takes it', async () => {
      await page.locator('[data-trace-session="rm-3"]').click();
      await page.locator('[data-trace-session="rm-3"]').getByRole('button', { name: 'open', exact: true }).click();
      const one = page.getByRole('region', { name: 'Session', exact: true });
      await expect(one).toBeVisible({ timeout: 30_000 });
      await one.getByRole('button', { name: 'delete', exact: true }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Delete this session?' });
      const seen = await refusedIn(dialog, 'k2-session-refused');
      expect(seen.sessions, 'nothing removed').toBe(3);
      await wrap(app!, 'traces:remove', 'put back');
      await dialog.getByRole('button', { name: seen.label, exact: true }).click();
      await expect(one, 'deleted, back to the list').toHaveCount(0, { timeout: 15_000 });
      const left = await count(page);
      keep({ k2: { ...seen, left } });
      expect(left, 'the session deleted once main takes it').toBe(2);
    });

    await test.step('k3. the storage: delete every session', async () => {
      await page.goto(`${DEV_URL}/traces?view=storage`, { waitUntil: 'domcontentloaded' });
      await wrap(app!, 'traces:remove', 'throw');
      await page.getByRole('button', { name: 'delete every session', exact: true }).click({ timeout: 30_000 });
      const seen = await refusedIn(page.getByRole('dialog').filter({ hasText: /Delete \d+ sessions\?/ }), 'k3-storage-refused');
      keep({ k3: seen });
      expect(seen.sessions, 'nothing removed').toBe(2);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      await wrap(app!, 'traces:remove', 'put back');
    });

    await test.step('l. a reader token main could not make or revoke, said in its dialog: main\'s sentence, or the call that failed', async () => {
      if (posixOnly('l')) return;
      const reader = page.getByRole('region', { name: 'Reader access', exact: true });
      const tokenFile = path.join(s.privateDir, 'traces-reader-token');

      // Made on a folder that may not be written: main answers why.
      await reader.getByRole('button', { name: 'Create a reader token', exact: true }).click({ timeout: 30_000 });
      const create = page.getByRole('dialog').filter({ hasText: 'Create a reader token?' });
      fs.chmodSync(s.privateDir, 0o500);
      let made: Answer;
      try {
        await create.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(create.locator('[data-token-refused="answered"]')).toBeVisible({ timeout: 15_000 });
        made = await call<Answer>(page, 'traces', 'rotateReaderToken');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
      }
      expect(made, JSON.stringify(made)).toMatchObject({ ok: false });
      await expect(create.locator('[data-token-refused]'), "main's sentence, once").toHaveText(`${clause(String(made.error))}. Create tries again.`);
      await stepShot(page, 'l1-create-refused');
      await create.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.locator('[data-reader-token]'), 'Create, tried again, makes it').toBeVisible({ timeout: 15_000 });
      await page.getByRole('dialog').filter({ has: page.locator('[data-reader-token]') }).getByRole('button', { name: 'Done', exact: true }).click();

      // Revoked with a file that can be neither removed nor emptied: main applies it, and says it could not save it.
      await reader.getByRole('button', { name: 'revoke', exact: true }).click({ timeout: 15_000 });
      const revoke = page.getByRole('dialog').filter({ hasText: 'Revoke the reader token?' });
      fs.chmodSync(tokenFile, 0o400);
      fs.chmodSync(s.privateDir, 0o500);
      let revoked: Answer;
      try {
        await revoke.getByRole('button', { name: 'Revoke', exact: true }).click();
        await expect(revoke.locator('[data-token-refused="answered"]')).toBeVisible({ timeout: 15_000 });
        revoked = await call<Answer>(page, 'traces', 'revokeReaderToken');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
        fs.chmodSync(tokenFile, 0o600);
      }
      expect(revoked, JSON.stringify(revoked)).toMatchObject({ ok: false });
      await expect(revoke.locator('[data-token-refused]'), "main's sentence").toContainText(clause(String(revoked.error)));
      await expect(revoke.locator('[data-token-refused]')).toContainText('Revoke tries again.');
      const status = await call<{ exists: boolean }>(page, 'traces', 'readerToken');
      await stepShot(page, 'l2-revoke-refused');
      await revoke.getByRole('button', { name: 'Keep it', exact: true }).click();

      // A call that fails on the way to main: said as such, nothing claimed of the token.
      await wrap(app!, 'traces:rotateReaderToken', 'throw');
      await reader.getByRole('button', { name: 'Create a reader token', exact: true }).click({ timeout: 15_000 });
      await create.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(create.locator('[data-token-refused="call"]')).toHaveText(`the call failed: ${FULL}. Create tries again.`, { timeout: 15_000 });
      await stepShot(page, 'l3-create-call-failed');
      await wrap(app!, 'traces:rotateReaderToken', 'put back');
      await create.getByRole('button', { name: 'Cancel', exact: true }).click();
      keep({ l: { made, revoked, tokenAfterRevoke: status } });
      expect(status.exists, 'the revoked token, refused at once').toBe(false);
    });

    keep({ errors });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    if (fs.existsSync(s.privateDir)) fs.chmodSync(s.privateDir, 0o700);
    await removeHome(s.home);
  }
});

test('after two deletions the notice and the upload say the latest one: what may be sent, and nothing sent since', async () => {
  test.setTimeout(5 * 60_000);
  const office = await backOffice();
  // The first deletion, from an earlier run: a day and more ago, asked by the user.
  const first = Date.now() - 26 * 3600_000;
  const s = sandbox('traces-states-two-deletions', ({ a }) => ({
    inferenceEndpoints: [ENDPOINT],
    traces: { projects: [a], capBytes: GIB, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: office.url, uploadDeletedAt: first, uploadDeletionBy: 'you' },
  }));
  const values: Record<string, unknown> = { uploadUrl: office.url, first };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  let app: ElectronApplication | null = null;
  try {
    app = await launch(s.home, apiPort(31958));
    const page = await windowOf(app, errors);
    await openUpload(page);

    await test.step('c1. after the first deletion the notice says its moment', async () => {
      await page.getByRole('button', { name: 'What leaves this computer', exact: true }).first().click();
      await expect(noticeOf(page)).toBeVisible({ timeout: 15_000 });
      const notice = await call<{ onlyAfter?: string }>(page, 'traces', 'uploadNotice');
      await expect(page.locator('[data-only-after]')).toContainText(dayClock(Date.parse(String(notice.onlyAfter))));
      keep({ c1: { onlyAfter: notice.onlyAfter, said: await page.locator('[data-only-after]').innerText() } });
      expect(notice.onlyAfter, "main's moment is the first deletion's").toBe(new Date(first).toISOString());
      await stepShot(page, 'c1-notice-first-deletion');
      await noticeOf(page).getByRole('button', { name: 'Upload what I opt in', exact: true }).click();
      await expect(backOfficeBox(page)).toContainText(CONSENT_GIVEN, { timeout: 15_000 });
    });

    await test.step('h-. a session sent after the first deletion: SENT counts it, never "since the deletion"', async () => {
      await record(app!, { traceId: 'h-1', project: s.a, startedAt: Date.now() - 10_000 });
      const sent = await pass(app!);
      expect(sent, JSON.stringify(sent)).toMatchObject({ sent: 1, failed: 0 });
      await openUpload(page);
      await expect(uploadBox(page)).toContainText(/SENT\s*1\s*sessions/, { timeout: 15_000 });
      await expect(uploadBox(page), 'a deletion said where a session went since').not.toContainText('since the deletion');
      keep({ hMinus: { sent, box: await uploadBox(page).innerText() } });
      await stepShot(page, 'h0-sent-since-first');
    });

    await test.step('c2. after the second deletion the notice says the second moment, never the first', async () => {
      office.deleteAnswers(200);
      await deleteInView(page);
      await expect.poll(async () => (await settings(page)).uploadDeletedAt, { timeout: 30_000, message: 'the second deletion recorded' }).not.toBe(first);
      const second = Number((await settings(page)).uploadDeletedAt);
      await page.getByRole('button', { name: 'What leaves this computer', exact: true }).first().click();
      await expect(noticeOf(page)).toBeVisible({ timeout: 15_000 });
      const notice = await call<{ onlyAfter?: string }>(page, 'traces', 'uploadNotice');
      await expect(page.locator('[data-only-after]')).toContainText(dayClock(second));
      await expect(page.locator('[data-only-after]'), "the first deletion's moment").not.toContainText(dayClock(first));
      keep({ c2: { second, onlyAfter: notice.onlyAfter, said: await page.locator('[data-only-after]').innerText() } });
      expect(notice.onlyAfter, "main's moment is the second deletion's").toBe(new Date(second).toISOString());
      await stepShot(page, 'c2-notice-second-deletion');
      await noticeOf(page).getByRole('button', { name: 'Not now', exact: true }).click();
      values.second = second;
    });

    await test.step('h. nothing sent since the second deletion: SENT says 0 since the deletion, and the line its moment', async () => {
      const second = Number(values.second);
      await expect(uploadBox(page)).toContainText(/SENT\s*0\s*since the deletion/, { timeout: 15_000 });
      await expect(page.locator('[data-upload-status]')).toContainText(dayClock(second));
      const state = await upload(page);
      keep({ h: { state, status: await page.locator('[data-upload-status]').innerText(), box: await uploadBox(page).innerText() } });
      await stepShot(page, 'h1-nothing-sent-since');
    });

    keep({ errors, backOffice: office.requests });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(office.requests, null, 2));
    await office.close();
    await removeHome(s.home);
  }
});

test('a deletion Tars took at a start is said as such after a restart and once given up; one asked in the view never is', async () => {
  test.skip(onWindows, POSIX);
  test.setTimeout(6 * 60_000);
  const office = await backOffice();
  const s = sandbox('traces-states-by-start', ({ a }) => ({
    inferenceEndpoints: [ENDPOINT],
    traces: { projects: [a], capBytes: GIB, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: office.url },
  }));
  const values: Record<string, unknown> = { uploadUrl: office.url };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  let app: ElectronApplication | null = null;
  try {
    app = await launch(s.home, apiPort(31960));
    let page = await windowOf(app, errors);
    expect(await call<Answer>(page, 'traces', 'giveUploadConsent')).toMatchObject({ ok: true });
    await record(app, { traceId: 'i-1', project: s.a, startedAt: Date.now() - 60_000 });
    expect(await pass(app)).toMatchObject({ sent: 1, failed: 0 });
    await openUpload(page);

    await test.step('i-. a deletion asked in the view, refused, on a folder that may not be written: owed, never said as taken at a start', async () => {
      fs.chmodSync(s.privateDir, 0o500);
      try {
        office.deleteAnswers(503);
        await deleteInView(page);
        await expect(deletionBox(page).getByRole('button', { name: 'Give up this deletion', exact: true }), 'owed').toBeVisible({ timeout: 30_000 });
        const state = await upload(page);
        await expect(page.locator('[data-deletion-owed-why]'), 'a deletion asked in the view, said as taken at a start').toHaveCount(0);
        // e, as the owner meets it here: main holds the withdrawal and says it could not write it.
        await expect(page.locator('[data-upload-unsaved]').first()).toHaveText(String(state.unsaved));
        keep({ iMinus: { state } });
        expect(state, 'owed, asked by you').toMatchObject({ deletionOwed: true, deletionBy: 'you' });
        await stepShot(page, 'i0-owed-asked-in-view');
        // Quit before a write holds: the folder stays unwritable until the app has closed.
        await app!.close();
        app = null;
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
      }
    });

    app = await launch(s.home, apiPort(31960));
    page = await windowOf(app, errors);
    await openUpload(page);

    await test.step('i. after the restart the owed deletion is said as taken by Tars at its start', async () => {
      await expect(deletionBox(page).getByRole('button', { name: 'Give up this deletion', exact: true }), 'owed again').toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-deletion-owed-why]')).toHaveText(TAKEN_AT_START);
      await expect(page.locator('[data-deletion-by-start]'), 'the upload line while it is owed').toHaveCount(0);
      const state = await upload(page);
      keep({ i: { state } });
      expect(state, 'owed, taken at the start').toMatchObject({ deletionOwed: true, deletionBy: 'start' });
      await stepShot(page, 'i1-owed-taken-at-start');
    });

    await test.step('j. given up, the deletion taken at the start is said under the upload line', async () => {
      await deletionBox(page).getByRole('button', { name: 'Give up this deletion', exact: true }).click();
      await page.getByRole('dialog').filter({ hasText: 'Give up this deletion?' }).getByRole('button', { name: 'Give up the deletion', exact: true }).click({ timeout: 15_000 });
      await expect(page.locator('[data-deletion-by-start]')).toHaveText(TAKEN_AT_START, { timeout: 15_000 });
      await expect(page.locator('[data-deletion-owed-why]'), 'owed no more').toHaveCount(0);
      await expect(uploadBox(page)).toContainText(/SENT\s*0\s*since the deletion/);
      const state = await upload(page);
      keep({ j: { state } });
      expect(state).toMatchObject({ deletionOwed: false, deletionBy: 'start' });
      await stepShot(page, 'j1-by-start-given-up');
    });

    await test.step('j-. a deletion asked in the view since: never said as taken at a start', async () => {
      expect(await call<Answer>(page, 'traces', 'giveUploadConsent')).toMatchObject({ ok: true });
      await record(app!, { traceId: 'i-2', project: s.a, startedAt: Date.now() + 1_000 });
      const sent = await pass(app!);
      expect(sent, JSON.stringify(sent)).toMatchObject({ sent: 1, failed: 0 });
      office.deleteAnswers(200);
      await openUpload(page);
      await deleteInView(page);
      await expect.poll(async () => (await upload(page)).deletionBy, { timeout: 30_000, message: 'the deletion asked in the view' }).toBe('you');
      await expect(uploadBox(page)).toContainText(/SENT\s*0\s*since the deletion/, { timeout: 15_000 });
      await expect(page.locator('[data-deletion-by-start]'), 'a deletion asked in the view, said as taken at a start').toHaveCount(0);
      keep({ jMinus: { sent, state: await upload(page) } });
      await stepShot(page, 'j2-asked-in-view');
    });

    keep({ errors, backOffice: office.requests });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(office.requests, null, 2));
    await office.close();
    if (fs.existsSync(s.privateDir)) fs.chmodSync(s.privateDir, 0o700);
    await removeHome(s.home);
  }
});

test('a revoke main holds but could not write is said beside the control that asked it until main writes it, and the consent line says main\'s note for a held consent only', async () => {
  test.skip(onWindows, POSIX);
  test.setTimeout(10 * 60_000);
  const office = await backOffice();
  const at = (name: string, allowTraces: boolean, n: number) => ({ id: `ep-00000${n}`, name, baseUrl: 'http://127.0.0.1:9/v1', allowTraces, approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] });
  const s = sandbox('traces-states-revokes', ({ a, b }) => ({
    inferenceEndpoints: [at('Alpha', true, 2), at('Beta', true, 3), at('Gamma', false, 4), at('Delta', true, 5)],
    traces: {
      projects: [a, b], capBytes: GIB, retentionDays: 30, excludeClosedModels: false, uploadUrl: office.url,
      pairs: [{ harness: 'qwen-code', models: '*' }, { harness: 'pi', models: '*' }, { harness: 'codex', models: '*' }],
    },
  }));
  const consentFile = path.join(s.privateDir, 'traces-upload-consent');
  const values: Record<string, unknown> = { uploadUrl: office.url };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const written = (page: Page) => expect.poll(async () => (await upload(page)).unsaved ?? null, { timeout: 90_000, intervals: [1_000], message: "main's next try writes it" }).toBeNull();
  let app: ElectronApplication | null = null;
  try {
    app = await launch(s.home, apiPort(31962));
    const page = await windowOf(app, errors);
    await openUpload(page);
    const kinds: Record<string, string | undefined> = {};

    await test.step('o owed, e. no consent: a revoke not written is said on the upload view, never on the consent line, and goes once written', async () => {
      fs.chmodSync(s.privateDir, 0o500);
      let answer: Answer;
      let state: UploadState;
      try {
        answer = await call<Answer>(page, 'traces', 'setSettings', { projects: [s.a] });
        state = await upload(page);
        await expect(page.locator('[data-upload-unsaved]').first()).toHaveText(String(state.unsaved), { timeout: 15_000 });
        await expect(page.locator('[data-upload-unsaved]'), 'beside the consent and the deletion').toHaveCount(2);
        await expect(page.locator('[data-consent-line="held"]'), "main's note on the consent line, for 'owed'").toHaveCount(0);
        await stepShot(page, 'o1-owed');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
      }
      kinds.owed = state.unsaved;
      keep({ owed: { answer, state } });
      expect(state.unsavedKind).toBe('owed');
      expect(answer.unsaved, 'the answer and the upload state say the same words').toBe(state.unsaved);
      await written(page);
      await expect(page.locator('[data-upload-unsaved]'), 'the line once main wrote it').toHaveCount(0, { timeout: 15_000 });
      await stepShot(page, 'e-written');
    });

    await test.step('o revoke-comes-back. a consent whose file stays: the note is said, the consent line still says the consent', async () => {
      expect(await call<Answer>(page, 'traces', 'giveUploadConsent')).toMatchObject({ ok: true });
      await openUpload(page);
      await expect(backOfficeBox(page)).toContainText(CONSENT_GIVEN, { timeout: 15_000 });
      fs.chmodSync(consentFile, 0o400);
      fs.chmodSync(s.privateDir, 0o500);
      let state: UploadState;
      try {
        await call<Answer>(page, 'traces', 'removePair', { harness: 'pi', models: '*' });
        state = await upload(page);
        await expect(page.locator('[data-upload-unsaved]').first()).toHaveText(String(state.unsaved), { timeout: 15_000 });
        await expect(page.locator('[data-consent-line="held"]'), "main's note on the consent line, for 'revoke-comes-back'").toHaveCount(0);
        await expect(backOfficeBox(page), 'the consent the file still holds').toContainText(CONSENT_GIVEN);
        await stepShot(page, 'o2-revoke-comes-back');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
        fs.chmodSync(consentFile, 0o600);
      }
      kinds.revokeComesBack = state.unsaved;
      keep({ revokeComesBack: { state } });
      expect(state.unsavedKind).toBe('revoke-comes-back');
      await written(page);
      await expect(page.locator('[data-upload-unsaved]')).toHaveCount(0, { timeout: 15_000 });
    });

    await test.step('f. an endpoint main refuses to remove for a reason of its own: its words in the notice, never the question again', async () => {
      await openEndpoints(page);
      const answer = await wrap(app!, 'endpoints:remove', { answerFor: ['ep-not-held'] }) as Answer;
      const gamma = endpointRow(page, 'Gamma');
      await gamma.getByRole('button', { name: 'remove', exact: true }).first().click();
      await gamma.locator('[data-endpoint-notice]').getByRole('button', { name: 'remove', exact: true }).click();
      await expect(gamma.locator('[data-endpoint-remove-refused]')).toHaveText(`Not removed: ${clause(String(answer.error))}.`, { timeout: 15_000 });
      await expect(gamma.locator('[data-endpoint-notice] p'), 'the refusal alone, not the question').toHaveCount(1);
      await stepShot(page, 'f-remove-refused');
      await wrap(app!, 'endpoints:remove', 'put back');
      await gamma.locator('[data-endpoint-notice]').getByRole('button', { name: 'keep it', exact: true }).click();
      keep({ f: { answer } });
      expect(answer.ok, JSON.stringify(answer)).toBe(false);
      await expect(gamma, 'still listed').toHaveCount(1);
    });

    await test.step('n, o consent-held, g. a consent standing: each revoke says main\'s note beside its control, the consent line says it, a grant is refused under its row', async () => {
      expect((await upload(page)).consentAt, 'a consent stands').toBeTruthy();
      const notes: Record<string, string> = {};
      fs.chmodSync(s.privateDir, 0o500);
      try {
        // n1. A project's switch, in its Projects panel.
        await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: 'project-a', exact: true }).first()
          .locator('xpath=ancestor::div[.//button][1]').getByRole('button', { name: 'open', exact: true }).click({ timeout: 30_000 });
        const panel = page.locator('[data-project-traces]');
        await panel.getByRole('switch', { name: 'Record traces for this project', exact: true }).click({ timeout: 30_000 });
        // The click returns before main has answered it: wait for main's note, then read it.
        await expect.poll(async () => (await upload(page)).unsavedKind ?? null, { timeout: 15_000, message: 'a revoke under a standing consent' }).toBe('consent-held');
        let state = await upload(page);
        await expect(page.locator('[data-project-traces-unsaved]')).toHaveText(String(state.unsaved), { timeout: 15_000 });
        await expect(panel.getByRole('switch', { name: 'Record traces for this project', exact: true }), 'the switch as main holds it').toHaveAttribute('aria-checked', 'false');
        notes.project = await page.locator('[data-project-traces-unsaved]').innerText();
        await stepShot(page, 'n1-project-switch');

        // o. The consent line says main's note, once, and never "consent given" while the consent is held back.
        await openUpload(page);
        await expect(page.locator('[data-consent-line="held"]')).toHaveText(String(state.unsaved), { timeout: 15_000 });
        await expect(backOfficeBox(page), 'consent given, while main holds it back').not.toContainText(CONSENT_GIVEN);
        await expect(page.locator('[data-upload-unsaved]'), 'said once in the consent card, and beside the deletion').toHaveCount(1);
        await stepShot(page, 'o3-consent-held');
        kinds.consentHeld = state.unsaved;

        // n2. A pair removed.
        await page.goto(`${DEV_URL}/traces?view=pairs`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-trace-pair]').filter({ hasText: 'qwen-code' }).getByRole('button', { name: 'remove', exact: true }).click({ timeout: 30_000 });
        state = await upload(page);
        await expect(page.locator('[data-pairs-unsaved]')).toHaveText(String(state.unsaved), { timeout: 15_000 });
        notes.pair = await page.locator('[data-pairs-unsaved]').innerText();
        await stepShot(page, 'n2-pair-removed');

        // n3 to n5, and g, in Settings: closed models left out, traces off for two endpoints, one removed, one granted.
        await openEndpoints(page);
        const closed = page.getByRole('switch', { name: 'Never record closed models', exact: true });
        await expect(closed).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
        await closed.click();
        state = await upload(page);
        await expect(page.locator('[data-closed-models-unsaved]')).toHaveText(String(state.unsaved), { timeout: 15_000 });
        await expect(closed, 'the switch as main holds it').toHaveAttribute('aria-checked', 'true');

        for (const name of ['Alpha', 'Beta']) {
          await endpointRow(page, name).getByRole('switch', { name: `${name} allows traces`, exact: true }).click();
          state = await upload(page);
          await expect(endpointRow(page, name).locator('[data-endpoint-unsaved]'), `${name}'s note under its row`).toHaveText(String(state.unsaved), { timeout: 15_000 });
        }
        await expect(endpointRow(page, 'Alpha').locator('[data-endpoint-unsaved]'), "Alpha's note, once Beta's came").toHaveCount(1);
        await expect(page.locator('[data-endpoint-unsaved]'), 'one note under each of the two rows').toHaveCount(2);

        // g. A grant (traces turned on for Gamma) is written first: on this folder main refuses it, under its row.
        const gammaView = (await call<EndpointView[]>(page, 'endpoints', 'list')).find(e => e.name === 'Gamma')!;
        await endpointRow(page, 'Gamma').getByRole('switch', { name: 'Gamma allows traces', exact: true }).click();
        await expect(endpointRow(page, 'Gamma').locator('[data-endpoint-row-error]')).toBeVisible({ timeout: 15_000 });
        const granted = await call<Answer>(page, 'endpoints', 'save', {
          id: gammaView.id, name: gammaView.name, baseUrl: gammaView.baseUrl, allowTraces: true,
          holdMaxSeconds: gammaView.holdMaxSeconds, sendSessionHeaders: gammaView.sendSessionHeaders, allowPlainHttp: gammaView.allowPlainHttp,
        });
        expect(granted, JSON.stringify(granted)).toMatchObject({ ok: false });
        await expect(endpointRow(page, 'Gamma').locator('[data-endpoint-row-error]'), "main's refusal, word for word").toHaveText(String(granted.error));
        await expect(endpointRow(page, 'Gamma').locator('[data-endpoint-unsaved]'), 'a grant refused, said as a revoke held').toHaveCount(0);
        await expect(endpointRow(page, 'Gamma').getByRole('switch', { name: 'Gamma allows traces', exact: true }), 'not granted').toHaveAttribute('aria-checked', 'false');
        notes.granted = String(granted.error);

        // n5. An endpoint removed: its row is gone, main's note goes above the list.
        const delta = endpointRow(page, 'Delta');
        await delta.getByRole('button', { name: 'remove', exact: true }).first().click();
        await delta.locator('[data-endpoint-notice]').getByRole('button', { name: 'remove', exact: true }).click();
        await expect(delta, 'removed at once').toHaveCount(0, { timeout: 15_000 });
        state = await upload(page);
        await expect(page.locator('[data-endpoint-remove-unsaved]')).toHaveText(String(state.unsaved), { timeout: 15_000 });
        notes.endpoints = await page.locator('[data-endpoint-unsaved]').first().innerText();
        await stepShot(page, 'n3-settings-notes');
      } finally {
        fs.chmodSync(s.privateDir, 0o700);
      }

      // Written on main's next try: every note goes, and the consent is given again.
      await written(page);
      for (const note of ['[data-closed-models-unsaved]', '[data-endpoint-unsaved]', '[data-endpoint-remove-unsaved]']) {
        await expect(page.locator(note), `${note} once main wrote it`).toHaveCount(0, { timeout: 15_000 });
      }
      await stepShot(page, 'n4-settings-written');
      await openUpload(page);
      await expect(page.locator('[data-consent-line="held"]'), 'the held line once main wrote it').toHaveCount(0, { timeout: 15_000 });
      await expect(backOfficeBox(page), 'the consent given again').toContainText(CONSENT_GIVEN, { timeout: 15_000 });
      const after = await upload(page);
      await stepShot(page, 'o4-consent-given-again');
      keep({ notes, kinds, consentAfter: after.consentAt ?? null });
      expect(after.consentAt, 'the consent standing again').toBeTruthy();
      expect(new Set([kinds.owed, kinds.revokeComesBack, kinds.consentHeld]).size, "main's three notes, three sentences").toBe(3);
    });

    keep({ errors, backOffice: office.requests });
    expect(errors).toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(test.info().outputPath('back-office-requests.json'), JSON.stringify(office.requests, null, 2));
    await office.close();
    if (fs.existsSync(consentFile)) fs.chmodSync(consentFile, 0o600);
    if (fs.existsSync(s.privateDir)) fs.chmodSync(s.privateDir, 0o700);
    await removeHome(s.home);
  }
});
