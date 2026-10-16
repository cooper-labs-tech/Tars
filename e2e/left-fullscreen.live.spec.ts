// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/left-fullscreen.live.spec.ts
//
// The renderer side of #127 (#132), proved in a sandbox Tars with real Claude
// Code against a fake Messages API (e2e/live/fake-messages-api.mjs), on its own
// throwaway project. QA's R1: a fullscreen claude is SIGKILLed and
// `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude` is run in the same shell.
// Beside it, a fullscreen session left alone and one inline from boot.
//
// Needs a native claude: E2E_CLAUDE, or the `claude` on PATH, resolved to its
// version file (written against 2.1.280). About four minutes. Its artefact, in
// the run directory: facts.jsonl, values.json, checks.json, the screenshots,
// fake.log and app-trace.zip. On a renderer before #132 the notice, the wheel
// guard, Copy Output and the size resend fail (the Frontend's control run on
// main 3387518); committed at QA's gate of #131, from the Frontend's proof.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const AM = `${DIST}/core/agent-manager.js`;
const PM = `${DIST}/core/pty-manager.js`;
const TM = `${DIST}/core/terminal-mirror.js`;
const PORT = apiPort(31481);
const STUB = 31981 + PORT_OFFSET;
const STYLE = fs.readFileSync(`${WT}/e2e/screenshot.css`, 'utf8');
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
// Set in the test, inside its output folder, which is inside the run directory.
let OUT = '';
let FAKE_LOG = '';
let FACTS = '';

/** The native claude this runs: E2E_CLAUDE, or the one on PATH, resolved to its version file. */
function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

