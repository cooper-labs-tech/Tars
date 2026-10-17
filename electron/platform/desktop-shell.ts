/**
 * The desktop shell: the title bar, a close that hides to the tray, no
 * application menu, the tray's menu, and where the tray panel opens.
 *
 * Every function here is pure and takes the platform, and the callers carry
 * no `if (win32)` of their own. darwin gets exactly what it had before this
 * file existed. linux shares Windows's tray menu, no menu bar and close to the
 * tray since 2.0.4 (parity P2), the close only where a tray is shown.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface DisplayArea { bounds: Rect; workArea: Rect }

/** The native caption buttons' band. 32 px leaves 5 px above the header's actions; 40 overlaps them. */
export const TITLE_BAR_OVERLAY_HEIGHT = 32;

/** package.json build.appId. Windows attributes a toast to it; unset, toasts are dropped. */
export const WINDOWS_APP_USER_MODEL_ID = 'xyz.cooperlabs.tars';

/** The gap between the tray panel and the taskbar or the screen edge. */
export const TRAY_PANEL_MARGIN = 8;

/**
 * How long after the panel hid on blur a tray click is the click that caused
 * the blur. Pressing the icon blurs the panel, releasing it clicks.
 */
export const TRAY_CLICK_AFTER_BLUR_MS = 300;

/** The dark theme's --bg-primary and --text-primary: the window opens dark. */
const LAUNCH_OVERLAY = { color: '#121212', symbolColor: '#F5F4F2' } as const;

