import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { hasPlanMode, modeForProvider, noPlanReason, templateModeOf } from '../../src/lib/plan-mode';

/**
 * Where an agent's permission selectors offer plan (src/lib/plan-mode.ts).
 * PR B (#364) launches claude with --permission-mode plan, and the other CLIs
 * read plan as normal, the narrowest they have; the main process launches an
 * agent with no provider, or one it does not know, as claude. Frames:
 * `Permissions · plan mode · states`. Written before the code. How it can fail:
 * 1. Claude Code is refused plan, the one CLI that has it;
 * 2. a CLI that is not claude (codex, gemini, grok, opencode, amp, pi, ollama)
 *    is offered plan, which it would run as manual;
 * 3. an API-key provider (openrouter, deepseek...), whose launch passes no
 *    plan, is offered plan;
 * 4. an agent with no provider, or an id Tars does not know, both launched as
 *    claude, is refused plan;
 * 5. choosing a provider without plan while plan is chosen keeps plan;
 * 6. choosing a provider changes manual, auto or bypass, or turns plan into
 *    something other than manual;
 * 7. a dimmed plan's reason names no provider, or another one than chosen;
 * 8. an agent in plan saved as a template hands the template plan, which a
 *    template cannot keep, or a template's manual, auto or bypass changes
 *    (added with the template caller tsc found, after the first seven; shown
 *    to bite by its mutant, plan handed through).
 */

describe('hasPlanMode', () => {
  it('offers plan to Claude Code (1)', () => {
    expect(hasPlanMode('claude')).toBe(true);
  });

  it('refuses plan to the CLIs that are not claude (2)', () => {
    for (const id of ['codex', 'gemini', 'grok', 'opencode', 'amp', 'pi', 'ollama']) expect(hasPlanMode(id), id).toBe(false);
  });

  it('refuses plan to the API-key providers, whose launch passes no plan (3)', () => {
    for (const id of ['openrouter', 'deepseek', 'moonshot', 'zhipu', 'minimax', 'venice', 'custom-openai']) expect(hasPlanMode(id), id).toBe(false);
  });

  it('offers plan to an agent launched as claude: no provider, or one Tars does not know (4)', () => {
    expect(hasPlanMode(undefined)).toBe(true);
    expect(hasPlanMode(null)).toBe(true);
    expect(hasPlanMode('')).toBe(true);
    expect(hasPlanMode('local')).toBe(true);
    expect(hasPlanMode('no-such-provider')).toBe(true);
  });
});

describe('modeForProvider', () => {
  it('turns plan into manual on a provider without it (5)', () => {
    expect(modeForProvider('plan', 'codex')).toBe('normal');
    expect(modeForProvider('plan', 'openrouter')).toBe('normal');
  });

  it('keeps plan where it runs, and the other modes everywhere (6)', () => {
    expect(modeForProvider('plan', 'claude')).toBe('plan');
    for (const mode of ['normal', 'auto', 'bypass'] as const) {
      expect(modeForProvider(mode, 'codex')).toBe(mode);
      expect(modeForProvider(mode, 'claude')).toBe(mode);
    }
  });
});

describe('noPlanReason (7)', () => {
  it('names the provider chosen', () => {
    expect(noPlanReason('codex')).toBe('Codex has no plan mode here: plan would run as manual.');
    expect(noPlanReason('openrouter')).toBe('OpenRouter has no plan mode here: plan would run as manual.');
  });
});

describe('templateModeOf (8)', () => {
  it('saves plan as manual, and keeps the three modes a template has', () => {
    expect(templateModeOf('plan')).toBe('normal');
    for (const mode of ['normal', 'auto', 'bypass'] as const) expect(templateModeOf(mode)).toBe(mode);
  });
});
