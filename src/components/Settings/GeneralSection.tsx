import { useState, useEffect } from 'react';
import { Button, Select, Dropdown } from '@/components/ui';
import { Toggle } from './Toggle';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import type { ClaudeInfo, AppSettings } from './types';
import { PRIVACY_POLICY_URL } from './constants';
import { PROVIDER_REGISTRY, computeProviderAvailability } from '@/lib/providers';
import { errorReportsOffered } from '@/lib/error-reports';
import { diagnosticLine } from '@/lib/diagnostic';

interface GeneralSectionProps {
  info: ClaudeInfo | null;
  appSettings: AppSettings;
  onSaveAppSettings: (updates: Partial<AppSettings>) => void;
}

export const GeneralSection = ({ appSettings, onSaveAppSettings }: GeneralSectionProps) => {
  const [installedProviders, setInstalledProviders] = useState<Record<string, boolean>>({ claude: true, codex: true, gemini: true });
  // Not on a Windows build (lib/error-reports.ts): read after hydration, as the bridge is.
  const [reportsOffered, setReportsOffered] = useState(true);
  useEffect(() => setReportsOffered(errorReportsOffered()), []);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.cliPaths?.detect(),
      window.electronAPI?.appSettings?.get(),
      window.electronAPI?.ollama?.test(),
    ]).then(([paths, settings, ollama]) => {
      if (paths || settings) {
        setInstalledProviders(computeProviderAvailability(
          paths as Record<string, string | undefined> | undefined,
          settings,
          ollama?.reachable,
        ));
      }
    });
  }, []);

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
            <span className="block">{"Sends Sentry the error, where it happened in Tars's code, the version, the system and a random install id."}</span>
            {/* The abrupt-end note under the same switch (services/health/abrupt-end.ts): the crash type is macOS's own, read without memory. */}
            <span className="block">When Tars ended abruptly, the next launch says so: how long it ran, the crash type macOS gives, and its last health numbers.</span>
            {/* True of what the main process sends (PR 221): a path under home as ~/..., one outside it whole. */}
            <span className="block">File paths keep their names, with your home folder shown as ~.</span>
            <span className="block">
              Never your code, prompts, conversations or keys.{' '}
              <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Privacy policy</a>
            </span>
          </>
        }
        control={
          <Toggle
            label="Send error reports"
            enabled={appSettings.errorReportsEnabled === true}
            onChange={() => onSaveAppSettings({ errorReportsEnabled: appSettings.errorReportsEnabled !== true })}
          />
        }
      />}

      {/* Under the same switch, and hidden with it on Windows. Frame: `Settings · Preferences · diagnostic`. */}
      {reportsOffered && <DiagnosticRow enabled={appSettings.errorReportsEnabled === true} />}

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

      <SettingsRow
        label="Default provider"
        description="Used for Telegram-spawned agents and webhook dispatches."
        control={
          <Dropdown
            className="w-[300px]"
            ariaLabel="Default provider"
            searchable
            value={appSettings.defaultProvider || 'claude'}
            onChange={(v) => onSaveAppSettings({ defaultProvider: v })}
            options={PROVIDER_REGISTRY
              // Why these two and not the others: the answer is that nobody
              // knows, and the list is kept rather than guessed at. It arrived
              // in eac841a (2026-04-12) as "Remove OpenCode/Pi from provider
              // picker (CLI-only tools)", and that reason does not pick them
              // out: `requiresCli` is true for eight providers here, and amp
              // has the same single "default" model row as opencode without
              // being excluded. Nothing in the main process separates them
              // either, neither `supportsNativeHooks` (false for five) nor the
              // one-shot builders (both implement them).
              //
              // It matters less than it looks, and that is the real finding:
              // `defaultProvider` is written here and read nowhere. Not in
              // electron/, not in mcp-*/, not in hooks/. A programmatic spawn
              // takes `agent.provider` and falls back to a hardcoded 'claude'
              // (ipc-handlers.ts:437 and :554), so this control changes
              // nothing and the row's description above it is not true today.
              // Wiring it or removing it is a decision, not a cleanup.
              .filter(p => p.id !== 'opencode' && p.id !== 'pi')
              .map(({ id, label, requiresCli }) => {
                const notAvailable = installedProviders[id] !== true;
                return {
                  value: id,
                  label,
                  hint: notAvailable
                    ? requiresCli ? 'not installed' : 'add an API key first'
                    : undefined,
                  disabled: notAvailable,
                };
              })}
          />
        }
      />

      {/* Settings · Preferences: the last row, off unless chosen. Since 2.0.0 it shows to everyone, the
          preview; before, only once the settings file had turned it on (Noah, 12/10). */}
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

/**
 * Send a diagnostic: the last 24 hours of health samples main keeps, sent now
 * (`diagnostic:send`). The button is off while the switch is, and while a send
 * runs, about ten seconds on a slow network; then one line says what main
 * answered (lib/diagnostic.ts).
 */
function DiagnosticRow({ enabled }: { enabled: boolean }) {
  const [sending, setSending] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const send = async () => {
    setSending(true);
    setLine(null);
    let answer: unknown;
    try {
      answer = await window.electronAPI?.diagnostic?.send();
    } catch {
      // The call itself failed: diagnosticLine reads no answer as nothing sent.
    }
    setLine(diagnosticLine(answer, new Date()));
    setSending(false);
  };

  return (
    <SettingsRow
      wrap
      label="Diagnostic"
      description={
        <>
          <span className="block">Sends the last 24 hours of health numbers now, at most once a day, while Send error reports is on. Tars records them here every 5 minutes: memory, the slowest calls, how many agents run, the page open. No file path, no name, no content.</span>
          {line && <span data-diagnostic-line className="block mt-1 font-mono text-foreground">{line}</span>}
        </>
      }
      control={
        <Button size="sm" className="font-mono lowercase" disabled={!enabled || sending} onClick={send}>
          {sending ? 'sending…' : 'send a diagnostic'}
        </Button>
      }
    />
  );
}
