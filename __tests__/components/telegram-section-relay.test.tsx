import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, ofType, textOf, type Mount } from './hook-runtime';
import { TelegramSection } from '../../src/components/Settings/TelegramSection';
import { Toggle } from '../../src/components/Settings/Toggle';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import { SecretRow } from '../../src/components/Settings/SecretRow';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';
import type { AppSettings } from '../../src/components/Settings/types';
import { Button, Input, PasswordInput } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings, Telegram while Telegram goes through Hermes (#285's
 * `hermesRelayEnabled`). Main erased the bot's token and kept the bot off
 * whatever the page sent (settingsForRelay), and the page went on taking a
 * token and turning the bot on, showing what main had just refused (the
 * Audit's finding on #291, measured in the app). Written before the code.
 * Since 2.0.5 Tars has no Telegram bot of its own (#545), and the section is
 * the one the relay gave, whatever the settings say of the relay (#547, its
 * proof e2e/telegram-through-hermes-window.spec.ts). Frame: `Settings ·
 * Telegram · Telegram through Hermes` (clAod), and its light copy. How it can
 * fail:
 * 1. the section still offers the bot's switch, its token field or any other
 *    field or switch: there is no bot left for them to reach;
 * 2. it does not say that Telegram goes through Hermes, in the frame's words:
 *    the user is left with a card that says nothing;
 * 3. its one button does not open Settings, Hermes, where Telegram is set
 *    now (the section is handed nothing to save with since 2.0.5);
 * 4. with the relay off, or a settings file older than the relay, the bot's
 *    own section comes back: its switch and its token's row.
 */

type Section = ReturnType<typeof TelegramSection>;
let section: Mount<Section> | null = null;
const onOpenHermes = vi.fn();

afterEach(() => {
  section?.unmount();
  section = null;
  onOpenHermes.mockReset();
});

/** A settings file as a 2.0.4 bot left it, with the relay on, off or older than it. */
function open(relay: boolean | undefined) {
  const appSettings = {
    ...DEFAULT_APP_SETTINGS,
    telegramEnabled: true,
    telegramBotToken: '•'.repeat(8),
    telegramAuthToken: '•'.repeat(8),
    secretsSet: { telegramBotToken: true, telegramAuthToken: true },
    telegramAuthorizedChatIds: ['42'],
    hermesRelayEnabled: relay,
  } as unknown as AppSettings;
  section = mount(() => TelegramSection({ appSettings, onOpenHermes }));
  return section;
}

const rows = (s: Mount<Section>) => ofType(s.result, SettingsRow).map(r => r.props as { label: unknown; description: unknown; control?: unknown });
const buttons = (s: Mount<Section>) => ofType(s.result, Button).map(b => ({ text: textOf(b.props.children as never), click: b.props.onClick as () => void }));
const fields = (s: Mount<Section>) => [...ofType(s.result, Input), ...ofType(s.result, PasswordInput)];

describe('Settings, Telegram, which goes through Hermes', () => {
  it('offers nothing to type and nothing to switch (1)', () => {
    const s = open(true);
    expect(fields(s)).toHaveLength(0);
    expect(ofType(s.result, SecretRow)).toHaveLength(0);
    expect(ofType(s.result, Toggle)).toHaveLength(0);
    expect(buttons(s).map(b => b.text)).toEqual(['open hermes']);
  });

  it('says Telegram goes through Hermes, in the frame\'s words (2)', () => {
    const s = open(true);
    const [way] = rows(s);
    expect(rows(s)).toHaveLength(1);
    expect(way.label).toBe('Telegram goes through Hermes');
    expect(textOf(way.description as never)).toBe(
      'Tars has no Telegram bot of its own since 2.0.5. Hermes is the only voice on your Telegram: its relay, its gateways and who may write to Tars from it are set in Settings, Hermes.',
    );
  });

  it('opens Settings, Hermes, with its one button (3)', () => {
    const s = open(true);
    buttons(s)[0].click();
    expect(onOpenHermes).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])('is the same section with the relay %s: the bot does not come back (4)', (relay) => {
    const s = open(relay);
    expect(rows(s).map(r => r.label)).toEqual(['Telegram goes through Hermes']);
    expect(ofType(s.result, Toggle)).toHaveLength(0);
    expect(ofType(s.result, SecretRow)).toHaveLength(0);
    expect(buttons(s).map(b => b.text)).toEqual(['open hermes']);
  });
});
