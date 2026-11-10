import { describe, it, expect } from 'vitest';
import {
  agentOptionsSummary,
  canSubmitAgent,
  canSubmitTeam,
  deployButtonLabel,
  ownWorktreeOf,
  teamDeployFooter,
  teamSelectionSummary,
  worktreeCount,
  worktreeToSave,
} from '@/components/NewChatModal/logic';

/**
 * The one-screen creation flow reads its own state back as the collapsed
 * Options row's summary and the footer's submit gate - both used to be spread
 * across the wizard's Next/Back wiring, hidden inside JSX. Pulled out here so
 * a wrong summary or a submit button that enables too early is a red test,
 * not a screenshot diff nobody looks at closely.
 */

describe('agentOptionsSummary', () => {
  it('drops the skills segment when nothing is selected', () => {
    expect(agentOptionsSummary({ skillsCount: 0, effort: 'medium', useWorktree: false, permissionMode: 'normal' }))
      .toBe('medium effort · normal');
  });

  it('reads the exact form the design frame shows', () => {
    expect(agentOptionsSummary({ skillsCount: 2, effort: 'medium', useWorktree: true, permissionMode: 'auto' }))
      .toBe('2 skills · medium effort · own worktree · auto');
  });

  it('singularises one skill', () => {
    expect(agentOptionsSummary({ skillsCount: 1, effort: 'low', useWorktree: false, permissionMode: 'bypass' }))
      .toBe('1 skill · low effort · bypass');
  });

  it('omits "own worktree" when there is none', () => {
    expect(agentOptionsSummary({ skillsCount: 3, effort: 'high', useWorktree: false, permissionMode: 'auto' }))
      .toBe('3 skills · high effort · auto');
  });
});

describe('canSubmitAgent', () => {
  it('requires a project', () => {
    expect(canSubmitAgent({ projectPath: '', useWorktree: false, branchName: '' })).toBe(false);
  });

  it('allows submit with no worktree once a project is picked', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: false, branchName: '' })).toBe(true);
  });

  it('blocks a worktree with a blank branch', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: true, branchName: '   ' })).toBe(false);
  });

  it('allows a worktree once the branch has real content', () => {
    expect(canSubmitAgent({ projectPath: '/repo', useWorktree: true, branchName: 'feat/x' })).toBe(true);
  });
});

describe('worktreeCount', () => {
  it('counts only members with a non-blank branch', () => {
    expect(worktreeCount([
      { worktreeBranch: 'feat/frontend' },
      { worktreeBranch: '' },
      { worktreeBranch: undefined },
      { worktreeBranch: '  ' },
      { worktreeBranch: 'feat/backend' },
    ])).toBe(2);
  });

  it('is zero for an empty roster', () => {
    expect(worktreeCount([])).toBe(0);
  });
});

describe('teamSelectionSummary', () => {
  it('matches the design frame exactly', () => {
    expect(teamSelectionSummary({ totalMembers: 6, selectedCount: 5, worktrees: 5 })).toBe('5 of 6 selected · 5 worktrees');
  });

  it('singularises one worktree', () => {
    expect(teamSelectionSummary({ totalMembers: 2, selectedCount: 1, worktrees: 1 })).toBe('1 of 2 selected · 1 worktree');
  });
});

describe('canSubmitTeam', () => {
  it('requires a project and at least one selected member', () => {
    expect(canSubmitTeam({ projectPath: '', selectedCount: 3 })).toBe(false);
    expect(canSubmitTeam({ projectPath: '/repo', selectedCount: 0 })).toBe(false);
    expect(canSubmitTeam({ projectPath: '/repo', selectedCount: 1 })).toBe(true);
  });
});

describe('deployButtonLabel', () => {
  it('falls back to a neutral label when nothing is selected yet', () => {
    expect(deployButtonLabel(0)).toBe('Deploy a team');
  });

  it('pluralises the count', () => {
    expect(deployButtonLabel(1)).toBe('Deploy 1 agent');
    expect(deployButtonLabel(5)).toBe('Deploy 5 agents');
  });
});

