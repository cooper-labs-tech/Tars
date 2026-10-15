import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, seedSandbox } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { currentUserSid, readDacls } from '../__tests__/electron/platform/read-dacl';

/**
 * The Sentry token leaves ~/.dorothy, which every agent is handed, for
 * ~/.tars-private, which none is (the Audit's gates of #242 and #292), in the
 * real app: a token saved by an older Tars in app-settings.json moves at the
 * first start, the settings the app hands its pages still carry it, and a
 * save, of that token or of anything else, never writes it back.
 */

type Api = { electronAPI: { appSettings: {
  get(): Promise<Record<string, unknown>>;
  save(s: Record<string, unknown>): Promise<unknown>;
} } };

const OLD = 'sntryu_e2e-token-saved-by-an-older-tars';
const NEW = 'sntryu_e2e-token-typed-in-settings';

const onWindows = process.platform === 'win32';
const OWNER_ONLY = 'the user and SYSTEM, nothing a folder can hand down';
let userSid = '';

/**
 * Whom the private file is open to. macOS and Linux: its mode. Windows, where
 * a mode is only the read-only bit: its access list, which Tars closes to the
 * user and SYSTEM (electron/platform/owner-only.ts), read as SIDs. The file is
 * closed itself, or inherits from the private directory once the startup pass
 * has closed that one; either way the same two entries, full control, behind
 * a list that takes nothing from the home.
 */
function privacyOf(file: string): string {
  if (!onWindows) return (fs.statSync(file).mode & 0o777).toString(8);
  userSid ||= currentUserSid();
  const [ofFile, ofDir] = readDacls(file, path.dirname(file));
  const entries = ofFile.aces.map((ace) => ace.replace(/^\(A;ID;/, '(A;;')).sort();
  const closed = JSON.stringify(entries) === JSON.stringify([`(A;;FA;;;${userSid})`, '(A;;FA;;;S-1-5-18)'].sort())
    && (ofFile.protectedFromParent || ofDir.protectedFromParent);
  return closed ? OWNER_ONLY : JSON.stringify({ file: ofFile, dir: ofDir });
}

test('the Sentry token moves out of ~/.dorothy at the first start, and a save never writes it back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-sentry-token-'));
  seedSandbox(home);
  const settingsFile = path.join(home, '.dorothy', 'app-settings.json');
  const seeded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...seeded, sentryAuthToken: OLD, sentryTriageProject: '/work/tars' }, null, 2));
  const privateFile = path.join(home, '.tars-private', 'sentry-token');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31469), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const get = () => page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.get());
    const save = (s: Record<string, unknown>) => page.evaluate((x) => (window as unknown as Api).electronAPI.appSettings.save(x), s);
    const onDisk = () => fs.readFileSync(settingsFile, 'utf8');

    // Moved at the first start, and still handed to the pages. On Windows the
    // pass that closes the private directory runs in the background after the
    // move (main.ts, closeSecretsToOtherAccounts): its end is waited for.
    if (onWindows) await expect.poll(() => privacyOf(privateFile), { timeout: 30_000 }).toBe(OWNER_ONLY);
    const moved = { inSettings: onDisk().includes(OLD), private: fs.readFileSync(privateFile, 'utf8'), mode: privacyOf(privateFile) };
    expect(moved).toEqual({ inSettings: false, private: OLD, mode: onWindows ? OWNER_ONLY : '600' });
    expect((await get()).sentryAuthToken).toBe(OLD);

    // A save of something else does not write it back.
    await save({ sentryTriageProject: '/work/other' });
    const afterOther = { inSettings: onDisk().includes(OLD), project: JSON.parse(onDisk()).sentryTriageProject, private: fs.readFileSync(privateFile, 'utf8') };
    expect(afterOther).toEqual({ inSettings: false, project: '/work/other', private: OLD });

    // A new token goes to the private file only.
    await save({ sentryAuthToken: NEW });
    const afterNew = { inSettings: /sntryu_/.test(onDisk()), private: fs.readFileSync(privateFile, 'utf8'), handed: (await get()).sentryAuthToken };
    expect(afterNew).toEqual({ inSettings: false, private: NEW, handed: NEW });

    // Cleared, it is gone.
    await save({ sentryAuthToken: '' });
    const cleared = { privateExists: fs.existsSync(privateFile), handed: (await get()).sentryAuthToken };
    expect(cleared).toEqual({ privateExists: false, handed: '' });

    recordValues({ moved, afterOther, afterNew, cleared, keysOnDisk: Object.keys(JSON.parse(onDisk())).sort() });
  } finally {
    await app.close();
  }
});
