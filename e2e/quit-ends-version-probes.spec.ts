import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Quitting Tars ends the version probes Settings started (the Audit's gate of
 * #298), in the real app.
 *
 * Settings asks each CLI for its version (`shell:version`). On 01/10 QA found
 * amp's, started just before a quit, still writing into the home after the
 * app was gone. The CLI here is a stand-in that takes its time to answer, and
 * meanwhile, with a child it started, writes into the home every 50 ms. The
 * window asks it for its version, the app quits while it is still thinking,
 * and from that moment on nothing may be written.
 *
 * The artefact: values.json with the writes before and after the quit.
 */

type Api = { electronAPI: { shell: { version(binary: string): Promise<unknown> } } };

test('quitting ends a version probe still running, and what it started', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-probe-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  const writes = path.join(home, 'writes');
  // writeNodeCli: the script itself on macOS and Linux; on Windows npm's shim
  // beside it, which the probe reads through to node and the script
  // (version-probe.ts), and whose tree the quit ends with taskkill /T. Tars
  // reads a shim through only to a .js script, hence the .cjs there.
  const amp = writeNodeCli(path.join(home, process.platform === 'win32' ? 'slow-amp.cjs' : 'slow-amp'), [
    "const fs = require('fs'); const { spawn } = require('child_process');",
    `const log = ${JSON.stringify(writes)};`,
    "const write = who => fs.appendFileSync(log, `${Date.now()} ${who}\\n`);",
    // Detached on Windows only: there libuv puts every other child of node in a
    // job that dies with node, so the child would end with the probe whatever
    // Tars does. A CLI's own children (claude.exe is not libuv) are in no such
    // job, and only taskkill /T ends them. Elsewhere it stays in the probe's group.
    "spawn(process.execPath, ['-e', `setInterval(() => require('fs').appendFileSync(${JSON.stringify(log)}, Date.now() + ' child\\\\n'), 50)`], { stdio: 'ignore', detached: process.platform === 'win32' });",
    "setInterval(() => write('amp'), 50);",
    "setTimeout(() => { console.log('amp 0.0.1'); process.exit(0); }, 60000);",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const read = () => (fs.existsSync(writes) ? fs.readFileSync(writes, 'utf8').trim().split('\n').filter(Boolean).map(l => {
    const [at, who] = l.split(' ');
    return { at: Number(at), who };
  }) : []);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31468), DOROTHY_E2E: '1' },
  });
  let quitAt = 0;
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    // Not awaited: it answers only when the probe ends, and the window closes first.
    page.evaluate(b => (window as unknown as Api).electronAPI.shell.version(b), amp).catch(() => undefined);
    // Both the probe and its child are at work.
    await expect.poll(() => new Set(read().map(w => w.who)).size, { timeout: 30_000 }).toBe(2);
  } finally {
    quitAt = Date.now();
    await app.close().catch(() => { /* gone */ });
  }
  const closedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const all = read();
  const after = all.filter(w => w.at > closedAt + 100);

  recordValues({ quitAt, closedAt, writesBefore: all.filter(w => w.at <= quitAt).length, writesAfterClose: after });

  expect(all.some(w => w.who === 'amp') && all.some(w => w.who === 'child')).toBe(true);
  expect(after, 'the probe, or what it started, wrote after Tars had quit').toEqual([]);
});
