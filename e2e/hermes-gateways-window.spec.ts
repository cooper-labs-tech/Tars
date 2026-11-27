import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, stepShot, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings, Hermes, Gateways (2.0.4, the window of #469): every Hermes that hands Tars work, its two addresses, its
 * secret set and never shown back, and the projects it may reach. Frames: `Gateways · Settings, Hermes` (its light
 * copy, the narrowest window), `· states` (and its light copy); Connection's `row Incoming webhook` points there.
 *
 * The real app on a sandbox HOME from before 2.0.4: no gateway registry, so Hermes, the default, reaches no project;
 * Tars lists two projects (projects.json); the fixture's tailscale serves Tars on tars-sandbox.example.ts.net. Tars's
 * own dialog and the clipboard are stood in for in the main process, so the run reads what Tars showed and copied and
 * never touches the machine's clipboard. Asserted:
 * 1. Gateways lists Hermes, the default, with its two addresses (the tailnet's, and this machine's on the sandbox's
 *    port), a secret set, no remove, and no project: none, said in the waiting tone.
 * 2. allow projects lists Tars's two projects, none ticked; one ticked and saved is the registry's and shows as its
 *    chip; a save the private folder refuses says not saved in the page's words and changes nothing (not staged when
 *    the run is root, whom a folder's mode does not stop).
 * 3. copy secret has Tars copy the default's secret, the webhook secret, which the page never holds.
 * 4. add gateway asks a name only; once added, Tars shows its secret in its own dialog and never in the page, and it is
 *    listed with its own two addresses, a secret set, a remove, and no project.
 * 5. replace asks once: cancel changes nothing; replace makes a new secret, shown by Tars and held nowhere in the page.
 * 6. remove asks once, then the gateway and its secret are gone; Hermes, the default, stays.
 * 7. Connection's Incoming webhooks row points to Gateways, and open gateways opens it.
 * Red on 721583f7 (this branch before the page: #469's 68d91cd9 with #484's d726356d): Hermes has no Gateways (1).
 * The artefact: values.json (the rows read, the registry before and after, which secrets Tars showed and copied, by
 * whose they were, never their values), the screenshots, and with E2E_TRACE=on the app's trace.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const TAILNET = 'tars-sandbox.example.ts.net';
type Handoffs = { copied: string[]; dialogs: { message: string; detail: string }[] };
type Gateway = { id: string; label: string; projects: string[] };

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-gateways-window-'));
  const dir = path.join(home, '.tars');
  const priv = path.join(home, '.tars-private');
  const billing = path.join(home, 'code', 'harbor-billing');
  const landing = path.join(home, 'code', 'landing-site');
  for (const d of [dir, billing, landing]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([billing, landing]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  /** The gateways as main keeps them (services/hermes-gateways.ts), or null while it has written none. */
  const registry = (): Gateway[] | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(priv, 'hermes-gateways.json'), 'utf8')).gateways;
    } catch {
      return null;
    }
  };
  const secretFile = (id: string) => path.join(priv, id === 'default' ? 'hermes-webhook-secret' : `hermes-webhook-${id}.secret`);
  const secretOf = (id: string) => (fs.existsSync(secretFile(id)) ? fs.readFileSync(secretFile(id), 'utf8').trim() : '');
  return { home, priv, billing, landing, registry, secretFile, secretOf };
}

/** Tars's own dialog and the clipboard, stood in for in the main process before anything is shown or copied. */
async function standInForHandoffs(app: ElectronApplication) {
  await app.evaluate(({ clipboard, dialog }) => {
    const g = globalThis as unknown as { __e2eHandoffs: { copied: string[]; dialogs: { message: string; detail: string }[] } };
    g.__e2eHandoffs = { copied: [], dialogs: [] };
    const write = (text: string) => { g.__e2eHandoffs.copied.push(text); };
    clipboard.writeText = write as typeof clipboard.writeText;
    const box = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string };
      g.__e2eHandoffs.dialogs.push({ message: String(options.message ?? ''), detail: String(options.detail ?? '') });
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBox = box;
    if (clipboard.writeText !== write || dialog.showMessageBox !== box) throw new Error('the clipboard or the dialog could not be stood in for');
  });
}
const handoffs = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __e2eHandoffs: Handoffs }).__e2eHandoffs);

