import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { ALL } from './surfaces.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, makeShotSandbox, markWhatsNewSeen, recordValues, removeShotSandbox, seedSandbox, splashGone, stepShot, stubSkillsSh } from './fixture.mjs';
import { apiPort } from './ports.mjs';

/**
 * The window's Content Security Policy, on the packaged build (electron/core/window-csp.ts).
 *
 * 1. Every surface of the manifest (e2e/surfaces.mjs, the 43 the sweep photographs) renders under the policy
 *    with no violation: a securitypolicyviolation listener is in each document before its first script, and the
 *    console's "Refused to ..." lines are kept beside it.
 * 2. The witness: a script added to the page does not run. An inline script, a script from a data: URL and an
 *    inline event handler are put into the Dashboard; under the policy none runs and each is reported; without
 *    it, all three run.
 *
 * Needs the packed app: TARS_PACKED_APP=<path to the .app> (npm run electron:pack writes
 * release/mac-arm64/Tars Sandbox.app). Skipped without it. macOS only: electron:pack is --mac.
 * Red on train/2.0.7 b5f207bcf's build: no policy is served, and the three scripts run.
 * The artefact: values.json (the policy as served, each surface's violations, the witness), a picture per surface.
 */

const APP = process.env.TARS_PACKED_APP;

test.skip(!APP || process.platform !== 'darwin', 'TARS_PACKED_APP names the app npm run electron:pack built (macOS)');
test.describe.configure({ mode: 'serial' });

type Violation = { directive: string; blocked: string; sample: string; source: string; line: number };
type Surface = { name: string; route: string; clickText?: string; clickText2?: string; clickRole?: 'radio'; settle?: number };

let app: ElectronApplication;
let page: Page;
let home: string;
const refused: string[] = [];

/** What the document reported since it loaded. */
const violations = (p: Page) => p.evaluate(() => [...((window as unknown as { __cspViolations?: Violation[] }).__cspViolations ?? [])]);

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(APP!, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as Record<string, string>;
  home = makeShotSandbox('dorothy-e2e-csp-', os.tmpdir());
  seedSandbox(home);
  app = await launchSandboxed(electron, home, {
    executablePath: path.join(APP!, 'Contents', 'MacOS', info.CFBundleExecutable),
    env: { DOROTHY_API_PORT: apiPort(31386), DOROTHY_E2E: '1' },
  });
  page = await app.firstWindow();
  // In every document before its first script, as Playwright adds an init script: outside the page's policy.
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample, source: event.sourceFile, line: event.lineNumber });
    });
  });
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text().slice(0, 400));
  });
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await stubSkillsSh(app);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (home) await removeShotSandbox(home);
});

test('every surface renders under the policy with no violation', async () => {
  test.setTimeout(900_000);
  const perSurface: Record<string, Violation[]> = {};
  const refusedPerSurface: Record<string, string[]> = {};

  await page.goto('app://-/', { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  const policy = await page.evaluate(() => fetch(location.href).then((response) => response.headers.get('content-security-policy')));
  recordValues({ app: APP, policy });

  for (const surface of ALL as Surface[]) {
    const consoleBefore = refused.length;
    await page.goto(`app://-${surface.route}`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    await page.waitForTimeout(600);
    const scope = surface.name.startsWith('settings-') ? page.getByTestId('settings-nav') : page;
    for (const [index, clickText] of [surface.clickText, surface.clickText2].entries()) {
      if (!clickText) continue;
      const target = index === 0 && surface.clickRole
        ? scope.getByRole(surface.clickRole, { name: clickText, exact: true })
        : scope.getByText(clickText, { exact: true }).first();
      await target.waitFor({ state: 'visible', timeout: 8000 });
      await target.click();
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(surface.settle ?? 1200);
    await stepShot(page, surface.name);
    perSurface[surface.name] = await violations(page);
    refusedPerSurface[surface.name] = refused.slice(consoleBefore);
    recordValues({ surfaces: Object.keys(perSurface).length, perSurface, refusedPerSurface });
  }

  expect(policy, 'the policy the page is served with').toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
  expect(policy).not.toContain('unsafe-eval');
  expect(Object.keys(perSurface)).toHaveLength((ALL as Surface[]).length);
  for (const [name, seen] of Object.entries(perSurface)) expect.soft(seen, `violations on ${name}`).toEqual([]);
  for (const [name, lines] of Object.entries(refusedPerSurface)) expect.soft(lines, `console refusals on ${name}`).toEqual([]);
});

test('a script added to the page does not run', async () => {
  test.setTimeout(120_000);
  await page.goto('app://-/', { waitUntil: 'domcontentloaded' });
  await splashGone(page);
  const before = (await violations(page)).length;
  const ran = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const inline = document.createElement('script');
    inline.textContent = 'window.__cspWitnessInline = true;';
    document.head.appendChild(inline);
    const fromData = document.createElement('script');
    const dataOutcome = new Promise<string>((resolve) => {
      fromData.onload = () => resolve('loaded');
      fromData.onerror = () => resolve('refused');
    });
    fromData.src = 'data:text/javascript,window.__cspWitnessData=true';
    document.head.appendChild(fromData);
    const holder = document.createElement('div');
    holder.innerHTML = '<img alt="" src="app://-/no-such-picture.png" onerror="window.__cspWitnessHandler=true">';
    document.body.appendChild(holder);
    const outcome = await dataOutcome;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    holder.remove();
    return { inline: w.__cspWitnessInline === true, data: w.__cspWitnessData === true, handler: w.__cspWitnessHandler === true, dataOutcome: outcome };
  });
  const reported = (await violations(page)).slice(before);
  recordValues({ witness: { ran, reported } });
  await stepShot(page, 'witness');

  expect.soft(ran.inline, 'an inline script added to the page ran').toBe(false);
  expect.soft(ran.data, 'a data: script added to the page ran').toBe(false);
  expect.soft(ran.handler, 'an inline event handler added to the page ran').toBe(false);
  expect.soft(reported.map((v) => v.directive).sort(), 'what the policy reported').toEqual(['script-src-attr', 'script-src-elem', 'script-src-elem']);
});
