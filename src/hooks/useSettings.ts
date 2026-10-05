'use client';

import { useState, useEffect, useCallback } from 'react';
import { isElectron } from '@/hooks/useElectron';
import type { ClaudeSettings, ClaudeInfo, Skill, AppSettings } from '@/components/Settings/types';
import { DEFAULT_APP_SETTINGS } from '@/components/Settings/constants';
import { readClaudeData } from '@/hooks/useClaude';
import { followErrorReports } from '@/lib/error-reports';

/** The settings a bot fills in itself, which the page shows as they change. */
const BOT_WRITTEN = ['slackChannelId', 'discordChannelId'] as const;

export const useSettings = () => {
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [info, setInfo] = useState<ClaudeInfo | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * Which keys the user actually touched since this page loaded.
   *
   * Every section changes settings through `updateSettings`, so this is the one
   * place that can know the difference between a value someone chose and a
   * value that merely came along in the snapshot.
   */
  const [changedKeys, setChangedKeys] = useState<Set<keyof ClaudeSettings>>(new Set());
  const hasChanges = changedKeys.size > 0;

  const fetchSettings = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.settings) {
      setError('Settings are only available in the desktop app');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const [settingsData, infoData, appSettingsData] = await Promise.all([
        window.electronAPI.settings.get(),
        window.electronAPI.settings.getInfo(),
        window.electronAPI.appSettings?.get(),
      ]);

      if (settingsData) {
        setSettings(settingsData);
        // A fresh read replaces the snapshot, so nothing is pending against it.
        setChangedKeys(new Set());
      }
      if (infoData) {
        setInfo(infoData);
      }
      if (appSettingsData) {
        setAppSettings(prev => ({
          ...prev,
          ...appSettingsData,
          cliPaths: { ...prev.cliPaths, ...appSettingsData.cliPaths },
        }));
      }
      setError(null);
      // Claude's data is only read here for the skills list, so the page does
      // not wait for it, and asks for it only once its own settings are in:
      // past main's one-minute memo it is a whole transcript scan, and asked
      // first, it ran ahead of them.
      void readClaudeData().then(claude => { if (claude?.skills) setSkills(claude.skills); });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // What a bot writes on its own: the channel it was first addressed from
  // (Slack, Discord). It pushes the whole settings object, but only these keys
  // are taken from it: the rest would replace a token being typed, or undo a
  // switch whose save is still on its way.
  useEffect(() => {
    const off = window.electronAPI?.appSettings?.onUpdated?.(pushed => {
      const from = pushed as Partial<AppSettings> | null;
      if (!from) return;
      const taken: Partial<AppSettings> = {};
      for (const key of BOT_WRITTEN) if (typeof from[key] === 'string') taken[key] = from[key];
      if (Object.keys(taken).length) setAppSettings(prev => ({ ...prev, ...taken }));
    });
    return () => { off?.(); };
  }, []);

  const handleSave = async () => {
    if (!settings || !window.electronAPI?.settings) return;

    // Send only the keys someone changed, the way the app settings beside this
    // already do. The main process merges what arrives onto the file, so a key
    // present in the payload wins even when nobody touched it, and the snapshot
    // this page loaded is stale the moment anything else writes that file.
    //
    // The sequence that made this real: open Settings before Tars has written
    // its hooks, so the snapshot carries the `hooks: {}` that a missing file
    // reads as; Tars writes the hooks; press Save; `{}` goes back over them.
    // The main process now guards hooks and a few others, but it cannot guard
    // `includeCoAuthoredBy`: it is a boolean, and a stale `false` is
    // indistinguishable from a chosen `false`. Only not sending it works.
    const delta = Object.fromEntries(
      [...changedKeys].map(key => [key, settings[key]]),
    ) as Partial<ClaudeSettings>;

    try {
      setSaving(true);
      const result = await window.electronAPI.settings.save(delta);

      if (result.success) {
        setSaved(true);
        setChangedKeys(new Set());
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError(result.error || 'Failed to save settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAppSettings = async (newSettings: Partial<AppSettings>) => {
    const updated = { ...appSettings, ...newSettings };
    setAppSettings(updated);

    if (!window.electronAPI?.appSettings) return;

    try {
      // Send only the delta, not the full local snapshot: the main process
      // merges this onto its own current settings, so shipping our whole
      // (possibly stale) copy would silently overwrite any field changed
      // through another path since this page last fetched - e.g. Slack's
      // auto-detected channel id, or a Telegram auth token generated while
      // this page was open. It also made every save look like a Telegram/
      // Slack credential change to the main process, since those fields are
      // always present on the full object, re-initializing both bots on
      // every unrelated toggle.
      const result = await window.electronAPI.appSettings.save(newSettings);
      if (!result.success) {
        setError(result.error || 'Failed to save notification settings');
      } else {
        if (newSettings.errorReportsEnabled !== undefined) {
          // The window's half of error reports follows the switch at once.
          void followErrorReports(newSettings.errorReportsEnabled);
        }
        // The relay on, main has erased the bot's token and turned the bot
        // off as it saved (settingsForRelay): this page sends only what
        // changed, so it says the same of its own copy, or Settings, Telegram
        // would go on showing a bot that no longer runs.
        if (newSettings.hermesRelayEnabled === true) {
          setAppSettings(prev => ({ ...prev, telegramEnabled: false, telegramBotToken: '' }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save notification settings');
    }
  };

  const updateSettings = (updates: Partial<ClaudeSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...updates });
    setChangedKeys(prev => {
      const next = new Set(prev);
      for (const key of Object.keys(updates) as (keyof ClaudeSettings)[]) next.add(key);
      return next;
    });
  };

  const updateLocalAppSettings = (updates: Partial<AppSettings>) => {
    setAppSettings(prev => ({ ...prev, ...updates }));
  };

  return {
    // State
    settings,
    appSettings,
    info,
    skills,
    loading,
    saving,
    error,
    saved,
    hasChanges,
    // Actions
    fetchSettings,
    handleSave,
    handleSaveAppSettings,
    updateSettings,
    updateLocalAppSettings,
  };
};
