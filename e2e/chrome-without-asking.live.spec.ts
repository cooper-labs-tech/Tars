// Opt-in live E2E with the owner's own Claude in Chrome:
//   E2E_LIVE_CHROME=1 npx playwright test e2e/chrome-without-asking.live.spec.ts
//
// The owner's report of 10/11 (chrome-and-permissions-general.md): every Claude in Chrome call of an agent in bypass
// was held for Tars's window, which could not allow it, and refused at the delay; "ask in terminal" seemed to do
// nothing. Measured on claude 2.1.321: under the server's flag tengu_cowork_chrome_automode_default, Claude Code takes
// Chrome's calls out of bypass and hands each to the auto mode classifier after tool.check, which the state mod took
// for the dialog. A sandbox Tars runs two workers in bypass, each asked to open https://example.com in Chrome, read
// it and close the tab:
// - "off": the owner's setting chromeActsWithoutAsking off (the default). The mod asks Tars only when Claude Code's
//   dialog would show (classic.PermissionRequest): the classifier decides, nothing asks.
// - "on": the owner's switch turned on from the window (its own channel, chromeWithoutAsking:set, kept in ~/.tars-private), then the agent started: its CLI starts with
//   CLAUDE_CHROME_CLASSIFIER_FLOOR=0, Chrome's calls under bypass, and nothing asks.
// For each: the agent never reads waiting on a permission and Tars holds no question (the window), no
// PermissionRequest hook ran and no permission line was written (the terminal), and every Chrome call came back with
// its result within the turn, the tab opened, read and closed (the extension: a site prompt would have held it).
//
// Needs, on the machine that runs it: a native claude (E2E_CLAUDE, or `claude` on PATH), the Claude in Chrome
// extension connected, and the owner signed in to claude.ai in that claude. The keychain that holds the sign-in is
// found through the account's own home, so each agent's CLI starts through a wrapper (its cliPath) that sets HOME back
// to the account's: the CLI reads the owner's ~/.claude and writes its transcript there; Tars, its settings, its
// agents and its logs stay in the sandbox. Negative witness: E2E_CHROME_STATE_MOD_DIR=<a folder holding 2.0.6's
// mods/tars-state> gives the "off" agent that mod, which asked at tool.check: the agent is then held on a permission.
// Its artefact, in the run directory: facts.jsonl, values.json.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31467);
const ACCOUNT_HOME = os.userInfo().homedir;
const PROMPT = 'Use Claude in Chrome now, without asking me anything. 1) Call mcp__claude-in-chrome__tabs_context_mcp with '
  + 'createIfEmpty true. 2) Call mcp__claude-in-chrome__navigate to https://example.com in that tab. 3) Call '
  + 'mcp__claude-in-chrome__get_page_text on it. 4) Call mcp__claude-in-chrome__tabs_close_mcp on that tab. Then reply '
  + 'with CHROME-DONE followed by the page title.';
let FACTS = '';

