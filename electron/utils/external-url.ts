/**
 * A URL the app may hand to the system's browser (shell.openExternal): https only (2.0.7). What the window follows
 * as a link (will-navigate, core/window-manager.ts) and what it asks for itself (app:openExternal, the update's
 * download page) both handed any URL on. A link the page opens in a new window keeps its own rule, http and https
 * (setWindowOpenHandler): the Vault's attachments are served on the loopback over http.
 */
export function mayOpenExternally(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
