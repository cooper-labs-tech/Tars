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
 * What a person does to a traced session's turns, and why a request was cut (trace feature B3, 27/11): the real app,
 * a stand-in Qwen Code on a stand-in endpoint (e2e/stand-in-openai-endpoint.mjs, a dummy key, loopback only), every
 * key sent through the window's own input channel (agent:input), as the panel sends what is typed.
 *
 * 1. The owner types a task into Q's pane: a turn that ends done.
 * 2. The owner types a correction a few seconds later: the turn before reads `corrected`, with who typed it (the
 *    owner, `user`) and the delay in seconds.
 * 3. The owner types a task the endpoint answers slowly, and presses Esc while the answer streams: the turn reads
 *    `interrupted` by `esc` during the answer, and its request carries `cancel: { by: 'harness', cause: 'esc' }` with
 *    the bytes that reached the harness, no endpoint error, and the turn `abandoned`.
 * 4. What leaves: the upload's preview carries the turns' interventions and the request's cancel, and the notice says
 *    both.
 * Red on the base (#675's head, 0346e9a65): no interventions, the owner's words of `unknown` authorship, and the cut
 * request kept as the endpoint's error ("the endpoint closed the stream") with no cancel.
 * The artefact: values.json, the session as exported, the preview, the notice, the stand-in's and the fake CLI's logs,
 * the app's log, the window.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000b4';
const EP = 'ep-0e2eb4';
type Row = Record<string, unknown>;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

test('an Esc into a streaming answer and a correction after a done turn are on their turns, and the cut request says who cut it', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-b3i-');
  const project = path.join(home, 'projects', 'probe');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });

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

  const port = apiPort(31974);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Row[];
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
    /** Keys into Q's pane, as the panel sends them: the words, then Enter alone. */
    const type = async (words: string) => {
      await api('agent', 'sendInput', { id: Q, input: words });
      await new Promise(r => setTimeout(r, 300));
      await api('agent', 'sendInput', { id: Q, input: '\r' });
    };
    const answers = () => lines(fakeLog).filter(e => typeof e.answer === 'string').map(e => String(e.answer));

    const setKey = await api<{ ok: boolean; error?: string }>('endpoints', 'setKey', EP, key);
    expect(setKey.ok, `the key: ${setKey.error}`).toBe(true);
    await api('agent', 'start', { id: Q, prompt: '' });
    await expect.poll(() => lines(fakeLog).some(e => e.launch && e.agent === Q), { timeout: 30_000 }).toBe(true);
    await new Promise(r => setTimeout(r, 1500));

    // 1. A task the owner types: done.
    await type('Run the probe and report what it printed.');
    await expect.poll(() => answers().filter(a => a.includes('PROBE-OK')).length, { timeout: 60_000 }).toBe(1);
    await new Promise(r => setTimeout(r, 2000));

    // 2. The owner's correction, a few seconds later.
    await type('No, run it again and report it word for word.');
    await expect.poll(() => answers().filter(a => a.includes('PROBE-OK')).length, { timeout: 60_000 }).toBe(2);
    await new Promise(r => setTimeout(r, 2000));

    // 3. A task answered slowly, and Esc while it streams.
    await type('SLOW STREAM: tell me everything about the probe.');
    await expect.poll(() => lines(standinLog).some(e => JSON.stringify(e.body ?? '').includes('SLOW STREAM')), { timeout: 30_000 }).toBe(true);
    await new Promise(r => setTimeout(r, 1200));
    await api('agent', 'sendInput', { id: Q, input: '\x1b' });
    await expect.poll(() => lines(fakeLog).some(e => e.interrupted), { timeout: 15_000 }).toBe(true);

    const traceIdOf = `const s = req(dist + '/services/traces-runtime.js').traceStore().list({ agentId: arg.q }).sessions; return s.length ? s[0].traceId : null;`;
    const traceId = (await evaluate<string>(traceIdOf, { q: Q }))!;
    const sessionOf = `return req(dist + '/services/traces-runtime.js').traceStore().session(arg.id);`;
    // The cut request is recorded once the harness has hung up.
    await expect.poll(async () => ((await evaluate<{ turns: Array<{ requests: Row[] }> }>(sessionOf, { id: traceId }))?.turns ?? []).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await new Promise(r => setTimeout(r, 1000));
    const session = await evaluate<{ turns: Array<Row & { requests: Row[]; interventions?: Row }> }>(sessionOf, { id: traceId });
    const exported = await evaluate<string[]>(`return [...req(dist + '/services/trace-export.js').traceExportLines(req(dist + '/services/traces-runtime.js').traceStore(), {})];`);
    fs.writeFileSync(test.info().outputPath('trace-export.jsonl'), `${exported.join('\n')}\n`);
    const preview = await api<{ document: { batches: Array<{ body: { turns: Row[]; requests: Row[] } }> } } | null>('traces', 'preview', traceId);
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), JSON.stringify(preview, null, 2));
    const notice = await api<{ leaves: string[] }>('traces', 'uploadNotice');
    const turns = session.turns;
    const slow = turns.find(t => t.requests.some(r => r.cancel || r.error)) ?? turns[turns.length - 1];
    const cut = slow.requests.find(r => r.cancel || r.error) ?? {};
    keep({
      traceId, notice: notice.leaves,
      turns: turns.map(t => ({ index: t.index, author: t.author, finalStatus: t.finalStatus, interventions: t.interventions ?? null, requests: t.requests.map(r => ({ status: r.status, error: r.error ?? null, cancel: r.cancel ?? null })) })),
      fakeLog: lines(fakeLog).filter(e => e.interrupted || e.key),
    });

    // 1 and 2. The owner's words are theirs; the done turn before the correction reads corrected.
    expect.soft(turns.map(t => t.author), 'who wrote each turn').toEqual(['user', 'user', 'user']);
    expect.soft(turns[0].finalStatus, 'the first turn').toBe('done');
    expect.soft(turns[0].interventions, 'the first turn\'s interventions').toMatchObject({ corrected: true, next: { by: 'user' } });
    const delay = Number((turns[0].interventions?.next as Row | undefined)?.delaySec);
    expect.soft(delay > 0 && delay < 600, `the correction's delay, ${delay} s`).toBe(true);

    // 3. The Esc: on its turn, during the answer, and the cut's cause on its request.
    expect.soft(slow.interventions?.interrupted, 'the Esc on its turn').toMatchObject({ by: 'esc', during: 'answer' });
    expect.soft(slow.finalStatus, 'the cut turn').toBe('abandoned');
    expect.soft(cut.cancel, 'the cut request\'s cancel').toMatchObject({ by: 'harness', cause: 'esc' });
    expect.soft(Number((cut.cancel as Row | undefined)?.deliveredBytes), 'bytes delivered before the Esc').toBeGreaterThan(0);
    expect.soft(cut.error, 'an endpoint error for the Esc').toBeUndefined();

    // 4. What leaves.
    const sent = preview?.document.batches[0]?.body;
    expect.soft(sent?.turns?.[0]?.interventions, 'the preview\'s first turn').toMatchObject({ corrected: true });
    expect.soft(sent?.requests?.some(r => (r.cancel as Row | undefined)?.cause === 'esc'), 'the preview\'s cut request').toBe(true);
    expect.soft(notice.leaves.some(l => l.startsWith('why each request cut before its end was cut')), 'the notice: the cancel').toBe(true);
    expect.soft(notice.leaves.some(l => l.startsWith('what was done to each turn')), 'the notice: the interventions').toBe(true);

    await page.screenshot({ path: test.info().outputPath('window.png') });
  } finally {
    await app?.close();
    await standin.close();
  }
});
