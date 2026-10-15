import { describe, it, expect } from 'vitest';
import * as path from 'path';

/**
 * The `app://` handler served any file on disk.
 *
 * `new URL()` collapses a literal `..` in the pathname but leaves `%2f` alone,
 * and the handler decoded AFTER parsing, so `..%2f..%2f` came back out as a
 * real traversal that `path.join` walked straight through. The scheme is
 * registered secure and CORS-enabled, so it is same-origin with the app's own
 * page, and a markdown image is fetched without a click and never passes
 * through `isSafeUrl`. A vault note, which any agent can write, holding
 *
 *     ![](app://-/a/..%2f..%2f..%2f.dorothy%2fapp-settings.json)
 *
 * read every provider API key the moment the note was opened.
 *
 * These tests pin the two halves: that the URL really does decode into a
 * traversal (so the fix is not guarding against nothing), and that the
 * containment rule rejects it.
 */

/** The rule the handler applies, mirrored: see isUnder in window-manager.ts. */
function isUnder(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

/** What the handler does to a request URL before it touches the filesystem. */
function resolveRequest(base: string, url: string): { filePath: string; allowed: boolean } {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(url).pathname);
  } catch {
    urlPath = '/';
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const relativePath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  const filePath = path.join(base, relativePath);
  return { filePath, allowed: isUnder(base, filePath) };
}

const BASE = '/Applications/Tars.app/Contents/Resources/app/out';

describe('app:// path containment', () => {
  it('the encoded traversal really does decode into one', () => {
    // Guarding the guard: if URL ever started collapsing %2f, this test would
    // fail and the fix below would be protecting against nothing.
    const decoded = decodeURIComponent(new URL('app://-/a/..%2f..%2fsecret').pathname);
    expect(decoded).toBe('/a/../../secret');
  });

  it('refuses the reported vault-note vector', () => {
    const { allowed } = resolveRequest(
      BASE,
      'app://-/a/..%2f..%2f..%2f..%2f..%2fUsers%2fyou%2f.dorothy%2fapp-settings.json',
    );
    expect(allowed).toBe(false);
  });

  it('refuses a plain encoded escape, however many levels', () => {
    for (const depth of [1, 3, 8]) {
      const up = Array.from({ length: depth }, () => '..%2f').join('');
      expect(resolveRequest(BASE, `app://-/${up}etc%2fpasswd`).allowed).toBe(false);
    }
  });

  it('refuses a double-encoded escape', () => {
    // %252f decodes to %2f, not to a separator, so this one must simply not
    // resolve to a file outside the bundle either.
    expect(resolveRequest(BASE, 'app://-/a/..%252f..%252fsecret').allowed).toBe(true);
    // ...and it stays inside, which is the property that matters.
    // BASE in the platform's own spelling, as path.join writes the file path.
    expect(resolveRequest(BASE, 'app://-/a/..%252f..%252fsecret').filePath.startsWith(path.normalize(BASE))).toBe(true);
  });

  it('refuses the Windows spellings of an escape, or keeps them inside the bundle', () => {
    const inside = (filePath: string) => filePath.startsWith(path.normalize(BASE) + path.sep);
    // `%5c` is `\`: a separator on Windows, where it climbs out and is refused;
    // an ordinary character of a file name elsewhere, where it stays inside.
    const climb = resolveRequest(BASE, 'app://-/a/..%5c..%5c..%5c..%5c..%5cUsers%5cdemo%5c.dorothy%5capp-settings.json');
    if (process.platform === 'win32') expect(climb.allowed).toBe(false);
    else expect(inside(climb.filePath)).toBe(true);
    // A drive and a UNC name are joined under the bundle, never taken as roots.
    for (const url of ['app://-/C:%5cWindows%5cwin.ini', 'app://-/%5c%5clocalhost%5cC$%5csecret']) {
      const { filePath, allowed } = resolveRequest(BASE, url);
      expect(allowed, url).toBe(true);
      expect(inside(filePath), `${url} resolved to ${filePath}`).toBe(true);
    }
  });

  it('refuses a sibling directory that merely shares the prefix', () => {
    // `/…/out-evil` must not pass as being under `/…/out`.
    expect(isUnder(BASE, `${BASE}-evil/index.html`)).toBe(false);
  });

  it('still serves the app itself', () => {
    expect(resolveRequest(BASE, 'app://-/index.html').allowed).toBe(true);
    expect(resolveRequest(BASE, 'app://-/_next/static/chunk.js').allowed).toBe(true);
    expect(resolveRequest(BASE, 'app://-/').filePath).toBe(path.join(BASE, 'index.html'));
  });

  it('still serves a route carrying a query string', () => {
    // The parse (rather than a slice) exists so this link works at all: the
    // "Sign in to Hermes" action from Kanban and Schedules uses it.
    const { filePath, allowed } = resolveRequest(BASE, 'app://-/settings?section=hermes');
    expect(allowed).toBe(true);
    expect(filePath).toBe(path.join(BASE, 'settings'));
  });

  it('still serves a directory route as its index.html', () => {
    expect(resolveRequest(BASE, 'app://-/agents/').filePath).toBe(path.join(BASE, 'agents', 'index.html'));
  });
});
