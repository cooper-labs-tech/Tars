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
 * What each traced turn changed in the repository, and how much of it lasted (trace feature B1), in the real app.
 *
 * Q is a qwen-code agent (the qwen stand-in of e2e/fake-clis.mjs) on an inference endpoint, traced, working in a git
 * repository on a branch of its own. The endpoint is a stand-in here: to an instruction carrying `FILES:<json>` it
 * answers with a call to the harness's shell tool, `tars-fake-files <json>`, which the stand-in CLI runs for real
 * (writes, deletes, a commit); after the tool's result it answers "done". It answers 400 ms after each request, as a
 * model would, which is the time the turn's start snapshot has before the tool runs. Three turns: the first commits
 * two files, the second edits one without committing, the third takes the second's lines back. Then Q is stopped,
 * its branch merged into main, where a line is edited, and the sweep's step measures survival again.
 *
 * How it can fail, written before it ran (27/11):
 * 1. A turn has no workspace record in the read API's session document, or its start or end head is not the commit
 *    the repository was on (the start is read before the turn's tools ran, the end before the next turn's request).
 * 2. A turn's files or lines are miscounted, across a commit and a dirty edit.
 * 3. At the session's end, survival is missing or wrong: lines the third turn took back count as surviving, the
 *    second turn is not `reverted`.
 * 4. After the merge, survival is not measured again on main, or the session's change sequence does not move, so a
 *    reader of the sessions feed never sees it.
 * 5. Tars's own reads write into the repository's .git (an object, the index, a lock) while it measures.
 * 6. The upload preview carries a path or a line of content, or misses the turn's numbers.
 * 7. An uncaught error in the page.
 * The artefact: values.json (the session document's turns, the feed, the preview's turns, .git before and after),
 * the endpoint stand-in's request log, the stand-in CLI's log, a screenshot per step, the app's log.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000b1';
const EP = 'ep-0e2eb1';
const MODEL = 'stand-in-coder';
const files = (job: Record<string, unknown>) => `FILES:${Buffer.from(JSON.stringify(job)).toString('base64url')}`;
type Ws = Record<string, unknown> | null;
type Doc = { turns: Array<{ turn_index: number; workspace: Ws }> };

