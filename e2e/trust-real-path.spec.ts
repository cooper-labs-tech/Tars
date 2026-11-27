import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A claude agent whose project is reached through a link starts trusted (2.0.4). Claude Code reads
 * `projects[<folder>].hasTrustDialogAccepted` in ~/.claude.json under the folder it starts in as the system names it,
 * its real path; Tars wrote it under the spelling it saved alone. Anything under macOS's /var or /tmp, or a checkout
 * linked elsewhere, then met "Do you trust the files in this folder?", and the agent's first task answered it: in the
 * QA's CLI matrix with the system TMPDIR (19/10), claude's first task went into the question and it never called
 * delegate_task, and every pair after it hung.
 *
 * The real app on a sandbox HOME; the project saved as `<home>/linked/demo`, `<home>/linked` a link to
 * `<home>/elsewhere`. Agent dev's CLI is a stand-in named `claude` that, as Claude Code, reads the trust under its real
 * working directory, and logs whether it would ask.
 * Asserted: started from the window, it does not ask, and
 * ~/.claude.json trusts the project under its real path.
 * Red on main (bc169117): it asks.
 * The artefact: values.json (the stand-in's log, the projects ~/.claude.json trusts).
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path');
const real = process.cwd();
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.claude.json'), 'utf8')); } catch {}
const asks = cfg.projects?.[real]?.hasTrustDialogAccepted !== true;
fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ cwd: real, asks }) + '\n');
process.stdout.write(asks ? 'Do you trust the files in this folder?\n' : 'ready\n');
process.stdin.resume();
`;

type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

test(`a claude agent whose project is reached through a link starts trusted`, async () => {
  test.setTimeout(120_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-trust-link-'));
  const real = path.join(home, 'elsewhere', 'demo');
  const bin = path.join(home, 'bin');
  for (const d of [real, bin, path.join(home, '.tars')]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'linked'));
  const project = path.join(home, 'linked', 'demo');
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: {} }));
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([{
    id: 'dev', name: 'Build Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'bypass', cliPath: claude, createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] } }));
  const log = path.join(home, 'stand-in.jsonl');
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31383), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
    await expect.poll(() => fs.existsSync(log), { timeout: 60_000 }).toBe(true);
    const seen = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as Array<{ cwd: string; asks: boolean }>;
    const trusted = Object.entries((JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }).projects ?? {})
      .filter(([, p]) => p.hasTrustDialogAccepted === true).map(([k]) => k);
    recordValues({ project, real: fs.realpathSync(project), seen, trusted });
    expect.soft(seen[0]?.cwd).toBe(fs.realpathSync(project));
    expect.soft(seen[0]?.asks, 'the trust question shown').toBe(false);
    expect.soft(trusted).toContain(fs.realpathSync(project));
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
