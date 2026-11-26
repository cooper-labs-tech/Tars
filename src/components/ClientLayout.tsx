'use client';

import { useStore } from '@/store';
import { BrandMark } from '@/components/Brand';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import { useEffect, useState, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import NewShell from '@/components/NewShell/NewShell';
import { Splash } from '@/components/Splash';
import { Button, BrandSpinner } from '@/components/ui';
import { followErrorReportsSetting } from '@/lib/error-reports';

/** Strip HTML tags and collapse whitespace so release notes render as plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string;
  hasUpdate: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
}

type UpdateFlowState = 'available' | 'downloading' | 'ready' | 'restarting' | 'restart-failed';

const VAULT_READ_DOCS_KEY = 'vault-read-docs';
/** Kept in sync with the pre-hydration script in app/layout.tsx. */
const THEME_KEY = 'tars-theme';

function loadVaultReadDocs(): Set<string> {
  try {
    const stored = localStorage.getItem(VAULT_READ_DOCS_KEY);
    if (stored) return new Set(JSON.parse(stored));
    return new Set();
  } catch {
    return new Set();
  }
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Tray panel is a standalone Electron popup - render without sidebar/chrome
  if (pathname?.startsWith('/tray-panel')) {
    return <>{children}</>;
  }

  return <ClientLayoutInner>{children}</ClientLayoutInner>;
}

function ClientLayoutInner({ children }: { children: React.ReactNode }) {
  const {
    darkMode, setDarkMode, setVaultUnreadCount,
    updateBannerDismissed: updateDismissed,
    setUpdateBannerDismissed: setUpdateDismissed,
    setPendingUpdateVersion,
  } = useStore();

  // The splash belongs to the first paint, so it renders on both sides of
  // hydration. It used to be gated on a sessionStorage flag read inside this
  // initializer, and that is why nobody ever saw it: the initializer wrote the
  // flag during the hydration render, the splash node it returned had no match
  // in the prerendered HTML, hydration failed (React #418), and the client
  // re-render React falls back to re-ran the initializer, read the flag it had
  // just written, and returned false. The splash mounted, marked itself shown,
  // and was thrown away before a single frame of it painted. Starting at true
  // on both sides removes the mismatch and the need for the flag; only a real
  // document load reaches here, since client-side navigation keeps this layout
  // mounted.
  const [showSplash, setShowSplash] = useState(true);
  const dismissSplash = useCallback(() => setShowSplash(false), []);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateFlowState, setUpdateFlowState] = useState<UpdateFlowState>('available');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const downloadClickedRef = useRef(false);
  /** The version the panel was last opened for, so a repeat check does not
   *  reopen a banner the user closed. */
  const notifiedVersionRef = useRef<string | null>(null);

  // Listen for auto-check update available event from main process
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.updates) return;
    const unsubs: (() => void)[] = [];

    if (window.electronAPI.updates.onUpdateAvailable) {
      unsubs.push(window.electronAPI.updates.onUpdateAvailable((info) => {
        if (!info.hasUpdate) return;
        setUpdateInfo(info);
        setPendingUpdateVersion(info.latestVersion ?? null);
        // The check runs every half hour now, so re-opening the panel on every
        // result would put a dismissed banner back twice an hour. A dismissal
        // holds for the version it was made about; a newer one is new news.
        const version = info.latestVersion ?? '';
        if (version !== notifiedVersionRef.current) {
          notifiedVersionRef.current = version;
          // The panel no longer opens itself. A new version is news, not an
          // interruption: the sidebar row appears and stays until the update
          // is installed, and opening the panel is a click. It used to take
          // over the middle of the screen the moment a check came back.
          setUpdateDismissed(true);
          setUpdateFlowState('available');
          downloadClickedRef.current = false;
        }
      }));
    }

    if (window.electronAPI.updates.onDownloadProgress) {
      unsubs.push(window.electronAPI.updates.onDownloadProgress((progress) => {
        setDownloadPercent(progress.percent);
        setDownloadSpeed(progress.bytesPerSecond);
      }));
    }

    if (window.electronAPI.updates.onUpdateDownloaded) {
      unsubs.push(window.electronAPI.updates.onUpdateDownloaded(() => {
        setUpdateFlowState('ready');
      }));
    }

    if (window.electronAPI.updates.onUpdateError) {
      unsubs.push(window.electronAPI.updates.onUpdateError(() => {
        setUpdateFlowState('available');
        downloadClickedRef.current = false;
      }));
    }

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const isFallbackUpdate = !!(updateInfo?.downloadUrl);

  const handleDownloadUpdate = useCallback(() => {
    if (downloadClickedRef.current) return;
    downloadClickedRef.current = true;
    if (isFallbackUpdate && updateInfo?.downloadUrl) {
      // Fallback mode: open browser (no in-app download available)
      window.electronAPI?.updates?.openExternal(updateInfo.downloadUrl);
      setUpdateDismissed(true);
    } else {
      setUpdateFlowState('downloading');
      setDownloadPercent(0);
      window.electronAPI?.updates?.download();
    }
  }, [isFallbackUpdate, updateInfo]);

  const handleQuitAndInstall = useCallback(async () => {
    setUpdateFlowState('restarting');
    const res = await window.electronAPI?.updates?.quitAndInstall();
    if (res && !res.started) {
      setUpdateFlowState('restart-failed');
      return;
    }
    // A successful handover kills this process, so anything that runs after
    // this line means it did not happen. The updater can decline without
    // throwing, which is what left the panel on "Restarting" forever.
    setTimeout(() => setUpdateFlowState(prev => (prev === 'restarting' ? 'restart-failed' : prev)), 8000);
  }, []);

  // Error reports, the window's half: started only if Settings has them on
  // (src/lib/error-reports.ts); the switch starts them itself when turned on.
  useEffect(() => { void followErrorReportsSetting(window.electronAPI); }, []);

  // Initialize dark mode from localStorage on mount. Dark is the launch
  // default: only an explicit 'light' pref moves off it. The old
  // 'dorothy-dark-mode' key is deliberately not migrated - it carries the
  // previous brand, and a stale 'false' in it used to open the app light.
  useEffect(() => {
    if (localStorage.getItem(THEME_KEY) === 'light') setDarkMode(false);
  }, [setDarkMode]);

  // Sync dark class on <html> and persist to localStorage
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem(THEME_KEY, darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // Global vault unread badge: listen for new documents even when VaultView is not mounted
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.vault) return;

    // Compute initial unread count on app start
    const initUnread = async () => {
      try {
        const result = await window.electronAPI!.vault!.listDocuments();
        if (result?.documents) {
          const readIds = loadVaultReadDocs();
          // If localStorage key doesn't exist yet (first ever load), don't show badges
          if (localStorage.getItem(VAULT_READ_DOCS_KEY) === null) return;
          const unread = result.documents.filter((d: { id: string }) => !readIds.has(d.id)).length;
          setVaultUnreadCount(unread);
        }
      } catch {
        // Ignore
      }
    };
    initUnread();

    // Listen for real-time document creation - increment unread
    const unsub = window.electronAPI!.vault!.onDocumentCreated(() => {
      setVaultUnreadCount(useStore.getState().vaultUnreadCount + 1);
    });

    return unsub;
  }, [setVaultUnreadCount]);

  return (
    <div className="app-shell min-h-screen bg-bg-primary relative">
      {showSplash && <Splash onDone={dismissSplash} />}
      {/* The shell, the only one since 2.1.0 (JeanBrasse, 26/11): the frames `Shell · <page>` and
          `Shell · <page> card`. The classic shell went with its switch. */}
      <NewShell>{children}</NewShell>

      {/* Update Available Dialog */}
      <AnimatePresence>
        {updateInfo && !updateDismissed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-scrim z-[100] flex items-center justify-center p-4"
            onClick={() => setUpdateDismissed(true)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className="bg-card border border-border rounded-lg max-w-md w-full p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-4">
                <BrandMark className="w-3 h-3" />
                <div>
                  <h3 className="font-semibold text-foreground">Update Available</h3>
                  <p className="text-sm text-muted-foreground">
                    Tars {updateInfo.latestVersion} is ready
                  </p>
                </div>
              </div>

              <div className="p-3 bg-secondary/50 border border-border rounded mb-4">
                <p className="text-sm text-muted-foreground">
                  You&apos;re currently on version <span className="font-mono font-medium text-foreground">{updateInfo.currentVersion}</span>
                </p>
              </div>

              {updateInfo.releaseNotes && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Release notes:</p>
                  <p className="text-sm text-foreground/80 whitespace-pre-wrap line-clamp-6">
                    {stripHtml(updateInfo.releaseNotes).slice(0, 400)}
                    {updateInfo.releaseNotes.length > 400 ? '...' : ''}
                  </p>
                </div>
              )}

              {/* Download progress bar */}
              {updateFlowState === 'downloading' && (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span>Downloading... {downloadPercent.toFixed(0)}%</span>
                    <span>{downloadSpeed > 0 ? `${(downloadSpeed / 1024 / 1024).toFixed(1)} MB/s` : ''}</span>
                  </div>
                  <div className="w-full h-2 bg-secondary overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${downloadPercent}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Why nothing happened, when nothing happened. Left unsaid, the
                  panel sat on "Restarting" and the user had no idea the
                  handover had been refused. */}
              {updateFlowState === 'restart-failed' && (
                <div className="mb-4 flex items-start gap-2 border border-warning/40 bg-card px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-muted-foreground">
                    Tars could not swap itself for the new version. On macOS this is usually because
                    the build is not code-signed, so the updater will not install what it downloaded.
                    Install it by hand and this will keep working as before.
                  </p>
                </div>
              )}

              {/* The label carries what the icon used to say, so the download
                  and restart glyphs are gone; the spinners stay because they
                  report progress, not the action. */}
              <div className="flex gap-2">
                {updateFlowState === 'available' && (
                  <Button variant="primary" className="flex-1" onClick={handleDownloadUpdate}>
                    {isFallbackUpdate ? 'Download in Browser' : 'Download Update'}
                  </Button>
                )}

                {updateFlowState === 'downloading' && (
                  <Button variant="primary" className="flex-1" disabled>
                    <BrandSpinner size={14} />
                    Downloading
                  </Button>
                )}

                {updateFlowState === 'ready' && (
                  <Button variant="primary" className="flex-1" onClick={handleQuitAndInstall}>
                    Restart to Apply
                  </Button>
                )}

                {updateFlowState === 'restarting' && (
                  <Button variant="primary" className="flex-1" disabled>
                    <BrandSpinner size={14} />
                    Restarting
                  </Button>
                )}

                {updateFlowState === 'restart-failed' && (
                  <Button
                    variant="primary"
                    className="flex-1"
                    onClick={() => window.electronAPI?.updates?.openExternal(
                      updateInfo?.downloadUrl || 'https://github.com/cooper-labs-tech/Tars/releases/latest',
                    )}
                  >
                    Download it instead
                  </Button>
                )}

                {updateFlowState !== 'restarting' && (
                  <Button variant="ghost" onClick={() => setUpdateDismissed(true)}>
                    Later
                  </Button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
