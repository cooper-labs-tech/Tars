import { app, dialog, Menu, type BrowserWindow } from 'electron';
import { closeAction, isWindowsShell, removesApplicationMenu, WINDOWS_APP_USER_MODEL_ID } from '../platform/desktop-shell';
import { registerDesktopShellHandlers } from '../handlers/desktop-shell-handlers';

/**
 * The app lifecycle: one instance per profile, on every platform. On Windows
 * and Linux (since 2.0.4, parity P2), no application menu and a close that
 * hides to the tray, Linux only while a tray is shown; on Windows, the end of
 * the session. darwin keeps Electron's defaults (the application menu, a
 * close that closes).
 */

/** Set by before-quit: from then on a close is a close, never a hide. */
let quitting = false;

function markQuitting(): void {
  quitting = true;
}

/** The app's before-quit listeners, run now, as a quit runs them. */
function emitBeforeQuit(): void {
  app.emit('before-quit', { preventDefault() {} });
}

/**
 * One Tars per user data directory. A second launch hands over to the first
 * (`onSecondLaunch`, which shows its window) and must end at once: it has read
 * app-settings.json and nothing else, written nothing, and anything it went on
 * to do (bind the API port, save an empty fleet over agents.json on quit)
 * would be done by a second writer. False means this process is the second one.
 *
 * On every platform (the maintainer's parity rule of 2026-10-16, the Audit's
 * G1): macOS only brings a running app forward when it is opened from the
 * Finder, and `open -n`, a second copy or a dev run start a second process;
 * Linux starts one at every launch. The lock is Chromium's, per user data
 * directory: a sandbox (scripts/sandbox.sh moves it with CFFIXED_USER_HOME)
 * or an e2e run (`--user-data-dir`) has its own, and runs beside.
 */
export function claimSingleInstance(onSecondLaunch: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', onSecondLaunch);
  return true;
}

/** Where the one-time explanation is remembered: app-settings.json. */
export interface CloseExplanationStore {
  explained(): boolean;
  markExplained(): void;
}

/**
 * The first close, once: whether the agents keep running in the tray or Tars
 * quits. It has no "don't ask again" box, since the answer is always
 * remembered.
 */
async function explainCloseToTray(win: BrowserWindow, platform: NodeJS.Platform): Promise<'keep' | 'quit'> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Tars',
    message: 'Keep your agents running?',
    // Linux: an AppIndicator opens its menu on any click.
    detail: platform === 'linux'
      ? 'Tars can keep them working in the background: open it again, or quit it, from the menu of its icon in the top bar.'
      : 'Tars can keep them working in the background: open it again from the tray icon, or right click it to quit.',
    buttons: ['Keep running in the tray', 'Quit and stop agents'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 ? 'quit' : 'keep';
}

/**
 * Closing the main window on Windows hides it to the tray: the agents keep
 * running, the tray icon or a second launch brings it back, and Quit Tars in
 * the tray menu ends it (before-quit kills the terminals, as ever). The first
 * close explains that once. On Linux the same while a tray is shown
 * (`trayShown`, asked at each close); with none, a close closes.
 */
export function keepRunningOnClose(
  win: BrowserWindow,
  store: CloseExplanationStore,
  platform: NodeJS.Platform = process.platform,
  trayShown: () => boolean = () => false,
): void {
  if (platform !== 'win32' && platform !== 'linux') return;
  let explaining = false;
  win.on('close', (event) => {
    const action = closeAction({ platform, quitting, explained: store.explained(), trayShown: trayShown() });
    if (action === 'close') return;
    event.preventDefault();
    if (action === 'hide') {
      win.hide();
      return;
    }
    // A second close while the question is up is the same close.
    if (explaining) return;
    explaining = true;
    explainCloseToTray(win, platform).then((choice) => {
      store.markExplained();
      if (choice === 'quit') app.quit();
      else if (!win.isDestroyed()) win.hide();
    }, (err) => {
      // No dialog: hide all the same, and ask again next time.
      console.error('close to tray: the explanation could not be shown', err);
      if (!win.isDestroyed()) win.hide();
    }).finally(() => {
      explaining = false;
    });
  });
}

/**
 * Everything the desktop shell adds, installed once the main window exists:
 * the renderer's two calls (desktop-shell-handlers.ts, answered on every
 * platform, acting on Windows only), then
 *
 * - on Windows and Linux: no application menu (removesApplicationMenu says
 *   what Electron's default one bound; text fields keep cut, copy, paste and
 *   select all without it: Chromium handles them), a quit that is a quit
 *   (before-quit) and a close that hides to the tray, on Linux only while a
 *   tray is shown (`trayShown`);
 * - on Windows alone: the AppUserModelId Windows attributes toasts to (unset,
 *   it drops them) and the quit's steps at the end of the Windows session.
 */
export function installDesktopShell(opts: {
  getMainWindow: () => BrowserWindow | null;
  explanation: CloseExplanationStore;
  /**
   * What the end of the Windows session runs. Logoff, shutdown and restart
   * emit no before-quit, only the window's session-end, and Windows ends the
   * process as soon as that handler returns. Default: the app's own
   * before-quit listeners, emitted there, synchronously, once, so the quit's
   * steps (save the fleet, end the ACP runs, kill every terminal) are the one
   * list main.ts keeps.
   */
  onSessionEnd?: () => void;
  /** linux: whether a tray icon is shown now (platform/linux-tray.ts). */
  trayShown?: () => boolean;
  platform?: NodeJS.Platform;
}): void {
  const platform = opts.platform ?? process.platform;
  registerDesktopShellHandlers({ getMainWindow: opts.getMainWindow, platform });
  if (!removesApplicationMenu(platform)) return;
  if (isWindowsShell(platform)) app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  Menu.setApplicationMenu(null);
  app.on('before-quit', markQuitting);
  const win = opts.getMainWindow();
  if (!win) return;
  keepRunningOnClose(win, opts.explanation, platform, opts.trayShown);
  if (!isWindowsShell(platform)) return;
  let ended = false;
  win.on('session-end', () => {
    if (ended) return;
    ended = true;
    markQuitting();
    (opts.onSessionEnd ?? emitBeforeQuit)();
  });
}
