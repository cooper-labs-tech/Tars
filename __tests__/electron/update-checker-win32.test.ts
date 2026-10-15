import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * The GitHub fallback of the update check on Windows.
 *
 * electron-updater reads the feed electron-builder baked into the app
 * (build.publish, the repository macOS updates from too). When it throws, as
 * it does while the latest release has no latest.yml, update-checker.ts asks
 * the GitHub API itself, and until Windows was supported it offered the first
 * .dmg: a macOS installer to a Windows user.
 *
 * How it can fail, each case below:
 *  - the fallback asks another repository than GITHUB_REPO;
 *  - a .dmg or a .zip is offered on win32, or the wrong architecture's installer;
 *  - a newer release that carries no Windows installer yet is offered, which
 *    sends the user to a page with nothing to install, or reported as the
 *    latest version when it cannot be installed here;
 *  - the versions stop comparing as they do on macOS: a newer one read as not
 *    newer, or an older one as newer.
 * The decisions themselves are tested one by one in platform/update-feed.test.ts;
 * this file drives them through checkForUpdates, as the app calls it. The macOS
 * cases of update-checker.test.ts run with the platform held at darwin.
 */

const { mockAutoUpdater, mockFetch, current } = vi.hoisted(() => ({
  mockAutoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    currentVersion: { version: '1.9.6' },
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
  mockFetch: vi.fn(),
  current: { version: '1.9.6' },
}));

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }));
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), app: { getVersion: () => current.version } }));
vi.mock('../../electron/constants', () => ({ GITHUB_REPO: 'cooper-labs-tech/Tars' }));
vi.stubGlobal('fetch', mockFetch);

import { checkForUpdates, setMainWindowGetter } from '../../electron/services/update-checker';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
});

const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });
const RELEASE_PAGE = 'https://github.com/cooper-labs-tech/Tars/releases/tag/v1.9.7';
const MAC_FILES = [asset('Tars-1.9.7-arm64.dmg'), asset('Tars-1.9.7-arm64-mac.zip'), asset('latest-mac.yml')];
const WINDOWS_FILES = [asset('Tars-Setup-1.9.7.exe.blockmap'), asset('Tars-Setup-1.9.7.exe'), asset('Tars-Windows-1.9.7-x64.zip'), asset('latest.yml')];

function makeWindow() {
  return { webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow & { webContents: { send: ReturnType<typeof vi.fn> } };
}

/** The fallback, run as checkForUpdates runs it: electron-updater throws, GitHub answers with `release`. */
async function fallback(release: { tag_name: string; assets?: { name: string; browser_download_url: string }[] }) {
  const win = makeWindow();
  setMainWindowGetter(() => win);
  mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error('Cannot find latest.yml in the latest release artifacts'));
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({ html_url: RELEASE_PAGE, body: 'notes', assets: [], ...release }) });
  const result = await checkForUpdates();
  const [channel, info] = win.webContents.send.mock.calls[0];
  return { result, channel, info, url: mockFetch.mock.calls[0][0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  current.version = '1.9.6';
});

describe('the fallback on Windows', () => {
  it('asks the repository macOS updates from, and offers the next version\'s Windows installer', async () => {
    const { result, channel, info, url } = await fallback({ tag_name: 'v1.9.7', assets: [...MAC_FILES, ...WINDOWS_FILES] });
    expect(url).toBe('https://api.github.com/repos/cooper-labs-tech/Tars/releases/latest');
    expect(result).toEqual({ devMode: false, fallback: true });
    expect(channel).toBe('app:update-available');
    expect(info).toMatchObject({
      currentVersion: '1.9.6',
      latestVersion: '1.9.7',
      downloadUrl: 'https://example.com/Tars-Setup-1.9.7.exe',
      hasUpdate: true,
    });
  });

  it('offers no update, never a .dmg, while the release carries only the macOS files, and names the version installed as the latest it can get', async () => {
    const { result, channel, info } = await fallback({ tag_name: 'v1.9.7', assets: MAC_FILES });
    expect(result).toEqual({ devMode: false, fallback: true });
    expect(channel).toBe('app:update-not-available');
    expect(info).toEqual({ currentVersion: '1.9.6', latestVersion: '1.9.6' });
  });

  it.each([
    ['1.9.6', 'v1.9.7', true],
    ['1.9.6', 'v1.10.0', true],
    ['1.9.9', 'v1.9.10', true],
    ['1.9.6', 'v2.0.0', true],
    ['1.9.6', 'v1.9.6', false],
    ['1.9.7', 'v1.9.6', false],
    ['1.10.0', 'v1.9.12', false],
  ])('%s installed, %s released with its Windows installer: an update is %s', async (installed, tag, newer) => {
    current.version = installed;
    const { channel, info } = await fallback({ tag_name: tag, assets: [asset(`Tars-Setup-${tag.slice(1)}.exe`)] });
    expect(info.hasUpdate ?? false).toBe(newer);
    expect(channel).toBe(newer ? 'app:update-available' : 'app:update-not-available');
  });
});
