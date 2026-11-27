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
 * The training consent (trace feature A5, 27/11): the owner's switch "May be used to train models", beside sharing.
 * Each session carries `consent: { training }` as the switch stood while it ran (off at any moment: false), and the
 * install's current value goes to the back-office on every change (`PUT /v1/installs/me/consent`, #678's contract),
 * which covers the sessions already sent. Q is a qwen-code agent (the stand-in of e2e/fake-clis.mjs) on an endpoint
 * stand-in, traced; the back-office is a stand-in here that logs every call and may refuse the next consent PUT.
 * 1. Nothing chosen: the switch is on, and the upload notice says so in a line of its own.
 * 2. Sharing given, Q's turn, a pass: the registration carries `consent: { training: true }`, and Q's session goes with
 *    `consent: { training: true }`.
 * 3. The switch turned off while Q's terminal runs: the back-office gets `PUT /v1/installs/me/consent {training:false}`
 *    with the install token, and Q's session goes again with `{ training: false }` (its next turn too).
 * 4. Turned on, the PUT refused (503): the change stays owed in the private folder; Tars restarted; the first pass
 *    after the start sends `{ training: true }`.
 * 5. After the restart, Q's new session is true; the session turned off before stays false.
 * 6. The preview of Q's new session shows the consent it would carry.
 * The artefact: values.json, the back-office's log (bodies, the token present or not, never its value), the endpoint's
 * log, the app's log of each run.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000a5';
const EP = 'ep-0e2e05';
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Entry = Record<string, unknown> & { method?: string; url?: string; body?: string; status?: number };

