import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
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
 * 6. Never record closed models is not on in a Tars that never set it, or it says nothing of the providers' terms.
 * 7. An uncaught error in the page.
 * Red on #596's head (caefc8874), which has no window: 6 and 1 find no Inference endpoints in Settings.
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
    await page.goto(`${DEV_URL}/traces?view=upload`, { waitUntil: 'domcontentloaded' });
    const address = page.getByLabel('Back-office address');
    await expect(address).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('no address: nothing leaves this computer', { exact: true })).toBeVisible();
    await address.fill('http://127.0.0.1:9/traces');
    await address.press('Enter');
    const notice = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Upload what I opt in', exact: true }) });
    await expect(notice).toBeVisible({ timeout: 15_000 });
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
    await removeHome(home);
  }
});
