import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The gap before each request, split by cause (27/11, trace feature C1). The real app; a stand-in codex and a stand-in
 * pi on a stand-in endpoint (e2e/stand-in-openai-endpoint.mjs, a dummy key, loopback only), each writing its own log
 * in its harness's lines (codex 0.170's, measured on 27/11; pi 1.3.0's and 1.5.2's, read in their code); nothing leaves
 * the machine. Lead, the project's orchestrator, hands X (codex) and P (pi) their tasks through the run-task route
 * delegate_task uses, with its own token. The model asks for two commands in one answer, which the harness runs
 * together (codex's way and pi's), one of them failing; their words are read by e2e/fake-command.mjs, no shell.
 *
 * 1. X's first task: its second request carries the two calls' results. Its gap's tool part is their union, not their
 *    sum; each call is on the request by its id, with its exit code, its time and `failed` for the one that exited 3;
 *    the parts add up to the gap (the rest is the gap less the others).
 * 2. Lead waits, then hands X a second task, typed into its terminal: the request that opens that turn waits for those
 *    words, Lead's as an orchestrator (#680's authors), and carries no tool time.
 * 3. The same for P, from pi's own lines.
 * 4. What leaves: the export and the upload's preview carry each request's gap and calls as ids, numbers and flags,
 *    never a command or an output; the notice has a line for each.
 *
 * The artefact: values.json, the session as exported, the preview, codex's rollout and pi's session file, the
 * stand-in endpoint's log, the fakes' logs and the app's log.
 *   npx playwright test e2e/trace-gap-split.spec.ts
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000c1';
const X = 'eeee5555-0000-4000-8000-0000000000c1';
const P = 'ffff6666-0000-4000-8000-0000000000c1';
const EP = 'ep-0e2ec1';
const NEW_NOTICE_LINES = [
  'how the wait before each request divides: its tools\' run, the wait for typed words and whose they were (by kind), the endpoint\'s pause, and the harness\'s own time',
  'each tool call, by its id: its exit code, how long it ran, whether it was denied, timed out or failed, and whether the harness cut its output (with how many bytes, when it counts them), never its command or its output',
];
/** How long Lead waits before its second task: the input wait the opening request must show. */
const WAIT_MS = 2500;

type Row = Record<string, unknown>;
type Gap = { ms: number; toolMs: number | null; inputWaitMs: number | null; inputBy?: string; heldMs: number; harnessMs: number | null };
type Call = { toolCallId: string; exit: number | null; ms: number | null; denied: boolean; timedOut: boolean; failed: boolean; truncated: boolean };
type Req = Row & { side: boolean; gap?: Gap; toolCalls?: Call[] };

