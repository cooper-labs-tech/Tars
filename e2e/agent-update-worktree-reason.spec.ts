import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A worktree set in an agent's settings that git cannot make says why, in git's own words, in the real app.
 *
 * agent:update answered every failure with "Failed to create git worktree", which the Agents page shows after
 * "Not saved:" (#403): the user could not tell what to change. And a branch that exists but cannot be checked out
 * there was retried as a new branch, so the reason git gave was the retry's ("a branch named ... already exists").
 *
 * How it fails, written before the fix (2026-10-13, 2.0.2):
 * 1. The project is not a git repository: the answer must say so, not "Failed to create git worktree".
 * 2. A branch name Tars's guard lets through and git refuses (`feat/.hidden`, a component starting with a dot):
 *    the answer must name it as git does ("is not a valid branch name").
 * 3. A branch that exists and is checked out in the project (`main`): the answer must be git's reason for that
 *    branch (already checked out), not the retry's.
 * 4. Over-correction: a branch git takes still makes the worktree and saves it.
 * And from the Audit's MEDIUM on #403 (its probe audit-probe-403-refusal.spec.ts), written before the fix: the
 * name, model, provider, skills and CLI were written onto the live record before git ran, and a new provider or CLI
 * killed the running terminal there; a refusal then undid nothing, while the page says "Not saved: <reason>. Your
 * changes are still here."
 * 5. A refused save changes the record anyway: agent:list gives the new name, and agents.json takes it at the next
 *    save of any agent.
 * 6. A refused save with a new CLI kills the running terminal.
 * And from the Audit's Lows on #405 (GATE-PR405.md), written before the fix (2026-10-15, 2.0.3):
 * 7. agent:create, the other way an agent's worktree is made, kept the retry and git's whole command line: a new
 *    agent on a branch checked out in the project was refused with "Failed to create git worktree for branch main:
 *    Command failed: git worktree add -b main ..." and the retry's "a branch named 'main' already exists", which
 *    New team lists for the member it could not make. It must be git's reason, as for a save; and a branch git
 *    takes still makes the worktree.
 * 8. A git that answers in the user's language: gitRefusal reads "fatal:", so a translated git's refusal came out
 *    as "git refused it without saying why". Every git that makes an agent's worktree runs in the C locale. The git
 *    of this Mac has no translations: here the app's git is a stand-in first on its PATH that answers in French
 *    under LANG=fr_FR, as a translated git does, unless LC_ALL or LC_MESSAGES says otherwise.
 * 9. The secondary path, the refusal that came after the writes until 2.0.2: a save with a rename and a secondary
 *    path that does not exist must be refused, and leave the name.
 * The answers are git's lines without the "fatal: " and without its progress, as gitRefusal (#399) gives them, in
 * the C locale. The artefact: values.json with each answer.
 */

type Answer = { success: boolean; error?: string };
type Listed = { id: string; name?: string; cliPath?: string; cliRunning?: boolean; ptyId?: string };

/** git as a translated one answers (8.): in the language of LC_ALL, else LC_MESSAGES, else LANG. */
const frenchGit = (real: string) => [
  '#!/bin/sh',
  'case "${LC_ALL:-${LC_MESSAGES:-$LANG}}" in fr*) ;; *) exec "' + real + '" "$@" ;; esac',
  'err=$(mktemp) || exit 1',
  '"' + real + '" "$@" 2>"$err"',
  'code=$?',
  "sed -e 's/^fatal: /fatal : /' -e 's/^error: /erreur : /' -e 's/is already checked out at/est déjà extraite dans/'"
    + " -e 's/a branch named \\(.*\\) already exists/une branche nommée \\1 existe déjà/'"
    + " -e \"s/is not a valid branch name/n'est pas un nom de branche valide/\""
    + " -e \"s/not a git repository (or any of the parent directories)/ni ceci ni aucun de ses répertoires parents n'est un dépôt git/\""
    + ' "$err" >&2',
  'rm -f "$err"',
  'exit $code',
  '',
].join('\n');

/** A CLI that only waits at its prompt, as an idle claude does. */
const STAND_IN = String.raw`
process.stdin.setRawMode(true);
process.stdout.write('> ');
process.stdin.on('data', () => {});
process.stdin.resume();
`;

test('a worktree git cannot make is not saved, and the answer is git\'s own reason', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-update-wt-'));
  const plain = path.join(home, 'projects', 'plain');
  const repo = path.join(home, 'projects', 'repo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [plain, repo, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  const otherCli = path.join(bin, 'claude-other');
  for (const f of [cli, otherCli]) fs.writeFileSync(f, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com', HOME: home };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  fs.writeFileSync(path.join(repo, 'README.md'), 'repo\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env });
  const agent = (id: string, projectPath: string) => ({
    id, name: id, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath, skills: [], createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('p1', plain), agent('r1', repo), agent('r2', repo), agent('r3', repo), { ...agent('r4', repo), cliPath: cli }, agent('r5', repo),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([plain, repo]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // 7. A team of one, on the branch checked out in the project.
  fs.writeFileSync(path.join(dir, 'team-templates.json'), JSON.stringify({ user: [{
    id: 'checked-out', name: 'Checked out', description: '', icon: '', createdAt: '2026-10-15T08:00:00.000Z', updatedAt: '2026-10-15T08:00:00.000Z',
    members: [{ name: 'Builder', character: 'robot', provider: 'claude', permissionMode: 'normal', skills: [], worktreeBranch: 'main' }],
  }] }));
  // 8. The app's git, in French unless LC_ALL or LC_MESSAGES says otherwise.
  const gitDir = path.join(home, 'git-fr');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'git'), frenchGit(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()), { mode: 0o755 });

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31436), DOROTHY_E2E: '1',
      PATH: `${gitDir}:${process.env.PATH}`, LANG: 'fr_FR.UTF-8', LC_ALL: '', LC_MESSAGES: '',
    },
  });
  const values: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    const update = (id: string, branchName: string) => page.evaluate(([id, branchName]) =>
      (window as unknown as { electronAPI: { agent: { update(p: unknown): Promise<Answer> } } }).electronAPI.agent.update({ id, worktree: { enabled: true, branchName } }), [id, branchName] as const);
    type Saved = { id: string; worktreePath?: string; branchName?: string };
    const saved = (): Saved[] => {
      // As seeded, a list; as Tars writes it, { version, savedAt, agents }.
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as Saved[] | { agents: Saved[] };
      return Array.isArray(raw) ? raw : raw.agents;
    };

    const list = () => page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Listed[]> } } }).electronAPI.agent.list());
    const r4 = async () => (await list()).find((a) => a.id === 'r4')!;
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: unknown): Promise<unknown> } } }).electronAPI.agent.start({ id: 'r4', prompt: '' }));
    await expect.poll(async () => (await r4()).cliRunning ?? false, { timeout: 60_000 }).toBe(true);
    const before = await r4();

    values.notGit = await update('p1', 'feat/x');
    values.refusedName = await update('r1', 'feat/.hidden');
    values.checkedOut = await update('r2', 'main');
    const taken = await update('r3', 'feat/ok');
    values.taken = { success: taken.success, error: taken.error };
    // 5, 6. A rename and a new CLI in a save git refuses.
    values.refusedWithChanges = await page.evaluate(([cli]) => (window as unknown as { electronAPI: { agent: { update(p: unknown): Promise<Answer> } } }).electronAPI.agent.update({
      id: 'r4', name: 'Renamed', cliPath: cli, worktree: { enabled: true, branchName: 'feat/.hidden' },
    }), [otherCli] as const);
    // 9. A rename, and a secondary path that does not exist.
    values.secondaryMissing = await page.evaluate(([nowhere]) => (window as unknown as { electronAPI: { agent: { update(p: unknown): Promise<Answer> } } }).electronAPI.agent.update({
      id: 'r5', name: 'Renamed', secondaryProjectPath: nowhere,
    }), [path.join(home, 'nowhere')] as const);
    // The next save of any agent writes agents.json whole.
    expect(await page.evaluate(() => (window as unknown as { electronAPI: { agent: { update(p: unknown): Promise<Answer> } } }).electronAPI.agent.update({ id: 'r1', name: 'r1' }))).toMatchObject({ success: true });
    const after = await r4();
    values.r4 = { before: { name: before.name, cliPath: before.cliPath, ptyId: before.ptyId }, after: { name: after.name, cliPath: after.cliPath, ptyId: after.ptyId, cliRunning: after.cliRunning } };
    values.r5 = (await list()).find((a) => a.id === 'r5')!.name;

    // 7, 8. agent:create, the other way an agent's worktree is made.
    type Made = { id?: string; worktreePath?: string | null; error?: string };
    const create = (config: Record<string, unknown>) => page.evaluate(async (config): Promise<Made> => {
      try {
        const made = await (window as unknown as { electronAPI: { agent: { create(c: unknown): Promise<{ id: string; worktreePath?: string }> } } }).electronAPI.agent.create(config);
        return { id: made.id, worktreePath: made.worktreePath ?? null };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }, config);
    const fleet = (await list()).length;
    values.createCheckedOut = await create({ projectPath: repo, name: 'n-main', skills: [], worktree: { enabled: true, branchName: 'main' } });
    values.createNotGit = await create({ projectPath: plain, name: 'n-plain', skills: [], worktree: { enabled: true, branchName: 'feat/y' } });
    values.createdByRefusals = (await list()).length - fleet;
    values.createTaken = await create({ projectPath: repo, name: 'n-new', skills: [], worktree: { enabled: true, branchName: 'feat/new' } });
    // 7. New team lists the member it could not make, with that answer.
    await page.getByRole('button', { name: '+ Team', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New team', exact: true }) });
    await modal.getByRole('button', { name: 'Start from', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'Checked out' }).first().click();
    await modal.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'projects/repo' }).first().click();
    await modal.getByRole('button', { name: 'Deploy 1 agent', exact: true }).click();
    const listed = modal.getByText(/^Builder: /);
    await expect(listed).toBeVisible({ timeout: 30_000 });
    values.teamLine = await listed.innerText();
    values.saved = saved().map((a) => ({ id: a.id, worktreePath: a.worktreePath ?? null, branchName: a.branchName ?? null }));
    recordValues(values);

    expect.soft(values.notGit, '1. not a git repository').toEqual({ success: false, error: expect.stringMatching(/not a git repository/) });
    expect.soft(values.refusedName, '2. a name git refuses').toEqual({ success: false, error: expect.stringContaining("'feat/.hidden' is not a valid branch name") });
    expect.soft(values.checkedOut, '3. checked out in the project').toEqual({ success: false, error: expect.stringMatching(/'main' is already checked out/) });
    for (const answer of [values.notGit, values.refusedName, values.checkedOut] as Answer[]) {
      expect.soft(answer.error ?? '').not.toMatch(/Failed to create git worktree|fatal:|Preparing worktree/);
    }
    expect(values.taken, '4. a branch git takes').toMatchObject({ success: true });
    expect(values.refusedWithChanges).toMatchObject({ success: false });
    expect.soft(after.name, '5. a refused save renamed the agent').toBe('r4');
    expect.soft(after.cliPath, '5. a refused save changed its CLI').toBe(cli);
    expect.soft(saved().find((a) => a.id === 'r4') as unknown as { name?: string }, '5. agents.json took the refused name').toMatchObject({ name: 'r4' });
    expect.soft(after.ptyId, '6. a refused save killed its terminal').toBe(before.ptyId);
    expect.soft(after.cliRunning, '6. its CLI still runs').toBe(true);
    const byId = Object.fromEntries(saved().map((a) => [a.id, a]));
    expect(byId.r3.worktreePath).toBe(path.join(repo, '.worktrees', 'feat', 'ok'));
    expect(fs.existsSync(path.join(repo, '.worktrees', 'feat', 'ok', 'README.md'))).toBe(true);
    for (const id of ['p1', 'r1', 'r2']) expect(byId[id].worktreePath, `${id} saved no worktree`).toBeUndefined();

    expect.soft(values.secondaryMissing, '9. a secondary path that does not exist').toEqual({ success: false, error: 'Secondary project path does not exist' });
    expect.soft(values.r5, '9. a refused save renamed the agent').toBe('r5');
    expect.soft((byId.r5 as unknown as { name?: string }).name, '9. agents.json took the refused name').toBe('r5');
    const notGitsReason = /[Ff]ailed to create git worktree|Command failed|fatal|a branch named|refused it without saying why|déjà|dépôt/;
    expect.soft(values.createCheckedOut, '7. checked out in the project').toEqual({ error: expect.stringMatching(/'main' is already checked out at/) });
    expect.soft(values.createNotGit, '7, 8. not a git repository').toEqual({ error: expect.stringMatching(/The worktree could not be made: not a git repository/) });
    for (const made of [values.createCheckedOut, values.createNotGit] as Made[]) expect.soft(made.error ?? '').not.toMatch(notGitsReason);
    expect.soft(values.createdByRefusals, '7. a refused create made an agent').toBe(0);
    expect.soft(values.teamLine, '7. New team lists git\'s reason').toMatch(/^Builder: .*'main' is already checked out at/);
    expect.soft(values.teamLine).not.toMatch(notGitsReason);
    expect(values.createTaken, '7. a branch git takes').toMatchObject({ worktreePath: path.join(repo, '.worktrees', 'feat', 'new') });
    expect(fs.existsSync(path.join(repo, '.worktrees', 'feat', 'new', 'README.md'))).toBe(true);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
