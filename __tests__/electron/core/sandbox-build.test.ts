import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A test build (`npm run electron:pack`, "Tars Sandbox") runs only on a home
 * of its own (the Audit's M1 on #477). Its own name gives it its own Electron
 * profile, so its own single-instance lock: opened from the Finder, the Dock
 * or `open`, without scripts/sandbox.sh, it started beside the real Tars, on
 * the real home: its agents, settings and tokens, its Telegram and Slack bots,
 * port 31415.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  B1. A sandbox build started on the account's own home (HOME is the home the
 *      password database names: nothing moved it) is not refused.
 *  B2. A sandbox build started by scripts/sandbox.sh (HOME ~/Tars-sandbox), or
 *      by the E2E fixture (a temporary HOME), is refused.
 *  B3. A release, which carries no mark, is refused on the real home.
 *  B4. The mark is read from anything but the build's own package.json (an
 *      environment variable, a setting an agent can write), so a release could
 *      be told it is a sandbox, or a sandbox that it is not; or a package.json
 *      that cannot be read takes a release for a sandbox.
 *  B5. The same home spelled another way (a trailing slash, a link to it) is
 *      taken for another one, and the build starts on the real home.
 *  B6. The stand-in for the password database's home, which an E2E needs to
 *      reach the refusal without the real home, is honoured outside an E2E run.
 *  B7. A sandbox build checks for updates every half hour like a release, and
 *      offers to download the real Tars (the Audit's L1).
 */

import { isSandboxBuild, passwdHome, sandboxRefusal, checksForUpdates } from '../../../electron/core/sandbox-build';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-build-'));
const appWith = (pkg: unknown) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  return dir;
};

describe('the mark', () => {
  it('B4. is the build\'s own package.json, true and nothing else', () => {
    expect(isSandboxBuild(appWith({ name: 'tars', tarsSandbox: true }))).toBe(true);
    expect(isSandboxBuild(appWith({ name: 'tars' }))).toBe(false);
    expect(isSandboxBuild(appWith({ name: 'tars', tarsSandbox: 'true' }))).toBe(false);
    expect(isSandboxBuild(appWith('{ not json'))).toBe(false);
    expect(isSandboxBuild(tmp())).toBe(false);
  });
});

describe('the refusal', () => {
  it('B1. a sandbox build on the account\'s own home is refused, and says how to start it', () => {
    const home = tmp();
    const why = sandboxRefusal({ sandbox: true, home, passwdHome: home });
    expect(why).toContain('scripts/sandbox.sh');
    expect(why).toContain(home);
  });

  it('B2. a sandbox build on a home of its own starts', () => {
    const real = tmp();
    expect(sandboxRefusal({ sandbox: true, home: path.join(real, 'Tars-sandbox'), passwdHome: real })).toBeNull();
    expect(sandboxRefusal({ sandbox: true, home: tmp(), passwdHome: real })).toBeNull();
  });

  it('B3. a release starts on the real home', () => {
    const home = tmp();
    expect(sandboxRefusal({ sandbox: false, home, passwdHome: home })).toBeNull();
  });

  it('B5. the same home spelled another way is the same home', () => {
    const home = tmp();
    const link = path.join(tmp(), 'link-to-home');
    fs.symlinkSync(home, link);
    expect(sandboxRefusal({ sandbox: true, home: `${home}${path.sep}`, passwdHome: home })).not.toBeNull();
    expect(sandboxRefusal({ sandbox: true, home: link, passwdHome: home })).not.toBeNull();
  });
});

describe('the home the password database names', () => {
  it('B6. is the system\'s, unless an E2E run names a stand-in', () => {
    const real = os.userInfo().homedir;
    expect(passwdHome({ DOROTHY_E2E_PASSWD_HOME: '/elsewhere' })).toBe(real);
    expect(passwdHome({ DOROTHY_E2E: '0', DOROTHY_E2E_PASSWD_HOME: '/elsewhere' })).toBe(real);
    expect(passwdHome({ DOROTHY_E2E: '1', DOROTHY_E2E_PASSWD_HOME: '/elsewhere' })).toBe('/elsewhere');
    expect(passwdHome({ DOROTHY_E2E: '1' })).toBe(real);
  });
});

describe('updates', () => {
  it('B7. a sandbox build never checks for them; a release does', () => {
    expect(checksForUpdates({ sandbox: true })).toBe(false);
    expect(checksForUpdates({ sandbox: false })).toBe(true);
  });
});
