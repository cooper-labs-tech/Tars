import { describe, it, expect } from 'vitest';
import { claudeStepState, deployOutcome, gitInitLine, readinessLines } from '../../src/lib/first-run';

/**
 * What the first run and New team say from main's answers (2.0.7, PR 584's channels; frame `First run (2.0.7) ·
 * states`, its rows `what a folder lacks`, `deploy answers` and `claude missing`).
 *
 * How it can fail, written before the code:
 * 1. the folder's lacks are not said in main's order (git, repository, commit, remote, gh, gh's sign-in), or one is
 *    dropped;
 * 2. a folder with no repository or no first commit is not offered make it a repository;
 * 3. a remote that is not on GitHub is not said, or a GitHub remote is said as lacking;
 * 4. a first commit signed Tars does not say why nor how to set one's own name;
 * 5. a deploy refused for a plain folder, a signed-out Claude or a missing one does not offer its way on;
 * 6. a failed deploy does not name the member and its reason, or hides what it left;
 * 7. a success does not say what it skipped or did not start;
 * 8. a missing Claude Code reads as a failed check, or offers a sign in that cannot work;
 * 9. a brief deployed with a team whose orchestrator was already there (skipped) goes to nobody, since main gives it
 *    only to an orchestrator it made, and the dialog does not say so (the Audit's L1 on PR 580).
 */

const ready = {
  success: true as const, projectPath: '/p/harbor',
  git: { installed: true, repository: true, hasCommit: true, branch: 'main' },
  remote: { name: 'origin', url: 'git@github.com:you/harbor.git', github: 'you/harbor' },
  gh: { installed: true, signedIn: true, account: 'you', error: null },
  missing: [] as Array<'git' | 'repository' | 'commit' | 'remote' | 'gh' | 'gh-sign-in'>,
};

describe('what a folder lacks', () => {
  it('says each lack in main\'s order, with its way on (1, 2)', () => {
    const lines = readinessLines({ ...ready, git: { installed: true, repository: false, hasCommit: false, branch: null }, remote: null,
      gh: { installed: false, signedIn: null, account: null, error: null }, missing: ['repository', 'remote', 'gh'] });
    expect(lines.map(l => l.text)).toEqual([
      'Not a git repository.',
      'No remote: add one, for instance gh repo create --source . --push',
      'The GitHub CLI is not installed.',
    ]);
    expect(lines[0].action).toBe('git-init');
    expect(lines.slice(1).every(l => !l.action)).toBe(true);
  });

  it('a repository with no first commit is offered the same way on (2)', () => {
    const lines = readinessLines({ ...ready, git: { installed: true, repository: true, hasCommit: false, branch: 'main' }, missing: ['commit'] });
    expect(lines).toEqual([{ key: 'commit', text: 'No first commit yet.', action: 'git-init' }]);
  });

  it('git missing, and gh not signed in, are said (1)', () => {
    expect(readinessLines({ ...ready, missing: ['git'] })[0].text).toBe('Git is not installed.');
    expect(readinessLines({ ...ready, missing: ['gh-sign-in'] })[0].text).toBe('The GitHub CLI is not signed in: run gh auth login.');
  });

  it('a remote off GitHub is said; a ready folder says nothing lacks (3)', () => {
    const off = readinessLines({ ...ready, remote: { name: 'origin', url: 'https://git.example.com/harbor.git', github: null } });
    expect(off.map(l => l.text)).toEqual(['The remote origin is not on GitHub: pull requests go through GitHub.']);
    expect(readinessLines(ready)).toEqual([]);
  });
});

describe('a first commit', () => {
  it('signed with the user\'s own name says what it made (4)', () => {
    expect(gitInitLine({ success: true, branch: 'main', commit: 'abc1234', files: 3, identity: 'yours' }))
      .toEqual({ tone: 'running', text: 'Made a repository on main: 3 files in its first commit.' });
  });

  it('signed Tars says why and how to set one\'s own (4)', () => {
    expect(gitInitLine({ success: true, branch: 'main', commit: 'abc1234', files: 1, identity: 'tars' }).text)
      .toBe('Made a repository on main: 1 file in its first commit, signed Tars, since git knows no name of yours. Set yours with git config --global user.name and user.email.');
  });

  it('refused, says main\'s reason (4)', () => {
    expect(gitInitLine({ success: false, error: 'git is not installed', code: 'git-missing' })).toEqual({ tone: 'error', text: 'git is not installed' });
  });
});

