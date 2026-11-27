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
 * A traced session says what started it, the task it ran and when that task waited, was handed over and reached the
 * model, the commit it started from, how its branch's pull request ended, and the demand it never served (27/11,
 * trace feature A3). The real app, a stand-in Qwen Code on a stand-in endpoint (e2e/stand-in-openai-endpoint.mjs, a
 * dummy key, loopback only), and a stand-in gh that answers for a GitHub repository that is no real one: nothing
 * leaves the machine. Lead, the project's orchestrator, hands Q its tasks through the run-task route delegate_task
 * uses, with its own token.
 *
 * 1. Lead's first task starts Q's session: the session reads `task`, with that task's ref, Lead as its asker, when
 *    the task entered Q's line and when its turn came, in that order, and no first request at the endpoint (its one
 *    request is given up while held, 2); the ledger's task once its turn opened it; the commit and branch Q's folder
 *    was on.
 * 2. The endpoint pauses (503, Retry-After) and Q's harness gives its model call up while Tars holds it: a request
 *    row with status 499 and a structured cancel, never free text, and no endpoint error counted.
 * 3. Lead's second task, queued behind the first, is taken back by Lead before it starts: the session keeps it as
 *    demand it never served, with its kind (`cancelled`), not Lead's words.
 * 4. Q is stopped: the outcome holds the ledger's task (its id, where it came from, who asked, how it ended) and the
 *    request given up.
 * 5. The branch's pull request is merged: the stand-in gh says so, and the ended session takes it, its change
 *    sequence moved; gh is asked nothing but `pr list --state closed`. macOS and Linux: the stand-in gh is a script
 *    with a shebang, which execFile cannot run on Windows.
 * 6. What leaves: the upload's preview carries every new field and neither task's words; the notice has a line for
 *    each. The first turn carries the first task's ref (added on #675 for the back office's per-task split).
 * The artefact: values.json, the session as exported, the preview, the stand-in endpoint's and gh's logs, the app's log.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000a3';
const Q = 'eeee5555-0000-4000-8000-0000000000a3';
const EP = 'ep-0e2ea3';
const REPO_URL = 'https://github.com/e2e-owner/e2e-probe.git';
const NEW_NOTICE_LINES = [
  'what started each session: you, a task, a channel, a restart, a wake from sleep or a task handed on again, by its kind, and the id of the agent that asked when one did',
  'the tasks each session ran: their ids, where they came from (you, an agent, a channel, Tars), the task they were part of, the agent that asked, and how they ended',
  'the task each turn served, by its reference',
  'when each task reached Tars, was handed to the agent, and sent its first request to the model',
  'the commit and branch each session started from',
  'whether the pull request of a session\'s branch was merged or closed, its number, and when',
  'the tasks taken out of an agent\'s queue before they started, with when and why, by its kind',
  'past the last 50, how many more tasks a session ran and how many more were taken out of its queue',
  'the requests a harness gave up while Tars held them for a paused endpoint',
];

type Row = Record<string, unknown>;

