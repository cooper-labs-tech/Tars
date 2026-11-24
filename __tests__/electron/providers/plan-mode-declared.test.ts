import { describe, it, expect, vi } from 'vitest';

/**
 * QA, t-eb5544ff (#640): plan is each provider's own declaration, never its id.
 *
 * How it fails:
 * 1. hasPlanMode decides by a list of ids (the code before #640): a provider that declares planMode under an id the
 *    list does not hold is taken to have none, and one the list holds that no longer declares it is taken to have one.
 *    The registered providers cannot show it (their declarations and the list agree today), so the registry is a
 *    stand-in here, with an id no list holds and a Claude Code that declares nothing.
 * 2. planModeRefusal follows something other than hasPlanMode: plan refused for the provider that declares it, or
 *    taken for the one that does not.
 */

const STAND_INS: Record<string, { id: string; displayName: string; planMode?: true }> = {
  'new-cli': { id: 'new-cli', displayName: 'New CLI', planMode: true },
  claude: { id: 'claude', displayName: 'Claude Code' },
};
vi.mock('../../../electron/providers/index', () => ({
  getProvider: (id?: string) => STAND_INS[id && id !== 'local' ? id : 'claude'] ?? STAND_INS.claude,
}));

const { hasPlanMode, planModeRefusal } = await import('../../../electron/providers/plan-mode');

describe('plan is the provider\'s declaration (QA, #640)', () => {
  it('1. a provider that declares it has plan, whatever its id; one that does not, has none, whatever its id', () => {
    expect(hasPlanMode('new-cli')).toBe(true);
    expect(hasPlanMode('claude')).toBe(false);
    expect(hasPlanMode(undefined)).toBe(false);
  });

  it('2. the refusal follows the declaration', () => {
    expect(planModeRefusal('new-cli', 'plan')).toBeNull();
    expect(planModeRefusal('claude', 'plan')).toBe('Claude Code has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.');
  });
});
