import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, settle, type Mount } from './hook-runtime';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));
vi.mock('../../src/lib/error-reports', () => ({ followErrorReports: vi.fn(async () => true) }));

import { useSettings } from '../../src/hooks/useSettings';

/**
 * Settings' one save path (useSettings), since #466 handed the window masks and `secretsSet` instead of keys: a save
 * never sends a secret back, masked or typed, and the page's own copy never takes one in.
 *
 * Written before the change to useSettings. The ways it can fail:
 * 1. A save carries the mask a page was shown back to main (the bot token sent with an unrelated switch).
 * 2. A save carries a key a page let the user type: it goes through app:saveSettings, not secrets.set.
 * 3. A save made only of secrets still calls main, with nothing to save, and says saved.
 * 4. The page's copy takes in a key typed or saved through it, so the next render shows it, or the next save sends it.
 * 5. Once secrets.set has answered, the page's copy does not say so: the row goes on reading set after a clear.
 *
 * Slack's bot carries the checks since 2.0.5, as it does in e2e/settings-secrets-window.spec.ts: Tars's own Telegram
 * bot went with #545, and its tokens with it (#547 took them out of the window's secrets). The sixth way, the bot's
 * token read as set once Telegram through Hermes had main erase it, went with the bot.
 */

const MASK = '•'.repeat(8);
const g = globalThis as unknown as { window?: unknown };
let page: Mount<ReturnType<typeof useSettings>> | null = null;
afterEach(() => { page?.unmount(); page = null; delete g.window; });

async function settings() {
  const save = vi.fn(async (_delta: unknown) => ({ success: true }));
  g.window = {
    electronAPI: {
      settings: { get: vi.fn(async () => ({})), getInfo: vi.fn(async () => ({})), save: vi.fn(async () => ({ success: true })) },
      claude: { getData: vi.fn(async () => ({ skills: [] })) },
      appSettings: {
        get: vi.fn(async () => ({
          slackEnabled: true, slackBotToken: MASK, slackAppToken: MASK, openRouterApiKey: '',
          secretsSet: { slackBotToken: true, slackAppToken: true, openRouterApiKey: false },
        })),
        save,
        onUpdated: vi.fn(() => () => {}),
      },
    },
  };
  page = mount(() => useSettings());
  await settle();
  return { p: page, save };
}

describe('a save never sends a secret back (1, 2, 3)', () => {
  it('sends a switch without the mask that came with it', async () => {
    const { p, save } = await settings();
    await p.result.handleSaveAppSettings({ slackBotToken: MASK, slackEnabled: false });
    expect(save.mock.calls).toEqual([[{ slackEnabled: false }]]);
  });
  it('sends nothing for a key typed into a page, nor for a mask typed into', async () => {
    const { p, save } = await settings();
    await p.result.handleSaveAppSettings({ openRouterApiKey: 'sk-or-typed' });
    await p.result.handleSaveAppSettings({ slackBotToken: `${MASK}x`, secretsSet: { slackBotToken: false } });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("the page's copy never takes a secret in (4)", () => {
  it('keeps what main said through a save and a local change that carry keys', async () => {
    const { p } = await settings();
    await p.result.handleSaveAppSettings({ openRouterApiKey: 'sk-or-typed', slackEnabled: false });
    p.result.updateLocalAppSettings({ slackBotToken: 'typed', slackChannelId: '42' });
    p.rerender();
    expect(p.result.appSettings.openRouterApiKey).toBe('');
    expect(p.result.appSettings.slackBotToken).toBe(MASK);
    expect([p.result.appSettings.slackEnabled, p.result.appSettings.slackChannelId]).toEqual([false, '42']);
  });
});

describe("the page's copy says what secrets.set answered (5)", () => {
  it('reads a cleared token as not set, and a key set as set', async () => {
    const { p } = await settings();
    p.result.setSecretState('slackBotToken', false);
    p.result.setSecretState('openRouterApiKey', true);
    p.rerender();
    expect(p.result.appSettings.secretsSet).toEqual({ slackBotToken: false, slackAppToken: true, openRouterApiKey: true });
  });
});
