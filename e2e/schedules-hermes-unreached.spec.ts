import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, stepShot } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

/**
 * Schedules says in words that Tars could not reach Hermes, for the list and for each row action, never the window's
 * raw error (QA's finding on #653's surfaces; the frames `Shell · Schedules · Hermes did not answer` and its notes).
 *
 * A stand-in Hermes lists one schedule, then is closed, so its port refuses: every call of the page meets a gateway
 * that does not answer, as on a machine where Hermes stopped. How it fails, written before the run:
 * 1. A row action (pause, run now, delete) says nothing: the click is lost, and the throw over IPC becomes a page error.
 * 2. It says Electron's own wrapping, "Error invoking remote method 'hermes:...': Error: ...", anywhere on the page.
 * 3. It says the reason without what it was doing, or what it was doing without the reason: the sentence is
 *    `Could not <pause|run|delete> "<name>": Tars could not reach Hermes: <the socket's reason>.` (the main process's
 *    own words since #660 add `at <url>` after Hermes, which this accepts too).
 * 4. The rows go: a failed action takes the list out of view.
 * 5. Reading the list says the raw error, or nothing: `Could not read the schedules: Tars could not reach Hermes: ...`.
 * 6. Any uncaught page error on the way.
 *
 * The artefact: values.json (each sentence as the page said it, and the page errors) and a screenshot per step.
 */

const JOB = { id: 'job-1', name: 'Nightly dependency audit', schedule: '0 3 * * *', state: 'scheduled', prompt: 'Audit the dependencies.' };
const HERMES = 31749 + PORT_OFFSET;
const RAW = 'Error invoking remote method';
/** The sentence of a call that met no Hermes: what it was doing, then that Tars could not reach it, then why. */
const unreached = (doing: string) => new RegExp(`^${doing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Tars could not reach Hermes(?: at \\S+)?: .*ECONNREFUSED.*\\.$`);

test('Schedules says in words that Tars could not reach Hermes, for the list, pause, run now and delete, never the raw error', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-schedules-unreached-'));
  seedSandbox(home);
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: HERMES, authMode: 'token' }, null, 2));

  // The stand-in: one schedule listed, and any change answered, until it is closed.
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/cron/jobs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET' ? [JOB] : JOB));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(HERMES, '127.0.0.1', resolve));
  let open = true;
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); open = false; });

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31743), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = { hermes: HERMES };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('dialog', dialog => dialog.accept());
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/crons`, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    const row = main.getByText(JOB.name, { exact: true });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await stepShot(page, '01-listed');

    // Hermes stops: its port refuses from here on.
    await close();
    const notice = main.getByRole('status').filter({ hasText: 'Could not' });
    const said = async () => (await notice.first().innerText()).replace(/\s+/g, ' ').replace(/ dismiss$/, '').trim();
    for (const [button, verb] of [['pause', 'pause'], ['run now', 'run'], ['delete', 'delete']] as const) {
      await main.getByRole('button', { name: button, exact: true }).first().click();
      await expect(notice, `${button}: its failure is said above the rows`).toContainText(`Could not ${verb} "${JOB.name}": `, { timeout: 30_000 });
      const sentence = await said();
      seen[button] = sentence;
      expect(sentence, `${button}: what it was doing, then why`).toMatch(unreached(`Could not ${verb} "${JOB.name}"`));
      await expect(row, `${button}: the rows stay in view`).toBeVisible();
      await expect(main, `${button}: never the window's raw error`).not.toContainText(RAW);
      await stepShot(page, `02-${verb}`);
    }

    // The list itself.
    await main.getByRole('button', { name: 'Refresh', exact: true }).click();
    const block = main.getByText('Could not read the schedules: ', { exact: false });
    await expect(block, 'the list: its failure is said').toBeVisible({ timeout: 30_000 });
    const list = (await block.innerText()).replace(/\s+/g, ' ').trim();
    seen.list = list;
    expect(list, 'the list: what it was doing, then why').toMatch(unreached('Could not read the schedules'));
    await expect(main, "the list: never the window's raw error").not.toContainText(RAW);
    await stepShot(page, '03-list');

    seen.pageErrors = pageErrors;
    expect(pageErrors, 'no page error on the way').toEqual([]);
  } finally {
    recordValues(seen);
    await app.close();
    if (open) await close();
    await removeHome(home);
  }
});
