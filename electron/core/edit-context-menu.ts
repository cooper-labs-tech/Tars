import { BrowserWindow, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';

/**
 * The right-click menu of text, on every platform. Electron shows none unless
 * the app builds one on the webContents' `context-menu` event, and Tars built
 * none: a right click in a field (Settings > Hermes, say) offered no Paste. On
 * Windows first, which has no Edit menu to fall back on (desktop-lifecycle.ts),
 * then on macOS and Linux too (the maintainer's parity rule of 2026-10-16).
 * Electron's roles act on the focused field and carry the system's own labels
 * and accelerators.
 *
 * - An editable field: Cut, Copy, Paste, Select All, each enabled as Chromium
 *   says it can act (editFlags).
 * - Page text with a selection: Copy.
 * - Anything else: no menu, as before. A page that shows its own menu (the
 *   terminal panel headers) prevents the default, and Electron then emits no
 *   event at all.
 */
export function editMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>,
): MenuItemConstructorOptions[] {
  const f = params.editFlags;
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: f.canCut },
      { role: 'copy', enabled: f.canCopy },
      { role: 'paste', enabled: f.canPaste },
      { role: 'selectAll', enabled: f.canSelectAll },
    ];
  }
  if (params.selectionText.trim()) return [{ role: 'copy', enabled: f.canCopy }];
  return [];
}

/** Wires the menu to one window's contents, once, when the window is made, on every platform. */
export function installEditContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const template = editMenuTemplate(params);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
}
