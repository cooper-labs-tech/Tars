import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, ofType, textOf, type Mount } from './hook-runtime';
import { TelegramSection } from '../../src/components/Settings/TelegramSection';
import { Toggle } from '../../src/components/Settings/Toggle';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';
import type { AppSettings } from '../../src/components/Settings/types';
import { Button, Input, PasswordInput, StatusBadge } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings, Telegram while Telegram through Hermes is on (#285's
 * `hermesRelayEnabled`). Main erases the bot's token and keeps the bot off
 * whatever the page sends (settingsForRelay), and the page went on taking a
 * token and turning the bot on, showing what main had just refused (the
 * Audit's finding on #291, measured in the app). Frame: `Settings · Telegram ·
 * Telegram through Hermes`, and its light copy. Written before the code. How
 * it can fail:
 * 1. with the relay on, the section still offers the bot's switch, its token
 *    field or any other field or switch: whatever is typed or switched there,
 *    main erases as it saves, and the page shows it anyway;
 * 2. it does not say the bot is off, or not that Telegram through Hermes
 *    replaced it: the user is left with a card that says nothing;
 * 3. it gives no way back: the second row must say how to bring the bot back,
 *    and its one button must open Settings, Hermes, where the switch is;
 * 4. with the relay off, or a settings file older than the relay, the section
 *    is not the bot's own as before: its switch and its token field.
 */

type Section = ReturnType<typeof TelegramSection>;
let section: Mount<Section> | null = null;
const onSave = vi.fn();
const onLocal = vi.fn();
const onOpenHermes = vi.fn();

afterEach(() => {
  section?.unmount();
  section = null;
  onSave.mockReset();
  onLocal.mockReset();
  onOpenHermes.mockReset();
});

/** A bot that could run: its token, its auth token and its switch on, as before the relay. */
function open(relay: boolean | undefined) {
  const appSettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    telegramEnabled: true,
    telegramBotToken: '123456:ABCDEF',
    telegramAuthToken: 'auth-token',
    telegramAuthorizedChatIds: ['42'],
    hermesRelayEnabled: relay,
  };
  section = mount(() => TelegramSection({ appSettings, onSaveAppSettings: onSave, onUpdateLocalSettings: onLocal, onOpenHermes }));
  return section;
}

const rows = (s: Mount<Section>) => ofType(s.result, SettingsRow).map(r => r.props as { label: unknown; description: unknown; control?: unknown });
const buttons = (s: Mount<Section>) => ofType(s.result, Button).map(b => ({ text: textOf(b.props.children as never), click: b.props.onClick as () => void }));
const fields = (s: Mount<Section>) => [...ofType(s.result, Input), ...ofType(s.result, PasswordInput)];

describe('Settings, Telegram with Telegram through Hermes on', () => {
  it('offers nothing to type and nothing to switch (1)', () => {
    const s = open(true);
    expect(fields(s)).toHaveLength(0);
    expect(ofType(s.result, Toggle)).toHaveLength(0);
    expect(buttons(s).map(b => b.text)).toEqual(['open hermes']);
  });

  it('says the bot is off, replaced by Telegram through Hermes (2)', () => {
    const s = open(true);
    const [bot] = rows(s);
    expect(bot.label).toBe('Telegram bot');
    expect(textOf(bot.description as never)).toBe(
      "Replaced by Telegram through Hermes: Hermes is the only voice on your Telegram, and the bot's token was erased.",
    );
    expect(ofType(bot.control, StatusBadge).map(b => textOf(b.props.children as never)).join('').trim()).toBe('off');
  });

  it('says how to bring the bot back, and opens Settings, Hermes (3)', () => {
    const s = open(true);
    const way = rows(s)[1];
    expect(rows(s)).toHaveLength(2);
    expect(way.label).toBe('Telegram through Hermes');
    expect(textOf(way.description as never)).toBe(
      'To bring the bot back, turn it off in Settings, Hermes, Connection, then paste a new bot token here.',
    );
    buttons(s)[0].click();
    expect(onOpenHermes).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([false, undefined])('is the bot\'s own section with the relay %s (4)', (relay) => {
    const s = open(relay);
    expect(rows(s)[0].label).toBe('Enable Telegram bot');
    expect(ofType(s.result, Toggle).length).toBeGreaterThan(0);
    expect(ofType(s.result, PasswordInput).some(p => p.props.value === '123456:ABCDEF')).toBe(true);
    expect(buttons(s).map(b => b.text)).not.toContain('open hermes');
  });
});