test('each traced request\'s gap splits into its tools\' run, read from codex\'s and pi\'s own logs, the wait for typed words and whose, the hold and the rest', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-c1-');
  const project = path.join(home, 'projects', 'probe');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });

  const fakes = writeFakeClis(home, ['pi', 'codex']);
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog });

  const agent = (id: string, name: string, extra: Row) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
    agent(X, 'X', { provider: 'codex', model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes.codex }),
    agent(P, 'P', { provider: 'pi', model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes.pi }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex: fakes.codex, pi: fakes.pi },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'codex', models: '*' }, { harness: 'pi', models: '*' }] },
  }, null, 2));
  const dropDir = path.join(dir, 'endpoint-keys');
  fs.mkdirSync(dropDir, { recursive: true });

  const port = apiPort(31976);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
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

    const token = await evaluate<string>(`return req(dist + '/core/agent-tokens.js').mintRunToken(arg.lead).token;`, { lead: LEAD });
    const api = async (method: string, url: string, body?: Row) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': LEAD, 'X-Tars-Client': 'mcp', 'X-Tars-Caller-Project': project, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) as Row };
    };
    fs.writeFileSync(path.join(dropDir, 'remote.key'), `${key}\n`);
    const setKey = await api('POST', `/api/endpoints/${EP}/key`, { keyFile: 'remote.key' });
    keep({ setKey });
    expect(setKey.status, `the key: ${JSON.stringify(setKey.body)}`).toBeLessThan(300);

    // A task's end, as Lead reads it (task_status): the ledger's outcome, by the id run-task gave.
    const ended = async (ref: string) => String(((await api('GET', `/api/tasks/${ref}`)).body.task as Row | undefined)?.outcome ?? '');
    const traceIdOf = `const s = req(dist + '/services/traces-runtime.js').traceStore().list({ agentId: arg.id }).sessions; return s.length ? s[0].traceId : null;`;
    const sessionOf = `return req(dist + '/services/traces-runtime.js').traceStore().session(arg.id);`;
    const mainRequests = async (traceId: string) => ((await evaluate<{ turns: Array<{ requests: Req[] }> } | null>(sessionOf, { id: traceId }))?.turns ?? [])
      .flatMap(t => t.requests).filter(r => !r.side);

    // Two tasks for one agent: the first asks for two commands at once, then, WAIT_MS after it ended, the second.
    const run = async (id: string, name: string) => {
      const first = await api('POST', `/api/agents/${id}/run-task`, { task: `Run both probes. TOOLS 0.8:0,0.4:3`, answer: 'started' });
      expect(first.status, `${name}'s first task: ${JSON.stringify(first.body)}`).toBeLessThan(300);
      const ref1 = String(first.body.taskId);
      await expect.poll(() => ended(ref1), { timeout: 60_000, message: `${name}'s first task` }).toMatch(/completed|error|stopped/);
      await new Promise(r => setTimeout(r, WAIT_MS));
      const second = await api('POST', `/api/agents/${id}/run-task`, { task: `Now the last probe. TOOLS 0.3:0`, answer: 'started' });
      expect(second.status, `${name}'s second task: ${JSON.stringify(second.body)}`).toBeLessThan(300);
      const ref2 = String(second.body.taskId);
      await expect.poll(() => ended(ref2), { timeout: 60_000, message: `${name}'s second task` }).toMatch(/completed|error|stopped/);
      const traceId = (await evaluate<string | null>(traceIdOf, { id }))!;
      // The calls' lines are read from the harness's log on its watcher's tick: waited for without a throw, so a build
      // without them fails on each field below.
      for (const until = Date.now() + 15_000; Date.now() < until;) {
        const reqs = await mainRequests(traceId);
        if (reqs.filter(r => r.toolCalls?.length).length >= 2) break;
        await new Promise(r => setTimeout(r, 300));
      }
      return { ref1, ref2, traceId, requests: await mainRequests(traceId) };
    };

    for (const [id, name] of [[X, 'X (codex)'], [P, 'P (pi)']] as const) {
      const { ref1, ref2, traceId, requests } = await run(id, name);
      keep({ [name]: { ref1, ref2, traceId, requests: requests.map(r => ({ startedAt: r.startedAt, gap: r.gap ?? null, toolCalls: r.toolCalls ?? null })) } });
      // The four requests: the first task's two, the second task's two.
      expect.soft(requests.length, `${name}'s requests`).toBe(4);
      const [, carries, opens, last] = requests;

      // 1. The two calls run together: their union, not their sum; each by its id, with its exit and time.
      const calls = carries?.toolCalls ?? [];
      expect.soft(calls.length, `${name}: the calls on the request that carries their results`).toBe(2);
      const ok = calls.find(c => c.exit === 0);
      const bad = calls.find(c => c.exit === 3);
      expect.soft(ok, `${name}: the call that exited 0`).toMatchObject({ denied: false, timedOut: false, failed: false, truncated: false });
      expect.soft(bad, `${name}: the call that exited 3`).toMatchObject({ denied: false, timedOut: false, failed: true, truncated: false });
      expect.soft(Number(ok?.ms), `${name}: the 0.8 s call's time`).toBeGreaterThanOrEqual(750);
      expect.soft(Number(bad?.ms), `${name}: the 0.4 s call's time`).toBeGreaterThanOrEqual(350);
      const gap = carries?.gap;
      expect.soft(gap?.toolMs, `${name}: the tools' part`).not.toBeNull();
      expect.soft(Number(gap?.toolMs), `${name}: the union, at least the longer call`).toBeGreaterThanOrEqual(Number(ok?.ms ?? 0) - 25);
      expect.soft(Number(gap?.toolMs), `${name}: never the sum of the two`).toBeLessThan(Number(ok?.ms ?? 0) + Number(bad?.ms ?? 0) - 200);
      expect.soft(gap?.inputWaitMs, `${name}: no typed words inside a turn`).toBe(0);
      expect.soft(gap?.harnessMs, `${name}: the rest`).not.toBeNull();
      const sum = Number(gap?.toolMs) + Number(gap?.inputWaitMs) + Number(gap?.heldMs) + Number(gap?.harnessMs);
      expect.soft(Math.abs(sum - Number(gap?.ms)), `${name}: the parts add up to the gap (${JSON.stringify(gap)})`).toBeLessThanOrEqual(25);

      // 2. The second task's words, typed WAIT_MS after the first ended: the wait is Lead's, an orchestrator's.
      expect.soft(opens?.gap, `${name}: the gap before the second task`).toMatchObject({ toolMs: 0, inputBy: 'orchestrator' });
      expect.soft(Number(opens?.gap?.inputWaitMs), `${name}: the wait for Lead's words`).toBeGreaterThanOrEqual(WAIT_MS - 200);
      expect.soft(last?.toolCalls?.map(c => c.exit), `${name}: the second task's call`).toEqual([0]);
    }

    // 4. What leaves, for X's session.
    const traceId = (await evaluate<string>(traceIdOf, { id: X }))!;
    const exported = await evaluate<string[]>(`return [...req(dist + '/services/trace-export.js').traceExportLines(req(dist + '/services/traces-runtime.js').traceStore(), {})];`);
    fs.writeFileSync(test.info().outputPath('trace-export.jsonl'), `${exported.join('\n')}\n`);
    const preview = await evaluate<{ document: { batches: Array<{ body: { requests: Row[] } }> } } | null>(`return req(dist + '/services/traces-runtime.js').previewUpload(arg.id);`, { id: traceId });
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), JSON.stringify(preview, null, 2));
    const notice = await page.evaluate(() => (window as unknown as { electronAPI: { traces: { uploadNotice: () => Promise<{ leaves: string[] }> } } }).electronAPI.traces.uploadNotice());
    const sent = (preview?.document.batches ?? []).flatMap(b => b.body.requests ?? []);
    keep({ sentRequests: sent.map(r => ({ gap: r.gap ?? null, toolCalls: r.toolCalls ?? null })), notice: notice.leaves });
    expect.soft(sent.filter(r => r.gap).length, 'requests sent with their gap').toBeGreaterThanOrEqual(3);
    expect.soft(sent.filter(r => Array.isArray(r.toolCalls)).length, 'requests sent with their calls').toBeGreaterThanOrEqual(2);
    const fields = JSON.stringify(sent.map(r => [r.gap, r.toolCalls]));
    expect.soft(fields, 'a command in what leaves of the calls').not.toMatch(/sleep|exit 3|not run/);
    for (const line of NEW_NOTICE_LINES) expect.soft(notice.leaves, 'the notice').toContain(line);

    // The harnesses' own logs, as they were read.
    const copy = (from: string, to: string) => { if (fs.existsSync(from)) fs.cpSync(from, test.info().outputPath(to), { recursive: true }); };
    copy(path.join(home, '.codex', 'sessions'), 'codex-sessions');
    copy(path.join(dir, 'pi', 'sessions'), 'pi-sessions');
    copy(path.join(home, 'fake-codex.jsonl'), 'fake-codex.jsonl');
    copy(path.join(home, 'fake-cli.jsonl'), 'fake-cli.jsonl');
    await page.screenshot({ path: test.info().outputPath('window.png') });
  } finally {
    await app?.close();
    await standin.close();
  }
});
