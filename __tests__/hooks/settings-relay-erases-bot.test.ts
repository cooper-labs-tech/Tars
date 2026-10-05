import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, type Mount } from '../components/hook-runtime';
import { useSettings } from '../../src/hooks/useSettings';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../components/hook-runtime')).hooks,
}));

/**
 * The Settings page after the Telegram through Hermes switch is turned on.
 * Main erases the Tars bot's token and turns the bot off as it saves the
 * switch (#285, settingsForRelay), and the page sends only what changed and
 * keeps its own copy of the rest. Written before the code. How it can fail:
 * 1. the page goes on showing the bot's token and the bot on, which no longer
 *    exist: Settings, Telegram reads as if the bot still ran;
 * 2. a save that failed is mirrored anyway: the token vanishes from the page
 *    while main still has it;
 * 3. turning the relay off, or any other save, touches the bot's settings,
 *    or more than the switch is sent.
 */

type Save = ReturnType<typeof vi.fn>;
const g = globalThis as unknown as { window?: { electronAPI: Record<string, unknown> } };
let hook: Mount<ReturnType<typeof useSettings>> | null = null;
let save: Save;

async function open(result: { success: boolean; error?: string } = { success: true }) {
  save = vi.fn(async () => result);
  g.window = {
    electronAPI: {
      settings: { get: vi.fn(async () => ({})), getInfo: vi.fn(async () => ({})) },
      claude: { getData: vi.fn(async () => null) },
      appSettings: {
        get: vi.fn(async () => ({ telegramEnabled: true, telegramBotToken: '123:ABC', hermesRelayEnabled: false })),
        save,
      },
    },
  };
  hook = mount(() => useSettings());
  await settle();
  expect(hook.result.appSettings.telegramBotToken).toBe('123:ABC');
  return hook;
}

beforeEach(() => { hook = null; });
afterEach(() => {
  hook?.unmount();
  delete g.window;
});

describe('Settings after the relay is turned on', () => {
  it('stops showing the bot\'s token and the bot on, as main erased them (1)', async () => {
    const h = await open();
    await h.result.handleSaveAppSettings({ hermesRelayEnabled: true });
    await settle();
    expect(save.mock.calls).toEqual([[{ hermesRelayEnabled: true }]]);
    expect(h.result.appSettings.hermesRelayEnabled).toBe(true);
    expect(h.result.appSettings.telegramBotToken).toBe('');
    expect(h.result.appSettings.telegramEnabled).toBe(false);
  });

  it('keeps the bot as it was when the save failed (2)', async () => {
    const h = await open({ success: false, error: 'disk full' });
    await h.result.handleSaveAppSettings({ hermesRelayEnabled: true });
    await settle();
    expect(h.result.appSettings.telegramBotToken).toBe('123:ABC');
    expect(h.result.appSettings.telegramEnabled).toBe(true);
  });

  it('leaves the bot alone when the relay goes off, or anything else is saved (3)', async () => {
    const h = await open();
    await h.result.handleSaveAppSettings({ hermesRelayEnabled: false });
    await h.result.handleSaveAppSettings({ notificationsEnabled: false });
    await settle();
    expect(save.mock.calls).toEqual([[{ hermesRelayEnabled: false }], [{ notificationsEnabled: false }]]);
    expect(h.result.appSettings.telegramBotToken).toBe('123:ABC');
    expect(h.result.appSettings.telegramEnabled).toBe(true);
  });
});
