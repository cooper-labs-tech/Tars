import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { checkGrant, readGrants, writeGrant, type LoadGrant } from '../../../electron/services/load-grants';
import { createLoadWindow, type LoadWindowDeps } from '../../../electron/services/load-window';
import { readRun, updateRun } from '../../../electron/services/load-run-record';
import { planArrivals } from '../../../electron/services/load-pool';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The load window's proposal, approval and run record (trace feature C3, 27/11), and the owner's grants.
 *
 * How it fails, written before the code:
 *
 * The grants (`~/.tars-private/load-grants.json`, written by the window alone):
 *  G1. A grant is taken for a path that is no Tars project, an endpoint that does not exist or is not approved, a
 *      model the endpoint does not serve, a harness outside the endpoint harnesses (claude above all) or none.
 *  G2. The file is written readable by others, or not in the private folder; a removal leaves the grant.
 *  G3. A file edited by hand with a bad entry stops every grant from being read, or throws.
 *  Added before their code, for the Projects view of #672's frames (94d36a2bb, 27/11):
 *  G4. A project's settings are lost while its switch is off: the endpoint, model and harnesses chosen for a private
 *      project before it is allowed by name, or a harness chosen before any endpoint (a grant with no endpoint yet is
 *      refused); or a model is taken with no endpoint, or a switch that is not true or false.
 *  G5. The switch is held on for a project that cannot run: traces off, no endpoint or model, no harness, a private
 *      repository or one gh cannot tell, not allowed by name (withdrawing the name). It must be kept off, its
 *      settings kept, and the view say why.
 *  V1. The Projects view leaves out a project of Tars's, or does not give, for each: its repository, its visibility
 *      as gh says (gh never asked for a project allowed by name or with traces off), whether it is traced, its
 *      settings as kept, whether it is allowed, its state and the reason line the frames show; the approved endpoints
 *      with their models (an endpoint not approved offered); its load agents with their harness, endpoint, model and
 *      whether a window runs them now.
 *  V2. The view and the proposal decide a project differently: one allows what the other refuses, or they give
 *      another state or reason.
 *
 * The proposal:
 *  P1. The newest pool is not the one proposed; a pool the owner set aside (Not now) comes back unchanged; one already
 *      run unchanged comes back; a symlinked pool or tasks.jsonl is read (a path to anything on the machine).
 *  P2. A project is taken without a grant, not opted into traces, with no repository and not allowed by name, with a
 *      repository its remotes do not name, private and not allowed by name, or whose visibility gh could not tell;
 *      a refused project's tasks are not all left out, or its reason is not said.
 *  P3. A task whose base_commit is not in its project is taken (fetching it is never an answer: no network during a
 *      window), or one whose harnesses no load agent of its project runs.
 *  P4. A refused line or value of the file is not in the proposal with its file, line and reason.
 *  P5. The counts by split, the runnable count, the load agents planned (one per granted harness, the existing ones
 *      reused, at most max_concurrent a project, named Load N), the setup and test lines, or the window's values are
 *      not what the card must show.
 *
 * The approval (only through the window's IPC; load-approval-boundary.test.ts proves nothing else reaches it):
 *  A1. Approve without the hash the card showed, or with a stale one (the file changed since), starts a window: it
 *      must refuse and give the card again (the Audit's I-1). The same when the checks changed what can run.
 *  A2. The owner's window values are taken unchecked (a rate of 0, initial sessions over max concurrent).
 *  A3. The snapshot is not the bytes approved, its sha256 not theirs, or the run reads the live file after approval:
 *      an edit after it changes the run.
 *  A4. The run record lacks the planned arrivals (from the approved seed, the same as planArrivals gives), the window
 *      as approved, the snapshot's sha256, who approved, the runnable tasks with their split and train_ok, or the
 *      refusals; or a second window is approved while one runs.
 *  A5. Stop records nothing, or its reason is not the switch.
 *  A6. A run record written by anything but the approval (an agent can write ~/.tars) is taken for a window: it shows
 *      as running, blocks the next approval, or would be run. Only a run the owner approved counts, as kept in the
 *      private folder (its id, its snapshot's sha256 and its window); and a snapshot changed after the approval stops
 *      its run with an error, never runs it.
 *  A7. (The Audit's M1 at fdd82ca3d, written before its fix.) A run's state is read from its record under
 *      ~/.tars/load-runs, which any agent can write: a stop removed from a stopped run's record lifts the owner's stop;
 *      a stop an agent writes there stops the run; a `planned` or `tasks` edited there is what the run follows; a
 *      "not now" kept there can be undone or forged. The owner's stop is kept with the approval, in the private folder;
 *      the tasks and the planned arrivals come from the verified snapshot, the approved task lines and the approved
 *      window; a record that disagrees with them stops its run with an error; the set-asides are private too. The
 *      record is a log of the run, read for nothing a decision needs.
 */

let dir: string;
let projects: Record<string, string>;
let grantsFile: string;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const HEAD = 'c'.repeat(40);
const MISSING = 'd'.repeat(40);
const ENDPOINT = { id: 'ep-1', name: 'Shared host', baseUrl: 'http://127.0.0.1:9/v1', approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', models: ['open-coder-1'] };

function line(over: Record<string, unknown>): string {
  return JSON.stringify({
    task_id: 't', project: projects.pub, repo: 'example-org/pub', base_commit: HEAD, prompt: 'Fix it.', setup: ['npm ci'], test_cmd: 'npm test',
    time_cap_min: 30, harnesses: null, weight: 1, max_runs: 2, split: 'train', train_ok: true, ...over,
  });
}

function writePool(name: string, lines: string[], window?: Record<string, unknown>, mtime?: number): string {
  const p = path.join(dir, 'pools', name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'tasks.jsonl'), `${lines.join('\n')}\n`);
  if (window) fs.writeFileSync(path.join(p, 'window.json'), JSON.stringify(window));
  if (mtime) fs.utimesSync(path.join(p, 'tasks.jsonl'), mtime / 1000, mtime / 1000);
  return p;
}

let grants: LoadGrant[];
let traced: string[];
let loadAgents: Array<{ id: string; name: string; projectPath: string; provider: string; endpointId?: string; model?: string }>;
let ghCalls: string[][];
let now: number;
/** Each project's git remote (none: not a git work tree), and each repository's visibility as gh says (none: gh fails). */
let remotes: Record<string, string>;
let visibilityOf: Record<string, 'PUBLIC' | 'PRIVATE'>;

/** A grant: the switch on, the shared endpoint and its model. */
const g = (p: string, harnesses: LoadGrant['harnesses'], allowedByName = false): LoadGrant =>
  ({ path: p, enabled: true, allowedByName, endpointId: 'ep-1', model: 'open-coder-1', harnesses });

function deps(over: Partial<LoadWindowDeps> = {}): LoadWindowDeps {
  return {
    poolsDir: path.join(dir, 'pools'), runsDir: path.join(dir, 'runs'), approvedFile: path.join(dir, 'private', 'load-approved.json'),
    setAsideFile: path.join(dir, 'private', 'load-set-aside.json'),
    projects: () => Object.values(projects),
    grants: () => grants, tracedProjects: () => traced, endpoints: () => [ENDPOINT, { ...ENDPOINT, id: 'ep-2', name: 'Not approved', approved: false }],
    loadAgents: () => loadAgents,
    // A git that knows each project's remote and HEAD only.
    git: async (cwd, args) => {
      if (args[0] === 'rev-parse') { if (remotes[cwd]) return 'true\n'; throw new Error('not a git repository'); }
      if (args[0] === 'remote') return `origin\t${remotes[cwd]} (fetch)\norigin\t${remotes[cwd]} (push)\n`;
      if (args[0] === 'cat-file') { if (args[2].startsWith(HEAD)) return ''; throw new Error('missing'); }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    gh: async (args) => {
      ghCalls.push(args);
      const seen = visibilityOf[args[2]];
      if (seen) return JSON.stringify({ visibility: seen });
      throw new Error('gh: not signed in');
    },
    now: () => now,
    emit: () => {},
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-window-'));
  const p = (n: string) => path.join(dir, 'p', n);
  projects = {
    pub: p('pub'), priv: p('priv'), named: p('named'), untraced: p('untraced'), fresh: p('fresh'), off: p('off'), ghfail: p('ghfail'), bare: p('bare'),
  };
  remotes = {
    [projects.pub]: 'https://github.com/example-org/pub.git', [projects.priv]: 'git@github.com:example-org/priv.git',
    [projects.named]: 'https://github.com/example-org/named.git', [projects.fresh]: 'https://github.com/example-org/fresh.git',
    [projects.off]: 'https://github.com/example-org/off.git', [projects.ghfail]: 'https://github.com/example-org/ghfail.git',
    [projects.bare]: 'https://github.com/example-org/bare.git',
  };
  visibilityOf = {
    'example-org/pub': 'PUBLIC', 'example-org/priv': 'PRIVATE', 'example-org/named': 'PRIVATE', 'example-org/fresh': 'PUBLIC',
    'example-org/off': 'PUBLIC', 'example-org/bare': 'PUBLIC',
  };
  grantsFile = path.join(dir, 'private', 'load-grants.json');
  grants = [g(projects.pub, ['codex', 'qwen-code']), g(projects.priv, ['codex']), g(projects.named, ['opencode'], true), g(projects.untraced, ['codex'])];
  traced = [projects.pub, projects.priv, projects.named, projects.fresh, projects.off, projects.ghfail, projects.bare];
  loadAgents = [];
  ghCalls = [];
  now = Date.parse('2026-11-27T14:00:00Z');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the owner\'s grants', () => {
  const ctx = () => ({ projects: Object.values(projects), endpoints: [ENDPOINT] });
  const good = (): LoadGrant => g(projects.pub, ['codex']);

  it('G1: a grant outside the rules is refused, saying why', () => {
    expect(checkGrant(good(), ctx())).toEqual(good());
    for (const [over, word] of [
      [{ path: '/not/a/project' }, 'project'], [{ endpointId: 'ep-x' }, 'endpoint'], [{ model: 'closed-model' }, 'model'],
      [{ harnesses: ['claude'] }, 'harness'], [{ harnesses: 'codex' }, 'harness'], [{ allowedByName: 'yes' }, 'allowedByName'],
      [{ enabled: 'yes' }, 'enabled'],
    ] as Array<[Partial<LoadGrant>, string]>) {
      expect(checkGrant({ ...good(), ...over } as LoadGrant, ctx()), word).toEqual(expect.stringContaining(word));
    }
    expect(checkGrant(good(), { projects: ctx().projects, endpoints: [{ ...ENDPOINT, approved: false }] })).toEqual(expect.stringContaining('endpoint'));
  });

  it('G4: the settings are kept with the switch off: no endpoint yet, no harness yet; a model needs its endpoint', () => {
    const none = { ...good(), enabled: false, endpointId: null, model: null, harnesses: ['opencode'] } as LoadGrant;
    expect(checkGrant(none, ctx())).toEqual(none);
    expect(checkGrant({ ...good(), enabled: false, harnesses: [] }, ctx())).toMatchObject({ harnesses: [] });
    expect(checkGrant({ ...good(), endpointId: null }, ctx())).toEqual(expect.stringContaining('model'));
    writeGrant(none, grantsFile);
    expect(readGrants(grantsFile)).toEqual([none]);
  });

  it('G2 and G3: written 0600 in the file given, removed whole, and a bad entry skipped without a throw', () => {
    writeGrant(good(), grantsFile);
    writeGrant({ ...good(), path: projects.named, allowedByName: true }, grantsFile);
    expect(readGrants(grantsFile).map(g => g.path).sort()).toEqual([projects.named, projects.pub].sort());
    if (hasPosixModes()) expect(fs.statSync(grantsFile).mode & 0o777).toBe(0o600);
    writeGrant({ path: projects.named, remove: true }, grantsFile);
    expect(readGrants(grantsFile).map(g => g.path)).toEqual([projects.pub]);
    const raw = JSON.parse(fs.readFileSync(grantsFile, 'utf8'));
    raw.projects.push({ path: 7 });
    fs.writeFileSync(grantsFile, JSON.stringify(raw));
    expect(readGrants(grantsFile).map(g => g.path)).toEqual([projects.pub]);
    fs.writeFileSync(grantsFile, 'not json');
    expect(readGrants(grantsFile)).toEqual([]);
    expect(readGrants(path.join(dir, 'none.json'))).toEqual([]);
  });
});

describe('the proposal', () => {
  it('P1: the newest pool, not one set aside or already run unchanged, and never through a link', async () => {
    writePool('older', [line({ task_id: 'o1' })], undefined, now - 60_000);
    writePool('newer', [line({ task_id: 'n1' })], undefined, now - 1000);
    const w = createLoadWindow(deps());
    expect((await w.refresh()).proposal?.pool).toBe('newer');
    const shown = (await w.refresh()).proposal!;
    await w.notNow({ pool: 'newer', sha256: shown.sha256 });
    expect((await w.refresh()).proposal?.pool).toBe('older');
    // A pool written again is a new proposal.
    writePool('newer', [line({ task_id: 'n1' }), line({ task_id: 'n2' })], undefined, now);
    expect((await w.refresh()).proposal?.pool).toBe('newer');
    // A link to a pool, and a tasks.jsonl that is a link, are never read.
    fs.symlinkSync(path.join(dir, 'pools', 'older'), path.join(dir, 'pools', 'linked'));
    fs.mkdirSync(path.join(dir, 'pools', 'filelink'));
    fs.symlinkSync(path.join(dir, 'pools', 'older', 'tasks.jsonl'), path.join(dir, 'pools', 'filelink', 'tasks.jsonl'));
    fs.utimesSync(path.join(dir, 'pools', 'older', 'tasks.jsonl'), (now + 5000) / 1000, (now + 5000) / 1000);
    const pools = (await w.refresh()).proposal?.pool;
    expect(['linked', 'filelink']).not.toContain(pools);
  });

  it('P2 to P5: projects refused whole with their reason, tasks refused alone, what the card shows', async () => {
    writePool('mixed', [
      line({ task_id: 'pub-1' }),
      line({ task_id: 'pub-2', harnesses: ['qwen-code'], setup: [], test_cmd: null, split: 'eval', train_ok: false }),
      line({ task_id: 'pub-missing', base_commit: MISSING }),
      line({ task_id: 'pub-pi', harnesses: ['pi'] }),
      line({ task_id: 'priv-1', project: projects.priv, repo: 'example-org/priv' }),
      line({ task_id: 'named-1', project: projects.named, repo: 'example-org/named', split: 'heldout', train_ok: false }),
      line({ task_id: 'untraced-1', project: projects.untraced, repo: null }),
      line({ task_id: 'nogrant-1', project: path.join(dir, 'p', 'nogrant'), repo: null }),
      line({ task_id: 'wrong-repo', repo: 'example-org/other' }),
      'not json',
    ], { rate_per_hour: 12, seed: 4711, window_min: 90, max_concurrent: 4, initial_sessions: 2, pick: 'random' });
    const p = (await createLoadWindow(deps()).refresh()).proposal!;
    expect(p.pool).toBe('mixed');
    expect(p.sha256).toBe(sha(fs.readFileSync(path.join(dir, 'pools', 'mixed', 'tasks.jsonl'))));
    const byName = Object.fromEntries(p.projects.map(x => [x.path, x]));
    expect(byName[projects.pub]).toMatchObject({ visibility: 'public', state: 'allowed', repo: 'example-org/pub', tasks: 2 });
    expect(byName[projects.named]).toMatchObject({ visibility: 'allowed_by_name', state: 'allowed_by_name', tasks: 1 });
    expect(byName[projects.priv]).toMatchObject({ visibility: 'refused', state: 'private', reason: expect.stringContaining('private') });
    expect(byName[projects.untraced]).toMatchObject({ visibility: 'refused', state: 'traces_off', reason: expect.stringContaining('traces') });
    expect(byName[path.join(dir, 'p', 'nogrant')]).toMatchObject({ visibility: 'refused', state: 'unknown_project', reason: expect.stringContaining('not one of your projects') });
    // A named project is never asked of gh.
    expect(ghCalls.map(a => a[2])).not.toContain('example-org/named');
    const reasons = Object.fromEntries(p.refused.map(r => [`${r.file}:${r.line}`, r.reason]));
    expect(reasons['tasks.jsonl:3']).toContain('base_commit');
    expect(reasons['tasks.jsonl:4']).toContain('harness');
    expect(reasons['tasks.jsonl:9']).toContain('example-org/other');
    expect(reasons['tasks.jsonl:10']).toContain('JSON');
    expect(p.refused.some(r => r.file === 'window.json' && r.key === 'pick')).toBe(true);
    expect(p.runnable).toBe(3);
    expect(p.tasks.map(t => t.taskId)).toEqual(['pub-1', 'pub-2', 'named-1']);
    expect(p.tasks[0]).toMatchObject({ setup: ['npm ci'], testCmd: 'npm test', split: 'train', capMin: 30 });
    expect(p.tasks[1]).toMatchObject({ setup: [], testCmd: null, split: 'eval' });
    expect(p.counts).toEqual({ train: 1, heldout: 1, eval: 1, tasks: 3 });
    expect(p.window).toMatchObject({ rate_per_hour: 12, seed: 4711, window_min: 90, max_concurrent: 4, initial_sessions: 2, pick: 'weighted_without_replacement' });
    expect(p.agents.map(a => [a.name, a.project, a.harness, a.existing])).toEqual([
      ['Load 1', projects.pub, 'codex', false], ['Load 2', projects.pub, 'qwen-code', false], ['Load 3', projects.named, 'opencode', false],
    ]);
    expect(p.endpoints).toEqual([{ id: 'ep-1', name: 'Shared host', baseUrl: 'http://127.0.0.1:9/v1' }]);
  });

  it('P5: an existing load agent is reused, and a project gets at most max_concurrent', async () => {
    loadAgents = [{ id: 'a-7', name: 'Load 7', projectPath: projects.pub, provider: 'qwen-code' }];
    grants[0].harnesses = ['codex', 'qwen-code', 'pi', 'opencode'];
    writePool('one', [line({ task_id: 'pub-1' })], { max_concurrent: 2 });
    const p = (await createLoadWindow(deps()).refresh()).proposal!;
    expect(p.agents.map(a => [a.name, a.harness, a.existing])).toEqual([['Load 7', 'qwen-code', true], ['Load 1', 'codex', false]]);
  });
});

describe('the Projects view', () => {
  it('G5: the switch holds only for a project that can run; its settings are kept either way', async () => {
    const w = createLoadWindow(deps());
    expect(await w.settle(g(projects.pub, ['codex']))).toMatchObject({ enabled: true });
    expect(await w.settle(g(projects.priv, ['codex']))).toEqual({ ...g(projects.priv, ['codex']), enabled: false });
    expect(await w.settle(g(projects.priv, ['codex'], true))).toMatchObject({ enabled: true, allowedByName: true });
    expect(await w.settle(g(projects.untraced, ['codex']))).toMatchObject({ enabled: false });
    expect(await w.settle({ ...g(projects.fresh, ['codex']), endpointId: null, model: null })).toMatchObject({ enabled: false, harnesses: ['codex'] });
    expect(await w.settle(g(projects.bare, []))).toMatchObject({ enabled: false });
    expect(await w.settle(g(projects.ghfail, ['codex']))).toMatchObject({ enabled: false });
  });

  it('V1: every project, with its repository, visibility, settings, state and reason; the endpoints; its load agents', async () => {
    grants = [
      g(projects.pub, ['codex', 'qwen-code']), g(projects.named, ['opencode'], true), { ...g(projects.priv, ['codex', 'qwen-code']), enabled: false },
      g(projects.untraced, ['codex']), { ...g(projects.fresh, ['opencode']), endpointId: null, model: null, enabled: false },
      { ...g(projects.off, ['codex']), enabled: false }, g(projects.ghfail, ['codex']), g(projects.bare, []),
    ];
    loadAgents = [{ id: 'a-1', name: 'Load 1', projectPath: projects.pub, provider: 'codex', endpointId: 'ep-1', model: 'open-coder-1' }];
    const w = createLoadWindow(deps());
    const v = await w.projects();
    expect(v.projects.map(x => x.path).sort()).toEqual(Object.values(projects).sort());
    expect(v.endpoints).toEqual([{ id: 'ep-1', name: 'Shared host', models: ['open-coder-1'] }]);
    const by = Object.fromEntries(v.projects.map(x => [x.path, x]));
    expect(by[projects.pub]).toMatchObject({
      name: 'pub', repo: 'example-org/pub', visibility: 'public', traced: true, allowed: true, state: 'allowed',
      reason: expect.stringContaining('Shared host, open-coder-1'), grant: { harnesses: ['codex', 'qwen-code'] },
      agents: [{ id: 'a-1', name: 'Load 1', harness: 'codex', endpointName: 'Shared host', model: 'open-coder-1', inWindow: false }],
    });
    expect(by[projects.named]).toMatchObject({ visibility: 'not_asked', allowed: true, state: 'allowed_by_name', reason: expect.stringContaining('by name') });
    expect(by[projects.priv]).toMatchObject({ visibility: 'private', allowed: false, state: 'private', reason: expect.stringContaining('Allow it by name'), grant: { endpointId: 'ep-1', harnesses: ['codex', 'qwen-code'] } });
    expect(by[projects.untraced]).toMatchObject({ traced: false, visibility: 'not_asked', allowed: false, state: 'traces_off', reason: expect.stringContaining('Opt it in') });
    expect(by[projects.fresh]).toMatchObject({ visibility: 'public', allowed: false, state: 'no_endpoint', grant: { endpointId: null, harnesses: ['opencode'] } });
    expect(by[projects.off]).toMatchObject({ visibility: 'public', allowed: false, state: 'off' });
    expect(by[projects.ghfail]).toMatchObject({ visibility: 'unknown', allowed: false, state: 'unknown', reason: expect.stringContaining('not signed in') });
    expect(by[projects.bare]).toMatchObject({ allowed: false, state: 'no_harness' });
    // gh is never asked for a project allowed by name, nor one with traces off.
    expect(ghCalls.map(a => a[2])).not.toContain('example-org/named');
    // A load agent a window runs now.
    writePool('p', [line({ task_id: 'pub-1' })]);
    const shown = (await w.refresh()).proposal!;
    const r = await w.approve({ pool: 'p', sha256: shown.sha256, proposalId: shown.id, window: {} }) as { runId: string };
    updateRun(path.join(dir, 'runs'), r.runId, x => ({ ...x, arrivals: [{ n: 1, taskId: 'pub-1', plannedAt: now, actualAt: now, agentId: 'a-1', harness: 'codex' }] }));
    expect((await w.projects()).projects.find(x => x.path === projects.pub)!.agents[0].inWindow).toBe(true);
  });

  it('V2: the view and the proposal decide each project alike', async () => {
    grants = [g(projects.pub, ['codex']), g(projects.priv, ['codex']), { ...g(projects.off, ['codex']), enabled: false }, g(projects.ghfail, ['codex']), g(projects.named, ['opencode'], true)];
    writePool('all', [
      line({ task_id: 'pub-1' }), line({ task_id: 'priv-1', project: projects.priv, repo: 'example-org/priv' }),
      line({ task_id: 'off-1', project: projects.off, repo: 'example-org/off' }), line({ task_id: 'fail-1', project: projects.ghfail, repo: 'example-org/ghfail' }),
      line({ task_id: 'fresh-1', project: projects.fresh, repo: 'example-org/fresh' }), line({ task_id: 'named-1', project: projects.named, repo: 'example-org/named' }),
      line({ task_id: 'untraced-1', project: projects.untraced, repo: null }),
    ]);
    const w = createLoadWindow(deps());
    const view = Object.fromEntries((await w.projects()).projects.map(x => [x.path, x]));
    const proposal = (await w.refresh()).proposal!;
    for (const p of proposal.projects) {
      expect({ path: p.path, state: p.state, runs: p.visibility !== 'refused' }, p.path).toEqual({ path: p.path, state: view[p.path].state, runs: view[p.path].allowed });
      if (p.visibility === 'refused') expect(p.reason, p.path).toBe(view[p.path].reason);
    }
    expect(proposal.projects.map(p => p.state).sort()).toEqual(['allowed', 'allowed_by_name', 'no_endpoint', 'off', 'private', 'traces_off', 'unknown']);
  });
});

describe('the approval', () => {
  it('A1 to A4: a stale hash shows the card again; the approved bytes are the run\'s, whatever the file becomes', async () => {
    const poolDir = writePool('p', [line({ task_id: 'pub-1' }), line({ task_id: 'pub-2' })], { seed: 7, rate_per_hour: 30, window_min: 60 });
    const w = createLoadWindow(deps());
    const shown = (await w.refresh()).proposal!;
    const approved = fs.readFileSync(path.join(poolDir, 'tasks.jsonl'));
    // No hash, or another one: refused, the card again.
    expect(await w.approve({ pool: 'p', sha256: '', proposalId: shown.id, window: {} })).toMatchObject({ ok: false, reason: 'stale' });
    fs.appendFileSync(path.join(poolDir, 'tasks.jsonl'), `${line({ task_id: 'pub-3' })}\n`);
    const stale = await w.approve({ pool: 'p', sha256: shown.sha256, proposalId: shown.id, window: {} });
    expect(stale).toMatchObject({ ok: false, reason: 'stale', state: { proposal: { pool: 'p', runnable: 3 } } });
    // The checks changed what can run since the card was shown: stale too.
    fs.writeFileSync(path.join(poolDir, 'tasks.jsonl'), approved);
    const again = (await w.refresh()).proposal!;
    traced = [];
    expect(await w.approve({ pool: 'p', sha256: again.sha256, proposalId: again.id, window: {} })).toMatchObject({ ok: false, reason: 'stale' });
    traced = [projects.pub];
    const fresh = (await w.refresh()).proposal!;
    // A2: the owner's values are checked.
    expect(await w.approve({ pool: 'p', sha256: fresh.sha256, proposalId: fresh.id, window: { rate_per_hour: 0 } })).toMatchObject({ ok: false, error: expect.stringContaining('rate_per_hour') });
    const r = await w.approve({ pool: 'p', sha256: fresh.sha256, proposalId: fresh.id, window: { seed: 99, initial_sessions: 1 } });
    expect(r).toMatchObject({ ok: true, runId: expect.stringMatching(/^\d{8}-\d{6}-[0-9a-f]{4}$/) });
    const runId = (r as { runId: string }).runId;
    // A3: the live file changes; the run does not.
    fs.writeFileSync(path.join(poolDir, 'tasks.jsonl'), 'changed\n');
    const run = readRun(path.join(dir, 'runs'), runId)!;
    expect(run.snapshotSha256).toBe(sha(approved));
    expect(fs.readFileSync(path.join(dir, 'runs', runId, 'tasks.snapshot.jsonl'))).toEqual(approved);
    expect(run).toMatchObject({ pool: 'p', approvedBy: 'owner', approvedAt: now, window: { seed: 99, rate_per_hour: 30, window_min: 60, initial_sessions: 1 }, endsAt: now + 60 * 60_000 });
    expect(run.tasks.map(t => [t.taskId, t.split, t.train_ok])).toEqual([['pub-1', 'train', true], ['pub-2', 'train', true]]);
    const expected = planArrivals(run.window, (await import('../../../electron/services/load-pool')).parseTasksJsonl(approved.toString()).tasks);
    expect(run.planned).toEqual(expected.map(a => ({ ...a, plannedAt: now + a.offsetMs })));
    // A4: one window at a time; the state says it runs.
    const state = await w.refresh();
    expect(state.running?.runId).toBe(runId);
    writePool('q', [line({ task_id: 'q-1' })]);
    const q = (await w.refresh()).proposal;
    expect(await w.approve({ pool: 'q', sha256: q?.sha256 ?? '', proposalId: q?.id ?? '', window: {} })).toMatchObject({ ok: false, error: expect.stringContaining('runs') });
    // A5: the switch.
    expect(await w.stop(runId)).toMatchObject({ ok: true });
    expect(readRun(path.join(dir, 'runs'), runId)!.stop).toMatchObject({ reason: 'switch', at: now });
    // P1: a pool already run, unchanged, is not proposed again; changed, it is (found by the mutation bench: no test
    // looked past a running window).
    await w.notNow({ pool: 'q', sha256: sha(fs.readFileSync(path.join(dir, 'pools', 'q', 'tasks.jsonl'))) });
    fs.writeFileSync(path.join(poolDir, 'tasks.jsonl'), approved);
    const after = await w.refresh();
    expect(after.proposal).toBeUndefined();
    expect(after.last?.stop).toMatchObject({ reason: 'switch' });
    fs.appendFileSync(path.join(poolDir, 'tasks.jsonl'), `${line({ task_id: 'pub-3' })}\n`);
    expect((await w.refresh()).proposal?.pool).toBe('p');
  });

  it('A6: a run record nobody approved is no window; a snapshot changed after approval stops its run', async () => {
    writePool('p', [line({ task_id: 'pub-1' })]);
    const w = createLoadWindow(deps());
    // As an agent could write it: a record and a snapshot, with no approval behind them.
    const forged = '20261127-140000-beef';
    fs.mkdirSync(path.join(dir, 'runs', forged), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', forged, 'tasks.snapshot.jsonl'), 'x\n');
    fs.writeFileSync(path.join(dir, 'runs', forged, 'run.json'), JSON.stringify({
      version: 1, runId: forged, pool: 'p', poolDir: '', writtenAt: now, snapshotSha256: sha('x\n'), approvedAt: now, approvedBy: 'owner',
      window: { rate_per_hour: 6 }, endsAt: now + 3600_000, tasks: [], refused: [], refusedProjects: [], planned: [], arrivals: [], agents: [], worktrees: [],
    }));
    const state = await w.refresh();
    expect(state.running).toBeUndefined();
    const shown = state.proposal!;
    const r = await w.approve({ pool: 'p', sha256: shown.sha256, proposalId: shown.id, window: {} });
    expect(r).toMatchObject({ ok: true });
    const runId = (r as { runId: string }).runId;
    expect((await w.refresh()).running?.runId).toBe(runId);
    // The snapshot changed under the run: it stops, with an error, and runs no more.
    fs.writeFileSync(path.join(dir, 'runs', runId, 'tasks.snapshot.jsonl'), 'tampered\n');
    expect((await w.refresh()).running).toBeUndefined();
    expect(readRun(path.join(dir, 'runs'), runId)!.stop).toMatchObject({ reason: 'error', detail: expect.stringContaining('snapshot') });
  });

  /** Approves pool `name` as shown; its run's id and its record's file. */
  async function approved(w: ReturnType<typeof createLoadWindow>, name: string): Promise<{ runId: string; record: string }> {
    writePool(name, [line({ task_id: `${name}-1` }), line({ task_id: `${name}-2` })], { seed: 7, rate_per_hour: 30 });
    const shown = (await w.refresh()).proposal!;
    expect(shown.pool).toBe(name);
    const r = await w.approve({ pool: name, sha256: shown.sha256, proposalId: shown.id, window: {} }) as { ok: boolean; runId: string };
    expect(r.ok).toBe(true);
    return { runId: r.runId, record: path.join(dir, 'runs', r.runId, 'run.json') };
  }
  const editRecord = (file: string, fn: (r: Record<string, unknown>) => void) => {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fn(r);
    fs.writeFileSync(file, JSON.stringify(r));
  };

  it('A7: a stop an agent writes in the record stops nothing; the owner\'s stop holds when the record loses it', async () => {
    const w = createLoadWindow(deps());
    const { runId, record } = await approved(w, 'p');
    editRecord(record, (r) => { r.stop = { reason: 'switch', at: now }; });
    expect((await w.refresh()).running?.runId).toBe(runId);
    expect(await w.stop(runId)).toMatchObject({ ok: true });
    editRecord(record, (r) => { delete r.stop; });
    const after = await w.refresh();
    expect(after.running).toBeUndefined();
    expect(after.last).toMatchObject({ runId, stop: { reason: 'switch', at: now } });
    // Nor can the record undo it through the approval's other fields: the run is not proposed again either.
    expect(after.proposal).toBeUndefined();
  });

  it('A7: a record whose planned arrivals or tasks were edited stops its run with an error', async () => {
    const w = createLoadWindow(deps());
    const first = await approved(w, 'p');
    editRecord(first.record, (r) => { (r.planned as Array<Record<string, unknown>>)[0].taskId = 'p-2-forged'; });
    expect((await w.refresh()).running).toBeUndefined();
    expect((await w.refresh()).last).toMatchObject({ runId: first.runId, stop: { reason: 'error', detail: expect.stringContaining('record') } });
    const second = await approved(w, 'q');
    editRecord(second.record, (r) => { (r.tasks as Array<Record<string, unknown>>)[0].split = 'eval'; });
    expect((await w.refresh()).running).toBeUndefined();
    expect((await w.refresh()).last).toMatchObject({ runId: second.runId, stop: { reason: 'error', detail: expect.stringContaining('record') } });
  });

  it('A7: "not now" is kept in the private folder; a set-aside written under ~/.tars hides nothing', async () => {
    writePool('p', [line({ task_id: 'p-1' })]);
    const w = createLoadWindow(deps());
    const shown = (await w.refresh()).proposal!;
    fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', 'set-aside.json'), JSON.stringify({ p: shown.sha256 }));
    expect((await createLoadWindow(deps()).refresh()).proposal?.pool).toBe('p');
    await w.notNow({ pool: 'p', sha256: shown.sha256 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'private', 'load-set-aside.json'), 'utf8'))).toEqual({ p: shown.sha256 });
    expect((await createLoadWindow(deps()).refresh()).proposal).toBeUndefined();
  });
});