test('each traced turn records what it changed in the repository, and how much of it lasted', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-turn-workspace-'));
  const project = path.join(home, 'projects', 'project-a');
  const dataDir = path.join(home, '.tars');
  for (const d of [project, dataDir]) fs.mkdirSync(d, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=owner', '-c', 'user.email=owner@example.com', '-c', 'commit.gpgSign=false', ...args], { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'readme.md'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'c0');
  git('checkout', '-q', '-b', 'feat/x');
  const c0 = git('rev-parse', 'HEAD');
  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');

  // The endpoint stand-in: a tool call for a FILES instruction, "done" after a tool's result, 400 ms after each request.
  const requests: Array<{ at: string; tool: boolean; files: boolean }> = [];
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
      requests.push({ at: new Date().toISOString(), tool: afterTool, files: !!job });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: 'chatcmpl-ws', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
        const sse = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (job && !afterTool) {
          sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'run_shell_command', arguments: JSON.stringify({ command: `tars-fake-files ${job[1]}` }) } }] }, finish_reason: null }] });
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

  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: Q, name: 'Q', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    provider: 'qwen-code', model: MODEL, endpointId: EP, traces: true, cliPath: fakes['qwen-code'],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false,
    inferenceEndpoints: [{ id: EP, name: 'Stand-in', baseUrl, allowTraces: true, approved: true, approvedBaseUrl: baseUrl, models: [MODEL] }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }], uploadUrl: '' },
  }, null, 2));

  const port = apiPort(31968);
  const values: Record<string, unknown> = { c0 };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const dist = path.resolve('electron', 'dist');
  const runtime = `${dist}/services/traces-runtime.js`;
  const answers = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: { answer?: string }) => typeof e.answer === 'string').length : 0);
  const until = async <T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms: number, what: string): Promise<T> => {
    const end = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < end) { await new Promise(r => setTimeout(r, 250)); v = await read(); }
    if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    return v;
  };
  /** Every path, size, time and mode under the repository's .git: any write shows. */
  const dotGit = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const st = fs.lstatSync(full);
        out[path.relative(project, full)] = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
        if (e.isDirectory()) walk(full);
      }
    };
    walk(path.join(project, '.git'));
    return out;
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

    // Three turns.
    const turn1 = files({ write: { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\nb2\n' }, commit: 'c1' });
    await api('agent', 'start', { id: Q, prompt: `turn one ${turn1}` });
    await until(answers, n => n >= 1, 60_000, 'the first turn');
    const c1 = git('rev-parse', 'HEAD');
    await api('agent', 'sendInput', { id: Q, input: `turn two ${files({ write: { 'a.txt': 'a1\na3\nn1\nn2\n' } })}\r` });
    await until(answers, n => n >= 2, 60_000, 'the second turn');
    await api('agent', 'sendInput', { id: Q, input: `turn three ${files({ write: { 'a.txt': 'a1\na3\n' } })}\r` });
    await until(answers, n => n >= 3, 60_000, 'the third turn');
    await stepShot(page, '01-three-turns');
    await api('agent', 'stop', Q);

    const sessions = await until(() => read('/api/traces/sessions'), s => (s.sessions as unknown[] ?? []).length > 0, 20_000, 'the session');
    const traceId = String((sessions.sessions as Array<{ traceId: string }>)[0].traceId);
    const doc = await until(() => read(`/api/traces/sessions/${traceId}`) as Promise<unknown> as Promise<Doc>,
      d => (d.turns ?? []).length === 3 && d.turns.every(t => t.workspace?.survival_basis === 'session_end'), 30_000, 'the survival at the end');
    const ws = doc.turns.map(t => t.workspace!);
    keep({ c1, traceId, endTurns: ws });
    // 1 and 2.
    expect(ws.map(w => w.start_head), 'each turn\'s start head').toEqual([c0, c1, c1]);
    expect(ws.map(w => w.end_head), 'each turn\'s end head').toEqual([c1, c1, c1]);
    expect(new Set(ws.map(w => w.end_tree)).size, 'three different trees').toBe(3);
    expect(ws.map(w => [w.files, w.lines_added, w.lines_removed]), 'files, lines added, lines removed').toEqual([[2, 5, 0], [1, 2, 1], [1, 0, 2]]);
    // 3.
    expect(ws.map(w => [w.changed_lines, w.survived_lines, w.reverted]), 'survival at the end').toEqual([[5, 4, false], [2, 0, true], [0, null, false]]);

    // 4 and 5. Merged into main, where a line is then edited; the sweep's step measures survival again.
    const cursor = String((await read('/api/traces/sessions')).nextCursor);
    git('commit', '-q', '-am', 'c2');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge feat/x', 'feat/x');
    fs.writeFileSync(path.join(project, 'a.txt'), 'a1 edited\na3\n');
    git('commit', '-q', '-am', 'edit on main');
    const before = dotGit();
    await app.evaluate((_e, r) => process.mainModule!.require(r).finalizeWorkspaces(), runtime);
    const after = dotGit();
    const merged = await read(`/api/traces/sessions/${traceId}`) as unknown as Doc;
    const again = await read(`/api/traces/sessions?cursor=${encodeURIComponent(cursor)}`);
    keep({ mergedTurns: merged.turns.map(t => t.workspace), feedAfterMerge: again, dotGitChanged: Object.keys(after).filter(k => after[k] !== before[k]).concat(Object.keys(before).filter(k => !(k in after))) });
    expect.soft(after, 'Tars\'s reads wrote nothing under .git').toEqual(before);
    expect(merged.turns.map(t => [t.workspace?.survived_lines, t.workspace?.survival_basis]), 'survival on main').toEqual([[3, 'merged'], [0, 'merged'], [null, 'merged']]);
    expect((again.sessions as Array<{ traceId: string }>).map(s => s.traceId), 'the session is new to a reader again').toContain(traceId);

    // 6. The upload preview: numbers and hashes only.
    const preview = await api<{ document: { batches: Array<{ body: { turns: Array<Record<string, unknown>> } }> } }>('traces', 'preview', traceId);
    const sent = JSON.stringify(preview.document.batches);
    const upTurns = preview.document.batches.flatMap(b => b.body.turns);
    keep({ previewTurns: upTurns });
    for (const word of ['a.txt', 'b.txt', 'a1\\n']) expect.soft(sent, `the preview holds "${word}"`).not.toContain(word);
    expect.soft(upTurns[0], 'the first turn\'s numbers in the upload').toMatchObject({ startHead: c0, endHead: c1, filesChanged: 2, linesAdded: 5, linesRemoved: 0, changedLines: 5, survivedLines: 3, survivalBasis: 'merged' });

    await page.goto(`${DEV_URL}/traces`, { waitUntil: 'domcontentloaded' });
    await stepShot(page, '02-traces-page');
    keep({ endpointRequests: requests, errors });
    expect(errors, 'uncaught errors in the page').toEqual([]);
  } finally {
    if (app) await app.close().catch(() => {});
    if (fs.existsSync(fakeLog)) fs.copyFileSync(fakeLog, test.info().outputPath('fake-cli.jsonl'));
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await removeHome(home);
  }
});
