'use client';

import { useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import { SECRET_MASK, secretIsSet } from '@/lib/secret-settings';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { SecretRow } from './SecretRow';
import type { AppSettings } from './types';

const ACTION = 'font-mono lowercase';

/**
 * A Discord user ID as the bot compares it: 17 to 20 digits. Anything else
 * would be saved to match nobody, so it is refused here, in the frame's words.
 */
const USER_ID = /^\d{17,20}$/;

interface DiscordSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
  onUpdateLocalSettings: (updates: Partial<AppSettings>) => void;
  /** What secrets.set answered (useSettings' setSecretState). */
  onSecretChanged: (field: string, set: boolean) => void;
}

/**
 * Settings > Discord: the Slack section's card with Discord's rows. Frames:
 * `Settings · Discord` and `Settings · Discord · states` in
 * design/tars-redesign.pen (#182), against the bot's contract (#193).
 */
export const DiscordSection = ({ appSettings, onSaveAppSettings, onSecretChanged }: DiscordSectionProps) => {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newMember, setNewMember] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Whether the token is set is all the page knows of it (2.0.4, #466): it is
  // set and cleared through secrets.set, which restarts the bot (#193).
  const tokenSet = secretIsSet(appSettings, 'discordBotToken');
  const channel = appSettings.discordChannelId ?? '';
  const allowed = appSettings.discordAllowedUserIds ?? [];
  const requireMention = appSettings.discordRequireMention ?? true;

  // The invite link is main's, made from the token it keeps (#200): the page
  // sends the mask, which main takes for that token, and the permissions the
  // link asks for are decided there. An answer for a token since set or
  // cleared is dropped, and there is no link until main answers. A call that
  // fails is no answer: nothing is known about the token then.
  const [inviteAnswer, setInviteAnswer] = useState<{ tokenSet: boolean; url: string | null } | null>(null);
  useEffect(() => {
    const inviteUrl = window.electronAPI?.discord?.inviteUrl;
    if (!inviteUrl) return;
    let current = true;
    inviteUrl(tokenSet ? SECRET_MASK : '')
      .then(url => { if (current) setInviteAnswer({ tokenSet, url }); })
      .catch(() => {});
    return () => { current = false; };
  }, [tokenSet]);
  const answered = inviteAnswer?.tokenSet === tokenSet ? inviteAnswer : null;
  const invite = answered?.url ?? null;
  // Main looked at the token it keeps and found no bot in it.
  const noBotId = !!answered && answered.url === null && tokenSet;

  const addMember = () => {
    const id = newMember.trim();
    if (!USER_ID.test(id)) {
      setMemberError(`${id} is not a Discord user ID: those are 17 to 20 digits.`);
      return;
    }
    if (allowed.includes(id)) {
      setMemberError(`${id} is on the list already.`);
      return;
    }
    onSaveAppSettings({ discordAllowedUserIds: [...allowed, id] });
    setNewMember('');
    setMemberError(null);
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy the invite link:', err);
    }
  };

  // Each test asks the main process, which answers in its own words: Discord's
  // refusal of a token, or where a channel is still missing.
  const testToken = async () => {
    if (!window.electronAPI?.discord?.test) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await window.electronAPI.discord.test();
      setResult(r.success
        ? { success: true, message: r.botName ? `Signed in as ${r.botName}.` : 'Signed in.' }
        : { success: false, message: r.error || 'Discord did not accept the token.' });
    } catch {
      setResult({ success: false, message: 'The test could not reach the app.' });
    } finally {
      setTesting(false);
    }
  };

  const sendTest = async () => {
    if (!window.electronAPI?.discord?.sendTest) return;
    setTesting(true);
    setResult(null);
    try {
      const r = await window.electronAPI.discord.sendTest();
      setResult(r.success
        ? { success: true, message: 'Sent a test message to the channel.' }
        : { success: false, message: r.error || 'The test message was not sent.' });
    } catch {
      setResult({ success: false, message: 'The test could not reach the app.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsCard>
      <SettingsRow
        label="Enable Discord"
        description="Receive notifications and drive agents from Discord."
        control={
          <Toggle
            enabled={!!appSettings.discordEnabled}
            onChange={() => onSaveAppSettings({ discordEnabled: !appSettings.discordEnabled })}
          />
        }
      />

      <SecretRow
        field="discordBotToken"
        label="Bot token"
        noun="token"
        set={tokenSet}
        // The intent is the part a cut line would lose: without it the bot
        // reads every message as empty. The frame gives it two lines.
        wrap
        description="From the Developer Portal: your application, Bot, Reset Token. Turn on the Message Content intent on the same page, or the bot reads every message as empty."
        placeholder="Paste a token"
        clearWarning="Clear the bot token? The Discord bot stops now, and starts again once a token is set."
        onChanged={onSecretChanged}
      />

      <SettingsRow
        label="Invite"
        description={invite
          ? 'Adds the bot to a server of yours, allowed to see channels and send messages, in channels, threads and direct messages.'
          : noBotId
            ? 'This token holds no bot id.'
            : 'Set the bot token first: the link is made from it.'}
        control={
          <Button size="sm" className={ACTION} onClick={copyInvite} disabled={!invite}>
            {copied ? 'copied' : 'copy invite link'}
          </Button>
        }
      />

      <SettingsRow
        label="Channel"
        description="Auto-detected when you mention the bot or DM it."
        control={
          <Input
            mono
            readOnly
            width="control"
            value={channel}
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
            'Discord user IDs, 17 to 20 digits. An empty list answers nobody; a refused sender is told their ID.'
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Input
              compact
              mono
              aria-label="Discord user ID"
              value={newMember}
              onChange={(e) => { setNewMember(e.target.value); setMemberError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') addMember(); }}
              placeholder="123456789012345678"
            />
            <Button size="sm" className={ACTION} onClick={addMember} disabled={!newMember.trim()}>
              add
            </Button>
          </div>
        }
      />

      {/* One row per ID, as Slack lists its own: removing is the way back out. */}
      {allowed.map(id => (
        <SettingsRow
          key={id}
          label={<span className="font-mono">{id}</span>}
          description="Answered"
          control={
            <Button
              size="sm"
              className={ACTION}
              onClick={() => onSaveAppSettings({ discordAllowedUserIds: allowed.filter(member => member !== id) })}
            >
              remove
            </Button>
          }
        />
      ))}

      <SettingsRow
        label="Require @mention"
        description="In server channels the bot only answers when mentioned. Direct messages always work."
        control={
          <Toggle
            enabled={requireMention}
            onChange={() => onSaveAppSettings({ discordRequireMention: !requireMention })}
          />
        }
      />

      <SettingsRow
        label="Test"
        description={
          result ? (
            <span className={result.success ? 'text-status-running' : 'text-status-error'}>{result.message}</span>
          ) : (
            'Checks the token, then posts a message to the detected channel.'
          )
        }
        control={
          <div className="flex items-center gap-2">
            <Button size="sm" className={ACTION} onClick={testToken} disabled={!tokenSet || testing}>
              test token
            </Button>
            <Button size="sm" className={ACTION} onClick={sendTest} disabled={!channel || !tokenSet || testing}>
              send test
            </Button>
          </div>
        }
      />
    </SettingsCard>
  );
};
