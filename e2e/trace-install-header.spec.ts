import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The install header (trace feature A4, 27/11): an inference endpoint may keep its own copy of every request it serves,
 * uploaded or not. With the owner's switch on, Tars's endpoint proxy tells it the install's back-office id on every
 * request (X-Install-Id), so that a deletion of the whole install at the back-office can reach that copy too.
 *
 * Two harnesses run on one endpoint through the proxy: Q, a qwen-code agent, and O, an opencode agent (the stand-ins
 * of e2e/fake-clis.mjs, which call the endpoint where Tars points each: OPENAI_BASE_URL for qwen-code, the provider in
 * OPENCODE_CONFIG_CONTENT for opencode). The endpoint is e2e/stand-in-openai-endpoint.mjs, which logs every request's
 * headers; the back-office is a stand-in here that numbers the installs it registers with canonical uuids written in
 * capitals (INSTALL(1), INSTALL(2) upper-cased: the endpoint is told them in lower case, the value's contract) and takes
 * a deletion. Each step is one turn of each agent, and what the endpoint saw of that turn:
 * 1. The switch off (session headers on), no registration: no X-Install-Id, the session headers there.
 * 2. The switch asked for without the session headers: refused, and the endpoint's view unchanged.
 * 3. The switch on, no registration: no X-Install-Id.
 * 4. On, registered with the back-office: INSTALL(1), on every request of both harnesses.
 * 5. After "delete everything" at the back-office (a DELETE answered 200): no X-Install-Id, INSTALL(1) never again.
 * 6. Sharing given again, a new registration: INSTALL(2), and INSTALL(1) nowhere after step 5.
 * 7. The switch off again: no X-Install-Id.
 * And the upload notice names the install id an endpoint may be told.
 * The artefact: values.json (each step's headers as the endpoint saw them, per agent), the endpoint's request log,
 * the back-office's request log, the fakes' log, the app's log.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000f1';
const O = 'eeee5555-0000-4000-8000-0000000000f2';
const EP = 'ep-0e2e04';
/** The id the back-office stand-in gives its n-th registration, as the endpoint must be told it: a lower-case uuid. */
const INSTALL = (n: number) => `0e2e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Entry = Record<string, unknown> & { method?: string; url?: string; headers?: Record<string, string> };

test('an endpoint is told the install\'s back-office id only with the owner\'s switch, only while registered, never an id deleted', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-install-header-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['qwen-code', 'opencode']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const backOfficeLog = test.info().outputPath('back-office-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog });

  // The back-office: numbers the installs it registers, takes what is sent, and deletes an install it knows.
  let installs = 0;
  const tokens = new Map<string, string>();
  const backOffice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      let status = 200;
      let body: unknown = {};
      if (req.method === 'POST' && req.url === '/v1/installs') {
        const t = `e2e-install-token-${randomBytes(6).toString('hex')}`;
        // A canonical uuid with capitals, as a back-office may store one: the endpoint is told it in lower case.
        tokens.set(t, INSTALL(++installs).toUpperCase());
        [status, body] = [201, { installId: tokens.get(t), token: t, limits: {}, retentionDays: 90 }];
      } else if (!tokens.has(token)) {
        [status, body] = [401, { error: 'unauthorized' }];
      } else if (req.method === 'DELETE' && req.url === '/v1/installs/me') {
        tokens.delete(token);
        body = { deleted: { sessions: 0 }, deletedAt: Date.now(), receipt: 'del_e2e' };
      } else if (req.method === 'POST' && req.url === '/v1/blobs/missing') {
        body = { missing: [] };
      } else if (req.method === 'PUT' && req.url?.startsWith('/v1/batches/')) {
        body = { replayed: false, missingBlobs: [] };
      }
      fs.appendFileSync(backOfficeLog, `${JSON.stringify({ method: req.method, url: req.url, auth: token ? 'present' : 'none', status, installId: (body as { installId?: string }).installId })}\n`);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', () => resolve()));
  const backOfficeUrl = `http://127.0.0.1:${(backOffice.address() as AddressInfo).port}`;

  const agent = (id: string, name: string, provider: string, cliPath: string) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [], provider,
    model: MODEL_ID, endpointId: EP, traces: true, cliPath, createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(Q, 'Q', 'qwen-code', fakes['qwen-code']),
    agent(O, 'O', 'opencode', fakes.opencode),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'], opencode: fakes.opencode },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30, sendSessionHeaders: true }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }, { harness: 'opencode', models: '*' }], uploadUrl: backOfficeUrl },
  }, null, 2));

  const port = apiPort(31950);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Entry[];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    const pass = () => app!.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist);
    const shown = { baseUrl: standin.baseUrl, extraHeaders: {} };
    const owned = { id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, holdMaxSeconds: 30, shown };
    const view = async () => (await api<Array<Record<string, unknown>>>('endpoints', 'list')).find(v => v.id === EP);

    expect((await api<{ ok: boolean; error?: string }>('endpoints', 'setKey', EP, key)).ok, 'the key set').toBe(true);
    for (const id of [Q, O]) {
      await page.evaluate((id) => ((window as unknown as Api).electronAPI.agent.start as (p: unknown) => Promise<unknown>)({ id, prompt: '' }), id);
    }
    const launched = (id: string) => lines(fakeLog).some(e => e.launch && e.agent === id);
    await expect.poll(() => launched(Q) && launched(O), { timeout: 30_000 }).toBe(true);

    // One turn of each agent, and the requests the endpoint got for it, by agent (X-Agent-Id, a session header).
    const steps: Record<string, Record<string, Array<string | null>>> = {};
    const turn = async (step: string) => {
      const before = lines(standinLog).length;
      const answersBefore = { [Q]: lines(fakeLog).filter(e => e.answer && e.agent === Q).length, [O]: lines(fakeLog).filter(e => e.answer && e.agent === O).length };
      for (const id of [Q, O]) await api('agent', 'sendInput', { id, input: `Run the probe for ${step}.\r` });
      await expect.poll(() => [Q, O].every(id => lines(fakeLog).filter(e => e.answer && e.agent === id).length > answersBefore[id]), { timeout: 60_000, message: `both turns of ${step}` }).toBe(true);
      const reached = lines(standinLog).slice(before).filter(e => e.method === 'POST' && e.headers);
      const seen: Record<string, Array<string | null>> = {};
      for (const [id, name] of [[Q, 'qwen-code'], [O, 'opencode']]) {
        seen[name] = reached.filter(r => r.headers!['x-agent-id'] === id).map(r => r.headers!['x-install-id'] ?? null);
      }
      steps[step] = seen;
      keep({ steps });
      expect.soft(seen['qwen-code'].length, `qwen-code reached the endpoint in ${step}`).toBeGreaterThan(0);
      expect.soft(seen.opencode.length, `opencode reached the endpoint in ${step}`).toBeGreaterThan(0);
      return [...seen['qwen-code'], ...seen.opencode];
    };

    // 1. The switch off, no registration.
    expect.soft(await view(), 'the switch off by default').toMatchObject({ sendSessionHeaders: true, sendInstallHeader: false });
    expect.soft((await turn('1-off')).every(v => v === null), 'step 1: no install header').toBe(true);

    // 2. Without the session headers: refused, nothing changed.
    const alone = await api<{ ok: boolean; error?: string }>('endpoints', 'save', { ...owned, sendSessionHeaders: false, sendInstallHeader: true });
    keep({ alone, afterRefusal: await view() });
    expect.soft(alone.ok, 'step 2: the switch without the session headers').toBe(false);
    expect.soft(alone.error ?? '', 'step 2: why').toMatch(/session headers/i);
    expect.soft(await view(), 'step 2: nothing changed').toMatchObject({ sendSessionHeaders: true, sendInstallHeader: false });

    // 3. On, no registration.
    const on = await api<{ ok: boolean; error?: string }>('endpoints', 'save', { ...owned, sendSessionHeaders: true, sendInstallHeader: true });
    keep({ on, afterOn: await view() });
    expect.soft(on.ok, `step 3: the switch on: ${on.error}`).toBe(true);
    expect.soft((await turn('3-on-unregistered')).every(v => v === null), 'step 3: no registration, no header').toBe(true);

    // 4. Registered.
    const notice = await api<{ leaves: string[] }>('traces', 'uploadNotice');
    const consent = await api<{ ok: boolean; error?: string }>('traces', 'giveUploadConsent');
    const firstPass = await pass();
    keep({ notice, consent, firstPass, registered: await api('traces', 'uploadState') });
    expect.soft(notice.leaves.join('\n'), 'the notice names the install id an endpoint may be told').toMatch(/endpoint/i);
    expect.soft(consent.ok, `consent: ${consent.error}`).toBe(true);
    const registered = await turn('4-registered');
    expect.soft(registered, 'step 4: the id on every request of both harnesses').toEqual(registered.map(() => INSTALL(1)));

    // 5. Deleted everywhere.
    const deleted = await api<{ ok: boolean; error?: string }>('traces', 'deleteEverywhere');
    keep({ deleted });
    expect.soft(deleted.ok, `step 5: the deletion: ${deleted.error}`).toBe(true);
    const afterDeletion = await turn('5-deleted');
    expect.soft(afterDeletion.every(v => v === null), 'step 5: no install header after the deletion').toBe(true);

    // 6. Shared again: a new registration.
    const again = await api<{ ok: boolean; error?: string }>('traces', 'giveUploadConsent');
    const secondPass = await pass();
    keep({ again, secondPass });
    expect.soft(again.ok, `consent again: ${again.error}`).toBe(true);
    const reRegistered = await turn('6-registered-again');
    expect.soft(reRegistered, 'step 6: the new id').toEqual(reRegistered.map(() => INSTALL(2)));

    // 7. The switch off again.
    const off = await api<{ ok: boolean; error?: string }>('endpoints', 'save', { ...owned, sendSessionHeaders: true, sendInstallHeader: false });
    expect.soft(off.ok, `step 7: the switch off: ${off.error}`).toBe(true);
    expect.soft((await turn('7-off-again')).every(v => v === null), 'step 7: no install header').toBe(true);

    const deletedAt = Object.keys(steps).indexOf('5-deleted');
    const afterDelete = Object.entries(steps).slice(deletedAt).flatMap(([, s]) => [...s['qwen-code'], ...s.opencode]);
    keep({ backOffice: lines(backOfficeLog) });
    expect.soft(afterDelete.some(v => v?.toLowerCase() === INSTALL(1)), 'the deleted id sent again, in any case').toBe(false);
  } finally {
    await app?.close().catch(() => {});
    await standin.close();
    await new Promise(r => backOffice.close(() => r(undefined)));
    await removeHome(home);
  }
});
