import { Tray, nativeImage, NativeImage, Menu, app } from 'electron';
import * as path from 'path';
import { toggleTrayPanel, destroyTrayPanel } from './tray-panel-manager';
import { setTrayAttentionCallback } from '../utils/agents-tick';
import { revealMainWindow } from './window-manager';
import { isWindowsShell } from '../platform/desktop-shell';

let tray: Tray | null = null;
let normalIcon: NativeImage | null = null;
let badgeIcon: NativeImage | null = null;
let showingBadge = false;

function resolveIconPath(): string {
  // __dirname is electron/dist/core/ at runtime, resources are at electron/resources/
  // Use the full-color Tars logo instead of a monochrome template
  let iconPath = path.join(__dirname, '..', '..', 'resources', 'trayColor.png');
  // In production, resources are unpacked outside the asar archive
  iconPath = iconPath.replace('app.asar', 'app.asar.unpacked');
  return iconPath;
}

function createBadgeIcon(base: NativeImage): NativeImage {
  let icon2xPath = path.join(__dirname, '..', '..', 'resources', 'trayColor@2x.png');
  icon2xPath = icon2xPath.replace('app.asar', 'app.asar.unpacked');
  const icon2x = nativeImage.createFromPath(icon2xPath);

  const bitmap = icon2x.toBitmap();
  const logicalSize = icon2x.getSize();
  const totalPx = bitmap.length / 4;
  const w = Math.round(Math.sqrt(totalPx * (logicalSize.width / logicalSize.height)));
  const h = totalPx / w;

  const dotR = Math.max(3, Math.round(w * 0.15));
  const dotCx = w - dotR - 1;
  const dotCy = dotR + 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - dotCx;
      const dy = y - dotCy;
      if (dx * dx + dy * dy <= dotR * dotR) {
        const i = (y * w + x) * 4;
        bitmap[i] = 239;     // R (#ef4444)
        bitmap[i + 1] = 68;  // G
        bitmap[i + 2] = 68;  // B
        bitmap[i + 3] = 255; // A
      }
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: w, height: h, scaleFactor: 2.0 });
}

/** A file in electron/resources, outside the asar archive in production. */
function resourcePath(name: string): string {
  return path.join(__dirname, '..', '..', 'resources', name).replace('app.asar', 'app.asar.unpacked');
}

let contextMenu: Menu | null = null;

/**
 * The tray's right-click menu on Windows: the only way to quit once closing
 * the window hides it (desktop-lifecycle.ts). Quit Tars is app.quit(), so
 * before-quit saves the fleet and kills every terminal, as it always has.
 */
export function trayContextMenu(): Menu {
  contextMenu ??= Menu.buildFromTemplate([
    { label: 'Show Tars', click: () => revealMainWindow() },
    { type: 'separator' },
    { label: 'Quit Tars', click: () => app.quit() },
  ]);
  return contextMenu;
}

/**
 * Windows: the mark as a multi-size .ico (16 to 48 px, pixel-snapped, drawn
 * from public/icon.svg), so each DPI gets its own
 * pixels instead of a resampled PNG of the old prompt; the attention badge is
 * the same grid with today's dot, drawn ahead of time into its own .ico.
 */
function initWindowsTray() {
  normalIcon = nativeImage.createFromPath(resourcePath('tray.ico'));
  badgeIcon = nativeImage.createFromPath(resourcePath('tray-attention.ico'));
  tray = new Tray(normalIcon);
  tray.setToolTip('Tars');
  tray.setContextMenu(trayContextMenu());
  tray.on('click', () => {
    if (tray) toggleTrayPanel(tray.getBounds());
  });
  setTrayAttentionCallback(updateTrayAttention);
}

export function initTray() {
  if (isWindowsShell(process.platform)) {
    initWindowsTray();
    return;
  }
  // Use the @2x image with scaleFactor 2.0 so macOS gets full-resolution
  // pixels on retina displays instead of upscaling the tiny 1x image.
  let icon2xPath = path.join(__dirname, '..', '..', 'resources', 'trayColor@2x.png');
  icon2xPath = icon2xPath.replace('app.asar', 'app.asar.unpacked');
  // The mark already sits on transparency with hard corners - no circular
  // mask, the app has no round shapes anywhere else.
  const rawIcon = nativeImage.createFromPath(icon2xPath);
  const icon = nativeImage.createFromBuffer(rawIcon.toPNG(), { scaleFactor: 2.0 });
  icon.setTemplateImage(false);
  normalIcon = icon;

  tray = new Tray(icon);
  tray.setToolTip('Tars');

  tray.on('click', () => {
    if (tray) {
      toggleTrayPanel(tray.getBounds());
    }
  });

  // Register the attention callback so agents-tick can drive badge updates
  setTrayAttentionCallback(updateTrayAttention);
}

export function updateTrayAttention(hasWaiting: boolean): void {
  if (!tray || !normalIcon) return;

  if (hasWaiting && !showingBadge) {
    if (!badgeIcon) {
      badgeIcon = createBadgeIcon(normalIcon);
    }
    // When showing badge, don't use template image so the red dot is visible
    badgeIcon.setTemplateImage(false);
    tray.setImage(badgeIcon);
    showingBadge = true;
  } else if (!hasWaiting && showingBadge) {
    tray.setImage(normalIcon);
    showingBadge = false;
  }
}

/**
 * The tray icon, or null before initTray. Read by the Windows E2E spec
 * (e2e/desktop-shell.win32.spec.ts) for the icon's bounds, which place the
 * tray panel it opens.
 */
export function getTray(): Tray | null {
  return tray;
}

export function rebuildTrayMenu() {
  // No-op: the tray panel is live via IPC, no native menu to rebuild
}

export function destroyTray() {
  destroyTrayPanel();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
