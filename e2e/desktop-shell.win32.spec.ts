import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { assertWindowOnScreen, launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, seedSandbox, settleFleet, splashGone, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

/**
 * The Windows desktop shell, driven as a user drives it:
 *
 * - The title bar: no frame, the native caption buttons over the top 32 px in the theme's
 *   background, following it when the theme switches; the top strip and the
 *   page header move the window while every header action stays clickable
 *   (a real OS click, since CDP input never meets the drag regions), and no
 *   header action on any page reaches under the caption buttons.
 * - The keys: no application menu. Real OS keystrokes, since menu accelerators
 *   never see CDP input (measured): what a focused
 *   terminal's PTY receives for Ctrl+W, Ctrl+R and the rest, that nothing
 *   reloads, zooms, opens DevTools or closes; Ctrl+digit is a page and
 *   Alt+digit a panel, neither typed into the program; Ctrl+C copies a
 *   selection, Ctrl+V pastes.
 * - The tray: the icon's sizes, its menu, the panel over the taskbar, and the
 *   click that closed the panel not reopening it.
 * - Close and a second launch: a second launch shows the first window and
 *   exits; the first close
 *   explains once, in the real dialog; close hides with the agents still
 *   running; Quit Tars in the tray menu ends the app and its terminals.
 * - The shell: the one picked in Settings > Terminal is saved, reads back after a
 *   reload, and is the shell a new quick terminal runs.
 *
 * Windows only. Every run leaves values.json and the screenshots, native
 * chrome included, in its output folder.
 *
 *   E2E_PORT_OFFSET=70 npx playwright test e2e/desktop-shell.win32.spec.ts
 *
 * Real input takes the foreground for a moment: the helper refuses to type or
 * click unless the sandbox window is in front at that instant.
 */

test.skip(process.platform !== 'win32', 'the Windows desktop shell');
test.describe.configure({ mode: 'serial' });

const DIST = path.resolve('electron', 'dist');
const HELPER = path.resolve('e2e', 'win32-desktop.ps1');
const COMMAND = 'E2E_PORT_OFFSET=70 npx playwright test e2e/desktop-shell.win32.spec.ts';

function desktop(args: string[]): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args], { encoding: 'utf8' }).trim();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Runs `src` in the main process with the main window as `w` and the dist folder as `dist`. */
async function inMain<T>(app: ElectronApplication, src: string, arg?: unknown): Promise<T> {
  return app.evaluate((electronModule, { dist, src, arg }) => {
    const req = process.mainModule!.require;
    const w = req(`${dist}/core/window-manager.js`).getMainWindow();
    return new Function('w', 'electron', 'req', 'dist', 'arg', src)(w, electronModule, req, dist, arg);
  }, { dist: DIST, src, arg }) as Promise<T>;
}

async function hwndOf(app: ElectronApplication): Promise<string> {
  return inMain(app, 'return w.getNativeWindowHandle().readBigInt64LE(0).toString();');
}

/** The window as the screen shows it, caption buttons included. */
async function shotWindow(app: ElectronApplication, name: string): Promise<string> {
  const hwnd = await hwndOf(app);
  await inMain(app, "w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop();");
  await sleep(500);
  await assertWindowOnScreen(app);
  const frame = JSON.parse(desktop(['-Mode', 'frame', '-Hwnd', hwnd]));
  const out = test.info().outputPath(`${name}.png`);
  desktop(['-Mode', 'capture', '-X', String(frame.x), '-Y', String(frame.y), '-W', String(frame.width), '-H', String(frame.height), '-Out', out]);
  await inMain(app, 'w.setAlwaysOnTop(false);');
  return out;
}

