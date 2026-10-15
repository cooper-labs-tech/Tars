import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, removeHome, seedSandbox, splashGone } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Saving the Settings page must not write back what nobody touched.
 *
 * The page used to send the whole snapshot it loaded when it opened, and the
 * main process merges what arrives onto the file, so every key in that payload
 * won: the ones the user never went near, and the ones something else had
 * written since. The main process now refuses an empty `hooks`, an empty `env`
 * and empty permissions, because empty is a shape it can recognise. It cannot
 * do the same for `includeCoAuthoredBy`: a stale `false` and a chosen `false`
 * are the same two bytes. Only leaving a key out of the payload settles it.
 *
 * Driven through the real app rather than through the hook, because there is
 * no way to drive the hook: the suite runs in `node` with no DOM and no
 * testing-library, and `renderToStaticMarkup` cannot take a component through
 * a state change. Going end to end also proves the part that matters, which is
 * the whole chain from the toggle to the bytes on disk.
 *
 * The Co-authored-by toggle is the only control wired to `updateSettings`, so
 * it is the only key a save can legitimately carry today.
 */

test('saving the Git toggle carries that key and nothing else', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-partial-'));
  seedSandbox(home);

  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const settings = path.join(claude, 'settings.json');
  const before = {
    includeCoAuthoredBy: false,
    permissions: { allow: ['Bash(npm run test:*)'], defaultMode: 'acceptEdits' },
    model: 'opus',
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.sh' }] }] },
    enabledPlugins: { 'vercel@marketplace': true },
    tui: { theme: 'dark' },
    theme: 'dark',
    statusLine: { type: 'command', command: '/Users/you/bin/mine.sh' },
  };
  fs.writeFileSync(settings, JSON.stringify(before, null, 2));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31492), DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');

  // Open the Git section: the page takes its snapshot of the file here.
  await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
  // Hydrated first: until React holds the page, what follows acts on the
  // server's HTML, and on a slow runner its bounds ran out there (run
  // 36461229599, attempt 2). splashGone waits for that as long as the spec
  // allows, then holds the splash to its own cap.
  await splashGone(page);
  await page.waitForTimeout(1500);
  const nav = page.getByTestId('settings-nav');
  await nav.getByText('Workspace', { exact: true }).click();
  await page.waitForTimeout(400);
  await nav.getByText('Git', { exact: true }).click();
  await page.waitForTimeout(1200);

  // Now something else writes the file, which is the whole scenario: the
  // snapshot the page is holding is stale from this moment on. `model` is used
  // rather than `hooks` on purpose, because the main process guard from #72
  // already protects hooks and would hide the difference.
  fs.writeFileSync(settings, JSON.stringify({ ...before, model: 'sonnet' }, null, 2));

  // Toggle Co-authored-by, then Save.
  await page.getByRole('switch').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(1500);

  const after = JSON.parse(fs.readFileSync(settings, 'utf-8'));
  console.log('PARTIAL model     :', JSON.stringify(after.model), '(sonnet means the save left it alone)');
  console.log('PARTIAL coAuthored:', JSON.stringify(after.includeCoAuthoredBy), '(true means the toggle landed)');
  console.log('PARTIAL keys      :', Object.keys(after).length, Object.keys(after).join(','));
  console.log('PARTIAL statusLine:', JSON.stringify(after.statusLine));

  await app.close();

  // The change the user made lands, and the change they never saw survives.
  expect(after.includeCoAuthoredBy).toBe(true);
  expect(after.model).toBe('sonnet');
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

  await removeHome(home);
});
