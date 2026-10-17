import { ipcMain, type BrowserWindow } from 'electron';
import { detectShells } from '../platform/shell-choices';
import { isWindowsShell, parseTitleBarOverlay, TITLE_BAR_OVERLAY_HEIGHT } from '../platform/desktop-shell';

/**
 * The renderer's two calls into the desktop shell:
 *
 * - `desktop:detectShells`: the shells Settings > Terminal offers, and
 *   the one a terminal gets with no setting, on every platform (on macOS and
 *   Linux from /etc/shells, since 2.0.4).
 * - `desktop:setTitleBarOverlay`: the caption buttons' colours, pushed by the
 *   shell when the theme changes. Honoured for the main window only, on
 *   Windows only, and only for two `#rrggbb` colours.
 */
export function registerDesktopShellHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  platform?: NodeJS.Platform;
}): void {
  const platform = deps.platform ?? process.platform;
  ipcMain.handle('desktop:detectShells', () => detectShells({ platform }));

  ipcMain.handle('desktop:setTitleBarOverlay', (event, colours: unknown) => {
    const win = deps.getMainWindow();
    if (!isWindowsShell(platform) || !win || win.isDestroyed() || win.webContents !== event.sender) {
      return { success: false, error: 'no title bar overlay here' };
    }
    const parsed = parseTitleBarOverlay(colours);
    if (!parsed) return { success: false, error: 'expected two #rrggbb colours' };
    win.setTitleBarOverlay({ ...parsed, height: TITLE_BAR_OVERLAY_HEIGHT });
    return { success: true };
  });
}
