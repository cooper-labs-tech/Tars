// E2E: the first run's backend, through the window's own channels (project.readiness, project.gitInit,
// teams.deploy, claudeAccounts), in a sandbox Tars with a stand-in claude.
//
// From QA's fresh-install report (fresh-install-turnkey.md: B3, B4, H3, W4) and Tars-Frontend's request
// (first-run-window.md). Written before the code (10/11), the ways it fails:
// 1. A plain folder reads as ready, or what it lacks is not said: readiness names repository, first commit, remote,
//    and gh (missing or signed out), in that order.
// 2. A team that asks for worktrees on a plain folder makes the orchestrator alone and fails the rest with git's raw
//    words: refused before anything is made (`not-a-repository`), no agent left.
// 3. Nothing makes the folder a repository: gitInit gives it `main` and a first commit holding its files.
// 4. The team is made one by one and the orchestrator is started before its team exists, its bootstrap's roster
//    empty: every member is made, the orchestrator started last, and the roster its session reads names the team.
// 5. Without a Hermes gateway the orchestrator is sent to a Hermes board that is not there: its bootstrap says there
//    is no kanban board.
// 6. A deploy one member of which cannot be made leaves the others: every member made by it is removed, and the
//    answer names who failed and why.
// 7. A team deployed on a signed-out Claude Code with no word: refused first (`signed-out`).
// 8. A claude that is not there reads like any failure: the account says `cli-missing`.
// 9. (the orchestrator's task of 10/11) A team not started loses its brief, or keeps it as the orchestrator's role:
//    its role stays its own, the brief is its first task, typed once at its first start, then gone.
// Its artefact, in the run directory: values.json (the answers asserted), launches.jsonl (each stand-in launch, with
// the bootstrap it read), app.log (the main process's log, whose `[team-deploy] ... starting` lines give the order
// Tars launched the team in: its first run, the night of 10/11, compared the stand-ins' own start times instead, and a
// member's shell, slower under load, started its CLI 232 ms after the orchestrator's), and screenshots of the window.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

const PORT = apiPort(31469);

/** A claude that answers `auth status` (signed out while a marker file is there), and otherwise records its launch and the bootstrap Tars gives it. */
function standInClaude(dir) {
  return writeNodeCli(path.join(dir, 'claude'), `
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  const out = fs.existsSync(path.join(dir, 'signed-out'));
  console.log(JSON.stringify(out ? { loggedIn: false, authMethod: 'none' } : { loggedIn: true, authMethod: 'claude.ai', email: 'new.user@example.com', subscriptionType: 'pro' }));
  process.exit(out ? 1 : 0);
}
const id = process.env.CLAUDE_AGENT_ID;
const at = Date.now();
fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/' + id + '/bootstrap', { headers: { Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN } })
  .then(r => r.json()).catch(e => ({ error: String(e) }))
  .then(b => {
    fs.appendFileSync(path.join(dir, 'launches.jsonl'), JSON.stringify({ id, at, args: args.join(' '), bootstrap: b.context ?? b.error ?? null }) + '\\n');
  });
setInterval(() => {}, 60000);
`);
}

function seed() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-first-run-be-')));
  const project = path.join(home, 'work', 'my-app');
  const other = path.join(home, 'work', 'other-app');
  const bin = path.join(home, 'stand-in');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), bin, project, other]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("hello")\n');
  const claude = standInClaude(bin);
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), '[]');
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project, other], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return { home, project, other, bin, claude };
}

const team = [
  { name: 'Orchestrator', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], role: 'orchestrator' },
  { name: 'Frontend', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], worktreeBranch: 'feat/frontend', savedPrompt: 'You own src/.' },
  { name: 'Backend', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], worktreeBranch: 'feat/backend' },
];

