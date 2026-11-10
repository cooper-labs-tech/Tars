/**
 * A team deployed in one call, every member made or none (electron/services/team-deploy.ts, the window's
 * teams:deploy). From QA's fresh-install report (fresh-install-turnkey.md, B3 and B4) and Tars-Frontend's request
 * (first-run-window.md): New team created its members one by one from the window, so a plain folder left the
 * orchestrator alone and five members failed with git's raw words, and the orchestrator was started before its team
 * existed, its bootstrap's roster empty.
 *
 * How it fails, written before the code (10/11):
 * 1. A member that cannot be made leaves the ones made before it: every member is made or none. The ones made are
 *    removed, the branches this deploy created deleted, and the answer names who failed and why, and what removal
 *    could not take back (a worktree kept, a branch left).
 * 2. A member that asks for a worktree on a folder that is not a git repository with a first commit fails at git
 *    with git's words, after others were made: checked first, nothing made, `not-a-repository`.
 * 3. The orchestrator is made and started before its team: it is made last, and started after every member, so the
 *    roster its session reads at its start holds the whole team.
 * 4. A team deployed on a Claude Code that is signed out: refused first with `signed-out`, naming the members it
 *    would run, unless the window says the user knows (`signedOutOk`); and with `cli-missing` when there is no claude
 *    to run them.
 * 5. A member already deployed on the project (its name taken there) is made twice: it is skipped, and said.
 * 6. A start that fails takes the made team back, or is lost: the members stay, and the answer names who did not start.
 * 7. Not started on deploy, a member starts all the same: nothing starts (the brief and the roles are item 11's).
 * 8. Members the deploy cannot tell apart (two with one name or one branch), a branch name git would refuse or that
 *    would leave .worktrees, two orchestrators: refused first, nothing made, `invalid`.
 * 9. A folder that is not one of Tars's projects, or no member at all: refused, nothing made.
 * 10. Two deploys on one project at once make a team twice: the second is refused, `busy`.
 * And from the orchestrator's task of 10/11 (Tars-Frontend's role-saved-on-create.md, M1), before the code:
 * 11. The brief is kept as a member's role (savedPrompt), which every start of it reads: each member's role is its own
 *     saved prompt, and the brief is the orchestrator's first task (each member's when the team has no orchestrator),
 *     taken once at its next start (core/first-task.ts), whether or not the team starts now.
 * 12. Started on deploy, every member works on the brief at once: only the orchestrator gets it; the others start at
 *     their prompt with their role, and wait for its delegations.
 * And from the Audit's gate of #584 (L1, at 13f018132), before the code:
 * 13. A member that fails after its worktree was made (the API not listening, no terminal left) keeps that worktree
 *     and its new branch, while the answer says nothing was kept: they are taken back too, and what cannot be is in
 *     `left`. A worktree that was there before the deploy is never removed.
 * And from the Audit's I1 on #584, made a fix by the orchestrator's task t-e05241d5, before the code:
 * 14. With several Claude accounts, the deploy goes ahead when any one is signed in, and a member starts on one that
 *     is not: the sign-in asked is the one of the accounts the members will start on (newAgentSignIn,
 *     claude-accounts/launch.ts), and a refusal names those that are signed out, in its error and for each member.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deployTeam, type TeamDeployDeps, type TeamDeployParams } from '../../../electron/services/team-deploy';
import type { TeamTemplateMember } from '../../../electron/types/team-template';

const PROJECT = '/work/my-app';
const member = (name: string, over: Partial<TeamTemplateMember> = {}): TeamTemplateMember => ({
  name, character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], ...over,
});
const TEAM = [
  member('Orchestrator', { role: 'orchestrator' }),
  member('Frontend', { worktreeBranch: 'feat/frontend', savedPrompt: 'You own src/.' }),
  member('Backend', { worktreeBranch: 'feat/backend' }),
];

let log: string[];
let deps: TeamDeployDeps;
let failCreate: string | null;
let failStart: string | null;
let failAfterWorktree: boolean;
let signIn: 'signed-in' | 'signed-out' | 'cli-missing' | 'unknown';
let signedOutAccounts: string[];
let repo: boolean;
let names: Set<string>;
let branches: Set<string>;
let roles: Record<string, string>;
let worktrees: Set<string>;
let firstTasks: Record<string, string>;

beforeEach(() => {
  log = [];
  failCreate = null;
  failStart = null;
  signIn = 'signed-in';
  signedOutAccounts = [];
  repo = true;
  names = new Set();
  branches = new Set(['main']);
  roles = {};
  firstTasks = {};
  worktrees = new Set();
  failAfterWorktree = false;
  let n = 0;
  const made = new Map<string, string>();
  const branchOf = new Map<string, string>();
  deps = {
    isProject: p => p === PROJECT,
    takenNames: () => names,
    hasCommit: async () => repo,
    branchExists: async (_p, b) => branches.has(b),
    deleteBranch: async (_p, b) => { log.push(`delete branch ${b}`); branches.delete(b); },
    claudeSignIn: async () => ({ state: signIn, signedOut: signedOutAccounts }),
    worktreeExists: (_p, b) => worktrees.has(b),
    removeWorktree: async (_p, b) => { log.push(`remove worktree ${b}`); worktrees.delete(b); },
    create: async (config) => {
      log.push(`create ${config.name}`);
      if (failCreate && config.name.startsWith(failCreate) && failAfterWorktree && config.worktree?.enabled) {
        // Its worktree made, then the terminal refused (core/no-terminal.ts).
        worktrees.add(config.worktree.branchName);
        branches.add(config.worktree.branchName);
        throw new Error('No terminal is left on this machine');
      }
      if (failCreate && config.name.startsWith(failCreate)) throw new Error('The worktree could not be made: a branch named feat/backend is checked out elsewhere');
      if (config.worktree?.enabled) { branches.add(config.worktree.branchName); worktrees.add(config.worktree.branchName); }
      const id = `id-${++n}`;
      made.set(id, config.name);
      if (config.worktree?.enabled) branchOf.set(id, config.worktree.branchName);
      return { id };
    },
    // As removeAgent: the agent goes, and its worktree with it.
    remove: async (id) => { log.push(`remove ${made.get(id)}`); worktrees.delete(branchOf.get(id) ?? ''); return {}; },
    start: async (id, prompt) => {
      log.push(`start ${made.get(id)}${prompt ? ` with ${prompt}` : ''}`);
      if (failStart && made.get(id)!.startsWith(failStart)) throw new Error('No terminal is left on this machine');
    },
    saveRole: (id, role) => { roles[made.get(id)!] = role; },
    setFirstTask: (id, task) => { log.push(`first task of ${made.get(id)}`); firstTasks[made.get(id)!] = task; },
  };
});

const deploy = (over: Partial<TeamDeployParams> = {}) => deployTeam({ projectPath: PROJECT, members: TEAM, brief: 'Build the login page.', startOnDeploy: true, ...over }, deps);

describe('a team deploy', () => {
  it('3. makes every member, the orchestrator last, and starts it after its whole team', async () => {
    const r = await deploy();
    expect(r).toMatchObject({ success: true, skipped: [], notStarted: [] });
    expect(log).toEqual([
      'create Frontend - my-app', 'create Backend - my-app', 'create Orchestrator - my-app',
      'first task of Orchestrator - my-app',
      'start Frontend - my-app', 'start Backend - my-app', 'start Orchestrator - my-app',
    ]);
    expect(r.success && r.agentIds).toHaveLength(3);
  });

  it('1. takes back every member made when one cannot be made, and says who failed, why, and what it left', async () => {
    failCreate = 'Backend';
    const r = await deploy();
    expect(r).toMatchObject({
      success: false, code: 'failed',
      failed: [{ member: 'Backend', reason: 'The worktree could not be made: a branch named feat/backend is checked out elsewhere' }],
    });
    expect(log).toEqual(['create Frontend - my-app', 'create Backend - my-app', 'remove Frontend - my-app', 'delete branch feat/frontend']);
    expect(branches.has('feat/frontend')).toBe(false);
    expect(log.some(l => l.startsWith('start'))).toBe(false);
  });

  it('1. says what removal could not take back, and leaves the branch of a worktree it kept', async () => {
    failCreate = 'Orchestrator';
    const remove = deps.remove;
    deps.remove = async (id) => {
      await remove(id);
      return id === 'id-1' ? { worktreeKept: 'it holds files git ignores (.env), so its worktree was kept at /work/my-app/.worktrees/feat/frontend' } : {};
    };
    deps.deleteBranch = async (_p, b) => { log.push(`delete branch ${b}`); if (b === 'feat/backend') throw new Error('error: branch not found'); };
    const r = await deploy();
    expect(r.success).toBe(false);
    expect(!r.success && r.left).toEqual([
      'Frontend - my-app: it holds files git ignores (.env), so its worktree was kept at /work/my-app/.worktrees/feat/frontend',
      'the branch feat/backend: error: branch not found',
    ]);
    expect(log).not.toContain('delete branch feat/frontend');
  });

  it('1. never deletes a branch that was there before the deploy', async () => {
    branches.add('feat/frontend');
    failCreate = 'Backend';
    await deploy();
    expect(log).not.toContain('delete branch feat/frontend');
  });

  it('13. takes back the worktree and new branch of the member that failed after making them', async () => {
    failCreate = 'Backend';
    failAfterWorktree = true;
    const r = await deploy();
    expect(r).toMatchObject({ success: false, code: 'failed', failed: [{ member: 'Backend', reason: 'No terminal is left on this machine' }], left: [] });
    expect(log).toEqual([
      'create Frontend - my-app', 'create Backend - my-app',
      'remove Frontend - my-app', 'delete branch feat/frontend',
      'remove worktree feat/backend', 'delete branch feat/backend',
    ]);
    expect(worktrees.size).toBe(0);
  });

  it('13. says what it could not take back of the failing member, and never removes a worktree that was there', async () => {
    failCreate = 'Backend';
    failAfterWorktree = true;
    deps.removeWorktree = async (_p, b) => { throw new Error(`git refused to remove .worktrees/${b}`); };
    const r = await deploy();
    expect(!r.success && r.left).toEqual(['the worktree of Backend: git refused to remove .worktrees/feat/backend']);
    // A worktree there before the deploy stays, whatever fails.
    log = [];
    worktrees = new Set(['feat/backend']);
    deps.removeWorktree = async (_p, b) => { log.push(`remove worktree ${b}`); };
    await deploy();
    expect(log).not.toContain('remove worktree feat/backend');
  });

  it('2. refuses worktrees on a folder with no first commit before making anything', async () => {
    repo = false;
    const r = await deploy();
    expect(r).toMatchObject({ success: false, code: 'not-a-repository' });
    expect(log).toEqual([]);
    // Without worktrees, the same folder takes the team.
    const plain = TEAM.map(m => ({ ...m, worktreeBranch: undefined }));
    expect(await deploy({ members: plain })).toMatchObject({ success: true });
  });

  it('4. refuses a signed-out or missing Claude Code first, unless the window says the user knows', async () => {
    signIn = 'signed-out';
    expect(await deploy()).toMatchObject({ success: false, code: 'signed-out', failed: [
      { member: 'Orchestrator', reason: expect.stringMatching(/signed out/) },
      { member: 'Frontend', reason: expect.stringMatching(/signed out/) },
      { member: 'Backend', reason: expect.stringMatching(/signed out/) },
    ] });
    expect(log).toEqual([]);
    expect(await deploy({ signedOutOk: true })).toMatchObject({ success: true });
    log = [];
    signIn = 'cli-missing';
    expect(await deploy({ signedOutOk: true })).toMatchObject({ success: false, code: 'cli-missing' });
    expect(log).toEqual([]);
    // A team with no Claude member is not asked about.
    signIn = 'signed-out';
    expect(await deploy({ members: [member('Coder', { provider: 'codex' })] })).toMatchObject({ success: true });
  });

  it('14. names the accounts the members would start on that are signed out', async () => {
    signIn = 'signed-out';
    signedOutAccounts = ['Account 1'];
    const r = await deploy();
    expect(r).toMatchObject({ success: false, code: 'signed-out' });
    expect(!r.success && r.error).toMatch(/signed out on Account 1/);
    expect(!r.success && r.failed.map(f => f.reason)).toEqual([
      'Claude Code is signed out on Account 1, the account it would start on',
      'Claude Code is signed out on Account 1, the account it would start on',
      'Claude Code is signed out on Account 1, the account it would start on',
    ]);
    expect(log).toEqual([]);
    signedOutAccounts = ['Account 1', 'Max two'];
    const two = await deploy();
    expect(!two.success && two.failed[0].reason).toBe('Claude Code is signed out on Account 1 and Max two, the accounts it may start on');
    expect(await deploy({ signedOutOk: true })).toMatchObject({ success: true });
  });

  it('5. skips a member already deployed on the project, and says so', async () => {
    names = new Set(['Frontend - my-app']);
    const r = await deploy();
    expect(r).toMatchObject({ success: true, skipped: [{ member: 'Frontend', reason: 'already deployed on this project' }] });
    expect(log.filter(l => l.startsWith('create'))).toEqual(['create Backend - my-app', 'create Orchestrator - my-app']);
  });

  it('6. keeps the team when a start fails, and names who did not start', async () => {
    failStart = 'Backend';
    const r = await deploy();
    expect(r).toMatchObject({ success: true, notStarted: [{ member: 'Backend', reason: 'No terminal is left on this machine' }] });
    expect(log).toContain('start Orchestrator - my-app');
    expect(log.some(l => l.startsWith('remove'))).toBe(false);
  });

  it('7, 11. starts nothing when asked not to, keeps each role as its own, and the brief as the orchestrator\'s first task', async () => {
    const r = await deploy({ startOnDeploy: false });
    expect(r).toMatchObject({ success: true });
    expect(log.some(l => l.startsWith('start'))).toBe(false);
    expect(roles).toEqual({ 'Frontend - my-app': 'You own src/.' });
    expect(firstTasks).toEqual({ 'Orchestrator - my-app': 'Build the login page.' });
  });

  it('11. with no orchestrator, the brief is each member\'s first task; never a role', async () => {
    const workers = TEAM.filter(m => m.role !== 'orchestrator');
    await deploy({ members: workers, startOnDeploy: false });
    expect(firstTasks).toEqual({ 'Frontend - my-app': 'Build the login page.', 'Backend - my-app': 'Build the login page.' });
    expect(roles).toEqual({ 'Frontend - my-app': 'You own src/.' });
    // No brief: no first task.
    firstTasks = {};
    await deploy({ members: [member('Docs')], brief: '  ', startOnDeploy: false });
    expect(firstTasks).toEqual({});
  });

  it('12. started on deploy: the orchestrator takes the brief at its start, the others start with no task', async () => {
    await deploy();
    expect(roles).toEqual({ 'Frontend - my-app': 'You own src/.' });
    expect(firstTasks).toEqual({ 'Orchestrator - my-app': 'Build the login page.' });
    // Each start carries no prompt of its own: the launch types the first task (core/first-task.ts).
    expect(log.filter(l => l.startsWith('start'))).toEqual(['start Frontend - my-app', 'start Backend - my-app', 'start Orchestrator - my-app']);
  });

  it('8. refuses members it cannot tell apart, a bad branch, two orchestrators, before making anything', async () => {
    for (const members of [
      [member('A'), member('A')],
      [member('A', { worktreeBranch: 'feat/x' }), member('B', { worktreeBranch: 'feat/x' })],
      [member('A', { worktreeBranch: '../../etc' })],
      [member('A', { worktreeBranch: 'feat/x.lock' })],
      [member('A', { role: 'orchestrator' }), member('B', { role: 'orchestrator' })],
      [member('')],
    ]) {
      expect(await deploy({ members }), JSON.stringify(members.map(m => [m.name, m.worktreeBranch, m.role]))).toMatchObject({ success: false, code: 'invalid' });
    }
    expect(log).toEqual([]);
  });

  it('9. refuses a folder that is not a project, and an empty team', async () => {
    expect(await deploy({ projectPath: '/somewhere/else' })).toMatchObject({ success: false, code: 'not-a-project' });
    expect(await deploy({ members: [] })).toMatchObject({ success: false, code: 'invalid' });
    expect(log).toEqual([]);
  });

  it('10. refuses a second deploy on the same project while one runs', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const create = deps.create;
    deps.create = async (config) => { await held; return create(config); };
    const first = deploy();
    expect(await deploy()).toMatchObject({ success: false, code: 'busy' });
    release();
    expect(await first).toMatchObject({ success: true });
    expect(await deploy({ members: [member('Docs')] })).toMatchObject({ success: true });
  });
});
