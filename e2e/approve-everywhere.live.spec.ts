// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/approve-everywhere.live.spec.ts
//
// Every permission question allowable from the window (approve-everywhere.md, the owner's question of 10/11: "pourquoi
// ouvrir le terminal et ne plutôt remplacer 'ask in terminal' par 'approve' ???"). A sandbox Tars, real Claude Code
// against the fake Messages API (e2e/live/fake-messages-api.mjs), whose `RUNWRITE <tag> <n>` makes the model ask for
// one Write of a new file of n numbered lines. One agent in the default permission mode, where Claude Code asks before
// that Write, running the state mod:
// - the question comes to Tars with the file's content (until 2.0.7 the mod sent its path alone, the route marked it
//   withheld, and for an agent not in bypass it went straight to the terminal's dialog);
// - what the agent's status carries is a view: the content cut at 2,000 characters, `cut` naming it, no fingerprint;
// - agent.permissionQuestion gives the window the question whole, the content byte for byte, with its fingerprint;
// - an allow that names no fingerprint is refused (`success: false`, `code: 'read-first'`), the question still held;
// - the allow naming the fingerprint is taken: the file is written with exactly that content, and the terminal's dialog
//   never opened (no PermissionRequest in hooks.log).
//
// Negative witness: E2E_STATE_MOD_DIR=<a folder holding #582's state mod, `tars-state`> runs the agent on that mod,
// which withholds a file's content: the question never reaches Tars and the spec fails at "asks Tars".
//
// Needs a native claude at 2.1.321 or newer: E2E_CLAUDE, or the `claude` on PATH. Its artefact, in the run directory:
// facts.jsonl, values.json, fake.log.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';
import { writtenContent } from './live/written-content.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31513);
const STUB = 31993 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
const TAG = 'delta';
const LINES = 400;
let FACTS = '';

function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude, stateModDir) {
  const home = fs.mkdtempSync('/tmp/tars-approve-');
  const project = path.join(home, 'projects', 'approve');
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
  // The witness runs the agent on another state mod: Tars's own copy is named in CLAUDE_CODE_PLUGIN_DIRS, replaced here.
  let cliPath = claude;
  if (stateModDir) {
    cliPath = path.join(home, 'bin', 'claude-old-mod');
    fs.writeFileSync(cliPath, `#!/bin/bash\nexport CLAUDE_CODE_PLUGIN_DIRS='${stateModDir}'\nexec '${claude}' "$@"\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([{
    id: 'writer', name: 'Writer', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'normal', cliPath, lastActivity: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return { home, project: fs.realpathSync(project) };
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

test('a file an agent writes is asked of Tars with its content, shown whole, and allowed from the window', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.setTimeout(6 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const { home: HOME, project: PROJECT } = seed(CLAUDE, process.env.E2E_STATE_MOD_DIR);
  fact('seeded', { claude: CLAUDE, oldMod: process.env.E2E_STATE_MOD_DIR ?? null });
  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG, FAKE_WRITE_DIR: PROJECT }, stdio: 'ignore',
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

    const state = () => app.evaluate((_e, { dist }) => {
      const req = process.mainModule.require;
      const agent = req(`${dist}/core/agent-manager.js`).agents.get('writer');
      const beat = req(`${dist}/services/state-mod.js`).modBeatFor('writer');
      return agent && {
        status: agent.status, waitingReason: agent.waitingReason ?? null,
        permissionAsk: agent.permissionAsk ?? null, output: agent.lastCleanOutput ?? null, mod: !!beat,
      };
    }, { dist: DIST });

    const expected = writtenContent(TAG, LINES);
    const target = path.join(PROJECT, `written-${TAG}.md`);
    await page.evaluate(prompt => window.electronAPI.agent.start({ id: 'writer', prompt }), `RUNWRITE ${TAG} ${LINES}`);

    // The question reaches Tars, with the file's content.
    const asked = await waitFor(async () => { const s = await state(); return s?.permissionAsk ? s : null; }, 150_000, 'the writer asks Tars');
    const view = asked.permissionAsk;
    fact('asked', { status: asked.status, mod: asked.mod, tool: view.tool, cut: view.cut ?? null, fingerprint: view.fingerprint ?? null, withheld: view.withheld ?? null, contentInView: view.fields.content?.length ?? null });

    // The window's whole question.
    const whole = await page.evaluate(() => window.electronAPI.agent.permissionQuestion('writer'));
    fact('whole', { success: whole.success, tool: whole.question?.tool, filePath: whole.question?.fields?.file_path, contentLength: whole.question?.fields?.content?.length ?? null, fingerprint: whole.question?.fingerprint ?? null });

    // An allow naming nothing is refused for a cut view; the one naming what the window read is taken.
    const blind = await page.evaluate(() => window.electronAPI.agent.answerPermission('writer', 'allow'));
    const stillHeld = await state();
    const allowed = await page.evaluate(fp => window.electronAPI.agent.answerPermission('writer', 'allow', undefined, fp), whole.question?.fingerprint);
    fact('answers', { blind, stillHeld: !!stillHeld.permissionAsk, allowed });
    await waitFor(async () => { const s = await state(); return s.status === 'idle' && (s.output ?? '').startsWith('tool said') ? s : null; }, 120_000, 'the writer\'s turn ends');

    const written = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const hookLog = fs.readFileSync(path.join(HOME, '.tars', 'logs', 'hooks.log'), 'utf8');
    const dialogOpened = hookLog.split('\n').some(l => l.includes('PERMISSION_REQUEST') && l.includes('AGENT_ID=writer '));
    const permissionsLog = fs.readFileSync(path.join(HOME, '.tars', 'logs', 'permissions.log'), 'utf8').trim().split('\n');
    fact('end', { written: written === null ? null : { length: written.length, same: written === expected }, dialogOpened, permissionsLog });
    recordValues({
      claude: CLAUDE, oldMod: process.env.E2E_STATE_MOD_DIR ?? null, view: { ...view, fields: Object.fromEntries(Object.entries(view.fields).map(([k, v]) => [k, v.length])) },
      wholeContentLength: whole.question?.fields?.content?.length ?? null, expectedLength: expected.length, blind, allowed,
      writtenSame: written === expected, dialogOpened, permissionsLog,
    });

    expect(asked.mod, 'the writer runs the state mod').toBe(true);
    expect(view.tool).toBe('Write');
    expect(view.withheld ?? null, 'the question is not withheld').toBeNull();
    expect(view.cut).toEqual([{ field: 'content', length: expected.length }]);
    expect(view.fields.content).toBe(expected.slice(0, 2000));
    expect(view.fingerprint ?? null, 'a cut view names no fingerprint').toBeNull();
    expect(whole.success).toBe(true);
    expect(whole.question.fields).toEqual({ file_path: target, content: expected });
    // Refused, and said why (#588's audit, L2): an allow that names no fingerprint.
    expect(blind).toMatchObject({ success: false, code: 'read-first' });
    expect(stillHeld.permissionAsk, 'still held after the blind allow').not.toBeNull();
    expect(allowed).toEqual({ success: true });
    expect(written, 'the file holds exactly the content the window showed').toBe(expected);
    expect(dialogOpened, 'the terminal\'s dialog never opened').toBe(false);
    expect(permissionsLog.some(l => l.includes('Write allow by the user'))).toBe(true);
  } finally {
    await app?.close().catch(() => {});
    stub.kill();
  }
});
