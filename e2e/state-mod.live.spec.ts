// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/state-mod.live.spec.ts
//
// The state mod (mods/tars-state/, mods step 1, JeanBrasse's go of 2026-10-05), in a
// sandbox Tars with real Claude Code against the fake Messages API
// (e2e/live/fake-messages-api.mjs). Two agents on the same claude, each given
// one task:
// - "Mod agent" is launched as Tars launches any claude new enough: the mod
//   loads, registers its session, reports the turn (running, then idle with
//   its answer), and beats every 15 s; the shell hooks still run, and Tars
//   answers their posts for that session `ignored: state-mod`;
// - "Hooks agent" runs through a wrapper that drops the mod's two variables,
//   as a claude that cannot load it: no mod session, the shell hooks drive its
//   state exactly as before.
//
// Needs a native claude at 2.1.289 or newer: E2E_CLAUDE, or the `claude` on
// PATH. Its artefact, in the run directory: facts.jsonl, values.json and
// fake.log.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31466);
const STUB = 31966 + PORT_OFFSET;
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
  for (const dir of [path.join(home, '.claude'), path.join(home, '.dorothy'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
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
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([
    agent('mod', 'Mod agent', claude), agent('hooks', 'Hooks agent', plain),
  ], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({
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

test("the state mod reports a claude agent's turn and heartbeat, and a claude without it keeps the shell hooks", async () => {
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

    /** What main holds for an agent: its session, status, output, and the mod's record of it. */
    const state = id => app.evaluate(({ app: electronApp }, { id, dist }) => {
      const req = process.mainModule.require;
      const agent = req(`${dist}/core/agent-manager.js`).agents.get(id);
      const beat = req(`${dist}/services/state-mod.js`).modBeatFor(id);
      return agent && { status: agent.status, session: agent.currentSessionId ?? null, output: agent.lastCleanOutput ?? null, task: agent.currentTask ?? null, beat: beat ?? null };
    }, { id, dist: DIST });

    for (const id of ['mod', 'hooks']) {
      await page.evaluate(agentId => window.electronAPI.agent.start({ id: agentId, prompt: 'say ok' }), id);
    }
    // Each turn ends on the fake's "ok": the agent idle again, with that answer.
    for (const id of ['mod', 'hooks']) {
      await waitFor(async () => { const s = await state(id); return s?.output === 'ok' && s.status === 'idle'; }, 120_000, `${id}'s turn reported`);
      fact(`${id} turn`, await state(id));
    }
    const mod = await state('mod');
    const hooks = await state('hooks');
    // The heartbeat comes every 15 s: one more within 25.
    const firstBeat = mod.beat?.at ?? 0;
    await waitFor(async () => ((await state('mod')).beat?.at ?? 0) > firstBeat, 25_000, 'a heartbeat');
    const beat = (await state('mod')).beat;
    fact('mod beat', beat);

    const hookLog = fs.readFileSync(path.join(HOME, '.dorothy', 'logs', 'hooks.log'), 'utf8');
    const promptResults = hookLog.split('\n').filter(l => l.includes('USER_PROMPT_SUBMIT curl result'));
    fact('shell hooks', { promptResults });
    const setAside = id => promptResults.some(l => l.includes('"ignored":"state-mod"') && l.includes(`"id":"${id}"`));

    // The folder claude was handed: Claude Code writes .claude-plugin/types/
    // into a mod's folder at every load (the Audit's delta gate of #308), so it
    // must be Tars's own read-only copy, and hold nothing claude wrote.
    const handed = await app.evaluate((_e, { dist }) => process.mainModule.require(`${dist}/services/state-mod.js`).stateModDir(), { dist: DIST });
    const types = path.join(handed, '.claude-plugin', 'types');
    const tsconfig = path.join(handed, 'tsconfig.json');
    const handedFacts = {
      dir: handed,
      outsideTheRepo: !handed.startsWith(`${WT}/`),
      registerWritable: (fs.statSync(path.join(handed, 'hooks', 'register.ts')).mode & 0o222) !== 0,
      typesWritten: fs.readdirSync(types).length > 0,
      tsconfigWritten: !fs.statSync(tsconfig).isDirectory(),
    };
    fact('handed folder', handedFacts);

    recordValues({ claude: CLAUDE, mod, hooks, beat, promptResults, handed: handedFacts });
    expect(handedFacts).toMatchObject({ outsideTheRepo: true, registerWritable: false, typesWritten: false, tsconfigWritten: false });

    expect(mod.beat?.sessionId, 'the mod registered the session Tars runs').toBe(mod.session);
    expect(beat.at).toBeGreaterThan(firstBeat);
    expect(setAside('mod'), "the shell hook's post for the mod's session was taken").toBe(true);
    expect(hooks.beat, 'a claude without the mod has a mod session').toBeNull();
    expect(setAside('hooks'), "the shell hook's post was set aside for a session without the mod").toBe(false);
    expect(hooks.status).toBe('idle');
    expect(hooks.output).toBe('ok');
  } finally {
    await app?.close().catch(() => {});
    stub.kill();
  }
});
