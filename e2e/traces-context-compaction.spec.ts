import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The harness's context settings and its compactions, in the real app (trace feature C2). An endpoint whose owner set
 * its context window (8,000 tokens) and its output cap (700) in the window; C, a codex agent on it, traced (the fake
 * codex of e2e/fake-codex.mjs, which compacts as codex 0.163 was measured to on 27/11: after a tool call, a call of its
 * own with no tools asking for a summary, a `compacted` line in its rollout, then a history of the task and the summary
 * as a new user message). C's task says COMPACT TWICE. Asserted:
 * 1. Codex is started with the endpoint's limits (`-c model_context_window=8000`, `-c model_max_output_tokens=700`), and
 *    the session says what it was given: the window, the cap, auto-compaction on.
 * 2. The two compactions stay inside the task's one turn: the summary messages open no turn.
 * 3. The two requests after a compaction are marked (`contextReset`, kind compact, the tokens dropped), the two
 *    compaction calls are side requests.
 * 4. Once the terminal has exited, the session's compactions are the ones codex logged (source harness, the prompt's
 *    length before and after, from its rollout), each tied to its marked request.
 * 5. The export and the upload's preview carry all of it.
 * The artefact: values.json, the stand-in's request log, the export, the preview, the fake codex's log and rollout,
 * the app's log.
 */

const C = 'eeee5555-0000-4000-8000-0000000000e5';
const EP = 'ep-0e2e03';
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Request = Record<string, unknown> & { startedAt: number; side: boolean; contextReset?: { kind: string; droppedTokens?: number }; requestId: string };
type SessionView = { session: Record<string, unknown> & { traceId: string; agentId: string; endedAt?: number; turnCount: number; unknownTurns: number }; turns: Array<{ requests: Request[] }> };

