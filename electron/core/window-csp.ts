import * as crypto from 'crypto';

/**
 * The window's Content Security Policy.
 *
 * The renderer holds the preload's whole bridge: terminals, files, agents. contextIsolation is on and
 * nodeIntegration and webviewTag are off, but a script that reached the page, through markup that lands in
 * the DOM or a module gone bad, would hold that bridge as the app's own code does. The policy is what refuses
 * it: a script runs only if it is a file of the bundle, or one of the inline scripts the bundle's page itself
 * carries, named by its hash. Nothing is loaded from anywhere else, and no plugin, base URL, form target or
 * frame parent is taken.
 *
 * Packaged, the app:// handler serves it as a header on every page, with the SHA-256 of each inline script of
 * that page. Next's static export writes four per page: the theme boot (src/app/layout.tsx), Turbopack's list
 * of chunks, and the two that carry the page's React Server Components payload, which differs from page to
 * page. A nonce needs a server rendering each request, which a static export has not; the hashes of the
 * shipped files hold the same line, and a script added to the page later matches none of them.
 *
 * In development the session sets the same policy on next dev's pages, with three differences, all in what a
 * script may be: inline, through eval, and the page may open next dev's refresh socket. next dev writes its
 * inline scripts per request and refreshes modules through eval, so neither can be named in advance.
 *
 * What each source is there for (measured on the packaged build, see e2e/window-csp.packed.spec.ts):
 * - style-src 'unsafe-inline': the exported pages carry style attributes (React's), xterm and the tray panel
 *   add style elements at run time, and none of those can be hashed. A style runs no script.
 * - img-src data: the stylesheet's own SVG icons; blob: a picture attached in the Chat, previewed before it is
 *   sent; http://127.0.0.1:<port>/api/local-file: the vault's pictures and attachments, which the window
 *   asks as /api/local-file?path=…. The route, not the API's origin: a source's path is matched exactly and
 *   the query is not part of the match, so no other route of the API loads as a picture.
 * - connect-src https://raw.githubusercontent.com: the plugin marketplace's lists (src/lib/plugins-database.ts).
 *   'self' is the page's own route data, which client navigation reads.
 * - manifest-src 'self': the pages link /manifest.json.
 * - Everything the main process fetches (models.dev, GitHub's releases, error reports) is not the page's and
 *   is not listed: the policy binds the page only.
 */

/** The one place a remote host is named: the plugin marketplace's manifests. */
const MARKETPLACE = 'https://raw.githubusercontent.com';

const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HAS_SRC = /(?:^|\s)src\s*=/i;

/**
 * The hash sources of every inline script an HTML page carries, as the browser hashes them: the element's text
 * with its line breaks normalised (the HTML parser reads CR LF and a lone CR as LF), in UTF-8, without
 * attributes. A script with a src is the bundle's file and needs none. A script this reading cannot parse gets
 * a hash that matches nothing: it is refused, never allowed by mistake.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attributes, text] of html.matchAll(SCRIPT_ELEMENT)) {
    if (HAS_SRC.test(attributes)) continue;
    const normalised = text.replace(/\r\n?/g, '\n');
    hashes.add(`'sha256-${crypto.createHash('sha256').update(normalised, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

export interface WindowCspOptions {
  /** The local API's port, whose /api/local-file serves the vault's pictures. Anything but a port is left out. */
  apiPort: number;
  /** Packaged: the page's inline scripts, from inlineScriptHashes. */
  scriptHashes?: string[];
  /** Development: next dev's origin, whose inline scripts, eval and refresh socket the page takes. */
  devOrigin?: string;
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/** next dev's refresh socket, at the dev server's own host and port. */
function devSocket(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' ? `ws://${url.host}` : null;
  } catch {
    return null;
  }
}

/** The policy, as one header value. */
export function windowCsp({ apiPort, scriptHashes = [], devOrigin }: WindowCspOptions): string {
  const dev = devOrigin !== undefined;
  const socket = dev ? devSocket(devOrigin) : null;
  const api = isPort(apiPort) ? [`http://127.0.0.1:${apiPort}/api/local-file`] : [];
  const hashes = scriptHashes.filter((hash) => /^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(hash));
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'none'"]],
    ['script-src', dev ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'", ...new Set(hashes)]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...api]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", MARKETPLACE, ...(socket ? [socket] : [])]],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}
