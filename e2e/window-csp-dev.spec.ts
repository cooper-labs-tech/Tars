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
    // A file outside the vault's attachments: the route answers 403, a load error, never a policy refusal.
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

/**
 * A vault note's local picture is read from this Tars's own API port (electronAPI.apiPort), never 31415 (QA's
 * finding on #651 at f5462e8dd: MarkdownRenderer and DocumentViewer wrote 31415 in, so under img-src every Tars on
 * another port, the sandbox's, every E2E's, the packed spec's, had its note pictures refused).
 * A sandbox on a port of its own, a 1x1 picture in ~/.tars/vault/attachments (the one folder /api/local-file
 * serves), a note naming it, opened in the Vault page: the picture loads (naturalWidth > 0) from this port, and the
 * policy refuses nothing. Red on f5462e8dd: the picture was asked of 31415 and refused by img-src.
 */
test('a vault note\'s local picture is read from this Tars\'s own API port, never 31415', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-csp-picture-'));
  const attachments = path.join(home, '.tars', 'vault', 'attachments');
  fs.mkdirSync(attachments, { recursive: true });
  const picture = path.join(fs.realpathSync(attachments), 'pixel.png');
  fs.writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const port = apiPort(31954);
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
    await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    type VaultApi = { electronAPI: { apiPort: number | null; vault: { createDocument(p: { title: string; content: string; author: string }): Promise<{ success: boolean }> } } };
    const created = await page.evaluate((src) => (window as unknown as VaultApi).electronAPI.vault.createDocument({ title: 'A note with a picture', content: `![a pixel](${src})`, author: 'e2e' }), picture);
    const windowPort = await page.evaluate(() => (window as unknown as VaultApi).electronAPI.apiPort);
    await page.goto(`${DEV_URL}/vault`, { waitUntil: 'domcontentloaded' });
    await splashGone(page);
    await page.getByRole('button').filter({ hasText: 'A note with a picture' }).first().click();
    const img = page.locator('img[alt="a pixel"]').first();
    await expect(img).toBeAttached({ timeout: 15_000 });
    const loaded = await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0).then(() => true, () => false);
    const shown = await img.evaluate((el) => ({ src: (el as HTMLImageElement).src, naturalWidth: (el as HTMLImageElement).naturalWidth }));
    const reported = await page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations.slice());
    await page.screenshot({ path: test.info().outputPath('vault-picture.png') });
    recordValues({ created, port, windowPort, loaded, shown, reported });

    expect.soft(created.success, 'the note made').toBe(true);
    expect.soft(windowPort, 'the window is told its own API port').toBe(Number(port));
    expect.soft(shown.src, 'the picture asked of this Tars\'s own port').toContain(`http://127.0.0.1:${port}/api/local-file?path=`);
    expect.soft(shown.naturalWidth, 'the picture loads').toBeGreaterThan(0);
    expect.soft(reported, 'the policy refuses nothing').toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
