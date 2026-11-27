import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

/**
 * A claude agent started on a machine where Claude Code has never trusted anything answers its first task (27/11).
 *
 * Measured on claude 2.1.332: a folder handed with --add-dir that the .claude.json the CLI reads does not trust stops
 * it before its first turn on "Adding a new directory: <folder> ... Is this a directory you created or one you trust?",
 * "No, exit" preselected, and nobody answers in an agent's terminal. Tars trusted the agent's own folder only, while it
 * hands every claude agent ~/.tars, and its secondary folder when it has one. On the owner's machine, whose home Claude
 * Code trusts, nobody ever saw it; the Frontend met it on a fresh sandbox home taking #653's hero shot, every agent
 * stopped there.
 *
 * Here the real chain, with nobody at the terminal: a fresh home where Claude Code is onboarded and trusts nothing,
 * one claude agent in bypass with a secondary folder, started from the window as a user starts it (agent.start: its
 * shell, then its line typed there), the real claude (E2E_CLAUDE, or the one on the PATH) against the stand-in
 * Messages API (e2e/live/fake-messages-api.mjs) through ANTHROPIC_BASE_URL and an API key Claude Code was told to use.
 * No account, no sign-in: CLAUDE_SECURESTORAGE_CONFIG_DIR points the keychain item Claude Code would look for at the
 * sandbox, so the account's own login is never the one it finds.
 *
 * Asserted: Claude Code never shows a trust question; the task reaches the stand-in and its answer is in the agent's
 * terminal; and ~/.claude.json trusts the agent's folder, ~/.tars and the secondary folder, as spelled and where they
 * really are, and nothing wider than them (never the home, never the root).
 *
 * Live: E2E_LIVE=1 and a native claude. The artefact: values.json (the outcome, the folder asked about if any, every
 * request the stand-in got, the folders ~/.claude.json trusts, the terminal's last lines) and the screenshot.
 */

/** What a test started, ended after it even when it ran out of time: a stand-in left on its port answers the next run. */
const started: ChildProcess[] = [];
test.afterEach(() => { for (const child of started.splice(0)) child.kill(); });
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOZc]/g;
const TRUST_QUESTION = /Adding a new directory|Is this a (?:directory|project) you created/;

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

test('a claude agent on a home Claude Code never trusted answers its first task, with nobody at its terminal', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  test.setTimeout(4 * 60_000);

  // /tmp, not os.tmpdir(): no folder above it is one Claude Code trusts, and /tmp is a link (/private/tmp on macOS),
  // so each folder has two spellings, which Claude Code reads by its real path.
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-added-folders-');
  const project = path.join(home, 'projects', 'demo');
  const secondary = path.join(home, 'notes');
  const dataDir = path.join(home, '.tars');
  for (const d of [project, secondary, dataDir, path.join(home, '.claude'), path.join(home, '.tars-private')]) fs.mkdirSync(d, { recursive: true });

  const KEY = `sk-ant-api03-e2e-${randomBytes(24).toString('hex')}-AA`;
  const nonce = randomBytes(4).toString('hex');
  const STUB = 31990 + PORT_OFFSET;
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const version = path.basename(CLAUDE);
  const AGENT = 'eeee5555-0000-4000-8000-0000000000e5';

  // Claude Code's own state, as a new user's after its first run: onboarded, told to use the key, and no folder trusted.
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 1, installMethod: 'native', autoUpdates: false, theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: {},
  }, null, 2));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([{
    id: AGENT, name: 'Solo', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'bypass',
    projectPath: project, secondaryProjectPath: secondary, cliPath: CLAUDE, skills: [], output: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(home, '.tars-private', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: CLAUDE },
  }, null, 2));

  const stub: ChildProcess = spawn(process.execPath, [path.resolve('e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG, FAKE_KEY: KEY }, stdio: 'ignore',
  });
  started.push(stub);
  await expect.poll(() => fs.existsSync(FAKE_LOG) && fs.readFileSync(FAKE_LOG, 'utf8').includes('"listening"'),
    { timeout: 10_000, message: `the stand-in is not listening on ${STUB}: is another process holding the port?` }).toBe(true);
  const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
    .filter((r: { url?: string }) => r.url) as Array<{ url: string; last: string; side: boolean; auth: { bearer: string | null; xApiKey: string | null } }>;
  const trusted = () => {
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    return Object.entries(config.projects ?? {}).filter(([, p]) => p?.hasTrustDialogAccepted === true).map(([k]) => k).sort();
  };

  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { claude: version, home, project, secondary, dataDir };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31515), DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, '.claude-secure-storage'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, null, { timeout: 120_000 });

    // As a user starts it: the window's agent.start, its shell, then its line typed there.
    const start = await page.evaluate(([id, prompt]) => (window as unknown as {
      electronAPI: { agent: { start: (o: { id: string; prompt: string }) => Promise<unknown> } };
    }).electronAPI.agent.start({ id, prompt }), [AGENT, `LINES 1 TRUSTOK${nonce}`]);
    keep({ start });

    const screen = async () => {
      const text = await app!.evaluate((_e, { dist, id }) => {
        const agent = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
        return (agent?.output ?? []).join('') as string;
      }, { dist, id: AGENT });
      return text.replace(ANSI, ' ').replace(/\s+/g, ' ');
    };
    // Bounded, on what the terminal shows: the old build ends on the question, the fixed one on the answer.
    let outcome = 'neither the answer nor a question in 120 s';
    const deadline = Date.now() + 120_000;
    let last = '';
    while (Date.now() < deadline) {
      last = await screen();
      if (last.includes(`TRUSTOK${nonce} line 1 of 1`)) { outcome = 'answered'; break; }
      if (TRUST_QUESTION.test(last)) { outcome = 'trust question'; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    const asked = /Adding a new directory:?\s*(\S+)/.exec(last)?.[1] ?? null;
    keep({
      outcome, folderAsked: asked, requests: requests(), trusted: trusted(), terminalTail: last.slice(-900),
    });
    await stepShot(page, outcome === 'answered' ? 'answered' : 'held');

    expect(TRUST_QUESTION.test(last), `Claude Code stopped on its trust question${asked ? ` for ${asked}` : ''}, and nobody was there to answer`).toBe(false);
    expect(outcome).toBe('answered');
    const task = requests().filter(r => !r.side && r.last === `LINES 1 TRUSTOK${nonce}`);
    expect(task.length, 'the task never reached the stand-in').toBeGreaterThan(0);
    const real = (p: string) => fs.realpathSync.native(p);
    for (const dir of [project, dataDir, secondary]) {
      expect(trusted(), `${dir} is not trusted in ~/.claude.json`).toContain(dir);
      expect(trusted(), `${real(dir)} is not trusted in ~/.claude.json`).toContain(real(dir));
    }
    for (const wide of [home, real(home), '/', '/tmp', '/private/tmp']) expect(trusted()).not.toContain(wide);
  } finally {
    stub.kill();
    await app?.close();
    await new Promise(r => setTimeout(r, 500));
    await removeHome(home);
  }
});
