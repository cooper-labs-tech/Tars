import { createXtermTheme, getTerminalFontFamily, getTerminalMode } from '@/lib/terminal-theme';

// Terminal themes live in src/lib/terminal-theme.ts, the single xterm source (R9).
// The exports below are migration shims for the call sites that still read a theme
// off this module; delete them once those imports are gone.

/** @deprecated shim: import `createXtermTheme` from `@/lib/terminal-theme`. */
export const TERMINAL_THEME = createXtermTheme('dark');

/** @deprecated shim: import `createXtermTheme` from `@/lib/terminal-theme`. */
export const TERMINAL_THEME_LIGHT = createXtermTheme('light');

/** @deprecated shim: import `createXtermTheme` from `@/lib/terminal-theme`. */
export const QUICK_TERMINAL_THEME = createXtermTheme();

/** @deprecated shim: import `createXtermTheme` from `@/lib/terminal-theme`. */
export function getTerminalTheme(theme: 'dark' | 'light' = getTerminalMode()) {
  return createXtermTheme(theme);
}

// Terminal configuration
export const TERMINAL_CONFIG = {
  fontSize: 13,
  /** @deprecated shim: import `getTerminalFontFamily` from `@/lib/terminal-theme`. */
  get fontFamily() {
    return getTerminalFontFamily();
  },
  cursorBlink: true,
  cursorStyle: 'bar' as const,
  // A Dashboard panel's history, xterm's scrollback: 5,000 lines (JeanBrasse's
  // choice 9 of 05/10). A full panel weighed 32.6 MB at 10,000 lines (RD-RAM).
  // The transcript keeps everything; the terminal's mirror in main is the
  // Backend's.
  scrollback: 5000,
  convertEol: true,
};

export const QUICK_TERMINAL_CONFIG = {
  ...TERMINAL_CONFIG,
  fontSize: 12,
  scrollback: 5000,
};

// Language mappings for syntax highlighting
export const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  prisma: 'graphql',
};

// Get language from file extension
export const getLanguageFromPath = (filePath: string): string => {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_MAP[ext] || 'typescript';
};

// File tree types
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  isExpanded?: boolean;
}

// Git data types
export interface GitData {
  branch: string;
  status: Array<{ status: string; file: string }>;
  diff: string;
  commits: Array<{ hash: string; message: string; author: string; date: string }>;
}

// Initial git data state
export const INITIAL_GIT_DATA: GitData = {
  branch: '',
  status: [],
  diff: '',
  commits: [],
};
