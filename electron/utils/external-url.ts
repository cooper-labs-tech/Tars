/**
 * The only URLs Tars hands to the operating system's browser.
 *
 * `shell.openExternal` runs whatever the OS maps the scheme to: `file:` opens
 * a path, `javascript:` and custom protocol handlers launch programs. A link
 * printed by an agent or a web page is untrusted text, so the scheme is
 * checked here, in the main process, and not trusted from the renderer.
 */
export function externalUrlToOpen(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}