test('the training switch: on by default, stamped on each session as it stood, sent to the back-office on every change, after a restart too', async () => {
  test.setTimeout(5 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-training-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const backOfficeLog = test.info().outputPath('back-office-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog });

  // The back-office (#678's shape): registers, takes batches, takes the install's training value; may refuse it once.
  let refuseConsent = 0;
  const tokens = new Set<string>();
  const backOffice = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      let status = 200;
      let body: unknown = {};
      if (req.method === 'POST' && req.url === '/v1/installs') {
        const t = `e2e-install-token-${randomBytes(6).toString('hex')}`;
        tokens.add(t);
        [status, body] = [201, { installId: '0e2e0000-0000-4000-8000-0000000000a5', token: t, limits: {}, retentionDays: 90 }];
      } else if (!tokens.has(token)) {
        [status, body] = [401, { error: 'unauthorized' }];
      } else if (req.method === 'PUT' && req.url === '/v1/installs/me/consent') {
        if (refuseConsent > 0) { refuseConsent--; [status, body] = [503, { error: 'unavailable' }]; }
        else body = { training: JSON.parse(raw).training, at: Date.now() };
      } else if (req.method === 'POST' && req.url === '/v1/blobs/missing') {
        body = { missing: [] };
      } else if (req.method === 'PUT' && req.url?.startsWith('/v1/batches/')) {
        body = { replayed: false, missingBlobs: [] };
      }
      // Bodies are logged (the batches' are scrubbed sessions of the stand-in fake), the token never.
      fs.appendFileSync(backOfficeLog, `${JSON.stringify({ at: Date.now(), method: req.method, url: req.url, auth: token ? (tokens.has(token) ? 'install token' : 'other') : 'none', status, body: raw.length < 200_000 ? raw : `(${raw.length} bytes)` })}\n`);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => backOffice.listen(0, '127.0.0.1', () => resolve()));
  const backOfficeUrl = `http://127.0.0.1:${(backOffice.address() as AddressInfo).port}`;

  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: Q, name: 'Q', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [], provider: 'qwen-code',
    model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes['qwen-code'], createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: backOfficeUrl },
  }, null, 2));

  const port = apiPort(31960);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Entry[];
  const backOfficeCalls = () => lines(backOfficeLog);
  const consentPuts = () => backOfficeCalls().filter(c => c.method === 'PUT' && c.url === '/v1/installs/me/consent');
  /** The consent each batch carried for each session, in the order they came. */
  const sessionConsents = () => backOfficeCalls().filter(c => c.method === 'PUT' && String(c.url).startsWith('/v1/batches/'))
    .flatMap(c => ((JSON.parse(String(c.body)).sessions ?? []) as Array<{ sessionId: string; consent?: unknown }>).map(s => ({ sessionId: s.sessionId, consent: s.consent })));
  let app: ElectronApplication | undefined;
  let run = 0;

  const launch = async () => {
    run++;
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath(`app-${run}.log`);
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    const pass = () => app!.evaluate((_e, d) => process.mainModule!.require(`${d}/services/traces-runtime.js`).traceUploader().runOnce(), dist) as Promise<{ sent: number; failed: number; skipped?: string }>;
    const turn = async (what: string) => {
      const answers = () => lines(fakeLog).filter(e => e.answer && e.agent === Q).length;
      const before = answers();
      await api('agent', 'sendInput', { id: Q, input: `Run the probe for ${what}.\r` });
      await expect.poll(answers, { timeout: 60_000, message: `Q's turn for ${what}` }).toBeGreaterThan(before);
    };
    const startQ = async () => {
      const launches = () => lines(fakeLog).filter(e => e.launch && e.agent === Q).length;
      const before = launches();
      await page.evaluate((id) => ((window as unknown as Api).electronAPI.agent.start as (p: unknown) => Promise<unknown>)({ id, prompt: '' }), Q);
      await expect.poll(launches, { timeout: 30_000 }).toBeGreaterThan(before);
    };
    return { page, api, pass, turn, startQ };
  };

  try {
    let a = await launch();
    expect((await a.api<{ ok: boolean }>('endpoints', 'setKey', EP, key)).ok, 'the key set').toBe(true);

    // 1. Nothing chosen: on, and the notice says it.
    const first = await a.api<{ training: boolean; owed: boolean }>('traces', 'training');
    const notice = await a.api<{ training?: boolean; leaves: string[] }>('traces', 'uploadNotice');
    keep({ first, notice });
    expect.soft(first, 'step 1: on with nothing chosen').toMatchObject({ training: true, owed: false });
    expect.soft(notice.training, 'step 1: the notice says where it stands').toBe(true);
    expect.soft(notice.leaves.join('\n'), 'step 1: a line of its own').toMatch(/train/i);

    // 2. Shared, a turn, a pass.
    expect.soft((await a.api<{ ok: boolean }>('traces', 'giveUploadConsent')).ok, 'consent').toBe(true);
    await a.startQ();
    await a.turn('step 2');
    const pass2 = await a.pass();
    const registration = backOfficeCalls().find(c => c.method === 'POST' && c.url === '/v1/installs');
    const firstSessionId = sessionConsents()[0]?.sessionId;
    keep({ pass2, registration, consentsAfter2: sessionConsents() });
    expect.soft(registration && JSON.parse(String(registration.body)).consent, 'step 2: the registration carries the value').toEqual({ training: true });
    expect.soft(sessionConsents().map(s => s.consent), 'step 2: the session carries it').toEqual([{ training: true }]);

    // 3. Off while Q runs.
    const off = await a.api<{ ok: boolean; unsaved?: string }>('traces', 'setTraining', false);
    await expect.poll(() => consentPuts().filter(p => p.status === 200).length, { timeout: 30_000, message: 'step 3: the PUT went by itself' }).toBeGreaterThan(0);
    await a.turn('step 3');
    const pass3 = await a.pass();
    const put3 = consentPuts()[0];
    keep({ off, pass3, put3, consentsAfter3: sessionConsents() });
    expect.soft(off.ok, 'step 3: turned off').toBe(true);
    expect.soft(put3 && JSON.parse(String(put3.body)), 'step 3: the install value, alone').toEqual({ training: false });
    expect.soft(put3?.auth, 'step 3: with the install token').toBe('install token');
    const latest3 = sessionConsents().filter(s => s.sessionId === firstSessionId).at(-1);
    expect.soft(latest3?.consent, 'step 3: the running session goes again, false').toEqual({ training: false });

    // 4. On, refused once; owed across a restart.
    refuseConsent = 1;
    const on = await a.api<{ ok: boolean }>('traces', 'setTraining', true);
    await expect.poll(() => consentPuts().filter(p => p.status === 503).length, { timeout: 30_000, message: 'step 4: the refused PUT' }).toBe(1);
    const owedBefore = await a.api<{ training: boolean; owed: boolean }>('traces', 'training');
    const fileBefore = JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'traces-training.json'), 'utf8'));
    keep({ on, owedBefore, fileBefore });
    expect.soft(owedBefore, 'step 4: still owed after a 503').toMatchObject({ training: true, owed: true });
    expect.soft(fileBefore, 'step 4: owed where a restart finds it').toMatchObject({ training: true, owed: true });
    await app!.close();
    app = undefined;
    a = await launch();
    await expect.poll(() => consentPuts().filter(p => p.status === 200).map(p => JSON.parse(String(p.body)).training).at(-1), { timeout: 60_000, message: 'step 4: sent after the restart' }).toBe(true);
    const owedAfter = await a.api<{ training: boolean; owed: boolean }>('traces', 'training');
    keep({ owedAfter, putsAfter4: consentPuts().map(p => ({ status: p.status, body: p.body })) });
    expect.soft(owedAfter, 'step 4: nothing owed once sent').toMatchObject({ training: true, owed: false });

    // 5. A new session after the restart is true; the old one stays false.
    await a.startQ();
    await a.turn('step 5');
    const pass5 = await a.pass();
    const consents5 = sessionConsents();
    const newSession = consents5.filter(s => s.sessionId !== firstSessionId).at(-1);
    keep({ pass5, consents5 });
    expect.soft(newSession?.consent, 'step 5: the new session').toEqual({ training: true });
    expect.soft(consents5.filter(s => s.sessionId === firstSessionId).at(-1)?.consent, 'step 5: the old one stays false').toEqual({ training: false });

    // 6. The preview shows it.
    const preview = newSession ? await a.api<{ consent?: unknown }>('traces', 'preview', newSession.sessionId) : undefined;
    keep({ previewConsent: preview?.consent });
    expect.soft(preview?.consent, 'step 6: the preview shows the consent').toEqual({ training: true });
    keep({ backOffice: backOfficeCalls().map(c => ({ method: c.method, url: c.url, status: c.status, auth: c.auth })) });
  } finally {
    await app?.close().catch(() => {});
    await standin.close();
    await new Promise(r => backOffice.close(() => r(undefined)));
    await removeHome(home);
  }
});