test('a traced session records what started it, its task and its times, its start commit, its pull request, and the demand it never served', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-a3-');
  const project = path.join(home, 'projects', 'probe');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } }).trim();
  git('init', '-q', '-b', 'feat/probe');
  fs.writeFileSync(path.join(project, 'README.md'), 'probe\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', REPO_URL);
  const head = git('rev-parse', 'HEAD');

  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const key = `e2e-endpoint-key-${randomBytes(6).toString('hex')}`;
  const standin = await startStandIn({ key, log: standinLog, failFirst: [503, 503, 503, 503, 503, 503] });

  // The stand-in gh: no closed pull request until the spec says the branch's is merged (the flag file), then one, at
  // the moment it is asked. Every call is logged. A script with a shebang, which execFile cannot run on Windows (as
  // github-watch.test.ts notes for its own): the pull request's step is macOS's and Linux's.
  const prStep = process.platform !== 'win32';
  const ghLog = test.info().outputPath('gh-calls.jsonl');
  const merged = path.join(home, 'pr-merged.flag');
  const gh = path.join(home, 'bin', 'gh');
  fs.mkdirSync(path.dirname(gh), { recursive: true });
  fs.writeFileSync(gh, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'closed' && args[args.indexOf('--repo') + 1] === 'e2e-owner/e2e-probe') {
  const at = new Date().toISOString();
  process.stdout.write(JSON.stringify(fs.existsSync(${JSON.stringify(merged)}) ? [{ number: 42, state: 'MERGED', headRefName: 'feat/probe', mergedAt: at, closedAt: at }] : []));
  process.exit(0);
}
process.stderr.write('stand-in gh: not something Tars asks');
process.exit(1);
`, { mode: 0o755 });

  const agent = (id: string, name: string, extra: Row) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(LEAD, 'Lead', { provider: 'claude', role: 'orchestrator' }),
    agent(Q, 'Q', { provider: 'qwen-code', model: MODEL_ID, endpointId: EP, traces: true, cliPath: fakes['qwen-code'] }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }, null, 2));
  // The endpoint's key, set as the window sets it (the drop file is endpoint_set_key's, traces-native.spec.ts).
  const dropDir = path.join(dir, 'endpoint-keys');
  fs.mkdirSync(dropDir, { recursive: true });

  const port = apiPort(31970);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  const fakeEntries = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Row[];
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as string[][];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_PR_EVERY_MS: '500', ...(prStep ? { DOROTHY_E2E_GH: gh } : {}) },
    });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const evaluate = <T>(fn: string, arg: Row = {}) => app!.evaluate(({}, { fn, arg, dist }) => {
      const req = process.mainModule!.require;
      return new Function('req', 'dist', 'arg', fn)(req, dist, arg);
    }, { fn, arg, dist }) as Promise<T>;

    // Lead, with its own token, on the routes its tools call (mcp-shared/src/tars-api.ts sends these headers).
    const token = await evaluate<string>(`return req(dist + '/core/agent-tokens.js').mintRunToken(arg.lead).token;`, { lead: LEAD });
    const api = async (method: string, url: string, body?: Row) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': LEAD, 'X-Tars-Client': 'mcp', 'X-Tars-Caller-Project': project, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) as Row };
    };
    // The endpoint's key, from the drop file, as endpoint_set_key sets it.
    fs.writeFileSync(path.join(dropDir, 'remote.key'), `${key}\n`);
    const setKey = await api('POST', `/api/endpoints/${EP}/key`, { keyFile: 'remote.key' });
    keep({ setKey });
    expect(setKey.status, `the key: ${JSON.stringify(setKey.body)}`).toBeLessThan(300);

    // 1 and 2. Lead's first task starts Q's session; its model call is given up while the endpoint pauses.
    const first = await api('POST', `/api/agents/${Q}/run-task`, { task: 'Run the probe and report what it printed. GIVE UP AFTER 2500', answer: 'started' });
    const ref1 = String(first.body.taskId ?? '');
    keep({ first });
    expect(first.status, `run-task: ${JSON.stringify(first.body)}`).toBeLessThan(300);
    expect(ref1).toMatch(/^t-[0-9a-f]{8}$/);
    await expect.poll(() => fakeEntries().some(e => e.launch && e.agent === Q), { timeout: 30_000 }).toBe(true);

    // 3. Lead's second task waits behind the first, and Lead takes it back before it starts.
    const second = await api('POST', `/api/agents/${Q}/run-task`, { task: 'SECOND-TASK-WORDS: then run the other probe.', answer: 'started' });
    const ref2 = String(second.body.taskId ?? '');
    const cancelled = await api('POST', `/api/tasks/${ref2}/cancel`, { reason: 'LEAD-REASON-WORDS: not needed after all' });
    keep({ second, cancelled });
    expect.soft(second.body.outcome, 'the second task was queued').toBe('queued');
    expect.soft(cancelled.status, `the cancel: ${JSON.stringify(cancelled.body)}`).toBeLessThan(300);

    await expect.poll(() => fakeEntries().some(e => e.gaveUp && e.agent === Q), { timeout: 30_000 }).toBe(true);
    // Its turn ends (the harness answered that it gave up): the ledger's task ends with it.
    const ledgerTask = `const t = req(dist + '/services/task-ledger.js').liveTaskLedger()?.tasks().filter(x => x.agentId === arg.q); return t && t.length ? t[t.length - 1].outcome : null;`;
    await expect.poll(() => evaluate<string | null>(ledgerTask, { q: Q }), { timeout: 30_000 }).toMatch(/completed|error|stopped/);

    // 4. Q stopped: its session ends.
    await page.evaluate((id) => (window as unknown as { electronAPI: { agent: { stop: (id: string) => Promise<unknown> } } }).electronAPI.agent.stop(id), Q);
    const traceIdOf = `const s = req(dist + '/services/traces-runtime.js').traceStore().list({ agentId: arg.q }).sessions; return s.length ? s[s.length - 1].traceId : null;`;
    await expect.poll(() => evaluate<string | null>(traceIdOf, { q: Q }), { timeout: 30_000 }).toBeTruthy();
    const traceId = (await evaluate<string>(traceIdOf, { q: Q }))!;
    const sessionOf = `return req(dist + '/services/traces-runtime.js').traceStore().session(arg.id);`;
    await expect.poll(async () => ((await evaluate<Row>(sessionOf, { id: traceId }))?.session as Row | undefined)?.endedAt, { timeout: 30_000 }).toBeTruthy();
    const seqOf = `return req(dist + '/services/traces-runtime.js').traceStore().seqOf(arg.id);`;
    // The session's change sequence once its end is written: until the flag, gh has no closed pull request to give.
    const seqAtEnd = await evaluate<number>(seqOf, { id: traceId });

    // 5. The branch's pull request is merged now, read by the stand-in gh, into the ended session. Waited for without
    // a throw, so that a build without it fails on every field below, not on this one alone.
    let seqAfterPr = seqAtEnd;
    if (prStep) {
      fs.writeFileSync(merged, '1');
      for (const until = Date.now() + 30_000; Date.now() < until;) {
        if (((await evaluate<Row>(sessionOf, { id: traceId }))?.outcome as Row | undefined)?.pr) break;
        await new Promise(r => setTimeout(r, 300));
      }
      seqAfterPr = await evaluate<number>(seqOf, { id: traceId });
    }

    const session = await evaluate<Row & { start?: Row; outcome?: Row; lostDemand?: Row[]; turns: Array<{ requests: Row[]; taskRef?: string }> }>(sessionOf, { id: traceId });
    const requests = session.turns.flatMap(t => t.requests);
    const start = session.start ?? {};
    const outcome = session.outcome ?? {};
    const task = (outcome.task ?? {}) as Row;
    const exported = await evaluate<string[]>(`return [...req(dist + '/services/trace-export.js').traceExportLines(req(dist + '/services/traces-runtime.js').traceStore(), {})];`);
    fs.writeFileSync(test.info().outputPath('trace-export.jsonl'), `${exported.join('\n')}\n`);
    const preview = await evaluate<{ document: { batches: Array<{ body: { sessions: Row[]; requests: Row[] } }> } } | null>(`return req(dist + '/services/traces-runtime.js').previewUpload(arg.id);`, { id: traceId });
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), JSON.stringify(preview, null, 2));
    const sent = preview?.document.batches[0]?.body;
    const notice = await page.evaluate(() => (window as unknown as { electronAPI: { traces: { uploadNotice: () => Promise<{ leaves: string[] }> } } }).electronAPI.traces.uploadNotice());
    keep({ ref1, ref2, head, traceId, start, outcome, lostDemand: session.lostDemand ?? null, requests: requests.map(r => ({ status: r.status, attempts: r.attempts, cancel: r.cancel ?? null, error: r.error ?? null })), seqAtEnd, seqAfterPr, ghCalls: ghCalls(), sentSession: sent?.sessions?.[0] ?? null, sentRequestCancels: sent?.requests?.map(r => r.cancel ?? null) ?? null, notice: notice.leaves });

    // 1. What started it, and when.
    expect.soft(start, 'the start').toMatchObject({ trigger: 'task', via: 'api', taskRef: ref1, requesterAgentId: LEAD, commit: head, branch: 'feat/probe' });
    expect.soft(typeof start.taskId, 'the ledger\'s task, named').toBe('string');
    const [queuedAt, handedAt] = [start.queuedAt, start.handedAt].map(Number);
    expect.soft([queuedAt, handedAt].every(Number.isFinite), `the queue times ${queuedAt} ${handedAt}`).toBe(true);
    expect.soft(queuedAt <= handedAt, `queued ${queuedAt}, handed ${handedAt}`).toBe(true);
    // The session's one request was given up while held: it never reached the endpoint, so the session has no first
    // request (the Audit's L2 on #675).
    expect.soft(start.firstRequestAt, 'a first request, from the one that never reached the endpoint').toBeUndefined();

    // 2. The request given up while held.
    const givenUp = requests.filter(r => r.cancel);
    expect.soft(givenUp, 'the request given up while held').toEqual([expect.objectContaining({ status: 499, cancel: expect.objectContaining({ by: 'harness', cause: 'abandoned_while_held', deliveredBytes: 0 }) })]);
    expect.soft(Number(givenUp[0]?.attempts ?? 0), 'held at least once').toBeGreaterThan(1);

    // 3. The demand it never served.
    expect.soft(session.lostDemand, 'the task taken back').toEqual([expect.objectContaining({ kind: 'queue_drop', ref: ref2, reason: 'cancelled' })]);

    // The session started on the first task: its first turn carries that task's ref, which survives the outcome's cap.
    expect.soft(session.turns[0]?.taskRef, 'the first turn\'s task').toBe(ref1);

    // 4. The outcome: the ledger's task, and the request given up counted apart.
    expect.soft(task, 'the outcome\'s task').toMatchObject({ id: start.taskId, ref: ref1, source: 'agent', requesterAgentId: LEAD });
    expect.soft(['completed', 'error', 'stopped']).toContain(task.status);
    expect.soft(outcome, 'the outcome').toMatchObject({ abandonedWhileHeld: 1, requestErrors: 0, branch: 'feat/probe', head });

    // 5. The pull request, its change sequence moved, and gh asked nothing else.
    if (prStep) {
      expect.soft(outcome.pr, 'the pull request').toMatchObject({ number: 42, state: 'merged' });
      expect.soft(seqAfterPr, 'the change sequence after the pull request').toBeGreaterThan(seqAtEnd);
      expect.soft(ghCalls().length, 'gh was asked').toBeGreaterThan(0);
      for (const args of ghCalls()) expect.soft(args.slice(0, 2).concat(args[args.indexOf('--state') + 1]), `gh ${args.join(' ')}`).toEqual(['pr', 'list', 'closed']);
    }

    // 6. What leaves, and the notice's lines.
    expect.soft(sent?.sessions?.[0], 'the preview\'s session').toMatchObject({
      start: expect.objectContaining({ trigger: 'task', taskRef: ref1, commit: head }),
      lostDemand: [expect.objectContaining({ kind: 'queue_drop', reason: 'cancelled' })],
      outcome: expect.objectContaining({ task: expect.objectContaining({ ref: ref1 }), ...(prStep ? { pr: expect.objectContaining({ number: 42, state: 'merged' }) } : {}) }),
    });
    expect.soft(sent?.requests?.some(r => (r.cancel as Row | undefined)?.cause === 'abandoned_while_held'), 'the preview\'s request cancel').toBe(true);
    const leaving = JSON.stringify(preview);
    expect.soft(leaving, 'a task\'s words in the preview').not.toContain('SECOND-TASK-WORDS');
    expect.soft(leaving, 'the asker\'s reason in the preview').not.toContain('LEAD-REASON-WORDS');
    for (const line of NEW_NOTICE_LINES) expect.soft(notice.leaves, 'the notice').toContain(line);

    await page.screenshot({ path: test.info().outputPath('window.png') });
  } finally {
    await app?.close();
    await standin.close();
  }
});
