'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettings } from '@/hooks/useSettings';
import { Button, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import {
  SettingsSidebar,
  SettingsCard,
  InstallTerminalModal,
  GeneralSection,
  TerminalSection,
  GitSection,
  NotificationsSection,
  TelegramSection,
  SlackSection,
  DiscordSection,
  SocialDataSection,
  TasmaniaSection,
  GoogleWorkspaceSection,
  AIProvidersSection,
  ClaudeAccountsSection,
  PermissionsSection,
  SkillsSection,
  McpSection,
  MemorySection,
  HermesSection,
  CLIPathsSection,
  SystemSection,
  SECTIONS,
} from '@/components/Settings';
import type { SettingsSection } from '@/components/Settings';
import 'xterm/css/xterm.css';

/**
 * One action per sub-page, in the header.
 *
 * The header used to carry two buttons for every screen - a bordered `Refresh`
 * that reloaded all seventeen sections, and a `Save Changes` that only ever
 * applied to two of them. The design gives each sub-page the single action it
 * actually needs, named after what that screen does.
 *
 * `save` and `refresh` are the two the page itself owns. The rest name the
 * action the design puts here, but their handler still lives inside the section
 * body until that section is converted, so they render disabled with a note
 * rather than claiming to do something they do not.
 */
type HeaderActionKind = 'save' | 'refresh' | 'unwired' | 'none';

const HEADER_ACTIONS: Record<SettingsSection, { label: string; kind: HeaderActionKind }> = {
  general: { label: 'Save', kind: 'save' },
  terminal: { label: 'Save', kind: 'save' },
  notifications: { label: 'Save', kind: 'save' },
  permissions: { label: 'Save', kind: 'save' },
  git: { label: 'Save', kind: 'save' },
  socialdata: { label: 'Save', kind: 'save' },
  'google-workspace': { label: 'Save', kind: 'save' },
  tasmania: { label: 'Save', kind: 'save' },
  'ai-providers': { label: 'Detect', kind: 'unwired' },
  // Every control acts at once, as drawn: add an account sits in its list.
  'claude-accounts': { label: '', kind: 'none' },
  cli: { label: 'Detect', kind: 'unwired' },
  hermes: { label: 'Test connection', kind: 'unwired' },
  telegram: { label: 'Test', kind: 'unwired' },
  slack: { label: 'Test', kind: 'unwired' },
  discord: { label: 'Test', kind: 'unwired' },
  memory: { label: 'Check', kind: 'unwired' },
  mcp: { label: '+ Server', kind: 'unwired' },
  system: { label: 'Refresh', kind: 'refresh' },
  skills: { label: 'Refresh', kind: 'refresh' },
};

/**
 * Telegram while Telegram through Hermes is on: the bot is off and its token
 * erased, so there is nothing to test, as `Settings · Telegram · Telegram
 * through Hermes` draws it.
 */
const NO_ACTION = { label: '', kind: 'none' } as const;

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const searchParams = useSearchParams();
  const sectionParam = searchParams.get('section');
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

  // Deep-link: initialize from URL param
  useEffect(() => {
    if (sectionParam && SECTIONS.some(s => s.id === sectionParam)) {
      setActiveSection(sectionParam as SettingsSection);
    }
  }, [sectionParam]);
  const [showInstallTerminal, setShowInstallTerminal] = useState(false);
  const [installCommand, setInstallCommand] = useState('');

  const {
    settings,
    appSettings,
    info,
    skills,
    loading,
    saving,
    error,
    saved,
    hasChanges,
    fetchSettings,
    handleSave,
    handleSaveAppSettings,
    updateSettings,
    updateLocalAppSettings,
  } = useSettings();

  const renderContent = () => {
    switch (activeSection) {
      case 'general':
        return <GeneralSection info={info} appSettings={appSettings} onSaveAppSettings={handleSaveAppSettings} />;
      case 'terminal':
        return <TerminalSection appSettings={appSettings} onSaveAppSettings={handleSaveAppSettings} />;
      case 'git':
        return <GitSection settings={settings} onUpdateSettings={updateSettings} />;
      case 'notifications':
        return (
          <NotificationsSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
          />
        );
      case 'telegram':
        return (
          <TelegramSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
            onOpenHermes={() => setActiveSection('hermes')}
          />
        );
      case 'slack':
        return (
          <SlackSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'discord':
        return (
          <DiscordSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'socialdata':
        return (
          <SocialDataSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'tasmania':
        return (
          <TasmaniaSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'google-workspace':
        return (
          <GoogleWorkspaceSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'ai-providers':
        return (
          <AIProvidersSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'claude-accounts':
        return <ClaudeAccountsSection />;
      case 'permissions':
        return <PermissionsSection settings={settings} />;
      case 'skills':
        return <SkillsSection skills={skills} />;
      case 'hermes':
        return (
          <HermesSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'memory':
        return (
          <MemorySection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'mcp':
        return <McpSection />;
      case 'cli':
        return (
          <CLIPathsSection
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
            onUpdateLocalSettings={updateLocalAppSettings}
          />
        );
      case 'system':
        return (
          <SystemSection
            info={info}
            appSettings={appSettings}
            onSaveAppSettings={handleSaveAppSettings}
          />
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <LoadingState loading what="Loading your settings" detail="reading ~/.dorothy/app-settings.json" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <ErrorState
          title="Could not read your settings."
          detail={error}
          onRetry={fetchSettings}
        />
      </div>
    );
  }

  // The header names the sub-page you are on, not the app: `Preferences`,
  // `Terminal`, `Providers`, `Connection`. Title and subtitle both come from
  // the leaf, so the nav and the header can never disagree.
  const activeLeaf = SECTIONS.find(s => s.id === activeSection);
  const action = activeSection === 'telegram' && appSettings.hermesRelayEnabled === true
    ? NO_ACTION
    : HEADER_ACTIONS[activeSection];

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] lg:h-[calc(100vh-3rem)] overflow-hidden">
      <PageHeader
        title={activeLeaf?.label ?? 'Settings'}
        subtitle={activeLeaf?.description}
        actions={
          action.kind === 'none' ? undefined : action.kind === 'save' ? (
            <Button
              variant="primary"
              size="md"
              onClick={handleSave}
              disabled={saving || !hasChanges}
            >
              {saving ? 'Saving' : saved ? 'Saved' : action.label}
            </Button>
          ) : action.kind === 'refresh' ? (
            <Button variant="primary" size="md" onClick={fetchSettings}>
              {action.label}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              disabled
              title="This action still lives inside the section below."
            >
              {action.label}
            </Button>
          )
        }
      />

      {/* Error message */}
      {error && settings && (
        <div className="p-4 bg-danger/10 border border-danger/30 text-danger text-sm mb-4 shrink-0">
          {error}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex gap-2.5 overflow-hidden min-h-0">
        <SettingsSidebar
          activeSection={activeSection}
          onSectionChange={setActiveSection}
        />

        {/* Content Area: one bordered card per sub-page, filling the height */}
        <motion.div
          key={activeSection}
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.15 }}
          className="flex-1 min-w-0 min-h-0 flex flex-col"
        >
          <SettingsCard>{renderContent()}</SettingsCard>
        </motion.div>
      </div>

      {/* Installation Terminal Modal */}
      <AnimatePresence>
        {showInstallTerminal && (
          <InstallTerminalModal
            show={showInstallTerminal}
            command={installCommand}
            onClose={() => setShowInstallTerminal(false)}
            onComplete={fetchSettings}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
