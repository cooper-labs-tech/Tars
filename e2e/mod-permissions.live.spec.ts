// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/mod-permissions.live.spec.ts
//
// Permissions decided by Tars (mods step 2), in a sandbox Tars with real Claude
// Code against the fake Messages API (e2e/live/fake-messages-api.mjs), whose
// `RUNBASH <tag>` makes the model ask for `echo <tag> > ran-<tag>.txt`. Three
// agents in the default permission mode, where Claude Code asks before that
// command:
// - "Allow agent" (the mod): the question comes to Tars, the agent reads
//   waiting on a permission naming the command, with `permissionAsk`; nobody
//   answers for 45 s, past the hook's 10 s budget and past the ~30 s after
//   which a single request ended and Claude Code showed its dialog anyway
//   (Tars answers `pending` every 20 s and the mod asks again), then the
//   window allows it: the file is written, the model reads the command's
//   output, and the terminal's dialog never opened (no PermissionRequest);
// - "Deny agent" (the mod): the window refuses it with a reason: no file, and
//   the model reads who refused it and why;
// - "Dialog agent" (no mod, as a claude that cannot load it): the terminal's
//   dialog as before, Tars holding no question.
//
// Needs a native claude at 2.1.289 or newer: E2E_CLAUDE, or the `claude` on
// PATH. Its artefact, in the run directory: facts.jsonl, values.json, fake.log.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31465);
const STUB = 31965 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
let FACTS = '';

function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude) {
  const home = fs.mkdtempSync('/tmp/tars-perm-');
  const project = path.join(home, 'projects', 'perm');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark',
    hasCompletedOnboarding: true, lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  const plain = path.join(home, 'bin', 'claude-without-mod');
  fs.writeFileSync(plain, `#!/bin/bash\nunset CLAUDE_CODE_PLUGIN_DIRS CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\nexec '${claude}' "$@"\n`, { mode: 0o755 });
  const agent = (id, name, cliPath) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'normal', cliPath,
    lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([
    agent('allow', 'Allow agent', claude), agent('deny', 'Deny agent', claude), agent('dialog', 'Dialog agent', plain),
  ], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return { home, project };
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

test('a permission claude would ask in its dialog is asked of Tars, and the window decides it', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.setTimeout(8 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const { home: HOME, project: PROJECT } = seed(CLAUDE);
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
      return agent && {
        status: agent.status, waitingReason: agent.waitingReason ?? null, waitingOn: agent.waitingOn ?? null,
        permissionAsk: agent.permissionAsk ?? null, output: agent.lastCleanOutput ?? null, mod: !!beat,
      };
    }, { id, dist: DIST });
    const toolResults = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8') : '')
      .split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => typeof e.toolResult === 'string').map(e => e.toolResult);

    const asked = async (id, tag) => {
      const s = await waitFor(async () => { const v = await state(id); return v?.permissionAsk ? v : null; }, 150_000, `${id} asks Tars`);
      fact(`${id} asked`, s);
      expect(s.status).toBe('waiting');
      expect(s.waitingReason).toBe('permission');
      expect(s.waitingOn?.text).toContain(`echo ${tag} > ran-${tag}.txt`);
      return s;
    };

    for (const [id, tag] of [['allow', 'alpha'], ['deny', 'beta'], ['dialog', 'gamma']]) {
      await page.evaluate(({ agentId, prompt }) => window.electronAPI.agent.start({ id: agentId, prompt }), { agentId: id, prompt: `RUNBASH ${tag}` });
    }

    // Allow: held 45 s, past the hook's budget and the ~30 s a single request
    // lasted, then allowed from the window.
    const allowAsked = await asked('allow', 'alpha');
    await sleep(45_000);
    const stillHeld = await state('allow');
    fact('allow after 45 s', stillHeld);
    // Every allow names the fingerprint of the question read (#588's M1).
    const allowAnswer = await page.evaluate(fp => window.electronAPI.agent.answerPermission('allow', 'allow', undefined, fp), stillHeld.permissionAsk?.fingerprint);
    await waitFor(async () => { const s = await state('allow'); return s.status === 'idle' && (s.output ?? '').startsWith('tool said'); }, 120_000, 'allow turn ends');
    const allowEnd = await state('allow');
    fact('allow end', allowEnd);

    // Deny, with a reason the model reads.
    const denyAsked = await asked('deny', 'beta');
    const denyAnswer = await page.evaluate(() => window.electronAPI.agent.answerPermission('deny', 'deny', 'not in this sandbox'));
    await waitFor(async () => { const s = await state('deny'); return s.status === 'idle' && (s.output ?? '').startsWith('tool said'); }, 120_000, 'deny turn ends');
    const denyEnd = await state('deny');
    fact('deny end', denyEnd);

    // No mod: the terminal's dialog, as before, and no question held by Tars.
    const dialog = await waitFor(async () => { const s = await state('dialog'); return s?.status === 'waiting' && s.waitingReason === 'permission' ? s : null; }, 150_000, 'dialog agent waits on its dialog');
    fact('dialog', dialog);

    const hookLog = fs.readFileSync(path.join(HOME, '.tars', 'logs', 'hooks.log'), 'utf8');
    const dialogsOpened = ['allow', 'deny', 'dialog'].filter(id => hookLog.split('\n').some(l => l.includes('PERMISSION_REQUEST') && l.includes(`AGENT_ID=${id} `)));
    fact('dialogs opened', { dialogsOpened });
    const results = toolResults();
    const files = { alpha: fs.existsSync(path.join(PROJECT, 'ran-alpha.txt')), beta: fs.existsSync(path.join(PROJECT, 'ran-beta.txt')), gamma: fs.existsSync(path.join(PROJECT, 'ran-gamma.txt')) };
    fact('files', files);
    fact('tool results', { results });
    recordValues({ claude: CLAUDE, allowAsked, stillHeld, allowAnswer, allowEnd, denyAsked, denyAnswer, denyEnd, dialog, files, results, dialogsOpened });

    expect(allowAsked.mod && denyAsked.mod, 'both mod agents run the mod').toBe(true);
    expect(stillHeld.permissionAsk, 'still held by Tars after 45 s').not.toBeNull();
    expect(dialogsOpened, 'the terminal\'s dialog opened only where Tars held no question').toEqual(['dialog']);
    expect(allowAnswer).toEqual({ success: true });
    expect(files.alpha).toBe(true);
    expect(denyAnswer).toEqual({ success: true });
    expect(files.beta).toBe(false);
    expect(results.some(r => r.includes('the user refused it in Tars: not in this sandbox')), 'the model read who refused it and why').toBe(true);
    expect(dialog.mod).toBe(false);
    expect(dialog.permissionAsk).toBeNull();
    expect(files.gamma).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    stub.kill();
  }
});
