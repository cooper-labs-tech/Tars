import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, roomListSettled, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { splitPageErrors } from './surfaces.mjs';

/**
 * What a Chat room does, where chat-rooms.spec.ts photographs what it shows.
 *
 * Written before the fixes, each test red on main at 00c7fc40 (1.8.0). The ways
 * a room fails that these pin:
 *
 * 1. A draft follows you into the next room. The room view stayed mounted from
 *    one room to the next, so the words typed in orion were in the composer of
 *    tars once tars opened, and Enter posted them to tars, whose agents were
 *    never meant to read them.
 * 2. An error hides behind "no turn signal". The team rail asked whether the
 *    CLI reports its turns before it asked about an error, so an agent on grok
 *    whose session failed read "no turn signal" and "Tars sees its output, not
 *    its turns", and the reason it failed was nowhere on the page.
 * 3. The older messages of a busy room are out of reach. The thread was a scroll
 *    box that was also `justify-end`, so what overflowed went above its top,
 *    where no scroll reaches: QA measured 30 messages in tars, the first 2584 px
 *    above the thread and the wheel moving nothing.
 * 4. The room list stays empty after a slow start. It was read once and given
 *    10 s; an answer after that was thrown away, and a refused read was not
 *    sent again, so the note "The bus did not answer" stood where the rows
 *    would be until a click on retry or a message (red on 1.9.1).
 *
 * Same sandbox as chat-rooms.spec.ts: the seeded journal, nothing started. The
 * statuses a test needs are set on the app's own agent map and pushed with a
 * tick, as a hook would.
 */

let app: ElectronApplication;
let page: Page;
let sandboxHome: string;
const pageErrors: string[] = [];

const DRAFT = 'typed in orion, for orion only';
const REASON = 'connect ECONNREFUSED 127.0.0.1:5432';

test.beforeAll(async () => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-behaviour-'));
  seedSandbox(sandboxHome, { chatRooms: true });
  app = await launchSandboxed(electron, sandboxHome, {
    timezoneId: 'UTC',
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: apiPort(31477),
      DOROTHY_E2E: '1',
      TZ: 'UTC',
    },
  });
  page = await app.firstWindow();
  listenForErrors(page, pageErrors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  await removeHome(sandboxHome);
});

/** Patches agents on the app's own map and pushes a tick, as a hook would. */
async function setAgents(patches: Record<string, Record<string, unknown>>) {
  const dist = path.resolve(process.cwd(), 'electron', 'dist');
  await app.evaluate((_electron, { dist, patches }) => {
    const req = process.mainModule!.require;
    const { agents } = req(`${dist}/core/agent-manager.js`);
    for (const [id, patch] of Object.entries(patches)) {
      const agent = agents.get(id);
      if (agent) Object.assign(agent, patch);
    }
    req(`${dist}/utils/agents-tick.js`).scheduleTick();
  }, { dist, patches });
}

/**
 * Opens a room from the conversation list and waits for its own words. The list
 * is read first, and a read that failed fails here with the page's note.
 */
