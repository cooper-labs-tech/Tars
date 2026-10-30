import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, splashGone, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent is created, started from a window, started over the API, started
 * from a chat bot, and a terminal is opened, in the real app; the CLI each
 * start runs is a recorder that writes down the argv, the folder and the
 * identity it was handed.
 *
 * On Windows each start has to run the CLI as the terminal's own process: no
 * shell, nothing typed. Without that, the agent's terminal was `/bin/bash -l`,
 * which ConPTY cannot start, so no agent could even be created there; every
 * start typed `cd '<dir>' && <cmd>` into a shell, where PowerShell runs each
 * line of a multi-line prompt as a command (proved); a bot read a bare shell as
 * a running CLI and typed its task in as a message; and the terminal a person
 * opens was `/bin/bash` too.
 *
 * The recorder is this spec's own, as terminal-replay-modes.spec.ts has its
 * own: the fixture's fake CLI is a `#!node` .cjs, which Windows cannot start.
 * Here Windows gets it the way npm installs a CLI there, an npm cmd-shim in
 * front of a node script; darwin and linux get the shebang file.
 *
 * The prompt of the start from a window carries `'; New-Item x` and `& calc`
 * on lines of their own: typed into PowerShell they run as commands. The
 * recorder must receive it byte for byte, and neither may leave a trace.
 */

const onWindows = process.platform === 'win32';
const PROJECT_NAME = "o'neil proj (x86)";
const HOSTILE_PROMPT = "fix the build\n'; New-Item x\n& calc\nsay \"done\" when %PATH% is printed";

type Launch = { argv: string[]; cwd: string; agentId: string | null; token: boolean; apiUrl: string | null; pathKeys: number; pid: number };
type AgentView = { id: string; ptyId?: string; status: string; cliRunning?: boolean; output?: string[] };
type Api = {
  electronAPI: {
    agent: {
      create(config: Record<string, unknown>): Promise<AgentView>;
      start(params: { id: string; prompt: string }): Promise<{ success: boolean; error?: string }>;
      get(id: string): Promise<AgentView | null>;
    };
  };
};

/**
 * The recorder: one JSON line per start, then a screen and a terminal it
 * holds, like a CLI at its prompt, so the agent reads as running.
 */
function recorderScript(log: string): string {
  return [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
    '  argv: process.argv.slice(2), cwd: process.cwd(),',
    '  agentId: process.env.CLAUDE_AGENT_ID || null, token: !!process.env.CLAUDE_MGR_API_TOKEN,',
    '  apiUrl: process.env.CLAUDE_MGR_API_URL || null, pid: process.pid,',
    "  pathKeys: Object.keys(process.env).filter(k => k.toUpperCase() === 'PATH').length,",
    "}) + '\\n');",
    "if (process.env.CLAUDE_MGR_API_TOKEN) fs.writeFileSync(" + JSON.stringify(`${log}.token`) + ", process.env.CLAUDE_MGR_API_TOKEN);",
    "process.stdout.write('\\x1b[2J\\x1b[Hthe recorder of the launch spec\\r\\n> ');",
    'process.stdin.resume();',
    '',
  ].join('\n');
}

/** The recorder as the CLI path an agent is given, installed the way each platform runs one. */
function installRecorder(home: string, log: string): string {
  const npmDir = path.join(home, 'npm dir');
  const pkg = path.join(npmDir, 'node_modules', 'fake-claude');
  fs.mkdirSync(pkg, { recursive: true });
  if (!onWindows) {
    const file = path.join(npmDir, 'fake-claude.cjs');
    fs.writeFileSync(file, `#!${process.execPath}\n${recorderScript(log)}`, { mode: 0o755 });
    return file;
  }
  fs.writeFileSync(path.join(pkg, 'cli.js'), recorderScript(log));
  // npm's cmd-shim, as npm 10 writes it (cli-binary.ts reads it through to node and the script).
  const shim = path.join(npmDir, 'fake-claude.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*', '',
  ].join('\r\n'));
  return shim;
}

function launches(log: string): Launch[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Launch);
}

async function launchOf(log: string, agentId: string, count = 1): Promise<Launch> {
  await expect.poll(() => launches(log).filter(l => l.agentId === agentId).length, {
    timeout: 30_000, message: `the recorder never started for ${agentId}`,
  }).toBeGreaterThanOrEqual(count);
  return launches(log).filter(l => l.agentId === agentId)[count - 1];
}

