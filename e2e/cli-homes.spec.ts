import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A user who exports GEMINI_CLI_HOME or GROK_HOME gets a gemini or a grok that reads Tars's MCP servers and hooks in
 * that home, and nothing of Tars's in the plain ~/.gemini or ~/.grok, which that CLI never reads.
 *
 * Measured, isolated, on 24/11: gemini 0.70.0 takes its home from GEMINI_CLI_HOME before HOME, its folder being
 * $GEMINI_CLI_HOME/.gemini; grok 1.0.92 takes GROK_HOME in place of ~/.grok. Before this, Tars wrote both into
 * os.homedir(), and such a user's agents ran without Tars's servers, hooks or trust.
 *
 * The real app on a sandbox HOME, with GEMINI_CLI_HOME and GROK_HOME exported to folders of the sandbox. Tars writes
 * gemini's hooks at its start, and registers its MCP servers as a packaged Tars does (setupMcpOrchestrator, with the
 * bundle under the sandbox's resources), through its own writer: the app's PATH holds only the open shim while it
 * does, so no `<cli> mcp add` can run, neither the binary under test (which honours its home by itself, and would
 * hide the bug) nor one of the machine's. Then gemini and grok themselves, isolated, with the same variables, list
 * what they see.
 *
 * Asserted:
 * 1. `gemini mcp list` shows Tars's orchestrator server, read from $GEMINI_CLI_HOME/.gemini/settings.json, the file
 *    that holds Tars's hooks (SessionStart, BeforeAgent, AfterAgent): gemini 0.70.0 lists no hooks of its own;
 * 2. `grok mcp list` shows it, from $GROK_HOME/config.toml (Tars writes no grok hooks on main: #635 brings them);
 * 3. nothing of Tars's in the sandbox's plain ~/.gemini/settings.json or ~/.grok/config.toml.
 * Red before the fix: Tars wrote both into the plain folders, and each CLI listed none of Tars's servers.
 *
 * Opt-in: TARS_HARNESS_GEMINI and TARS_HARNESS_GROK name the binaries (gemini's own bundle/gemini.js, grok's binary),
 * pinned in folders of their own; skipped and said so without them. Every run of a binary is isolated: the sandbox's
 * HOME, TMPDIR and XDG folders, npm's prefix and cache in sinks, an `open`/`xdg-open` that opens nothing (asserted
 * unused), grok's updater off.
 * The artefact: values.json (each list, the hooks found, the plain folders), the app's log.
 */

const GEMINI = process.env.TARS_HARNESS_GEMINI ?? '';
const GROK = process.env.TARS_HARNESS_GROK ?? '';

