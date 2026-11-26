import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The window's policy in development (electron/core/window-csp.ts): next dev's pages get it from the session,
 * scripts loosened as next dev needs them and every other directive as packaged. The rest of the suite runs on
 * next dev and fails a surface on any console error, so this is what makes its silence about the policy mean
 * something: were the development policy gone, a picture from another host would load here unreported.
 *
 * An inline script added to the page runs (development allows it, the packaged build does not:
 * e2e/window-csp.packed.spec.ts), and a picture from another host is refused and reported (img-src).
 * Red on train/2.0.7 b5f207bcf: no policy, nothing reported.
 * The artefact: values.json (what ran, what the policy reported).
 */

type Violation = { directive: string; blocked: string };

test('next dev\'s pages get the development policy: scripts as next dev needs them, the rest as packaged', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-csp-dev-'));
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31372), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      const seen: Violation[] = [];
      Object.defineProperty(window, '__cspViolations', { value: seen });
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
      });
    });
    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    const seen = await page.evaluate(async () => {
      const w = window as unknown as { __cspViolations: Violation[]; __cspDevInline?: boolean };
      const before = w.__cspViolations.length;
      const inline = document.createElement('script');
      inline.textContent = 'window.__cspDevInline = true;';
      document.head.appendChild(inline);
      const picture = new Image();
      const outcome = new Promise<string>((resolve) => {
        picture.onload = () => resolve('loaded');
        picture.onerror = () => resolve('error');
      });
      // TEST-NET-3: an address nothing answers, so no request leaves the machine either way.
      picture.src = 'http://203.0.113.9/picture.png';
      const pictureOutcome = await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 3000))]);
      return { inline: w.__cspDevInline === true, pictureOutcome, reported: w.__cspViolations.slice(before) };
    });
    recordValues({ seen });

    expect.soft(seen.inline, 'an inline script runs in development').toBe(true);
    expect.soft(seen.reported, 'the picture from another host, refused by img-src').toEqual([
      { directive: 'img-src', blocked: 'http://203.0.113.9/picture.png' },
    ]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
