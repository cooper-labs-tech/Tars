import { useState, useEffect } from 'react';
import { Button, Input } from '@/components/ui';
import { SettingsRow } from './SettingsRow';
import type { AppSettings, CLIPaths } from './types';
import { CLIS } from '@/lib/clis';
import { tildePath } from '@/lib/display-path';
import { useCliDetection } from '@/hooks/useCliDetection';

interface CLIPathsSectionProps {
  appSettings: AppSettings;
  onSaveAppSettings: (settings: Partial<AppSettings>) => void;
  /** Kept for the call site; the provider toggles that used it now live on Providers. */
  onUpdateLocalSettings?: (settings: Partial<AppSettings>) => void;
}

type BinaryKey = keyof Omit<CLIPaths, 'additionalPaths'>;

// Row actions are words, not glyphs (R7): 26px lowercase mono.
const ROW_ACTION = 'font-mono lowercase';

// One row per binary: the command-line agents from the one list every page
// reads (src/lib/clis.ts), then the tools they reach for.
const BINARIES: { key: BinaryKey; label: string }[] = [
  ...CLIS.filter((c) => c.pathKey).map((c) => ({ key: c.pathKey as BinaryKey, label: c.name })),
  { key: 'gws', label: 'Google Workspace (gws)' },
  { key: 'gcloud', label: 'Google Cloud SDK (gcloud)' },
  { key: 'gh', label: 'GitHub CLI (gh)' },
  { key: 'node', label: 'Node.js' },
  { key: 'minimax', label: 'MiniMax' },
];

// The PATH separator of the machine the app runs on: `;` on Windows, where
// every drive holds a `:` and `C:\tools` split on colons became `C` and `\tools`.
const pathListSeparator = () => (typeof window !== 'undefined' && window.electronAPI?.platform === 'win32' ? ';' : ':');

const EMPTY_CLI_PATHS: CLIPaths = {
  claude: '', codex: '', gemini: '', grok: '', qwencode: '', kilo: '', opencode: '',
  amp: '', pi: '', gws: '', gcloud: '', gh: '', node: '', minimax: '', additionalPaths: [],
};

export const CLIPathsSection = ({ appSettings, onSaveAppSettings }: CLIPathsSectionProps) => {
  // The detection Providers reads too (useCliDetection), shown as the page
  // opens: it used to wait for detect now, and said "not detected" of CLIs
  // Providers listed as ready.
  const { paths: detectedPaths, detecting, detectAgain } = useCliDetection();
  const [localPaths, setLocalPaths] = useState<CLIPaths>(appSettings.cliPaths || EMPTY_CLI_PATHS);
  // The extra directories are one PATH string in the row, so the text has to
  // survive a trailing separator the parsed array would drop.
  const [additionalText, setAdditionalText] = useState(
    (appSettings.cliPaths?.additionalPaths || []).join(pathListSeparator())
  );

  useEffect(() => {
    setLocalPaths(appSettings.cliPaths || EMPTY_CLI_PATHS);
    setAdditionalText((appSettings.cliPaths?.additionalPaths || []).join(pathListSeparator()));
  }, [appSettings.cliPaths]);

  const handleDetectPaths = async () => {
    // Looks again. Detection is cached in main for the app run (#144), so
    // without `refresh` a CLI installed while Tars runs stays not found.
    const paths = await detectAgain();
    // Auto-fill empty fields with detected values
    const updatedPaths = { ...localPaths };
    for (const { key } of BINARIES) {
      if (!updatedPaths[key] && paths[key]) updatedPaths[key] = paths[key];
    }
    setLocalPaths(updatedPaths);
  };

  const handlePathChange = (key: BinaryKey, value: string) => {
    setLocalPaths(prev => ({ ...prev, [key]: value }));
  };

  const handleAdditionalChange = (value: string) => {
    setAdditionalText(value);
    setLocalPaths(prev => ({
      ...prev,
      additionalPaths: value.split(pathListSeparator()).map(p => p.trim()).filter(Boolean),
    }));
  };

  const handleSave = () => {
    onSaveAppSettings({ cliPaths: localPaths });
  };

  const hasChanges = JSON.stringify(localPaths) !== JSON.stringify(appSettings.cliPaths || EMPTY_CLI_PATHS);

  return (
    <>
      <SettingsRow
        label="Auto-detect"
        description="Looks in the usual places and fills in every path you have left empty."
        control={
          <Button
            size="sm"
            variant="ghost"
            className={ROW_ACTION}
            onClick={handleDetectPaths}
            disabled={detecting}
          >
            {detecting ? 'detecting' : 'detect now'}
          </Button>
        }
      />

      {BINARIES.map(({ key, label }) => {
        const detected = detectedPaths?.[key];
        const current = localPaths[key];
        // The row's second line is the path that will actually run.
        const resolved = current || detected || '';
        return (
          <SettingsRow
            key={key}
            label={label}
            description={
              resolved
                ? <span data-cli-path className="font-mono">{tildePath(resolved)}</span>
                : detectedPaths ? 'not found' : 'looking'
            }
            control={
              <Input
                mono
                width="control"
                value={current}
                onChange={(e) => handlePathChange(key, e.target.value)}
                placeholder={detected ? 'detected' : 'set path…'}
              />
            }
          />
        );
      })}

      <SettingsRow
        label="Additional PATH"
        description="Extra directories agents get on their PATH, separated by colons. /opt/homebrew/bin, /usr/local/bin and ~/.nvm are always included."
        control={
          <Input
            mono
            width="control"
            value={additionalText}
            onChange={(e) => handleAdditionalChange(e.target.value)}
            placeholder="/path/to/directory"
          />
        }
      />

      <SettingsRow
        label="Save CLI paths"
        description="Nothing here takes effect until you save."
        control={
          <Button variant="primary" size="md" onClick={handleSave} disabled={!hasChanges}>
            Save
          </Button>
        }
      />
    </>
  );
};