/** Every place a page can hold a string: its text, its fields, its attributes. Which of `needles` it holds. */
const held = (page: Page, needles: string[]) => page.evaluate((list) => {
  const places = [
    document.body.innerText,
    ...Array.from(document.querySelectorAll('input, textarea')).map((e) => (e as HTMLInputElement).value),
    ...Array.from(document.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).map((a) => a.value)),
  ];
  return list.filter((n) => places.some((p) => p.includes(n)));
}, needles);

async function section(page: Page, group: string, child: string) {
  const nav = page.getByTestId('settings-nav');
  await nav.getByText(group, { exact: true }).first().click({ timeout: 30_000 });
  await nav.getByText(child, { exact: true }).first().click({ timeout: 10_000 });
}
const rowOf = (page: Page, scope: Page | Locator, label: string) =>
  scope.locator('[data-settings-row]').filter({ has: page.locator('[data-settings-label]', { hasText: new RegExp(`^${label}$`) }) });
const gatewayOf = (page: Page, label: string) => page.getByRole('region', { name: label, exact: true });

async function launch(base: number) {
  const sandbox = seed();
  const port = apiPort(base);
  const app = await launchSandboxed(electron, sandbox.home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await standInForHandoffs(app);
  await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-nav')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
  return { ...sandbox, port, app, page, errors };
}

const shell = ' (new interface)';

test(`settings, hermes, gateways: each hermes's addresses, its secret shown and copied by tars only, the projects it reaches, added, replaced and removed${shell}`, async () => {
  test.setTimeout(300_000);
  const s = await launch(31568);
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const { page } = s;
  try {
    // 1. Hermes, the default, from before 2.0.4: its two addresses, a secret set, no remove, no project.
    keep({ registryBefore: s.registry() });
    await section(page, 'Hermes', 'Gateways');
    const hermes = gatewayOf(page, 'Hermes');
    await expect(hermes).toBeVisible({ timeout: 30_000 });
    await expect(hermes).toContainText('HERMES');
    await expect(hermes).toContainText('default · /api/webhooks/hermes');
    await expect(rowOf(page, hermes, 'Address').locator('input')).toHaveValue(`https://${TAILNET}/api/webhooks/hermes`, { timeout: 30_000 });
    await expect(rowOf(page, hermes, 'Address')).toContainText(`tailscale serve active · ${TAILNET}: a Hermes on another machine posts here.`);
    await expect(rowOf(page, hermes, 'On this machine').locator('input')).toHaveValue(`http://127.0.0.1:${s.port}/api/webhooks/hermes`);
    await expect(rowOf(page, hermes, 'Secret')).toContainText('a secret is set');
    await expect(rowOf(page, hermes, 'Projects')).toContainText('none');
    await expect(rowOf(page, hermes, 'Projects')).toContainText('Reaches no project yet. Its Hermes jobs get not found until you allow one.');
    await expect(hermes.getByRole('button', { name: 'remove', exact: true })).toHaveCount(0);
    keep({ default: { rows: await rowOf(page, hermes, '.+').locator('[data-settings-label]').allTextContents() } });
    await stepShot(page, '01-hermes-reaches-no-project');

    // 2. allow projects: Tars's two projects, none ticked; one saved is the registry's and shows as its chip.
    await rowOf(page, hermes, 'Projects').getByRole('button', { name: 'allow projects', exact: true }).click();
    await expect(hermes.getByRole('checkbox')).toHaveCount(2);
    await expect(hermes.getByRole('checkbox', { name: 'harbor-billing', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(hermes.getByRole('checkbox', { name: 'landing-site', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(rowOf(page, hermes, 'Projects')).toContainText('Tick the projects this gateway may reach.');
    await hermes.getByRole('checkbox', { name: 'harbor-billing', exact: true }).click();
    await expect(hermes.getByRole('checkbox', { name: 'harbor-billing', exact: true })).toHaveAttribute('aria-checked', 'true');
    await stepShot(page, '02-allowing-projects');
    await hermes.getByRole('button', { name: 'save', exact: true }).click();
    await expect.poll(() => s.registry()?.find((g) => g.id === 'default')?.projects, { timeout: 15_000 }).toEqual([s.billing]);
    await expect(hermes.getByRole('checkbox')).toHaveCount(0);
    await expect(rowOf(page, hermes, 'Projects')).toContainText('harbor-billing');
    await expect(rowOf(page, hermes, 'Projects')).toContainText('A job for any other project is answered not found.');

    // A save the private folder refuses: said in the page's words, nothing changed.
    const root = process.getuid?.() === 0;
    if (!root) {
      await rowOf(page, hermes, 'Projects').getByRole('button', { name: 'change', exact: true }).click();
      await hermes.getByRole('checkbox', { name: 'landing-site', exact: true }).click();
      fs.chmodSync(s.priv, 0o500);
      try {
        await hermes.getByRole('button', { name: 'save', exact: true }).click();
        await expect(hermes).toContainText('Not saved: Tars could not write its private settings (permission denied).', { timeout: 15_000 });
      } finally {
        fs.chmodSync(s.priv, 0o700);
      }
      expect(s.registry()?.find((g) => g.id === 'default')?.projects).toEqual([s.billing]);
      await expect(hermes.getByRole('checkbox')).toHaveCount(0);
      await expect(rowOf(page, hermes, 'Projects')).not.toContainText('landing-site');
      await stepShot(page, '03-not-saved');
    }
    keep({ notSavedStaged: !root, registryAllowed: s.registry()?.map((g) => ({ id: g.id, projects: g.projects.map((p) => path.basename(p)) })) });

    // 3. copy secret: Tars copies the default's secret, the webhook's; the page holds it nowhere.
    await rowOf(page, hermes, 'Secret').getByRole('button', { name: 'copy secret', exact: true }).click();
    await expect(rowOf(page, hermes, 'Secret').getByRole('button', { name: 'copied', exact: true })).toBeVisible();
    const webhook = s.secretOf('default');
    expect(webhook.length).toBeGreaterThan(20);
    expect((await handoffs(s.app)).copied).toEqual([webhook]);
    expect(await held(page, [webhook]), 'the webhook secret is held nowhere').toEqual([]);

    // 4. add gateway: a name only; Tars shows the new secret in its own dialog, the page lists the gateway.
    await page.getByRole('button', { name: 'add gateway', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Gateway name', exact: true });
    await expect(name).toBeFocused();
    await expect(page.getByRole('button', { name: 'add', exact: true })).toBeDisabled();
    await name.fill('Hermes on the VPS');
    await stepShot(page, '04-adding-a-gateway');
    await page.getByRole('button', { name: 'add', exact: true }).click();
    const vps = gatewayOf(page, 'Hermes on the VPS');
    await expect(vps).toBeVisible({ timeout: 15_000 });
    await expect(name).toHaveCount(0);
    const added = s.registry()?.find((g) => g.label === 'Hermes on the VPS');
    expect(added?.id).toMatch(/^gw-[0-9a-f]{6}$/);
    const id = added!.id;
    const minted = s.secretOf(id);
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    await expect.poll(async () => (await handoffs(s.app)).dialogs.length, { timeout: 15_000 }).toBe(1);
    const shown = (await handoffs(s.app)).dialogs[0];
    expect(shown.message).toBe('Secret of the Hermes gateway "Hermes on the VPS"');
    expect(shown.detail).toContain(minted);
    await expect(vps).toContainText('HERMES ON THE VPS');
    await expect(vps).toContainText(`${id} · /api/webhooks/hermes/${id}`);
    await expect(rowOf(page, vps, 'Address').locator('input')).toHaveValue(`https://${TAILNET}/api/webhooks/hermes/${id}`);
    await expect(rowOf(page, vps, 'On this machine').locator('input')).toHaveValue(`http://127.0.0.1:${s.port}/api/webhooks/hermes/${id}`);
    await expect(rowOf(page, vps, 'Secret')).toContainText('a secret is set');
    await expect(rowOf(page, vps, 'Projects')).toContainText('none');
    await expect(vps.getByRole('button', { name: 'remove', exact: true })).toBeVisible();
    expect(await held(page, [webhook, minted]), 'no secret is held after the add').toEqual([]);
    await stepShot(page, '05-gateway-added');
    await rowOf(page, vps, 'Secret').getByRole('button', { name: 'copy secret', exact: true }).click();
    await expect(rowOf(page, vps, 'Secret').getByRole('button', { name: 'copied', exact: true })).toBeVisible();
    expect((await handoffs(s.app)).copied).toEqual([webhook, minted]);

    // 5. replace asks once: cancel changes nothing; replace makes a new secret, shown by Tars only.
    await rowOf(page, vps, 'Secret').getByRole('button', { name: 'replace', exact: true }).click();
    const replacing = page.getByRole('alertdialog', { name: 'Replace the secret of Hermes on the VPS', exact: true });
    await expect(replacing).toContainText("Replace this gateway's secret? The one its Hermes holds stops working now, and Tars shows the new one once.");
    await stepShot(page, '06-replace-asks');
    await replacing.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(replacing).toHaveCount(0);
    expect(s.secretOf(id)).toBe(minted);
    expect((await handoffs(s.app)).dialogs).toHaveLength(1);
    await rowOf(page, vps, 'Secret').getByRole('button', { name: 'replace', exact: true }).click();
    await replacing.getByRole('button', { name: 'replace', exact: true }).click();
    await expect.poll(() => s.secretOf(id), { timeout: 15_000 }).not.toBe(minted);
    const rotated = s.secretOf(id);
    await expect.poll(async () => (await handoffs(s.app)).dialogs.length, { timeout: 15_000 }).toBe(2);
    expect((await handoffs(s.app)).dialogs[1].detail).toContain(rotated);
    await expect(replacing).toHaveCount(0);
    expect(await held(page, [webhook, minted, rotated]), 'no secret is held after the replace').toEqual([]);

    // 6. remove asks once; then the gateway and its secret are gone, Hermes stays.
    await vps.getByRole('button', { name: 'remove', exact: true }).click();
    const removing = page.getByRole('alertdialog', { name: 'Remove Hermes on the VPS', exact: true });
    await expect(removing).toContainText('Remove Hermes on the VPS? Its address stops answering now, and its secret is deleted.');
    await stepShot(page, '07-remove-asks');
    await removing.getByRole('button', { name: 'remove', exact: true }).click();
    await expect(vps).toHaveCount(0, { timeout: 15_000 });
    expect(s.registry()?.map((g) => g.id)).toEqual(['default']);
    expect(fs.existsSync(s.secretFile(id))).toBe(false);
    await expect(hermes).toBeVisible();
    const dialogs = (await handoffs(s.app)).dialogs;
    keep({
      added: { id, secretLength: minted.length },
      dialogs: dialogs.map((d) => ({ message: d.message, holds: d.detail.includes(minted) ? 'the added secret' : d.detail.includes(rotated) ? 'the replaced secret' : 'neither' })),
      copied: (await handoffs(s.app)).copied.map((c) => (c === webhook ? 'default' : c === minted ? id : 'other')),
      registryAfter: s.registry()?.map((g) => ({ id: g.id, projects: g.projects.map((p) => path.basename(p)) })),
    });

    // 7. Connection's Incoming webhooks row points to Gateways.
    await section(page, 'Hermes', 'Connection');
    const pointer = rowOf(page, page, 'Incoming webhooks');
    await expect(pointer).toContainText('Each Hermes that hands Tars work has its own address, secret and projects, set in Gateways.', { timeout: 30_000 });
    await expect(pointer.locator('input')).toHaveCount(0);
    await stepShot(page, '08-connection-points-to-gateways');
    await pointer.getByRole('button', { name: 'open gateways', exact: true }).click();
    await expect(gatewayOf(page, 'Hermes')).toBeVisible({ timeout: 15_000 });

    keep({ pageErrors: s.errors });
    expect(s.errors, s.errors.join('\n')).toEqual([]);
  } finally {
    fs.chmodSync(s.priv, 0o700);
    await s.app.close().catch(() => { /* gone */ });
    await removeHome(s.home);
  }
});