/** The colour at a screen point, read by the app from a capture of it. */
async function screenColour(app: ElectronApplication, x: number, y: number, name: string): Promise<string> {
  const out = test.info().outputPath(`${name}.png`);
  await inMain(app, "w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop();");
  await sleep(500);
  await assertWindowOnScreen(app);
  desktop(['-Mode', 'capture', '-X', String(x), '-Y', String(y), '-W', '4', '-H', '4', '-Out', out]);
  await inMain(app, 'w.setAlwaysOnTop(false);');
  return app.evaluate(({ nativeImage }, file) => {
    const b = nativeImage.createFromPath(file).toBitmap();
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex(b[2])}${hex(b[1])}${hex(b[0])}`.toUpperCase();
  }, out);
}

/** A real OS click at the centre of a page element. */
async function osClick(app: ElectronApplication, page: Page, locator: ReturnType<Page['locator']>): Promise<string> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to click');
  const content = await inMain<{ x: number; y: number }>(app, 'w.show(); w.focus(); return w.getContentBounds();');
  const x = Math.round(content.x + box.x + box.width / 2);
  const y = Math.round(content.y + box.y + box.height / 2);
  return desktop(['-Mode', 'click', '-Hwnd', await hwndOf(app), '-X', String(x), '-Y', String(y)]);
}

async function osKeys(app: ElectronApplication, combo: string): Promise<string> {
  await inMain(app, 'w.show(); w.moveTop(); w.focus();');
  await sleep(300);
  return desktop(['-Mode', 'keys', '-Hwnd', await hwndOf(app), '-Combo', combo]);
}

async function launch(home: string, port: number): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(port), DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.waitForLoadState('domcontentloaded');
  // Shown and in front: real input and native captures need the window on screen.
  await inMain(app, 'w.show(); w.focus();');
  await assertWindowOnScreen(app);
  return { app, page, errors };
}

/**
 * Waits for the Windows drag rules to be in force on the page just loaded:
 * its header drawn and computing `-webkit-app-region: drag`. WindowsCaption
 * renders those rules only after hydration, once the bridge says win32, so a
 * fixed wait measured the page before them on a slow runner: every header
 * action read `none`, not `no-drag` (/skills and /crons, on CI).
 * Rules that never come fail here, naming the route.
 */
async function captionRulesInForce(page: Page, route: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const headers = [...document.querySelectorAll('main header')];
    return headers.length > 0 && headers.every(h => getComputedStyle(h).getPropertyValue('-webkit-app-region') === 'drag');
  }), { message: `${route}: the page header is drawn under the Windows drag rules`, timeout: 30_000 }).toBe(true);
}

/** Every write into every terminal, recorded in the main process. */
async function recordPtyWrites(app: ElectronApplication): Promise<void> {
  await app.evaluate((_e, dist) => {
    const pm = process.mainModule!.require(`${dist}/core/pty-manager.js`);
    const g = globalThis as unknown as { __ptyLog: { id: string; d: string }[] };
    g.__ptyLog ||= [];
    for (const map of [pm.ptyProcesses, pm.quickPtyProcesses]) {
      for (const [id, p] of map as Map<string, { write: (d: string) => void; __wrapped?: boolean }>) {
        if (p.__wrapped) continue;
        const orig = p.write.bind(p);
        p.write = (d: string) => { g.__ptyLog.push({ id, d: String(d) }); return orig(d); };
        p.__wrapped = true;
      }
    }
  }, DIST);
}

async function takePtyWrites(app: ElectronApplication): Promise<{ id: string; d: string }[]> {
  return app.evaluate(() => {
    const g = globalThis as unknown as { __ptyLog?: { id: string; d: string }[] };
    const log = g.__ptyLog ?? [];
    g.__ptyLog = [];
    return log;
  });
}

/**
 * The QA agent (a4) runs a fake CLI that asks for bracketed paste, as Claude
 * Code and every readline program do: its multi-line paste is the proof that
 * Ctrl+V goes through xterm's own paste and not around it.
 */
function seedBracketedPasteCli(home: string): void {
  const cli = writeNodeCli(path.join(home, 'bin', 'bracketed-cli.cjs'), [
    "process.stdout.write('\\x1b[2J\\x1b[Ha bracketed paste CLI of the E2E sandbox\\r\\n> \\x1b[?2004h');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  const file = path.join(home, '.dorothy', 'agents.json');
  const agents = JSON.parse(fs.readFileSync(file, 'utf-8')).map((a: { id: string }) => (a.id === 'a4' ? { ...a, cliPath: cli } : a));
  fs.writeFileSync(file, JSON.stringify(agents, null, 2));
}

const SETTINGS_FILE = (home: string) => path.join(home, '.dorothy', 'app-settings.json');
const readSettings = (home: string) => JSON.parse(fs.readFileSync(SETTINGS_FILE(home), 'utf-8'));

test.describe('the Windows desktop shell', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;
  let errors: string[];

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-desktop-shell-'));
    seedSandbox(home);
    seedBracketedPasteCli(home);
    ({ app, page, errors } = await launch(home, 31461));
    await settleFleet(app);
  });

  test.afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('title bar: the caption overlay is there, 32 px, and follows the theme', async () => {
    test.setTimeout(180_000);
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const overlay = await page.evaluate(() => {
      const o = (navigator as unknown as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
      return o ? { visible: o.visible, rect: o.getTitlebarAreaRect().toJSON(), innerWidth } : null;
    });
    expect(overlay?.visible).toBe(true);
    expect(overlay?.rect.height).toBe(32);
    const captionWidth = overlay!.innerWidth - overlay!.rect.width;
    expect(captionWidth).toBeGreaterThan(100);
    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null);
    expect(menu, 'no application menu').toBe(true);

    // Every call the renderer makes to recolour the caption buttons.
    await inMain(app, `
      globalThis.__overlayCalls = [];
      const orig = w.setTitleBarOverlay.bind(w);
      w.setTitleBarOverlay = (o) => { globalThis.__overlayCalls.push(o); return orig(o); };`);

    const content = await inMain<{ x: number; y: number; width: number }>(app, 'return w.getContentBounds();');
    // Between the header and the minimise glyph: pure caption background.
    const probe = { x: content.x + content.width - captionWidth + 6, y: content.y + 4 };
    const colours: Record<string, string> = {};
    const shots: string[] = [];
    colours.dark = await screenColour(app, probe.x, probe.y, 'caption-dark');
    for (const route of ['/agents', '/settings', '/', '/kanban']) {
      await page.goto(`${DEV_URL}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      shots.push(await shotWindow(app, `window-dark${route === '/' ? '-dashboard' : route.replace(/\//g, '-')}`));
    }

    await page.getByRole('button', { name: 'Light Mode' }).click();
    await page.waitForTimeout(800);
    colours.light = await screenColour(app, probe.x, probe.y, 'caption-light');
    for (const route of ['/agents', '/settings', '/', '/kanban']) {
      await page.goto(`${DEV_URL}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      shots.push(await shotWindow(app, `window-light${route === '/' ? '-dashboard' : route.replace(/\//g, '-')}`));
    }
    await page.getByRole('button', { name: 'Dark Mode' }).click();
    await page.waitForTimeout(800);
    colours.darkAgain = await screenColour(app, probe.x, probe.y, 'caption-dark-again');
    const calls = await app.evaluate(() => (globalThis as unknown as { __overlayCalls: unknown[] }).__overlayCalls);

    recordValues({ command: COMMAND, overlay, captionWidth, overlayCalls: calls, captionColours: colours, windowShots: shots });
    // The tokens as the page reads them, whatever their case.
    const lower = (calls as { color: string; symbolColor: string; height: number }[]).map(c => ({ ...c, color: c.color.toLowerCase(), symbolColor: c.symbolColor.toLowerCase() }));
    expect(lower).toContainEqual({ color: '#faf9f7', symbolColor: '#1e1e1e', height: 32 });
    expect(lower.at(-1)).toEqual({ color: '#121212', symbolColor: '#f5f4f2', height: 32 });
    expect(colours).toEqual({ dark: '#121212', light: '#FAF9F7', darkAgain: '#121212' });
  });

  test('title bar: no header action on any page reaches under the caption buttons or the drag strip', async () => {
    test.setTimeout(240_000);
    const routes = ['/', '/chat', '/agents', '/kanban', '/vault', '/projects', '/skills', '/crons', '/review', '/logs', '/usage', '/memory', '/whats-new', '/settings'];
    const report: Record<string, unknown> = {};
    const offenders: string[] = [];
    for (const route of routes) {
      await page.goto(`${DEV_URL}${route}`, { waitUntil: 'domcontentloaded' });
      await splashGone(page);
      await captionRulesInForce(page, route);
      const found = await page.evaluate(() => {
        const o = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay;
        const bar = o.getTitlebarAreaRect();
        const interactive = [...document.querySelectorAll('main button, main a, main input, main select, main textarea, main [role="button"]')]
          .map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0);
        const header = interactive.filter(({ el }) => el.closest('main header'));
        return {
          headerActions: header.map(({ el, r }) => ({ text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24), top: Math.round(r.top), right: Math.round(r.right) })),
          // Anything clickable in the top 32 px: under the caption buttons, or under the drag strip.
          underBar: interactive.filter(({ r }) => r.top < bar.height).map(({ el, r }) => `${(el.textContent || '').trim().slice(0, 24)}@${Math.round(r.left)},${Math.round(r.top)}`),
          headerNoDrag: header.every(({ el }) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'no-drag'),
          headerDrag: [...document.querySelectorAll('main header')].every(h => getComputedStyle(h).getPropertyValue('-webkit-app-region') === 'drag'),
        };
      });
      const minTop = Math.min(...found.headerActions.map(a => a.top), Infinity);
      report[route] = { ...found, clearance: Number.isFinite(minTop) ? minTop - 32 : null };
      if (found.underBar.length) offenders.push(`${route}: ${found.underBar.join(', ')}`);
      if (!found.headerNoDrag) offenders.push(`${route}: a header action is inside the drag region`);
    }
    recordValues({ headerClearance: report });
    expect(offenders).toEqual([]);
    expect((report['/agents'] as { clearance: number }).clearance).toBeGreaterThanOrEqual(4);
  });

  test('title bar: a real click on a header action and on the dialog it opens goes through', async () => {
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const add = page.locator('main header').getByRole('button', { name: '+ Agent' });
    const clicked = await osClick(app, page, add);
    await page.waitForTimeout(1200);
    const dialog = page.getByRole('dialog').first();
    const opened = await dialog.isVisible().catch(() => false);
    await page.screenshot({ path: test.info().outputPath('os-click-new-agent.png') });
    // And out again, by a real click on the dialog's own Cancel.
    const cancel = page.getByRole('button', { name: 'Cancel' }).first();
    const cancelVisible = await cancel.isVisible().catch(() => false);
    if (cancelVisible) await osClick(app, page, cancel);
    await page.waitForTimeout(800);
    const closed = !(await dialog.isVisible().catch(() => false));
    recordValues({ headerOsClick: { clicked, opened, cancelVisible, closed } });
    expect(opened).toBe(true);
    expect(closed).toBe(true);
  });

  test('title bar: overlays anchored to the top keep their controls out from under the caption band', async () => {
    test.setTimeout(180_000);
    // Every visible control above the band's bottom edge: under the native
    // caption buttons (right of the title bar area), or under the drag strip.
    const underBand = () => page.evaluate(() => {
      const bar = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay.getTitlebarAreaRect();
      return [...document.querySelectorAll('button, a, input, select, textarea, [role="button"]')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width > 0 && r.height > 0 && r.top < bar.height && getComputedStyle(el).visibility !== 'hidden')
        .map(({ el, r }) => `${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24)}@${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.bottom)}${r.right > bar.width ? ' under the caption buttons' : ''}`);
    });
    const found: Record<string, string[]> = {};

    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'open', exact: true }).first().click();
    await page.waitForTimeout(1200);
    found.projectsDrawer = await underBand();
    await shotWindow(app, 'overlay-projects-drawer');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'close', exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(600);

    await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    // Fullscreen is a button of the panel header since upstream 1.9.2, no
    // longer an item of its menu; the same button exits it.
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).first().click();
    await page.waitForTimeout(1200);
    found.panelFullscreen = await underBand();
    await shotWindow(app, 'overlay-panel-fullscreen');
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.waitForTimeout(600);

    // The broadcast banner (Ctrl+Shift+B on the board), which holds no control:
    // where its top edge sits against the band.
    await page.locator('main h1').first().click();
    await page.keyboard.press('Control+Shift+B');
    const banner = page.getByText('Broadcast Mode Active', { exact: false });
    await banner.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(600);
    const bannerTop = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div.fixed')].find(d => d.textContent?.includes('Broadcast Mode Active'));
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    });
    await shotWindow(app, 'overlay-broadcast-banner');
    await page.keyboard.press('Control+Shift+B');
    await page.waitForTimeout(600);

    // The board's own fullscreen (TerminalsView/index.tsx) has no control that
    // opens it today; its container, with its classes, gets the same rule.
    const boardFullscreenPadding = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'flex flex-col overflow-hidden fixed inset-0 z-[100] bg-background window-no-drag pt-7';
      document.body.appendChild(el);
      const padding = parseFloat(getComputedStyle(el).paddingTop);
      el.remove();
      return padding;
    });

    recordValues({ topAnchoredOverlays: found, bannerTop, boardFullscreenPadding });
    expect(found).toEqual({ projectsDrawer: [], panelFullscreen: [] });
    expect(bannerTop).toBeGreaterThanOrEqual(32);
    expect(boardFullscreenPadding).toBeGreaterThanOrEqual(32);
  });

  test('keys: what a focused terminal receives, and what no key does any more', async () => {
    test.setTimeout(240_000);
    let loads = 0;
    page.on('load', () => { loads++; });
    const state = () => inMain<{ devtools: boolean; zoom: number; visible: boolean; url: string }>(app,
      'return { devtools: w.webContents.isDevToolsOpened(), zoom: w.webContents.getZoomLevel(), visible: w.isVisible(), url: w.webContents.getURL() };');

    const focusTerminal = async (index = 0) => {
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);
      await recordPtyWrites(app);
      const box = await page.locator('.xterm-screen').nth(index).boundingBox();
      await page.mouse.click(box!.x + 60, box!.y + 60);
      await page.waitForTimeout(300);
      await takePtyWrites(app);
      await page.keyboard.type('x');
      await page.waitForTimeout(400);
      return (await takePtyWrites(app)).map(p => p.id)[0] ?? null;
    };

    const results: Record<string, unknown>[] = [];
    const inTerminal = async (combo: string, index = 0) => {
      const ptyId = await focusTerminal(index);
      const before = await state();
      const loadsBefore = loads;
      const sent = await osKeys(app, combo);
      await page.waitForTimeout(1500);
      const after = await state();
      const log = await takePtyWrites(app);
      const r = {
        combo, focus: 'terminal', sent, ptyId,
        ptyReceived: log.filter(l => l.id === ptyId).map(l => JSON.stringify(l.d)).join(' ') || '(nothing)',
        reloaded: loads > loadsBefore, visible: after.visible,
        devtoolsOpened: after.devtools && !before.devtools, zoomChanged: after.zoom !== before.zoom,
        url: after.url.replace(DEV_URL, ''),
      };
      results.push(r);
      if (after.devtools) await inMain(app, 'w.webContents.closeDevTools();');
      if (after.zoom !== 0) await inMain(app, 'w.webContents.setZoomLevel(0);');
      return r;
    };

    const w = await inTerminal('ctrl+w');
    const r = await inTerminal('ctrl+r');
    const shiftR = await inTerminal('ctrl+shift+r');
    const devtools = await inTerminal('ctrl+shift+i');
    const zoom = await inTerminal('ctrl+-');
    const page2 = await inTerminal('ctrl+2');

    // Alt+digit: each focuses its own panel, and the program sees no ESC digit.
    await focusTerminal(0);
    // Which terminal holds the keyboard: the index of the focused xterm input.
    const focusedTerminal = () => page.evaluate(() =>
      [...document.querySelectorAll('textarea.xterm-helper-textarea')].indexOf(document.activeElement as HTMLTextAreaElement));
    const panels: Record<string, number> = {};
    for (const combo of ['alt+2', 'alt+1']) {
      await osKeys(app, combo);
      await page.waitForTimeout(600);
      const leaked = await takePtyWrites(app);
      panels[combo] = await focusedTerminal();
      results.push({ combo, focus: 'terminal', ptyReceived: leaked.map(l => JSON.stringify(l.d)).join(' ') || '(nothing)', focusedTerminal: panels[combo] });
    }

    // The clipboard, as Windows Terminal does it. The user's clipboard text is put back after.
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
    let copied = '';
    let pasted = '';
    let bracketed = '';
    try {
      // Panel 3: panel 1 has had its keys, and the ^C below ends the fake CLI of panel 4.
      const pty = await focusTerminal(2);
      // The word `sandbox` of the fake CLI's banner, as xterm draws it in the focused panel.
      const word = await page.evaluate(() => {
        const input = document.activeElement as HTMLElement;
        const terminal = input.closest('.xterm') ?? document;
        for (const row of terminal.querySelectorAll('.xterm-rows > div')) {
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = (n.textContent ?? '').indexOf('sandbox');
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(n, at);
            range.setEnd(n, at + 'sandbox'.length);
            const r = range.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });
      expect(word, 'the fake CLI banner is on screen').not.toBeNull();
      await app.evaluate(({ clipboard }) => clipboard.writeText('before-copy'));
      await page.mouse.dblclick(word!.x, word!.y);
      await page.waitForTimeout(300);
      await takePtyWrites(app);
      await osKeys(app, 'ctrl+c');
      await page.waitForTimeout(800);
      copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      const copyLog = await takePtyWrites(app);
      results.push({ combo: 'ctrl+c', focus: 'terminal, a word selected', clipboard: copied, ptyReceived: copyLog.map(l => JSON.stringify(l.d)).join(' ') || '(nothing)' });

      await app.evaluate(({ clipboard }) => clipboard.writeText('tars-paste-check'));
      const consoleLines: string[] = [];
      const onConsole = (m: { type(): string; text(): string }) => consoleLines.push(`${m.type()}: ${m.text()}`);
      page.on('console', onConsole);
      await osKeys(app, 'ctrl+v');
      await page.waitForTimeout(1000);
      const pasteLog = await takePtyWrites(app);
      pasted = pasteLog.filter(l => l.id === pty).map(l => l.d).join('');
      page.off('console', onConsole);
      results.push({ combo: 'ctrl+v', focus: 'terminal', ptyReceived: pasteLog.map(l => JSON.stringify(l.d)).join(' ') || '(nothing)', console: consoleLines });

      // Two lines into the program that asked for bracketed paste: one paste,
      // wrapped, the newline as the Enter xterm sends for it.
      const a4Pty = await app.evaluate((_e, dist) =>
        process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('a4')?.ptyId ?? null, DIST);
      let found = -1;
      for (let i = 0; i < 4 && found < 0; i++) if (await focusTerminal(i) === a4Pty) found = i;
      expect(found, 'the bracketed paste CLI has a panel').toBeGreaterThanOrEqual(0);
      await app.evaluate(({ clipboard }) => clipboard.writeText('a\nb'));
      await osKeys(app, 'ctrl+v');
      await page.waitForTimeout(1000);
      const multiLog = await takePtyWrites(app);
      bracketed = multiLog.filter(l => l.id === a4Pty).map(l => l.d).join('');
      results.push({ combo: 'ctrl+v', focus: 'terminal in bracketed paste mode, a two-line clipboard', ptyReceived: JSON.stringify(bracketed) });
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
    }

    // No selection: Ctrl+C is the interrupt. Last in a terminal, since it ends the fake CLI.
    const noSelection = await inTerminal('ctrl+c', 3);

    // Outside a terminal: nothing closes, nothing reloads.
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.locator('main h1').first().click();
    const outside: Record<string, unknown>[] = [];
    for (const combo of ['ctrl+r', 'ctrl+shift+i', 'ctrl+w']) {
      const loadsBefore = loads;
      const sent = await osKeys(app, combo);
      await page.waitForTimeout(1500);
      const after = await state();
      outside.push({ combo, focus: 'settings page', sent, reloaded: loads > loadsBefore, visible: after.visible, devtoolsOpened: after.devtools, url: after.url.replace(DEV_URL, '') });
      if (after.devtools) await inMain(app, 'w.webContents.closeDevTools();');
    }
    // Ctrl+digit outside a terminal: the page.
    await osKeys(app, 'ctrl+3');
    await page.waitForTimeout(1500);
    const outsideDigit = (await state()).url.replace(DEV_URL, '');

    recordValues({ keys: { inTerminal: results, outside, outsideCtrl3: outsideDigit, panels } });
    fs.writeFileSync(test.info().outputPath('keys-after.json'), JSON.stringify({ inTerminal: results, outside, outsideCtrl3: outsideDigit, panels }, null, 2));

    expect(w.ptyReceived).toBe(JSON.stringify('\x17'));
    expect(r.ptyReceived).toBe(JSON.stringify('\x12'));
    for (const x of [w, r, shiftR, devtools, zoom]) {
      expect(x.visible && !x.reloaded && !x.devtoolsOpened && !x.zoomChanged, x.combo as string).toBe(true);
    }
    expect(noSelection.ptyReceived).toBe(JSON.stringify('\x03'));
    expect(page2.url).toMatch(/^\/agents\/?$/);
    expect(page2.ptyReceived).toBe('(nothing)');
    expect(panels['alt+1']).toBeGreaterThanOrEqual(0);
    expect(panels['alt+2']).toBeGreaterThanOrEqual(0);
    expect(panels['alt+1']).not.toBe(panels['alt+2']);
    expect(results.filter(x => String(x.combo).startsWith('alt+')).every(x => x.ptyReceived === '(nothing)')).toBe(true);
    // xterm's double-click word: its separators leave the colon on.
    expect(copied).toMatch(/^sandbox:?$/);
    expect(pasted).toContain('tars-paste-check');
    expect(bracketed).toBe('\x1b[200~a\rb\x1b[201~');
    for (const o of outside) expect(o.visible && !o.reloaded && !o.devtoolsOpened, String(o.combo)).toBe(true);
    expect(outsideDigit).toMatch(/^\/kanban\/?$/);
  });

  test('shell: the shell picked in Settings is saved, reads back, and a new quick terminal runs it', async () => {
    test.setTimeout(180_000);
    const openTerminalSettings = async () => {
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.getByTestId('settings-nav').getByText('Terminal', { exact: true }).click();
      await page.waitForTimeout(1200);
    };
    const detected = await page.evaluate(() => window.electronAPI!.desktopShell!.detectShells());
    const cmd = detected!.choices.find(c => c.id === 'cmd')!.path!;

    const quickTerminalSays = async (): Promise<string> => {
      const id = await page.evaluate(() => window.electronAPI!.pty!.create({ cols: 100, rows: 30 }).then(r => r.id));
      await app.evaluate((_e, { dist, id }) => {
        const pm = process.mainModule!.require(`${dist}/core/pty-manager.js`);
        const g = globalThis as unknown as { __quickOut: Record<string, string> };
        g.__quickOut ||= {};
        g.__quickOut[id] = '';
        pm.ptyProcesses.get(id).onData((d: string) => { g.__quickOut[id] += d; });
      }, { dist: DIST, id });
      await page.waitForTimeout(4000);
      const out = await app.evaluate((_e, id) => (globalThis as unknown as { __quickOut: Record<string, string> }).__quickOut[id], id);
      await page.evaluate((id) => window.electronAPI!.pty!.kill({ id }), id).catch(() => {});
      return out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    };

    const beforeOutput = await quickTerminalSays();
    await openTerminalSettings();
    await page.screenshot({ path: test.info().outputPath('shell-default.png') });
    await page.getByRole('button', { name: 'Terminal shell' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: test.info().outputPath('shell-open.png') });
    await page.getByRole('option', { name: /Command Prompt/ }).click();
    await page.waitForTimeout(1200);
    const saved = readSettings(home).terminalShell;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openTerminalSettings();
    const shown = await page.getByRole('button', { name: 'Terminal shell' }).textContent();
    await page.screenshot({ path: test.info().outputPath('shell-command-prompt.png') });
    const afterOutput = await quickTerminalSays();

    // The custom path row: the same file typed by hand.
    await page.getByRole('button', { name: 'Terminal shell' }).click();
    await page.getByRole('option', { name: 'Custom path' }).click();
    await page.waitForTimeout(400);
    const field = page.getByRole('textbox', { name: 'Shell path' });
    const customShown = await field.isVisible();
    await page.screenshot({ path: test.info().outputPath('shell-custom.png') });

    // Back to the default, so the rest of the run keeps its own shell.
    await page.getByRole('button', { name: 'Terminal shell' }).click();
    await page.getByRole('option', { name: /^Default/ }).click();
    await page.waitForTimeout(1000);
    const reset = readSettings(home).terminalShell;

    recordValues({ shell: { detected, saved, shown, customShown, reset, beforeOutput: beforeOutput.slice(0, 200), afterOutput: afterOutput.slice(0, 200) } });
    expect(saved).toBe(cmd);
    expect(shown).toContain('Command Prompt');
    expect(afterOutput).toMatch(/Microsoft Windows/);
    expect(beforeOutput).not.toMatch(/Microsoft Windows \[/);
    expect(customShown).toBe(true);
    expect(reset).toBe('');
  });

  test('tray: the tray icon, its menu, the panel over the taskbar, and the click that closed it', async () => {
    const tray = await app.evaluate(({ screen, nativeImage }, dist) => {
      const req = process.mainModule!.require;
      const t = req(`${dist}/core/tray-manager.js`).getTray();
      const menu = req(`${dist}/core/tray-manager.js`).trayContextMenu();
      const bounds = t.getBounds();
      const display = screen.getDisplayMatching(bounds.width ? bounds : { x: 0, y: 0, width: 1, height: 1 });
      const ico = req('path').join(dist, '..', 'resources', 'tray.ico');
      const image = nativeImage.createFromPath(ico);
      return {
        bounds, workArea: display.workArea, displayBounds: display.bounds,
        menu: menu.items.map((i: { type: string; label: string }) => (i.type === 'separator' ? '---' : i.label)),
        icoScaleFactors: image.getScaleFactors(), icoEmpty: image.isEmpty(),
      };
    }, DIST);

    const open = () => app.evaluate(({ BrowserWindow }, { dist, b }) => {
      const req = process.mainModule!.require;
      req(`${dist}/core/tray-panel-manager.js`).toggleTrayPanel(b);
      const main = req(`${dist}/core/window-manager.js`).getMainWindow();
      const p = BrowserWindow.getAllWindows().find(w => w !== main);
      return p ? { bounds: p.getBounds(), visible: p.isVisible() } : null;
    }, { dist: DIST, b: tray.bounds });

    const first = await open();
    await page.waitForTimeout(2500);
    const panelHwnd = await app.evaluate(({ BrowserWindow }, dist) => {
      const main = process.mainModule!.require(`${dist}/core/window-manager.js`).getMainWindow();
      return BrowserWindow.getAllWindows().find(w => w !== main)!.getNativeWindowHandle().readBigInt64LE(0).toString();
    }, DIST);
    desktop(['-Mode', 'print', '-Hwnd', panelHwnd, '-Out', test.info().outputPath('tray-panel-window.png')]);
    const d = tray.displayBounds;
    desktop(['-Mode', 'capture', '-X', String(d.x + d.width - 1300), '-Y', String(d.y + d.height - 820), '-W', '1300', '-H', '820', '-Out', test.info().outputPath('tray-panel-position.png')]);

    // The panel hides on blur, and the click that caused the blur arrives after it.
    const k02 = await app.evaluate(({ BrowserWindow }, { dist, b }) => {
      const req = process.mainModule!.require;
      const main = req(`${dist}/core/window-manager.js`).getMainWindow();
      const p = BrowserWindow.getAllWindows().find(w => w !== main)!;
      p.emit('blur');
      req(`${dist}/core/tray-panel-manager.js`).toggleTrayPanel(b);
      return { visibleAfterClosingClick: p.isVisible() };
    }, { dist: DIST, b: tray.bounds });
    await sleep(500);
    const later = await open();
    await app.evaluate((_e, dist) => process.mainModule!.require(`${dist}/core/tray-panel-manager.js`).hideTrayPanel(), DIST);

    recordValues({ tray: { ...tray, panel: first, k02, reopenedLater: later } });
    expect(tray.menu).toEqual(['Show Tars', '---', 'Quit Tars']);
    expect(tray.icoEmpty).toBe(false);
    const wa = tray.workArea;
    const pb = first!.bounds;
    expect(first!.visible).toBe(true);
    expect(pb.y + pb.height).toBeLessThanOrEqual(wa.y + wa.height);
    expect(pb.y).toBeGreaterThanOrEqual(wa.y);
    expect(pb.x).toBeGreaterThanOrEqual(wa.x);
    expect(pb.x + pb.width).toBeLessThanOrEqual(wa.x + wa.width);
    expect(k02.visibleAfterClosingClick).toBe(false);
    expect(later!.visible).toBe(true);
  });

  test('close: a second launch shows the first window and exits', async () => {
    test.setTimeout(120_000);
    await inMain(app, 'w.hide();');
    // The first instance's own 30 s autosave would rewrite agents.json inside
    // the window this compares (about one run in fourteen): held off for it.
    const autosave = (call: 'stopAgentAutosave' | 'startAgentAutosave') => app.evaluate((_e, { dist, call }) =>
      process.mainModule!.require(`${dist}/core/agent-manager.js`)[call](), { dist: DIST, call });
    await autosave('stopAgentAutosave');
    try {
      const agentsBefore = fs.readFileSync(path.join(home, '.dorothy', 'agents.json'), 'utf-8');
      const electronPath = (await import('electron')).default as unknown as string;
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
        .filter(([k, v]) => v !== undefined && !/^(CLAUDE|DOROTHY|ANTHROPIC)|^CLAUDECODE$/.test(k))) as Record<string, string>;
      const roaming = path.join(home, 'AppData', 'Roaming');
      const local = path.join(home, 'AppData', 'Local');
      Object.assign(env, {
        HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local, CFFIXED_USER_HOME: home,
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31461), DOROTHY_E2E: '1',
      });
      const started = Date.now();
      const second = spawn(electronPath, ['.', `--user-data-dir=${path.join(home, 'electron-profile')}`], { env, stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { second.kill(); resolve(null); }, 30_000);
        second.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      });
      await sleep(1000);
      const shown = await inMain<{ visible: boolean; focused: boolean }>(app, 'return { visible: w.isVisible(), focused: w.isFocused() };');
      const agentsAfter = fs.readFileSync(path.join(home, '.dorothy', 'agents.json'), 'utf-8');
      recordValues({ singleInstance: { exitCode: code, ms: Date.now() - started, firstWindow: shown, agentsUntouched: agentsBefore === agentsAfter } });
      expect(code).toBe(0);
      expect(shown.visible).toBe(true);
      expect(agentsAfter).toBe(agentsBefore);
    } finally {
      await autosave('startAgentAutosave');
    }
  });

  test('close: closing hides to the tray and the agents keep running; Alt+F4 too; Show Tars brings it back', async () => {
    test.setTimeout(120_000);
    // Answered as the explanation's default would be; the real dialog is the next suite's.
    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __explained: number };
      g.__explained = 0;
      dialog.showMessageBox = (async () => { g.__explained++; return { response: 0, checkboxChecked: false }; }) as typeof dialog.showMessageBox;
    });
    const pids = () => app.evaluate((_e, dist) => {
      const { ptyProcesses } = process.mainModule!.require(`${dist}/core/pty-manager.js`);
      return [...ptyProcesses.values()].map((p: { pid: number }) => p.pid).filter((pid: number) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
    }, DIST);
    const alive = await pids();
    await inMain(app, 'w.close();');
    await sleep(1500);
    const afterFirst = await inMain<{ destroyed: boolean; visible: boolean }>(app, 'return { destroyed: w.isDestroyed(), visible: w.isVisible() };');
    const stillAlive = await pids();
    const explainedSaved = readSettings(home).closeToTrayExplained;

    await app.evaluate((_e, dist) => {
      const item = process.mainModule!.require(`${dist}/core/tray-manager.js`).trayContextMenu().items.find((i: { label: string }) => i.label === 'Show Tars');
      item.click();
    }, DIST);
    await sleep(800);
    const shownAgain = await inMain<boolean>(app, 'return w.isVisible();');
    const altF4 = await osKeys(app, 'alt+f4');
    await sleep(1500);
    const afterAltF4 = await inMain<{ destroyed: boolean; visible: boolean }>(app, 'return { destroyed: w.isDestroyed(), visible: w.isVisible() };');
    const explainedCalls = await app.evaluate(() => (globalThis as unknown as { __explained: number }).__explained);
    await inMain(app, 'w.show();');

    recordValues({ closeToTray: { alive, afterFirst, stillAlive, explainedSaved, shownAgain, altF4, afterAltF4, explainedCalls } });
    // Three of the four: the keys test ended one fake CLI with its ^C.
    expect(alive.length).toBeGreaterThanOrEqual(3);
    expect(afterFirst).toEqual({ destroyed: false, visible: false });
    expect(stillAlive).toEqual(alive);
    expect(explainedSaved).toBe(true);
    expect(shownAgain).toBe(true);
    expect(afterAltF4).toEqual({ destroyed: false, visible: false });
    expect(explainedCalls).toBe(1);
  });

  test('no page error on the way', async () => {
    recordValues({ pageErrors: errors });
    expect(errors).toEqual([]);
  });
});

