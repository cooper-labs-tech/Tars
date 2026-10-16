import { describe, expect, it } from 'vitest';
import {
  COMES_WITH,
  OSES,
  builds,
  heroPrimary,
  installerFor,
  newestBuild,
  newestPublished,
  othersLine,
  promised,
  readVisitor,
  visitorArch,
  visitorOs,
  type Builds,
} from '../../landing/src/lib/platforms';

/**
 * Which build the landing offers each visitor (landing/src/lib/platforms.ts),
 * as `Landing · downloads per OS` draws it in design/landing.pen: the parity
 * program of 16/10, macOS, Windows and Linux offered alike. Written before the
 * code, as the ways it can fail:
 * 1. the visitor's system: a Mac, Windows or Linux browser read as another
 *    system or as none; a phone or a tablet read as a desktop (Android as
 *    Linux, an iPhone or an iPad in desktop mode as a Mac); ChromeOS read as
 *    Linux; the browser's client hint ignored, or a hint that says phone
 *    overruled by the user agent; an empty user agent throwing;
 * 2. its architecture: an arm64 Linux read as x64, or a Mac given one it
 *    cannot be read from;
 * 3. the file of a release: another system's file served (the Windows zip to
 *    a Mac, the macOS zip to Windows), a .blockmap or a latest*.yml taken for
 *    an installer, the visitor's architecture ignored when the release has
 *    both, or something served from a release that has no file for the system;
 * 4. the release: a draft or a prerelease served, an older release served while
 *    a newer one has the file, Windows said to be missing while the newest
 *    release's Windows files are not uploaded yet but the one before has them,
 *    or the version read with its "v";
 * 5. the line under the hero's buttons: the visitor's own system offered again,
 *    a system with a build said to come later, one without a build offered as
 *    a link, two systems coming with one version not said in one sentence,
 *    "undefined" where a version should be, or a line for a visitor whose
 *    system is not known; when GitHub did not answer, a system said to come
 *    later when it may be out;
 * 6. the hero's own button: a button for a file that is not there, a promise
 *    for a system that has a build, or a system picked for a visitor whose
 *    system is not known;
 * 7. the browser the page runs in: its client hints, its touch points or its
 *    user agent left unread, or a browser without userAgentData throwing.
 *
 * Added with the Audit's Medium on #430, before its code:
 * 9. a version promised for a system once that version is out without its
 *    build: 2.0.3 published with no Windows setup, and the page still saying
 *    Windows comes with 2.0.3; or versions compared as text, 2.0.10 read as
 *    older than 2.0.9.
 *
 * Added after the code, for a mutant of its bench that survived (M11):
 * 8. the Windows zip, or the setup's .blockmap, taken for its installer when
 *    GitHub lists it before the setup, or served from a release that has no
 *    setup (3 had the setup listed first, so it never had to choose).
 */

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const LINUX_FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const UBUNTU_FIREFOX = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const LINUX_ARM = 'Mozilla/5.0 (X11; Linux aarch64; rv:132.0) Gecko/20100101 Firefox/132.0';
const ANDROID_PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROMEOS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/cooper-labs-tech/Tars/releases/download/x/${name}` });
const ALL_THREE = [
  'latest-mac.yml', 'Tars-2.0.4-arm64-mac.zip', 'Tars-2.0.4-arm64.dmg', 'Tars-2.0.4-arm64.dmg.blockmap',
  'latest.yml', 'Tars-Setup-2.0.4.exe', 'Tars-Setup-2.0.4.exe.blockmap', 'Tars-Windows-2.0.4-x64.zip',
  'latest-linux.yml', 'latest-linux-arm64.yml', 'Tars-2.0.4.AppImage', 'Tars-2.0.4-arm64.AppImage',
].map(asset);
const MAC_ONLY = ['latest-mac.yml', 'Tars-2.0.2-arm64-mac.zip', 'Tars-2.0.2-arm64.dmg'].map(asset);
const release = (tag: string, names: string[], extra: Record<string, unknown> = {}) => ({ tag_name: tag, assets: names.map(asset), ...extra });

/** A line's words, as a reader sees them. */
const words = (parts: Array<{ text: string }>) => parts.map(p => p.text).join('');
/** The systems a line links to. */
const links = (parts: Array<{ os?: string }>) => parts.filter(p => p.os).map(p => p.os);

describe('the visitor\'s system (1)', () => {
  it.each([
    ['a Mac in Safari', MAC_SAFARI, 'mac'],
    ['a Mac in Chrome', MAC_CHROME, 'mac'],
    ['Windows in Chrome', WIN_CHROME, 'windows'],
    ['Windows in Firefox', WIN_FIREFOX, 'windows'],
    ['Linux in Firefox', LINUX_FIREFOX, 'linux'],
    ['Ubuntu in Firefox', UBUNTU_FIREFOX, 'linux'],
    ['an arm64 Linux', LINUX_ARM, 'linux'],
  ])('reads %s', (_what, ua, os) => {
    expect(visitorOs(ua)).toBe(os);
  });

  it.each([
    ['an Android phone', ANDROID_PHONE],
    ['an Android tablet', ANDROID_TABLET],
    ['an iPhone', IPHONE],
    ['ChromeOS', CHROMEOS],
    ['an empty user agent', ''],
    ['a user agent that names no system', 'curl/8.7.1'],
  ])('reads no desktop system on %s', (_what, ua) => {
    expect(visitorOs(ua)).toBeNull();
  });

  it('reads an iPad in desktop mode, which says Macintosh, as no desktop system', () => {
    expect(visitorOs(MAC_SAFARI, { touchPoints: 5 })).toBeNull();
    expect(visitorOs(MAC_SAFARI, { touchPoints: 0 })).toBe('mac');
  });

  it('takes the browser\'s client hint first, and a hint of a phone over any user agent', () => {
    expect(visitorOs('Mozilla/5.0', { platform: 'Linux' })).toBe('linux');
    expect(visitorOs(WIN_CHROME, { platform: 'macOS' })).toBe('mac');
    expect(visitorOs(MAC_CHROME, { platform: 'macOS', mobile: true })).toBeNull();
    expect(visitorOs(LINUX_FIREFOX, { platform: 'Android' })).toBeNull();
    expect(visitorOs(LINUX_FIREFOX, { platform: 'Chrome OS' })).toBeNull();
  });
});

describe('the visitor\'s architecture (2)', () => {
  it('reads arm64 and x64 where the browser says them, and nothing on a Mac', () => {
    expect(visitorArch(LINUX_ARM)).toBe('arm64');
    expect(visitorArch(LINUX_FIREFOX)).toBe('x64');
    expect(visitorArch(WIN_CHROME)).toBe('x64');
    expect(visitorArch(MAC_SAFARI)).toBeNull();
    expect(visitorArch('Mozilla/5.0', { architecture: 'arm', bitness: '64' })).toBe('arm64');
    expect(visitorArch('Mozilla/5.0', { architecture: 'x86', bitness: '64' })).toBe('x64');
  });
});

describe('the file of a release (3)', () => {
  it('serves each system its own installer, and never an update file or another system\'s', () => {
    expect(installerFor('mac', ALL_THREE)?.name).toBe('Tars-2.0.4-arm64.dmg');
    expect(installerFor('windows', ALL_THREE)?.name).toBe('Tars-Setup-2.0.4.exe');
    expect(installerFor('linux', ALL_THREE)?.name).toBe('Tars-2.0.4.AppImage');
  });

  it('serves the visitor\'s architecture when the release has both', () => {
    expect(installerFor('linux', ALL_THREE, 'arm64')?.name).toBe('Tars-2.0.4-arm64.AppImage');
    expect(installerFor('linux', ALL_THREE, 'x64')?.name).toBe('Tars-2.0.4.AppImage');
  });

  it('serves Windows its setup whatever order GitHub lists the files in, and never the zip (8)', () => {
    const zipFirst = ['Tars-Windows-2.0.4-x64.zip', 'Tars-Setup-2.0.4.exe.blockmap', 'latest.yml', 'Tars-Setup-2.0.4.exe'].map(asset);
    expect(installerFor('windows', zipFirst)?.name).toBe('Tars-Setup-2.0.4.exe');
    expect(installerFor('windows', ['Tars-Windows-2.0.4-x64.zip', 'latest.yml'].map(asset))).toBeUndefined();
  });

  it('serves nothing from a release that has no file for the system', () => {
    expect(installerFor('windows', MAC_ONLY)).toBeUndefined();
    expect(installerFor('linux', MAC_ONLY)).toBeUndefined();
    expect(installerFor('mac', ['Tars-Windows-2.0.4-x64.zip', 'Tars-Setup-2.0.4.exe'].map(asset))).toBeUndefined();
  });
});

describe('the release a file comes from (4)', () => {
  const releases = [
    release('v2.0.6', ['Tars-2.0.6-arm64.dmg', 'Tars-Setup-2.0.6.exe', 'Tars-2.0.6.AppImage'], { draft: true }),
    release('v2.0.5', ['Tars-2.0.5-arm64.dmg', 'Tars-Setup-2.0.5.exe', 'Tars-2.0.5.AppImage'], { prerelease: true }),
    release('v2.0.4', ['latest-mac.yml', 'Tars-2.0.4-arm64.dmg', 'Tars-2.0.4-arm64-mac.zip']),
    release('v2.0.3', ['Tars-2.0.3-arm64.dmg', 'Tars-Setup-2.0.3.exe', 'Tars-Windows-2.0.3-x64.zip']),
  ];

  it('serves the newest published release that has the system\'s file, without its v', () => {
    expect(newestBuild('mac', releases)).toMatchObject({ version: '2.0.4', asset: { name: 'Tars-2.0.4-arm64.dmg' } });
    expect(newestBuild('windows', releases)).toMatchObject({ version: '2.0.3', asset: { name: 'Tars-Setup-2.0.3.exe' } });
    expect(newestBuild('linux', releases)).toBeNull();
  });

  it('says, for each system, the version of its newest build, or none', () => {
    expect(builds(releases)).toEqual({ mac: '2.0.4', windows: '2.0.3', linux: null });
    expect(builds([])).toEqual({ mac: null, windows: null, linux: null });
  });
});

describe('the line under the hero\'s buttons (5)', () => {
  const today: Builds = { mac: '2.0.2', windows: null, linux: null };
  const allOut: Builds = { mac: '2.0.4', windows: '2.0.4', linux: '2.0.4' };

  it('says two systems that come with one version in one sentence, and links neither', () => {
    const line = othersLine('mac', today, '2.0.2', { windows: '2.0.4', linux: '2.0.4' });
    expect(words(line)).toBe('Windows and Linux come with 2.0.4.');
    expect(links(line)).toEqual([]);
  });

  it('offers Windows macOS, and says when Linux comes', () => {
    const line = othersLine('windows', today, '2.0.2');
    expect(words(line)).toBe(`Also for macOS. Linux comes with ${COMES_WITH.linux}.`);
    expect(links(line)).toEqual(['mac']);
  });

  it('offers every other system once each has a build, and never the visitor\'s own', () => {
    const line = othersLine('windows', allOut, '2.0.4');
    expect(words(line)).toBe('Also for macOS and Linux.');
    expect(links(line)).toEqual(['mac', 'linux']);
  });

  it('says the versions apart when two systems come with different ones', () => {
    const line = othersLine('mac', today, '2.0.2', { windows: '2.0.3', linux: '2.0.4' });
    expect(words(line)).toBe('Windows comes with 2.0.3. Linux comes with 2.0.4.');
  });

  it('offers every other system when GitHub did not answer, rather than say one is to come', () => {
    expect(words(othersLine('linux', null, null))).toBe('Also for macOS and Windows.');
  });

  it('has no line for a visitor whose system is not known', () => {
    expect(othersLine(null, today, '2.0.2')).toEqual([]);
  });

  it('never writes undefined or null for a version, whoever visits', () => {
    for (const visitor of OSES) {
      for (const b of [today, allOut, { mac: null, windows: null, linux: null }]) {
        expect(words(othersLine(visitor, b, '2.0.2'))).not.toMatch(/undefined|null/);
      }
    }
  });
});

describe('the hero\'s own button (6)', () => {
  const today: Builds = { mac: '2.0.2', windows: null, linux: null };

  it('is a download for a system with a build, and a promise for one without', () => {
    expect(heroPrimary('mac', today, '2.0.2')).toEqual({ kind: 'download', os: 'mac' });
    expect(heroPrimary('windows', today, '2.0.2')).toEqual({ kind: 'comes', os: 'windows', version: COMES_WITH.windows });
    expect(heroPrimary('linux', { ...today, linux: '2.0.4' }, '2.0.4')).toEqual({ kind: 'download', os: 'linux' });
  });

  it('sends a visitor whose system is not known to the list, and offers the download when GitHub did not answer', () => {
    expect(heroPrimary(null, today, '2.0.2')).toEqual({ kind: 'list' });
    expect(heroPrimary('windows', null, null)).toEqual({ kind: 'download', os: 'windows' });
  });
});

describe('the browser the page runs in (7)', () => {
  it('reads the system and the architecture from what the browser exposes', () => {
    expect(readVisitor({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toEqual({ os: 'mac', arch: null });
    expect(readVisitor({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toEqual({ os: null, arch: null });
    expect(readVisitor({ userAgent: LINUX_ARM })).toEqual({ os: 'linux', arch: 'arm64' });
    expect(readVisitor({ userAgent: 'Mozilla/5.0', userAgentData: { platform: 'Windows', mobile: false } })).toEqual({ os: 'windows', arch: null });
    expect(readVisitor({ userAgent: WIN_CHROME, userAgentData: { platform: 'Windows', mobile: false } })).toEqual({ os: 'windows', arch: 'x64' });
  });

  it('reads no system from a browser that says nothing', () => {
    expect(readVisitor({})).toEqual({ os: null, arch: null });
  });
});

describe('a version is promised only while it is newer than the newest release (9)', () => {
  const released = (tag: string, names: string[], extra: Record<string, unknown> = {}) => ({ tag_name: tag, assets: names.map(asset), ...extra });

  it('reads the newest published release, without its v, past drafts and prereleases', () => {
    expect(newestPublished([
      released('v2.0.5', ['Tars-2.0.5-arm64.dmg'], { draft: true }),
      released('v2.0.4', ['Tars-2.0.4-arm64.dmg'], { prerelease: true }),
      released('v2.0.3', ['Tars-2.0.3-arm64.dmg']),
    ])).toBe('2.0.3');
    expect(newestPublished([])).toBeNull();
  });

  it('reads the highest version, when GitHub lists an older line\'s patch first', () => {
    expect(newestPublished([released('v1.9.8', ['Tars-1.9.8-arm64.dmg']), released('v2.0.3', ['Tars-2.0.3-arm64.dmg'])])).toBe('2.0.3');
  });

  it('promises a version newer than the newest release, and none once that version is out', () => {
    expect(promised('windows', '2.0.2', { windows: '2.0.3' })).toBe('2.0.3');
    expect(promised('windows', '2.0.3', { windows: '2.0.3' })).toBeNull();
    expect(promised('windows', '2.0.4', { windows: '2.0.3' })).toBeNull();
    expect(promised('windows', null, { windows: '2.0.3' })).toBeNull();
  });

  it('compares versions as numbers, not as text', () => {
    expect(promised('linux', '2.0.9', { linux: '2.0.10' })).toBe('2.0.10');
    expect(promised('linux', '2.0.10', { linux: '2.0.9' })).toBeNull();
    expect(promised('linux', '2.1.0', { linux: '2.0.10' })).toBeNull();
  });

  it('says a system is coming, with no number, once its version is out without its build', () => {
    const afterRelease: Builds = { mac: '2.0.3', windows: null, linux: null };
    expect(words(othersLine('mac', afterRelease, '2.0.3', { windows: '2.0.3', linux: '2.0.4' }))).toBe('Windows is coming. Linux comes with 2.0.4.');
    expect(words(othersLine('mac', { mac: '2.0.4', windows: null, linux: null }, '2.0.4', { windows: '2.0.3', linux: '2.0.4' }))).toBe('Windows and Linux are coming.');
    expect(heroPrimary('windows', afterRelease, '2.0.3')).toEqual({ kind: 'comes', os: 'windows', version: null });
  });
});

