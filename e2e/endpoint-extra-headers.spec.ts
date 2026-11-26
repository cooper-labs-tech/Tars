import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An endpoint's extra headers in the window (#599 on #596's contract, the owner's decision of 26/11), driven by its
 * owner in the real app: Settings, AI & Providers, Inference endpoints. The endpoint is
 * e2e/stand-in-openai-endpoint.mjs on loopback, which logs the headers of every request; Lead, the project's
 * orchestrator, changes the headers over the API with its own token, as its MCP tool does. Frames: `Settings ·
 * Inference endpoints · extra headers` and its light copy. Written by Tars-Frontend, at the orchestrator's request.
 *
 * How it can fail, written before the window's field (26/11):
 * 1. The endpoint's editor has no extra headers: no way to add one, or one added is not saved, or saved but not sent:
 *    the stand-in's next request (the row's check) does not carry it.
 * 2. The field does not say never to put a credential there.
 * 3. A name main refuses (Authorization) is saved, or refused without main's sentence under the field, or the
 *    editor closes as if saved.
 * 4. An agent's change over the API does not show as waiting: the row reads approved, no notice shows the approved
 *    and the new headers, or no answer approves them. Approved, the new ones are not what the next request carries.
 *    4b. (found at be9ec24ad) the waiting row says what a change of headers is not: its key gone with an old address,
 *        or recording stopped for an endpoint whose traces were already off.
 *    (main's explicit approval, #596 at c31811361, the Audit's gap on #599, written before the window's part)
 *    4c. The owner turns traces on for a row whose headers wait: the save approves them, the notice goes, or a
 *        request is sent to the endpoint.
 *    4d. An agent changes them again while the notice shows the last ones: approve goes through on what the owner
 *        never saw, or main's refusal is not said, or the notice keeps the old lists.
 *    4e. Approve on what the notice shows now does not approve it, or the next request does not carry it.
 * 5. Put back the approved ones does not restore them, or leaves the endpoint waiting.
 * 6. An uncaught error in the page.
 * The artefact: values.json (each step's view, the stand-in's requests as seen), step screenshots, the app's log.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000b1';
/** main keeps an endpoint whose id is `ep-` and six hex digits only. */
const EP = 'ep-0e2e5a';
const ENDPOINT = 'Remote host';
type View = { id: string; approved: boolean; allowTraces: boolean; extraHeaders: Record<string, string>; approvedExtraHeaders?: Record<string, string> };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ method?: string; url?: string; headers?: Record<string, string> }>;

