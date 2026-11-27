import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';

/**
 * A load window runs (trace feature C3, part 2, 27/11): the real app, a small git project whose remote names a public
 * repository on GitHub (a stand-in gh answers) and whose `origin` is a local bare repository, an inference endpoint
 * stood in on loopback, and Qwen Code stood in (e2e/fake-clis.mjs), which runs a `git push` the model asks for, for
 * real, where its session works.
 *
 * 1. The owner allows the project for qwen-code and writes nothing else: no agent exists.
 * 2. A pool of one task, two runs at the window's start, at most one at a time: the owner approves it.
 * 3. Tars makes the project's load agent, Load 1, a qwen-code agent on the endpoint, `load: true`.
 * 4. The first arrival starts: a worktree at the task's base commit on `load/<run>/<task>-1`, under the project's
 *    `.worktrees`, a fresh session of Load 1 in it. The second is blocked, `max_concurrent`, and never starts.
 * 5. The model asks for `git push origin HEAD:refs/heads/main`: the session's push is refused, and the bare origin
 *    has nothing new.
 * 6. Its turn ends: the arrival ends `done`, the worktree and its branch are gone, the private state names nothing.
 * Red on the base (#685 at d43af8072): nothing runs an approved window.
 * The artefact: values.json, the run's log, the fake CLI's log, the endpoint's requests, the app's log.
 */

type Row = Record<string, unknown>;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };

