import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What a traced session's upload carries of personal data (trace feature B3, 27/11): the real app, a stand-in Qwen
 * Code on a stand-in endpoint (e2e/stand-in-openai-endpoint.mjs, a dummy key, loopback only), nothing leaving the
 * machine. Nothing is uploaded: the window's own preview (traces:preview, what the Upload view shows before consent)
 * is the document an upload sends, built by the same function.
 *
 * 1. Q's task holds an e-mail address twice, a phone number, another user's home, a file in the account's own home
 *    (the sandbox's), and the name of the author of the project's git history.
 * 2. The preview carries none of them as typed: each is its placeholder, `<EMAIL_n>`, `<PHONE_n>`, `<HOME_n>`,
 *    `<PERSON_n>`, the same value under the same number, and the session row carries `maskingVersion` and
 *    `maskCounts` with its six types.
 * 3. The notice the window shows before consent says it: a line in what leaves, and what the scrubbing catches.
 * Red on the base (feat/traces-window at 69c8f3f08): the e-mail, the phone number, the other home and the name go
 * as typed, the account's home as `~`, and the session has no counts.
 * The artefact: values.json, the preview, the notice, the stand-in endpoint's log, the app's log, the window.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000b3';
const EP = 'ep-0e2eb3';
const EMAIL = 'ada.quill@example.org';
const PHONE = '+33 6 12 34 56 78';
const OTHER_HOME = '/Users/otherone';
const AUTHOR = 'Ada Quill';

type Row = Record<string, unknown>;
type Preview = { document: { batches: Array<{ body: { sessions: Row[] } }>; blobs: Record<string, unknown> }; counts: Record<string, number>; scrubVersion: string } | null;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

test('a traced session\'s upload preview masks e-mails, phone numbers, home paths and known names, and counts them', async () => {
  test.setTimeout(3 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-b3-');
  const project = path.join(home, 'projects', 'probe');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: AUTHOR, GIT_AUTHOR_EMAIL: 'author@example.invalid', GIT_COMMITTER_NAME: AUTHOR, GIT_COMMITTER_EMAIL: 'author@example.invalid' } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), 'probe\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');

  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog });

  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: Q, name: 'Q', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
    provider: 'qwen-code', model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes['qwen-code'],
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }, null, 2));

  const port = apiPort(31972);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  const fakeEntries = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Row[];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const evaluate = <T>(fn: string, arg: Row = {}) => app!.evaluate(({}, { fn, arg, dist }) => {
      const req = process.mainModule!.require;
      return new Function('req', 'dist', 'arg', fn)(req, dist, arg);
    }, { fn, arg, dist }) as Promise<T>;
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;

    const setKey = await api<{ ok: boolean; error?: string }>('endpoints', 'setKey', EP, key);
    keep({ setKey });
    expect(setKey.ok, `the key: ${setKey.error}`).toBe(true);

    // 1. Q's task, with the values the upload must not carry.
    const task = `Mail ${EMAIL} (${EMAIL}) or call ${PHONE} about ${OTHER_HOME}/notes.md and ${project}/README.md; ${AUTHOR} wrote it.`;
    await api('agent', 'start', { id: Q, prompt: task });
    await expect.poll(() => fakeEntries().some(e => e.model && e.status === 200), { timeout: 60_000 }).toBe(true);
    const traceIdOf = `const s = req(dist + '/services/traces-runtime.js').traceStore().list({ agentId: arg.q }).sessions; return s.length ? s[0].traceId : null;`;
    await expect.poll(() => evaluate<string | null>(traceIdOf, { q: Q }), { timeout: 30_000 }).toBeTruthy();
    const traceId = (await evaluate<string>(traceIdOf, { q: Q }))!;
    const requestsOf = `return req(dist + '/services/traces-runtime.js').traceStore().session(arg.id)?.session.requestCount ?? 0;`;
    await expect.poll(() => evaluate<number>(requestsOf, { id: traceId }), { timeout: 30_000 }).toBeGreaterThan(0);

    // 2. The window's preview: the document an upload would send.
    const preview = await api<Preview>('traces', 'preview', traceId);
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), JSON.stringify(preview, null, 2));
    const notice = await api<{ leaves: string[]; scrubbing: { version: string; catches: string[]; cannot: string[] } }>('traces', 'uploadNotice');
    fs.writeFileSync(test.info().outputPath('upload-notice.json'), JSON.stringify(notice, null, 2));
    const leaving = JSON.stringify(preview);
    const sentSession = preview?.document.batches[0]?.body.sessions[0] ?? {};
    const userText = Object.values(preview?.document.blobs ?? {}).map(b => JSON.stringify(b)).find(b => b.includes('Mail ')) ?? '';
    keep({ traceId, sentSession, userText, counts: preview?.counts ?? null, scrubVersion: preview?.scrubVersion ?? null, notice });

    for (const [what, typed] of [['the e-mail', EMAIL], ['the phone number', PHONE], ['another user\'s home', OTHER_HOME], ['the account\'s home', home], ['the git author', AUTHOR]] as const) {
      expect.soft(leaving, `${what} in the preview`).not.toContain(typed);
    }
    expect.soft(userText, 'the task as it would leave').toMatch(/Mail <EMAIL_1> \(<EMAIL_1>\) or call <PHONE_1> about <HOME_(\d+)>\/notes\.md and <HOME_(?!\1)\d+>\/projects\/probe\/README\.md; <PERSON_1> wrote it\./);
    expect.soft(sentSession.maskingVersion, 'the masking version').toEqual(expect.any(String));
    const counts = (sentSession.maskCounts ?? {}) as Record<string, number>;
    expect.soft(Object.keys(counts).sort(), 'the count types').toEqual(['EMAIL', 'HOME', 'IP', 'PERSON', 'PHONE', 'SECRET']);
    expect.soft(counts.EMAIL, 'e-mails masked').toBeGreaterThanOrEqual(2);
    expect.soft(counts.PHONE, 'phone numbers masked').toBeGreaterThanOrEqual(1);
    expect.soft(counts.HOME, 'home paths masked').toBeGreaterThanOrEqual(2);
    expect.soft(counts.PERSON, 'names masked').toBeGreaterThanOrEqual(1);

    // 3. The notice says it.
    expect.soft(notice.leaves.some(l => /masked in each session/.test(l)), 'the counts in what leaves').toBe(true);
    for (const kind of ['e-mail addresses', 'IP addresses', 'phone numbers', 'home folders', 'names']) {
      expect.soft(notice.scrubbing.catches.some(c => c.includes(kind)), `${kind} in what the scrubbing catches`).toBe(true);
    }
    expect.soft(notice.scrubbing.cannot.join(' '), 'what it cannot catch').not.toMatch(/e-mail addresses|IP addresses/);

    await page.screenshot({ path: test.info().outputPath('window.png') });
  } finally {
    await app?.close();
    await standin.close();
  }
});