async function openRoom(title: string, says: string) {
  await roomListSettled(page, [title]);
  const entry = page.getByRole('button', { name: title, exact: false }).filter({ hasText: title }).first();
  await entry.waitFor({ state: 'visible', timeout: 20_000 });
  await entry.click();
  await expect(page.getByText(says, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

test('a draft typed in one room is not sent from the next', async () => {
  const errorsBefore = pageErrors.length;
  // Someone at work in each room, or neither composer takes a word.
  await setAgents({ c4: { status: 'running' }, a3: { status: 'running' } });
  await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });

  await openRoom('orion', 'Stop there, both of you.');
  const field = page.getByRole('textbox', { name: 'Message' });
  await expect(field).toBeEditable({ timeout: 20_000 });
  await field.fill(DRAFT);
  await stepShot(page, 'draft-1-typed-in-orion');

  await openRoom('tars', 'Then I hold the write until the fit resolves');
  const composerInTars = await field.inputValue();
  await stepShot(page, 'draft-2-tars-opened');

  // What a person does next: Enter, in the field in front of them.
  await field.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  const copies = await page.evaluate(async text => {
    const bus = window.electronAPI!.bus!;
    const { rooms } = await bus.listRooms();
    const found: Record<string, number> = {};
    for (const room of rooms) {
      const { messages = [] } = await bus.getRoom(room.id);
      found[room.title] = messages.filter(m => m.text === text).length;
    }
    return found;
  }, DRAFT);
  await stepShot(page, 'draft-3-after-enter');
  recordValues({ draft: { composerInTars, copies } });

  expect.soft(composerInTars, 'what the composer of tars opens with').toBe('');
  expect.soft(copies.tars ?? 0, 'copies of the orion draft posted to tars').toBe(0);
  // The sweep's rule: whatever KNOWN_PAGE_ERRORS does not tolerate fails.
  expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
});

test('an error on a CLI that never reports its turns still says why', async () => {
  const errorsBefore = pageErrors.length;
  // a5 runs grok, one of the five CLIs with no end of turn.
  await setAgents({ a5: { status: 'error', error: REASON } });
  await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });
  await openRoom('1212-capital', 'Nobody was stopped: every agent finished its turn');
  await page.waitForTimeout(900);
  await stepShot(page, 'error-1-capital');

  const shown = {
    reason: await page.getByText(REASON, { exact: true }).count(),
    noTurnSignal: await page.getByText('no turn signal', { exact: true }).count(),
    outputNotTurns: await page.getByText('Tars sees its output, not its turns', { exact: true }).count(),
  };
  recordValues({ error: shown });

  expect.soft(shown.reason, 'the reason, in the team rail').toBe(1);
  expect.soft(shown.noTurnSignal, '"no turn signal" in place of the error').toBe(0);
  expect.soft(shown.outputNotTurns, 'the no-turn-signal line in place of the reason').toBe(0);
  expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
});


test('an older message of a busy room can be scrolled back to', async () => {
  // Held by the QA at the gate of #175, red on main (e16b7692) and on #175 alike.
  // The thread is an `overflow-y-auto` box that is also `justify-end`: what
  // overflows goes above its top, where no scroll reaches. Measured with 30
  // messages in tars: the first sat at y = -2584 above a thread starting at
  // y = 116, scrollHeight equalled clientHeight (616), and twenty turns of the
  // wheel upward moved nothing. With rows about 110 px tall, a room keeps its
  // last five or so messages on screen and the rest out of reach.
  const errorsBefore = pageErrors.length;
  await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });
  const tars = await page.evaluate(async () => (await window.electronAPI!.bus!.listRooms()).rooms.find(r => r.title === 'tars')?.id);
  for (let i = 1; i <= 30; i++) {
    await page.evaluate(async ([id, n]) => window.electronAPI!.bus!.postMessage({ roomId: id as string, text: `filler ${n}: a line long enough to take a row of the thread, and then some more words so it wraps.` }), [tars, i]);
  }
  await openRoom('tars', 'filler 30:');
  const thread = page.locator('div.overflow-y-auto.justify-end, [data-room-thread]').first();
  const box = (await thread.boundingBox())!;
  // And a busy room still opens at its newest message, with the thread scrolled
  // to its bottom rather than to its top.
  const newest = (await page.getByText('filler 30:', { exact: false }).first().boundingBox())!;
  expect.soft(newest.y + newest.height, 'the newest message in view when the room opens').toBeLessThanOrEqual(box.y + box.height + 1);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(50); }
  await page.waitForTimeout(500);
  const first = (await page.getByText('filler 1:', { exact: false }).first().boundingBox())!;

  expect.soft(first.y, 'the first message, after scrolling to the top').toBeGreaterThanOrEqual(box.y);
  expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
});