test.describe('the first close and Quit Tars, in a fresh profile', () => {
  test('the real first-close dialog keeps Tars in the tray; Quit Tars ends the app and its terminals', async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-desktop-quit-'));
    seedSandbox(home);
    const { app, page, errors } = await launch(home, 31462);
    try {
      await settleFleet(app);
      const pid = await app.evaluate(() => process.pid);
      await inMain(app, 'setTimeout(() => w.close(), 50);');
      // The message box, found among the app's windows and photographed as Windows draws it.
      let dialogLine: string | undefined;
      for (let i = 0; i < 20 && !dialogLine; i++) {
        await sleep(250);
        dialogLine = desktop(['-Mode', 'list', '-ProcId', String(pid)]).split(/\r?\n/).find(l => l.split('|')[1] === '#32770');
      }
      expect(dialogLine, 'the first close shows the explanation').toBeTruthy();
      const dialogHwnd = dialogLine!.split('|')[0];
      desktop(['-Mode', 'print', '-Hwnd', dialogHwnd, '-Out', test.info().outputPath('first-close-dialog.png')]);
      // Enter answers with the default button, a real key on the real dialog.
      const answered = desktop(['-Mode', 'keys', '-Hwnd', dialogHwnd, '-Combo', 'enter']);
      await sleep(1500);
      const hidden = await inMain<{ destroyed: boolean; visible: boolean }>(app, 'return { destroyed: w.isDestroyed(), visible: w.isVisible() };');
      const explained = readSettings(home).closeToTrayExplained;

      const ptyPids: number[] = await app.evaluate((_e, dist) => {
        const { ptyProcesses } = process.mainModule!.require(`${dist}/core/pty-manager.js`);
        return [...ptyProcesses.values()].map((p: { pid: number }) => p.pid);
      }, DIST);
      const closed = app.waitForEvent('close', { timeout: 30_000 });
      await app.evaluate((_e, dist) => {
        const item = process.mainModule!.require(`${dist}/core/tray-manager.js`).trayContextMenu().items.find((i: { label: string }) => i.label === 'Quit Tars');
        setTimeout(() => item.click(), 50);
      }, DIST);
      await closed;
      await sleep(2000);
      const survivors = ptyPids.filter(p => { try { process.kill(p, 0); return true; } catch { return false; } });
      const appAlive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();

      recordValues({ command: COMMAND, firstClose: { answered, hidden, explained, ptyPids, survivors, appAlive, pageErrors: errors } });
      expect(hidden).toEqual({ destroyed: false, visible: false });
      expect(explained).toBe(true);
      expect(ptyPids.length).toBeGreaterThanOrEqual(4);
      expect(survivors).toEqual([]);
      expect(appAlive).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
    void page;
  });
});