/** Its own HOME under /tmp, a throwaway git project, and three agents on that claude. */
function seed(claude) {
  // Spelled /tmp, not /private/tmp: the fixture compares the app's folders with
  // it. Windows has no /tmp (the literal made C:\tmp): the temp dir there.
  const home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'tars-lfs-'));
  const project = path.join(home, 'projects', 'lfs');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.dorothy'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true,
  }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark',
    hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    // Claude reads its trust at the git root it resolves, and /tmp is /private/tmp.
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  // The inline-from-boot agent: the same binary, told at launch never to use the alternate screen.
  const inline = path.join(home, 'bin', 'claude-inline');
  fs.writeFileSync(inline, `#!/bin/bash\nexport CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1\nexec '${claude}' "$@"\n`, { mode: 0o755 });
  const agent = (id, name, cliPath) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath,
    lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([
    agent('full', NAMES.full, claude), agent('left', NAMES.left, claude), agent('inline', NAMES.inline, inline),
  ], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return home;
}
const NAMES = { full: 'Full agent', left: 'Left agent', inline: 'Inline agent' };
const IDS = Object.keys(NAMES);
const idOf = name => IDS.find(id => NAMES[id] === name);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fact = (step, data) => {
  fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
  console.log(`[fact] ${step} ${JSON.stringify(data).slice(0, 1500)}`);
};
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms} ms: ${what}`);
}
const stubLines = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const mainRequests = () => stubLines().filter(l => l.url && !l.side && l.stream);
const reached = text => mainRequests().some(l => (l.last || '').includes(text));
const countReports = s => (s.match(/\x1b\[<\d+;\d+;\d+M/g) || []).length;

test('a panel whose claude left fullscreen', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  // Its inline agent starts claude through a bash script, and finds claude with
  // `which`: Windows starts only a .exe or an npm .cmd shim (cli-binary.ts).
  test.skip(process.platform === 'win32', 'the inline agent is a bash script that execs claude, which Windows cannot start (cli-binary.ts starts a .exe or an npm .cmd shim); this runs on macOS and Linux');
  test.setTimeout(10 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FAKE_LOG = path.join(OUT, 'fake.log');
  FACTS = path.join(OUT, 'facts.jsonl');
  const HOME = seed(CLAUDE);
  const values = { claude: CLAUDE, home: HOME, api: PORT, fakeApi: STUB };
  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG }, stdio: 'ignore',
  });
  let app;
  try {
    await waitFor(async () => { try { await fetch(`http://127.0.0.1:${STUB}/`); return true; } catch { return false; } }, 10_000, 'fake API up');
    app = await launchSandboxed(electron, HOME, {
      env: {
        NODE_ENV: 'development',
        DOROTHY_DEV_URL: `${DEV_URL}/`,
        DOROTHY_API_PORT: PORT,
        DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`,
        ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
    });
    await app.context().tracing.start({ screenshots: true, snapshots: true }).catch(e => fact('trace not started', { error: String(e) }));
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 300_000 });

    // ---- Preflight, before any CLI starts: where would its hooks report?
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    await waitFor(() => { try { return !!JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks; } catch { return false; } }, 60_000, 'hooks configured');
    const hookJson = JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks);
    const scripts = [...new Set((hookJson.match(/\/[^"\s]+\.sh/g) || []))];
    const outside = scripts.filter(s => !s.startsWith(`${WT}/hooks/`));
    const hardcoded = scripts.filter(s => !fs.readFileSync(s, 'utf8').includes('${CLAUDE_MGR_API_URL:-'));
    fact('preflight-hooks', { scripts: scripts.map(s => s.replace(WT, '<wt>')), outside, hardcoded });
    if (outside.length || hardcoded.length || scripts.length === 0) throw new Error('hooks would not report to this sandbox');

    // ---- Recorders in the sandbox's main: every input, resize, start and stop the renderer sends.
    const wrapped = await app.evaluate(({ ipcMain }) => {
      globalThis.__rec = { input: [], resize: [], start: [], stop: [], restart: [] };
      const wrap = (channel, note) => {
        const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get(channel);
        if (!h) return false;
        ipcMain._invokeHandlers.set(channel, async (event, ...args) => { note(args); return h(event, ...args); });
        return true;
      };
      return [
        wrap('agent:input', ([p]) => globalThis.__rec.input.push({ at: Date.now(), id: p && p.id, input: p && p.input })),
        wrap('agent:resize', ([p]) => globalThis.__rec.resize.push({ at: Date.now(), id: p && p.id, cols: p && p.cols, rows: p && p.rows })),
        wrap('agent:start', ([p]) => globalThis.__rec.start.push({ at: Date.now(), id: p && p.id, options: p && p.options })),
        wrap('agent:stop', ([id]) => globalThis.__rec.stop.push({ at: Date.now(), id })),
        // The notice's restart is one call since #138 (38b01c02), which keeps
        // the conversation: a stop then a start began a new one.
        wrap('agent:restart', ([id]) => globalThis.__rec.restart.push({ at: Date.now(), id })),
      ];
    });
    fact('recorders', { wrapped });
    if (!wrapped.every(Boolean)) throw new Error('a recorder could not be installed');
    const rec = () => app.evaluate(() => globalThis.__rec);

    const list = () => page.evaluate(async () => (await window.electronAPI.agent.list()).map(a => ({
      id: a.id, status: a.status, cliRunning: a.cliRunning, leftFullscreen: a.leftFullscreen ?? null,
      ptyId: a.ptyId || null, session: a.currentSessionId ? a.currentSessionId.slice(0, 8) : null,
    })));
    const byId = async () => Object.fromEntries((await list()).map(a => [a.id, a]));
    const pty = id => app.evaluate((_e, [am, pm, agentId]) => {
      const a = process.mainModule.require(am).agents.get(agentId);
      const p = a && a.ptyId ? process.mainModule.require(pm).ptyProcesses.get(a.ptyId) : null;
      return p ? { ptyId: a.ptyId, pid: p.pid, cols: p.cols, rows: p.rows } : null;
    }, [AM, PM, id]);
    // The terminal's own state, from its mirror (terminal-mirror.ts terminalSnapshot):
    // the PTY the agent holds now, not agent.output, which a restart does not
    // empty and whose trims carry the old session's modes (the gate of #366).
    const terminalModes = id => app.evaluate((_e, [am, pm, tm, agentId]) => {
      const a = process.mainModule.require(am).agents.get(agentId);
      const p = a && a.ptyId ? process.mainModule.require(pm).ptyProcesses.get(a.ptyId) : null;
      const snap = p ? process.mainModule.require(tm).terminalSnapshot(p) : undefined;
      return snap === undefined ? null : { ptyId: a.ptyId, alternateScreen: snap.includes('\x1b[?1049h'), sgrMouse: snap.includes('\x1b[?1006h') };
    }, [AM, PM, TM, id]);
    // What the panel is handed on a remount since #127: one redraw of the screen.
    const screenOf = id => page.evaluate(async agentId => {
      const a = await window.electronAPI.agent.get(agentId);
      return a && a.output ? a.output.join('') : '';
    }, id);
    // Claude Code's own field, the way /dispatch types into it.
    const typeIn = (id, text) => app.evaluate((_e, [am, pm, agentId, t]) => {
      const a = process.mainModule.require(am).agents.get(agentId);
      const { ptyProcesses, writeProgrammaticInput } = process.mainModule.require(pm);
      return writeProgrammaticInput(ptyProcesses.get(a.ptyId), t, true);
    }, [AM, PM, id, text]);
    // The shell, as a person types a line at its prompt.
    const shellWrite = (id, text) => app.evaluate((_e, [am, pm, agentId, t]) => {
      const a = process.mainModule.require(am).agents.get(agentId);
      process.mainModule.require(pm).ptyProcesses.get(a.ptyId).write(t);
      return true;
    }, [AM, PM, id, text]);

    // Label every panel with its agent, and read what it shows.
    const panels = () => page.evaluate(names => {
      const out = {};
      for (const b of document.querySelectorAll('button')) {
        const t = b.getAttribute('title') || '';
        if (t !== 'Stop this agent' && !/^Start .* in this terminal$/.test(t)) continue;
        let root = b.parentElement;
        while (root && root.querySelectorAll('.xterm').length === 0) root = root.parentElement;
        if (!root || root.querySelectorAll('.xterm').length !== 1) continue;
        const name = names.find(n => (root.textContent || '').includes(n));
        if (!name) continue;
        root.setAttribute('data-panel', name);
        b.setAttribute('data-sb', name);
        const notice = [...root.querySelectorAll('[role=status]')].find(e => (e.textContent || '').includes('Claude left fullscreen:'));
        if (notice) notice.setAttribute('data-notice', name);
        const rows = root.querySelector('.xterm-rows');
        const viewport = root.querySelector('.xterm-viewport');
        const screen = root.querySelector('.xterm-screen');
        out[name] = {
          button: b.textContent.trim(),
          notice: notice ? notice.textContent.replace(/\s+/g, ' ').trim() : null,
          noticeHeight: notice ? notice.getBoundingClientRect().height : null,
          noticeButtons: notice ? [...notice.querySelectorAll('button')].map(x => ({ text: x.textContent.trim(), height: x.getBoundingClientRect().height })) : [],
          screen: rows ? rows.innerText.split('\n').map(l => l.trimEnd()).filter(Boolean) : null,
          viewportTop: viewport ? viewport.scrollTop : null,
          screenSize: screen ? { w: Math.round(screen.getBoundingClientRect().width), h: Math.round(screen.getBoundingClientRect().height) } : null,
        };
      }
      return out;
    }, Object.values(NAMES));
    const shot = async name => page.screenshot({ path: path.join(OUT, `${name}.png`), style: STYLE });

    // Six notches up over a panel's terminal, through CDP, as a mouse sends them.
    const wheelOver = async name => {
      await panels();
      const box = await page.locator(`[data-panel="${name}"] .xterm-screen`).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(300);
      const before = (await rec()).input.length;
      const p0 = (await panels())[name];
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await sleep(150); }
      await sleep(2000);
      const id = idOf(name);
      const sent = (await rec()).input.slice(before).filter(x => x.id === id);
      const p1 = (await panels())[name];
      return {
        notches: 6,
        reportsSent: sent.reduce((n, x) => n + countReports(String(x.input)), 0),
        inputCalls: sent.length,
        screenChanged: JSON.stringify(p0.screen) !== JSON.stringify(p1.screen),
        viewportTop: [p0.viewportTop, p1.viewportTop],
        lastLineBefore: (p0.screen || []).slice(-3),
        lastLineAfter: (p1.screen || []).slice(-3),
      };
    };

    // ================= The Dashboard, three idle agents =================
    await waitFor(async () => Object.keys(await panels()).length >= 3, 180_000, 'three panels');
    await sleep(1500);
    await shot('0-dashboard-idle');

    // Start each from its panel's own start button.
    for (const name of Object.values(NAMES)) {
      await panels();
      await page.locator(`[data-sb="${name}"]`).click();
      await sleep(1200);
    }
    await waitFor(async () => { const a = await byId(); return IDS.every(id => a[id].session); }, 120_000, 'three sessions registered');
    await sleep(4000);
    values.boot = {};
    for (const id of IDS) {
      const s = await screenOf(id);
      values.boot[id] = { alternateScreen: s.includes('\x1b[?1049h'), pty: await pty(id) };
    }
    fact('boot', values.boot);

    // A turn each, long enough to leave something to scroll.
    fact('type full', { outcome: await typeIn('full', 'LINES 80 F') });
    fact('type inline', { outcome: await typeIn('inline', 'LINES 80 I') });
    fact('type left', { outcome: await typeIn('left', 'LINES 40 L') });
    await waitFor(() => reached('LINES 80 F') && reached('LINES 80 I') && reached('LINES 40 L'), 90_000, 'three turns reached the model');
    await sleep(6000);
    values.baseline = { list: await list(), panels: await panels() };
    fact('baseline', { list: values.baseline.list, notices: Object.fromEntries(Object.entries(values.baseline.panels).map(([k, v]) => [k, v.notice])) });
    await shot('1-three-sessions');

    // ================= QA's R1 on Left =================
    const leftPty = await pty('left');
    const kids = execFileSync('pgrep', ['-P', String(leftPty.pid)]).toString().trim().split('\n').filter(Boolean).map(Number);
    const described = kids.map(k => {
      try {
        return { pid: k, comm: execFileSync('ps', ['-o', 'ucomm=', '-p', String(k)]).toString().trim(), args: execFileSync('ps', ['-o', 'args=', '-p', String(k)]).toString().trim().slice(0, 90) };
      } catch { return { pid: k, gone: true }; }
    });
    const target = described.find(d => d.comm === path.basename(CLAUDE) || (d.args || '').includes(CLAUDE));
    if (!target) throw new Error(`no claude under Left's shell: ${JSON.stringify(described)}`);
    process.kill(target.pid, 'SIGKILL');
    fact('R1 SIGKILL', { shellPid: leftPty.pid, children: described, killed: target.pid });
    await sleep(2500);
    await shellWrite('left', `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 '${CLAUDE}' --dangerously-skip-permissions\r`);
    fact('R1 inline claude typed at the shell', {});
    await sleep(9000);
    fact('type left (inline now)', { outcome: await typeIn('left', 'LINES 40 R') });
    await waitFor(() => reached('LINES 40 R'), 60_000, 'the inline turn reached the model');
    const flaggedAt = await waitFor(async () => (await byId()).left.leftFullscreen === true && Date.now(), 60_000, 'left flagged').catch(() => null);
    values.flagged = { flagged: !!flaggedAt, list: await list() };
    fact('flagged', values.flagged);
    if (!flaggedAt) throw new Error('the main process never raised leftFullscreen: R1 did not reproduce');

    // The panels, once the tick has carried it.
    await waitFor(async () => (await panels())['Left agent'].notice !== null, 20_000, 'the notice on Left');
    await sleep(1000);
    values.flaggedPanels = await panels();
    fact('panels with Left flagged', Object.fromEntries(Object.entries(values.flaggedPanels).map(([k, v]) => [k, { notice: v.notice, noticeHeight: v.noticeHeight, noticeButtons: v.noticeButtons }])));
    await shot('2-left-flagged');
    {
      const box = await page.locator('[data-panel="Left agent"]').boundingBox();
      const clip = { x: box.x, y: box.y, width: box.width, height: 150 };
      await page.screenshot({ path: path.join(OUT, '2b-left-notice-dark.png'), clip, style: STYLE });
      await page.evaluate(() => document.documentElement.classList.toggle('dark', false));
      await sleep(500);
      await page.screenshot({ path: path.join(OUT, '2c-left-notice-light.png'), clip, style: STYLE });
      await page.evaluate(() => document.documentElement.classList.toggle('dark', true));
      await sleep(500);
    }

    // ---- The wheel over each panel.
    values.wheel = {};
    for (const name of Object.values(NAMES)) values.wheel[name] = await wheelOver(name);
    fact('wheel', values.wheel);

    // ---- Copy Output from Full's context menu, into a recorder rather than Noah's clipboard.
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async t => { window.__copied = t; } });
    });
    await panels();
    await page.locator('[data-panel="Full agent"]').getByText('Full agent', { exact: true }).first().click({ button: 'right' });
    await page.getByText('Copy Output', { exact: true }).click();
    await sleep(1000);
    const copied = await page.evaluate(() => window.__copied);
    values.copy = {
      length: copied ? copied.length : null,
      hasEscape: copied ? copied.includes('\x1b') : null,
      startsWithRIS: copied ? copied.startsWith('\x1bc') : null,
      hasTheAnswer: copied ? /F line \d+ of 80/.test(copied) : null,
      head: copied ? JSON.stringify(copied.slice(0, 160)) : null,
    };
    fact('copy output', values.copy);

    // ---- A new PTY under a panel: the size it is born at, and the size it ends at.
    // Another window asks Full's terminal for 120x30 (the Agents window, the
    // tray); then Full is stopped and started from its own header.
    const fullBefore = await pty('full');
    await page.evaluate(() => window.electronAPI.agent.resize({ id: 'full', cols: 120, rows: 30 }));
    await sleep(800);
    const forced = await pty('full');
    await panels();
    await page.locator('[data-sb="Full agent"]').click();
    await waitFor(async () => !(await byId()).full.ptyId, 20_000, 'Full stopped');
    await sleep(1000);
    const startAt = Date.now();
    await panels();
    await page.locator('[data-sb="Full agent"]').click();
    await waitFor(async () => { const a = (await byId()).full; return a.ptyId && a.ptyId !== fullBefore.ptyId; }, 30_000, 'Full has a new terminal');
    await sleep(5000);
    const fullAfter = await pty('full');
    values.sizeResend = {
      panelSize: { cols: fullBefore.cols, rows: fullBefore.rows },
      forced: { cols: forced.cols, rows: forced.rows },
      newPty: fullAfter,
      resizesFromRenderer: (await rec()).resize.filter(r => r.id === 'full' && r.at >= startAt).map(r => ({ ms: r.at - startAt, cols: r.cols, rows: r.rows })),
    };
    fact('size resend', values.sizeResend);

    // ---- Restart, from the notice.
    {
      const old = await byId();
      // The negative witness (Rule 3.5): E2E_WITNESS_INLINE_RESTART=1 makes the
      // restarted claude come back inline, which must turn the restart check red.
      // The main process's environment is what the restarted terminal inherits.
      if (process.env.E2E_WITNESS_INLINE_RESTART === '1') {
        await app.evaluate(() => { process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'; });
        fact('witness', { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' });
      }
      const clickAt = Date.now();
      await panels();
      await page.locator('[data-notice="Left agent"]').getByRole('button', { name: 'restart' }).click();
      await waitFor(async () => { const a = (await byId()).left; return a.ptyId && a.ptyId !== old.left.ptyId; }, 30_000, 'Left has a new terminal');
      await waitFor(async () => { const a = (await byId()).left; return a.session && a.session !== old.left.session; }, 60_000, 'Left has a new session');
      await sleep(5000);
      const r = await rec();
      const screen = await screenOf('left');
      values.restart = {
        stops: r.stop.filter(x => x.id === 'left' && x.at >= clickAt).length,
        starts: r.start.filter(x => x.id === 'left' && x.at >= clickAt).map(x => x.options),
        restarts: r.restart.filter(x => x.id === 'left' && x.at >= clickAt).length,
        list: (await list()).find(a => a.id === 'left'),
        alternateScreen: screen.includes('\x1b[?1049h'),
        newTerminal: await terminalModes('left'),
        panel: (({ notice, noticeButtons }) => ({ notice, noticeButtons }))((await panels())['Left agent']),
      };
      fact('restart', values.restart);
      await shot('4-left-restarted');
      values.restart.wheel = await wheelOver('Left agent');
      fact('wheel after restart', values.restart.wheel);
    }

    values.pageErrors = pageErrors;
    fact('page errors', { pageErrors });
    await app.context().tracing.stop({ path: path.join(OUT, 'app-trace.zip') }).catch(e => fact('trace not saved', { error: String(e) }));
    fs.writeFileSync(path.join(OUT, 'values.json'), JSON.stringify(values, null, 2));

    // ================= What must hold =================
    const w = values.wheel;
    const checks = {
      'Full and Left boot fullscreen, Inline inline': values.boot.full.alternateScreen && values.boot.left.alternateScreen && !values.boot.inline.alternateScreen,
      'no notice before R1': Object.values(values.baseline.panels).every(p => p.notice === null),
      'main flags Left only': values.flagged.list.every(a => (a.id === 'left') === (a.leftFullscreen === true)),
      'the notice on Left only': (values.flaggedPanels['Left agent'].notice || '').startsWith('Claude left fullscreen: the wheel cannot scroll this terminal.')
        && values.flaggedPanels['Left agent'].noticeButtons.map(b => b.text).join() === 'restart'
        && values.flaggedPanels['Full agent'].notice === null && values.flaggedPanels['Inline agent'].notice === null,
      'the notice row and its buttons are 26 high': values.flaggedPanels['Left agent'].noticeHeight === 26 && values.flaggedPanels['Left agent'].noticeButtons.every(b => b.height === 26),
      'no report leaves Left': w['Left agent'].reportsSent === 0,
      'Full still sends the wheel and its screen moves': w['Full agent'].reportsSent > 0 && w['Full agent'].screenChanged,
      'Inline scrolls its own history': w['Inline agent'].reportsSent === 0 && w['Inline agent'].viewportTop[1] < w['Inline agent'].viewportTop[0],
      'Copy Output is the text on screen': values.copy.hasEscape === false && values.copy.hasTheAnswer === true,
      'a new PTY ends at its panel\'s size': values.sizeResend.newPty.cols === values.sizeResend.panelSize.cols && values.sizeResend.newPty.rows === values.sizeResend.panelSize.rows,
      'restart gives a fullscreen session and the wheel back': !!(values.restart && values.restart.restarts === 1 && values.restart.stops === 0 && values.restart.starts.length === 0
        && values.restart.newTerminal && values.restart.newTerminal.ptyId !== null && values.restart.newTerminal.alternateScreen && values.restart.newTerminal.sgrMouse
        && values.restart.list.leftFullscreen === false && values.restart.panel.notice === null && values.restart.wheel.reportsSent > 0),
      'no page error': pageErrors.length === 0,
    };
    fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));
    console.log('[checks]', JSON.stringify(checks, null, 2));
    for (const [name, ok] of Object.entries(checks)) expect.soft(ok, name).toBe(true);
  } finally {
    if (app) await app.close().catch(() => {});
    stub.kill();
  }
});
