/**
 * Which build the landing offers each visitor: macOS, Windows and Linux alike
 * (the parity program of 16/10), as `Landing · downloads per OS` in
 * design/landing.pen draws it.
 *
 * The visitor's system is read in the browser, from what it says of itself,
 * and kept nowhere: a download link names the system it asks for, and the
 * route serves that system's file from the newest release that has one. A
 * system no release has a build for yet says the version it comes with, and
 * its button appears once a release carries its file, with no change here.
 *
 * Imported by the root's tests: no landing-only package, no `@/` path.
 */

export type Os = 'mac' | 'windows' | 'linux';
export type Arch = 'x64' | 'arm64';
/** For each system, the version of the newest release that has its build, or null. */
export type Builds = Record<Os, string | null>;

/** In the frame's order. */
export const OSES: readonly Os[] = ['mac', 'windows', 'linux'];
export const OS_NAME: Record<Os, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
/** What a download button says: "Download for Mac". */
export const BUTTON_NAME: Record<Os, string> = { mac: 'Mac', windows: 'Windows', linux: 'Linux' };
/** What each build runs on (Get Tars). */
export const NEEDS: Record<Os, string> = {
  mac: 'macOS 13 or later, Apple silicon',
  windows: 'Windows 10 or later, x64',
  linux: 'AppImage, x64',
};
/**
 * The version each system's first build comes with, said while no release has
 * one: Windows once release:win has run, Linux once its build is published.
 * macOS has a build in every release; its entry is never shown while one does.
 */
export const COMES_WITH: Record<Os, string> = { mac: '2.0.2', windows: '2.0.4', linux: '2.0.4' };

export interface Asset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Asset[];
}

/** What a browser says of itself, in navigator.userAgentData, when it says it. */
export interface Hint {
  platform?: string;
  mobile?: boolean;
  touchPoints?: number;
  architecture?: string;
  bitness?: string;
}

/**
 * The visitor's desktop system, or null for a phone, a tablet, or a system
 * Tars does not run on. The client hint first, where the browser gives one; an
 * iPad in desktop mode says Macintosh and is told apart by its touch points.
 */
export function visitorOs(userAgent: string, hint: Hint = {}): Os | null {
  if (hint.mobile) return null;
  const platform = hint.platform?.toLowerCase();
  if (platform) {
    if (platform === 'macos') return (hint.touchPoints ?? 0) > 1 ? null : 'mac';
    if (platform === 'windows') return 'windows';
    if (platform === 'linux') return 'linux';
    return null;
  }
  const ua = userAgent ?? '';
  if (/iphone|ipad|ipod|android|mobile|cros/i.test(ua)) return null;
  if (/windows nt/i.test(ua)) return 'windows';
  if (/macintosh|mac os x/i.test(ua)) return (hint.touchPoints ?? 0) > 1 ? null : 'mac';
  if (/linux|x11/i.test(ua)) return 'linux';
  return null;
}

/** The visitor's architecture where the browser says it; a Mac never does. */
export function visitorArch(userAgent: string, hint: Hint = {}): Arch | null {
  if (hint.architecture) {
    if (hint.bitness && hint.bitness !== '64') return null;
    if (/^arm/i.test(hint.architecture)) return 'arm64';
    if (/^x86/i.test(hint.architecture)) return 'x64';
  }
  const ua = userAgent ?? '';
  if (/aarch64|arm64/i.test(ua)) return 'arm64';
  if (/x86_64|win64|wow64|amd64|\bx64\b/i.test(ua)) return 'x64';
  return null;
}

/** The parts of navigator the page reads. */
export interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}

/** The system and the architecture of the browser the page runs in. */
export function readVisitor(nav: NavigatorLike): { os: Os | null; arch: Arch | null } {
  const ua = nav.userAgent ?? '';
  const hint: Hint = { platform: nav.userAgentData?.platform, mobile: nav.userAgentData?.mobile, touchPoints: nav.maxTouchPoints };
  const os = visitorOs(ua, hint);
  return { os, arch: os ? visitorArch(ua) : null };
}

const isArm = (name: string) => /arm64|aarch64/i.test(name);

