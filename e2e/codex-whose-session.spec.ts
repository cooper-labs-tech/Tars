import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Whose codex session is whose (2.0.4, the Audit's M1 and L4 on #465).
 *
 * Measured on codex-cli 0.163.0: codex started with no prompt writes no rollout before its first turn, and holds its
 * rollout open from its first line to its end. Until this, the first session begun in a codex agent's folder after
 * its launch was taken for the agent's, the user's own codex included: its turns were posted as the agent's, and its
 * id became the one the agent resumes after a restart or a wake. And the codex in an agent's terminal read the
 * CODEX_HOME its shell's rc files set, where Tars had not trusted the folder: it asked "Trust this folder?" for good.
 *
 * codex is e2e/fake-codex.mjs, which holds its rollout open as 0.163 does. The sandbox's rc files send CODEX_HOME
 * elsewhere, as a user's can. Asserted:
 * 1. Wendy, a codex agent started from the window with no task, runs on the codex home Tars reads and writes,
 *    whatever the rc files say;
 * 2. the user's own codex, run outside Tars in Wendy's folder while she idles, is not hers: its session is neither
 *    her current one nor the one she resumes, and its answer is not posted as hers;
 * 3. a first message her user types into her terminal, which names nobody, is hers, her own codex holding its file:
 *    her turn is seen to end with its answer, and its session is hers.
 * The artefact: values.json (the launches, the sessions, what Wendy read at each step) and the screenshot.
 */

const WENDY = 'eeee5555-0000-4000-8000-0000000000e5';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> } } };

test(`a codex session is its agent's only on evidence, and the agent's codex reads Tars's home`, async () => {
  test.setTimeout(3 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-codex-whose-');
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  // The user's shell sends codex elsewhere: Tars's agents must not follow it there (L4).
  for (const rc of ['.zshrc', '.zprofile', '.bash_profile', '.profile']) fs.writeFileSync(path.join(home, rc), 'export CODEX_HOME="$HOME/.codex-elsewhere"\n');

  const codexLog = path.join(home, 'codex.jsonl');
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(codexLog)};\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });
  const entries = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;

  const wendy = {
    id: WENDY, name: 'Wendy', character: 'robot', provider: 'codex', status: 'idle', role: 'worker', permissionMode: 'auto', model: 'gpt-6-luna',
    projectPath: project, skills: [], createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([wendy], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex } }, null, 2));

  const port = apiPort(31317);
  const dist = path.resolve('electron', 'dist');
  const nonce = randomBytes(4).toString('hex');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  let users: ChildProcess | undefined;
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    const wendyNow = () => app!.evaluate((_e, { dist, id }) => {
      const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
      return { status: a?.status as string, currentSessionId: a?.currentSessionId as string | undefined, resumableSessionId: a?.resumableSessionId as string | undefined, lastCleanOutput: a?.lastCleanOutput as string | undefined };
    }, { dist, id: WENDY });

    // 1. Wendy, started from the window with no task: her codex idles, on Tars's home.
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), WENDY);
    const launched = (e: Record<string, unknown>) => !!e.launch && !e.refused && Array.isArray(e.argv) && !(e.argv as string[]).includes('--help');
    await expect.poll(() => entries().some(launched), { timeout: 30_000 }).toBe(true);
    const launch = entries().find(launched)!;
    keep({ launch, atLaunch: await wendyNow() });
    expect.soft(launch.codexHome, "Wendy's codex reads another home than Tars's").toBe(path.join(home, '.codex'));

    // 2. The user's own codex in her folder, outside Tars, with a turn of its own.
    users = spawn(process.execPath, [codex, '--approve-for-me', `ECHO user${nonce}`], {
      cwd: project, env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: path.join(home, '.codex') }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    await expect.poll(() => entries().some(e => e.pid === users!.pid && e.turn), { timeout: 20_000 }).toBe(true);
    const usersSession = String(entries().find(e => e.pid === users!.pid && e.turn)!.session);
    // The watch reads every second: four of its passes.
    await sleep(4_000);
    const afterUsers = await wendyNow();
    keep({ usersSession, afterUsers });
    expect.soft(afterUsers.currentSessionId, "the user's own session was taken for Wendy's").not.toBe(usersSession);
    expect.soft(afterUsers.resumableSessionId, "Wendy would resume the user's session").not.toBe(usersSession);
    expect.soft(afterUsers.lastCleanOutput ?? '', "the user's answer was posted as Wendy's").not.toContain(`echo user${nonce}`);

    // 3. Her user types into her terminal: a first message that names nobody, in her own codex.
    await app.evaluate((_e, { dist, id, text }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get(id);
      const terminal = req(`${dist}/core/pty-manager.js`).ptyProcesses.get(a.ptyId);
      terminal?.write(text);
      setTimeout(() => terminal?.write('\r'), 300);
    }, { dist, id: WENDY, text: `ECHO own${nonce}` });
    await expect.poll(() => entries().some(e => e.pid === launch.pid && e.turn), { timeout: 20_000 }).toBe(true);
    const ownSession = String(entries().find(e => e.pid === launch.pid && e.turn)!.session);
    let afterOwn: Awaited<ReturnType<typeof wendyNow>> | undefined;
    await expect.poll(async () => { afterOwn = await wendyNow(); return afterOwn.lastCleanOutput ?? ''; }, { timeout: 20_000 })
      .toContain(`echo own${nonce}`).catch(() => {});
    keep({ ownSession, afterOwn });
    expect.soft(afterOwn?.lastCleanOutput ?? '', "Wendy's own turn was never seen to end").toContain(`echo own${nonce}`);
    expect.soft(afterOwn?.currentSessionId, "Wendy's own session is not hers").toBe(ownSession);
    await stepShot(page, 'whose-session-new-interface');
    keep({ entries: entries() });
  } finally {
    users?.kill();
    await app?.close();
    await sleep(500);
    await removeHome(home);
  }
});
