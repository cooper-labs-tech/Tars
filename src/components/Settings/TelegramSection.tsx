'use client';

import { Button } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { AppSettings } from './types';

interface TelegramSectionProps {
  appSettings: AppSettings;
  /** Opens Settings, Hermes, where Telegram is set now. */
  onOpenHermes: () => void;
}

/**
 * Settings, Telegram since 2.0.5 (frames `Settings · Telegram · Telegram through Hermes` and its light copy): Tars has
 * no Telegram bot of its own any more, the owner's decision of 01/10. Telegram goes through Hermes, whose relay,
 * gateways and senders are set in Settings, Hermes, the one action here. Nothing to type, test or switch. When the
 * first 2.0.5 launch found the old bot's token (telegramBotRetired.hadToken), one line says to revoke it with
 * BotFather: Tars erased its copy, Telegram still knows it.
 */
export const TelegramSection = ({ appSettings, onOpenHermes }: TelegramSectionProps) => (
  <>
    <SettingsRow
      label="Telegram goes through Hermes"
      description="Tars has no Telegram bot of its own since 2.0.5. Hermes is the only voice on your Telegram: its relay, its gateways and who may write to Tars from it are set in Settings, Hermes."
      wrap
      control={<Button size="sm" className="font-mono lowercase" onClick={onOpenHermes}>open hermes</Button>}
    />
    {appSettings.telegramBotRetired?.hadToken && (
      <SettingsRow
        label="The old bot"
        description="Its token was erased from Tars. Revoke it with BotFather too: send /revoke to @BotFather and choose the bot."
        wrap
      />
    )}
  </>
);
