import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The traces window (#599), on #596's native traces, driven by its owner in the real app: Settings, AI & Providers,
 * Inference endpoints, and Traces, Upload. The endpoint is e2e/stand-in-openai-endpoint.mjs on loopback, with a key
 * made for the run; another stand-in plays the address an agent moves the endpoint to. Lead, the project's
 * orchestrator, works through the real mcp-orchestrator with its own token; Worker is a qwen-code agent (the qwen
 * stand-in of e2e/fake-clis.mjs), recorded once the owner put it on the endpoint.
 *
 * How it can fail, written before it ran (QA, 19/11):
 * 1. Settings has no Inference endpoints, or the endpoint added there is not saved approved, its models not read
 *    with its key, or it is not checked.
 * 2. The key comes back to the window: in the form opened again, in the page, or in endpoints.list.
 * 3. Plain http: an endpoint on a private address (loopback) needs the owner's switch; one on a public address is
 *    saved without it; or the row does not say unencrypted.
 * 4. An agent moves the endpoint's address: the row does not say its key is to be set again, the window offers no
 *    approval of the new address, or approving it hands the new address a key.
 * 5. Upload: an address taken without showing what leaves the computer and asking the consent; the preview is not
 *    the scrubbed document (it holds the endpoint's key, a secret the session carried, the sandbox's home, the
 *    endpoint's name or address); a new address keeps the old consent.
 *    5b. (QA's M7, 20/11) the address typed while the view still reads its settings is lost: the field took typing
 *    before them, its Enter was dropped, and the read that came in then wiped it. The spec slows that read by 3 s, as a
 *    loaded machine does, and types only once the field is enabled.
 *    5c. (QA, the Audit's L4 on #599, 23/11) the upload view's plain http switch saves nothing when it is moved: a
 *    public http address main refused stays refused while the switch says it is allowed.
 *    5d. (QA, the Audit's L3 and L5 on #599, 23/11) the deletion's states, with a back-office stand-in that registers
 *    this install and refuses its DELETE (404): the refusal is not said, or the deletion is not kept owed ("Delete
 *    again", "Give up this deletion"); a deletion, a give-up or an acknowledgment that main fails (a full disk: its own
 *    handler wrapped to throw ENOSPC, then put back) is not said in its box in main's own reason ("not deleted: no
 *    space left on device. Nothing was forgotten; try again.", "not acknowledged: no space left on device. OK tries
 *    again."), or says Electron's or the system's words around it (the channel's name, "ENOSPC"), or ends a sentence
 *    twice ("404 not_found.."); or the view does not read main again after it, so a give-up that removed the install,
 *    then failed, is not said as given up ("given up, though Tars could not finish: no space left on device") and
 *    does not come back as the deletion cleared by itself.
 *    5e. (QA, the Audit's L1 on #599, 24/11) a consent main cannot save (its handler wrapped to throw ENOSPC) is not
 *    said in the notice ("not saved: no space left on device. Upload what I opt in tries again."), the notice closes,
 *    a consent is saved, or anything is asked of the back-office before the next click saves it.
 * 6. Never record closed models is not on in a Tars that never set it, or it says nothing of the providers' terms.
 * 7. An uncaught error in the page.
 * Red on #596's head (caefc8874), which has no window: 6 and 1 find no Inference endpoints in Settings.
 * Red on #599 at edd6070bb (the view before M7's fix): 5b, every run (its field is never off, the address is wiped).
 * Red on #599 at 704038b2d (before 03b29c61f), both runs: 5c (nothing saved, the refusal still said) and 5d's three
 * failures (none said, main not read again after the deletion or the acknowledgment, three uncaught rejections).
 * The artefact: values.json (each step's views, the stand-ins' request logs as seen), step screenshots, the app's log.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000a1';
const WORKER = 'eeee5555-0000-4000-8000-0000000000a2';
const ENDPOINT = 'Remote host';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type View = { id: string; name: string; baseUrl: string; keySet: boolean; approved: boolean; approvedBaseUrl?: string; allowPlainHttp?: boolean; allowTraces: boolean; plainHttp: boolean; models: string[] };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ method?: string; url?: string; headers?: Record<string, string> }>;

test('the traces window: an endpoint added with its key never shown back, plain http, a moved address approved, the upload consent and its preview, closed models off by default', async () => {
  test.setTimeout(6 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-traces-window-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const endpointLog = test.info().outputPath('endpoint-requests.jsonl');
  const movedLog = test.info().outputPath('moved-address-requests.jsonl');
  const key = `e2e-window-key-${randomBytes(6).toString('hex')}`;
  const keyAgain = `e2e-window-key-again-${randomBytes(6).toString('hex')}`;
  const secret = `Zq9${randomBytes(5).toString('hex')}Wv7`;
  const standin = await startStandIn({ key, log: endpointLog });
  const moved = await startStandIn({ log: movedLog });
  // The back-office (5d): registers this install, takes what is sent, and refuses the deletion (404).
  const backOfficeLog = test.info().outputPath('back-office-requests.jsonl');
  const backOffice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const route = (req.url ?? '').replace(/^\/traces/, '');
      const [status, body]: [number, unknown] = req.method === 'POST' && route === '/v1/installs'
        ? [201, { installId: 'e2e-install', token: `e2e-install-token-${randomBytes(6).toString('hex')}` }]
        : req.method === 'DELETE' && route === '/v1/installs/me' ? [404, { error: 'not_found' }]
          : req.method === 'POST' && route === '/v1/blobs/missing' ? [200, { missing: [] }]
            : [200, {}];
      fs.appendFileSync(backOfficeLog, `${JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ? 'present' : 'none', bytes: Buffer.concat(chunks).length, status })}\n`);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', () => resolve()));
  const backOfficeUrl = `http://127.0.0.1:${(backOffice.address() as AddressInfo).port}/traces`;

  const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
    agent(WORKER, 'Worker', { provider: 'qwen-code', traces: true, cliPath: fakes['qwen-code'] }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  // The project's opt-in and the pair are set as a user would have set them before (their own views are not this
  // spec's); no endpoint at all: the owner adds it in the window. excludeClosedModels is never set (6).
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }, null, 2));

  const port = apiPort(31942);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;
    const views = () => api<View[]>('endpoints', 'list');

    const openEndpoints = async () => {
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByText('AI & Providers', { exact: true }).first().click({ timeout: 60_000 });
      await page.getByText('Inference endpoints', { exact: true }).first().click({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'add an endpoint', exact: true })).toBeVisible({ timeout: 30_000 });
    };
    const form = page.locator('[data-endpoint-form]');
    const row = (name: string) => page.locator(`[data-endpoint="${name}"]`);

    // 6. Never record closed models: on, as Tars ships, with the providers' terms as its warning.
    await openEndpoints();
    const closed = page.getByRole('switch', { name: 'Never record closed models', exact: true });
    await expect(closed).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    keep({ closedModels: { checked: await closed.getAttribute('aria-checked'), said: await page.locator('[data-closed-models]').innerText() } });
    expect.soft(values.closedModels as { said: string }).toMatchObject({ said: expect.stringMatching(/terms may forbid training/) });
    await stepShot(page, '1-closed-models-on');

    // 1, 3. An endpoint on loopback, plain http with no switch, its key typed once.
    await page.getByRole('button', { name: 'add an endpoint', exact: true }).click();
    await form.getByLabel('Endpoint name').fill(ENDPOINT);
    await form.getByLabel('Base URL').fill(standin.baseUrl);
    await form.getByLabel('Key').fill(key);
    await form.getByRole('switch', { name: 'Allows traces', exact: true }).click();
    const plainOnLoopback = await form.getByRole('switch', { name: 'Allow plain http to this address', exact: true }).getAttribute('aria-checked');
    await stepShot(page, '2-adding-on-loopback');
    await form.getByRole('button', { name: 'Add the endpoint', exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 60_000 });
    await expect(row(ENDPOINT)).toContainText('a key is set · never shown', { timeout: 15_000 });
    await expect(row(ENDPOINT)).toContainText('1 model');
    const added = (await views()).find(v => v.name === ENDPOINT)!;
    keep({ plainOnLoopback, added, addedRow: await row(ENDPOINT).innerText(), endpointSawOnAdd: lines(endpointLog).map(r => ({ method: r.method, url: r.url, keyed: r.headers?.authorization === `Bearer ${key}` })) });
    expect.soft(plainOnLoopback, 'the plain http switch on loopback').toBe('false');
    expect.soft(added, 'the endpoint added').toMatchObject({ approved: true, keySet: true, allowTraces: true, plainHttp: true, allowPlainHttp: false, models: [MODEL_ID] });
    expect.soft(await row(ENDPOINT).innerText(), 'its row').toContain(`${standin.baseUrl} · unencrypted`);
    expect.soft(lines(endpointLog).some(r => r.method === 'GET' && /\/v1\/models$/.test(String(r.url)) && r.headers?.authorization === `Bearer ${key}`), 'its models read with its key').toBe(true);

    // 2. The key, never shown back.
    await row(ENDPOINT).getByRole('button', { name: ENDPOINT, exact: true }).click();
    const keyShown = await form.getByLabel('Key').inputValue();
    const pageHtml = await page.content();
    keep({ keyShown, keyInPage: pageHtml.includes(key), keyInList: JSON.stringify(await views()).includes(key) });
    expect.soft(keyShown, 'the key field of the form opened again').toBe('a key is set · never shown');
    expect.soft(pageHtml.includes(key), 'the key in the page').toBe(false);
    expect.soft(JSON.stringify(await views()).includes(key), 'the key in endpoints.list').toBe(false);
    await stepShot(page, '3-opened-again');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();

    // 3. Plain http to a public address: refused without the owner's switch, taken with it.
    await page.getByRole('button', { name: 'add an endpoint', exact: true }).click();
    await form.getByLabel('Endpoint name').fill('Public plain');
    await form.getByLabel('Base URL').fill('http://203.0.113.10/v1');
    await form.getByRole('button', { name: 'Add the endpoint', exact: true }).click();
    await expect(form.getByText(/A public address takes https/)).toBeVisible({ timeout: 15_000 });
    const refusedWithout = (await views()).some(v => v.name === 'Public plain');
    await form.getByRole('switch', { name: 'Allow plain http to this address', exact: true }).click();
    await expect(form.getByText('allowed by you: unencrypted', { exact: true })).toBeVisible();
    await stepShot(page, '4-public-plain-allowed');
    // The window then reads its models and checks it: an address that answers nothing, 15 s each at most.
    await form.getByRole('button', { name: 'Add the endpoint', exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 90_000 });
    const publicPlain = (await views()).find(v => v.name === 'Public plain');
    keep({ refusedWithout, publicPlain, publicRow: await row('Public plain').innerText() });
    expect.soft(refusedWithout, 'saved without the switch').toBe(false);
    expect.soft(publicPlain, 'saved with it').toMatchObject({ allowPlainHttp: true, plainHttp: true, approved: true });
    expect.soft(await row('Public plain').innerText(), 'its row').toContain('http://203.0.113.10/v1 · unencrypted');

    // A session to preview: the owner puts Worker on the endpoint, Lead sends it a task carrying a secret.
    const moveWorker = await api<{ success: boolean; error?: string }>('agent', 'update', { id: WORKER, endpointId: added.id, model: MODEL_ID });
    keep({ moveWorker });
    expect(moveWorker.success, `Worker on the endpoint: ${moveWorker.error}`).toBe(true);
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
    const lead = async (tool: string, args: Record<string, unknown>) => {
      const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(120_000).then(() => ({ error: `${tool} gave no answer in 120 s` }) as Reply)]);
      return { tool, text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
    };
    await page.evaluate((id) => ((window as unknown as Api).electronAPI.agent.start)({ id, prompt: '' }), WORKER);
    await expect.poll(async () => lines(fakeLog).some((e: Record<string, unknown>) => e.launch && e.agent === WORKER), { timeout: 30_000 }).toBe(true);
    const sent = await lead('send_message', { id: WORKER, message: `Run the probe and report what it printed. The staging password: ${secret}` });
    const done = await lead('wait_for_agent', { id: WORKER, timeoutSeconds: 90 });
    await expect.poll(async () => (await api<{ sessions: unknown[] }>('traces', 'list', {})).sessions.length, { timeout: 30_000 }).toBeGreaterThan(0);
    keep({ sent, done });

    // 5. Upload: an address, what leaves the computer, a session previewed scrubbed, the consent; a new address asks again.
    // 5b: the view's read of its settings slowed by 3 s, as on a loaded machine (main's own handler, wrapped, then put back).
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const read = handlers.get('traces:settings');
      if (!read) throw new Error('no traces:settings handler to slow');
      (globalThis as Record<string, unknown>).__tarsQaTracesSettings = read;
      handlers.set('traces:settings', async (...args: unknown[]) => { await new Promise(r => setTimeout(r, 3_000)); return read(...args); });
    });
    await page.goto(`${DEV_URL}/traces?view=upload`, { waitUntil: 'domcontentloaded' });
    const address = page.getByLabel('Back-office address');
    await expect(address).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('no address: nothing leaves this computer', { exact: true })).toBeVisible();
    await expect(address, 'the address field takes typing only once its settings are read').toBeEnabled({ timeout: 30_000 });
    await address.fill('http://127.0.0.1:9/traces');
    await address.press('Enter');
    const notice = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Upload what I opt in', exact: true }) });
    await expect(notice, 'the address typed is kept and saved, and its consent asked').toBeVisible({ timeout: 15_000 });
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
      handlers.set('traces:settings', (globalThis as Record<string, unknown>).__tarsQaTracesSettings);
    });
    const beforeConsent = await api<{ uploadConsentAt?: string }>('traces', 'settings');
    await stepShot(page, '5-what-leaves');
    await notice.getByRole('button', { name: 'Preview a session', exact: true }).click();
    const previewed = page.locator('[data-upload-preview]');
    await expect(previewed).toBeVisible({ timeout: 15_000 });
    const doc = await previewed.innerText();
    const masked = await page.getByText(/^masked: /).innerText();
    await stepShot(page, '6-preview');
    keep({ beforeConsent, masked, preview: doc.slice(0, 4000) });
    expect.soft(beforeConsent.uploadConsentAt, 'a consent before the notice was answered').toBeUndefined();
    expect.soft(doc, 'the endpoint key in the preview').not.toContain(key);
    expect.soft(doc, 'the secret the session carried').not.toContain(secret);
    expect.soft(doc, 'the sandbox home').not.toContain(home);
    expect.soft(doc, "the endpoint's name").not.toContain(ENDPOINT);
    expect.soft(doc, "the endpoint's address").not.toContain(standin.baseUrl);
    expect.soft(doc, 'what was masked').toContain('<REDACTED:');
    expect.soft(masked, 'the masked line').not.toMatch(/^masked: nothing/);
    await page.getByRole('dialog').filter({ has: previewed }).getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(previewed).toHaveCount(0);
    await notice.getByRole('button', { name: 'Upload what I opt in', exact: true }).click();
    await expect(page.getByText(/^consent given /)).toBeVisible({ timeout: 15_000 });
    const consented = await api<{ uploadConsentAt?: string }>('traces', 'settings');
    await address.fill('http://127.0.0.1:9/elsewhere');
    await address.press('Enter');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    const afterNewAddress = await api<{ uploadConsentAt?: string; uploadUrl?: string }>('traces', 'settings');
    keep({ consented, afterNewAddress });
    expect.soft(typeof consented.uploadConsentAt, 'the consent given').toBe('string');
    expect.soft(afterNewAddress.uploadConsentAt, 'the consent kept for a new address').toBeUndefined();
    await notice.getByRole('button', { name: 'Not now', exact: true }).click();

    // 5c. The plain http switch saves when it is moved: a public http address main refused is taken with the leave.
    type UploadSettings = { uploadUrl?: string; uploadAllowPlainHttp?: boolean; uploadConsentAt?: string; uploadDeletionOwed?: boolean };
    type UploadState = { registered?: boolean; deletionOwed?: boolean; deletionCleared?: boolean };
    const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> => {
      const end = Date.now() + ms;
      let v = await read();
      while (!ok(v) && Date.now() < end) { await sleep(250); v = await read(); }
      return v;
    };
    await address.fill('http://203.0.113.10/traces');
    await address.press('Enter');
    await expect(page.getByText('A public back-office address takes https.', { exact: false })).toBeVisible({ timeout: 15_000 });
    const refusedPublic = await api<UploadSettings>('traces', 'settings');
    await page.getByRole('switch', { name: 'Allow plain http to the back-office', exact: true }).click();
    const leaveSaved = await until(() => api<UploadSettings>('traces', 'settings'), s => s.uploadAllowPlainHttp === true, 15_000);
    await expect.soft(page.getByText('allowed by you: unencrypted', { exact: true }), 'the leave said once saved').toBeVisible({ timeout: 10_000 });
    // The click blurs the field, whose own save (without the leave) is refused first: that refusal must not stay said.
    await expect.soft(page.getByText('A public back-office address takes https.', { exact: false }), 'the refusal once saved').toHaveCount(0, { timeout: 10_000 });
    await stepShot(page, '6b-plain-http-saved');
    keep({ refusedPublic, leaveSaved });
    expect.soft(refusedPublic.uploadUrl, 'the public http address saved without the leave').toBe('http://127.0.0.1:9/elsewhere');
    expect.soft(leaveSaved, 'the switch moved: the address and its leave saved').toMatchObject({ uploadUrl: 'http://203.0.113.10/traces', uploadAllowPlainHttp: true });
    // Saved, it is a new address, whose consent is asked (not given here); a view that saved nothing asks nothing.
    if (await notice.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) await notice.getByRole('button', { name: 'Not now', exact: true }).click();

    // 5d. The deletion, with the back-office stand-in: consent to it, a pass registers this install, the DELETE is refused.
    await address.fill(backOfficeUrl);
    await address.press('Enter');
    await expect(notice, 'the back-office address saved, its consent asked').toBeVisible({ timeout: 15_000 });
    // 5e. A consent main cannot save (a full disk: its handler wrapped to throw ENOSPC, then put back): said in the
    // notice, which stays open, nothing saved and nothing sent; the next click saves it.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const g = globalThis as Record<string, unknown>;
      g.__tarsQaConsent = handlers.get('traces:giveUploadConsent');
      handlers.set('traces:giveUploadConsent', () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); });
    });
    await notice.getByRole('button', { name: 'Upload what I opt in', exact: true }).click();
    await expect.soft(notice, 'a consent main could not save, said in the notice').toContainText('not saved: no space left on device. Upload what I opt in tries again.', { timeout: 15_000 });
    const consentFailed = { open: await notice.isVisible(), box: await notice.innerText().catch(() => ''), settings: await api<UploadSettings>('traces', 'settings'), asked: lines(backOfficeLog).length };
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
      handlers.set('traces:giveUploadConsent', (globalThis as Record<string, unknown>).__tarsQaConsent);
    });
    keep({ consentFailed });
    expect.soft(consentFailed.open, 'the notice stays open').toBe(true);
    expect.soft(consentFailed.settings.uploadConsentAt, 'a consent saved').toBeUndefined();
    expect.soft(consentFailed.asked, 'anything asked of the back-office').toBe(0);
    expect.soft(consentFailed.box, "Electron's or the system's words in the notice").not.toMatch(/Error invoking remote method|ENOSPC|\.\./);
    await stepShot(page, '6c0-consent-failed');
    await notice.getByRole('button', { name: 'Upload what I opt in', exact: true }).click();
    await expect(page.getByText(/^consent given /)).toBeVisible({ timeout: 15_000 });
    // The pass main runs every 5 minutes, run now.
    const pass = await app.evaluate((_e, dist) => process.mainModule!.require(`${dist}/services/traces-runtime.js`).traceUploader().runOnce(), dist);
    const registered = await until(() => api<UploadState>('traces', 'uploadState'), s => s.registered === true, 15_000);
    keep({ pass, registered });
    expect(registered.registered, `this install registered with the back-office stand-in (the pass: ${JSON.stringify(pass)})`).toBe(true);
    const deletion = page.getByRole('region', { name: 'Delete everything this Tars sent', exact: true });
    const cleared = page.getByRole('region', { name: 'Deletion cleared', exact: true });
    const confirmDeletion = async () => {
      const dialog = page.getByRole('dialog').filter({ hasText: 'Delete everything this Tars sent?' });
      await dialog.getByRole('button', { name: 'Delete everything', exact: true }).click({ timeout: 15_000 });
    };
    await deletion.getByRole('button', { name: 'Delete everything this Tars sent', exact: true }).click();
    await confirmDeletion();
    await expect(deletion, 'the refusal said').toContainText('not deleted: The back-office answered 404 not_found', { timeout: 30_000 });
    await expect.soft(deletion, 'the refusal, its sentence ended once').toContainText('not deleted: The back-office answered 404 not_found. Nothing was forgotten; try again.');
    await expect(deletion.getByRole('button', { name: 'Give up this deletion', exact: true }), 'the deletion kept owed').toBeVisible({ timeout: 15_000 });
    const refused = { box: await deletion.innerText(), state: await api<UploadState>('traces', 'uploadState'), settings: await api<UploadSettings>('traces', 'settings'), asked: lines(backOfficeLog) };
    await stepShot(page, '6c-deletion-refused-owed');
    keep({ refused });
    expect.soft(refused.box, 'the owed deletion asked again').toContain('Delete again');
    expect.soft(refused.state, 'main keeps the deletion owed').toMatchObject({ deletionOwed: true });
    expect.soft(refused.settings.uploadConsentAt, 'the consent withdrawn').toBeUndefined();
    expect.soft(refused.asked.filter(r => r.method === 'DELETE').length, 'the DELETE asked of the back-office').toBe(1);

    // Main's own handlers wrapped in place (as 5b), then put back: `traces:settings` counted, to see the view read main
    // again after each failure, and a call main fails as on a full disk.
    const handler = (channel: string, how: 'count' | 'fail' | 'fail-once-the-install-is-removed' | 'put back') => app!.evaluate(({ ipcMain }, { channel, how, dist }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const g = globalThis as Record<string, unknown>;
      const kept = (g.__tarsQaHandlers ??= {}) as Record<string, (...args: unknown[]) => unknown>;
      if (how === 'put back') { if (kept[channel]) handlers.set(channel, kept[channel]); delete kept[channel]; return; }
      const real = kept[channel] ?? handlers.get(channel);
      if (!real) throw new Error(`no ${channel} handler to wrap`);
      kept[channel] = real;
      if (how === 'count') {
        g.__tarsQaReads = 0;
        handlers.set(channel, (...args: unknown[]) => { g.__tarsQaReads = (g.__tarsQaReads as number) + 1; return real(...args); });
        return;
      }
      const full = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      if (how === 'fail') { handlers.set(channel, () => { throw full(); }); return; }
      // Main's give-up removes the install file first, then resets what was sent and the settings: the disk fills there.
      const installFile = process.mainModule!.require(`${dist}/services/traces-runtime.js`).TRACES_INSTALL_FILE as string;
      handlers.set(channel, () => { (process.mainModule!.require('fs') as typeof fs).rmSync(installFile, { force: true }); throw full(); });
    }, { channel, how, dist });
    const reads = () => app!.evaluate(() => (globalThis as Record<string, unknown>).__tarsQaReads as number);
    const readAgain = async (before: number) => (await until(reads, n => n > before, 5_000)) - before;
    await handler('traces:settings', 'count');

    await handler('traces:deleteEverywhere', 'fail');
    let before = await reads();
    await deletion.getByRole('button', { name: 'Delete again', exact: true }).click();
    await confirmDeletion();
    await expect.soft(deletion, 'a deletion main fails, said').toContainText('not deleted: no space left on device. Nothing was forgotten; try again.', { timeout: 15_000 });
    const deleteFailed = { readsAfter: await readAgain(before), box: '' };
    await handler('traces:deleteEverywhere', 'put back');
    await expect.soft(deletion.getByRole('button', { name: 'Give up this deletion', exact: true }), 'still owed, as main has it').toBeVisible();
    deleteFailed.box = await deletion.innerText();
    await stepShot(page, '6d-deletion-failed');

    await handler('traces:abandonDeletion', 'fail-once-the-install-is-removed');
    before = await reads();
    await deletion.getByRole('button', { name: 'Give up this deletion', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: 'Give up this deletion?' }).getByRole('button', { name: 'Give up the deletion', exact: true }).click({ timeout: 15_000 });
    await expect.soft(deletion, 'a give-up main fails once the install is gone, said as given up').toContainText('given up, though Tars could not finish: no space left on device', { timeout: 15_000 });
    const giveUpFailed = { readsAfter: await readAgain(before), box: '' };
    await handler('traces:abandonDeletion', 'put back');
    // What main recorded comes back: the install gone, the owed mark gone with it, so the deletion is given up (said
    // with the reason it could not finish) and said cleared by itself.
    await expect(cleared, 'the deletion cleared, read from main').toBeVisible({ timeout: 30_000 });
    giveUpFailed.box = await deletion.innerText();
    await stepShot(page, '6e-give-up-failed-cleared');

    await handler('traces:ackDeletionCleared', 'fail');
    before = await reads();
    await cleared.getByRole('button', { name: 'OK', exact: true }).click();
    await expect.soft(cleared, 'an acknowledgment main fails, said').toContainText('not acknowledged: no space left on device. OK tries again.', { timeout: 15_000 });
    const ackFailed = { readsAfter: await readAgain(before), box: await cleared.innerText(), state: await api<UploadState>('traces', 'uploadState') };
    await handler('traces:ackDeletionCleared', 'put back');
    await handler('traces:settings', 'put back');
    await stepShot(page, '6f-ack-failed');
    keep({ deleteFailed, giveUpFailed, ackFailed });
    expect.soft(`${refused.box}\n${deleteFailed.box}\n${giveUpFailed.box}\n${ackFailed.box}`, "Electron's or the system's words, or a sentence ended twice")
      .not.toMatch(/Error invoking remote method|ENOSPC|\.\./);
    expect.soft(deleteFailed.readsAfter, 'main read again after the failed deletion').toBeGreaterThan(0);
    expect.soft(giveUpFailed.readsAfter, 'main read again after the failed give-up').toBeGreaterThan(0);
    expect.soft(ackFailed.readsAfter, 'main read again after the failed acknowledgment').toBeGreaterThan(0);
    expect.soft(ackFailed.state, 'main still has the cleared deletion to say').toMatchObject({ deletionCleared: true, deletionOwed: false });
    // OK again, main taking it: the box goes.
    await cleared.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(cleared, 'acknowledged').toHaveCount(0, { timeout: 15_000 });

    // 4. Lead moves the endpoint's address: the key goes, the owner approves the new one in the window, sets a key again.
    const repointed = await lead('endpoint_update', { id: added.id, base_url: moved.baseUrl });
    await openEndpoints();
    await expect(row(ENDPOINT)).toContainText('new base URL waiting for your approval', { timeout: 15_000 });
    const waitingRow = await row(ENDPOINT).innerText();
    await stepShot(page, '7-moved-address');
    keep({ repointed, waitingRow, waitingView: (await views()).find(v => v.id === added.id) });
    expect.soft(waitingRow, 'the key line').toContain('key to set again: it went with the old address');
    expect.soft(waitingRow, 'the notice').toContain('Its key went with the old address: set it again, then approve the new one.');
    expect.soft(waitingRow, 'both addresses').toEqual(expect.stringMatching(new RegExp(`approved\\s+${standin.baseUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[\\s\\S]*new\\s+${moved.baseUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`)));
    await expect(row(ENDPOINT).getByRole('button', { name: 'set the key', exact: true })).toBeVisible();
    await row(ENDPOINT).getByRole('button', { name: 'approve the new URL', exact: true }).click();
    await expect(row(ENDPOINT)).not.toContainText('waiting for your approval', { timeout: 15_000 });
    const approved = (await views()).find(v => v.id === added.id);
    await row(ENDPOINT).getByRole('button', { name: ENDPOINT, exact: true }).click();
    await form.getByLabel('Key').fill(keyAgain);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toHaveCount(0, { timeout: 30_000 });
    await expect(row(ENDPOINT)).toContainText('a key is set · never shown', { timeout: 15_000 });
    const keyedAgain = (await views()).find(v => v.id === added.id);
    keep({ approved, keyedAgain, movedAddressSaw: lines(movedLog).map(r => ({ method: r.method, url: r.url, auth: r.headers?.authorization ? 'present' : 'none' })) });
    expect.soft(approved, 'approved in the window').toMatchObject({ approved: true, approvedBaseUrl: moved.baseUrl, keySet: false });
    expect.soft(keyedAgain, 'the key set again').toMatchObject({ keySet: true });
    expect.soft(lines(movedLog).every(r => r.headers?.authorization !== `Bearer ${key}`), 'the old key at the new address').toBe(true);
    expect.soft(JSON.stringify(await views()).includes(keyAgain), 'the new key in endpoints.list').toBe(false);
    await stepShot(page, '8-approved-key-set-again');

    // 7.
    keep({ errors });
    expect(errors).toEqual([]);
  } finally {
    for (const s of servers) s.kill();
    await app?.close().catch(() => {});
    await standin.close();
    await moved.close();
    backOffice.closeAllConnections();
    backOffice.close();
    await removeHome(home);
  }
});
