import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort, PORT_OFFSET } from './ports.mjs';

/**
 * A codex worker starts, and takes a task, on a codex config that has never held the Telegram server (2.0.7).
 *
 * Tars hands a codex worker `-c mcp_servers.<name>.enabled=false` for the two servers only an orchestrator gets
 * (services/mcp-roles.ts). codex 0.163 refuses to start on such a switch for a server its config.toml does not hold:
 * "Error: invalid transport in `mcp_servers.claude-mgr-telegram`". Telegram is no longer shipped (2.0.5), so on a
 * CODEX_HOME that never ran 2.0.4, a new user's, no codex worker started at all: its terminal showed the error and
 * the shell prompt (seen in the peer-message E2E of #656). A server is now switched off only where that config holds
 * it.
 *
 * Here a codex worker of Tars, in bypass, on the real codex, in a sandbox whose CODEX_HOME holds a model provider
 * (a local stand-in, e2e/live/fake-openai-api.mjs, no account) and its project's trust, and no Telegram server.
 * Asserted: the worker's codex reaches its prompt; a task typed into it reaches the model; its command line names no
 * server the config lacks; its terminal never says "invalid transport". On the build before the fix it stops at that
 * error.
 *
 * Live: E2E_LIVE=1 and codex on PATH (or E2E_CODEX); macOS and Linux. The artefact: values.json (codex's version, the
 * servers its config holds at the launch, the worker's command line, what reached the model, its terminal's last
 * rows), the stand-in's log and a screenshot.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;
const MODEL = 'stand-in-coder';
const KEY = `sk-e2e-stand-in-${'3'.repeat(24)}`;
const STUB = 31978 + PORT_OFFSET;

function resolveCodex(): string {
  const found = process.env.E2E_CODEX || (() => { try { return execFileSync('which', ['codex']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

test('a codex worker on a codex config without the Telegram server starts and takes a task', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and codex');
  test.skip(process.platform === 'win32', 'macOS and Linux');
  const CODEX = resolveCodex();
  test.skip(!CODEX, 'no codex: set E2E_CODEX or put codex on PATH');
  test.setTimeout(5 * 60_000);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const nonce = randomBytes(3).toString('hex');

  // /tmp, not os.tmpdir(): the CLI's cwd is its physical path.
  const home = fs.mkdtempSync('/tmp/tars-codex-fresh-');
  const project = path.join(home, 'projects', 'worker');
  for (const dir of [path.join(home, '.tars'), path.join(home, '.codex'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.writeFileSync(configFile, [
    `model = "${MODEL}"`, 'model_provider = "stand-in"', 'check_for_update_on_startup = false', '',
    '[model_providers.stand-in]', 'name = "Stand-in"', `base_url = "http://127.0.0.1:${STUB}/v1"`, 'env_key = "TARS_E2E_OPENAI_KEY"', 'wire_api = "responses"', '',
    // No shared daemon: started, it copies about 363 MB of codex into this CODEX_HOME, and it is not what this spec is
    // about; codex reads the config, and refuses the switch, the same in its TUI with or without it.
    '[features]', 'daemon_auto_start = false', '',
    ...[project, fs.realpathSync(project)].flatMap((p) => [`[projects."${p}"]`, 'trust_level = "trusted"', '']),
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify({
    version: 3,
    agents: [{
      id: 'worker', name: 'Worker', character: 'robot', provider: 'codex', status: 'idle', role: 'worker', orchestratorMode: false,
      projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath: CODEX, model: MODEL, lastActivity: new Date().toISOString(),
    }],
  }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', codexEnabled: true, cliPaths: { codex: CODEX, additionalPaths: [path.dirname(CODEX)] },
  }, null, 2));

  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-openai-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG, FAKE_MODEL: MODEL }, stdio: 'ignore',
  });
  type Req = { proto?: string; text?: string; listening?: number };
  const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Req).filter((r) => !r.listening) : []);
  const carrying = (word: string) => requests().filter((r) => (r.text ?? '').includes(word));
  const values: Record<string, unknown> = { codex: CODEX, version: execFileSync(CODEX, ['--version']).toString().trim(), nonce, tmpdir: process.env.TMPDIR ?? null };
  try {
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1', DOROTHY_API_PORT: apiPort(31445), TARS_E2E_OPENAI_KEY: KEY },
    });
    let screen: () => Promise<string[]> = async () => [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      type A = { status: string; cliRunning?: boolean };
      const agentOf = () => page.evaluate(() => (window as unknown as { electronAPI: { agent: { get(id: string): Promise<A> } } }).electronAPI.agent.get('worker'));
      screen = () => app.evaluate((_e, [dist]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get('worker');
        const pty = a?.ptyId ? (req(`${dist}/core/pty-manager.js`).ptyProcesses as Map<string, unknown>).get(a.ptyId) : undefined;
        const { terminalText } = req(`${dist}/core/terminal-mirror.js`) as { terminalText(p: unknown): string[] | undefined };
        return (terminalText(pty) ?? []).filter((l) => l.trim()).slice(-10);
      }, [DIST] as const);
      const type = (text: string) => app.evaluate((_e, [dist, text]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get('worker');
        const { ptyProcesses, writeProgrammaticInput } = req(`${dist}/core/pty-manager.js`) as { ptyProcesses: Map<string, unknown>; writeProgrammaticInput: (p: unknown, t: string, s: boolean) => unknown };
        return a?.ptyId ? writeProgrammaticInput(ptyProcesses.get(a.ptyId), text, true) : null;
      }, [DIST, text] as const);

      values.started = await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(a: unknown): Promise<unknown> } } }).electronAPI.agent.start({ id: 'worker', prompt: '' }));
      // What the config holds as codex starts: Tars may have written servers of its own there; never Telegram.
      values.serversInConfig = [...fs.readFileSync(configFile, 'utf8').matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]/gm)].map((m) => m[2]);
      recordValues(values);
      await expect.poll(async () => (await agentOf()).cliRunning === true, { timeout: 90_000, message: 'the worker\'s codex runs' }).toBe(true);
      await expect.poll(async () => (await screen()).join('\n'), { timeout: 90_000, message: 'the worker\'s codex at its prompt' }).toMatch(/›/);
      // The worker's codex by its own argv: the stand-in's model and bypass (its CODEX_HOME is in its environment, not
      // its argv, so the sandbox's path is not there to find it by).
      const line = execFileSync('ps', ['-axo', 'command=']).toString().split('\n')
        .find((l) => l.includes(`--model ${MODEL}`) && l.includes('--dangerously-bypass-approvals-and-sandbox')) ?? '';
      values.workerCommand = line.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<home>');
      recordValues(values);
      expect(line, 'the worker\'s codex not found among the processes').not.toBe('');
      for (const name of ['claude-mgr-telegram', 'dorothy-x']) {
        if (!(values.serversInConfig as string[]).includes(name)) expect(line, `a switch for ${name}, which the config does not hold`).not.toContain(`mcp_servers.${name}.`);
      }

      const TASK = `TASK-${nonce} say hi`;
      expect(await type(TASK)).not.toBeNull();
      await expect.poll(() => carrying(`TASK-${nonce}`).length, { timeout: 90_000, message: 'the task reached the worker\'s model' }).toBeGreaterThan(0);
      values.carried = carrying(`TASK-${nonce}`).length;
      values.screen = await screen();
      recordValues(values);
      await stepShot(page, 'codex-worker-took-a-task');
      expect((values.screen as string[]).join('\n')).not.toContain('invalid transport');
    } finally {
      values.atEnd = await screen().catch((err) => [String(err)]);
      values.requests = requests().map((r) => r.proto);
      recordValues(values);
      await app.close();
    }
  } finally {
    stub.kill();
    // What codex left running under the sandbox (its daemon, its git fetches), by PID, each command checked.
    const stopped: number[] = [];
    for (const row of execFileSync('ps', ['-axo', 'pid=,command=']).toString().split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!m || !m[2].includes(home)) continue;
      const now = (() => { try { return execFileSync('ps', ['-o', 'command=', '-p', m[1]]).toString(); } catch { return ''; } })();
      if (now.includes(home)) { try { process.kill(Number(m[1])); stopped.push(Number(m[1])); } catch { /* gone */ } }
    }
    values.stoppedLeftovers = stopped;
    recordValues(values);
    await removeHome(home);
  }
});
