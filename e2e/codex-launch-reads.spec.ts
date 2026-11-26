import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What Tars reads from codex when it starts a codex agent, read without freezing the window, and said when it means
 * the agent cannot work (2.0.4, the Audit's L6 and L7 on #465).
 *
 * L6: Tars reads the installed codex's flags from its own `--help` before it builds an agent's line (auto becomes
 * `--approve-for-me` where codex has it). It ran codex with execFileSync, on Electron's main thread, waiting up to 10 s
 * under load: the whole window froze that long.
 * L7: Tars hands the codex it starts its own home (`env CODEX_HOME=<Tars's home>`, the Audit's L4). A user whose rc
 * files set CODEX_HOME elsewhere, where their login is, with Tars started from the Dock (no rc file read), gets codex
 * agents that are not signed in: measured on codex-cli 0.163.0, codex then shows its sign-in screen and writes no
 * session, so Tars saw nothing, and the agent read as starting, then running.
 *
 * codex is e2e/fake-codex.mjs: its --help answers after FAKE_CODEX_HELP_MS, and with FAKE_CODEX_SIGN_IN=1 it reads its
 * login from its home's auth.json and shows 0.163's sign-in screen when there is none. Asserted:
 * 1. Cody, an auto agent started from the window while codex takes 8 s to answer --help, leaves the window answering:
 *    its calls to the main process answer within 3 s all along, and Cody then starts with `--approve-for-me`, the
 *    flag codex listed, codex asked once;
 * 2. Sid, a codex agent started from the window, whose codex runs on Tars's home, which has no login, while the rc
 *    files send CODEX_HOME to a folder that has one: his status says it, naming both folders, and his codex shows its
 *    sign-in screen on Tars's home.
 * The artefact: values.json (the delays of the window's calls, the launches, the codex log, Sid's status) and the
 * screenshots.
 */

const CODY = 'cccc6666-0000-4000-8000-0000000000c6';
const SID = 'dddd7777-0000-4000-8000-0000000000d7';
type Listed = { id: string; status: string; error?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Listed[]> } } };

/** A sandbox home with a git project, a fake codex whose wrapper sets `fakeEnv`, and one codex agent seeded. */
function sandbox(prefix: string, agent: Record<string, unknown>, fakeEnv: Record<string, string>) {
  const home = fs.mkdtempSync(`/tmp/dorothy-e2e-${prefix}-`);
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const codexLog = path.join(home, 'codex.jsonl');
  const codex = path.join(bin, 'codex');
  const env = Object.entries({ FAKE_CODEX_LOG: codexLog, ...fakeEnv }).map(([k, v]) => `process.env.${k} = ${JSON.stringify(v)};`).join('\n');
  fs.writeFileSync(codex, `#!${process.execPath}\n${env}\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    character: 'robot', provider: 'codex', status: 'idle', role: 'worker', model: 'gpt-6-luna', projectPath: project, skills: [],
    createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z', ...agent,
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex } }, null, 2));
  const entries = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;
  return { home, project, entries };
}

async function open(home: string, port: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Tars as the Dock starts it: no CODEX_HOME of its own, whatever the runner has.
  const app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', CODEX_HOME: '' } });
  const appLog = test.info().outputPath('app.log');
  app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
  app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
  const page = await app.firstWindow();
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
  return { app, page };
}

const launched = (e: Record<string, unknown>) => !!e.launch && !e.refused && Array.isArray(e.argv);

test(`codex's --help is read off the main thread: the window answers while it runs`, async () => {
  test.setTimeout(3 * 60_000);
  const { home, entries } = sandbox('codex-help-slow', { id: CODY, name: 'Cody', permissionMode: 'auto' }, { FAKE_CODEX_HELP_MS: '8000' });
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let app: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ app, page } = await open(home, apiPort(31335)));

    // 1. Cody started from the window; the window's own calls to the main process timed meanwhile.
    const delays = await page.evaluate(async (id) => {
      const api = (window as unknown as Api).electronAPI;
      void api.agent.start({ id, prompt: 'ECHO started' }).catch(() => {});
      const took: number[] = [];
      const end = Date.now() + 12_000;
      while (Date.now() < end) {
        const asked = performance.now();
        await api.agent.list();
        took.push(Math.round(performance.now() - asked));
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return took;
    }, CODY);
    await expect.poll(() => entries().some(launched), { timeout: 30_000 }).toBe(true);
    const launch = entries().find(launched)!;
    const helps = entries().filter(e => e.help).length;
    keep({ delays, slowest: Math.max(...delays), launch, helps });
    expect.soft(Math.max(...delays), 'the window waited on codex --help').toBeLessThan(3_000);
    expect.soft(launch.argv as string[], "Cody's launch").toContain('--approve-for-me');
    expect.soft(helps, 'codex was asked --help more than once').toBe(1);
    await stepShot(page, 'codex-help-slow-new-interface');
    keep({ entries: entries() });
  } finally {
    await app?.close();
    await removeHome(home);
  }
});

test(`a codex agent not signed in on Tars's home, while the shell's CODEX_HOME is, says so`, async () => {
  test.setTimeout(3 * 60_000);
  const { home, entries } = sandbox('codex-sign-in', { id: SID, name: 'Sid', permissionMode: 'normal' }, { FAKE_CODEX_SIGN_IN: '1' });
  // The user's rc files send CODEX_HOME where their login is; Tars's home (~/.codex) has none.
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'auth.json'), '{"auth_mode":"chatgpt"}', { mode: 0o600 });
  for (const rc of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) fs.writeFileSync(path.join(home, rc), 'export CODEX_HOME="$HOME/elsewhere"\n');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let app: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ app, page } = await open(home, apiPort(31337)));
    const sid = () => page.evaluate(async (id) => (await (window as unknown as Api).electronAPI.agent.list()).find(a => a.id === id), SID);

    // 2. Sid started from the window: his codex asks to sign in, and his status says why.
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: 'ECHO hello' }), SID);
    await expect.poll(() => entries().some(e => e.signInShown), { timeout: 30_000 }).toBe(true);
    let seen: Listed | undefined;
    await expect.poll(async () => { seen = await sid(); return seen?.status; }, { timeout: 30_000 }).toBe('error').catch(() => {});
    const shown = entries().find(e => e.signInShown)!;
    keep({ sid: seen, shown, logins: entries().filter(e => e.login) });
    expect.soft(seen?.status, "Sid's status").toBe('error');
    expect.soft(seen?.error ?? '', 'the folder Tars starts codex on').toContain('~/.codex');
    expect.soft(seen?.error ?? '', 'the folder the shell sets').toContain('~/elsewhere');
    expect.soft(shown.codexHome, "Sid's codex reads another home than Tars's").toBe(path.join(home, '.codex'));
    expect.soft(entries().some(e => e.turn), 'a turn ran with no login').toBe(false);
    await stepShot(page, 'codex-sign-in-new-interface');
    keep({ entries: entries() });
  } finally {
    await app?.close();
    await removeHome(home);
  }
});
