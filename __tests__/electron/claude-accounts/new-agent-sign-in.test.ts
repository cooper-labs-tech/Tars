/**
 * The Claude account a new agent will start on, and whether it is signed in
 * (electron/services/claude-accounts/launch.ts: accountsANewAgentMayStartOn,
 * newAgentSignIn). What teams:deploy checks each Claude member against before
 * it makes anything (QA's B3, and the Audit's I1 on #584): until now the deploy
 * went ahead when any one account was signed in, and a member could still start
 * on one that was not, in a terminal asking for a login nobody sees.
 *
 * How it fails, written before the code (10/11, the orchestrator's task t-e05241d5):
 * 1. Any one account signed in is taken as enough: with a credential override in
 *    ~/.claude/settings.json or Tars's environment, every agent starts on account 1,
 *    whichever account is signed in. Account 1 signed out: refused, and named.
 * 2. With the option off, another account's sign-in counts: only account 1 runs
 *    anything, so only its sign-in counts, and no account is named (there is one).
 * 3. An account whose folder cannot be used (not Tars's own, or a projects/ of its
 *    own holding something) is taken for one a member starts on: its launch starts
 *    it on account 1 instead, and account 1's sign-in is what counts.
 * 4. No account can run (all signed out): the launch falls back to account 1, so
 *    the deploy is refused on account 1, named.
 * 5. Asked too broadly: an account the launch never gives a new agent (disabled,
 *    or signed out while another can run) refuses a team whose members all land
 *    on a signed-in account. Only the accounts the launch can choose count.
 * 6. A disabled account that is signed in is counted as one a member may start on.
 * 7. A claude that is not there is read as signed out: `cli-missing`, whatever
 *    the accounts say.
 * 8. Account 1 whose answer is unknown (its status could not be read) is either
 *    refused as signed out or claimed signed in: the launch keeps it as an account
 *    that can run until it says signed out, so the answer is `unknown`, which the
 *    deploy does not refuse.
 * 9. Several accounts can take the members: each is one they may start on, in the
 *    order of the list, and all of them must be signed in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { accountsANewAgentMayStartOn, newAgentSignIn } from '../../../electron/services/claude-accounts/launch';
import { setAuth, resetAccountState } from '../../../electron/services/claude-accounts/state';
import { normalizeAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import type { ClaudeAccountsSettings } from '../../../electron/types';

const A = 'acct-aaaaaa';
const B = 'acct-bbbbbb';
type Answer = 'signed-in' | 'signed-out' | 'cli-missing' | 'unknown';

function settings(over: Partial<ClaudeAccountsSettings> = {}, disabled: string[] = []): ClaudeAccountsSettings {
  return {
    ...normalizeAccountsSettings({
      enabled: true,
      accounts: [
        { id: 'default', label: 'Account 1', enabled: !disabled.includes('default') },
        { id: A, label: 'Max two', enabled: !disabled.includes(A) },
        { id: B, label: 'Max three', enabled: !disabled.includes(B) },
      ],
    }),
    ...over,
  };
}

/** The answers of `claude auth status`, recorded as the handler records them (setAuth), then given as they came. */
function answered(answers: Record<string, Answer>): Record<string, Answer> {
  for (const [id, a] of Object.entries(answers)) {
    if (a === 'signed-in' || a === 'signed-out') setAuth(id, { signedIn: a === 'signed-in', email: null, subscriptionType: null, error: null });
  }
  return answers;
}

const clean = { overrides: [] as string[], folderProblem: () => null };

beforeEach(() => resetAccountState());

describe('the accounts a new agent may start on', () => {
  it('1. a credential override sends every agent to account 1, whichever is signed in', () => {
    const s = settings();
    const answers = answered({ default: 'signed-out', [A]: 'signed-in', [B]: 'signed-in' });
    const opts = { ...clean, overrides: ['ANTHROPIC_API_KEY'] };
    expect(accountsANewAgentMayStartOn(s, opts)).toEqual(['default']);
    expect(newAgentSignIn(s, answers, opts)).toEqual({ state: 'signed-out', signedOut: ['Account 1'] });
  });

  it('2. with the option off, only account 1 counts, and none is named', () => {
    const s = settings({ enabled: false });
    const answers = answered({ default: 'signed-out', [A]: 'signed-in' });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default']);
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'signed-out', signedOut: [] });
    expect(newAgentSignIn(s, answered({ default: 'signed-in', [A]: 'signed-out' }), clean)).toEqual({ state: 'signed-in', signedOut: [] });
  });

  it('3. an account whose folder cannot be used gives its place to account 1', () => {
    const s = settings();
    const answers = answered({ default: 'signed-out', [A]: 'signed-in', [B]: 'signed-out' });
    const opts = { ...clean, folderProblem: (dir: string) => (dir.endsWith(A) ? 'its projects/ is a folder of its own' : null) };
    expect(accountsANewAgentMayStartOn(s, opts)).toEqual(['default']);
    expect(newAgentSignIn(s, answers, opts)).toEqual({ state: 'signed-out', signedOut: ['Account 1'] });
  });

  it('4. with no account that can run, account 1 is where they start', () => {
    const s = settings();
    const answers = answered({ default: 'signed-out', [A]: 'signed-out', [B]: 'signed-out' });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default']);
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'signed-out', signedOut: ['Account 1'] });
  });

  it('5. an account the launch never gives a new agent does not refuse the team', () => {
    const s = settings({}, [B]);
    const answers = answered({ default: 'signed-out', [A]: 'signed-in', [B]: 'signed-out' });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual([A]);
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'signed-in', signedOut: [] });
  });

  it('6. a disabled account, signed in, is not one they may start on', () => {
    const s = settings({}, [A]);
    const answers = answered({ default: 'signed-out', [A]: 'signed-in', [B]: 'signed-out' });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default']);
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'signed-out', signedOut: ['Account 1'] });
  });

  it('7. no claude to ask: cli-missing, whatever the accounts say', () => {
    const s = settings();
    const answers = answered({ default: 'cli-missing', [A]: 'signed-in' });
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'cli-missing', signedOut: [] });
  });

  it('8. account 1 not read is kept as one that can run: unknown, neither refused nor claimed', () => {
    const s = settings({ enabled: false });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default']);
    expect(newAgentSignIn(s, answered({ default: 'unknown' }), clean)).toEqual({ state: 'unknown', signedOut: [] });
    const on = settings();
    const answers = answered({ default: 'unknown', [A]: 'signed-out', [B]: 'signed-out' });
    expect(accountsANewAgentMayStartOn(on, clean)).toEqual(['default']);
    expect(newAgentSignIn(on, answers, clean)).toEqual({ state: 'unknown', signedOut: [] });
  });

  it('9. every account that can take them counts, in the order of the list', () => {
    const s = settings();
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default']);
    const answers = answered({ default: 'signed-in', [A]: 'signed-in', [B]: 'signed-in' });
    expect(accountsANewAgentMayStartOn(s, clean)).toEqual(['default', A, B]);
    expect(newAgentSignIn(s, answers, clean)).toEqual({ state: 'signed-in', signedOut: [] });
  });
});
