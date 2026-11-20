import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { PROVIDER_REGISTRY, getProviderDef } from '../../src/lib/providers';
import { hasPlanMode, modeForProvider } from '../../src/lib/plan-mode';
import { cliById, cliForProvider } from '../../src/lib/clis';
import { providerText } from '../../src/lib/task-costs';

/**
 * The window's side of Qwen Code (2.0.4, on #461's provider `qwen-code`, the CLI `qwen`).
 *
 * Written before the code. The ways it can fail:
 * 1. Qwen Code is not in the provider registry, so New agent cannot pick it and a card names it `qwen-code`.
 * 2. Qwen Code and the Qwen API (`qwen`, the API through the claude binary) read the same, so one is picked for the other.
 * 3. Qwen Code is refused plan, which its CLI runs (--approval-mode plan, offered by the main process since #461).
 * 4. Qwen Code carries a fixed model list, stale against the user's own settings: its models come from the CLI.
 * 5. The one list of CLIs still gives Qwen Code no provider, so Providers says Tars does not drive it.
 * 6. Usage names its tasks `qwen-code` rather than Qwen Code.
 */

describe('Qwen Code in the registry (1, 2, 4)', () => {
  it('is a CLI named Qwen Code, with no fixed model list', () => {
    const def = getProviderDef('qwen-code');
    expect(def?.label).toBe('Qwen Code');
    expect(def?.requiresCli).toBe(true);
    expect(def?.models).toEqual([]);
  });
  it('cannot be mistaken for the Qwen API', () => {
    const api = getProviderDef('qwen')?.label ?? '';
    expect(api).not.toBe('Qwen Code');
    expect(api).toMatch(/API/);
    expect(PROVIDER_REGISTRY.filter((p) => p.label === 'Qwen Code')).toHaveLength(1);
  });
});

describe('plan (3)', () => {
  it('offers plan to Qwen Code, and keeps it when Qwen Code is picked', () => {
    expect(hasPlanMode('qwen-code')).toBe(true);
    expect(modeForProvider('plan', 'qwen-code')).toBe('plan');
    expect(hasPlanMode('qwen')).toBe(false);
  });
});

describe('the one list, and Usage (5, 6)', () => {
  it('drives Qwen Code through its provider', () => {
    expect(cliById('qwen-code')?.provider).toBe('qwen-code');
    expect(cliForProvider('qwen-code')?.command).toBe('qwen');
  });
  it('names its tasks Qwen Code in Usage', () => {
    expect(providerText({ provider: 'qwen-code' } as Parameters<typeof providerText>[0], {})).toBe('Qwen Code');
  });
});
