import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';

/**
 * A load task's setup and test, its trace's tags, and the disk floor (trace feature C3, part 3, 28/11): the real app, a
 * small git project whose remote names a public repository on GitHub (a stand-in gh answers), an inference endpoint
 * stood in on loopback whose model asks the session to write a file, and Qwen Code stood in (e2e/fake-clis.mjs). A
 * minute of the window's clocks is a second (DOROTHY_E2E_LOAD_MINUTE_MS): a 10-minute cap is 10 s. The heavy-run slot
 * holds one run, and its floors are lowered so a busy machine does not decide; a token is planted in the app's
 * environment, as when Tars runs inside an agent's terminal.
 *
 * Five windows, one after the other, one arrival each:
 * 1. A setup line (writes a file, and the environment it saw, outside the worktree) and a test that passes on that
 *    file: the setup passed, the session's diff stat counts what the model wrote and not the setup's file, the test
 *    passed, and the setup saw neither the planted token nor anything of Tars's.
 * 2. A test that exits 3: failed, exit code 3.
 * 3. The slot held by the spec through the session: the test waits its cap (10 s) and is not run, `heavy_slot`; the
 *    window goes on to its end, no failure.
 * 4. The slot still held, a task with a setup line: blocked `heavy_slot`, never queued, no worktree.
 * 5. The disk floor raised above the machine's free disk: the window stops, `disk_floor`, with its reason.
 * And the traces of windows 1 to 3 carry `load:<run>`, their task, split, train_ok, diff stat and test.
 * Red on #691 (21bccb635): no setup runs and no test either.
 * The artefact: values.json, each run's log, the fake CLI's log, the endpoint's requests, the app's log.
 */

type Row = Record<string, unknown>;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

test('a load task\'s setup and test run under the heavy-run slot, its trace is tagged, and the window stops at the disk floor', async () => {
  test.setTimeout(5 * 60_000);
  test.skip(process.platform === 'win32', 'the stand-in gh, the fake CLI and the setup lines are POSIX scripts');
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-load-steps-');
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
  const project = path.join(home, 'projects', 'steps-app');
  fs.mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), 'steps-app\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'github', 'https://github.com/e2e-owner/e2e-steps-app.git');
  const head = git(project, 'rev-parse', 'HEAD');

  const gh = path.join(home, 'bin', 'gh');
  fs.mkdirSync(path.dirname(gh), { recursive: true });
  fs.writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'e2e-owner/e2e-steps-app') { process.stdout.write(JSON.stringify({ visibility: 'PUBLIC' })); process.exit(0); }
