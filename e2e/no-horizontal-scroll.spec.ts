import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALL } from './surfaces.mjs';
import { launchSandboxed, removeHome, seedSandbox, splashGone, stubSkillsSh } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The page must never scroll sideways, with every dropdown open or shut.
 *
 * Two things made this worth asserting rather than eyeballing. The Usage hover
 * cards used to hang off the right of the last bars and widen the document, and
 * the fix for that is an anchoring rule plus `overflow-x-clip` that only a
 * measurement can prove. And the shared `Dropdown` panel is now sized by its
 * content instead of by its trigger, so any picker sitting near the right edge
 * can push the document wider than the window. One is the requirement, the
 * other is the regression it invites, and both show up as the same number.
 *
 * Measured on the real Electron window, not a jsdom guess.
 */


let app: ElectronApplication;
let page: Page;
let sandboxHome: string;

/** Sub-pixel layout rounding is not a sideways scrollbar. */
const SLACK_PX = 1;

/**
 * How many pickers were actually opened across the sweep.
 *
 * A loop over an empty locator passes without asserting anything, and the first
 * draft of this file did exactly that on the Usage bars. The tail test below
 * fails if the sweep went through the motions on nothing.
 */
let triggersExercised = 0;

function overflow(p: Page): Promise<number> {
  return p.evaluate(() => {
    const el = document.documentElement;
    return Math.max(el.scrollWidth - el.clientWidth, document.body.scrollWidth - el.clientWidth);
  });
}

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-hscroll-'));
  seedSandbox(sandboxHome);
  app = await launchSandboxed(electron, sandboxHome, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      // Its own port: the surfaces suite may still be holding 31498.
      DOROTHY_API_PORT: apiPort(31497),
      DOROTHY_E2E: '1',
    },
  });
  // This sweep opens /skills like the screenshot one, and reached the real
  // catalogue every run because the stub lived in that spec rather than here.
  await stubSkillsSh(app);
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await removeHome(sandboxHome);
});