test('a plain folder becomes a repository, takes its whole team, and its orchestrator starts last with the team in its roster', async () => {
  test.setTimeout(5 * 60_000);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const { home, project, other, bin, claude } = seed();
  const values = { project };
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/`, DOROTHY_API_PORT: PORT, DOROTHY_E2E: '1' },
  });
  // The main process's log: the order Tars launches the team in, which is what it holds to. Each CLI then starts when
  // its own shell is ready, and under load a member's started after the orchestrator's (232 ms, the night of 10/11).
  const appLog = path.join(OUT, 'app.log');
  app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI?.project?.gitInit, null, { timeout: 300_000 });
    const call = (fn, arg) => page.evaluate(([f, a]) => {
      const [ns, name] = f.split('.');
      return window.electronAPI[ns][name](...a);
    }, [fn, arg]);
    const agents = () => page.evaluate(() => window.electronAPI.agent.list());

    // 1. A plain folder: what it lacks, in the order it is fixed.
    values.plain = await call('project.readiness', [project]);
    expect(values.plain).toMatchObject({ success: true, git: { repository: false, hasCommit: false }, remote: null });
    expect(values.plain.missing.slice(0, 3)).toEqual(['repository', 'commit', 'remote']);
    expect(values.plain.missing.some(m => m === 'gh' || m === 'gh-sign-in'), 'gh, missing or signed out in the sandbox').toBe(true);

    // 2. Worktrees on a plain folder: refused, nothing made.
    values.refused = await call('teams.deploy', [{ projectPath: project, members: team, brief: 'Build the login page.', startOnDeploy: true }]);
    expect(values.refused).toMatchObject({ success: false, code: 'not-a-repository' });
    expect(await agents()).toEqual([]);

    // 3. Made a repository, its file in the first commit.
    values.init = await call('project.gitInit', [project]);
    expect(values.init).toMatchObject({ success: true, branch: 'main', files: 1 });
    values.repo = await call('project.readiness', [project]);
    expect(values.repo).toMatchObject({ git: { repository: true, hasCommit: true, branch: 'main' } });
    expect(values.repo.missing[0]).toBe('remote');

    // 4, 5. The whole team, the orchestrator last, its roster full, and no board without Hermes.
    values.deployed = await call('teams.deploy', [{ projectPath: project, members: team, brief: 'Build the login page.', startOnDeploy: true }]);
    expect(values.deployed).toMatchObject({ success: true, skipped: [], notStarted: [] });
    expect(values.deployed.agentIds).toHaveLength(3);
    const launches = path.join(bin, 'launches.jsonl');
    await expect.poll(() => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').length : 0), { timeout: 90_000 }).toBe(3);
    const launched = fs.readFileSync(launches, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    fs.copyFileSync(launches, path.join(OUT, 'launches.jsonl'));
    const byName = Object.fromEntries((await agents()).map(a => [a.name, a]));
    values.agents = Object.values(byName).map(a => ({ name: a.name, role: a.role, branch: a.branchName ?? null }));
    const lead = byName['Orchestrator - my-app'];
    expect(lead?.role).toBe('orchestrator');
    const leadLaunch = launched.find(l => l.id === lead.id);
    values.launchOrder = fs.readFileSync(appLog, 'utf8').split('\n')
      .map(l => /\[team-deploy\] .*: starting (.+), (\d+) of (\d+)$/.exec(l.trim())).filter(Boolean).map(m => m[1]);
    expect(values.launchOrder, 'Tars launches the orchestrator after every member').toEqual(['Frontend - my-app', 'Backend - my-app', 'Orchestrator - my-app']);
    expect(leadLaunch.bootstrap).toContain('"Frontend - my-app"');
    expect(leadLaunch.bootstrap).toContain('"Backend - my-app"');
    expect(leadLaunch.bootstrap).toMatch(/no kanban board/i);
    expect(leadLaunch.bootstrap).not.toContain('Hermes board');

    // 6. One member that cannot be made: none of this deploy is left.
    const before = (await agents()).map(a => a.id).sort();
    values.partial = await call('teams.deploy', [{ projectPath: project, startOnDeploy: false, members: [
      { name: 'Docs', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [] },
      { name: 'Reviewer', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], worktreeBranch: 'feat/frontend' },
    ] }]);
    expect(values.partial).toMatchObject({ success: false, code: 'failed', failed: [{ member: 'Reviewer', reason: expect.stringMatching(/worktree/) }] });
    expect((await agents()).map(a => a.id).sort()).toEqual(before);

    // 9. Not started: the orchestrator's role is its own, the brief its first task, typed once at its first start.
    values.idle = await call('teams.deploy', [{ projectPath: other, startOnDeploy: false, brief: 'Write the README.', members: [
      { name: 'Lead', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], role: 'orchestrator', savedPrompt: 'You lead other-app.' },
      { name: 'Writer', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [] },
    ] }]);
    expect(values.idle).toMatchObject({ success: true });
    const idleLead = () => agents().then(list => list.find(a => a.name === 'Lead - other-app'));
    values.idleLeadBefore = await idleLead();
    expect(values.idleLeadBefore).toMatchObject({ savedPrompt: 'You lead other-app.', firstTask: { text: 'Write the README.' } });
    expect((await agents()).find(a => a.name === 'Writer - other-app')?.firstTask).toBeUndefined();
    await page.evaluate(id => window.electronAPI.agent.start({ id, prompt: '' }), values.idleLeadBefore.id);
    await expect.poll(() => fs.readFileSync(launches, 'utf8').includes(values.idleLeadBefore.id), { timeout: 90_000 }).toBe(true);
    const firstLaunch = fs.readFileSync(launches, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(l => l.id === values.idleLeadBefore.id);
    expect(firstLaunch.args).toContain('Write the README.');
    values.idleLeadAfter = await idleLead();
    expect(values.idleLeadAfter.firstTask).toBeUndefined();
    expect(values.idleLeadAfter.savedPrompt).toBe('You lead other-app.');

    // 7. Signed out: refused before anything is made.
    const beforeSignedOut = (await agents()).map(a => a.id).sort();
    fs.writeFileSync(path.join(bin, 'signed-out'), '');
    await call('claudeAccounts.refresh', ['default']);
    values.signedOut = await call('teams.deploy', [{ projectPath: project, startOnDeploy: false, members: [
      { name: 'Writer', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [] },
    ] }]);
    expect(values.signedOut).toMatchObject({ success: false, code: 'signed-out' });
    expect((await agents()).map(a => a.id).sort()).toEqual(beforeSignedOut);

    // 8. No claude at all: the account says so.
    fs.renameSync(claude, `${claude}.gone`);
    const view = await call('claudeAccounts.refresh', ['default']);
    values.missing = view?.accounts?.find(a => a.id === 'default') ?? view;
    expect(values.missing).toMatchObject({ signedIn: null, code: 'cli-missing' });

    await page.screenshot({ path: path.join(OUT, 'end.png') });
  } finally {
    recordValues(values);
    await app.close().catch(() => {});
  }
});
