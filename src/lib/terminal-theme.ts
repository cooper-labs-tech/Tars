'use client';

import { useEffect, useState } from 'react';
import type { ILinkHandler, ITheme } from 'xterm';
import { terminalLinkHandler } from './terminal-links';

/**
 * Single source of truth for every xterm surface in the app.
 *
 * xterm needs literal colours (it cannot read `var(--token)`), so this module
 * resolves the design tokens off `document.documentElement` at call time and
 * hands back a plain `ITheme`. Nothing else in the codebase may hardcode a
 * terminal colour or font (R9).
 */

export type TerminalMode = 'dark' | 'light';

/**
 * Class for the wrapper `<div>` sitting behind an xterm canvas. Those wrappers
 * are painted separately from the canvas; without this they letterbox the
 * terminal in a mismatched colour.
 */
export const TERMINAL_SURFACE_CLASS = 'bg-term-bg';

/** Fallback stack when `--font-mono` cannot be read (SSR, first paint). */
export const TERMINAL_FONT_FAMILY =
  "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** The token values this module needs, resolved for one theme. */
interface TerminalTokens {
  termBg: string;
  foreground: string;
  card: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  textMuted: string;
  textSecondary: string;
}

/**
 * The tokens for one theme, read from the stylesheet.
 *
 * Custom properties inherit, so an element inside `<html class="dark">` sees
 * the dark values whatever class it carries. `globals.css` therefore names the
 * light values on `.light` as well as on `:root`, and this reads them off a
 * probe element carrying the class of the theme asked for. That is what lets
 * the terminal follow its own setting (Settings > Terminal) while the app
 * wears the other theme, without a second copy of the palette here: this file
 * used to mirror ten colours per theme, and two of them had already drifted
 * from the tokens (`--status-idle`, both themes).
 *
 * Read once per theme: the stylesheet does not change while the app runs.
 */
const cache = new Map<TerminalMode, TerminalTokens>();

function readTokens(mode: TerminalMode): TerminalTokens | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const cached = cache.get(mode);
  if (cached) return cached;

  const source = getTerminalMode() === mode ? document.documentElement : probeFor(mode);
  const style = getComputedStyle(source);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const tokens: TerminalTokens = {
    termBg: read('--term-bg'),
    foreground: read('--foreground'),
    card: read('--card'),
    primary: read('--primary'),
    success: read('--success'),
    warning: read('--warning'),
    danger: read('--danger'),
    textMuted: read('--text-muted'),
    textSecondary: read('--text-secondary'),
  };
  if (source !== document.documentElement) source.remove();

  // A stylesheet that has not landed yet answers with empty strings. Nothing is
  // cached then, so the next call reads again rather than freezing the miss.
  if (Object.values(tokens).some(value => !value)) return null;
  cache.set(mode, tokens);
  return tokens;
}

/** An element that wears the theme asked for, off-screen and for one read. */
function probeFor(mode: TerminalMode): HTMLElement {
  const probe = document.createElement('div');
  probe.className = mode;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  return probe;
}

/** The theme the document is wearing right now. */
export function getTerminalMode(): TerminalMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Append an 8-bit alpha to a 6-digit hex; leave any other notation alone. */
function withAlpha(color: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color;
}

/**
 * Build the xterm theme for one mode.
 *
 * @param mode - defaults to the theme the document is currently wearing.
 */
export function createXtermTheme(mode: TerminalMode = getTerminalMode()): ITheme {
  const t = readTokens(mode);
  // No document, or a stylesheet that has not landed: nothing paints a terminal
  // there, and xterm's own defaults stand in until the theme can be read.
  if (!t) return {};
  const isDark = mode === 'dark';

  return {
    background: t.termBg,
    foreground: t.foreground,
    // Cursor is the brand accent, never the retired teal.
    cursor: t.primary,
    cursorAccent: t.termBg,
    selectionBackground: withAlpha(t.primary, '33'),

    // The palette carries four hues (accent + three statuses), so the 16-colour
    // ANSI ramp folds onto them rather than onto Tailwind stock colours.
    black: isDark ? t.termBg : t.foreground,
    red: t.danger,
    green: t.success,
    yellow: t.warning,
    blue: t.primary,
    magenta: t.primary,
    cyan: t.success,
    white: isDark ? t.foreground : t.termBg,

    brightBlack: t.textMuted,
    brightRed: t.danger,
    brightGreen: t.success,
    brightYellow: t.warning,
    brightBlue: t.primary,
    brightMagenta: t.primary,
    brightCyan: t.success,
    brightWhite: isDark ? t.foreground : t.card,
  };
}

/**
 * Resolved `--font-mono` (Roboto Mono, self-hosted in `layout.tsx`). xterm
 * writes this straight into an inline style, so it must be literal.
 */
export function getTerminalFontFamily(): string {
  if (typeof document === 'undefined') return TERMINAL_FONT_FAMILY;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value || TERMINAL_FONT_FAMILY;
}

/** Theme + font in the shape the `new Terminal({...})` call sites need. */
export function createXtermOptions(mode: TerminalMode = getTerminalMode()): {
  theme: ITheme;
  fontFamily: string;
  linkHandler: ILinkHandler;
} {
  return { theme: createXtermTheme(mode), fontFamily: getTerminalFontFamily(), linkHandler: terminalLinkHandler };
}

/**
 * The app theme, as an xterm theme, kept in sync with the `dark` class on
 * `documentElement`. Terminals follow light mode instead of staying four black
 * rectangles on a light page.
 */
export function useTerminalTheme(): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => createXtermTheme());

  useEffect(() => {
    // Re-read after mount: the first render may have run without a document.
    setTheme(createXtermTheme());

    const observer = new MutationObserver(() => setTheme(createXtermTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