describe('what the deploy answers', () => {
  const refused = (code: 'not-a-repository' | 'signed-out' | 'cli-missing' | 'busy', error: string) =>
    ({ success: false as const, error, code, failed: [], left: [] });

  it('a plain folder, a signed-out or a missing Claude offers its way on (5)', () => {
    expect(deployOutcome(refused('not-a-repository', 'x')).offer).toBe('repository');
    const out = deployOutcome(refused('signed-out', 'x'));
    expect(out).toMatchObject({ done: false, offer: 'signed-out' });
    expect(out.lines[0]).toBe('Claude Code is signed out: the team\'s agents cannot work until it is signed in.');
    expect(deployOutcome(refused('cli-missing', 'x')).lines[0]).toBe('Claude Code is not installed on this computer: install it, then deploy.');
    expect(deployOutcome(refused('busy', 'Another deploy of this project is under way.')).lines).toEqual(['Another deploy of this project is under way.']);
  });

  it('a failed deploy names the member, its reason, and what it left (6)', () => {
    const out = deployOutcome({ success: false, error: 'x', code: 'failed', failed: [{ member: 'Builder', reason: 'not a git repository' }], left: ['Planner\'s worktree at .worktrees/planner'] });
    expect(out).toEqual({ done: false, tone: 'error', offer: null, lines: ['Builder could not be made: not a git repository. Nothing was kept.', 'Left: Planner\'s worktree at .worktrees/planner.'] });
  });

  it('a success says what it skipped or did not start, and nothing more when there is none (7)', () => {
    expect(deployOutcome({ success: true, agentIds: ['a', 'b'], skipped: [], notStarted: [] })).toEqual({ done: true, tone: 'running', offer: null, lines: [] });
    const out = deployOutcome({ success: true, agentIds: ['a'], skipped: [{ member: 'Orchestrator', reason: 'already on this project' }], notStarted: [{ member: 'Builder', reason: 'its CLI did not start' }] });
    expect(out.lines).toEqual(['Skipped: Orchestrator, already on this project.', 'Not started: Builder, its CLI did not start.']);
  });
});

describe('a brief that went to nobody', () => {
  const skippedLead = { success: true as const, agentIds: ['b'], skipped: [{ member: 'Orchestrator', reason: 'already deployed on this project' }], notStarted: [] };

  it('is said when the orchestrator was skipped, and the deploy is not read as done in silence (9)', () => {
    expect(deployOutcome(skippedLead, { brief: 'Ship the settlement rewrite.', lead: 'Orchestrator' })).toEqual({
      done: true, tone: 'waiting', offer: null,
      lines: [
        'Skipped: Orchestrator, already deployed on this project.',
        'The brief went to nobody: Orchestrator was already on this project. Give it the task yourself, in its chat or its terminal.',
      ],
    });
  });

  it('is not said with no brief, or when the orchestrator was made (9)', () => {
    expect(deployOutcome(skippedLead, { lead: 'Orchestrator' }).lines).toEqual(['Skipped: Orchestrator, already deployed on this project.']);
    expect(deployOutcome({ ...skippedLead, skipped: [{ member: 'Builder', reason: 'already deployed on this project' }] }, { brief: 'x', lead: 'Orchestrator' }).lines)
      .toEqual(['Skipped: Builder, already deployed on this project.']);
  });
});

describe('the Claude step', () => {
  it('a missing Claude Code says install, with no sign in (8)', () => {
    expect(claudeStepState({ signedIn: null, email: null, subscriptionType: null, error: 'claude auth status could not run: spawn claude ENOENT', code: 'cli-missing' }))
      .toEqual({ done: false, word: 'not installed', tone: 'waiting', canSignIn: false });
  });

  it('signed out offers sign in; signed in says who (8)', () => {
    expect(claudeStepState({ signedIn: false, email: null, subscriptionType: null, error: null })).toMatchObject({ word: 'signed out', canSignIn: true });
    expect(claudeStepState({ signedIn: true, email: 'a@b.c', subscriptionType: 'max', error: null })).toMatchObject({ done: true, word: 'signed in · a@b.c · max', canSignIn: false });
  });
});
