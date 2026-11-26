import { describe, it, expect } from 'vitest';

/**
 * What the app hands to the system's browser (2.0.7): a link the window follows (will-navigate,
 * core/window-manager.ts) and the window's own call (app:openExternal). Both handed any URL to shell.openExternal.
 *
 * How it fails, written before the code (2026-11-26):
 *  E1. A URL of any scheme but https is handed on (http included: no caller of these two needs it; a page link opened
 *      in a new window keeps its own rule, http and https).
 *  E2. A text that is no URL is handed on.
 *  E3. Something that is not a string is handed on.
 *  E4. Over-correction: an https URL refused, a GitHub release's download with its query included.
 */

import { mayOpenExternally } from '../../../electron/utils/external-url';

describe('what the app hands to the system\'s browser', () => {
  it('E1. no scheme but https', () => {
    for (const url of ['http://example.org/', 'file:///tmp/notes.txt', 'mailto:someone@example.org', 'ftp://example.org/x', 'tars-x://open', 'data:text/plain,hi']) {
      expect(mayOpenExternally(url), url).toBe(false);
    }
  });

  it('E2. no text that is no URL', () => {
    for (const url of ['', 'example.org', 'https//example.org', '/releases/latest']) expect(mayOpenExternally(url), url).toBe(false);
  });

  it('E3. nothing that is not a string', () => {
    for (const url of [undefined, null, 42, { href: 'https://example.org' }]) expect(mayOpenExternally(url), String(url)).toBe(false);
  });

  it('E4. an https URL', () => {
    for (const url of ['https://github.com/cooper-labs-tech/Tars/releases/latest', 'https://github.com/cooper-labs-tech/Tars/releases/download/v2.0.7/Tars-2.0.7-arm64.dmg?x=1']) {
      expect(mayOpenExternally(url), url).toBe(true);
    }
  });
});