test.describe('the end of the Windows session', () => {
  test('logoff, shutdown or restart: the fleet is saved and no terminal survives', async () => {
    test.setTimeout(240_000);
    // Closing hides the window now, so a session end is how Tars usually ends
    // on Windows, and Electron emits no before-quit then: only the window's
    // session-end (WM_ENDSESSION), after which Windows ends the process.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-desktop-session-end-'));
    seedSandbox(home);
    const { app, errors } = await launch(home, 31463);
    try {
      await settleFleet(app);
      const agentsFile = path.join(home, '.dorothy', 'agents.json');
      const marker = `session-end-${Date.now()}`;
      const ptyPids: number[] = await app.evaluate((_e, { dist, marker }) => {
        const req = process.mainModule!.require;
        const { agents, stopAgentAutosave } = req(`${dist}/core/agent-manager.js`);
        // A change only memory holds, with the autosave timer stopped: it
        // reaches agents.json by the shutdown's save, or not at all.
        stopAgentAutosave();
        agents.get('a1').currentTask = marker;
        const { ptyProcesses } = req(`${dist}/core/pty-manager.js`);
        return [...ptyProcesses.values()].map((p: { pid: number }) => p.pid);
      }, { dist: DIST, marker });
      const before = fs.readFileSync(agentsFile, 'utf-8').includes(marker);

      const ended = await inMain<{ closePrevented: boolean }>(app, `
        w.emit('session-end', { preventDefault() {} });
        // What Windows does next: the window closes, and it must close.
        let prevented = false;
        w.emit('close', { preventDefault() { prevented = true; } });
        return { closePrevented: prevented };`);
      await sleep(3000);
      const saved = fs.readFileSync(agentsFile, 'utf-8').includes(marker);
      const survivors = ptyPids.filter(p => { try { process.kill(p, 0); return true; } catch { return false; } });

      recordValues({ command: COMMAND, sessionEnd: { markerBefore: before, markerSaved: saved, ptyPids, survivors, ...ended, pageErrors: errors } });
      expect(before).toBe(false);
      expect(ptyPids.length).toBeGreaterThanOrEqual(4);
      expect(saved).toBe(true);
      expect(survivors).toEqual([]);
      expect(ended.closePrevented).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
