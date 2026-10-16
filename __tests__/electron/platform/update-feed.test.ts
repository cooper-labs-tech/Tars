import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { installerAssetFor, offersUpdate } from '../../../electron/platform/update-feed';

/**
 * Which asset of a release a platform installs, and whether a newer release is
 * offered at all: the decisions behind the GitHub fallback of
 * update-checker.ts, pure.
 *
 * One release carries the macOS dmg and zip and the Windows installer and zip
 * side by side, the Windows files added after the macOS ones, and every
 * platform reads it from the same repository.
 *
 * How it can fail, each case below:
 *  - Windows given a feed of its own (build.win.publish), or a build.publish
 *    that is not the repository GITHUB_REPO names: electron-updater and the
 *    fallback would then read different releases on Windows;
 *  - a .dmg, a .zip or a blockmap offered on win32, or the other
 *    architecture's installer, or a macOS file when there is no setup .exe;
 *  - a release that carries no Windows installer yet offered on win32, which
 *    sends the user to a page with nothing to install;
 *  - darwin and linux no longer get the .dmg first, then the .zip, or no
 *    longer get every newer release offered;
 *  - darwin and linux, on a release with no .dmg, offered the Windows zip
 *    listed beside the macOS one.
 */

const ROOT = path.join(__dirname, '..', '..', '..');
const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });

describe('which repository feeds Windows', () => {
  it('the one macOS reads: package.json build.publish, which GITHUB_REPO names, and no feed of its own', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const constants = fs.readFileSync(path.join(ROOT, 'electron', 'constants', 'index.ts'), 'utf8');
    const repo = /export const GITHUB_REPO = '([^']+)'/.exec(constants)?.[1];
    expect(repo).toBeTruthy();
    expect(`${pkg.build.publish.owner}/${pkg.build.publish.repo}`).toBe(repo);
    expect(pkg.build.win).toBeTruthy();
    expect(pkg.build.win.publish).toBeUndefined();
    expect(pkg.build.nsis?.publish).toBeUndefined();
  });
});

describe('which asset is offered', () => {
  const release = [asset('Tars-1.9.6-arm64.dmg'), asset('Tars-1.9.6-arm64-mac.zip'), asset('latest-mac.yml'),
    asset('Tars-Setup-1.9.6.exe.blockmap'), asset('Tars-Setup-1.9.6.exe'), asset('Tars-Windows-1.9.6-x64.zip'), asset('latest.yml')];

  it('win32: the setup .exe, never the .dmg, a .zip or the blockmap', () => {
    expect(installerAssetFor(release, 'win32', 'x64')?.name).toBe('Tars-Setup-1.9.6.exe');
  });

  it('win32: nothing when the release has no setup .exe, rather than a macOS file', () => {
    expect(installerAssetFor(release.filter(a => !a.name.includes('Setup')), 'win32', 'x64')).toBeUndefined();
  });

  it('win32: this architecture\'s setup first, then any setup', () => {
    const both = [asset('Tars-Setup-2.0.0-arm64.exe'), asset('Tars-Setup-2.0.0-x64.exe')];
    expect(installerAssetFor(both, 'win32', 'x64')?.name).toBe('Tars-Setup-2.0.0-x64.exe');
    expect(installerAssetFor(both, 'win32', 'arm64')?.name).toBe('Tars-Setup-2.0.0-arm64.exe');
    expect(installerAssetFor([asset('tars-setup-2.0.0.EXE')], 'win32', 'x64')?.name).toBe('tars-setup-2.0.0.EXE');
  });

  it('darwin and linux: unchanged, the .dmg, then the .zip', () => {
    expect(installerAssetFor(release, 'darwin', 'arm64')?.name).toBe('Tars-1.9.6-arm64.dmg');
    expect(installerAssetFor([asset('Tars-1.9.6-arm64-mac.zip')], 'darwin', 'arm64')?.name).toBe('Tars-1.9.6-arm64-mac.zip');
    expect(installerAssetFor(release, 'linux', 'x64')?.name).toBe('Tars-1.9.6-arm64.dmg');
  });

  it('darwin and linux: with no .dmg, the macOS zip, never the Windows zip listed beside it', () => {
    const windowsFirst = [asset('Tars-Windows-1.9.6-x64.zip'), asset('Tars-1.9.6-arm64-mac.zip'), asset('Tars-Setup-1.9.6.exe')];
    expect(installerAssetFor(windowsFirst, 'darwin', 'arm64')?.name).toBe('Tars-1.9.6-arm64-mac.zip');
    expect(installerAssetFor(windowsFirst, 'linux', 'x64')?.name).toBe('Tars-1.9.6-arm64-mac.zip');
    expect(installerAssetFor([asset('Tars-Windows-1.9.6-x64.zip'), asset('Tars-Setup-1.9.6.exe')], 'darwin', 'arm64')).toBeUndefined();
  });

  it('names the installer and the zip the way package.json has electron-builder name them, so each platform takes its own', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const named = String(pkg.build.nsis.artifactName).replace('${version}', '1.9.6').replace('${ext}', 'exe');
    const zip = String(pkg.build.win.artifactName).replace('${version}', '1.9.6').replace('${arch}', 'x64').replace('${ext}', 'zip');
    expect(installerAssetFor([asset(zip), asset(named)], 'win32', 'x64')?.name).toBe(named);
    expect(installerAssetFor([asset(zip), asset(named)], 'darwin', 'arm64')).toBeUndefined();
  });
});

describe('whether a newer release is offered', () => {
  it('win32: only when it carries a setup .exe', () => {
    expect(offersUpdate('win32', asset('Tars-Setup-1.9.6.exe'))).toBe(true);
    expect(offersUpdate('win32', undefined)).toBe(false);
  });

  it('darwin and linux: always, as before, whatever the release carries', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(offersUpdate(platform, asset('Tars-1.9.6-arm64.dmg'))).toBe(true);
      expect(offersUpdate(platform, undefined)).toBe(true);
    }
  });
});
