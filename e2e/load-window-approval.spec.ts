import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A load window proposed from a pool and approved by the owner's click (trace feature C3, 27/11): the real app, two
 * small git projects whose remotes name a public and a private repository on GitHub, a stand-in gh that answers their
 * visibility, nothing leaving the machine. Every call goes through the window's own channel (window.electronAPI.load),
 * the one the card calls.
 *
 * 1. The owner turns load windows on for both projects (load:grant, from the window): the public one is allowed; the
 *    private one's switch does not hold and its settings are kept. The Projects view (load:projects) says so for each,
 *    with its repository and visibility, and offers the approved endpoint with its models.
 * 2. A pool is written: Tars proposes it, with its sha256; the private project is refused whole, a line whose
 *    base_commit is not in its project and a line breaking a rule are refused with their line numbers; the load
 *    agents are planned, Load N, one per granted harness.
 * 3. Nothing but the window approves or grants: an agent's own token finds no route for either, and a run record
 *    written into ~/.tars/load-runs by hand is no window.
 * 4. The pool changes after the card was shown: approving with the hash shown is refused as stale, with the new
 *    proposal (the Audit's I-1).
 * 5. The owner approves the new proposal with a value changed: the run's snapshot is the bytes approved, its plan the
 *    approved seed's, its approval in the private folder; an edit of the live pool afterwards changes nothing of it.
 * 6. The Stop switch ends it, its reason recorded.
 * Red on the base (feat/traces-window at 69c8f3f08): there is no load window.
 * The artefact: values.json, each state as the window got it, the run record, the stand-in gh's log, the app's log.
 */

type Row = Record<string, unknown>;
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
const AGENT = 'dddd4444-0000-4000-8000-0000000000c3';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

test('a load window is proposed from a pool, approved by the owner\'s click alone, and run from its snapshot', async () => {
  test.setTimeout(3 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-load-c3-');
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const repo = (name: string, remote: string): { path: string; head: string } => {
    const p = path.join(home, 'projects', name);
    fs.mkdirSync(p, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: p, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } }).trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(p, 'README.md'), `${name}\n`);
    git('add', 'README.md');
    git('commit', '-q', '-m', 'first');
    git('remote', 'add', 'origin', remote);
    return { path: p, head: git('rev-parse', 'HEAD') };
  };
  const pub = repo('public-app', 'https://github.com/e2e-owner/e2e-public-app.git');
  const priv = repo('private-app', 'git@github.com:e2e-owner/e2e-private-app.git');

  // The stand-in gh: the two repositories' visibility, every call logged. A script with a shebang, which execFile
  // cannot run on Windows: there gh is the one on the PATH, and this spec is macOS's and Linux's.
  test.skip(process.platform === 'win32', 'the stand-in gh is a script with a shebang');
  const ghLog = test.info().outputPath('gh-calls.jsonl');
  const gh = path.join(home, 'bin', 'gh');
  fs.mkdirSync(path.dirname(gh), { recursive: true });
  fs.writeFileSync(gh, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
const vis = { 'e2e-owner/e2e-public-app': 'PUBLIC', 'e2e-owner/e2e-private-app': 'PRIVATE' }[args[2]];
if (args[0] === 'repo' && args[1] === 'view' && vis) { process.stdout.write(JSON.stringify({ visibility: vis })); process.exit(0); }
process.stderr.write('stand-in gh: not something Tars asks');
process.exit(1);
`, { mode: 0o755 });

  const EP = 'ep-0e2ec3';
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([pub.path, priv.path]));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'Worker', character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: pub.path, skills: [], provider: 'claude',
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, models: ['open-coder-1'], approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1' }],
    traces: { projects: [pub.path, priv.path], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: '*', models: '*' }] },
  }, null, 2));

  const task = (over: Row) => JSON.stringify({
    task_id: 't', project: pub.path, repo: 'e2e-owner/e2e-public-app', base_commit: pub.head, prompt: 'Fix the README.', setup: ['echo setup'],
    test_cmd: 'echo test', time_cap_min: 20, harnesses: null, weight: 1, max_runs: 2, split: 'train', train_ok: true, ...over,
  });
  const poolDir = path.join(dir, 'load-pools', 'e2e-pool');
  const tasksFile = path.join(poolDir, 'tasks.jsonl');
  const port = apiPort(31976);
  const dist = path.resolve('electron', 'dist');
  const values: Row = {};
  const keep = (more: Row) => { Object.assign(values, more); recordValues(values); };
  const save = (name: string, v: unknown) => fs.writeFileSync(test.info().outputPath(name), JSON.stringify(v, null, 2));
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_E2E_GH: gh },
    });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const evaluate = <T>(fn: string, arg: Row = {}) => app!.evaluate(({}, { fn, arg, dist }) => {
      const req = process.mainModule!.require;
      return new Function('req', 'dist', 'arg', fn)(req, dist, arg);
    }, { fn, arg, dist }) as Promise<T>;
    // An answer, or what was thrown (on a build without the channel), so each assertion below is witnessed either way.
    const load = <T>(name: string, ...args: unknown[]) =>
      page.evaluate(async ({ name, args }) => {
        try { return await ((window as unknown as Api).electronAPI.load[name])(...args); } catch (err) { return { thrown: String(err) }; }
      }, { name, args }) as Promise<T>;

    // 1. The owner's grants, from the window: the private project's switch does not hold, its settings are kept.
    const granted = await Promise.all([pub.path, priv.path].map(p => load<Row & { project?: Row }>('grant', { path: p, enabled: true, allowedByName: false, endpointId: EP, model: 'open-coder-1', harnesses: ['codex', 'qwen-code'] })));
    keep({ granted });
    expect.soft(granted.map(g => g.ok), 'the grants').toEqual([true, true]);
    expect.soft(granted.map(g => g.project?.state), 'their states').toEqual(['allowed', 'private']);
    const view = await load<{ projects?: Array<Row & { grant?: Row }>; endpoints?: Row[] }>('projects');
    save('projects-view.json', view);
    const inView = (p: string) => view.projects?.find(x => x.path === p);
    keep({ view: view.projects?.map(x => ({ path: x.path, state: x.state, visibility: x.visibility, allowed: x.allowed })) ?? null });
    expect.soft(inView(pub.path), 'the public project in the Projects view').toMatchObject({ repo: 'e2e-owner/e2e-public-app', visibility: 'public', allowed: true, state: 'allowed' });
    expect.soft(inView(priv.path), 'the private project in the Projects view').toMatchObject({ visibility: 'private', allowed: false, state: 'private', grant: { enabled: false, harnesses: ['codex', 'qwen-code'] } });
    expect.soft(view.endpoints, 'the endpoints offered').toEqual([{ id: EP, name: 'Remote host', models: ['open-coder-1'] }]);

    // 2. A pool, proposed.
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, 'window.json'), JSON.stringify({ rate_per_hour: 12, seed: 4711, window_min: 90, max_concurrent: 4, initial_sessions: 2 }));
    fs.writeFileSync(tasksFile, [
      task({ task_id: 'pub-1' }), task({ task_id: 'pub-2', split: 'eval', train_ok: false }),
      task({ task_id: 'pub-missing', base_commit: 'e'.repeat(40) }), task({ task_id: 'pub-short', time_cap_min: 5 }),
      task({ task_id: 'priv-1', project: priv.path, repo: 'e2e-owner/e2e-private-app', base_commit: priv.head }),
    ].join('\n') + '\n');
    const first = await load<Row & { proposal?: Row & { projects: Row[]; refused: Row[]; agents: Row[] } }>('state');
    save('state-1-proposed.json', first);
    const p1 = first.proposal;
    keep({ proposal: p1 ? { pool: p1.pool, sha256: p1.sha256, runnable: p1.runnable, projects: p1.projects, refused: p1.refused, agents: p1.agents } : null });
    expect.soft(p1?.pool, 'the pool proposed').toBe('e2e-pool');
    expect.soft(p1?.sha256, 'its hash').toBe(sha(fs.readFileSync(tasksFile)));
    expect.soft(p1?.runnable, 'the tasks that can run').toBe(2);
    expect.soft(p1?.projects.find(x => x.path === priv.path), 'the private project').toMatchObject({ visibility: 'refused', state: 'private', reason: expect.stringContaining('private') });
    expect.soft(p1?.projects.find(x => x.path === pub.path), 'the public project').toMatchObject({ visibility: 'public', state: 'allowed', tasks: 2 });
    expect.soft(p1?.refused.map(r => `${r.file}:${r.line}`), 'the refused lines').toEqual(['tasks.jsonl:3', 'tasks.jsonl:4']);
    expect.soft(p1?.agents.map(a => `${a.name} ${a.harness}`), 'the load agents planned').toEqual(['Load 1 codex', 'Load 2 qwen-code']);

    // 3. Nothing but the window: an agent's own token, and a run record written by hand.
    const token = await evaluate<string>(`return req(dist + '/core/agent-tokens.js').mintRunToken(arg.agent).token;`, { agent: AGENT });
    const post = async (url: string, body: Row) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': AGENT, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.status;
    };
    const byAgent = {
      approve: await post('/api/load/approve', { pool: 'e2e-pool', sha256: p1?.sha256, proposalId: p1?.id, window: {} }),
      grant: await post('/api/load/grant', { path: pub.path, allowedByName: true, endpointId: EP, model: 'open-coder-1', harnesses: ['codex'] }),
    };
    const forged = '20261127-120000-beef';
    fs.mkdirSync(path.join(dir, 'load-runs', forged), { recursive: true });
    fs.writeFileSync(path.join(dir, 'load-runs', forged, 'tasks.snapshot.jsonl'), 'x\n');
    fs.writeFileSync(path.join(dir, 'load-runs', forged, 'run.json'), JSON.stringify({ version: 1, runId: forged, pool: 'e2e-pool', snapshotSha256: sha('x\n'), approvedAt: Date.now(), approvedBy: 'owner', window: {}, endsAt: Date.now() + 3600_000, tasks: [], refused: [], refusedProjects: [], planned: [], arrivals: [], agents: [], worktrees: [] }));
    const afterForge = await load<Row>('state');
    keep({ byAgent, forgedRunning: afterForge.running ?? null });
    expect.soft(byAgent, 'an agent\'s token').toEqual({ approve: 404, grant: 404 });
    expect.soft(afterForge.running, 'a run record nobody approved').toBeUndefined();

    // 4. The pool changes after the card was shown: the hash shown is stale.
    fs.appendFileSync(tasksFile, `${task({ task_id: 'pub-3' })}\n`);
    const stale = await load<Row & { state?: { proposal?: Row } }>('approve', { pool: 'e2e-pool', sha256: p1?.sha256, proposalId: p1?.id, window: {} });
    save('approve-1-stale.json', stale);
    keep({ stale: { ok: stale.ok, reason: stale.reason, newSha: stale.state?.proposal?.sha256 ?? null } });
    expect.soft(stale, 'approving what was not shown').toMatchObject({ ok: false, reason: 'stale' });
    expect.soft(stale.state?.proposal?.sha256, 'the card again, with the new hash').toBe(sha(fs.readFileSync(tasksFile)));

    // 5. Approved, a value changed: the snapshot is the bytes approved.
    const p2 = (stale.state?.proposal ?? {}) as Row;
    const approvedBytes = fs.readFileSync(tasksFile);
    const approved = await load<Row>('approve', { pool: 'e2e-pool', sha256: p2.sha256, proposalId: p2.id, window: { seed: 99 } });
    save('approve-2.json', approved);
    keep({ approved });
    expect(approved.ok, `the approval: ${JSON.stringify(approved)}`).toBe(true);
    const runId = String(approved.runId);
    fs.writeFileSync(tasksFile, 'edited after the approval\n');
    const running = await load<Row & { running?: Row }>('state');
    save('state-2-running.json', running);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'load-runs', runId, 'run.json'), 'utf8')) as Row & { planned: Row[]; tasks: Row[]; window: Row };
    fs.copyFileSync(path.join(dir, 'load-runs', runId, 'run.json'), test.info().outputPath('run.json'));
    const snapshot = fs.readFileSync(path.join(dir, 'load-runs', runId, 'tasks.snapshot.jsonl'));
    const plan = await evaluate<Row[]>(`const p = req(dist + '/services/load-pool.js'); const all = p.parseTasksJsonl(arg.text).tasks.filter(t => arg.ids.includes(t.task_id)); return p.planArrivals(arg.window, all);`,
      { text: snapshot.toString(), ids: record.tasks.map(t => t.taskId), window: record.window });
    const approvals = JSON.parse(fs.readFileSync(path.join(home, '.tars-private', 'load-approved.json'), 'utf8')) as Row[];
    keep({ runId, runningId: running.running?.runId ?? null, recordSha: record.snapshotSha256, window: record.window, planned: record.planned.length, approvals: approvals.map(a => a.runId) });
    expect.soft(running.running?.runId, 'the window runs').toBe(runId);
    expect.soft(running.running?.snapshotSha256, 'its snapshot, whatever the live file').toBe(sha(approvedBytes));
    expect.soft(snapshot.equals(approvedBytes), 'the snapshot is the bytes approved').toBe(true);
    expect.soft(record.window, 'the window as approved').toMatchObject({ seed: 99, rate_per_hour: 12, window_min: 90, max_concurrent: 4, initial_sessions: 2 });
    expect.soft(record.tasks.map(t => t.taskId), 'its tasks').toEqual(['pub-1', 'pub-2', 'pub-3']);
    expect.soft(record.planned.map(a => [a.n, a.taskId, a.offsetMs]), 'the plan, the approved seed\'s').toEqual(plan.map(a => [a.n, a.taskId, a.offsetMs]));
    expect.soft(approvals.map(a => a.runId), 'the approval, in the private folder').toEqual([runId]);

    // 6. The Stop switch.
    const stopped = await load<Row>('stop', runId);
    const after = await load<Row & { last?: Row & { stop?: Row } }>('state');
    save('state-3-stopped.json', after);
    keep({ stopped, lastStop: after.last?.stop ?? null });
    expect.soft(stopped, 'the switch').toMatchObject({ ok: true });
    expect.soft(after.running, 'nothing runs').toBeUndefined();
    expect.soft(after.last?.stop, 'its reason').toMatchObject({ reason: 'switch' });

    await page.screenshot({ path: test.info().outputPath('window.png') });
  } finally {
    await app?.close();
  }
});