for (const surface of ALL as Array<{ name: string; route: string; clickText?: string; clickText2?: string; clickRole?: 'radio'; settle?: number }>) {
  test(`no sideways scroll: ${surface.name}`, async () => {
    await page.goto(DEV_URL + surface.route, { waitUntil: 'domcontentloaded' });
    // Hydrated first: until React holds the page, what follows acts on the
    // server's HTML, and on a slow runner its bounds ran out there (run
    // 36461229599, attempt 2). splashGone waits for that as long as the spec
    // allows, then holds the splash to its own cap.
    await splashGone(page);
    await page.waitForTimeout(600);

    // Same click-through as the screenshot sweep: most pickers live behind an
    // overlay or a settings section, so a plain page load reaches almost none.
    const scope = surface.name.startsWith('settings-') ? page.getByTestId('settings-nav') : page;
    for (const [index, clickText] of [surface.clickText, surface.clickText2].entries()) {
      if (!clickText) continue;
      // By role when the surface says so, as in the screenshot sweep.
      const target = index === 0 && surface.clickRole
        ? scope.getByRole(surface.clickRole, { name: clickText, exact: true })
        : scope.getByText(clickText, { exact: true }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(surface.settle ?? 500);

    expect(await overflow(page), `${surface.name} scrolls sideways at rest`).toBeLessThanOrEqual(SLACK_PX);

    // Every picker on the page, one at a time. A panel wider than its trigger
    // is the point of the change; a panel that widens the document is not.
    const triggers = page.locator('[aria-haspopup="listbox"]:visible');
    const count = await triggers.count();
    const offenders: string[] = [];

    for (let i = 0; i < count; i++) {
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await trigger.click({ timeout: 3000 }).catch(() => {});
      triggersExercised++;
      await page.waitForTimeout(120);
      const label = ((await trigger.getAttribute('aria-label')) || (await trigger.innerText().catch(() => '')) || `#${i}`)
        .replace(/\s+/g, ' ').trim();

      const open = await overflow(page);
      if (open > SLACK_PX) offenders.push(`"${label}" widens the document by ${open}px`);

      // A panel in a modal cannot widen the document (a fixed ancestor is not
      // part of the document's scrollable overflow), so the width change would
      // show up there as a panel running off the window instead. Same defect,
      // different symptom: measure the panel itself.
      const panel = page.locator('[role="listbox"]:visible').first();
      if (await panel.count() > 0) {
        const box = await panel.boundingBox();
        const width = page.viewportSize()?.width ?? 1440;
        if (box && (box.x < -SLACK_PX || box.x + box.width > width + SLACK_PX)) {
          offenders.push(`"${label}" panel spans ${Math.round(box.x)}..${Math.round(box.x + box.width)} outside 0..${width}`);
        }
      }
      // Click the trigger again rather than pressing Escape: on an overlay,
      // Escape closes the whole dialog, and every remaining picker on it then
      // reads as not visible. That silently reduced this sweep to one picker
      // per modal, which is exactly where the widened panels live.
      await trigger.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(80);
    }

    expect(offenders, `open dropdowns widen the document on ${surface.name}`).toEqual([]);
  });
}

test('no sideways scroll: usage hover cards on the first and last bar', async () => {
  await page.goto(DEV_URL + '/usage', { waitUntil: 'domcontentloaded' });
  // Hydrated first: until React holds the page, what follows acts on the
  // server's HTML, and on a slow runner its bounds ran out there (run
  // 36461229599, attempt 2). splashGone waits for that as long as the spec
  // allows, then holds the splash to its own cap.
  await splashGone(page);
  await page.waitForTimeout(1200);

  // The bar columns are the hover targets inside the chart panels: each is the
  // flex-1 cell that carries the bar and, on hover, its card. First and last are
  // the two the anchoring rule exists for: one hangs left, one hangs right.
  const bars = page.locator('.relative.flex-1.min-w-0.flex.flex-col.items-center');
  const count = await bars.count();
  // Never silently pass on nothing: hovering zero bars proves zero.
  expect(count, 'no chart bar columns found on /usage').toBeGreaterThan(0);

  for (const index of [0, count - 1]) {
    const bar = bars.nth(index);
    await bar.hover({ force: true }).catch(() => {});
    await page.waitForTimeout(200);

    expect(await overflow(page), `usage bar ${index} hover card widens the page`).toBeLessThanOrEqual(SLACK_PX);

    // The page not scrolling is only half the requirement, and `overflow-x-clip`
    // would satisfy it by cutting the card off instead of moving it. So measure
    // the card against the row of bars it belongs to: it has to LAND inside,
    // not be hidden outside.
    const card = bar.locator('div.absolute.z-20.pointer-events-none').first();
    // Not a soft skip: a card that never appeared would make this test assert
    // nothing at all, which is how the first draft of it passed on zero bars.
    expect(await card.count(), `no hover card appeared on usage bar ${index}`).toBeGreaterThan(0);
    const cardBox = await card.boundingBox();
    const rowBox = await bar.locator('xpath=..').boundingBox();
    expect(cardBox && rowBox, `hover card on bar ${index} has no box`).toBeTruthy();
    if (!cardBox || !rowBox) continue;
    expect(
      cardBox.x >= rowBox.x - SLACK_PX && cardBox.x + cardBox.width <= rowBox.x + rowBox.width + SLACK_PX,
      `usage bar ${index} card spans ${Math.round(cardBox.x)}..${Math.round(cardBox.x + cardBox.width)} outside its chart ${Math.round(rowBox.x)}..${Math.round(rowBox.x + rowBox.width)}`,
    ).toBe(true);
  }
});

test('the sweep actually opened pickers', () => {
  // Guards the loop above against passing on an empty locator, which is how a
  // green suite can assert nothing at all.
  test.info().annotations.push({ type: 'coverage', description: `${triggersExercised} pickers opened` });
  // 27 at the time of writing. The floor is well under that so removing a
  // picker does not fail this, and well over zero so an empty sweep does.
  expect(triggersExercised, 'the sweep opened almost no dropdowns, so it asserted almost nothing').toBeGreaterThan(15);
});
