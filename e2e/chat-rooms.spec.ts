import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { CHAT_ROOMS, recordPageErrors, SCREENSHOT_TOLERANCE, volatileMasks } from './surfaces.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, makeShotSandbox, markWhatsNewSeen, removeShotSandbox, roomListSettled, seedSandbox, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Chat room, one frame per state, in a sandbox of its own.
 *
 * A room is derived from a project rather than stored, and its state comes
 * from the bus journal, so five states means five rooms and a seeded journal.
 * That sandbox cannot be the sweep's: three more projects and six more agents
 * would move every baseline in it, and autostart would run each of those
 * agents as a real CLI, which makes `all stopped` impossible to photograph.
 *
 * What this pins that nothing else did: `delivered`, `dropped`, `bounded` and
 * `superseded` are rendered here for the first time. They were states the page
 * had code for and no data had ever produced, which is not the same as a state
 * that works.
 */


let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

type ChatSurface = { name: string; route: string; clickText?: string; shows: string; placeholder?: string };

/** The rooms this suite opens, which the seeded journal lists: every surface stands on that list. */
const LISTED_ROOMS = [...new Set((CHAT_ROOMS as ChatSurface[]).flatMap(s => (s.clickText ? [s.clickText] : [])))];

test.beforeAll(async () => {
  // Under /tmp, not os.tmpdir(): a room's head prints its project's path, so a
  // path that follows TMPDIR moves the head with the machine (3,842 to 5,111 px
  // between /tmp and macOS's /var/folders, measured for 1.9.0) and, once long,
  // cuts the room's name to its first letter. Spelled /tmp, not /private/tmp:
  // the fixture compares the app's folders with it. Windows has no /tmp (the
  // literal made C:\tmp) and its temp dir follows the user: there a root of
  // fixed length, and references of its own (makeShotSandbox in the fixture).
  sandboxHome = makeShotSandbox('dorothy-e2e-chat-', '/tmp');
  seedSandbox(sandboxHome, { chatRooms: true });
  app = await launchSandboxed(electron, sandboxHome, {
    timezoneId: 'UTC',
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      // Its own port: the other suites may still be holding 31498 and 31496.
      DOROTHY_API_PORT: apiPort(31495),
      DOROTHY_E2E: '1',
      // Every row carries a time, so the clock is pinned here rather than left
      // to whichever machine records the baseline.
      TZ: 'UTC',
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, pageErrors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await removeShotSandbox(sandboxHome);
});

for (const surface of CHAT_ROOMS as ChatSurface[]) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    // Photographed once the launch splash, shown again by every load, has gone.
    await splashGone(page);
    await roomListSettled(page, LISTED_ROOMS);

    if (surface.clickText) {
      // The room is chosen in the conversation list, which is the only way in:
      // the page holds the selection in state rather than in the URL.
      const entry = page.getByRole('button', { name: surface.clickText, exact: false })
        .filter({ hasText: surface.clickText }).first();
      await entry.waitFor({ state: 'visible', timeout: 20_000 });
      await entry.click();
    }

    // The state itself, in the words the page uses for it. Waiting on the room
    // title instead would photograph the log before the journal arrived.
    await expect(page.getByText(surface.shows, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    // Some of what a room says about itself is said in the composer rather than
    // in the log, and a placeholder is not text this would otherwise find.
    if (surface.placeholder) {
      await expect(page.getByPlaceholder(surface.placeholder, { exact: false })).toBeVisible({ timeout: 20_000 });
    }
    await page.waitForTimeout(900);

    // One rule for the whole suite: the known defects declared in surfaces.mjs
    // are recorded, anything else fails. What a room records counts for
    // e2e/known-errors.spec.ts exactly as the sweep's does: an error only a
    // room trips is still an error that happens. Soft, so the picture is still
    // compared, as in the sweep.
    const { masks, used } = await volatileMasks(page, surface.name);
    const fatal = recordPageErrors(test.info(), 'chat-rooms', surface.name, pageErrors.slice(errorsBefore), used);
    expect.soft(fatal, `errors on ${surface.name}`).toEqual([]);

    await expect(page).toHaveScreenshot(`${surface.name}.png`, {
      // The sweep's tolerance and the sweep's masks, from surfaces.mjs.
      ...SCREENSHOT_TOLERANCE,
      animations: 'disabled',
      mask: masks,
    });
  });
}
