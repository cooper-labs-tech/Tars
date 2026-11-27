// Opt-in live E2E with the owner's own Claude in Chrome:
//   E2E_LIVE_CHROME=1 E2E_CHROME_SIGNED_IN_URL=<a page the owner is signed in to> \
//   E2E_CHROME_X_THREAD_URL=<an x.com thread> npx playwright test e2e/chrome-without-asking.live.spec.ts
//
// The owner's report of 10/11 (chrome-and-permissions-general.md): every Claude in Chrome call of an agent in bypass
// was held for Tars's window, which could not allow it, and refused at the delay; "ask in terminal" seemed to do
// nothing. Measured on claude 2.1.321: under the server's flag tengu_cowork_chrome_automode_default, Claude Code takes
// Chrome's calls out of bypass and hands each to the auto mode classifier after tool.check, which the state mod took
// for the dialog. Among them, the Parallel orchestrator's of that night (its answer of 10/11): a browser_batch that
// navigated to a page of a site the owner is signed in to, refused at the 10-minute delay, and the x.com threads and
// searches it reads in Chrome, SocialData having no key. A sandbox Tars runs two workers in bypass, each asked, in one
// turn, to open https://example.com and read it, to make one browser_batch that navigates to the signed-in page
// (E2E_CHROME_SIGNED_IN_URL) and reads it, to read an x.com search and an x.com thread (E2E_CHROME_X_THREAD_URL), and
// to close the tab:
// - "off": the owner's switch chromeActsWithoutAsking off (the default). The mod asks Tars only when Claude Code's
//   dialog would show (classic.PermissionRequest): the classifier decides, nothing asks.
// - "on": the owner's switch turned on from the window (its own channel, chromeWithoutAsking:set, kept in
//   ~/.tars-private), then the agent started: its CLI starts with CLAUDE_CHROME_CLASSIFIER_FLOOR=0, Chrome's calls
//   under bypass, and nothing asks.
// For each: the agent never reads waiting on a permission and Tars holds no question (the window), no
// PermissionRequest hook ran and no permission line was written (the terminal), and every Chrome call came back with
// its result within the turn (the extension: a site prompt would have held it). No page's text is kept: the artefact
// holds the tools, the addresses navigated to, whether each call failed and how many characters a read returned.
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
const SIGNED_IN = process.env.E2E_CHROME_SIGNED_IN_URL ?? '';
const X_THREAD = process.env.E2E_CHROME_X_THREAD_URL ?? '';
const X_SEARCH = 'https://x.com/search?q=claude%20code&f=live';
const PROMPT = 'Use Claude in Chrome now, without asking me anything, in this order. '
  + '1) Call mcp__claude-in-chrome__tabs_context_mcp with createIfEmpty true. '
  + '2) Call mcp__claude-in-chrome__navigate to https://example.com in that tab, then mcp__claude-in-chrome__get_page_text. '
  + `3) Make ONE call of mcp__claude-in-chrome__browser_batch on that tab whose actions are a navigate to ${SIGNED_IN}, `
  + 'a computer wait of 2 seconds and a get_page_text; if the batch says it cannot act after a navigate, call '
  + 'get_page_text on its own after it. '
  + `4) Navigate to ${X_SEARCH}, wait 3 seconds (computer wait) and call get_page_text. `
  + `5) Navigate to ${X_THREAD}, wait 3 seconds and call get_page_text. `
  + 'On x.com, if a read finds no text, wait 3 seconds more and read once again. '
  + '6) Call mcp__claude-in-chrome__tabs_close_mcp on that tab. '
  + 'Do not repeat anything the pages say: reply with CHROME-DONE followed only by the title of the first page.';
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

/**
 * Whether the account's Claude Code trusts a folder, as claude 2.1.322 decides it (read in its code, `$dn`, `Wy`,
 * `jy`): the folder's own `hasTrustDialogAccepted`, else that of a parent, walking up no further than the root of the
 * git repository the folder is in, and with no bound for a folder in none. The agents' CLI reads the account's
 * ~/.claude.json, not the sandbox's where Tars pre-accepts the trust. The spec's first run, the night of 10/11, kept
 * both agents on Claude Code's "Is this a project you created or one you trust?" for their whole leg, the project under
 * the system's temporary folder; its second, the project in the run's folder under the account's trusted home, but made
 * a git repository of its own, which bounds the walk to itself.
 */
