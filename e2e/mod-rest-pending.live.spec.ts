// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/mod-rest-pending.live.spec.ts
//
// What the state mod tells Tars at a Stop about the work an agent leaves waiting
// inside its CLI (QA's gate of #322, run with the mod on): Claude Code hands the
// Stop hook `session_crons` and `background_tasks`; on-stop.sh counts them as
// `pending`, which decides whether the sleep pass may end the agent. For a
// session the mod registered, the shell's post is set aside, so the mod's Stop
// must count them too, or the agent's timers and background tasks are lost.
//
// Real Claude Code against the fake Messages API, whose `RUNBG <tag>` leaves a
// Bash `sleep 600` running in the background. "Mod agent" loads the mod;
// "Hooks agent" cannot (the wrapper drops its variables), as the control.
// Needs a native claude at 2.1.289 or newer: E2E_CLAUDE, or the `claude` on PATH.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31461);
const STUB = 31961 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
let FACTS = '';
let FAKE_LOG = '';

function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude) {
  const home = fs.mkdtempSync('/tmp/tars-mod-');
  const project = path.join(home, 'projects', 'mod');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark',
    hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  // A claude that cannot load the mod: the same binary, without its two variables.
  const plain = path.join(home, 'bin', 'claude-without-mod');
  fs.writeFileSync(plain, `#!/bin/bash\nunset CLAUDE_CODE_PLUGIN_DIRS CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\nexec '${claude}' "$@"\n`, { mode: 0o755 });
  const agent = (id, name, cliPath) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath,
    lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([
    agent('mod', 'Mod agent', claude), agent('hooks', 'Hooks agent', plain),
  ], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return home;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fact = (step, data) => {
  fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
  console.log(`[fact] ${step} ${JSON.stringify(data).slice(0, 800)}`);
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

test("the state mod's Stop counts the background work an agent leaves running, as on-stop.sh does", async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.setTimeout(6 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  FAKE_LOG = path.join(OUT, 'fake.log');
  const HOME = seed(CLAUDE);
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
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 300_000 });
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    await waitFor(() => { try { return !!JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks; } catch { return false; } }, 60_000, 'hooks configured');

    const state = id => app.evaluate((_e, { id, dist }) => {
      const req = process.mainModule.require;
      const agent = req(`${dist}/core/agent-manager.js`).agents.get(id);
      const beat = req(`${dist}/services/state-mod.js`).modBeatFor(id);
      return agent && { status: agent.status, output: agent.lastCleanOutput ?? null, restPending: agent.restPending ?? null, mod: !!beat };
    }, { id, dist: DIST });

    for (const id of ['mod', 'hooks']) {
      await page.evaluate(agentId => window.electronAPI.agent.start({ id: agentId, prompt: 'RUNBG nightly' }), id);
    }
    const ended = {};
    const toolResults = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8') : '').split('\n').filter(l => l.includes('[tool_result]')).length;
    // Both turns brought their tool's result back and were answered.
    await waitFor(() => toolResults() >= 2, 150_000, 'both tool results answered');
    for (const id of ['mod', 'hooks']) {
      try {
        ended[id] = await waitFor(async () => { const s = await state(id); return s && s.status !== 'running' ? s : null; }, 60_000, `${id}'s turn ends`);
      } catch (err) {
        fact(`${id} never at rest`, await state(id));
        throw err;
      }
      // The Stop's posts land just after the status flips: give them a moment.
      await sleep(3_000);
      ended[id] = await state(id);
      fact(`${id} at rest`, ended[id]);
    }
    recordValues({ claude: CLAUDE, ended });

    expect(ended.mod.mod, 'the mod runs the session').toBe(true);
    expect(ended.hooks.mod, 'the control runs no mod').toBe(false);
    expect(ended.hooks.restPending, 'on-stop.sh counts it (the control)').toEqual({ crons: 0, background: 1 });
    expect(ended.mod.restPending, "the mod's Stop counts it").toEqual({ crons: 0, background: 1 });
  } finally {
    await app?.close().catch(() => {});
    stub.kill();
    await removeHome(HOME);
  }
});
