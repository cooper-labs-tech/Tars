'use client';

import { useState } from 'react';
import { Button, Input, PasswordInput, StatusBadge, StatusSquare } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { AppSettings } from './types';

interface TelegramSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** Opens Settings, Hermes, where Telegram through Hermes is switched off. */
  onOpenHermes?: () => void;
}

/** Row actions are words, never glyphs: 26px bordered lowercase mono. */
const ACTION = 'font-mono lowercase';

export const TelegramSection = ({ appSettings, onSaveAppSettings, onUpdateLocalSettings, onOpenHermes }: TelegramSectionProps) => {
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [tokenGenerated, setTokenGenerated] = useState(false);

  const handleTestToken = async () => {
    if (!window.electronAPI?.telegram?.test) return;
    setTestingTelegram(true);
    setTelegramTestResult(null);
    try {
      const result = await window.electronAPI.telegram.test();
      if (result.success) {
        setTelegramTestResult({ success: true, message: `Bot @${result.botName} is valid!` });
      } else {
        setTelegramTestResult({ success: false, message: result.error || 'Invalid token' });
      }
    } catch {
      setTelegramTestResult({ success: false, message: 'Failed to test connection' });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleSendTest = async () => {
    if (!window.electronAPI?.telegram?.sendTest) return;
    setTestingTelegram(true);
    setTelegramTestResult(null);
    try {
      const result = await window.electronAPI.telegram.sendTest();
      if (result.success) {
        setTelegramTestResult({ success: true, message: 'Test message sent!' });
      } else {
        setTelegramTestResult({ success: false, message: result.error || 'Failed to send' });
      }
    } catch {
      setTelegramTestResult({ success: false, message: 'Failed to send test message' });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleGenerateAuthToken = async () => {
    if (!window.electronAPI?.telegram?.generateAuthToken) return;
    setGeneratingToken(true);
    try {
      const result = await window.electronAPI.telegram.generateAuthToken();
      if (result.success) {
        onUpdateLocalSettings({ telegramAuthToken: result.token });
        setTokenGenerated(true);
      }
    } catch (err) {
      console.error('Failed to generate auth token:', err);
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleCopyAuthToken = async () => {
    if (!appSettings.telegramAuthToken) return;
    try {
      await navigator.clipboard.writeText(appSettings.telegramAuthToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } catch (err) {
      console.error('Failed to copy token:', err);
    }
  };

  const handleRemoveChatId = async (chatId: string) => {
    if (!window.electronAPI?.telegram?.removeAuthorizedChatId) return;
    try {
      await window.electronAPI.telegram.removeAuthorizedChatId(chatId);
    } catch (err) {
      console.error('Failed to remove chat ID:', err);
    }
  };

  const authorizedChatIds = appSettings.telegramAuthorizedChatIds || [];

  // The auth token row carries the whole story of the token in one line: what is
  // missing, what to do with it, and whether a restart is owed.
  const authTokenDescription = !appSettings.telegramAuthToken
    ? 'Required before the bot can run. Generate one to get started.'
    : tokenGenerated
      ? <span className="text-warning">Restart the app to apply the new token.</span>
      : 'Share it with trusted users. They send /auth <token> to your bot.';

  // Telegram through Hermes on (#285): main has erased the bot's token and
  // keeps the bot off whatever this page sends (settingsForRelay), so nothing
  // here can be typed or switched, or the page would show a token or a switch
  // main has just refused. It says the bot is off and what replaced it, and how
  // to bring it back. Frame: `Settings · Telegram · Telegram through Hermes`,
  // and its light copy.
  if (appSettings.hermesRelayEnabled === true) {
    return (
      <>
        <SettingsRow
          label="Telegram bot"
          description="Replaced by Telegram through Hermes: Hermes is the only voice on your Telegram, and the bot's token was erased."
          wrap
          control={
            <StatusBadge tone="idle" className="font-mono">
              <StatusSquare tone="idle" />
              off
            </StatusBadge>
          }
        />
        <SettingsRow
          label="Telegram through Hermes"
          description="To bring the bot back, turn it off in Settings, Hermes, Connection, then paste a new bot token here."
          wrap
          control={<Button size="sm" className={ACTION} onClick={onOpenHermes}>open hermes</Button>}
        />
      </>
    );
  }

  return (
    <>
      <SettingsRow
        label="Enable Telegram bot"
        description={
          !appSettings.telegramAuthToken
            ? 'Generate an auth token first, it is what keeps the bot yours.'
            : 'Receive notifications and send commands from Telegram.'
        }
        control={
          <Toggle
            enabled={appSettings.telegramEnabled}
            onChange={() => onSaveAppSettings({ telegramEnabled: !appSettings.telegramEnabled })}
            disabled={!appSettings.telegramAuthToken || !appSettings.telegramBotToken}
          />
        }
      />

      <SettingsRow
        label="Bot token"
        description={
          <>
            Create the bot with{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              @BotFather
            </a>{' '}
            and paste what it gives you.
          </>
        }
        control={
          <PasswordInput
            width="control"
            value={appSettings.telegramBotToken}
            onChange={e => onUpdateLocalSettings({ telegramBotToken: e.target.value })}
            onBlur={() => {
              if (appSettings.telegramBotToken) {
                onSaveAppSettings({ telegramBotToken: appSettings.telegramBotToken });
              }
            }}
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz…"
          />
        }
      />

      <SettingsRow
        label="Secret auth token"
        description={authTokenDescription}
        control={
          <div className="flex w-full items-center justify-end gap-2">
            <PasswordInput
              className="min-w-0 flex-1"
              value={appSettings.telegramAuthToken || ''}
              readOnly
              placeholder="No token generated"
            />
            <Button
              size="sm"
              className={ACTION}
              onClick={handleCopyAuthToken}
              disabled={!appSettings.telegramAuthToken}
            >
              {copiedToken ? 'copied' : 'copy'}
            </Button>
            <Button
              size="sm"
              className={ACTION}
              onClick={handleGenerateAuthToken}
              disabled={generatingToken}
            >
              {generatingToken ? 'working' : appSettings.telegramAuthToken ? 'regenerate' : 'generate'}
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Chat id"
        description="The chat that receives agent notifications."
        control={
          <Input
            mono
            width="control"
            value={appSettings.telegramChatId || ''}
            onChange={e => onUpdateLocalSettings({ telegramChatId: e.target.value })}
            onBlur={e => onSaveAppSettings({ telegramChatId: e.target.value.trim() })}
            placeholder="Set by whoever authenticates first"
          />
        }
      />

      {/* One row per authorized chat: revoking access is the only way back out. */}
      {authorizedChatIds.length > 0 ? (
        authorizedChatIds.map(chatId => {
          const isDefault = appSettings.telegramChatId === chatId;
          return (
            <SettingsRow
              key={chatId}
              label={<span className="font-mono">{chatId}</span>}
              description={isDefault ? 'Default chat' : 'Authorized'}
              control={
                <div className="flex w-full items-center justify-end gap-2">
                  {!isDefault && (
                    <Button
                      size="sm"
                      className={ACTION}
                      onClick={() => onSaveAppSettings({ telegramChatId: chatId })}
                    >
                      set default
                    </Button>
                  )}
                  <Button size="sm" className={ACTION} onClick={() => handleRemoveChatId(chatId)}>
                    remove
                  </Button>
                </div>
              }
            />
          );
        })
      ) : (
        <SettingsRow
          label="Authorized chats"
          description="None yet. A user authenticates by sending /auth <token> to the bot."
        />
      )}

      <SettingsRow
        label="Require @mention"
        description="In groups the bot only answers when mentioned. Direct messages always work."
        control={
          <Toggle
            enabled={appSettings.telegramRequireMention || false}
            onChange={() => onSaveAppSettings({ telegramRequireMention: !appSettings.telegramRequireMention })}
          />
        }
      />

      <SettingsRow
        label="Test"
        description={
          telegramTestResult ? (
            <span className={telegramTestResult.success ? 'text-success' : 'text-danger'}>
              {telegramTestResult.message}
            </span>
          ) : (
            'Check the token with Telegram, then send yourself a message.'
          )
        }
        control={
          <div className="flex w-full items-center justify-end gap-2">
            <Button
              size="sm"
              className={ACTION}
              onClick={handleTestToken}
              disabled={!appSettings.telegramBotToken || testingTelegram}
            >
              {testingTelegram ? 'working' : 'test token'}
            </Button>
            <Button
              size="sm"
              className={ACTION}
              onClick={handleSendTest}
              disabled={!authorizedChatIds.length || testingTelegram}
            >
              send test
            </Button>
          </div>
        }
      />
    </>
  );
};
