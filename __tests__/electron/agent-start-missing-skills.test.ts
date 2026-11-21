import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { getProvider, getAllProviders } from '../../electron/providers';

/**
 * An agent whose record has no `skills` array could not start, at all.
 *
 * `AgentStatus.skills` is typed as required, so nothing warned, but the field is
 * only written by builds that had it: a file from an older version, a hand edit,
 * or a restored backup arrives without it. `agent:start` passes `agent.skills`
 * straight into `getPtyEnvVars`, and every one of the fifteen providers opens by
 * joining it, so the whole call threw
 *
 *     TypeError: Cannot read properties of undefined (reading 'join')
 *
 * The user saw nothing except an agent that refused to run, with the reason
 * buried in a rejected IPC call. Found by launching the packaged 1.6.0 against a
 * seeded home directory.
 *
 * `output` had the identical shape of problem and was fixed in loadAgents with a
 * comment describing it; `skills` two lines away was left out. That habit is why
 * this test covers every provider rather than the one that was reported.
 */

describe('getPtyEnvVars with no skills array', () => {
  const providers = getAllProviders();

  it('covers every registered provider', () => {
    // If a provider is added and this list does not grow, the loop below is
    // quietly testing less than it claims to.
    expect(providers.length).toBeGreaterThanOrEqual(15);
  });

  for (const provider of providers) {
    it(`${provider.id} survives undefined`, () => {
      const env = provider.getPtyEnvVars(
        'agent-1',
        '/Users/you/proj',
        undefined as unknown as string[],
        {} as never,
      );
      expect(env).toBeTypeOf('object');
      // Whichever name this provider uses for the variable, it is a string.
      const skillsVar = env.CLAUDE_SKILLS ?? env.DOROTHY_SKILLS;
      if (skillsVar !== undefined) expect(skillsVar).toBe('');
    });
  }

  it('still passes real skills through', () => {
    const env = getProvider('claude').getPtyEnvVars(
      'agent-1',
      '/Users/you/proj',
      ['superpowers', 'remember'],
      {} as never,
    );
    expect(env.CLAUDE_SKILLS).toBe('superpowers,remember');
  });

  it('treats an empty array the same as a missing one', () => {
    const withEmpty = getProvider('claude').getPtyEnvVars('a', '/p', [], {} as never);
    const withNone = getProvider('claude').getPtyEnvVars('a', '/p', undefined as unknown as string[], {} as never);
    expect(withEmpty.CLAUDE_SKILLS).toBe(withNone.CLAUDE_SKILLS);
  });
});
