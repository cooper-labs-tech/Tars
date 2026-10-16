import { describe, it, expect } from 'vitest';

import { hookToolsMissing } from '../../../electron/platform/hook-tools-check';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * Whether Tars says, at launch on macOS and Linux, that jq or curl is missing.
 *
 * There the agents' hooks are the .sh scripts of hooks/, which read their JSON
 * with jq and post it with curl. Without jq every hook posts an empty
 * session_id, the API refuses it, no session registers and the status does
 * not move, and nothing said why: the same symptom #358's Node warning answers
 * on Windows (G2 of the parity audit). macOS 13 and 14 ship no jq, and most
 * Linux desktops install neither by default.
 *
 * How it fails, written before the code (2026-10-17):
 * 1. win32: anything said, or a disk access (its hooks run on Node, and
 *    nodeMissing speaks there).
 * 2. darwin/linux: nothing said when jq is not on the PATH the agents get.
 * 3. darwin/linux: nothing said when curl is not.
 * 4. Something said when both are there.
 * 5. A jq in a relative PATH entry, or a folder named jq, counts.
 * 6. A tool that is there is named as missing.
 * 7. What is said names neither what stops working, nor how to install it on
 *    that system (Homebrew on macOS, the package manager on Linux), nor the
 *    restart.
 * 8. The PATH read is the main process's own, not the one the agents'
 *    terminals get (buildFullPath, as agent-manager builds theirs): a Tars
 *    opened from the Finder has launchd's bare PATH, and a jq Homebrew
 *    installed is said missing to every Mac that has one.
 */

function fakeFs(files: string[]): FsProbe & { asked: string[] } {
  const asked: string[] = [];
  const set = new Set(files);
  return {
    asked,
    isFile(p) {
      asked.push(p);
      return set.has(p);
    },
    readFile() {
      throw new Error('not read');
    },
  };
}

const PATH = '/opt/homebrew/bin:/usr/bin:/bin';

describe('hookToolsMissing', () => {
  it('says nothing on win32, and asks the disk nothing (1)', () => {
    const fs = fakeFs([]);
    expect(hookToolsMissing({ Path: 'C:\\Windows\\System32' }, 'win32', fs)).toBeNull();
    expect(fs.asked).toEqual([]);
  });

  describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
    it('says so when jq is not on the PATH, and names jq only (2, 6)', () => {
      const said = hookToolsMissing({ PATH }, platform, fakeFs(['/usr/bin/curl']));
      expect(said).not.toBeNull();
      expect(`${said!.message} ${said!.detail}`).toMatch(/\bjq\b/);
      expect(said!.message).not.toMatch(/curl/);
    });

    it('says so when curl is not, and names curl only (3, 6)', () => {
      const said = hookToolsMissing({ PATH }, platform, fakeFs(['/opt/homebrew/bin/jq']));
      expect(said).not.toBeNull();
      expect(said!.message).toMatch(/\bcurl\b/);
      expect(said!.message).not.toMatch(/\bjq\b/);
    });

    it('names both when neither is there', () => {
      const said = hookToolsMissing({ PATH }, platform, fakeFs([]));
      expect(said!.message).toMatch(/\bjq\b/);
      expect(said!.message).toMatch(/\bcurl\b/);
    });

    it('says nothing when both are on the PATH (4)', () => {
      expect(hookToolsMissing({ PATH }, platform, fakeFs(['/usr/bin/jq', '/usr/bin/curl']))).toBeNull();
    });

    it('counts neither a relative PATH entry nor a folder named jq (5)', () => {
      const fs = fakeFs(['bin/jq', './jq', 'jq', '/usr/bin/curl']);
      expect(hookToolsMissing({ PATH: 'bin:.:/usr/bin' }, platform, fs)).not.toBeNull();
      expect(fs.asked.every((p) => p.startsWith('/'))).toBe(true);
    });

    it('says what stops working and that Tars needs a restart (7)', () => {
      const said = hookToolsMissing({ PATH }, platform, fakeFs([]))!;
      expect(said.detail).toMatch(/status/);
      expect(said.detail).toMatch(/restart Tars/);
    });
  });

  it('tells macOS to use Homebrew, and Linux its package manager (7)', () => {
    expect(hookToolsMissing({ PATH }, 'darwin', fakeFs([]))!.detail).toMatch(/brew install jq curl/);
    const linux = hookToolsMissing({ PATH }, 'linux', fakeFs([]))!.detail;
    expect(linux).toMatch(/package manager/);
    expect(linux).toMatch(/apt install jq curl/);
    expect(linux).not.toMatch(/brew/);
  });

  it('reads the PATH the agents get, not the bare one a Finder launch gives (8)', () => {
    const finder = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/nonexistent-home' };
    expect(hookToolsMissing(finder, 'darwin', fakeFs(['/opt/homebrew/bin/jq', '/usr/bin/curl']))).toBeNull();
    expect(hookToolsMissing(finder, 'linux', fakeFs(['/usr/local/bin/jq', '/usr/bin/curl']))).toBeNull();
  });
});