test("gemini and grok read Tars's servers and hooks in the homes their variables name, and nothing lands in ~/.gemini or ~/.grok", async () => {
  test.skip(!GEMINI || !fs.existsSync(GEMINI) || !GROK || !fs.existsSync(GROK), 'TARS_HARNESS_GEMINI and TARS_HARNESS_GROK name no binaries: skipped');
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-homes-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const geminiHome = path.join(home, 'gemini-home');
  const grokHome = path.join(home, 'grok-home');
  const shim = path.join(home, 'shim');
  const opened = path.join(home, 'opened.log');
  for (const d of [project, dir, geminiHome, grokHome, shim, path.join(home, 'tmp')]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(shim, name), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '[cli]\nauto_update = false\n');
  const agent = (id: string, provider: string, cliPath: string) => ({
    id, name: `${provider} agent`, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'bypass', cliPath, createdAt: '2026-11-25T08:00:00.000Z', lastActivity: '2026-11-25T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('gem', 'gemini', GEMINI), agent('grk', 'grok', GROK)], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', geminiEnabled: true, grokEnabled: true,
    cliPaths: { gemini: GEMINI, grok: GROK, additionalPaths: [shim, path.dirname(GEMINI), path.dirname(GROK)] },
  }));
  const isolated = {
    PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, TMPDIR: path.join(home, 'tmp'), LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    npm_config_prefix: path.join(home, 'npm-sink'), npm_config_cache: path.join(home, 'npm-cache'),
    GROK_DISABLE_AUTOUPDATER: '1', GEMINI_CLI_HOME: geminiHome, GROK_HOME: grokHome,
  };
  const port = apiPort(31382);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { gemini: GEMINI, grok: GROK };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', ...isolated },
  });
  const appLog = test.info().outputPath('app.log');
  app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
  app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);

    // gemini's hooks, written at Tars's start, into gemini's own folder: waited for, then said softly, so that grok's
    // side is measured too when gemini's is red.
    const geminiSettings = path.join(geminiHome, '.gemini', 'settings.json');
    for (let waited = 0; waited < 30_000 && !fs.existsSync(geminiSettings); waited += 250) await new Promise((r) => setTimeout(r, 250));
    expect.soft(fs.existsSync(geminiSettings), "Tars wrote gemini's hooks in $GEMINI_CLI_HOME/.gemini").toBe(true);

    // Tars's MCP servers registered as a packaged Tars does, through Tars's own writer: only the open shim on the app's
    // PATH while it runs, so every `<cli> mcp add` fails to start and Tars writes the CLI's file itself.
    const resources = path.join(home, 'resources');
    fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
    await app.evaluate(async (_e, { resources, dist, shim }) => {
      const was = process.resourcesPath;
      const pathWas = process.env.PATH;
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      process.env.PATH = shim;
      try {
        await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
      } finally {
        Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
        process.env.PATH = pathWas;
      }
    }, { resources, dist, shim });

    // What gemini and grok themselves see in those homes.
    // Both streams: gemini 0.70.0 prints its list on stderr. And gemini hides every server, its user-level ones too,
    // in a folder it does not trust: its list runs with the workspace trusted, as Tars starts it (--skip-trust sets
    // GEMINI_CLI_TRUST_WORKSPACE), both measured isolated on 25/11. Run from the agent's project folder, as an agent's
    // CLI runs: run from the home folder, gemini read ~/.gemini/settings.json as its workspace's settings and grok
    // ~/.grok/config.toml as its project's, and each listed the plain folder's servers (the first red of 25/11).
    const run = (bin: string, args: string[], extra: Record<string, string> = {}) => {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 90_000, cwd: project, env: { ...isolated, ...extra } });
      return `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
    };
    const geminiList = run(GEMINI, ['mcp', 'list'], { GEMINI_CLI_TRUST_WORKSPACE: 'true' });
    const grokList = run(GROK, ['mcp', 'list']);
    const hooks = fs.existsSync(geminiSettings) ? Object.keys((JSON.parse(fs.readFileSync(geminiSettings, 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {}) : [];
    const plain = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    const plainGemini = plain(path.join(home, '.gemini', 'settings.json'));
    const plainGrok = plain(path.join(home, '.grok', 'config.toml'));
    keep({ geminiList, grokList, geminiHooks: hooks, plainGemini, plainGrok, opened: plain(opened) ?? '' });

    // 1. gemini.
    expect.soft(geminiList, 'gemini lists Tars\'s orchestrator server from $GEMINI_CLI_HOME/.gemini').toContain('claude-mgr-orchestrator');
    expect.soft(hooks, 'the same file holds Tars\'s hooks').toEqual(expect.arrayContaining(['SessionStart', 'BeforeAgent', 'AfterAgent']));
    // 2. grok.
    expect.soft(grokList, 'grok lists Tars\'s orchestrator server from $GROK_HOME').toContain('claude-mgr-orchestrator');
    // 3. Nothing of Tars's in the plain folders.
    expect.soft(plainGemini, 'nothing written to the plain ~/.gemini/settings.json').toBeNull();
    expect.soft(plainGrok, 'nothing written to the plain ~/.grok/config.toml').toBeNull();
    expect.soft(plain(opened) ?? '', 'nothing opened').toBe('');
  } finally {
    await app.close();
    await removeHome(home);
  }
});