function resolveClaude() {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

const fact = (step, data) => {
  fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
  console.log(`[fact] ${step} ${JSON.stringify(data).slice(0, 800)}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The CLI an agent starts: claude in the account's own home, saying first what Tars handed it. */
function wrapper(home, leg, claude, stateModDir) {
  const file = path.join(home, 'bin', `claude-${leg}`);
  const said = path.join(home, `cli-env-${leg}.txt`);
  fs.writeFileSync(file, [
    '#!/bin/bash',
    `printf 'CLAUDE_CHROME_CLASSIFIER_FLOOR=%s\\nCLAUDE_CODE_PLUGIN_DIRS=%s\\n' "\${CLAUDE_CHROME_CLASSIFIER_FLOOR-unset}" "\${CLAUDE_CODE_PLUGIN_DIRS-unset}" > '${said}'`,
    `export HOME='${ACCOUNT_HOME}'`,
    ...(stateModDir ? [`export CLAUDE_CODE_PLUGIN_DIRS='${stateModDir}'`] : []),
    `exec '${claude}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

function seed(claude, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-chrome-'));
  const project = path.join(home, 'projects', 'chrome');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const agent = (leg, cliPath) => ({
    id: `chrome-${leg}-${run}`, name: `Chrome ${leg}`, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath, model: 'claude-sonnet-5-5',
    lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([
    agent('off', wrapper(home, 'off', claude, process.env.E2E_CHROME_STATE_MOD_DIR)),
    agent('on', wrapper(home, 'on', claude)),
  ], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return { home, project };
}

/** The tool results of Chrome's calls in the agent's transcript, which its CLI wrote in the account's own home. */
function chromeResults(project, sessionId) {
  // Claude Code names the folder after the path the CLI runs in, through its link (/var) or not (/private/var).
  const file = [...new Set([fs.realpathSync(project), project])]
    .map(p => path.join(ACCOUNT_HOME, '.claude', 'projects', p.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`))
    .find(f => fs.existsSync(f));
  if (!sessionId || !file) return { file: null, uses: [], results: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const uses = new Map();
  const results = [];
  for (const line of lines) {
    for (const part of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (part.type === 'tool_use' && String(part.name).startsWith('mcp__claude-in-chrome__')) uses.set(part.id, part.name);
      if (part.type === 'tool_result' && uses.has(part.tool_use_id)) {
        const text = (Array.isArray(part.content) ? part.content : [part.content]).map(c => (typeof c === 'string' ? c : c?.text ?? '')).join(' ');
        results.push({ tool: uses.get(part.tool_use_id), error: part.is_error === true, text: text.slice(0, 300) });
      }
    }
  }
  return { file, uses: [...uses.values()], results };
}

test('Claude in Chrome acts for an agent in bypass with nothing asking, the owner\'s setting off and on', async () => {
  test.skip(process.env.E2E_LIVE_CHROME !== '1', 'live: E2E_LIVE_CHROME=1, a native claude signed in to claude.ai, the Claude in Chrome extension connected');
  test.setTimeout(12 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  const run = Date.now().toString(36);
  const startedAt = new Date();
  const { home: HOME, project: PROJECT } = seed(CLAUDE, run);
  fact('seeded', { home: HOME, claude: CLAUDE, oldMod: process.env.E2E_CHROME_STATE_MOD_DIR ?? null });
  let app;
  try {
    app = await launchSandboxed(electron, HOME, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/`, DOROTHY_API_PORT: PORT, DOROTHY_E2E: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.electronAPI, null, { timeout: 300_000 });

    const state = id => app.evaluate((_e, { id, dist }) => {
      const req = process.mainModule.require;
      const agent = req(`${dist}/core/agent-manager.js`).agents.get(id);
      const beat = req(`${dist}/services/state-mod.js`).modBeatFor(id);
      return agent && {
        status: agent.status, waitingReason: agent.waitingReason ?? null, permissionAsk: agent.permissionAsk ?? null,
        output: agent.lastCleanOutput ?? null, sessionId: agent.currentSessionId ?? null, mod: !!beat,
      };
    }, { id, dist: DIST });

    /** One leg: the agent started on the prompt, watched every 300 ms until its turn ends with the page's title. */
    const leg = async (name) => {
      const id = `chrome-${name}-${run}`;
      await page.evaluate(({ agentId, prompt }) => window.electronAPI.agent.start({ id: agentId, prompt }), { agentId: id, prompt: PROMPT });
      const asked = [];
      let last = null;
      let ran = false;
      const end = Date.now() + 5 * 60_000;
      while (Date.now() < end) {
        last = await state(id);
        if (last?.permissionAsk || last?.waitingReason === 'permission') asked.push({ at: new Date().toISOString(), ...last });
        // Held: fail at once, with what was asked, rather than wait out the delay.
        if (asked.length) break;
        if (last?.status === 'running') ran = true;
        if (ran && (last?.status === 'idle' || last?.status === 'completed') && (last.output ?? '').includes('CHROME-DONE')) break;
        await sleep(300);
      }
      const transcript = chromeResults(PROJECT, last?.sessionId);
      const env = fs.existsSync(path.join(HOME, `cli-env-${name}.txt`)) ? fs.readFileSync(path.join(HOME, `cli-env-${name}.txt`), 'utf8') : '';
      const result = { id, last, asked, transcript, env };
      fact(`leg ${name}`, result);
      return result;
    };

    const off = await leg('off');
    const saved = await page.evaluate(() => window.electronAPI.chromeWithoutAsking.set(true));
    fact('setting on', { saved });
    const on = await leg('on');

    const permissionsLog = path.join(HOME, '.tars', 'logs', 'permissions.log');
    const permissionLines = fs.existsSync(permissionsLog) ? fs.readFileSync(permissionsLog, 'utf8').split('\n').filter(Boolean) : [];
    // The CLIs ran Tars's installed shell hooks from the account's ~/.claude, which log to the account's hooks.log.
    const hooksLog = path.join(ACCOUNT_HOME, '.tars', 'logs', 'hooks.log');
    const dialogs = (fs.existsSync(hooksLog) ? fs.readFileSync(hooksLog, 'utf8').split('\n') : [])
      .filter(l => l.includes('PERMISSION_REQUEST') && (l.includes(off.id) || l.includes(on.id)));
    fact('logs', { permissionLines, dialogs });
    recordValues({ claude: CLAUDE, startedAt: startedAt.toISOString(), off, saved, on, permissionLines, dialogs });

    for (const [name, r] of [['off', off], ['on', on]]) {
      expect(r.asked, `${name}: Tars held no question and the agent never waited on a permission`).toEqual([]);
      expect(r.last?.mod, `${name}: the agent ran the state mod`).toBe(true);
      expect(r.last?.output ?? '', `${name}: the turn ended with the page's title`).toMatch(/CHROME-DONE[\s\S]*Example Domain/);
      expect(r.transcript.uses, `${name}: Chrome's four calls were made`).toEqual(expect.arrayContaining([
        'mcp__claude-in-chrome__tabs_context_mcp', 'mcp__claude-in-chrome__navigate', 'mcp__claude-in-chrome__get_page_text', 'mcp__claude-in-chrome__tabs_close_mcp',
      ]));
      expect(r.transcript.results.filter(x => x.error), `${name}: no Chrome call was refused or failed`).toEqual([]);
      expect(r.transcript.results.some(x => x.tool.endsWith('__navigate') && x.text.includes('https://example.com')), `${name}: the page opened`).toBe(true);
    }
    expect(off.env).toContain('CLAUDE_CHROME_CLASSIFIER_FLOOR=unset');
    expect(on.env).toContain('CLAUDE_CHROME_CLASSIFIER_FLOOR=0');
    expect(saved).toEqual({ success: true, on: true });
    // The switch lives in the sandbox's ~/.tars-private, never in the app-settings.json every agent is handed.
    expect(JSON.parse(fs.readFileSync(path.join(HOME, '.tars-private', 'owner-switches.json'), 'utf8'))).toMatchObject({ chromeActsWithoutAsking: true });
    expect(JSON.parse(fs.readFileSync(path.join(HOME, '.tars', 'app-settings.json'), 'utf8')).chromeActsWithoutAsking).toBeUndefined();
    expect(permissionLines, 'no permission decision was written').toEqual([]);
    expect(dialogs, 'no PermissionRequest hook ran: Claude Code showed no dialog').toEqual([]);
  } finally {
    await app?.close().catch(() => {});
  }
});
