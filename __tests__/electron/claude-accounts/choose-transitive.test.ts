import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { chooseAccount } from '../../../electron/services/claude-accounts/choose';

/**
 * QA, gate of #267: "the most room" with three accounts or more.
 *
 * The sort compares accounts in pairs, and two accounts within TIE_POINTS
 * (5) of each other are ordered by the list instead of by room. That rule is
 * not transitive: with margins 2, 6 and 10, 2 ties with 6 and 6 ties with 10,
 * while 10 beats 2 by 8 points. The sort never compares the first account with
 * the last, and the account with 2 points of room was chosen over the one
 * with 10, whichever way the list was ordered.
 *
 * What must hold: the accounts within TIE_POINTS of the BEST margin are the
 * ones the tie rule may reorder; an account more than TIE_POINTS below the
 * best is never chosen while one with room has the best margin.
 */
const now = Date.now();
const resets = Math.floor(now / 1000) + 3600;
const usage = (fiveHourUsed: number) => ({
  fiveHour: { usedPercentage: fiveHourUsed, resetsAt: resets },
  sevenDay: { usedPercentage: 0, resetsAt: resets + 86_400 },
  updatedAt: now,
});
const ids = ['default', 'acct-bbbbbb', 'acct-cccccc'];

function choose(used: number[]) {
  return chooseAccount({
    accounts: ids.map(id => ({ id, enabled: true, signedIn: true })),
    fiveHourThreshold: 90,
    weeklyThreshold: 90,
    usage: Object.fromEntries(ids.map((id, i) => [id, usage(used[i])])),
    blockedUntil: {},
    load: {},
    now,
  });
}

describe('the account with the most room, among three', () => {
  for (const used of [[88, 84, 80], [84, 88, 80], [88, 80, 84], [80, 84, 88], [84, 80, 88], [80, 88, 84]]) {
    it(`never picks a margin more than 5 points below the best (5 h used ${used.join('/')})`, () => {
      const margins = used.map(u => 90 - u);
      const best = Math.max(...margins);
      const chosen = choose(used);
      const margin = margins[ids.indexOf(chosen.accountId)];
      expect(best - margin, `chose ${chosen.accountId} with ${margin} points of room, where one had ${best}`).toBeLessThanOrEqual(5);
    });
  }
});
