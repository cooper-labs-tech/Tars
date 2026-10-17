import { describe, it, expect, vi } from 'vitest';

/**
 * The right-click menu of a text field, on every platform (on Windows first,
 * then on macOS and Linux by the maintainer's parity rule of 2026-10-16, the
 * Audit's G3). Electron shows none unless
 * the app builds one on the webContents' `context-menu` event, and Tars built
 * none: a right click in any field of the app offered no Paste (measured in
 * Settings > Hermes), and a Windows build has no Edit menu either
 * (desktop-lifecycle.ts).
 *
 * How it can fail, written before the code:
 * 1. an editable field gets no menu, or one without Cut, Copy, Paste and
 *    Select All, in that order;
 * 2. an item is enabled when Chromium says it cannot act (Paste with nothing on
 *    the clipboard, Cut or Copy with nothing selected), or disabled when it can;
 * 3. the items are not Electron's roles, so they do nothing, or are not
 *    localised and wired to the focused field as roles are;
 * 4. a right click on page text with a selection offers no Copy;
 * 5. a right click on page text with no selection, or on a selection of
 *    whitespace only, pops an empty or useless menu instead of none;
 * 6. a selection in page text offers Cut or Paste, which cannot apply there;
 * 7. installed, a right click pops nothing, pops over another window, or pops
 *    when there is nothing to offer;
 * 8. darwin/linux get no menu: a right click in a field offers no Paste there
 *    either (Electron shows none on any platform).
 */

const popups = vi.hoisted(() => [] as { items: { role?: string; enabled: boolean }[]; window: unknown }[]);
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: { role?: string; enabled?: boolean }[]) => ({
      items: template.map(t => ({ role: t.role, enabled: t.enabled !== false })),
      popup(this: { items: { role?: string; enabled: boolean }[] }, opts: { window?: unknown }) { popups.push({ items: this.items, window: opts?.window }); },
    }),
  },
  BrowserWindow: { fromWebContents: (wc: { owner?: unknown }) => wc.owner ?? null },
}));

import { editMenuTemplate, installEditContextMenu } from '../../../electron/core/edit-context-menu';

const HOST = process.platform;
const FLAGS = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false };
const params = (p: { isEditable?: boolean; selectionText?: string; editFlags?: Partial<typeof FLAGS> }) => ({
  isEditable: p.isEditable ?? false,
  selectionText: p.selectionText ?? '',
  editFlags: { ...FLAGS, ...p.editFlags },
});

describe('the menu a right click offers', () => {
  it('1, 3. an editable field: Cut, Copy, Paste, Select All, as roles, in that order', () => {
    const t = editMenuTemplate(params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }));
    expect(t.map(i => i.role)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(t.every(i => i.enabled)).toBe(true);
  });

  it('2. each item enabled exactly as Chromium says it can act', () => {
    // An empty field, text on the clipboard: only Paste.
    const empty = editMenuTemplate(params({ isEditable: true, editFlags: { canPaste: true } }));
    expect(empty.map(i => [i.role, i.enabled])).toEqual([['cut', false], ['copy', false], ['paste', true], ['selectAll', false]]);
    // A selection, nothing to paste.
    const selected = editMenuTemplate(params({ isEditable: true, selectionText: 'abc', editFlags: { canCut: true, canCopy: true, canSelectAll: true } }));
    expect(selected.map(i => [i.role, i.enabled])).toEqual([['cut', true], ['copy', true], ['paste', false], ['selectAll', true]]);
  });

  it('4, 6. page text with a selection: Copy alone', () => {
    const t = editMenuTemplate(params({ selectionText: 'http://127.0.0.1:9119', editFlags: { canCopy: true } }));
    expect(t.map(i => [i.role, i.enabled])).toEqual([['copy', true]]);
  });

  it('5. page text with no selection, or only whitespace: no menu', () => {
    expect(editMenuTemplate(params({}))).toEqual([]);
    expect(editMenuTemplate(params({ selectionText: ' \n\t', editFlags: { canCopy: true } }))).toEqual([]);
  });
});

describe('installed on a window', () => {
  function fakeContents(owner: unknown) {
    let handler: ((e: unknown, p: unknown) => void) | undefined;
    const events: string[] = [];
    return {
      owner,
      events,
      on: (event: string, fn: (e: unknown, p: unknown) => void) => {
        events.push(event);
        if (event === 'context-menu') handler = fn;
      },
      rightClick: (p: unknown) => handler?.({}, p),
    };
  }

  it('7. pops the menu over its own window, and nothing when there is nothing to offer', () => {
    popups.length = 0;
    const win = { id: 'main' };
    const wc = fakeContents(win);
    installEditContextMenu(wc as unknown as Electron.WebContents);

    wc.rightClick(params({}));
    expect(popups).toHaveLength(0);

    wc.rightClick(params({ isEditable: true, editFlags: { canPaste: true } }));
    expect(popups).toHaveLength(1);
    expect(popups[0].window).toBe(win);
    expect(popups[0].items.map(i => [i.role, i.enabled])).toEqual([['cut', false], ['copy', false], ['paste', true], ['selectAll', false]]);
  });

  it.each(['darwin', 'linux', 'win32'] as const)('8. %s: the same menu over its own window', (platform) => {
    popups.length = 0;
    const win = { id: 'main' };
    const wc = fakeContents(win);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      installEditContextMenu(wc as unknown as Electron.WebContents);
    } finally {
      Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
    }

    wc.rightClick(params({ isEditable: true, editFlags: { canPaste: true } }));
    expect(popups).toHaveLength(1);
    expect(popups[0].window).toBe(win);
    expect(popups[0].items.map(i => i.role)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  });
});
