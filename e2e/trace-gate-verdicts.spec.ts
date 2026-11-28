import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A gate's verdict as data, linked to the traced turns that made the judged head (trace feature B2), in the real app.
 *
 * Q is a qwen-code agent (the stand-in of e2e/fake-clis.mjs) on an inference endpoint, traced, on a branch of its own:
 * its first turn commits c1, its second commits c2, its third changes nothing (its head stays c2). The endpoint is the
 * stand-in of trace-turn-workspace.spec.ts. G is a claude agent of the same project, the stand-in gate: its turn's
 * text `VERDICT <json>` makes it call Tars's MCP tool record_verdict, as a gating agent does. While Q still runs, it
 * records QA's MERGE on c2 with the branch; then Q's session ends; then G records the Audit's NO-MERGE on c1, and
 * tries a ci of its own.
 *
 * How it can fail, written before it ran (27/11):
 * 1. The tool is missing from Tars's MCP server, or the call is refused for an agent recording in its own name.
 * 2. QA's MERGE on c1 is not in the session's outcome, or lands on another turn than the first (the only one whose
 *    end head is c1), or does not say who recorded it.
 * 3. The session's change sequence does not move, so a reader of the sessions feed never sees the gate.
 * 4. The Audit's NO-MERGE on c2, with the branch, misses a turn: the second and third end on c2, the first on c1, an
 *    ancestor on the branch.
 * 5. The shared token records a verdict (it names no agent).
 * 6. The upload preview carries the gate's report path, or misses the gate.
 * 7. An uncaught error in the page.
 * Added after the Audit's NO-MERGE at a3047a696 (28/11), the flow changed so that G records while Q still runs:
 * 8. QA's MERGE on c2, recorded while Q runs, misses c1's turn (Q's branch is only in the outcome its end writes), or
 *    is wiped when Q's session ends, or the last turn (which ended on c2 too) does not join it at the end.
 * 9. An agent's ci is taken; the recorder's role is not kept, or its name goes up with the upload.
 * The artefact: values.json (the session's outcome after each verdict, the feed, the refused call, the preview's
 * gates), the stand-in CLIs' log, a screenshot per step, the app's log.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000b2';
const G = 'eeee5555-0000-4000-8000-0000000000c2';
const EP = 'ep-0e2eb2';
const MODEL = 'stand-in-coder';
const files = (job: Record<string, unknown>) => `FILES:${Buffer.from(JSON.stringify(job)).toString('base64url')}`;
const verdict = (v: Record<string, unknown>) => `VERDICT ${Buffer.from(JSON.stringify(v)).toString('base64url')}`;
type Gate = Record<string, unknown>;
type Doc = { trace: { ended_at: number | null; outcome: ({ gates?: Gate[] } & Record<string, unknown>) | null }; turns: Array<{ turn_index: number; workspace: Record<string, unknown> | null }> };

test('a gate records its verdict through the tool, and the session shows it on the turns that made the head', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-gate-verdicts-'));
  const project = path.join(home, 'projects', 'project-a');
  const dataDir = path.join(home, '.tars');
  for (const d of [project, dataDir]) fs.mkdirSync(d, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'readme.md'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'c0');
  git('checkout', '-q', '-b', 'feat/x');
  const fakes = writeFakeClis(home, ['qwen-code', 'claude']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const report = path.join(home, 'reports', 'qa-7.md');

  // The endpoint stand-in: a tool call for a FILES instruction, "done" after a tool's result or without one.
  const endpoint = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { messages?: Array<{ role: string; content?: unknown }> };
      const msgs = body.messages ?? [];
      const lastUser = msgs.map(m => m.role).lastIndexOf('user');
      const afterTool = msgs.slice(lastUser + 1).some(m => m.role === 'tool');
      const job = /FILES:(\S+)/.exec(String(msgs[lastUser]?.content ?? ''));
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: 'chatcmpl-gv', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
        const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (job && !afterTool) {
          sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_gv', type: 'function', function: { name: 'run_shell_command', arguments: JSON.stringify({ command: `tars-fake-files ${job[1]}` }) } }] }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] });
          sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        }
        sse({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
        res.end('data: [DONE]\n\n');
      }, 400);
    });
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/v1`;

  const agent = (id: string, name: string, provider: string, more: Record<string, unknown>) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [], provider,
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', ...more,
  });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([
    agent(Q, 'Q', 'qwen-code', { model: MODEL, endpointId: EP, traces: true, cliPath: fakes['qwen-code'] }),
    agent(G, 'G', 'claude', { cliPath: fakes.claude }),
  ], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    inferenceEndpoints: [{ id: EP, name: 'Stand-in', baseUrl, allowTraces: true, approved: true, approvedBaseUrl: baseUrl, models: [MODEL] }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: '' },
  }, null, 2));

  const port = apiPort(31969);
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const logLines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []);
  const answers = (needle?: string) => logLines().filter(e => typeof e.answer === 'string' && (!needle || String(e.answer).includes(needle))).map(e => String(e.answer));
  const until = async <T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < end) { await new Promise(r => setTimeout(r, 250)); v = await read(); }
    if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    return v;
  };

  let app: ElectronApplication | null = null;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/traces`, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const page: Page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.waitForLoadState('domcontentloaded');
    const api = <T>(group: string, name: string, arg?: unknown) => page.evaluate(([g, n, a]) => (window as unknown as { electronAPI: Record<string, Record<string, (v?: unknown) => Promise<unknown>>> }).electronAPI[g as string][n as string](a), [group, name, arg] as const) as Promise<T>;
    const token = String((await api<{ token?: string }>('traces', 'rotateReaderToken')).token);
    const read = async (p: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${token}` } });
      return res.json() as Promise<Record<string, unknown>>;
    };

    // Tars's MCP servers registered in every CLI's configuration, as a packaged Tars does at every start
    // (setupMcpOrchestrator), as e2e/cli-matrix.spec.ts does: a development run finds no bundle under
    // process.resourcesPath, the app's own.
    const resources = path.join(home, 'resources');
    fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
    const dist = path.resolve('electron', 'dist');
    await app.evaluate(async (_e, { resources, dist }) => {
      const was = process.resourcesPath;
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      try {
        await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
      } finally {
        Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
      }
    }, { resources, dist });

    // Q's three turns: c1, c2, then nothing.
    await api('agent', 'start', { id: Q, prompt: `turn one ${files({ write: { 'a.txt': 'a1\na2\n' }, commit: 'c1' })}` });
    await until(() => answers().length, n => n >= 1, 60_000, 'the first turn');
    const c1 = git('rev-parse', 'HEAD');
    await api('agent', 'sendInput', { id: Q, input: `turn two ${files({ write: { 'b.txt': 'b1\n' }, commit: 'c2' })}\r` });
    await until(() => answers().length, n => n >= 2, 60_000, 'the second turn');
    const c2 = git('rev-parse', 'HEAD');
    await api('agent', 'sendInput', { id: Q, input: 'turn three, no change\r' });
    await until(() => answers().length, n => n >= 3, 60_000, 'the third turn');
    // Q keeps running: its last turn's end comes with its session's end.
    const sessions = await until(() => read('/api/traces/sessions'), s => (s.sessions as unknown[] ?? []).length > 0, 20_000, 'the session');
    const traceId = String((sessions.sessions as Array<{ traceId: string }>)[0].traceId);
    const doc = () => read(`/api/traces/sessions/${traceId}`) as Promise<unknown> as Promise<Doc>;
    const running = await until(doc, d => (d.turns ?? []).length === 3 && d.turns.slice(0, 2).every(t => !!t.workspace?.end_head), 30_000, 'the first two turns\' heads');
    expect(running.turns.map(t => t.workspace?.end_head ?? null), 'the heads while Q runs').toEqual([c1, c2, null]);
    const cursor = String((await read('/api/traces/sessions')).nextCursor);
    keep({ c1, c2, traceId });
    await stepShot(page, '01-three-turns');

    // 1 to 3. While Q runs: QA's MERGE on c2, with the branch, recorded by G through the tool.
    await api('agent', 'start', { id: G, prompt: verdict({ gate: 'qa', pr: 7, head: c2, verdict: 'merge', branch: 'feat/x', test_command: 'npm test', passed: 12, failed: 0, report }) });
    const qaAnswer = (await until(() => answers('record_verdict'), a => a.length >= 1, 90_000, 'the gate\'s first call'))[0];
    keep({ qaAnswer });
    expect(qaAnswer, 'the tool\'s answer').toMatch(/^record_verdict recorded: .*linked to 2 traced turn/);
    const afterQa = await until(doc, d => (d.trace.outcome?.gates ?? []).length === 1, 20_000, 'the gate in the outcome');
    keep({ gatesAfterQa: afterQa.trace.outcome?.gates });
    expect(afterQa.trace.outcome?.gates?.[0], 'QA\'s gate while Q runs: c2\'s turn, and c1\'s on the branch').toEqual({
      kind: 'qa', verdict: 'merge', at: expect.any(Number), pr: 7, head: c2, turns: [[0, 1]], by: G, byName: 'G', byRole: 'worker',
      testCommand: 'npm test', passed: 12, failed: 0, report,
    });
    const feed = await read(`/api/traces/sessions?cursor=${encodeURIComponent(cursor)}`);
    keep({ feedAfterQa: feed });
    expect((feed.sessions as Array<{ traceId: string }>).map(s => s.traceId), 'the session is new to a reader again').toContain(traceId);

    // 4. Q's session ends: the gate stays, and the last turn, which ended on c2 too, joins it.
    await api('agent', 'stop', Q);
    const afterEnd = await until(doc, d => !!d.trace.ended_at && JSON.stringify(d.trace.outcome?.gates?.[0]?.turns) === '[[0,2]]', 30_000, 'the gate after the session\'s end');
    keep({ gatesAfterEnd: afterEnd.trace.outcome?.gates, outcomeAfterEnd: afterEnd.trace.outcome });
    expect(afterEnd.trace.outcome, 'the end\'s own outcome kept beside the gate').toMatchObject({ branch: 'feat/x', head: c2 });

    // 5. The Audit's NO-MERGE on c1, no branch: the first turn only.
    await api('agent', 'sendInput', { id: G, input: `${verdict({ gate: 'audit', pr: 7, head: c1, verdict: 'no_merge' })}\r` });
    await until(() => answers('record_verdict'), a => a.length >= 2, 90_000, 'the gate\'s second call');
    const afterAudit = await until(doc, d => (d.trace.outcome?.gates ?? []).length === 2, 20_000, 'the second gate');
    const gates = afterAudit.trace.outcome?.gates ?? [];
    keep({ auditAnswer: answers('record_verdict')[1], gatesAfterAudit: gates });
    expect(gates.find(g => g.kind === 'audit'), 'the Audit\'s gate, on the first turn only').toMatchObject({ verdict: 'no_merge', head: c1, turns: [[0, 0]], by: G });
    expect(gates.find(g => g.kind === 'qa'), 'QA\'s gate unchanged').toMatchObject({ verdict: 'merge', turns: [[0, 2]] });
    await stepShot(page, '02-gates-recorded');

    // 6. ci is Tars's alone: the tool offers none. The shared token names no agent: refused.
    await api('agent', 'sendInput', { id: G, input: `${verdict({ gate: 'ci', pr: 7, head: c2, verdict: 'no_merge' })}\r` });
    const ciAnswer = (await until(() => answers('record_verdict'), a => a.length >= 3, 90_000, 'the gate\'s ci call'))[2];
    keep({ ciAnswer });
    expect(ciAnswer, 'an agent\'s ci').toMatch(/^record_verdict refused/);
    const shared = fs.readFileSync(path.join(home, '.tars-private', 'api-token'), 'utf8').trim();
    const refused = await fetch(`http://127.0.0.1:${port}/api/verdicts`, { method: 'POST', headers: { Authorization: `Bearer ${shared}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ gate: 'qa', pr: 7, head: c2, verdict: 'merge' }) });
    keep({ sharedTokenStatus: refused.status });
    expect(refused.status, 'the shared token').toBe(403);
    expect(((await doc()).trace.outcome?.gates ?? []).length, 'nothing recorded by either').toBe(2);

    // 7. The upload preview: the gates and the recorder's role, never the report's path or the recorder's name.
    const preview = await api<{ document: { batches: Array<{ body: { sessions?: Array<{ outcome?: { gates?: Gate[] } }> } }> } }>('traces', 'preview', traceId);
    // Each batch carries the session's row; the first one is read.
    const upGates = preview.document.batches[0]?.body.sessions?.[0]?.outcome?.gates ?? [];
    keep({ previewGates: upGates });
    expect(upGates.map(g => `${g.kind}:${g.verdict}:${JSON.stringify(g.turns)}:${g.byRole}`).sort(), 'the gates in the upload').toEqual(['audit:no_merge:[[0,0]]:worker', 'qa:merge:[[0,2]]:worker']);
    expect(upGates.some(g => 'byName' in g), 'the recorder\'s name in the upload').toBe(false);
    expect(JSON.stringify(preview.document), 'the report\'s path in the upload').not.toContain('qa-7.md');

    await page.goto(`${DEV_URL}/traces`, { waitUntil: 'domcontentloaded' });
    await stepShot(page, '03-traces-page');
    keep({ errors });
    expect(errors, 'uncaught errors in the page').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    if (fs.existsSync(fakeLog)) fs.copyFileSync(fakeLog, test.info().outputPath('fake-cli.jsonl'));
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await removeHome(home);
  }
});
