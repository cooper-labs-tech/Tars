import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';

/**
 * Whether a folder may be marked trusted (utils/trust-too-much.ts): Claude Code's hasTrustDialogAccepted trusts a
 * folder and everything below it, and codex's trust_level is refused on the same folders.
 *
 * The ways it fails:
 * 1. The home folder, or one above it, trusted for being spelled otherwise than the home folder's own spelling. On
 *    Windows a letter in another case (`c:\users\me`), `/` for `\`, a trailing separator, a `\\?\` prefix: compared as
 *    strings, they slipped past (the Audit's L2 on #465).
 * 2. A drive's or a share's root trusted on Windows for not being `/`.
 * 3. A relative path trusted: it names whatever folder the app happens to run in, a drive-relative `C:demo` included.
 * 4. A project folder below the home folder refused, on any system: then no agent's folder is ever trusted. On macOS
 *    and Linux, the comparisons as they were.
 */

import { trustsTooMuch } from '../../../electron/utils/trust-too-much';

describe('on Windows', () => {
  const home = 'C:\\Users\\me';

  it('1. the home folder, and above it, in any spelling', () => {
    for (const p of ['C:\\Users\\me', 'c:\\users\\me', 'C:/Users/me', 'C:\\Users\\me\\', '\\\\?\\C:\\Users\\me', 'C:\\Users', 'c:\\USERS']) {
      expect(trustsTooMuch(p, 'win32', home), p).toBe(true);
    }
  });

  it("2. a drive's root, or a share's", () => {
    for (const p of ['C:\\', 'c:/', 'D:\\', '\\\\srv\\share']) expect(trustsTooMuch(p, 'win32', home), p).toBe(true);
  });

  it('3. a relative path', () => {
    for (const p of ['demo', 'C:demo', '.\\demo']) expect(trustsTooMuch(p, 'win32', home), p).toBe(true);
  });

  it('4. a project below the home folder, or on another drive, is fine', () => {
    for (const p of ['C:\\Users\\me\\projects\\demo', 'c:\\users\\me\\demo', 'D:\\work\\demo', '\\\\srv\\share\\demo']) {
      expect(trustsTooMuch(p, 'win32', home), p).toBe(false);
    }
  });
});

describe('on macOS and Linux', () => {
  const home = '/home/me';

  it('1, 2, 3. the home folder, above it, the root and a relative path', () => {
    for (const p of ['/home/me', '/home/me/', '/home', '/', 'demo', './demo']) expect(trustsTooMuch(p, 'linux', home), p).toBe(true);
  });

  it('4. a project below the home folder, or elsewhere, is fine', () => {
    for (const p of ['/home/me/projects/demo', '/srv/demo', '/home/mel']) expect(trustsTooMuch(p, 'linux', home), p).toBe(false);
  });
});
