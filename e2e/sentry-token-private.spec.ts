import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { currentUserSid, readDacls } from '../__tests__/electron/platform/read-dacl';

/**
 * The Sentry token leaves ~/.tars, which every agent is handed, for
 * ~/.tars-private, which none is (the Audit's gates of #242 and #292), in the
 * real app: a token saved by an older Tars in app-settings.json moves at the
 * first start, and a save, of that token or of anything else, never writes it
 * back. The window is told whether it is set, never its value (PR 466: the
 * mask when set, '' when not, and `secretsSet.sentryAuthToken`); a save that
 * sends it empty keeps it, and only secrets.set clears it.
 */

type Api = { electronAPI: {
  appSettings: {
    get(): Promise<Record<string, unknown> & { secretsSet?: Record<string, boolean> }>;
    save(s: Record<string, unknown>): Promise<unknown>;
  };
  secrets: { set(field: string, value: string | null): Promise<unknown> };
} };

/** What the window is shown for a secret that is set (settings-secrets.ts, SECRET_MASK). */
const MASK = '\u2022'.repeat(8);

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

test('the Sentry token moves out of ~/.tars at the first start, and a save never writes it back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-sentry-token-'));
  seedSandbox(home);
  const settingsFile = path.join(home, '.tars', 'app-settings.json');
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
    /** What the window is handed of the token: the mask or '', whether it is set, and whether its value is anywhere in it. */
    const handed = async () => {
      const s = await get();
      return { shown: s.sentryAuthToken, set: s.secretsSet?.sentryAuthToken, value: /sntryu_/.test(JSON.stringify(s)) };
    };

    // Moved at the first start; the window is told it is set, never what it is. On Windows the
    // pass that closes the private directory runs in the background after the
    // move (main.ts, closeSecretsToOtherAccounts): its end is waited for.
    if (onWindows) await expect.poll(() => privacyOf(privateFile), { timeout: 30_000 }).toBe(OWNER_ONLY);
    const moved = { inSettings: onDisk().includes(OLD), private: fs.readFileSync(privateFile, 'utf8'), mode: privacyOf(privateFile) };
    expect(moved).toEqual({ inSettings: false, private: OLD, mode: onWindows ? OWNER_ONLY : '600' });
    const handedAtStart = await handed();
    expect(handedAtStart).toEqual({ shown: MASK, set: true, value: false });

    // A save of something else does not write it back.
    await save({ sentryTriageProject: '/work/other' });
    const afterOther = { inSettings: onDisk().includes(OLD), project: JSON.parse(onDisk()).sentryTriageProject, private: fs.readFileSync(privateFile, 'utf8') };
    expect(afterOther).toEqual({ inSettings: false, project: '/work/other', private: OLD });

    // A new token goes to the private file only, and the window is still shown the mask.
    await save({ sentryAuthToken: NEW });
    const afterNew = { inSettings: /sntryu_/.test(onDisk()), private: fs.readFileSync(privateFile, 'utf8'), handed: await handed() };
    expect(afterNew).toEqual({ inSettings: false, private: NEW, handed: { shown: MASK, set: true, value: false } });

    // A save that sends it back as shown, or empty, keeps it.
    await save({ sentryAuthToken: MASK });
    await save({ sentryAuthToken: '' });
    const kept = { private: fs.readFileSync(privateFile, 'utf8'), handed: await handed() };
    expect(kept).toEqual({ private: NEW, handed: { shown: MASK, set: true, value: false } });

    // Cleared through secrets.set, it is gone.
    await page.evaluate(() => (window as unknown as Api).electronAPI.secrets.set('sentryAuthToken', null));
    const cleared = { privateExists: fs.existsSync(privateFile), handed: await handed() };
    expect(cleared).toEqual({ privateExists: false, handed: { shown: '', set: false, value: false } });

    recordValues({ moved, handedAtStart, afterOther, afterNew, kept, cleared, keysOnDisk: Object.keys(JSON.parse(onDisk())).sort() });
  } finally {
    await app.close();
    await removeHome(home);
  }
});
