import { test, expect, _electron as electron } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { inheritable, launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { apiPort } from './ports.mjs';

/**
 * A test build never passes for the maintainer's Tars (the plan's point 13, 19/10). On 18/10 two Uncaught
 * Exception boxes from the QA's copy, a Tars like any other in the Dock, looked like his own Tars looping.
 * `npm run electron:pack` (the build scripts/sandbox.sh starts, never a release's) is "Tars Sandbox":
 *
 * 1. the bundle: named "Tars Sandbox", its own bundle id (macOS keeps its settings, its notifications and its
 *    Application Support folder apart from Tars's), and its own icon, build/sandbox-icon.icns, not Tars's;
 * 2. launched, it calls itself "Tars Sandbox", and its menu bar item's menu says so ("Quit Tars Sandbox");
 * 3. (the Audit's M1 on #477) started on the account's own home, as the Finder, the Dock or `open` start it, it
 *    refuses: it exits with 1, says why and how to start it, opens no window, and writes nothing in that home. The
 *    real home cannot be handed to a test, so the home the password database names is a stand-in here
 *    (DOROTHY_E2E_PASSWD_HOME, read under DOROTHY_E2E only), set to the temporary HOME it runs on.
 * 4. (the Audit's I-1 on #632) the window's fonts, committed under public/fonts and served from the export over
 *    app://, which no spec run under next dev reaches: in the packed window the three families load, and the main
 *    process never says "File not found: .../fonts/". Red on a pack whose public/fonts was moved aside.
 *
 * Needs the packed app: TARS_PACKED_APP=<path to the .app> (npm run electron:pack writes
 * release/mac-arm64/Tars Sandbox.app). Skipped without it, as a live spec is. macOS only: electron:pack is --mac.
 * Red on main (e2363ae0), whose electron:pack builds release/mac-arm64/Tars.app: Tars's name, id and icon.
 * 3 red on 615b16ff's build: it starts on that home, and writes its data folder there.
 * The artefact: values.json (the bundle's Info.plist as read, the icon's digest, the names read in the app).
 */

const APP = process.env.TARS_PACKED_APP;
const sha = (file: string) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

test.skip(!APP || process.platform !== 'darwin', 'TARS_PACKED_APP names the app npm run electron:pack built (macOS)');

test('a test build is Tars Sandbox: its name, its bundle id, its icon, and what it calls itself', async () => {
  test.setTimeout(120_000);
  const app = APP!;
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as Record<string, string>;
  const iconName = info.CFBundleIconFile.endsWith('.icns') ? info.CFBundleIconFile : `${info.CFBundleIconFile}.icns`;
  const icon = sha(path.join(app, 'Contents', 'Resources', iconName));
  const values: Record<string, unknown> = {
    app, bundle: { CFBundleName: info.CFBundleName, CFBundleDisplayName: info.CFBundleDisplayName, CFBundleIdentifier: info.CFBundleIdentifier, CFBundleExecutable: info.CFBundleExecutable, CFBundleIconFile: info.CFBundleIconFile },
    icon, sandboxIcon: sha(path.resolve('build', 'sandbox-icon.icns')), tarsIcon: sha(path.resolve('public', 'icon.icns')),
  };
  recordValues(values);

  // 1. The bundle.
  expect.soft(info.CFBundleName).toBe('Tars Sandbox');
  expect.soft(info.CFBundleIdentifier).toBe('xyz.cooperlabs.tars.sandbox');
  expect.soft(values.sandboxIcon, 'build/sandbox-icon.icns').not.toBeNull();
  expect.soft(icon, 'its icon is the sandbox\'s').toBe(values.sandboxIcon);
  expect.soft(icon, 'its icon is not Tars\'s').not.toBe(values.tarsIcon);

  // 2. Launched, on a sandbox HOME and profile, as scripts/sandbox.sh starts it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-packed-'));
  // Through the fixture, as every launch: HOME, CFFIXED_USER_HOME and the profile in the sandbox, and none of the caller's
  // CLAUDE_, DOROTHY_, ANTHROPIC_ or TARS_ variables (an agent running this spec would hand the app its live token).
  const launched = await launchSandboxed(electron, home, {
    executablePath: path.join(app, 'Contents', 'MacOS', info.CFBundleExecutable),
    env: { DOROTHY_API_PORT: apiPort(31388), DOROTHY_E2E: '1' },
  });
  try {
    const seen = await launched.evaluate(({ app }) => {
      const req = process.mainModule!.require;
      const { join, dirname } = req('path') as typeof import('path');
      const tray = req(join(dirname(process.mainModule!.filename), 'core', 'tray-manager.js'));
      return { name: app.getName(), trayMenu: tray.trayContextMenu().items.map((i: { label: string }) => i.label) as string[] };
    });
    Object.assign(values, { seen });
    recordValues(values);
    expect.soft(seen.name).toBe('Tars Sandbox');
    expect.soft(seen.trayMenu).toContain('Quit Tars Sandbox');

    // 4. The fonts, as the packed window loads them: what the main process says from here on, the window loaded again
    //    so that its font requests are among it, and each family asked for.
    const said: string[] = [];
    launched.process().stdout?.on('data', (d) => said.push(String(d)));
    launched.process().stderr?.on('data', (d) => said.push(String(d)));
    const page = await launched.firstWindow();
    await page.reload({ waitUntil: 'load' });
    const fonts = await page.evaluate(async () => {
      for (const family of ['Roboto Condensed', 'Roboto Mono', 'Instrument Serif']) await document.fonts.load(`16px "${family}"`).catch(() => []);
      await document.fonts.ready;
      const faces = [...document.fonts];
      return {
        loaded: [...new Set(faces.filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].sort(),
        failed: faces.filter((f) => f.status === 'error').map((f) => `${f.family} ${f.weight} ${f.style}`),
      };
    });
    const notFound = said.join('').split('\n').filter((line) => /File not found: .*[/\\]fonts[/\\]/.test(line));
    Object.assign(values, { fonts, notFound });
    recordValues(values);
    expect.soft(fonts.loaded, 'the three families load in the packed window').toEqual(['Instrument Serif', 'Roboto Condensed', 'Roboto Mono']);
    expect.soft(notFound, 'no font missing from the export').toEqual([]);
  } finally {
    await launched.close().catch(() => undefined);
    await removeHome(home);
  }
});

test('a test build started on the account\'s own home refuses to start, and touches nothing there', async () => {
  test.setTimeout(60_000);
  const app = APP!;
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })) as Record<string, string>;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-packed-own-home-'));
  const child = spawn(path.join(app, 'Contents', 'MacOS', info.CFBundleExecutable), [`--user-data-dir=${path.join(home, 'electron-profile')}`], {
    // None of the caller's CLAUDE_, DOROTHY_, ANTHROPIC_ or TARS_ variables, as launchSandboxed hands none (the Audit's Low on train 1).
    env: { ...inheritable(process.env), HOME: home, CFFIXED_USER_HOME: home, DOROTHY_API_PORT: apiPort(31387), DOROTHY_E2E: '1', DOROTHY_E2E_PASSWD_HOME: home },
  });
  let said = '';
  child.stdout.on('data', (d) => { said += d; });
  child.stderr.on('data', (d) => { said += d; });
  const code = await new Promise<number | null | 'still running'>((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 20_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  if (code === 'still running') child.kill('SIGTERM');
  // What Tars itself writes in a home: Electron's own folders (its profile, macOS's Library) are not Tars's to hold.
  const left = fs.readdirSync(home).filter((n) => ['.tars', '.tars', '.tars-private', '.claude', '.claude.json'].includes(n)).sort();
  recordValues({ app, code, said: said.slice(-2000), left });
  try {
    expect.soft(code, 'its exit').toBe(1);
    expect.soft(said).toContain('scripts/sandbox.sh');
    expect.soft(left, 'written in the home it refused').toEqual([]);
  } finally {
    await removeHome(home);
  }
});
