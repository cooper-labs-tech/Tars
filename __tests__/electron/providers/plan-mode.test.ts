import { describe, it, expect } from 'vitest';
import { getAllProviders } from '../../../electron/providers';
import { hasPlanMode, planModeRefusal } from '../../../electron/providers/plan-mode';
import { hasPlanMode as windowHasPlanMode } from '@/lib/plan-mode';

/**
 * Plan on a provider that has none (the Audit's Low 2 on #407). A Codex agent made in plan runs as normal and
 * edits once it has asked, since codex-provider maps only auto and bypass; the window disables plan for every
 * such provider, with its reason (src/lib/plan-mode.ts).
 *
 * How it fails, written before the code (2026-10-14):
 * 1. Plan is taken for a provider that has none, and nobody is told.
 * 2. The main process's rule and the window's disagree for a provider: one side offers what the other refuses.
 * 3. Plan is refused for Claude Code (no provider named, claude, or local, Claude Code on a local server), or
 *    another mode is refused for any provider.
 * 4. The refusal does not say why: the window's reason, the provider named.
 */

const ids = [...getAllProviders().map((p) => p.id), 'local'];

describe('which providers have plan mode', () => {
  it('2. the main process and the window agree, for every provider and for none', () => {
    for (const id of [...ids, undefined]) expect(hasPlanMode(id), String(id)).toBe(windowHasPlanMode(id));
  });

  it('3. Claude Code has it: no provider named, claude, local', () => {
    for (const id of [undefined, 'claude', 'local']) expect(hasPlanMode(id), String(id)).toBe(true);
  });
});

describe('the refusal of plan', () => {
  it('1, 4. refuses plan for every other provider, naming it, with the window\'s reason', () => {
    for (const p of getAllProviders().filter((p) => p.id !== 'claude')) {
      expect(planModeRefusal(p.id, 'plan'), p.id).toBe(`${p.displayName} has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.`);
    }
  });

  it('3. takes plan for Claude Code, and every other mode for every provider', () => {
    for (const id of [undefined, 'claude', 'local']) expect(planModeRefusal(id, 'plan'), String(id)).toBeNull();
    for (const id of [...ids, undefined]) {
      for (const mode of ['normal', 'auto', 'bypass', undefined]) expect(planModeRefusal(id, mode), `${id} ${mode}`).toBeNull();
    }
  });
});
