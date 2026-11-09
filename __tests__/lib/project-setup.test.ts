import { describe, it, expect } from 'vitest';
import { ciDoneLine, ciLine, claudeMdDoneLine, claudeMdLine, permissionOutcome, teamOf } from '../../src/lib/project-setup';

/**
 * What the window says of a project's setup offers (2.0.7; PR 586's electronAPI.projectSetup; frame `First run (2.0.7)
 * · states`, its rows `what a project is offered`, `after yes, and what is not offered` and `a project's panel, its
 * team there`).
 *
 * How it can fail, written before the code:
 * 1. a CI offer does not name the checks it runs, nor the branch its pull requests go into, or offers a yes when the
 *    project has a workflow or the CI does not apply;
 * 2. a CI that does not apply hides main's reason, or rewords it;
 * 3. a committed CI does not say where (the branch, the worktree) and that nothing was pushed, or a refusal does not
 *    say main's error in the error tone;
 * 4. a CLAUDE.md the project has is offered again, or a refusal reads as written;
 * 5. the team counted for the permission level is not main's (the project's agents, never another project's, never a
 *    chat's runner), so the button names a number main does not change;
 * 6. a permission level applied to some agents and refused for others reads as done, or hides who failed and why;
 *    one refused before any agent (main's error) reads as nothing.
 */

const P = '/u/projects/harbor';
const CI = [
  'name: CI', 'on:', '  pull_request:', '    branches: [main]', '  push:', '    branches: [main]', 'jobs:',
].join('\n');

describe('the CI offer', () => {
  it('names the checks and the branch, and offers the yes (1)', () => {
    expect(ciLine({ state: 'offer', path: `${P}/.github/workflows/ci.yml`, content: CI, checks: ['npm ci', 'npm run lint', 'npm test'], stack: 'node' }, P))
      .toEqual({ tone: 'waiting', text: 'A CI workflow for GitHub: npm ci, npm run lint, npm test on each pull request into main.', offer: true });
  });

  it('a workflow the project has reads done, with its path in the project, and no yes (1)', () => {
    expect(ciLine({ state: 'present', path: `${P}/.github/workflows/ci.yml` }, P))
      .toEqual({ tone: 'running', text: 'Has a CI workflow: .github/workflows/ci.yml', offer: false });
  });

  it('a CI that does not apply says main\'s reason as main words it, quietly (2)', () => {
    const why = 'Its remote is not on GitHub (git@git.example.com:you/harbor.git): Tars offers GitHub Actions only.';
    expect(ciLine({ state: 'not_github', why }, P)).toEqual({ tone: 'idle', text: why, offer: false });
  });

  it('a committed CI says the branch, the worktree and that nothing was pushed; a refusal says main\'s error (3)', () => {
    expect(ciDoneLine({ success: true, branch: 'chore/ci', worktree: `${P}/.worktrees/chore/ci`, file: `${P}/.worktrees/chore/ci/.github/workflows/ci.yml` }, P))
      .toEqual({ tone: 'running', text: 'Committed .github/workflows/ci.yml on chore/ci, in .worktrees/chore/ci, not pushed: your orchestrator delivers it as a pull request.' });
    expect(ciDoneLine({ success: false, error: 'The branch chore/ci exists already: Tars writes nothing over it.', code: 'exists' }, P))
      .toEqual({ tone: 'error', text: 'The branch chore/ci exists already: Tars writes nothing over it.' });
  });
});

describe('the CLAUDE.md offer', () => {
  it('offers the yes, or reads done when the project has one (4)', () => {
    expect(claudeMdLine({ state: 'offer', path: `${P}/CLAUDE.md`, content: '# harbor' }))
      .toEqual({ tone: 'waiting', text: 'A short CLAUDE.md: the checks, each agent\'s area, and how a change is delivered.', offer: true });
    expect(claudeMdLine({ state: 'present', path: `${P}/CLAUDE.md` })).toEqual({ tone: 'running', text: 'Has its CLAUDE.md.', offer: false });
  });

  it('written says so; refused says main\'s error (4)', () => {
    expect(claudeMdDoneLine({ success: true, path: `${P}/CLAUDE.md` })).toEqual({ tone: 'running', text: 'Wrote CLAUDE.md.' });
    const error = `The project has a CLAUDE.md already: ${P}/CLAUDE.md. Tars writes nothing over it.`;
    expect(claudeMdDoneLine({ success: false, error, code: 'exists' })).toEqual({ tone: 'error', text: error });
  });
});

describe('one permission level for the team', () => {
  it('counts the project\'s own agents, never another project\'s nor a chat\'s runner (5)', () => {
    const fleet = [
      { id: 'lead', projectPath: P }, { id: 'fe', projectPath: P }, { id: 'chat', projectPath: P, kind: 'chat' },
      { id: 'other', projectPath: '/u/projects/shop' }, { id: 'nested', projectPath: `${P}/sub` },
    ];
    expect(teamOf(fleet, P).map(a => a.id)).toEqual(['lead', 'fe']);
  });

  it('says how many took it, and who did not and why (6)', () => {
    expect(permissionOutcome({ success: true, agents: [{ id: 'a', name: 'Lead', success: true }, { id: 'b', name: 'Builder', success: true }] }, 'auto'))
      .toEqual([{ tone: 'running', text: 'Set to auto: 2 of 2 agents.' }]);
    expect(permissionOutcome({ success: false, agents: [{ id: 'a', name: 'Lead', success: true }, { id: 'b', name: 'Builder', success: false, error: 'Agent not found' }] }, 'bypass'))
      .toEqual([{ tone: 'waiting', text: 'Set to bypass: 1 of 2 agents.' }, { tone: 'error', text: 'Builder: Agent not found.' }]);
  });

  it('a refusal before any agent says main\'s error (6)', () => {
    expect(permissionOutcome({ success: false, error: 'permissionMode is one of plan, normal, auto, bypass.' }, 'auto'))
      .toEqual([{ tone: 'error', text: 'permissionMode is one of plan, normal, auto, bypass.' }]);
  });
});