test('the endpoint\'s limits reach codex, and its compactions are kept inside the turn, marked, and read from its log', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-ctx-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['codex']);
  const codexLog = path.join(home, 'fake-codex.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const standin = await startStandIn({ log: standinLog, usageFromInput: true });

  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: C, name: 'C', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', provider: 'codex', model: MODEL_ID,
    endpointId: EP, traces: true, cliPath: fakes.codex,
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex: fakes.codex },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30, contextWindow: 8000, maxOutputTokens: 700 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'codex', models: '*' }] },
  }, null, 2));

  const port = apiPort(31974);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, any>>;
  const soft = expect.configure({ soft: true });
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    const sessionOfC = async () => {
      const list = await api<{ sessions: Array<{ traceId: string; agentId: string }> }>('traces', 'list', {});
      const s = list.sessions.find(x => x.agentId === C);
      return s ? api<SessionView>('traces', 'session', s.traceId) : undefined;
    };

    await api('agent', 'start', { id: C, prompt: 'Run the probe and report what it printed. COMPACT TWICE' });
    // Three model calls, two compaction calls, and the last call with the tool's result: six.
    await expect.poll(() => lines(codexLog).filter(e => e.model === true).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
    await expect.poll(async () => ((await sessionOfC())?.turns ?? []).flatMap(t => t.requests).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(6);

    // 1. What codex was started with, and what the session says.
    const launch = lines(codexLog).find(e => e.launch);
    const argv = (launch?.argv as string[] | undefined) ?? [];
    const open = await sessionOfC();
    keep({ argv, openSession: open?.session });
    soft(argv.join(' '), "codex's launch").toContain('-c model_context_window=8000');
    soft(argv.join(' '), "codex's launch").toContain('-c model_max_output_tokens=700');
    soft(open?.session, 'what the session says codex was given').toMatchObject({ contextWindowGiven: 8000, outputCapGiven: 700, autoCompaction: 'on' });

    // 2 and 3, while the session is open: from the wire.
    const requests = (open?.turns ?? []).flatMap(t => t.requests).sort((a, b) => a.startedAt - b.startedAt);
    keep({ openRequests: requests.map(r => ({ side: r.side, contextReset: r.contextReset ?? null })) });
    // The task came on codex's command line, so its own turn's author is unknown; each summary would open one more.
    soft(open?.session.turnCount, 'one task, one turn').toBe(1);
    soft(requests.map(r => r.side), 'the compaction calls are side requests').toEqual([false, true, false, true, false, false]);
    soft(requests.map(r => r.contextReset?.kind ?? null), 'the requests after a compaction').toEqual([null, null, 'compact', null, 'compact', null]);
    soft(requests.filter(r => r.contextReset).every(r => Number(r.contextReset!.droppedTokens) > 0), 'the tokens each dropped').toBe(true);

    // 4. The terminal exits: codex's log is read.
    await api('agent', 'stop', C);
    await expect.poll(async () => (await sessionOfC())?.session.endedAt ?? null, { timeout: 30_000 }).not.toBeNull();
    await soft.poll(async () => ((await sessionOfC())?.session.compactions as unknown[] | undefined)?.length ?? 0, { timeout: 15_000, message: 'the compactions read' }).toBe(2);
    const ended = await sessionOfC();
    const compactions = (ended?.session.compactions as Array<Record<string, unknown>> | undefined) ?? [];
    const marked = (ended?.turns ?? []).flatMap(t => t.requests).filter(r => r.contextReset).sort((a, b) => a.startedAt - b.startedAt);
    const usage = lines(codexLog).filter(e => e.model === true);
    keep({ compactions, marked: marked.map(r => ({ requestId: r.requestId, contextReset: r.contextReset })), modelCalls: usage.length });
    soft(compactions.map(c => [c.kind, c.source]), "codex's compactions").toEqual([['compact', 'harness'], ['compact', 'harness']]);
    soft(compactions.map(c => c.requestId), 'each tied to its marked request').toEqual(marked.map(r => r.requestId));
    soft(compactions.every(c => Number(c.before) > Number(c.after) && Number(c.after) > 0), 'the prompt before and after, from the rollout').toBe(true);

    // 5. The export and the preview.
    const held = await app.evaluate((_e, { dist, traceId }) => {
      const req = process.mainModule!.require;
      const runtime = req(`${dist}/services/traces-runtime.js`);
      return {
        exported: [...req(`${dist}/services/trace-export.js`).traceExportLines(runtime.traceStore(), {})] as string[],
        preview: JSON.stringify(runtime.traceUploader().preview(traceId)),
      };
    }, { dist, traceId: ended!.session.traceId });
    fs.writeFileSync(test.info().outputPath('traces-export.jsonl'), `${held.exported.join('\n')}\n`);
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), held.preview);
    const exported = held.exported.map(l => JSON.parse(l));
    const trace = exported.find(l => l.table === 'traces');
    soft(trace, 'the exported session').toMatchObject({ context_window_given: 8000, output_cap_given: 700, auto_compaction: 'on' });
    soft((trace?.compactions ?? []).length, 'the exported compactions').toBe(2);
    soft(exported.filter(l => l.table === 'requests' && l.context_reset).length, 'the exported resets').toBe(2);
    const body = JSON.parse(held.preview) as { document: { batches: Array<{ body: { sessions: Array<Record<string, unknown>>; requests: Array<Record<string, unknown>> } }> } };
    const sent = body.document.batches.flatMap(b => b.body.sessions)[0] ?? {};
    soft(sent, 'the preview\'s session').toMatchObject({ contextWindowGiven: 8000, outputCapGiven: 700, autoCompaction: 'on' });
    soft(body.document.batches.flatMap(b => b.body.requests).filter(r => r.contextReset).length, 'the preview\'s resets').toBe(2);
  } finally {
    await app?.close().catch(() => {});
    await standin.close();
    if (fs.existsSync(codexLog)) fs.copyFileSync(codexLog, test.info().outputPath('fake-codex.jsonl'));
    const sessions = path.join(home, '.codex', 'sessions');
    if (fs.existsSync(sessions)) fs.cpSync(sessions, test.info().outputPath('codex-sessions'), { recursive: true });
    removeHome(home);
  }
});
