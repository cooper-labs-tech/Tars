import { test, expect, _electron as electron, type Locator } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The chats' places in the new shell, on the chats' records (#361's channels),
 * with Settings, Preferences, "New interface" on. Frames: `Shell · chats ·
 * list, a chat open`, `· new chat, its record`, `· project page, from the
 * records`, `· a chat's actions · states`, and `Chats · the list from the
 * records · notes`.
 *
 * A sandbox with three projects: tars-demo, whose orchestrator Lead is the
 * more recently active, with a worker, Backend, holding a request Lead made;
 * harbor-demo, with its orchestrator; docs-demo, with a worker and no
 * orchestrator. The launch makes each orchestrator's conversation its
 * project's chat #1, Main.
 *
 * The person reads the list: both Mains, under Active, the more recent first,
 * each with its project and number; tars-demo's Main, which has a runner,
 * opens on its conversation (e2e/new-interface-chat-page.spec.ts reads one).
 * New chat: docs-demo cannot be chosen, it has no orchestrator; a chat
 * "Release notes" made in tars-demo is #2, opens, and its page, with no runner
 * yet, waits for its first message, its composer open.
 * Renamed in place, then pinned, then snoozed for an hour (folded under
 * Snoozed, unfolded with its time), each kept in chats.json. harbor-demo's
 * Main is settled. "Triage", made next, becomes tars-demo's inbox; Main,
 * then, cannot be deleted while Backend holds Lead's request, and the row says
 * why and names Backend; Triage cannot be deleted, being the inbox. Release
 * notes is deleted: asked first, kept on cancel, gone on delete, and from the
 * file. The filter keeps tars-demo's chats; Projects opens tars-demo's page:
 * its chats by number, its team.
 *
 * The artefact: a screenshot per state and values.json with what each read.
 */

/** The launch splash, over the page on every document load until its checks answer (4 s at most). */
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';

const iso = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, minutes)).toISOString();
const agent = (o: Record<string, unknown>) => ({
  character: 'robot', provider: 'claude', status: 'idle', skills: [], createdAt: iso(0), lastActivity: iso(0), ...o,
});