/**
 * Puts a bus:listRooms in the app's main process that is slow or refuses, over
 * the app's own journal, and notes when each ask came, in ms after the first;
 * `null` puts the app's own back. A slow start, as CI met it: the list was read
 * once, given 10 s, and the answer that came after was thrown away. By time,
 * not by count: next dev mounts the page twice (React's strict mode), so two
 * asks leave together.
 */
async function listRoomsAnswers(how: 'held 12 s' | 'refused for 2 s' | null) {
  const dist = path.resolve(process.cwd(), 'electron', 'dist');
  await app.evaluate(({ ipcMain }, { dist, how }) => {
    const { listRooms } = process.mainModule!.require(`${dist}/services/bus-store.js`);
    const g = globalThis as { e2eListRoomsAsks?: number[] };
    const asks: number[] = g.e2eListRoomsAsks = [];
    let first = 0;
    ipcMain.removeHandler('bus:listRooms');
    ipcMain.handle('bus:listRooms', async () => {
      if (!asks.length) first = Date.now();
      const at = Date.now() - first;
      asks.push(at);
      if (how === 'held 12 s') await new Promise(resolve => setTimeout(resolve, 12_000));
      if (how === 'refused for 2 s' && at < 2_000) throw new Error('the bus is not ready');
      try {
        return { rooms: listRooms() };
      } catch (err) {
        return { rooms: [], error: err instanceof Error ? err.message : 'Failed to list rooms' };
      }
    });
  }, { dist, how });
}

for (const how of ['held 12 s', 'refused for 2 s'] as const) {
  test(`the room list is read again by itself when the bus was ${how}`, async () => {
    // Red before the retry (1.9.1): the note stayed, and the rows never came
    // without a click on retry or a message.
    const errorsBefore = pageErrors.length;
    const sidebar = page.locator('[data-chat-sidebar]');
    const note = sidebar.getByText('The bus did not answer', { exact: false });
    const row = (name: string) => sidebar.getByRole('button', { name, exact: false }).filter({ hasText: name }).first();
    await listRoomsAnswers(how);
    try {
      const started = Date.now();
      await page.goto(DEV_URL + '/chat', { waitUntil: 'domcontentloaded' });
      await expect(note, 'the note, while the bus has not given the list').toBeVisible({ timeout: 30_000 });
      const noteAt = Date.now() - started;
      const said = (await note.locator('xpath=ancestor::div[1]').locator('p').allInnerTexts()).join(' ').replace(/\s+/g, ' ').trim();
      await stepShot(page, `bus-retry-${how.replace(/\s+/g, '-')}-1-note`);

      // Nobody clicks retry, and no message comes.
      await expect(row('orion'), 'orion, listed with no click').toBeVisible({ timeout: 45_000 });
      const listedAt = Date.now() - started;
      await expect(row('tars'), 'tars, listed with no click').toBeVisible();
      await expect(note, 'the note, once the list is read').toBeHidden();
      await stepShot(page, `bus-retry-${how.replace(/\s+/g, '-')}-2-listed`);
      const asks = await app.evaluate(() => (globalThis as { e2eListRoomsAsks?: number[] }).e2eListRoomsAsks ?? []);
      recordValues({ [`busRetry ${how}`]: { noteAt, said, listedAt, asks } });

      // One read at a time: a held read is waited for, not asked again when the
      // note goes up at 10 s; a refused one is asked once more, after a pause.
      const later = asks.filter(at => at >= 2_000);
      expect.soft(later.length, `bus:listRooms asks after the first 2 s (all asks, in ms: ${asks.join(', ')})`)
        .toBe(how === 'held 12 s' ? 0 : 1);
    } finally {
      await listRoomsAnswers(null);
    }
    expect.soft(splitPageErrors(pageErrors.slice(errorsBefore)).fatal, 'page errors').toEqual([]);
  });
}
