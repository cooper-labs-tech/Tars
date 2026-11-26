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
 * e2e/window-csp.packed.spec.ts), and a picture from another host is refused and reported (img-src). Of the
 * local API, a picture from /api/local-file is taken, as the vault's are, and one from any other of its routes
 * (/api/health) is refused: img-src names the route, not the origin (the Audit's L1 on #651).
 * Red on train/2.0.7 b5f207bcf: no policy, nothing reported. Red on 98b064f8a: the API's whole origin allowed.
 * The artefact: values.json (what ran, what the policy reported).
 */

type Violation = { directive: string; blocked: string };

test('next dev\'s pages get the development policy: scripts as next dev needs them, the rest as packaged', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-csp-dev-'));
  const port = apiPort(31372);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
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
    const api = `http://127.0.0.1:${port}`;
    // A file that is not there: the route answers 404, a load error, never a policy refusal.
    const vaultPicture = `${api}/api/local-file?path=${encodeURIComponent(path.join(home, 'no-such-picture.png'))}`;
    const seen = await page.evaluate(async (pictures) => {
      const w = window as unknown as { __cspViolations: Violation[]; __cspDevInline?: boolean };
      const before = w.__cspViolations.length;
      const inline = document.createElement('script');
      inline.textContent = 'window.__cspDevInline = true;';
      document.head.appendChild(inline);
      const outcomes: Record<string, string> = {};
      for (const src of pictures) {
        const picture = new Image();
        const outcome = new Promise<string>((resolve) => {
          picture.onload = () => resolve('loaded');
          picture.onerror = () => resolve('error');
        });
        picture.src = src;
        outcomes[src] = await Promise.race([outcome, new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 3000))]);
      }
      return { inline: w.__cspDevInline === true, outcomes, reported: w.__cspViolations.slice(before) };
    }, [
      // TEST-NET-3: an address nothing answers, so no request leaves the machine either way.
      'http://203.0.113.9/picture.png',
      vaultPicture,
      `${api}/api/health`,
    ]);
    recordValues({ seen, api });

    expect.soft(seen.inline, 'an inline script runs in development').toBe(true);
    expect.soft(seen.reported, 'refused by img-src: the other host, and the API\'s routes but /api/local-file').toEqual([
      { directive: 'img-src', blocked: 'http://203.0.113.9/picture.png' },
      { directive: 'img-src', blocked: `${api}/api/health` },
    ]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
