'use client';

import { useState } from 'react';
import { Button, Input } from '@/components/ui';
import { secretIsSet } from '@/lib/secret-settings';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { SecretRow } from './SecretRow';
import type { AppSettings } from './types';

const ACTION = 'font-mono lowercase';

/**
 * A Slack member ID as the bot compares it: U, or W on Enterprise Grid, then
 * capitals and digits. `isAllowedSlackUser` (electron/services/slack-bot.ts)
 * matches it exactly, so a pasted lowercase ID is uppercased before it is
 * kept, and anything else is refused here rather than saved to match nobody.
 */
const MEMBER_ID = /^[UW][A-Z0-9]{2,}$/;

interface SlackSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** What secrets.set answered (useSettings' setSecretState). */
  onSecretChanged: (field: string, set: boolean) => void;
}

export const SlackSection = ({ appSettings, onSaveAppSettings, onSecretChanged }: SlackSectionProps) => {
  const [testingSlack, setTestingSlack] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newMember, setNewMember] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);

  // Who the bot answers (#137). Nobody while the list is empty, and the bot
  // tells anyone it refuses their own ID, which is how an ID reaches this list.
  const allowed = appSettings.slackAllowedUserIds ?? [];

  const addMember = () => {
    const id = newMember.trim().toUpperCase();
    if (!MEMBER_ID.test(id)) {
      setMemberError(`${newMember.trim()} is not a member ID: they start with U or W, then capitals and digits.`);
      return;
    }
    if (allowed.includes(id)) {
      setMemberError(`${id} is on the list already.`);
      return;
    }
    onSaveAppSettings({ slackAllowedUserIds: [...allowed, id] });
    setNewMember('');
    setMemberError(null);
  };

  const handleTestTokens = async () => {
    if (!window.electronAPI?.slack?.test) return;
    setTestingSlack(true);
    setSlackTestResult(null);
    try {
      const result = await window.electronAPI.slack.test();
      if (result.success) {
        setSlackTestResult({ success: true, message: `Bot @${result.botName} is valid!` });
      } else {
        setSlackTestResult({ success: false, message: result.error || 'Invalid tokens' });
      }
    } catch {
      setSlackTestResult({ success: false, message: 'Failed to test connection' });
    } finally {
      setTestingSlack(false);
    }
  };

  const handleSendTest = async () => {
    if (!window.electronAPI?.slack?.sendTest) return;
    setTestingSlack(true);
    setSlackTestResult(null);
    try {
      const result = await window.electronAPI.slack.sendTest();
      if (result.success) {
        setSlackTestResult({ success: true, message: 'Test message sent!' });
      } else {
        setSlackTestResult({ success: false, message: result.error || 'Failed to send' });
      }
    } catch {
      setSlackTestResult({ success: false, message: 'Failed to send test message' });
    } finally {
      setTestingSlack(false);
    }
  };

  // The nine-step "Setup Guide" card is gone: what a token is and where it comes
  // from is one line each, on the row that asks for it.
  return (
    <SettingsCard>
      <SettingsRow
        label="Enable"
        description="Receive notifications and drive agents from Slack."
        control={
          <Toggle
            enabled={appSettings.slackEnabled}
            onChange={() => onSaveAppSettings({ slackEnabled: !appSettings.slackEnabled })}
          />
        }
      />

      <SecretRow
        field="slackBotToken"
        label="Bot token"
        noun="token"
        set={secretIsSet(appSettings, 'slackBotToken')}
        description="xoxb-… from OAuth & Permissions, once the app is installed to the workspace."
        placeholder="xoxb-..."
        clearWarning="Clear the bot token? The Slack bot stops now, and starts again once both tokens are set."
        onChanged={onSecretChanged}
      />

      <SecretRow
        field="slackAppToken"
        label="App token"
        noun="token"
        set={secretIsSet(appSettings, 'slackAppToken')}
        description="xapp-… Socket Mode token, scoped connections:write."
        placeholder="xapp-..."
        clearWarning="Clear the app token? The Slack bot stops now, and starts again once both tokens are set."
        onChanged={onSecretChanged}
      />

      <SettingsRow
        label="Channel"
        description="Auto-detected when you mention the bot or DM it."
        control={
          <Input
            mono
            readOnly
            width="control"
            value={appSettings.slackChannelId || ''}
            placeholder="not connected yet"
          />
        }
      />

      <SettingsRow
        label="Allowed members"
        description={
          memberError ? (
            <span className="text-status-error">{memberError}</span>
          ) : (
            'Slack member IDs, U… or W…. An empty list answers nobody; a refused sender is told their ID.'
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              compact
              mono
              aria-label="Slack member ID"
              value={newMember}
              onChange={(e) => { setNewMember(e.target.value); setMemberError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
              placeholder="U0123ABCDE"
            />
            <Button size="sm" className={ACTION} onClick={addMember} disabled={!newMember.trim()}>
              add
            </Button>
          </div>
        }
      />

      {/* One row per ID, as Discord lists its own: removing is the way back out. */}
      {allowed.map(id => (
        <SettingsRow
          key={id}
          label={<span className="font-mono">{id}</span>}
          description="Answered"
          control={
            <Button
              size="sm"
              className={ACTION}
              onClick={() => onSaveAppSettings({ slackAllowedUserIds: allowed.filter(member => member !== id) })}
            >
              remove
            </Button>
          }
        />
      ))}

      <SettingsRow
        label="Test"
        description={
          slackTestResult ? (
            <span className={slackTestResult.success ? 'text-status-running' : 'text-status-error'}>
              {slackTestResult.message}
            </span>
          ) : (
            'Checks the tokens, then posts a message to the detected channel.'
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="font-mono"
              onClick={handleTestTokens}
              disabled={!secretIsSet(appSettings, 'slackBotToken') || !secretIsSet(appSettings, 'slackAppToken') || testingSlack}
            >
              test tokens
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="font-mono"
              onClick={handleSendTest}
              disabled={!appSettings.slackChannelId || testingSlack}
            >
              send test
            </Button>
          </div>
        }
      />
    </SettingsCard>
  );
};