/** Of a system's installers, the one for this architecture: arm64 by name, x64 the others. */
function forArch(files: Asset[], arch: Arch | null | undefined, prefer: Arch): Asset | undefined {
  const want = arch ?? prefer;
  return files.find(f => (want === 'arm64') === isArm(f.name)) ?? files[0];
}

/**
 * A release's installer for one system, never an update file or another
 * system's: the .dmg on a Mac (Apple silicon first), the NSIS setup .exe on
 * Windows, the .AppImage on Linux.
 */
export function installerFor(os: Os, assets: Asset[], arch?: Arch | null): Asset | undefined {
  const name = (a: Asset) => a.name.toLowerCase();
  if (os === 'mac') return forArch(assets.filter(a => name(a).endsWith('.dmg')), null, 'arm64');
  if (os === 'windows') return forArch(assets.filter(a => name(a).endsWith('.exe') && name(a).includes('setup')), arch, 'x64');
  return forArch(assets.filter(a => name(a).endsWith('.appimage')), arch, 'x64');
}

const published = (r: Release) => !r.draft && !r.prerelease;
const versionOf = (r: Release) => (r.tag_name ?? '').replace(/^v/i, '');

/**
 * The newest published release that has the system's file, and that file. A
 * release's Windows files are added after its macOS ones, so the release
 * before stands in while they are uploaded.
 */
export function newestBuild(os: Os, releases: Release[], arch?: Arch | null): { version: string; asset: Asset } | null {
  for (const release of releases) {
    if (!published(release)) continue;
    const asset = installerFor(os, release.assets ?? [], arch);
    if (asset) return { version: versionOf(release), asset };
  }
  return null;
}

/** For each system, the version of its newest build, or null. */
export function builds(releases: Release[]): Builds {
  return {
    mac: newestBuild('mac', releases)?.version ?? null,
    windows: newestBuild('windows', releases)?.version ?? null,
    linux: newestBuild('linux', releases)?.version ?? null,
  };
}

/** A piece of a line: words, or the name of a system that links to its download. */
export interface Part {
  text: string;
  os?: Os;
}

const and = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The line under the hero's buttons: the other systems, those with a build as
 * links ("Also for macOS and Linux."), those without one with the version they
 * come with ("Windows and Linux come with 2.0.4."). None for a visitor whose
 * system is not known; when GitHub did not answer, every other system is
 * offered, and the route decides.
 */
export function othersLine(visitor: Os | null, known: Builds | null, comesWith: Partial<Record<Os, string>> = COMES_WITH): Part[] {
  if (!visitor) return [];
  const others = OSES.filter(os => os !== visitor);
  const out = known ? others.filter(os => known[os]) : others;
  const parts: Part[] = [];
  if (out.length) {
    parts.push({ text: 'Also for ' });
    out.forEach((os, i) => {
      if (i > 0) parts.push({ text: i === out.length - 1 ? ' and ' : ', ' });
      parts.push({ text: OS_NAME[os], os });
    });
    parts.push({ text: '.' });
  }
  const coming = known ? others.filter(os => !known[os]) : [];
  const versions = [...new Set(coming.map(os => comesWith[os] ?? COMES_WITH[os]))];
  for (const version of versions) {
    const names = coming.filter(os => (comesWith[os] ?? COMES_WITH[os]) === version).map(os => OS_NAME[os]);
    if (parts.length) parts.push({ text: ' ' });
    parts.push({ text: `${and(names)} ${names.length > 1 ? 'come' : 'comes'} with ${version}.` });
  }
  return parts;
}

/** The hero's own button: the visitor's download, the version it comes with, or the list of all three. */
export type Primary = { kind: 'download'; os: Os } | { kind: 'comes'; os: Os; version: string } | { kind: 'list' };

export function heroPrimary(visitor: Os | null, known: Builds | null): Primary {
  if (!visitor) return { kind: 'list' };
  if (!known || known[visitor]) return { kind: 'download', os: visitor };
  return { kind: 'comes', os: visitor, version: COMES_WITH[visitor] };
}

/** The route a download link asks: the system, and arm64 when the visitor is on it. */
export function downloadHref(os: Os, arch?: Arch | null): string {
  return `/api/download?os=${os}${arch === 'arm64' ? '&arch=arm64' : ''}`;
}