test('an approved load window starts a fresh session of a load agent per arrival, in its own worktree, its push refused', async () => {
  test.setTimeout(4 * 60_000);
  test.skip(process.platform === 'win32', 'the stand-in gh and the fake CLI are scripts with a shebang');
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-load-runner-');
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
  const project = path.join(home, 'projects', 'load-app');
  const origin = path.join(home, 'remotes', 'origin.git');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(home, 'init', '-q', '--bare', origin);
  git(project, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'README.md'), 'load-app\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', 'origin', 'main');
  git(project, 'remote', 'add', 'github', 'https://github.com/e2e-owner/e2e-load-app.git');
  const head = git(project, 'rev-parse', 'HEAD');

  const ghLog = test.info().outputPath('gh-calls.jsonl');
  const gh = path.join(home, 'bin', 'gh');
  fs.mkdirSync(path.dirname(gh), { recursive: true });
  fs.writeFileSync(gh, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'e2e-owner/e2e-load-app') { process.stdout.write(JSON.stringify({ visibility: 'PUBLIC' })); process.exit(0); }
process.stderr.write('stand-in gh: not something Tars asks');
process.exit(1);
`, { mode: 0o755 });

  const fakes = writeFakeClis(home, ['qwen-code']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const standin = await startStandIn({ log: standinLog, command: 'git push origin HEAD:refs/heads/main' });
  // An id of the shape Tars knows (inference-endpoints.ts): another is no endpoint to it.
  const EP = 'ep-0e2e1a';
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'] },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }] },
  }, null, 2));

  const port = apiPort(31977);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  const fakeEntries = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Row[];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_E2E_GH: gh },
    });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const load = <T>(name: string, ...args: unknown[]) =>
      page.evaluate(async ({ name, args }) => {
        try { return await ((window as unknown as Api).electronAPI.load[name])(...args); } catch (err) { return { thrown: String(err) }; }
      }, { name, args }) as Promise<T>;
    const fleet = () => app!.evaluate(({}, { dist }) => {
      const { agents } = process.mainModule!.require(`${dist}/core/agent-manager.js`);
      return [...agents.values()].map((a: Row) => ({ id: a.id, name: a.name, provider: a.provider, load: a.load ?? null, endpointId: a.endpointId ?? null, worktreePath: a.worktreePath ?? null }));
    }, { dist }) as Promise<Row[]>;

    // 1. The grant, and no agent.
    const granted = await load<Row & { project?: Row }>('grant', { path: project, enabled: true, allowedByName: false, endpointId: EP, model: MODEL_ID, harnesses: ['qwen-code'] });
    keep({ granted: granted.project?.state ?? granted });
    expect(granted.project?.state, JSON.stringify(granted)).toBe('allowed');
    expect(await fleet()).toEqual([]);

    // 2. The pool, approved.
    const poolDir = path.join(dir, 'load-pools', 'runner-pool');
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, 'window.json'), JSON.stringify({ rate_per_hour: 1, seed: 1, window_min: 60, max_concurrent: 1, initial_sessions: 2 }));
    fs.writeFileSync(path.join(poolDir, 'tasks.jsonl'), `${JSON.stringify({
      task_id: 'push-it', project, repo: 'e2e-owner/e2e-load-app', base_commit: head, prompt: 'Push your work.', setup: [], test_cmd: null,
      time_cap_min: 10, harnesses: ['qwen-code'], weight: 1, max_runs: 2, split: 'train', train_ok: true,
    })}\n`);
    const state = await load<{ proposal?: Row }>('state');
    expect(state.proposal?.pool, JSON.stringify(state)).toBe('runner-pool');
    const approved = await load<Row>('approve', { pool: 'runner-pool', sha256: state.proposal!.sha256, proposalId: state.proposal!.id, window: {} });
    keep({ approved });
    expect(approved.ok, JSON.stringify(approved)).toBe(true);
    const runId = String(approved.runId);
    const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'load-runs', runId, 'run.json'), 'utf8')) as Row & { arrivals: Row[] };

    // 3. Load 1, made by Tars.
    await expect.poll(async () => (await fleet()).filter(a => a.load === true).map(a => `${a.name} ${a.provider} ${a.endpointId}`), { timeout: 30_000 })
      .toEqual([`Load 1 qwen-code ${EP}`]);

    // 4 and 5. The first arrival runs in its worktree and its push is refused; the second is blocked.
    const branch = `load/${runId}/push-it-1`;
    const where = path.join(project, '.worktrees', 'load', runId, 'push-it-1');
    await expect.poll(() => fakeEntries().find(e => typeof e.shell === 'string') ?? null, { timeout: 90_000 }).not.toBeNull();
    const push = fakeEntries().find(e => typeof e.shell === 'string')!;
    const blocked = record().arrivals.find(a => a.n === 2);
    keep({ push, blocked, branch });
    expect.soft(push.exit, 'the push').not.toBe(0);
    expect.soft(fs.realpathSync(String(push.cwd)), 'where the session works').toBe(fs.realpathSync(where));
    expect.soft(git(origin, 'for-each-ref', '--format=%(refname:short)'), 'the origin').toBe('main');
    expect.soft(git(origin, 'rev-parse', 'main'), 'the origin\'s main').toBe(head);
    expect.soft(blocked, 'the second arrival').toMatchObject({ blocked: 'max_concurrent' });

    // 6. Its turn ends: done, cleaned.
    await expect.poll(() => record().arrivals.find(a => a.n === 1 && a.end)?.end ?? null, { timeout: 90_000 }).toBe('done');
    await expect.poll(() => git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/load').trim(), { timeout: 30_000 }).toBe('');
    const after = { arrivals: record().arrivals, worktreeGone: !fs.existsSync(where), state: JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'load-run-state.json'), 'utf8')) };
    keep(after);
    expect.soft(after.worktreeGone, 'the worktree').toBe(true);
    expect.soft(after.state.worktrees, 'the private state').toEqual([]);
    expect.soft(after.arrivals.filter(a => a.n === 2 && !a.blocked), 'the blocked arrival never started').toEqual([]);
    expect.soft((await fleet()).find(a => a.load === true)?.worktreePath ?? null, 'Load 1 handed back').toBeNull();
    fs.copyFileSync(path.join(dir, 'load-runs', runId, 'run.json'), test.info().outputPath('run.json'));
    if (fs.existsSync(fakeLog)) fs.copyFileSync(fakeLog, test.info().outputPath('fake-cli.jsonl'));
    expect(await load<Row>('stop', runId)).toMatchObject({ ok: true });
  } finally {
    await app?.close();
    await standin.close();
  }
});