function accountTrusts(dir) {
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(ACCOUNT_HOME, '.claude.json'), 'utf8')); } catch { return false; }
  let root = null;
  try { root = fs.realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { root = null; }
  for (let p = fs.realpathSync(dir); ; p = path.dirname(p)) {
    if (config.projects?.[p]?.hasTrustDialogAccepted === true) return true;
    if (p === root || path.dirname(p) === p) return false;
  }
}

/** The sandbox: Tars's home in the system's temporary folder, the agents' project in the run's folder (`projectRoot`). */
function seed(claude, run, projectRoot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-chrome-'));
  // In the run's folder, under the account's home, which the account's Claude Code trusts (see accountTrusts), and no
  // git repository of its own: the agents only use Chrome, and a repository would bound the trust to the folder itself.
  const project = path.join(projectRoot, 'chrome-project');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), path.join(home, 'bin'), project]) fs.mkdirSync(dir, { recursive: true });
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

/** The addresses a Chrome call navigates to: a navigate's url, or each navigate of a browser_batch. */
function navigationsOf(name, input) {
  if (name.endsWith('__navigate')) return typeof input?.url === 'string' ? [input.url] : [];
  if (!name.endsWith('__browser_batch')) return [];
  const actions = Array.isArray(input?.actions) ? input.actions : [];
  return actions.filter(a => a?.name === 'navigate' && typeof a.input?.url === 'string').map(a => a.input.url);
}

/**
 * Chrome's calls and their results in the agent's transcript, which its CLI wrote in the account's own home. No page's
 * text is kept: a read is its length, a navigate's answer (the address it reached) its first 200 characters.
 */