/**
 * The worktree an agent's settings show and send (JeanBrasse's report of 13/10: set,
 * saved, and nothing kept). agent:list's branchName is the branch the agent's
 * folder is on, read from git (services/agent-truth.ts), so an agent with no
 * worktree of its own has its project's there. Written before the code. How it
 * can fail:
 * 1. an agent with no worktree of its own reads as having one, because its
 *    folder is on a branch: its switch on and locked, nothing to save;
 * 2. an agent with its own worktree reads as free, and a second one is offered;
 * 3. its folder's branch (main) is put in the field of an agent with none;
 * 4. a worktree turned on is not sent, or sent for an agent that already has one
 *    (agent:update ignores it), or sent with a blank or untrimmed branch.
 */
describe('ownWorktreeOf', () => {
  it('reads an agent with no worktree as free, whatever branch its folder is on (1, 3)', () => {
    expect(ownWorktreeOf({ branchName: 'main' })).toEqual({ on: false, branchName: '', locked: false });
    expect(ownWorktreeOf({})).toEqual({ on: false, branchName: '', locked: false });
  });

  it('reads an agent with its own worktree as on and locked, with its branch (2)', () => {
    expect(ownWorktreeOf({ worktreePath: '/p/.worktrees/feat-x', branchName: 'feat/x' })).toEqual({ on: true, branchName: 'feat/x', locked: true });
    expect(ownWorktreeOf({ worktreePath: '/p/.worktrees/feat-x' })).toEqual({ on: true, branchName: '', locked: true });
  });
});

describe('worktreeToSave', () => {
  it('sends a worktree turned on for an agent with none, its branch trimmed (4)', () => {
    expect(worktreeToSave({ useWorktree: true, branchName: '  feat/notes ' }, {})).toEqual({ enabled: true, branchName: 'feat/notes' });
    expect(worktreeToSave({ useWorktree: true, branchName: 'feat/notes' }, { branchName: 'main' })).toEqual({ enabled: true, branchName: 'feat/notes' });
  });

  it('sends nothing when it is off, blank, or the agent has its own already (4)', () => {
    expect(worktreeToSave({ useWorktree: false, branchName: 'feat/notes' }, {})).toBeUndefined();
    expect(worktreeToSave({ useWorktree: true, branchName: '   ' }, {})).toBeUndefined();
    expect(worktreeToSave({ useWorktree: true, branchName: 'feat/y' }, { worktreePath: '/p/.worktrees/feat-x', branchName: 'feat/x' })).toBeUndefined();
  });
});

/**
 * New team's footer: what the deploy will make (2.0.7; frames `Overlay · New team (one screen)` and `First run (2.0.7)
 * · states`, its row `new team from the first run`).
 *
 * How it can fail, written before the code:
 * 1. it names a fixed number of worktrees ("Five"), whatever members are chosen;
 * 2. it counts a member with no branch (the orchestrator on main, or every member after deploy without worktrees);
 * 3. a team none of whose members asks for a worktree (since PR 585, the built-in team) is told worktrees are made,
 *    instead of that the agents make one for each piece of work;
 * 4. it stops saying that nothing is pushed.
 */
describe('teamDeployFooter', () => {
  it('counts the worktrees of the members chosen, not a fixed five (1, 2, 4)', () => {
    expect(teamDeployFooter(4)).toBe('4 worktrees are created under the project, one for each member with a branch. Nothing is pushed.');
    expect(teamDeployFooter(1)).toBe('1 worktree is created under the project, for the member with a branch. Nothing is pushed.');
  });

  it('a team with no branch says no worktree is made now, and who makes them (3, 4)', () => {
    expect(teamDeployFooter(0)).toBe('No worktree is made now: your agents make one for each piece of work. Nothing is pushed.');
  });

  it('reads the count from the members, a member with no branch not counted (2)', () => {
    const members = [{ worktreeBranch: undefined }, { worktreeBranch: 'feat/a' }, { worktreeBranch: '' }, { worktreeBranch: 'feat/b' }];
    expect(teamDeployFooter(worktreeCount(members))).toMatch(/^2 worktrees are created/);
  });
});
