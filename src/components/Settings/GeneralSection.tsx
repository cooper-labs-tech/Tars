import { useState, useEffect } from 'react';
import { Select, SegmentedControl } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { ClaudeInfo, AppSettings } from './types';
import { PRIVACY_POLICY_URL } from './constants';
import { errorReportsOffered } from '@/lib/error-reports';
import { lastReportLine } from '@/lib/error-report-line';

interface GeneralSectionProps {
  info: ClaudeInfo | null;
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

export const GeneralSection = ({ appSettings, onSaveAppSettings }: GeneralSectionProps) => {
  // Not on a Windows build (lib/error-reports.ts): read after hydration, as the bridge is.
  const [reportsOffered, setReportsOffered] = useState(true);
  useEffect(() => setReportsOffered(errorReportsOffered()), []);
  // When the last report left, its kind and Sentry's answer (#474's errorReports:last), read as the page opens.
  const [lastReport, setLastReport] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.electronAPI?.errorReports?.last()
      .then((last) => { if (live) setLastReport(lastReportLine(last)); })
      .catch(() => { /* an older main without the channel: no line */ });
    return () => { live = false; };
  }, []);

  // Whether Tars keeps the computer awake right now (#511's keepAwake:state), read as the page opens, after each
  // change, and every five seconds while it is open, since a turn starting or ending changes it.
  const keepAwakeMode = appSettings.keepAwake ?? 'while-working';
  const [awake, setAwake] = useState<{ active: boolean; working: number; refused?: true } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => window.electronAPI?.keepAwake?.state()
      .then((s) => { if (live) setAwake({ active: s.active, working: s.working, refused: s.refused }); })
      .catch(() => { /* an older main without the channel: no line */ });
    read();
    const every = setInterval(read, 5_000);
    return () => { live = false; clearInterval(every); };
  }, [keepAwakeMode]);

  // The Tars identity card and the whole update checker (check button, release
  // notes, download progress, restart-to-apply) now live in SystemSection - the
  // version and its updates are one story, and it is that page's story. What
  // stays here is the preference itself.
  return (
    <SettingsCard>
      <SettingsRow
        label="Check for updates"
        description="Tars from its fork, never upstream, and the claude and Amp CLIs your agents run: at launch, every 30 min."
        control={
          <Toggle
            enabled={appSettings.autoCheckUpdates !== false}
            onChange={() => onSaveAppSettings({ autoCheckUpdates: !appSettings.autoCheckUpdates })}
          />
        }
      />

      {/* Off unless turned on, including in a settings file older than the
          key: main sends nothing to Sentry while it reads anything but true. */}
      {reportsOffered && <SettingsRow
        wrap
        label="Send error reports"
        description={
          <>
            <span className="block">{"Sends Sentry the errors Tars meets, where they happened in Tars's code, the version, the system and a random install id, and your agents' tool errors, as a code. An error Tars caught goes without its message."}</span>
            {/* True of what the main process sends (PR 221): a path under home as ~/..., one outside it whole. */}
            <span className="block">File paths keep their names, with your home folder shown as ~.</span>
            <span className="block">
              Never your code, prompts, conversations or keys.{' '}
              <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Privacy policy</a>
            </span>
          </>
        }
        control={
          <div className="flex items-center gap-3">
            {lastReport && <span className="text-[11.5px] text-muted-foreground whitespace-nowrap">{lastReport}</span>}
            <Toggle
              label="Send error reports"
              enabled={appSettings.errorReportsEnabled === true}
              onChange={() => onSaveAppSettings({ errorReportsEnabled: appSettings.errorReportsEnabled !== true })}
            />
          </div>
        }
      />}

      <SettingsRow
        label="Start agents when Tars opens"
        description="Resumes the agents you left idle, once, at launch. Navigating back to the dashboard never starts anything."
        control={
          <Toggle
            enabled={appSettings.autoStartAgentsOnLaunch !== false}
            onChange={() => onSaveAppSettings({ autoStartAgentsOnLaunch: appSettings.autoStartAgentsOnLaunch === false })}
          />
        }
      />

      {/* Frame: `Keep awake (2.0.5) · Settings, General, Preferences` and its states. */}
      <SettingsRow
        label="Keep this computer awake"
        wrap
        description={
          <>
            While an agent works, Tars keeps this computer from going to sleep, so a long task is not cut when you step away. The screen may still turn off.
            {awake && (
              <span data-keep-awake-line className={`block mt-0.5 font-mono text-[10.5px] ${awake.refused ? 'text-status-waiting' : awake.active ? 'text-status-running' : 'text-text-muted'}`}>
                {keepAwakeLine(keepAwakeMode, awake)}
              </span>
            )}
          </>
        }
        control={
          <SegmentedControl
            ariaLabel="Keep this computer awake"
            value={keepAwakeMode}
            onChange={(keepAwake) => onSaveAppSettings({ keepAwake })}
            options={[
              { value: 'while-working', label: 'while working' },
              { value: 'always', label: 'always' },
              { value: 'never', label: 'never' },
            ]}
          />
        }
      />

      {/* Settings · Preferences: the last row, off unless chosen. Since 2.0.0 it shows to everyone, the
          preview; before, only once the settings file had turned it on (JeanBrasse, 12/10). */}
      <SettingsRow
        label="New interface"
        description="Turns on the new shell and chats per project, a preview: the sidebar lists your chats, and Agents, Usage, Settings and the other pages open from More as cards above the app."
        wrap
        control={
          <Toggle
            label="New interface"
            enabled={appSettings.newInterface === true}
            onChange={() => onSaveAppSettings({ newInterface: appSettings.newInterface !== true })}
          />
        }
      />
    </SettingsCard>
  );
};

/** What the keep awake row says it does now, under its hint (frame `Keep awake (2.0.5) · states`). */
function keepAwakeLine(mode: 'while-working' | 'always' | 'never', state: { active: boolean; working: number; refused?: true }): string {
  // Wanted, but the system would not hold its sleep off (#511's `refused`): the setting stays as chosen.
  if (state.refused) return 'cannot keep this computer awake here: the system refused';
  if (state.active) {
    if (mode === 'always') return 'awake while Tars is open';
    return `awake now · ${state.working} ${state.working === 1 ? 'agent' : 'agents'} working`;
  }
  return mode === 'never' ? 'sleeps as usual, even during a turn' : 'sleeps as usual · no agent is working';
}