function chromeCalls(project, sessionId) {
  // Claude Code names the folder after the path the CLI runs in, through its link (/var) or not (/private/var).
  const file = [...new Set([fs.realpathSync(project), project])]
    .map(p => path.join(ACCOUNT_HOME, '.claude', 'projects', p.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`))
    .find(f => fs.existsSync(f));
  if (!sessionId || !file) return { file: null, calls: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = new Map();
  for (const line of lines) {
    for (const part of Array.isArray(line.message?.content) ? line.message.content : []) {
      if (part.type === 'tool_use' && String(part.name).startsWith('mcp__claude-in-chrome__')) {
        calls.set(part.id, { tool: part.name, navigates: navigationsOf(part.name, part.input), answered: false });
      }
      if (part.type === 'tool_result' && calls.has(part.tool_use_id)) {
        const text = (Array.isArray(part.content) ? part.content : [part.content]).map(c => (typeof c === 'string' ? c : c?.text ?? '')).join(' ');
        const call = calls.get(part.tool_use_id);
        Object.assign(call, {
          answered: true, error: part.is_error === true, chars: text.length,
          // A refusal is a call that failed saying so (Claude Code's and the extension's words); a page not loaded yet ("No
          // text content found") does not. Never a page's own text: example.com's says "asking for permission", which the
          // spec's third run (07:02Z) took for a refusal of a get_page_text that read it whole.
          refused: part.is_error === true && /permission|denied|refused|not allowed|requires approval/i.test(text),
          ...(call.tool.endsWith('__navigate') ? { said: text.slice(0, 200) } : {}),
        });
      }
    }
  }
  return { file, calls: [...calls.values()] };
}

test('Claude in Chrome acts for an agent in bypass with nothing asking, the owner\'s switch off and on', async () => {
  test.skip(process.env.E2E_LIVE_CHROME !== '1', 'live: E2E_LIVE_CHROME=1, a native claude signed in to claude.ai, the Claude in Chrome extension connected');
  test.skip(!/^https:\/\//.test(SIGNED_IN) || !/^https:\/\/x\.com\//.test(X_THREAD), 'set E2E_CHROME_SIGNED_IN_URL (a page the owner is signed in to) and E2E_CHROME_X_THREAD_URL (an x.com thread)');
  test.setTimeout(20 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  const run = Date.now().toString(36);
  const startedAt = new Date();
  const { home: HOME, project: PROJECT } = seed(CLAUDE, run, OUT);
  fact('seeded', { home: HOME, project: PROJECT, claude: CLAUDE, signedIn: new URL(SIGNED_IN).origin, xThread: X_THREAD, oldMod: process.env.E2E_CHROME_STATE_MOD_DIR ?? null });
  // Said at once rather than after two legs on a dialog nobody answers.
  expect(accountTrusts(PROJECT), `the account's Claude Code trusts ${PROJECT} or a parent of it: trust one in claude, or set E2E_RUN_DIR under a trusted folder`).toBe(true);
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

    /** One leg: the agent started on the prompt, watched every 300 ms until its turn ends. */
    const leg = async (name) => {
      const id = `chrome-${name}-${run}`;
      await page.evaluate(({ agentId, prompt }) => window.electronAPI.agent.start({ id: agentId, prompt }), { agentId: id, prompt: PROMPT });
      const asked = [];
      let last = null;
      let ran = false;
      const end = Date.now() + 8 * 60_000;
      while (Date.now() < end) {
        last = await state(id);
        if (last?.permissionAsk || last?.waitingReason === 'permission') asked.push({ at: new Date().toISOString(), tool: last.permissionAsk?.tool ?? null, subject: last.permissionAsk?.subject ?? null });
        // Held: fail at once, with what was asked, rather than wait out the delay.
        if (asked.length) break;
        if (last?.status === 'running') ran = true;
        if (ran && (last?.status === 'idle' || last?.status === 'completed') && (last.output ?? '').includes('CHROME-DONE')) break;
        await sleep(300);
      }
      const transcript = chromeCalls(PROJECT, last?.sessionId);
      const env = fs.existsSync(path.join(HOME, `cli-env-${name}.txt`)) ? fs.readFileSync(path.join(HOME, `cli-env-${name}.txt`), 'utf8') : '';
      const result = { id, status: last?.status ?? null, mod: last?.mod ?? null, done: (last?.output ?? '').includes('CHROME-DONE'), asked, transcript, env };
      fact(`leg ${name}`, result);
      return result;
    };

    const off = await leg('off');
    const saved = await page.evaluate(() => window.electronAPI.chromeWithoutAsking.set(true));
    fact('switch on', { saved });
    const on = await leg('on');

    const permissionsLog = path.join(HOME, '.tars', 'logs', 'permissions.log');
    const permissionLines = fs.existsSync(permissionsLog) ? fs.readFileSync(permissionsLog, 'utf8').split('\n').filter(Boolean) : [];
    // The CLIs ran Tars's installed shell hooks from the account's ~/.claude, which log to the account's hooks.log.
    const hooksLog = path.join(ACCOUNT_HOME, '.tars', 'logs', 'hooks.log');
    const dialogs = (fs.existsSync(hooksLog) ? fs.readFileSync(hooksLog, 'utf8').split('\n') : [])
      .filter(l => l.includes('PERMISSION_REQUEST') && (l.includes(off.id) || l.includes(on.id)));
    fact('logs', { permissionLines, dialogs });
    recordValues({ claude: CLAUDE, startedAt: startedAt.toISOString(), signedInOrigin: new URL(SIGNED_IN).origin, xThread: X_THREAD, off, saved, on, permissionLines, dialogs });

    const navigated = r => r.transcript.calls.flatMap(c => c.navigates.map(url => ({ url, tool: c.tool, answered: c.answered, error: c.error })));
    for (const [name, r] of [['off', off], ['on', on]]) {
      expect(r.asked, `${name}: Tars held no question and the agent never waited on a permission`).toEqual([]);
      expect(r.mod, `${name}: the agent ran the state mod`).toBe(true);
      expect(r.done, `${name}: the turn ended with CHROME-DONE`).toBe(true);
      expect(r.transcript.calls.filter(c => !c.answered || c.refused), `${name}: every Chrome call came back, none refused`).toEqual([]);
      expect(r.transcript.calls.filter(c => c.error && !c.tool.endsWith('__get_page_text')), `${name}: no call failed but a read of a page still loading`).toEqual([]);
      const went = navigated(r);
      expect(went.some(n => n.url.startsWith('https://example.com')), `${name}: example.com opened`).toBe(true);
      // Parallel's first case: a browser_batch that navigates on a site the owner is signed in to.
      expect(went.some(n => n.tool.endsWith('__browser_batch') && n.url === SIGNED_IN), `${name}: a browser_batch navigated to the signed-in page`).toBe(true);
      // Its second: x.com, a search and a thread, read.
      expect(went.some(n => n.url === X_SEARCH), `${name}: the x.com search opened`).toBe(true);
      expect(went.some(n => n.url === X_THREAD), `${name}: the x.com thread opened`).toBe(true);
      const reads = r.transcript.calls.filter(c => (c.tool.endsWith('__get_page_text') || c.tool.endsWith('__browser_batch')) && !c.error);
      expect(reads.length, `${name}: the pages were read (example.com, the signed-in page, the x.com search and thread)`).toBeGreaterThanOrEqual(4);
      expect(r.transcript.calls.some(c => c.tool.endsWith('__tabs_close_mcp')), `${name}: the tab was closed`).toBe(true);
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
