// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/held-behind-reply.live.spec.ts
//
// The held-message bug of 04/10 (bug-held-forever-05-10.md): three agents idle at their prompt, each with a message
// HELD for hours, its draft read as not empty. This drives a real Claude Code (E2E_CLAUDE, or the claude on PATH)
// against the fake Messages API, in a sandbox Tars, its panel mounted on the Dashboard, and records every chunk the
// panel sends to the main process (agent:input). After each thing a person does without typing (nothing, the window
// losing and taking focus, a resize, a minute idle, a click in the panel), a probe goes through the writer every
// message takes, and the probe's outcome is recorded with the chunks that came before it.
//
// Its artefact, in the run directory: facts.jsonl (every chunk, escaped), values.json, fake.log, app-trace.zip.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const AM = `${DIST}/core/agent-manager.js`;
const PM = `${DIST}/core/pty-manager.js`;
const PORT = apiPort(31466);
const STUB = 31966 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
let OUT = '';
let FAKE_LOG = '';
let FACTS = '';

function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude) {
  const home = fs.mkdtempSync('/tmp/tars-held-');
  const project = path.join(home, 'projects', 'held');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.dorothy'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ tui: 'fullscreen', skipDangerousModePermissionPrompt: true }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false,
    hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: 'worker', name: 'Held Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath: claude, lastActivity: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return home;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fact = (step, data) => {
  fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
  console.log(`[fact] ${step} ${JSON.stringify(data).slice(0, 600)}`);
};
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms} ms: ${what}`);
}
const stubLines = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reached = (text) => stubLines().some((l) => l.url && !l.side && l.stream && (l.last || '').includes(text));

test('a message to an idle agent whose panel is mounted goes in, whatever the panel answers the terminal', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.setTimeout(10 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FAKE_LOG = path.join(OUT, 'fake.log');
  FACTS = path.join(OUT, 'facts.jsonl');
  const HOME = seed(CLAUDE);
  const values = { claude: CLAUDE, home: HOME, probes: [] };
  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG }, stdio: 'ignore',
  });
  let app;
  try {
    await waitFor(async () => { try { await fetch(`http://127.0.0.1:${STUB}/`); return true; } catch { return false; } }, 10_000, 'fake API up');
    app = await launchSandboxed(electron, HOME, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/`, DOROTHY_API_PORT: PORT, DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    });
    await app.context().tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 300_000 });

    // Every chunk a panel sends, recorded in the sandbox's main before the handler gets it.
    const wrapped = await app.evaluate(({ ipcMain }) => {
      globalThis.__rec = [];
      const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('agent:input');
      if (!h) return false;
      ipcMain._invokeHandlers.set('agent:input', async (event, ...args) => {
        globalThis.__rec.push({ at: Date.now(), id: args[0] && args[0].id, input: args[0] && args[0].input });
        return h(event, ...args);
      });
      return true;
    });
    if (!wrapped) throw new Error('the recorder could not be installed');
    const rec = () => app.evaluate(() => globalThis.__rec);
    const status = () => page.evaluate(async () => {
      const a = (await window.electronAPI.agent.list()).find((x) => x.id === 'worker');
      return { status: a.status, waitingReason: a.waitingReason ?? null, cliRunning: a.cliRunning, session: !!a.currentSessionId };
    });
    // A message, through the writer /message, the bus and the bots all take.
    const probe = (text) => app.evaluate((_e, [am, pm, t]) => {
      const a = process.mainModule.require(am).agents.get('worker');
      const { ptyProcesses, writeProgrammaticInput } = process.mainModule.require(pm);
      return writeProgrammaticInput(ptyProcesses.get(a.ptyId), t, true, { agentId: 'worker', from: 'Tars', sender: { kind: 'tars' } });
    }, [AM, PM, text]);
    let seen = 0;
    const step = async (name, act) => {
      await act();
      const chunks = (await rec()).slice(seen);
      seen += chunks.length;
      for (const c of chunks) fact(`${name}: chunk`, { input: JSON.stringify(c.input) });
      const text = `PROBE ${name}`;
      const outcome = await probe(text);
      const typed = await waitFor(async () => reached(text), 40_000, `probe ${name} reached the model`).then(() => true, () => false);
      const entry = { step: name, outcome, typed, chunks: chunks.map((c) => JSON.stringify(c.input)), status: await status() };
      values.probes.push(entry);
      fact(`${name}: probe`, entry);
      // An idle prompt between steps, as the agent sits after a turn.
      await waitFor(async () => (await status()).status !== 'running', 60_000, 'back at rest').catch(() => undefined);
      await sleep(1500);
    };

    // The panel, and the agent started from it.
    const startButton = page.locator('button[title^="Start "]').first();
    await waitFor(async () => (await startButton.count()) > 0, 180_000, 'the panel and its start button');
    await startButton.click();
    await waitFor(async () => (await status()).session, 120_000, 'the session registered');
    await waitFor(async () => (await status()).status !== 'running', 60_000, 'at rest');
    await sleep(4000);
    // When the CLI asks the terminal for a colour (OSC 10/11 query), from its output in the main process.
    await app.evaluate((_e, [am, pm]) => {
      const a = process.mainModule.require(am).agents.get('worker');
      const p = process.mainModule.require(pm).ptyProcesses.get(a.ptyId);
      globalThis.__queries = [];
      p.onData((d) => { const m = d.match(/\x1b\](1[01]);\?/g); if (m) globalThis.__queries.push({ at: Date.now(), queries: m }); });
    }, [AM, PM]);
    const queries = () => app.evaluate(() => globalThis.__queries);

    await step('boot', async () => undefined);
    await step('blur-focus', async () => {
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.blur(); });
      await sleep(1500);
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.focus(); w.webContents.focus(); });
      await sleep(1500);
    });
    await step('resize', async () => {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1300, 900); });
      await sleep(2000);
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1600, 1000); });
      await sleep(2000);
    });
    await step('click-in-panel', async () => {
      const box = await page.locator('.xterm-screen').first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
      await sleep(1500);
    });
    await step('idle-70s', async () => { await sleep(70_000); });
    await step('theme-toggle', async () => {
      const toggle = page.getByText(/Light Mode|Dark Mode/).first();
      if (await toggle.count()) { await toggle.click(); await sleep(1500); await toggle.click(); await sleep(1500); }
    });

    values.colourQueries = await queries();
    fact('colour queries seen in the CLI output', { queries: values.colourQueries });
    recordValues(values);
    expect(values.probes.every((p) => p.typed), 'every probe reached the model').toBe(true);
  } finally {
    if (app) {
      await app.context().tracing.stop({ path: path.join(OUT, 'app-trace.zip') }).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    stub.kill();
  }
});
