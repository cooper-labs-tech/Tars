import { describe, it, expect, vi } from 'vitest';

/**
 * darwin and linux after the integration paths moved to electron/platform: the
 * Hermes Desktop config, the tailscale candidates and the Tasmania token are
 * the strings the code built inline before, to the byte. `path` is POSIX's
 * here, as it is on a Mac and on Linux, so the literals hold on any host.
 *
 * How it can fail:
 * 1. a path differs from the former `path.join(os.homedir(), 'Library', ...)`
 *    (a win32 separator, an %APPDATA% read, a folder renamed);
 * 2. the tailscale list changes: order, an entry added or dropped, a disk
 *    probe or a PATH lookup on a platform that never had one;
 * 3. linux, which the code always treated as darwin here, starts to differ from it.
 */

vi.mock('path', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return { ...p.posix, default: p.posix, posix: p.posix, win32: p.win32 };
});

import { hermesDesktopConfigPath, tailscaleCandidates, tasmaniaTokenPath, type FsProbe } from '../../../electron/platform';

const untouched: FsProbe = {
  isFile: () => { throw new Error('the disk was probed'); },
  readFile: () => { throw new Error('the disk was read'); },
};
// Windows variables set on purpose: darwin and linux must not read them.
const env = { APPDATA: 'D:\\Roam', ProgramFiles: 'C:\\Program Files', PATH: '/usr/bin:/bin' };

describe.each(['darwin', 'linux'] as const)('%s, to the byte', (platform) => {
  it('1. Hermes Desktop connection.json', () => {
    expect(hermesDesktopConfigPath({ platform, home: '/Users/demo', env }))
      .toBe('/Users/demo/Library/Application Support/Hermes/connection.json');
  });

  it('2. the tailscale candidates', () => {
    expect(tailscaleCandidates({ platform, env, fs: untouched }))
      .toEqual(['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  });

  it('1. the Tasmania token', () => {
    expect(tasmaniaTokenPath({ platform, home: '/Users/demo' }))
      .toEqual({ ok: true, path: '/Users/demo/Library/Application Support/Tasmania/.control-api-token' });
  });
});
