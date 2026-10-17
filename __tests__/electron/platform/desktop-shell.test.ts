import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  TITLE_BAR_OVERLAY_HEIGHT,
  WINDOWS_APP_USER_MODEL_ID,
  TRAY_PANEL_MARGIN,
  titleBarOptions,
  parseTitleBarOverlay,
  isWindowsShell,
  taskbarEdge,
  trayPanelPosition,
  isClickThatClosedPanel,
  closeAction,
  removesApplicationMenu,
  hasTrayMenu,
} from '../../../electron/platform/desktop-shell';

/**
 * The Windows desktop shell (title bar, close, menu, tray panel), as pure
 * functions of the platform and the geometry.
 *
 * How it fails, written before the code (2026-09-26):
 * 1. darwin/linux: the window options change at all (anything but
 *    `titleBarStyle: 'hiddenInset'` and no overlay), or any of the Windows
 *    behaviours (no menu, single instance, hide on close, click guard) turns
 *    on there.
 * 2. win32: no overlay, an overlay taller or shorter than 32 px (40 px
 *    overlaps "+ Agent"), or an initial colour that is not the dark launch
 *    theme's background (#121212) and text (#F5F4F2).
 * 3. The renderer's overlay colours are passed through unchecked: anything
 *    but two `#rrggbb` strings (a CSS name, rgb(), an object, a string
 *    carrying more than a colour) reaches setTitleBarOverlay.
 * 4. Panel position, bottom taskbar: the panel lands below the work area (the
 *    measured bug: y = 1444 on a 1440 screen), overlaps the taskbar, is not
 *    8 px above it, or is not centred on the icon and clamped 8 px inside
 *    the work area's left and right edges.
 * 5. Top, left and right taskbars: the panel is not on the taskbar's side of
 *    the work area, 8 px in, or leaves the work area.
 * 6. Overflow: an icon in the flyout (bounds inside the work area) or with no
 *    bounds at all (0x0) is centred on a meaningless point instead of being
 *    anchored to the taskbar's corner (bottom right for a bottom taskbar).
 * 7. Auto-hidden taskbar (work area = display bounds): no edge is found and
 *    the panel falls back to 0,0 instead of the display edge nearest the icon.
 * 8. A second monitor with negative coordinates (left of the primary) is
 *    placed relative to 0,0 rather than to its own work area.
 * 9. A panel larger than the work area is placed outside its top left.
 * 10. The blur-then-click reopen: a tray click that arrives just after
 *    the panel hid on blur reopens it; or a click long after reopens nothing;
 *    or the guard fires on darwin/linux, where nothing was reported.
 * 11. Close: on win32 a close while Tars runs quits (killing every agent), a
 *    quit (tray menu, updater, Playwright) is turned into a hide and never
 *    ends, or the explanation is shown more than once.
 * 12. The AppUserModelId differs from package.json build.appId, so toasts
 *    are attributed to nothing and never shown.
 * And Linux (2.0.4, parity P2; the Audit's G6 and G4):
 * 13. linux keeps Electron's default menu bar (Alt shows it, and its Ctrl+W,
 *    Ctrl+R and Ctrl+Shift+I act over every page, the terminals included), or
 *    its tray has no menu: under AppIndicator a tray click is never sent, so
 *    the menu is the only way to show or quit Tars from the tray.
 * 14. linux closes while a tray is shown, so the agents end with the window,
 *    unlike on Windows; or hides while none is (a GNOME without the
 *    AppIndicator extension), so Tars runs with no window and nothing on
 *    screen to bring it back but a second launch; or a quit is turned into a
 *    hide.
 * 15. darwin changes at all: its close, its menu, its tray.
 */

const WIN = 'win32' as const;
const PANEL = { width: 800, height: 540 };

/** 2560x1440 at 100 %, bottom taskbar 48 px: the measured machine. */
const BOTTOM = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
};

