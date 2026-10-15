import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow, app } from 'electron';
import { GITHUB_REPO } from '../constants';
import { installerAssetFor, offersUpdate } from '../platform';

// Don't download until user clicks "Download"
autoUpdater.autoDownload = false;
// Install on next quit after download completes
autoUpdater.autoInstallOnAppQuit = true;

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null) {
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    getMainWindow()?.webContents.send('app:update-available', {
      currentVersion: autoUpdater.currentVersion.version,
      latestVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      hasUpdate: true,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    getMainWindow()?.webContents.send('app:update-not-available', {
      currentVersion: autoUpdater.currentVersion.version,
      latestVersion: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    getMainWindow()?.webContents.send('app:update-progress', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', () => {
    getMainWindow()?.webContents.send('app:update-downloaded');
  });

  autoUpdater.on('error', (err) => {
    // Don't broadcast error if we're going to fall back to GitHub API
    // The fallback is handled in checkForUpdates()
    console.error('autoUpdater error:', err.message);
  });
}

/**
 * Fallback: check GitHub releases API directly (same as pre-electron-updater).
 * Used when autoUpdater fails (e.g. missing latest-mac.yml on older releases).
 */
async function checkGitHubRelease(mainWindow: BrowserWindow | null) {
  const currentVersion = app.getVersion();
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Tars-App',
    },
  });

  if (!response.ok) return null;

  const data = await response.json();
  const tagName: string = data.tag_name || '';
  const latestVersion = tagName.replace(/^v/, '');

  const pa = currentVersion.split('.').map(Number);
  const pb = latestVersion.split('.').map(Number);
  let hasUpdate = false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (nb > na) { hasUpdate = true; break; }
    if (na > nb) break;
  }

  // Find download asset: this platform's own, since one release carries the
  // macOS and the Windows files side by side.
  let downloadUrl = '';
  let installer: { name: string; browser_download_url?: string } | undefined;
  if (data.assets && Array.isArray(data.assets)) {
    installer = installerAssetFor<{ name: string; browser_download_url?: string }>(data.assets, process.platform, process.arch);
    downloadUrl = installer?.browser_download_url || '';
  }
  // A release this platform cannot install yet is no update, and the latest
  // version it can get is then the one it runs.
  const offered = offersUpdate(process.platform, installer);
  if (!offered) hasUpdate = false;
  const latestForThisPlatform = offered ? latestVersion : currentVersion;

  const info = {
    currentVersion,
    latestVersion: latestForThisPlatform,
    downloadUrl: downloadUrl || data.html_url || '',
    releaseUrl: data.html_url || '',
    releaseNotes: data.body || '',
    hasUpdate,
  };

  if (hasUpdate) {
    mainWindow?.webContents.send('app:update-available', info);
  } else {
    mainWindow?.webContents.send('app:update-not-available', {
      currentVersion,
      latestVersion: latestForThisPlatform,
    });
  }

  return info;
}

// Store a reference so the fallback can access mainWindow
let _getMainWindow: (() => BrowserWindow | null) | null = null;

export function setMainWindowGetter(fn: () => BrowserWindow | null) {
  _getMainWindow = fn;
}

export async function checkForUpdates() {
  try {
    // autoUpdater.checkForUpdates() returns null when app is not packed (dev mode)
    const result = await autoUpdater.checkForUpdates();
    if (result === null) {
      return { devMode: true, currentVersion: app.getVersion() };
    }
    return { devMode: false };
  } catch (err) {
    // autoUpdater failed (e.g. missing latest-mac.yml on older releases).
    // Fall back to direct GitHub API check.
    console.warn('autoUpdater failed, falling back to GitHub API:', (err as Error).message);
    try {
      const mainWindow = _getMainWindow?.() ?? null;
      const info = await checkGitHubRelease(mainWindow);
      if (!info) {
        return { error: true };
      }
      return { devMode: false, fallback: true };
    } catch (fallbackErr) {
      console.error('GitHub API fallback also failed:', fallbackErr);
      return { error: true };
    }
  }
}

export function downloadUpdate() {
  return autoUpdater.downloadUpdate();
}

/**
 * Hand over to the downloaded update.
 *
 * This can fail and used to fail silently: it was called and never awaited or
 * caught, so a refusal left the window sitting on "Restarting" forever. On
 * macOS the common refusal is an unsigned build, where the updater cannot
 * validate what it downloaded and declines to swap it in.
 *
 * It also returns when it succeeds only in the sense that the process is about
 * to die, so the caller cannot treat "returned" as "worked". What it can do is
 * report a throw, which is the case that leaves the user staring at a spinner.
 */
export function quitAndInstall(): { started: boolean; error?: string } {
  try {
    autoUpdater.quitAndInstall();
    return { started: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('quitAndInstall refused:', message);
    return { started: false, error: message };
  }
}
