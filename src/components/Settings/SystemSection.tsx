import { useState, useEffect } from 'react';
import { FolderOpen, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import type { ClaudeInfo, AppSettings } from './types';

interface SystemSectionProps {
  info: ClaudeInfo | null;
  appSettings: AppSettings;
  onSaveAppSettings: (settings: Partial<AppSettings>) => void;
}

interface CLIVersion {
  name: string;
  binary: string;
  version: string | null;
  loading: boolean;
}

export const SystemSection = ({ info, appSettings, onSaveAppSettings }: SystemSectionProps) => {
  const [cliVersions, setCliVersions] = useState<CLIVersion[]>([
    { name: 'Claude', binary: 'claude', version: null, loading: true },
    { name: 'Codex', binary: 'codex', version: null, loading: true },
    { name: 'Gemini', binary: 'gemini', version: null, loading: true },
    { name: 'Qwen Code', binary: 'qwen-code', version: null, loading: true },
    { name: 'OpenCode', binary: 'opencode', version: null, loading: true },
    { name: 'Pi', binary: 'pi', version: null, loading: true },
    { name: 'MiniMax', binary: 'minimax', version: null, loading: true },
  ]);

  useEffect(() => {
    const detect = async () => {
      const results = await Promise.all(
        cliVersions.map(async (cli) => {
          try {
            const result = await window.electronAPI?.shell?.exec({ command: `${cli.binary} --version 2>&1` });
            const version = result?.success && result.output && !result.output.includes('not found') && !result.output.includes('command not found')
              ? result.output.trim().split('\n')[0]
              : null;
            return { ...cli, version, loading: false };
          } catch {
            return { ...cli, version: null, loading: false };
          }
        })
      );
      setCliVersions(results);
    };
    detect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenConfigFolder = () => {
    if (info?.configPath && window.electronAPI?.shell) {
      window.electronAPI.shell.exec({ command: `open "${info.configPath}"` });
    }
  };

  const handleVerboseModeToggle = () => {
    onSaveAppSettings({ verboseModeEnabled: !appSettings.verboseModeEnabled });
  };

  const handleChromeToggle = () => {
    onSaveAppSettings({ chromeEnabled: !appSettings.chromeEnabled });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">System Information</h2>
        <p className="text-sm text-muted-foreground">Installation details and CLI versions</p>
      </div>

      {/* Installed CLIs */}
      <div className="border border-border bg-card p-6">
        <h3 className="text-md font-medium mb-4">Installed CLIs</h3>
        <div className="space-y-0">
          {cliVersions.map((cli) => (
            <div key={cli.binary} className="flex items-center justify-between py-3 border-b border-border last:border-0">
              <span className="text-sm">{cli.name}</span>
              <div className="flex items-center gap-2">
                {cli.loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                ) : cli.version ? (
                  <>
                    <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                    <span className="text-sm font-mono">{cli.version}</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                    <span className="text-sm text-muted-foreground">Not installed</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Agent Settings */}
      <div className="border border-border bg-card p-6">
        <h3 className="text-md font-medium mb-4">Agent Settings</h3>
        <div className="flex items-center justify-between py-3 border-b border-border">
          <div>
            <span className="text-sm">Verbose Mode</span>
            <p className="text-xs text-muted-foreground mt-1">
              Start agents with --verbose flag for detailed output
            </p>
          </div>
          <button
            onClick={handleVerboseModeToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              appSettings.verboseModeEnabled ? 'bg-white' : 'bg-white/20'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-black transition-transform ${
                appSettings.verboseModeEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between py-3 border-b border-border">
          <div>
            <span className="text-sm">Chrome Browser Sharing</span>
            <p className="text-xs text-muted-foreground mt-1">
              Share your logged-in Chrome browser with agents via --chrome flag
            </p>
          </div>
          <button
            onClick={handleChromeToggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              appSettings.chromeEnabled ? 'bg-white' : 'bg-white/20'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-black transition-transform ${
                appSettings.chromeEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <div className="mt-3 px-3 py-2 bg-muted/50 border border-border rounded text-xs text-muted-foreground">
          Requires Claude Code v2.0.73 or later and the{' '}
          <a
            href="https://chromewebstore.google.com/detail/claude-in-chrome/ofnckddkabkmfmjkfgiofpofhpgjdlda"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Claude in Chrome
          </a>{' '}
          extension installed.
        </div>
      </div>

      {info && (
        <div className="border border-border bg-card p-6">
          <div className="space-y-4">
            <div className="flex justify-between py-3 border-b border-border">
              <span className="text-sm text-muted-foreground">Platform</span>
              <span className="text-sm font-mono">{info.platform} ({info.arch})</span>
            </div>
            <div className="flex justify-between py-3 border-b border-border">
              <span className="text-sm text-muted-foreground">Electron</span>
              <span className="text-sm font-mono">{info.electronVersion}</span>
            </div>
            <div className="flex justify-between py-3 border-b border-border">
              <span className="text-sm text-muted-foreground">Node.js</span>
              <span className="text-sm font-mono">{info.nodeVersion}</span>
            </div>
            <div className="flex justify-between py-3 border-b border-border">
              <span className="text-sm text-muted-foreground">Config Path</span>
              <span className="text-sm font-mono text-muted-foreground truncate max-w-[200px]">{info.configPath}</span>
            </div>
            <div className="pt-4">
              <button
                onClick={handleOpenConfigFolder}
                className="flex items-center gap-2 px-4 py-2 bg-secondary text-foreground hover:bg-secondary/80 transition-colors text-sm"
              >
                <FolderOpen className="w-4 h-4" />
                Open Config Folder
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