test('the chat list from the records: sections, a new chat, rename, pin, snooze, settle, the inbox, deletes refused and done, the filter, and a project\'s page', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-list-'));
  const real = fs.realpathSync(home);
  const project = (name: string) => path.join(real, 'projects', name);
  const tars = project('tars-demo');
  const harbor = project('harbor-demo');
  const docs = project('docs-demo');
  for (const p of [tars, harbor, docs]) fs.mkdirSync(p, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent({ id: 'lead', name: 'Lead', role: 'orchestrator', projectPath: tars, lastActivity: iso(30) }),
    agent({ id: 'backend', name: 'Backend', role: 'worker', projectPath: tars, requestedBy: { agentId: 'lead', ptyId: '' } }),
    agent({ id: 'lead-two', name: 'Lead two', role: 'orchestrator', projectPath: harbor, lastActivity: iso(10) }),
    agent({ id: 'writer', name: 'Writer', role: 'worker', projectPath: docs }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([tars, harbor, docs]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const chatsFile = path.join(dir, 'chats.json');
  const onDisk = () => JSON.parse(fs.readFileSync(chatsFile, 'utf8')).chats as Array<Record<string, unknown>>;

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31454), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });

    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    const main = page.getByRole('main');
    const section = (name: string) => sidebar.getByRole('region', { name, exact: true });
    const rows = (name: string) => section(name).locator('[data-chat-row]');
    const texts = async (where: Locator) => (await where.allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim());
    /** A row's actions; `which` picks the row when two share a title (two projects' Main). */
    const actions = async (title: string, which = title) => {
      const row = sidebar.locator('[data-chat-row]', { hasText: which });
      await expect(row).toHaveCount(1);
      await row.hover();
      await row.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
      return page.getByRole('menu', { name: `Actions for ${title}`, exact: true });
    };
    const newChat = async (name: string, title: string) => {
      await sidebar.getByRole('button', { name: 'New chat', exact: true }).click();
      await expect(main.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
      await main.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { name, exact: true }).click();
      await main.getByRole('textbox', { name: 'Title' }).fill(title);
      await main.getByRole('button', { name: 'Create chat', exact: true }).click();
      await expect(main.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 15_000 });
    };

    // The list, from the records: both Mains under Active, the more recent first.
    await expect(rows('Active')).toHaveCount(2, { timeout: 90_000 });
    seen.list = await texts(rows('Active'));
    expect(seen.list).toEqual(['Main tars-demo #1', 'Main harbor-demo #1']);
    // Main has a runner, Lead: it opens on its conversation (empty here, Lead
    // has written none), its composer open (e2e/new-interface-chat-send.spec.ts sends from it).
    await expect(main.getByRole('heading', { name: 'Main', exact: true })).toBeVisible();
    await expect(main.getByRole('log', { name: 'Conversation' })).toBeVisible();
    await expect(main.getByRole('group', { name: 'Message composer' }).getByRole('textbox', { name: 'Message' })).toBeEnabled();
    // /chats with no `?chat=` opened tars-demo's Main: its row is the current one, as when the address names it, and
    // the other Main's is not (QA's finding on #653's surfaces, chatShown in src/lib/chat-sections.ts).
    await expect(rows('Active').first().getByRole('link')).toHaveAttribute('aria-current', 'page');
    await expect(rows('Active').nth(1).getByRole('link')).not.toHaveAttribute('aria-current', 'page');
    await stepShot(page, '01-list');

    // New chat: a project without an orchestrator cannot be chosen.
    await sidebar.getByRole('button', { name: 'New chat', exact: true }).click();
    const projects = main.getByRole('radiogroup', { name: 'Project' });
    await expect(projects.getByRole('radio', { name: 'docs-demo', exact: true })).toBeDisabled();
    seen.newChatProjects = await texts(projects.getByRole('radio'));
    await stepShot(page, '02-new-chat');
    await projects.getByRole('radio', { name: 'tars-demo', exact: true }).click();
    await main.getByRole('textbox', { name: 'Title' }).fill('Release notes');
    await main.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'Release notes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText('Its conversation starts with your first message')).toBeVisible();
    const made = sidebar.locator('[data-chat-row]', { hasText: 'Release notes' });
    await expect(made).toContainText('tars-demo #2');
    await expect(made.getByRole('link')).toHaveAttribute('aria-current', 'page');
    seen.created = onDisk().find(c => c.title === 'Release notes');
    expect(seen.created).toMatchObject({ number: 2, projectPath: tars, titleSource: 'user' });
    // A row's actions button is a small control, 26 px (DESIGN.md), as its frame draws it.
    const dots = await made.getByRole('button', { name: 'Actions for Release notes', exact: true }).boundingBox();
    seen.actionsButton = dots && { width: Math.round(dots.width), height: Math.round(dots.height) };
    expect(seen.actionsButton).toEqual({ width: 26, height: 26 });
    await stepShot(page, '03-created');

    // Rename, in place.
    await (await actions('Release notes')).getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const field = sidebar.getByRole('textbox', { name: 'Title of Release notes', exact: true });
    await field.fill('Release notes for 1.9.6');
    await field.press('Enter');
    await expect(sidebar.locator('[data-chat-row]', { hasText: 'Release notes for 1.9.6' })).toHaveCount(1);
    expect(onDisk().some(c => c.title === 'Release notes for 1.9.6')).toBe(true);

    // Pin.
    await (await actions('Release notes for 1.9.6')).getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await expect(rows('Pinned')).toHaveCount(1);
    seen.pinned = await texts(rows('Pinned'));
    await stepShot(page, '04-pinned');

    // Snooze for an hour: folded under Snoozed, unfolded with its time.
    const menu = await actions('Release notes for 1.9.6');
    await menu.getByRole('menuitem', { name: 'Snooze', exact: true }).click();
    await page.getByRole('menu', { name: 'Snooze until', exact: true }).getByRole('menuitem', { name: 'For an hour', exact: true }).click();
    await expect(section('Pinned')).toHaveCount(0);
    const snoozedHead = section('Snoozed').getByRole('button', { name: /Snoozed/ });
    await expect(snoozedHead).toHaveAttribute('aria-expanded', 'false');
    await expect(rows('Snoozed')).toHaveCount(0);
    await snoozedHead.click();
    await expect(rows('Snoozed')).toHaveCount(1);
    await expect(rows('Snoozed')).toContainText(/until (\w{3} )?\d{1,2}:\d{2}/);
    const snoozed = onDisk().find(c => c.title === 'Release notes for 1.9.6');
    seen.snoozedUntil = snoozed?.snoozedUntil;
    expect(Date.parse(String(snoozed?.snoozedUntil)) - Date.now()).toBeGreaterThan(50 * 60_000);
    await stepShot(page, '05-snoozed');

    // Settle harbor-demo's Main.
    await (await actions('Main', 'harbor-demo #1')).getByRole('menuitem', { name: 'Settle', exact: true }).click();
    await expect(section('Settled').getByRole('button', { name: /Settled/ })).toContainText('1');
    seen.settled = onDisk().filter(c => c.settledAt).map(c => `${path.basename(String(c.projectPath))} #${c.number}`);

    // Triage becomes tars-demo's inbox; Main, then, is refused for the work out.
    await newChat('tars-demo', 'Triage');
    await (await actions('Triage')).getByRole('menuitem', { name: 'Make it the inbox', exact: true }).click();
    await expect.poll(() => onDisk().find(c => c.title === 'Triage')?.inbox).toBe(true);
    await (await actions('Main', 'tars-demo #1')).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await sidebar.getByRole('alertdialog').getByRole('button', { name: 'delete', exact: true }).click();
    const refusedWork = sidebar.getByRole('alert');
    await expect(refusedWork).toContainText('This chat has work out at the team');
    await expect(refusedWork).toContainText('Backend');
    // The list takes the sidebar's height down to its foot: under the refusal, the last section is still in sight.
    await expect(section('Settled').getByRole('button', { name: /Settled/ })).toBeInViewport();
    seen.refusedWork = (await refusedWork.innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '06-refused-work');
    expect(onDisk().some(c => c.title === 'Main' && c.projectPath === tars)).toBe(true);

    // Triage, the inbox, is refused too, in the store's words.
    await (await actions('Triage')).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await sidebar.getByRole('alertdialog').getByRole('button', { name: 'delete', exact: true }).click();
    await expect(sidebar.getByRole('alert')).toContainText("This chat is the project's inbox");
    seen.refusedInbox = (await sidebar.getByRole('alert').innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '07-refused-inbox');

    // Release notes, deleted: asked first, kept on cancel, gone on delete.
    await (await actions('Release notes for 1.9.6')).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const ask = sidebar.getByRole('alertdialog');
    await expect(ask).toContainText('Delete tars-demo #2, Release notes for 1.9.6?');
    seen.deleteAsks = (await ask.innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '08-delete-asks');
    await ask.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect(sidebar.locator('[data-chat-row]', { hasText: 'Release notes for 1.9.6' })).toHaveCount(1);
    await (await actions('Release notes for 1.9.6')).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await sidebar.getByRole('alertdialog').getByRole('button', { name: 'delete', exact: true }).click();
    await expect(sidebar.locator('[data-chat-row]', { hasText: 'Release notes for 1.9.6' })).toHaveCount(0);
    expect(onDisk().some(c => String(c.title).startsWith('Release notes'))).toBe(false);

    // The filter keeps tars-demo's chats.
    await sidebar.getByRole('button', { name: 'Project filter', exact: true }).click();
    await page.getByRole('menu', { name: 'Project filter', exact: true }).getByRole('menuitem', { name: 'tars-demo', exact: true }).click();
    seen.filtered = await texts(sidebar.locator('[data-chat-row]'));
    for (const text of seen.filtered as string[]) expect(text).toContain('tars-demo');
    await stepShot(page, '09-filter');

    // Projects: tars-demo's page, its chats by number, its team.
    await sidebar.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(/\/project\/?\?path=/);
    await expect(main.getByRole('heading', { name: 'tars-demo', exact: true })).toBeVisible({ timeout: 30_000 });
    const chatsPanel = main.getByRole('region', { name: 'Chats in tars-demo', exact: true });
    seen.projectChats = await texts(chatsPanel.locator('[data-project-chat]'));
    expect((seen.projectChats as string[]).map(t => t.split(' ')[0])).toEqual(['#1', '#3']);
    const team = main.getByRole('region', { name: 'Team', exact: true });
    seen.team = await texts(team.locator('[data-team-member]'));
    expect((seen.team as string[]).join(' ')).toContain('Lead');
    expect((seen.team as string[]).join(' ')).toContain('Backend');
    await stepShot(page, '10-project-page');

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

