import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';

/**
 * Who OpenRouter is told the traffic comes from.
 *
 * Claude Code sends OR_SITE_URL as the HTTP-Referer OpenRouter attributes an
 * app's traffic to. It said https://tars.app, a domain the project does not
 * own: every OpenRouter request credited, and pointed readers of the ranking
 * to, whoever holds that name. The repository is what the project owns.
 */

import { OpenRouterProvider } from '../../../electron/providers/openrouter-provider';
import { GITHUB_REPO } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';

describe('the OpenRouter attribution', () => {
  it('names the repository, not a domain the project does not own', () => {
    const vars = new OpenRouterProvider().getPtyEnvVars('a1', '/tmp/project', [], { openRouterApiKey: 'sk-or-test' } as AppSettings);

    expect(vars.OR_SITE_URL).toBe(`https://github.com/${GITHUB_REPO}`);
    expect(Object.values(vars).join(' ')).not.toContain('tars.app');
  });
});
