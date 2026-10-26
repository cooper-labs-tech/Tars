import type { ILinkHandler, Terminal } from 'xterm';

/** Hands a clicked link to the main process, which opens http and https only (electron/utils/external-url.ts). */
function openLink(url: string): void {
  void window.electronAPI?.updates?.openExternal(url);
}

/**
 * Click handler for OSC 8 hyperlinks (what Claude Code prints around a URL).
 *
 * xterm's own default asks "this link could be dangerous", then calls
 * `window.open('')` and sets its location afterwards. The main process denies
 * every `window.open`, so the user got the warning and then nothing. A click
 * now goes straight to the default browser through the main process, which
 * allows http and https only and drops any other scheme.
 */
export const terminalLinkHandler: ILinkHandler = {
  allowNonHttpProtocols: false,
  activate(_event, text) {
    openLink(text);
  },
};

/**
 * Makes the http and https URLs a program prints as plain text clickable too
 * (a dev server's address, the link `git push` gives), through the same main
 * process check. Loaded on demand, and only where there is a window: the
 * addon's bundle reads `self` when it is imported, which neither the server
 * render nor a test running a terminal hook under Node has (an unhandled
 * rejection there). A terminal disposed before it arrives gets nothing.
 */
export async function addWebLinks(term: Terminal): Promise<void> {
  if (typeof self === 'undefined') return;
  const { WebLinksAddon } = await import('xterm-addon-web-links');
  try {
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
  } catch {
    // Disposed meanwhile: nothing left to make clickable.
  }
}