describe('title bar', () => {
  it('darwin and linux keep hiddenInset and get no overlay', () => {
    for (const p of ['darwin', 'linux'] as const) {
      expect(titleBarOptions(p)).toEqual({ titleBarStyle: 'hiddenInset' });
    }
  });

  it('win32 hides the frame and draws a 32 px overlay in the dark launch colours', () => {
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(32);
    expect(titleBarOptions(WIN)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#121212', symbolColor: '#F5F4F2', height: 32 },
    });
  });

  it('accepts two #rrggbb colours and nothing else', () => {
    expect(parseTitleBarOverlay({ color: '#FAF9F7', symbolColor: '#1e1e1e' }))
      .toEqual({ color: '#FAF9F7', symbolColor: '#1e1e1e' });
    expect(parseTitleBarOverlay({ color: ' #121212 ', symbolColor: '#F5F4F2' }))
      .toEqual({ color: '#121212', symbolColor: '#F5F4F2' });
    for (const bad of [
      null, undefined, 'x', 42, {}, { color: '#121212' },
      { color: 'red', symbolColor: '#FFFFFF' },
      { color: 'rgb(1,2,3)', symbolColor: '#FFFFFF' },
      { color: '#12121', symbolColor: '#FFFFFF' },
      { color: '#1212121', symbolColor: '#FFFFFF' },
      { color: '#121212;x', symbolColor: '#FFFFFF' },
      { color: { toString: () => '#121212' }, symbolColor: '#FFFFFF' },
    ]) {
      expect(parseTitleBarOverlay(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the Windows shell switches', () => {
  it('are on for win32 only', () => {
    expect(isWindowsShell('win32')).toBe(true);
    expect(isWindowsShell('darwin')).toBe(false);
    expect(isWindowsShell('linux')).toBe(false);
  });

  it('names the app as package.json does, so a toast has an owner', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(pkg.build.appId);
  });
});

describe('close', () => {
  it('15. darwin closes as it always has, tray or not', () => {
    for (const trayShown of [undefined, false, true]) {
      expect(closeAction({ platform: 'darwin', quitting: false, explained: false, trayShown })).toBe('close');
      expect(closeAction({ platform: 'darwin', quitting: false, explained: true, trayShown })).toBe('close');
      expect(closeAction({ platform: 'darwin', quitting: true, explained: true, trayShown })).toBe('close');
    }
  });

  it('14. linux hides to a tray that is shown, explains once, lets a quit through, and closes when no tray is shown', () => {
    expect(closeAction({ platform: 'linux', quitting: false, explained: false, trayShown: true })).toBe('explain');
    expect(closeAction({ platform: 'linux', quitting: false, explained: true, trayShown: true })).toBe('hide');
    expect(closeAction({ platform: 'linux', quitting: true, explained: true, trayShown: true })).toBe('close');
    for (const trayShown of [undefined, false]) {
      expect(closeAction({ platform: 'linux', quitting: false, explained: true, trayShown })).toBe('close');
      expect(closeAction({ platform: 'linux', quitting: false, explained: false, trayShown })).toBe('close');
    }
  });

  it('13. no application menu, and a tray menu, on win32 and linux; darwin keeps both as they are', () => {
    expect([removesApplicationMenu('win32'), removesApplicationMenu('linux'), removesApplicationMenu('darwin')]).toEqual([true, true, false]);
    expect([hasTrayMenu('win32'), hasTrayMenu('linux'), hasTrayMenu('darwin')]).toEqual([true, true, false]);
  });

  it('win32 hides while Tars runs, explains once, and lets a quit through', () => {
    expect(closeAction({ platform: WIN, quitting: false, explained: false })).toBe('explain');
    expect(closeAction({ platform: WIN, quitting: false, explained: true })).toBe('hide');
    expect(closeAction({ platform: WIN, quitting: true, explained: false })).toBe('close');
    expect(closeAction({ platform: WIN, quitting: true, explained: true })).toBe('close');
  });
});

describe('taskbar edge', () => {
  it('reads the side the work area gave up', () => {
    expect(taskbarEdge(BOTTOM, { x: 2300, y: 1416 })).toBe('bottom');
    expect(taskbarEdge({ bounds: BOTTOM.bounds, workArea: { x: 0, y: 48, width: 2560, height: 1392 } }, { x: 2300, y: 20 })).toBe('top');
    expect(taskbarEdge({ bounds: BOTTOM.bounds, workArea: { x: 62, y: 0, width: 2498, height: 1440 } }, { x: 30, y: 1300 })).toBe('left');
    expect(taskbarEdge({ bounds: BOTTOM.bounds, workArea: { x: 0, y: 0, width: 2498, height: 1440 } }, { x: 2530, y: 1300 })).toBe('right');
  });

  it('falls back to the display edge nearest the icon when the taskbar auto-hides', () => {
    const full = { bounds: BOTTOM.bounds, workArea: BOTTOM.bounds };
    expect(taskbarEdge(full, { x: 2300, y: 1430 })).toBe('bottom');
    expect(taskbarEdge(full, { x: 2300, y: 5 })).toBe('top');
    expect(taskbarEdge(full, { x: 3, y: 700 })).toBe('left');
    expect(taskbarEdge(full, { x: 2555, y: 700 })).toBe('right');
  });
});

describe('tray panel position', () => {
  const M = TRAY_PANEL_MARGIN;

  it('bottom taskbar: 8 px above the work area, centred on the icon', () => {
    // An icon beside the clock.
    const tray = { x: 2200, y: 1396, width: 40, height: 40 };
    const p = trayPanelPosition({ trayBounds: tray, display: BOTTOM, panel: PANEL });
    expect(M).toBe(8);
    expect(p.y).toBe(1392 - 540 - 8);
    expect(p.y + PANEL.height).toBeLessThanOrEqual(BOTTOM.workArea.height);
    expect(p.x).toBe(2560 - 800 - 8); // centred at 1820 would overflow the right edge: clamped
  });

  it('bottom taskbar, the measured chevron (2286,1392 32x48): visible, above the taskbar', () => {
    const p = trayPanelPosition({ trayBounds: { x: 2286, y: 1392, width: 32, height: 48 }, display: BOTTOM, panel: PANEL });
    expect(p).toEqual({ x: 2560 - 800 - 8, y: 1392 - 540 - 8 });
  });

  it('bottom taskbar, icon near the middle: centred on it', () => {
    const p = trayPanelPosition({ trayBounds: { x: 1260, y: 1396, width: 40, height: 40 }, display: BOTTOM, panel: PANEL });
    expect(p).toEqual({ x: 1280 - 400, y: 844 });
  });

  it('bottom taskbar, icon at the far left: clamped 8 px inside', () => {
    const p = trayPanelPosition({ trayBounds: { x: 4, y: 1396, width: 40, height: 40 }, display: BOTTOM, panel: PANEL });
    expect(p.x).toBe(8);
  });

  it('top taskbar: 8 px below it', () => {
    const display = { bounds: BOTTOM.bounds, workArea: { x: 0, y: 48, width: 2560, height: 1392 } };
    const p = trayPanelPosition({ trayBounds: { x: 1260, y: 4, width: 40, height: 40 }, display, panel: PANEL });
    expect(p).toEqual({ x: 880, y: 48 + 8 });
  });

  it('left taskbar: 8 px right of it, centred vertically on the icon and clamped', () => {
    const display = { bounds: BOTTOM.bounds, workArea: { x: 62, y: 0, width: 2498, height: 1440 } };
    const p = trayPanelPosition({ trayBounds: { x: 11, y: 1380, width: 40, height: 40 }, display, panel: PANEL });
    expect(p).toEqual({ x: 62 + 8, y: 1440 - 540 - 8 });
    const mid = trayPanelPosition({ trayBounds: { x: 11, y: 700, width: 40, height: 40 }, display, panel: PANEL });
    expect(mid).toEqual({ x: 70, y: 720 - 270 });
  });

  it('right taskbar: 8 px left of it', () => {
    const display = { bounds: BOTTOM.bounds, workArea: { x: 0, y: 0, width: 2498, height: 1440 } };
    const p = trayPanelPosition({ trayBounds: { x: 2509, y: 700, width: 40, height: 40 }, display, panel: PANEL });
    expect(p).toEqual({ x: 2498 - 800 - 8, y: 450 });
  });

  it('an icon in the overflow flyout is anchored to the taskbar corner', () => {
    // The flyout opens above the taskbar, inside the work area; centred on
    // the icon, the panel would sit at x = 616.
    const p = trayPanelPosition({ trayBounds: { x: 1000, y: 1300, width: 32, height: 32 }, display: BOTTOM, panel: PANEL });
    expect(p).toEqual({ x: 2560 - 800 - 8, y: 1392 - 540 - 8 });
  });

  it('no bounds at all: the taskbar corner of the cursor display', () => {
    const p = trayPanelPosition({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, display: BOTTOM, panel: PANEL, cursor: { x: 2300, y: 1420 } });
    expect(p).toEqual({ x: 2560 - 800 - 8, y: 1392 - 540 - 8 });
    const left = { bounds: BOTTOM.bounds, workArea: { x: 62, y: 0, width: 2498, height: 1440 } };
    expect(trayPanelPosition({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, display: left, panel: PANEL }))
      .toEqual({ x: 70, y: 1440 - 540 - 8 });
  });

  it('auto-hidden bottom taskbar: above the bottom edge', () => {
    const full = { bounds: BOTTOM.bounds, workArea: BOTTOM.bounds };
    const p = trayPanelPosition({ trayBounds: { x: 1260, y: 1436, width: 40, height: 4 }, display: full, panel: PANEL });
    expect(p).toEqual({ x: 880, y: 1440 - 540 - 8 });
  });

  it('a monitor left of the primary, negative coordinates', () => {
    const display = {
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 0, width: 1920, height: 1032 },
    };
    const p = trayPanelPosition({ trayBounds: { x: -100, y: 1036, width: 40, height: 40 }, display, panel: PANEL });
    expect(p).toEqual({ x: -800 - 8, y: 1032 - 540 - 8 });
  });

  it('a panel larger than the work area stays at its top left inset', () => {
    const small = { bounds: { x: 0, y: 0, width: 700, height: 500 }, workArea: { x: 0, y: 0, width: 700, height: 452 } };
    const p = trayPanelPosition({ trayBounds: { x: 600, y: 456, width: 40, height: 40 }, display: small, panel: PANEL });
    expect(p).toEqual({ x: 8, y: 8 });
  });

  it('returns whole pixels', () => {
    const p = trayPanelPosition({ trayBounds: { x: 1261, y: 1396, width: 33, height: 40 }, display: BOTTOM, panel: { width: 801, height: 541 } });
    expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
  });
});

describe('the click that closed the panel', () => {
  it('win32: a tray click right after a blur hide is the closing click', () => {
    expect(isClickThatClosedPanel(WIN, 10_100, 10_000)).toBe(true);
    expect(isClickThatClosedPanel(WIN, 10_000, 10_000)).toBe(true);
  });

  it('win32: a later click, or no blur yet, opens the panel', () => {
    expect(isClickThatClosedPanel(WIN, 11_000, 10_000)).toBe(false);
    expect(isClickThatClosedPanel(WIN, 10_100, null)).toBe(false);
  });

  it('darwin and linux never swallow a click', () => {
    expect(isClickThatClosedPanel('darwin', 10_100, 10_000)).toBe(false);
    expect(isClickThatClosedPanel('linux', 10_100, 10_000)).toBe(false);
  });
});
