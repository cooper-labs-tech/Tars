import { describe, it, expect } from 'vitest';

import { externalUrlToOpen } from '../../../electron/utils/external-url';

/**
 * The only URLs Tars hands to the system's browser (shell.openExternal).
 *
 * A link in a terminal is text an agent, a command or a web page printed:
 * untrusted. shell.openExternal runs whatever the system maps a scheme to, so
 * anything but a web page could open a file or start a program.
 *
 * How it fails, written before the code (2026-10-14):
 * 1. An http or https link (the PR link of the bug report) is refused.
 * 2. `file:`, `javascript:`, `data:`, `vbscript:` or an app's own scheme
 *    (`ms-settings:`, `search-ms:`, `tars:`) is let through.
 * 3. A UNC path or a Windows path, with or without `file:`, is let through:
 *    opening `\\host\share` sends the account's NTLM hash to that host.
 * 4. The scheme is compared case-sensitively (`HTTPS:` refused, or
 *    `JavaScript:` let through).
 * 5. A string that is not a URL, an empty one, or something that is not a
 *    string (the IPC carries whatever the renderer sends) throws, or is let
 *    through.
 * 6. Leading or trailing spaces, or a tab or newline inside, turn a refused
 *    URL into an accepted one or the reverse: the URL handed on is not the
 *    one checked.
 * 7. An http(s) URL with no host is let through.
 */

describe('externalUrlToOpen', () => {
  it('lets an http or https link through, as the browser would read it (1)', () => {
    expect(externalUrlToOpen('https://github.com/cooper-labs-tech/ward/pull/21')).toBe('https://github.com/cooper-labs-tech/ward/pull/21');
    expect(externalUrlToOpen('http://localhost:3000/a?b=c#d')).toBe('http://localhost:3000/a?b=c#d');
  });

  it('refuses every other scheme (2)', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'ms-settings:privacy',
      'search-ms:query=x',
      'tars://open',
      'mailto:a@b.c',
      'ftp://example.com/x',
    ]) expect(externalUrlToOpen(url), url).toBeNull();
  });

  it('refuses a UNC or Windows path, with or without file: (3)', () => {
    for (const url of ['\\\\host\\share\\x', '//host/share/x', 'file://host/share/x', 'C:\\Windows\\System32\\calc.exe', 'C:/x']) {
      expect(externalUrlToOpen(url), url).toBeNull();
    }
  });

  it('reads the scheme whatever its case (4)', () => {
    expect(externalUrlToOpen('HTTPS://Example.com/Path')).toBe('https://example.com/Path');
    expect(externalUrlToOpen('JavaScript:alert(1)')).toBeNull();
    expect(externalUrlToOpen('FILE:///etc/passwd')).toBeNull();
  });

  it('refuses what is not a URL, without throwing (5)', () => {
    for (const url of ['', '   ', 'not a url', 'github.com/x', undefined, null, 42, {}, ['https://a.b']]) {
      expect(externalUrlToOpen(url), String(url)).toBeNull();
    }
  });

  it('hands on the URL it checked, spaces and control characters dealt with as the browser would (6)', () => {
    expect(externalUrlToOpen('  https://example.com/x  ')).toBe('https://example.com/x');
    expect(externalUrlToOpen('java\tscript:alert(1)')).toBeNull();
    expect(externalUrlToOpen('https://exa\nmple.com/')).toBe('https://example.com/');
    expect(externalUrlToOpen(' javascript:alert(1)')).toBeNull();
  });

  it('refuses an http(s) URL with no host (7)', () => {
    expect(externalUrlToOpen('https://')).toBeNull();
    expect(externalUrlToOpen('http:///x')).not.toBe('http:///x');
  });
});
