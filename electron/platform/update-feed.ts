/**
 * What a platform takes from a GitHub release when the update check falls back
 * to the GitHub API: the decisions behind that fallback in
 * services/update-checker.ts, which calls these and decides nothing of its own.
 *
 * Every platform reads the same releases: GITHUB_REPO, the repository of
 * package.json build.publish, which electron-builder bakes into the macOS and
 * the Windows builds alike for electron-updater. One release carries the macOS
 * dmg and zip and the Windows installer and zip side by side, and the Windows
 * files are added to it after the macOS ones, so each platform has to pick its
 * own file, and Windows can meet a release that has none for it yet.
 *
 * win32: the NSIS setup .exe, this architecture's first, never another
 * platform's file, and no update offered while the release carries no setup.
 *
 * darwin and linux: the .dmg, then the .zip, and every newer release offered,
 * byte for byte what update-checker.ts did before this layer.
 */

type ReleaseAsset = { name: string; browser_download_url?: string };

/** The Windows zip, `Tars-Windows-<version>-<arch>.zip` (package.json build.win.artifactName). */
const WINDOWS_ZIP = /^Tars-Windows-.*\.zip$/i;

/**
 * The asset of a release this platform installs. win32: the setup .exe, this
 * architecture's first, and nothing rather than another platform's file.
 * darwin and linux: the .dmg, then the .zip that is not the Windows one, which
 * is any .zip on a release that has none for Windows, as before.
 */
export function installerAssetFor<T extends ReleaseAsset>(assets: T[], platform: NodeJS.Platform, arch: string): T | undefined {
  if (platform === 'win32') {
    const setups = assets.filter(a => /setup/i.test(a.name) && /\.exe$/i.test(a.name));
    return setups.find(a => a.name.toLowerCase().includes(arch.toLowerCase())) ?? setups[0];
  }
  const dmgAsset = assets.find(a => a.name.endsWith('.dmg'));
  const zipAsset = assets.find(a => a.name.endsWith('.zip') && !WINDOWS_ZIP.test(a.name));
  return dmgAsset || zipAsset;
}

/**
 * Whether a newer release is offered as an update on this platform, given the
 * installer installerAssetFor found in it. win32: only with a setup, since a
 * release without one is a version whose Windows build is not out yet, and
 * offering it would send the user to a page with nothing to install. darwin
 * and linux: always, the release page standing in for a missing file, as
 * before.
 */
export function offersUpdate(platform: NodeJS.Platform, installer: ReleaseAsset | undefined): boolean {
  return platform !== 'win32' || installer !== undefined;
}