test('an endpoint\'s extra headers: added by the owner and sent, a credential\'s name refused in main\'s words, an agent\'s change waiting until approved or put back', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-extra-headers-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const endpointLog = test.info().outputPath('endpoint-requests.jsonl');
  const standin = await startStandIn({ log: endpointLog });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: LEAD, name: 'Lead', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    provider: 'claude', role: 'orchestrator', createdAt: '2026-11-26T08:00:00.000Z', lastActivity: '2026-11-26T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    inferenceEndpoints: [{ id: EP, name: ENDPOINT, baseUrl: standin.baseUrl, allowTraces: false, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30, extraHeaders: {}, approvedExtraHeaders: {} }],
  }, null, 2));

  const port = apiPort(31964);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    const view = async () => ((await page.evaluate(() => ((window as unknown as Api).electronAPI.endpoints.list)())) as View[]).find(v => v.id === EP)!;
    const form = page.locator('[data-endpoint-form]');
    const row = page.locator(`[data-endpoint="${ENDPOINT}"]`);
    // What reached the stand-in with the row's check: its GET /v1/models, the headers it carried.
    const checkedWith = async (name: string) => {
      const before = lines(endpointLog).length;
      await row.getByRole('button', { name: 'check', exact: true }).click();
      await expect.poll(() => lines(endpointLog).length, { timeout: 30_000 }).toBeGreaterThan(before);
      const seen = lines(endpointLog).slice(before).filter(r => r.method === 'GET' && /\/v1\/models$/.test(String(r.url)));
      return seen.map(r => r.headers?.[name.toLowerCase()] ?? null);
    };

    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByText('AI & Providers', { exact: true }).first().click({ timeout: 60_000 });
    await page.getByText('Inference endpoints', { exact: true }).first().click({ timeout: 15_000 });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // 1, 2. The owner opens the endpoint and adds a header; the row counts it, the next request carries it.
    await row.getByRole('button', { name: ENDPOINT, exact: true }).click();
    await expect(form).toBeVisible();
    const warning = await form.locator('[data-extra-headers]').innerText();
    await form.getByRole('button', { name: 'add a header', exact: true }).click();
    await form.getByLabel('Header name').last().fill('X-Route');
    await form.getByLabel('Header value').last().fill('blue-pool');
    await stepShot(page, '1-a-header-added');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });
    await expect(row).toContainText('1 extra header', { timeout: 15_000 });
    const added = await view();
    const sentRoute = await checkedWith('X-Route');
    keep({ warning, added, addedRow: await row.innerText(), sentRoute });
    expect.soft(warning, 'the field says never to put a credential there').toMatch(/Never put a key, a token or a password here/);
    expect.soft(added, 'the header saved, approved').toMatchObject({ approved: true, extraHeaders: { 'X-Route': 'blue-pool' } });
    expect.soft(sentRoute, 'the next request carries it').toContain('blue-pool');

    // 3. A name main refuses: its sentence under the field, nothing saved, the editor left open.
    await row.getByRole('button', { name: ENDPOINT, exact: true }).click();
    await form.getByRole('button', { name: 'add a header', exact: true }).click();
    await form.getByLabel('Header name').last().fill('Authorization');
    await form.getByLabel('Header value').last().fill('see-the-key-field');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const refusal = form.locator('[data-extra-headers-refused]');
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    const refused = { said: await refusal.innerText(), formOpen: await form.count(), view: await view() };
    keep({ refused });
    await stepShot(page, '2-a-credential-refused');
    expect.soft(refused.said, 'main\'s sentence').toBe('Authorization cannot be an extra header: Tars sets the key, the session headers and the connection\'s own headers itself.');
    expect.soft(refused.formOpen, 'the editor left open').toBe(1);
    expect.soft(refused.view.extraHeaders, 'nothing saved').toEqual({ 'X-Route': 'blue-pool' });
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();

    // 4. Lead changes them over the API, with its own token, as its tool does: the row waits for the owner.
    const token = await app.evaluate((_e, { dist, lead }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return tokens.mintRunToken(lead).token as string;
    }, { dist, lead: LEAD });
    const byLead = (extraHeaders: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/endpoints/${EP}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': LEAD },
      body: JSON.stringify({ extraHeaders }),
    }).then(async r => ({ status: r.status, body: await r.json() as { needsApproval?: boolean; error?: string } }));
    const changed = await byLead({ 'X-Route': 'green-pool', 'X-Batch': 'nightly' });
    const notice = row.locator('[data-endpoint-notice]');
    await expect(row).toContainText('new extra headers waiting for your approval', { timeout: 15_000 });
    await expect(notice).toBeVisible();
    const waiting = { notice: await notice.innerText(), view: await view(), row: await row.innerText() };
    keep({ changed, waiting });
    await stepShot(page, '3-waiting-for-approval');
    expect.soft(changed, 'Lead\'s change').toMatchObject({ status: 200, body: { needsApproval: true } });
    expect.soft(waiting.view, 'waiting').toMatchObject({ approved: false, extraHeaders: { 'X-Route': 'green-pool', 'X-Batch': 'nightly' }, approvedExtraHeaders: { 'X-Route': 'blue-pool' } });
    expect.soft(waiting.notice, 'the approved list').toContain('approved   X-Route: blue-pool');
    expect.soft(waiting.notice, 'the new list').toContain('new        X-Route: green-pool · X-Batch: nightly');
    expect.soft(waiting.notice, 'who changed them').toContain('Lead changed its extra headers');
    // Red at be9ec24ad, seen on its screenshot 3: the row said the key went with the old address, and that recording
    // stopped, rules of a moved address and of traces turned off that a change of headers is neither.
    expect.soft(waiting.row, 'the key line: the address did not move').not.toContain('key to set again');
    expect.soft(waiting.row, 'no traces note: traces were already off').not.toContain('Recording stopped');

    // 4c. The owner turns traces on for the row while the headers wait: a save of another field approves nothing.
    const sentBeforeFlip = lines(endpointLog).length;
    await row.getByRole('switch', { name: `${ENDPOINT} allows traces`, exact: true }).click();
    await expect.poll(async () => (await view()).allowTraces, { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(1_500);
    const flipped = { view: await view(), noticeShown: await notice.count(), sentAfterFlip: lines(endpointLog).length - sentBeforeFlip };
    keep({ flipped });
    expect.soft(flipped.view, 'still waiting after the switch').toMatchObject({ approved: false, approvedExtraHeaders: { 'X-Route': 'blue-pool' } });
    expect.soft(flipped.noticeShown, 'the notice still shown').toBe(1);
    expect.soft(flipped.sentAfterFlip, 'nothing sent to the endpoint').toBe(0);

    // 4d. Lead changes them again while the notice shows the last ones: main's word that it changed is held back from
    // the window (its webContents.send wrapped, then put back), so the notice is the one the owner read. Approve is
    // refused in main's sentence, and the notice is read again: the new lists.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('tray-panel'))!;
      const send = win.webContents.send.bind(win.webContents);
      const g = globalThis as Record<string, unknown>;
      g.__qaHeldSend = { win, send };
      win.webContents.send = (channel: string, ...args: unknown[]) => { if (channel !== 'endpoints:changed') send(channel, ...args); };
    });
    const changedAgain = await byLead({ 'X-Route': 'amber-pool', 'X-Batch': 'nightly' });
    const stale = await notice.innerText();
    await notice.getByRole('button', { name: 'approve the new headers', exact: true }).click();
    const refusedAgain = row.locator('[data-endpoint-row-error]');
    await expect(refusedAgain).toContainText('changed since it was shown', { timeout: 15_000 });
    await expect(notice).toContainText('X-Route: amber-pool', { timeout: 15_000 });
    await app.evaluate(() => {
      const held = (globalThis as Record<string, unknown>).__qaHeldSend as { win: { webContents: { send: unknown } }; send: unknown };
      held.win.webContents.send = held.send;
    });
    const changedTwice = { changedAgain, stale, refused: await refusedAgain.innerText(), notice: await notice.innerText(), view: await view() };
    keep({ changedTwice });
    await stepShot(page, '3b-changed-since-shown');
    expect.soft(changedTwice.stale, 'the notice the owner read').toContain('X-Route: green-pool');
    expect.soft(changedTwice.refused, 'main\'s sentence').toMatch(/^The endpoint "Remote host" changed since it was shown \(Lead, [^)]+\): look at it again before you approve\.$/);
    expect.soft(changedTwice.notice, 'the new lists').toContain('new        X-Route: amber-pool · X-Batch: nightly');
    expect.soft(changedTwice.view, 'nothing approved').toMatchObject({ approved: false, approvedExtraHeaders: { 'X-Route': 'blue-pool' } });

    // 4e. Approve what is shown now: approved, and the next request carries it.
    await notice.getByRole('button', { name: 'approve the new headers', exact: true }).click();
    await expect(row).not.toContainText('waiting for your approval', { timeout: 15_000 });
    const approved = await view();
    const sentAfter = await checkedWith('X-Route');
    keep({ approved, sentAfter, rowAfter: await row.innerText() });
    expect.soft(approved, 'approved').toMatchObject({ approved: true, extraHeaders: { 'X-Route': 'amber-pool', 'X-Batch': 'nightly' } });
    expect.soft(sentAfter, 'the next request carries the new ones').toContain('amber-pool');
    expect.soft(await row.innerText(), 'the refusal is gone once approved').not.toContain('changed since it was shown');

    // 5. Lead changes them again; the owner puts back the approved ones.
    const again = await byLead({ 'X-Route': 'red-pool' });
    await expect(row).toContainText('new extra headers waiting for your approval', { timeout: 15_000 });
    await notice.getByRole('button', { name: 'put back the approved ones', exact: true }).click();
    await expect(row).not.toContainText('waiting for your approval', { timeout: 15_000 });
    const putBack = await view();
    keep({ again, putBack, putBackRow: await row.innerText() });
    await stepShot(page, '4-put-back');
    expect.soft(putBack, 'put back').toMatchObject({ approved: true, extraHeaders: { 'X-Route': 'amber-pool', 'X-Batch': 'nightly' } });

    // 6.
    keep({ errors });
    expect(errors).toEqual([]);
  } finally {
    await app?.close().catch(() => {});
    await standin.close();
    await removeHome(home);
  }
});