/** Whether the Windows-only parts apply: the title bar overlay, the AppUserModelId, the session end, the tray panel's placement. */
export function isWindowsShell(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/**
 * No application menu: Electron's default one bound Ctrl+W to closing the
 * window, Ctrl+R and Ctrl+Shift+R to reloading the renderer, Ctrl+Shift+I to
 * DevTools and Ctrl+minus to zoom, over every page including the terminals,
 * and showed a File / Edit / View bar on Linux. macOS keeps its menu: it is
 * Cmd+Q, Cmd+C, Cmd+V and every Edit command there.
 */
export function removesApplicationMenu(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

/**
 * The tray has a menu (Show Tars, Quit Tars). On Windows it is the only way to
 * quit once a close hides; on Linux the tray is an AppIndicator, which sends
 * no click, so the menu is all it does. macOS opens the tray panel on a click.
 */
export function hasTrayMenu(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

export type TitleBarOptions =
  | { titleBarStyle: 'hiddenInset' }
  | { titleBarStyle: 'hidden'; titleBarOverlay: { color: string; symbolColor: string; height: number } };

/**
 * The main window's title bar. darwin/linux: `hiddenInset`, as always. win32:
 * no frame, and the native minimise, maximise and close buttons drawn over the
 * window in the app's own background, which the renderer then keeps in step
 * with the theme (parseTitleBarOverlay).
 */
export function titleBarOptions(platform: NodeJS.Platform): TitleBarOptions {
  if (!isWindowsShell(platform)) return { titleBarStyle: 'hiddenInset' };
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...LAUNCH_OVERLAY, height: TITLE_BAR_OVERLAY_HEIGHT } };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * The overlay colours the renderer sends when the theme changes, read from its
 * --bg-primary and --text-primary tokens. Anything but two `#rrggbb` strings is
 * refused: the value comes over IPC and goes to a native call.
 */
export function parseTitleBarOverlay(input: unknown): { color: string; symbolColor: string } | null {
  if (!input || typeof input !== 'object') return null;
  const { color, symbolColor } = input as Record<string, unknown>;
  if (typeof color !== 'string' || typeof symbolColor !== 'string') return null;
  const c = color.trim();
  const s = symbolColor.trim();
  return HEX.test(c) && HEX.test(s) ? { color: c, symbolColor: s } : null;
}

/**
 * What closing the main window does. darwin: it closes, as always. win32
 * while Tars runs: it hides to the tray and the agents keep running, after a
 * one-time explanation. linux the same, only while a tray is shown
 * (platform/linux-tray.ts): with none, hiding would leave nothing on screen
 * to bring Tars back, so it closes. A quit (the tray menu, the updater, a
 * test harness) always closes, or it would never end.
 */
export function closeAction(opts: {
  platform: NodeJS.Platform;
  quitting: boolean;
  explained: boolean;
  /** linux: whether a tray icon is shown. Unknown is not shown. */
  trayShown?: boolean;
}): 'close' | 'hide' | 'explain' {
  if (opts.quitting) return 'close';
  if (opts.platform === 'linux' ? opts.trayShown !== true : !isWindowsShell(opts.platform)) return 'close';
  return opts.explained ? 'hide' : 'explain';
}

/** A tray click that follows the panel's blur hide by less than the guard is the click that closed it. */
export function isClickThatClosedPanel(platform: NodeJS.Platform, now: number, hiddenByBlurAt: number | null): boolean {
  if (!isWindowsShell(platform) || hiddenByBlurAt === null) return false;
  const since = now - hiddenByBlurAt;
  return since >= 0 && since < TRAY_CLICK_AFTER_BLUR_MS;
}

export type TaskbarEdge = 'bottom' | 'top' | 'left' | 'right';

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

/**
 * The side of the display the taskbar is on: the side the work area gave up.
 * An auto-hidden taskbar gives up nothing, so the display edge nearest the
 * icon (or the cursor) stands for it.
 */
export function taskbarEdge(display: DisplayArea, near: Point): TaskbarEdge {
  const { bounds: b, workArea: w } = display;
  const insets: [TaskbarEdge, number][] = [
    ['bottom', bottom(b) - bottom(w)],
    ['top', w.y - b.y],
    ['left', w.x - b.x],
    ['right', right(b) - right(w)],
  ];
  const widest = insets.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  if (widest[1] > 0) return widest[0];
  const distances: [TaskbarEdge, number][] = [
    ['bottom', bottom(b) - near.y],
    ['top', near.y - b.y],
    ['left', near.x - b.x],
    ['right', right(b) - near.x],
  ];
  return distances.reduce((best, cur) => (cur[1] < best[1] ? cur : best))[0];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Where the tray panel opens on Windows: on the taskbar's side of the
 * work area, TRAY_PANEL_MARGIN inside it, centred on the icon along the
 * taskbar and clamped to the work area.
 *
 * An icon in the overflow flyout (bounds inside the work area, above the
 * taskbar) or one Windows reports no bounds for (0x0) has no meaningful
 * centre: the panel is anchored to the taskbar's corner instead, bottom right
 * for a bottom or right taskbar, top right for a top one, bottom left for a
 * left one. `cursor` names the side when there are no bounds.
 */
export function trayPanelPosition(opts: {
  trayBounds: Rect;
  display: DisplayArea;
  panel: { width: number; height: number };
  cursor?: Point;
}): Point {
  const { trayBounds: t, display, panel } = opts;
  const w = display.workArea;
  const M = TRAY_PANEL_MARGIN;
  const hasBounds = t.width > 0 && t.height > 0;
  const centre = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
  const near = hasBounds ? centre : opts.cursor ?? { x: right(display.bounds), y: bottom(display.bounds) };
  const edge = taskbarEdge(display, near);

  const workAreaIsDisplay = w.x === display.bounds.x && w.y === display.bounds.y
    && w.width === display.bounds.width && w.height === display.bounds.height;
  const insideWorkArea = centre.x > w.x && centre.x < right(w) && centre.y > w.y && centre.y < bottom(w);
  const anchored = !hasBounds || (!workAreaIsDisplay && insideWorkArea);

  const minX = w.x + M;
  const maxX = right(w) - panel.width - M;
  const minY = w.y + M;
  const maxY = bottom(w) - panel.height - M;

  let x: number;
  let y: number;
  if (edge === 'bottom' || edge === 'top') {
    y = edge === 'bottom' ? maxY : minY;
    x = anchored ? maxX : centre.x - panel.width / 2;
  } else {
    x = edge === 'left' ? minX : maxX;
    y = anchored ? maxY : centre.y - panel.height / 2;
  }
  return { x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)) };
}
