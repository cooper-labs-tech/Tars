import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as os from 'os';
import { ALL, recordPageErrors, SCREENSHOT_TOLERANCE, USAGE_DAY, volatileMasks } from './surfaces.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, makeShotSandbox, markWhatsNewSeen, pinDayOn, removeShotSandbox, seedSandbox, settleFleet, splashGone, stubSkillsSh } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Visual + technical sweep of the real Electron app.
 *
 * The app boots sandboxed through launchSandboxed in fixture.mjs: HOME points
 * at a temp dir, so ~/.dorothy and ~/.claude are test fixtures, its Chromium
 * profile is moved there too, which HOME alone does not do, and the API binds
 * a dedicated port.
 *
 * For each surface in e2e/surfaces.mjs:
 *  - navigate (and click through to overlays / settings sections)
 *  - assert zero uncaught page errors        ← technical check
 *  - compare a screenshot against baseline   ← design check
 */


let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

/** macOS's own temp folder for this user, whatever TMPDIR the run inherited; elsewhere, os.tmpdir(). */
function osTempFolder(): string {
  if (process.platform !== 'darwin') return os.tmpdir();
  return execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
}

test.beforeAll(async () => {
  // In macOS's own temp folder, not os.tmpdir(): the /agents surfaces print
  // the seeded projects' paths, and the sandbox-paths mask covers that text's
  // own box, so the picture follows the length of TMPDIR. Measured on
  // 2026-10-12 (QA): an agent's own TMPDIR (services/agent-tmp.ts), 37
  // characters against the system's 48, turned the four /agents references
  // red by 4,370 to 4,514 px each, and a folder of 48 characters under /tmp
  // kept them green. The references were recorded under this folder. The chat
  // suite left TMPDIR for /tmp for the same reason (d08e4559).
  // On Windows, a folder of the same length on every machine (makeShotSandbox).
  sandboxHome = makeShotSandbox('dorothy-e2e-', osTempFolder());
  // Photograph a populated app, not an empty one. Every surface used to render
  // its own empty state, which cannot show a status colour, a row rhythm, a
  // truncation or a full column - so the screenshots guarded almost nothing.
  // Must happen before launch: this is the last moment the app has not read it.
  seedSandbox(sandboxHome);
  app = await launchSandboxed(electron, sandboxHome, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: apiPort(31498),
      DOROTHY_E2E: '1',
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, pageErrors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await pinDayOn(page, '/usage', USAGE_DAY);
  await stubSkillsSh(app);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  // The Dashboard has just started the tars agents on the seed's fake CLI:
  // once each holds its terminal, the statuses the references show are set,
  // and nothing in the sandbox moves them again. See SWEEP_STATUSES.
  await settleFleet(app);
});

test.afterAll(async () => {
  await app?.close();
  await removeShotSandbox(sandboxHome);
});

for (const surface of ALL as Array<{ name: string; route: string; clickText?: string; clickText2?: string; clickRole?: 'radio'; settle?: number }>) {
  test(`surface: ${surface.name}`, async () => {
    const errorsBefore = pageErrors.length;

    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    // Photographed once the launch splash, shown again by every load, has gone.
    await splashGone(page);
    await page.waitForTimeout(600);

    // Settings labels collide with the main navigation ('Extensions' is both a
    // page and a settings group), so scope those clicks to the settings nav.
    const scope = surface.name.startsWith('settings-')
      ? page.getByTestId('settings-nav')
      : page;

    for (const [index, clickText] of [surface.clickText, surface.clickText2].entries()) {
      if (!clickText) continue;
      // By role when the surface says so: a tab and a sidebar entry can carry
      // the same word, and the sidebar is the one the DOM offers first.
      const target = index === 0 && surface.clickRole
        ? scope.getByRole(surface.clickRole, { name: clickText, exact: true })
        : scope.getByText(clickText, { exact: true }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click();
      await page.waitForTimeout(400);
    }

    // Anything that publishes an async probe state waits for it to land rather
    // than being photographed mid-probe. Chat's gateway banner is the case
    // that forced this: it appears a beat late and moves the whole thread, a
    // 16,000 pixel difference between two runs of the same build. Settings ·
    // Hermes reads the tailnet for its webhook row, two `tailscale` calls one
    // after the other, and the row says "detecting…" until both answer: it was
    // photographed that way at a load average of about 90 (2026-10-05).
    // Settings · AI & Providers asks each CLI for its version, and every row
    // reads "checking" until all of them have answered: it was photographed
    // that way at a load average of about 40, 5,161 pixels (QA's gate of #311,
    // 2026-10-05). A probe with several rows waits for the last of them.
    for (const probe of ['[data-gateway-state="checking"]', 'input[placeholder="detecting…"]', ':text-is("checking")']) {
      const probing = page.locator(probe);
      const until = Date.now() + 15_000;
      while (await probing.count() > 0 && Date.now() < until) await page.waitForTimeout(100);
    }

    await page.waitForTimeout(surface.settle ?? 900);

    // Known pre-existing defects are recorded rather than failed. Each one is
    // declared in surfaces.mjs, and e2e/known-errors.spec.ts fails when a
    // declared one stops happening, so an allowance cannot outlive its defect.
    // Recorded before the screenshot, so a surface that fails on its picture
    // still counts for what it saw. Any OTHER error fails the surface.
    const { masks, used } = await volatileMasks(page, surface.name);
    const fatal = recordPageErrors(test.info(), 'surfaces', surface.name, pageErrors.slice(errorsBefore), used);
    // Soft, so the picture below is still taken and compared: a surface that
    // logs an error is exactly the one whose look is worth seeing, and a hard
    // failure here left no screenshot and no diff to look at. The test fails
    // all the same, at its end.
    expect.soft(fatal, `errors on ${surface.name}`).toEqual([]);

    // Everything that moves on its own is masked by locator rather than
    // tolerated by the number below: which locators, and why each one, is in
    // VOLATILE in surfaces.mjs, and a locator that stops matching fails the run
    // in e2e/known-errors.spec.ts. The tolerance is the same in every spec and
    // is measured, not chosen: see SCREENSHOT_TOLERANCE.
    try {
      await expect(page).toHaveScreenshot(`${surface.name}.png`, {
        ...SCREENSHOT_TOLERANCE,
        animations: 'disabled',
        mask: masks,
      });
    } finally {
      // A mask counts for what the picture covered, which the screenshot above
      // resolves when it is taken, after the count made at the settle. The CLI
      // versions of settings-ai-providers arrive once the page's detection is
      // done: measured in the final run of 1.8.0 at a load average of 80 to
      // 110, after the count and before the picture, which masked them.
      const late = (await volatileMasks(page, surface.name)).used.filter(key => !used.includes(key));
      if (late.length > 0) recordPageErrors(test.info(), 'surfaces', surface.name, [], late);
    }
  });
}