process.stderr.write('stand-in gh: not something Tars asks');
process.exit(1);
`, { mode: 0o755 });

  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standin = await startStandIn({ log: test.info().outputPath('endpoint-requests.jsonl'), command: 'echo done > agent-change.txt' });
  const EP = 'ep-0e2e2b';
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
    // One heavy run at a time, so the spec can hold the slot; floors a busy machine does not reach.
    heavySlots: 1, heavySlotMinDiskGb: 1, heavySlotMinFreeMemPct: 1,
  }, null, 2));
  const setupEnv = path.join(home, 'setup-env.txt');

  const port = apiPort(31979);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_E2E_GH: gh,
        DOROTHY_E2E_LOAD_MINUTE_MS: '1000',
        // As when Tars runs inside an agent's terminal: no step may see it.
        CLAUDE_MGR_API_TOKEN: 'planted-load-token',
      },
    });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(async ({ group, name, args }) => {
        try { return await ((window as unknown as Api).electronAPI[group][name])(...args); } catch (err) { return { thrown: String(err) }; }
      }, { group, name, args }) as Promise<T>;
    const load = <T>(name: string, ...args: unknown[]) => api<T>('load', name, ...args);
    const record = (runId: string) => JSON.parse(fs.readFileSync(path.join(dir, 'load-runs', runId, 'run.json'), 'utf8')) as Row & { arrivals: Row[] };
    const arrival = (runId: string) => record(runId).arrivals.find(a => a.n === 1);
    const slot = (what: 'take' | 'give', id?: string) => app!.evaluate(async ({}, { dist, project, what, id }) => {
      const s = process.mainModule!.require(`${dist}/services/heavy-slot-runtime.js`);
      if (what === 'give') return s.giveSlotBack(id, 'e2e-holder');
      const v = await s.askSlot({ agentId: 'e2e-holder', agentName: 'E2E holder', projectPath: project, pid: process.pid, priority: 'normal', label: 'the spec holds the slot', orchestrator: false });
      return { id: v.id, state: v.state };
    }, { dist, project, what, id }) as Promise<{ id: string; state: string } | boolean>;

    const granted = await load<Row & { project?: Row }>('grant', { path: project, enabled: true, allowedByName: false, endpointId: EP, model: MODEL_ID, harnesses: ['qwen-code'] });
    expect(granted.project?.state, JSON.stringify(granted)).toBe('allowed');

    /** A window of one task, one arrival at its start: approved, and its run id. */
    async function windowOf(pool: string, fields: Row): Promise<string> {
      const poolDir = path.join(dir, 'load-pools', pool);
      fs.mkdirSync(poolDir, { recursive: true });
      fs.writeFileSync(path.join(poolDir, 'window.json'), JSON.stringify({ rate_per_hour: 1, seed: 1, window_min: 60, max_concurrent: 1, initial_sessions: 1 }));
      fs.writeFileSync(path.join(poolDir, 'tasks.jsonl'), `${JSON.stringify({
        task_id: pool, project, repo: 'e2e-owner/e2e-steps-app', base_commit: head, prompt: 'Write your change.', setup: [], test_cmd: null,
        time_cap_min: 10, harnesses: ['qwen-code'], weight: 1, max_runs: 1, split: 'train', train_ok: true, ...fields,
      })}\n`);
      const state = await expect.poll(async () => (await load<{ proposal?: Row }>('state')).proposal ?? null, { timeout: 20_000 }).not.toBeNull()
        .then(() => load<{ proposal?: Row }>('state'));
      expect(state.proposal?.pool, JSON.stringify(state)).toBe(pool);
      const approved = await load<Row>('approve', { pool, sha256: state.proposal!.sha256, proposalId: state.proposal!.id, window: {} });
      expect(approved.ok, JSON.stringify(approved)).toBe(true);
      return String(approved.runId);
    }

    // 1. A setup line and a test that passes on what it wrote.
    const run1 = await windowOf('with-setup', {
      setup: [`env > ${JSON.stringify(setupEnv)} && echo ok > setup-ran.txt`], test_cmd: 'test -f setup-ran.txt', split: 'heldout', train_ok: false,
    });
    await expect.poll(() => arrival(run1)?.test ?? null, { timeout: 90_000 }).not.toBeNull();
    const first = arrival(run1)!;
    const seen = fs.existsSync(setupEnv) ? fs.readFileSync(setupEnv, 'utf8') : '';
    keep({ first, setupSawTarsToken: seen.includes('planted-load-token'), setupSawTarsVars: seen.split('\n').filter(l => /^(CLAUDE_MGR_|TARS_|DOROTHY_)/.test(l)).map(l => l.split('=')[0]) });
    expect.soft(first, 'the first task').toMatchObject({ end: 'done', setup: { result: 'passed', lines: 1 }, test: { result: 'passed', exitCode: 0 }, diffStat: { files: 1, insertions: 1, deletions: 0 } });
    expect.soft(seen, 'the setup ran').toContain('CI=1');
    expect.soft(values.setupSawTarsToken, 'the planted token in the setup').toBe(false);
    expect.soft(values.setupSawTarsVars, 'Tars\'s variables in the setup').toEqual([]);
    expect(await load<Row>('stop', run1)).toMatchObject({ ok: true });

    // 2. A test that fails.
    const run2 = await windowOf('failing-test', { test_cmd: 'exit 3' });
    await expect.poll(() => arrival(run2)?.test ?? null, { timeout: 90_000 }).not.toBeNull();
    keep({ second: arrival(run2) });
    expect.soft(arrival(run2), 'the second task').toMatchObject({ end: 'done', test: { result: 'failed', exitCode: 3 } });
    expect(await load<Row>('stop', run2)).toMatchObject({ ok: true });

    // 3. The slot held through the session: the test waits its cap and is not run.
    const held = await slot('take') as { id: string; state: string };
    expect(held.state, 'the spec holds the slot').toBe('granted');
    const run3 = await windowOf('slot-held', { test_cmd: 'true' });
    await expect.poll(() => arrival(run3)?.test ?? null, { timeout: 90_000 }).not.toBeNull();
    keep({ third: arrival(run3) });
    expect.soft(arrival(run3), 'the third task').toMatchObject({ end: 'done', test: { result: 'not_run', reason: 'heavy_slot' } });
    expect.soft(Number((arrival(run3)!.test as Row).slotWaitMs), 'its wait, the cap of 10 load minutes').toBeGreaterThanOrEqual(9_000);
    expect.soft(record(run3).stop ?? null, 'no stop of the window for it').toBeNull();
    expect(await load<Row>('stop', run3)).toMatchObject({ ok: true });

    // 4. The slot still held: a task with a setup line is blocked heavy_slot, never queued.
    const run4 = await windowOf('setup-blocked', { setup: ['echo never > ran.txt'], test_cmd: 'true' });
    await expect.poll(() => arrival(run4)?.blocked ?? null, { timeout: 30_000 }).toBe('heavy_slot');
    keep({ fourth: arrival(run4) });
    expect.soft(fs.existsSync(path.join(project, '.worktrees', 'load', run4)), 'a worktree for it').toBe(false);
    expect(await slot('give', held.id)).toBe(true);
    expect(await load<Row>('stop', run4)).toMatchObject({ ok: true });

    // 5. The disk floor above the machine's free disk: the window stops, disk_floor, with its reason.
    await api('appSettings', 'save', { heavySlotMinDiskGb: 1_000_000 });
    const run5 = await windowOf('disk-floor', {});
    await expect.poll(async () => ((await load<{ last?: Row; running?: Row }>('state')).last as Row | undefined)?.runId === run5
      ? ((await load<{ last?: Row }>('state')).last!.stop as Row | undefined)?.reason ?? null : null, { timeout: 30_000 }).toBe('disk_floor');
    const stopped = (await load<{ last?: Row }>('state')).last!.stop as Row;
    keep({ fifth: { stop: stopped, arrival: arrival(run5) ?? null } });
    expect.soft(String(stopped.detail), 'its reason').toMatch(/GB free, under the 1000000 GB floor/);

    // The traces of windows 1 to 3: tagged with their run, task, split, train_ok, diff stat and test.
    const loadId = (first.agentId as string);
    const tags = await app.evaluate(({}, { dist, agentId }) => {
      const { traceStore } = process.mainModule!.require(`${dist}/services/traces-runtime.js`);
      return traceStore().list({ agentId }).sessions.map((s: Row) => traceStore().session(s.traceId)?.outcome?.load ?? null).filter((l: Row | null) => l && l.tag);
    }, { dist, agentId: loadId }) as Row[];
    keep({ tags });
    expect.soft(tags.find(t => t.runId === run1), 'the first session\'s tags').toMatchObject({
      tag: `load:${run1}`, taskId: 'with-setup', n: 1, split: 'heldout', trainOk: false, diffStat: { files: 1, insertions: 1, deletions: 0 }, test: { result: 'passed' },
    });
    expect.soft(tags.find(t => t.runId === run2), 'the second session\'s tags').toMatchObject({ tag: `load:${run2}`, test: { result: 'failed', exitCode: 3 } });
    expect.soft(tags.find(t => t.runId === run3), 'the third session\'s tags').toMatchObject({ tag: `load:${run3}`, test: { result: 'not_run', reason: 'heavy_slot' } });
    for (const runId of [run1, run2, run3, run4, run5]) {
      if (fs.existsSync(path.join(dir, 'load-runs', runId, 'run.json'))) fs.copyFileSync(path.join(dir, 'load-runs', runId, 'run.json'), test.info().outputPath(`run-${runId}.json`));
    }
    if (fs.existsSync(fakeLog)) fs.copyFileSync(fakeLog, test.info().outputPath('fake-cli.jsonl'));
  } finally {
    await app?.close();
    await standin.close();
  }
});