/** Calculators running now, by pid: `& calc` typed into PowerShell starts one. */
function calculators(): string[] {
  if (!onWindows) return [];
  const out = execFileSync('C:\\Windows\\System32\\tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return out.split('\n').filter(line => /^"(calc|CalculatorApp|win32calc)\.exe"/i.test(line)).map(line => line.split('","')[1]);
}

/** The processes whose command line names the sandbox: what the app left behind. */
function leftBehind(home: string): string[] {
  if (!onWindows) return [];
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${home.replace(/'/g, "''")}') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const out = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function call<T>(page: Page, fn: (api: Api['electronAPI'], arg: unknown) => Promise<T>, arg?: unknown): Promise<T> {
  return page.evaluate(([source, value]) => {
    const f = new Function('api', 'arg', `return (${source})(api, arg);`);
    return f((window as unknown as Api).electronAPI, value);
  }, [fn.toString(), arg] as const) as Promise<T>;
}

/**
 * How long a PowerShell whose terminal is alive may take to reach its prompt.
 * Not a speed expectation: the wait below ends at once when the terminal is
 * gone, which is the defect it is there for (a shell ConPTY cannot start).
 * Windows PowerShell's start is CPU bound. Measured on 2026-09-26 through
 * node-pty with a fresh sandbox profile, as the fixture gives: 0.4 s idle on
 * an 8-thread machine, 9.5 s beside 32 busy threads, 11 to 17 s beside 64.
 * A run on CI's windows-latest saw no prompt in the 30 s this used to
 * allow, and its rerun of the same commit passed the whole test in 16.7 s;
 * what that run printed could not say whether its terminal was alive (below).
 */
const PROMPT_WAIT_MS = 90_000;

/** One look at a terminal: what it shows, whether it has ended, and what else says so. */
type TerminalLook = { screen: string; gone: boolean; state: Record<string, unknown> };

/**
 * Waits until `prompt` is on a terminal's screen and returns how long it took.
 * Fails at once when the terminal has gone, and after PROMPT_WAIT_MS when it is
 * alive and silent, both times with what the terminal held, raw: the report
 * stripped the escapes of an empty screen down to "", which said neither
 * whether the shell had died nor what it printed.
 */
async function promptOn(what: string, prompt: RegExp, look: () => Promise<TerminalLook>): Promise<number> {
  const since = Date.now();
  for (;;) {
    const { screen, gone, state } = await look();
    if (prompt.test(screen)) return Date.now() - since;
    if (gone || Date.now() - since > PROMPT_WAIT_MS) {
      const seen = JSON.stringify({ afterMs: Date.now() - since, ...state, screen });
      throw new Error(`${gone ? `${what} ended before its prompt` : `${what} never showed its prompt`}: ${seen}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** PowerShell's prompt in an agent's terminal, read from agent:get. */
async function powerShellPrompt(page: Page, id: string): Promise<number> {
  return promptOn('the agent terminal', /PS [A-Z]:\\/, async () => {
    const view = await call(page, (api, agentId) => api.agent.get(agentId as string), id);
    return {
      screen: (view?.output ?? []).join(''),
      gone: !view?.ptyId || view.status !== 'idle',
      state: { status: view?.status ?? null, ptyId: view?.ptyId ?? null },
    };
  });
}

/**
 * Counts the quick terminals that end from now on. A quick terminal has no id
 * the page shows, and one whose shell exits takes its dialog with it (the
 * projects page listens to pty:exit), so the exit itself is what says it is
 * gone. No other pty:create terminal runs in this test.
 */
async function watchQuickTerminalExits(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __qaPtyExits: unknown[]; electronAPI: { pty: { onExit(cb: (e: unknown) => void): () => void } } };
    w.__qaPtyExits = [];
    w.electronAPI.pty.onExit(event => { w.__qaPtyExits.push(event); });
  });
}

/** The prompt of the quick terminal on screen, read from its xterm rows. */
async function quickTerminalPrompt(page: Page, prompt: RegExp): Promise<number> {
  return promptOn('the project terminal', prompt, async () => {
    const { rows, exits } = await page.evaluate(() => {
      const all = document.querySelectorAll('.xterm .xterm-rows');
      const last = all[all.length - 1] as HTMLElement | undefined;
      return { rows: last ? last.innerText : null, exits: (window as unknown as { __qaPtyExits: unknown[] }).__qaPtyExits };
    });
    return { screen: rows ?? '', gone: exits.length > 0, state: { onScreen: rows !== null, exits } };
  });
}

test('an agent is created, started from a window, over the API and from a bot, running its CLI with the exact argv and never through a shell', async () => {
  test.setTimeout(360_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-launch-'));
  const dataDir = path.join(home, '.tars');
  const project = path.join(home, 'projects', PROJECT_NAME);
  const log = path.join(home, 'launches.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const cli = installRecorder(home, log);
  const port = apiPort(31460);
  fs.writeFileSync(path.join(dataDir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dataDir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dataDir, 'app-settings.json'), JSON.stringify({
    ollamaBaseUrl: 'http://127.0.0.1:9',
    autoStartAgentsOnLaunch: false,
    // The CLI the bots start: they read the settings, not the agent's own path.
    cliPaths: {
      amp: '', claude: cli, codex: '', gemini: '', grok: '', qwencode: '', opencode: '', pi: '',
      gws: '', gcloud: '', gh: '', node: '', minimax: '', additionalPaths: [],
    },
  }, null, 2));
  const calculatorsBefore = calculators();

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const errors: string[] = [];
  const values: Record<string, unknown> = { platform: process.platform, project, cli };
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState('domcontentloaded');
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    // Hydrated first: until React holds the page, what follows acts on the
    // server's HTML, and on a slow runner its bounds ran out there (run
    // 36461229599, attempt 2). splashGone waits for that as long as the spec
    // allows, then holds the splash to its own cap.
    await splashGone(page);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Api).electronAPI?.agent), { timeout: 60_000 }).toBe(true);

    // ── Created: its terminal is a shell waiting, not a CLI ─────────
    const create = (name: string) => call(page, (api, arg) => api.agent.create(arg as Record<string, unknown>), {
      projectPath: project, skills: [], name, cliPath: cli, permissionMode: 'normal',
    });
    const worker = await create('Launch Worker');
    const apiStarted = await create('Api Started');
    const botStarted = await create('Bot Started');
    expect(worker.ptyId, 'agent:create opened no terminal').toBeTruthy();
    const idle = await call(page, (api, id) => api.agent.get(id as string), worker.id);
    expect(idle).toMatchObject({ status: 'idle', cliRunning: false });
    // The terminal an agent waits in is PowerShell's, at its prompt.
    const promptMs = onWindows ? await powerShellPrompt(page, worker.id) : undefined;
    values.created = { id: worker.id, status: idle?.status, cliRunning: idle?.cliRunning, promptMs };
    await stepShot(page, '01-created');

    // ── Started from a window, with a prompt hostile to a shell ────
    const started = await call(page, (api, arg) => api.agent.start(arg as { id: string; prompt: string }), { id: worker.id, prompt: HOSTILE_PROMPT });
    expect(started, JSON.stringify(started)).toMatchObject({ success: true });
    const fromWindow = await launchOf(log, worker.id);
    const mcpConfig = path.join(home, '.claude', 'mcp.json');
    const expectedArgv = [
      ...(fs.existsSync(mcpConfig) ? ['--mcp-config', mcpConfig] : []),
      '--permission-mode', 'default', '--add-dir', dataDir, '--', HOSTILE_PROMPT,
    ];
    expect(fromWindow.argv, 'the argv the CLI received').toEqual(expectedArgv);
    expect(fromWindow.argv.at(-1), 'the prompt, byte for byte').toBe(HOSTILE_PROMPT);
    // The same folder, read through its links: macOS hands the CLI the
    // physical /private/var/... of os.tmpdir()'s /var/...
    expect(fs.realpathSync(fromWindow.cwd)).toBe(fs.realpathSync(project));
    expect(fromWindow.token, 'the CLI was started without a token of its own').toBe(true);
    expect(fromWindow.apiUrl).toBe(`http://127.0.0.1:${port}`);
    expect(fromWindow.pathKeys, 'PATH twice in the CLI\'s env (Path and PATH)').toBe(1);
    await expect.poll(async () => (await call(page, (api, id) => api.agent.get(id as string), worker.id))?.cliRunning, { timeout: 15_000 }).toBe(true);
    values.fromWindow = { argv: fromWindow.argv, cwd: fromWindow.cwd, agentId: fromWindow.agentId, token: fromWindow.token, pathKeys: fromWindow.pathKeys };

    await stepShot(page, '02-started-from-window');

    // ── Started over the API (spawnAgentSession), by the project's orchestrator's own token ─
    // Since 2.0.4 (#449, #480) a worker starts no other agent: only Tars, the window and the project's
    // orchestrator do. Its CLI, started from the window, is handed its terminal's token, which the
    // stand-in writes down as it starts.
    const lead = await call(page, (api, arg) => api.agent.create(arg as Record<string, unknown>), {
      projectPath: project, skills: [], name: 'Launch Lead', cliPath: cli, permissionMode: 'normal', role: 'orchestrator',
    });
    const leadStarted = await call(page, (api, arg) => api.agent.start(arg as { id: string; prompt: string }), { id: lead.id, prompt: 'lead' });
    expect(leadStarted, JSON.stringify(leadStarted)).toMatchObject({ success: true });
    await launchOf(log, lead.id);
    const token = fs.readFileSync(`${log}.token`, 'utf8');
    const response = await fetch(`http://127.0.0.1:${port}/api/agents/${apiStarted.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'from the api\nsecond line' }),
    });
    const answer = await response.json();
    expect(response.status, JSON.stringify(answer)).toBe(200);
    const overApi = await launchOf(log, apiStarted.id);
    // Since #569 the message goes under its sender's line, after Tars's header (launchPrompt).
    expect(overApi.argv.at(-1)).toMatch(new RegExp(`^\\[Tars: you are agent "Api Started" .*\\]\\n\\nMessage from agent "Launch Lead" \\("${lead.id}"\\): \\nfrom the api\\nsecond line$`, 's'));
    expect(overApi.argv.slice(0, -1)).toEqual(expectedArgv.slice(0, -1));
    expect(fs.realpathSync(overApi.cwd)).toBe(fs.realpathSync(project));
    expect(overApi.token).toBe(true);
    expect(overApi.pathKeys).toBe(1);
    values.overApi = { argv: overApi.argv, cwd: overApi.cwd, agentId: overApi.agentId, status: response.status };

    // ── Started from a bot (bot-core), an idle agent with its shell open ───
    const botBefore = await call(page, (api, id) => api.agent.get(id as string), botStarted.id);
    expect(botBefore?.cliRunning, 'a bare shell read as a running CLI').toBe(false);
    const dist = path.resolve('electron', 'dist');
    const reply = await app.evaluate(async (_electron, { dist, id }) => {
      const req = process.mainModule!.require;
      const manager = req(`${dist}/core/agent-manager.js`);
      const { ptyProcesses } = req(`${dist}/core/pty-manager.js`);
      const { startWithTask } = req(`${dist}/services/bot-core.js`);
      const settings = JSON.parse(req('fs').readFileSync(req('path').join(req('os').homedir(), '.tars', 'app-settings.json'), 'utf8'));
      const fleet = {
        agents: manager.agents, ptyProcesses, settings: () => settings, saveAgents: manager.saveAgents,
        initAgentPty: (agent: unknown) => manager.initAgentPty(agent, null, () => {}, manager.saveAgents),
      };
      const replies: string[] = [];
      await startWithTask(fleet, manager.agents.get(id), 'from a chat', 'Telegram', { resume: false, reply: (o: string) => { replies.push(o); } });
      return replies;
    }, { dist, id: botStarted.id });
    expect(reply).toEqual(['started']);
    const fromBot = await launchOf(log, botStarted.id);
    expect(fromBot.argv).toEqual([...expectedArgv.slice(0, -1), 'Message from Telegram: \nfrom a chat']);
    expect(fs.realpathSync(fromBot.cwd)).toBe(fs.realpathSync(project));
    await expect.poll(async () => (await call(page, (api, id) => api.agent.get(id as string), botStarted.id))?.cliRunning, { timeout: 15_000 }).toBe(true);
    values.fromBot = { reply, argv: fromBot.argv, cwd: fromBot.cwd, agentId: fromBot.agentId };

    // ── The terminal a person opens: Projects > Terminal ──────────────────
    await page.goto(`${DEV_URL}/projects`, { waitUntil: 'domcontentloaded' });
    // Hydrated first: until React holds the page, what follows acts on the
    // server's HTML, and on a slow runner its bounds ran out there (run
    // 36461229599, attempt 2). splashGone waits for that as long as the spec
    // allows, then holds the splash to its own cap.
    await splashGone(page);
    const row = page.locator('div').filter({ hasText: PROJECT_NAME }).filter({ has: page.getByRole('button', { name: 'open', exact: true }) }).last();
    await row.getByRole('button', { name: 'open', exact: true }).click();
    await watchQuickTerminalExits(page);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const terminal = page.locator('.xterm .xterm-rows').last();
    const quickPromptMs = await quickTerminalPrompt(page, onWindows ? /PS [A-Z]:\\.*>/ : /\S/);
    values.quickTerminal = (await terminal.innerText()).trim().split('\n').filter(Boolean).slice(-1)[0];
    values.quickPromptMs = quickPromptMs;
    await stepShot(page, '03-project-terminal');

    expect(errors, 'the page reported errors').toEqual([]);
  } finally {
    recordValues(values);
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Nothing of the prompt ran as a command: no `x` anywhere it could land,
    // no calculator. Read here, whatever failed above, so a start that typed
    // the prompt into a shell and never reached the recorder is still judged
    // on what that shell did.
    const strays = [project, home, dataDir].map(dir => path.join(dir, 'x')).filter(file => fs.existsSync(file));
    const newCalculators = calculators().filter(pid => !calculatorsBefore.includes(pid));
    const orphans = leftBehind(home);
    recordValues({ security: { strays, newCalculators }, leftBehind: orphans });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    expect.soft(strays, 'a line of the prompt ran as a command (New-Item x)').toEqual([]);
    expect.soft(newCalculators, 'a line of the prompt ran as a command (& calc)').toEqual([]);
    expect(orphans, 'processes of the sandbox outlived the app').toEqual([]);
  }
});
