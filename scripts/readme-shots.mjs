#!/usr/bin/env node
/**
 * The screenshots the README carries.
 *
 * These are NOT the e2e baselines. Those mask the terminal bodies, because the
 * dashboard photographs real PTY output carrying a random temp directory and a
 * clock, so the baseline could never match twice. A masked terminal is right for
 * a regression test and useless in a README, where the whole point of the first
 * image is that those panes are live terminals.
 *
 * So: the same sandboxed app, the same seeded fixture, no mask.
 *
 *   npx next dev -p 3100        (or let the e2e webServer be running)
 *   node scripts/readme-shots.mjs                     # writes screenshots/
 *   README_SHOTS_DIR=/some/folder node scripts/readme-shots.mjs
 *   README_SHOTS_DASHBOARD=1 node scripts/readme-shots.mjs   # the Dashboard too
 *
 * The Dashboard is left out unless asked: the README's dashboard.png is a
 * capture of real agents at work (#301), and the stand-ins' empty terminals
 * here would cover it (the Audit's batch 1).
 *
 * Everything runs in a sandbox, through launchSandboxed (e2e/fixture.mjs): a
 * temp HOME, and Electron's profile moved with --user-data-dir and
 * CFFIXED_USER_HOME, then checked. HOME alone moved ~/.dorothy and ~/.claude
 * and nothing else: until 1.9.1 this script opened the installed Tars's own
 * profile (QA's note on #214).
 *
 * What a public picture must not carry, and the e2e's seed has (2026-10-04):
 * - What's New's dot and count: the sandbox has never seen the changelog, so
 *   it is marked seen, at the newest entry src/data/changelog.ts has;
 * - Next's dev indicator, in the bottom left corner of every page `next dev`
 *   serves: hidden by e2e/screenshot.css, as the e2e does;
 * - agents that all read idle: the seed's fake CLI posts no status, so every
 *   agent the seed declares running, waiting or in error read idle once
 *   started. Here each agent runs a stand-in that reports the status the seed
 *   declares for it, through the same hook route and with the same token as
 *   the hooks Tars installs in a real CLI. The e2e's fake CLI is left alone;
 * - tasks that cost nothing: the seed has no transcript, so a Claude task read
 *   not counted, as only a CLI that writes none should (the Audit's L2 of
 *   #330). A Claude agent at work writes one, as Claude Code does, where Tars
 *   reads it: the usage of each of its replies, which prices its task. The
 *   page's totals add it up at the scan after the one at launch, which is
 *   kept a minute (transcript-usage.ts): the shot waits for it, and fails
 *   rather than show tasks that cost something under a total of $0.00;
 * - a task list cut at the bottom of the window: the Usage page runs past one
 *   screen, so the window grows to its height, sidebar included, for that
 *   shot (the Audit's L1 of #330);
 * - a project of JeanBrasse's: the seed's second project is named after a real one,
 *   so here it is renamed to an invented one before anything reads it, and
 *   French quotes in a seeded task read as English ones (JeanBrasse's go of 07/10).
 *   A shot whose page still shows the old name or a guillemet fails the run,
 *   and no picture is written: they are taken into a folder of their own and
 *   copied into the output only once every page has passed (the Audit's L1
 *   of #344);
 * - Hermes not answering: the seed points every suite at a dead port, so the
 *   Chat led with its error and the Kanban page was that error whole. A
 *   stand-in Hermes of the script's own, on a free port of 127.0.0.1, answers
 *   what those pages ask: its status, signed in, and a board. Anything else it
 *   is asked is a 404, printed. No real Hermes is ever reached.
 */
import { _electron as electron } from '@playwright/test';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { launchSandboxed, seedSandbox } from '../e2e/fixture.mjs';

const DEV_URL = process.env.DOROTHY_DEV_URL || 'http://localhost:3100';
/** The seed's second project, as a public picture names it: invented. */
const SECOND_NAME = 'harbor-billing';
const API_PORT = '31495';
const OUT = process.env.README_SHOTS_DIR || 'screenshots';

/** Only the ones the README actually embeds, in the order it embeds them. */
const SHOTS = [
  ...(process.env.README_SHOTS_DASHBOARD === '1' ? [{ file: 'dashboard.png', route: '/' }] : []),
  { file: 'chat.png', route: '/chat' },
  { file: 'agents.png', route: '/agents' },
  { file: 'kanban.png', route: '/kanban' },
  { file: 'usage.png', route: '/usage', whole: true, ready: totalsCounted },
  { file: 'vault.png', route: '/vault' },
  { file: 'review.png', route: '/review' },
  { file: 'brain.png', route: '/memory' },
  { file: 'extensions.png', route: '/skills' },
  { file: 'providers.png', route: '/settings?section=ai-providers' },
];

/** The Usage page's total cost, once the transcripts the stand-ins wrote are in it. */
async function totalsCounted(page) {
  await page.waitForFunction(() => {
    const caption = [...document.querySelectorAll('body *')].find(el => el.children.length === 0 && el.textContent?.trim() === 'TOTAL COST');
    let box = caption?.parentElement;
    while (box && !box.querySelector('.font-serif')) box = box.parentElement;
    const value = box?.querySelector('.font-serif')?.textContent?.trim();
    return !!value && value !== '$0.00';
  }, null, { timeout: 150_000, polling: 1000 });
}

/** The window grown to the page's height, so a page that runs past one screen shows whole. */
async function showWhole(page) {
  for (let i = 0; i < 3; i++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height <= (page.viewportSize()?.height ?? 900)) return;
    await page.setViewportSize({ width: 1440, height });
    await page.waitForTimeout(500);
  }
}

/** What's New's newest entry, as the page compares it with what was last seen. */
function newestChangelogId() {
  const source = readFileSync('src/data/changelog.ts', 'utf8');
  const key = /WHATS_NEW_STORAGE_KEY = '([^']+)'/.exec(source)?.[1];
  const id = /\bid:\s*(\d+)/.exec(source)?.[1];
  if (!key || !id) throw new Error('src/data/changelog.ts no longer says its storage key or its newest id');
  return { key, id };
}

/**
 * A CLI for each seeded agent that reports the status the seed declares for
 * it, as the installed hooks report a real one's: it registers its session
 * (SessionStart's post, with `source`), then says it is running its task,
 * waiting on a permission dialog, or failed with its message. An idle agent
 * says nothing more. The token and the address are the ones Tars hands every
 * terminal it starts (CLAUDE_MGR_API_TOKEN, CLAUDE_MGR_API_URL).
 */
function writeStandIn(home) {
  const agentsFile = join(home, '.dorothy', 'agents.json');
  const agents = JSON.parse(readFileSync(agentsFile, 'utf8'));
  // What a Claude agent at work has used so far, reply by reply, as Claude
  // Code's transcript says it: input, cache write, cache read and output tokens.
  const replies = a => a.provider !== 'claude' || (a.status !== 'running' && a.status !== 'waiting') ? []
    : a.role === 'orchestrator'
      ? [[9, 21400, 0, 412], [4, 1850, 21400, 268], [4, 640, 23250, 931]]
      : [[12, 14200, 0, 655], [6, 2300, 14200, 1240], [6, 880, 16500, 402], [5, 410, 17380, 1876]];
  const declared = Object.fromEntries(agents.map(a => [a.id, { status: a.status, task: a.currentTask ?? '', model: a.model ?? '', replies: replies(a) }]));
  const dir = join(home, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'readme-cli.cjs');
  writeFileSync(file, [
    `#!${process.execPath}`,
    "const { randomUUID } = require('crypto');",
    "const fs = require('fs'), path = require('path'), os = require('os');",
    `const declared = ${JSON.stringify(declared)}[process.env.CLAUDE_AGENT_ID] || { status: 'idle', task: '', model: '', replies: [] };`,
    "process.stdout.write('\\x1b[2J\\x1b[HA CLI of the README sandbox: no model, no network\\r\\n> ');",
    'process.stdin.resume();',
    'const session = randomUUID();',
    `const api = process.env.CLAUDE_MGR_API_URL || 'http://127.0.0.1:${API_PORT}';`,
    'const post = body => fetch(`${api}/api/hooks/status`, {',
    "  method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLAUDE_MGR_API_TOKEN}` },",
    '  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }),',
    '}).catch(() => undefined);',
    "// The transcript Claude Code writes under its folder's name, the prompt and",
    "// then each reply with its usage, after the task's start, so the task owns it.",
    'const transcript = () => {',
    "  const dir = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));",
    '  fs.mkdirSync(dir, { recursive: true });',
    '  const at = () => new Date().toISOString();',
    "  const lines = [{ type: 'user', sessionId: session, timestamp: at(), message: { role: 'user', content: declared.task } }];",
    '  declared.replies.forEach(([input, write, read, output], i) => lines.push({',
    "    type: 'assistant', sessionId: session, timestamp: at(), requestId: `req_${session.slice(0, 8)}_${i}`,",
    "    message: { id: `msg_${session.slice(0, 8)}_${i}`, role: 'assistant', model: declared.model, content: [{ type: 'text', text: 'Working on it.' }],",
    '      usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output } },',
    '  }));',
    "  fs.writeFileSync(path.join(dir, `${session}.jsonl`), lines.map(l => JSON.stringify(l)).join('\\n') + '\\n');",
    '};',
    '(async () => {',
    "  await post({ status: 'idle', source: 'startup' });",
    "  if (declared.status === 'running' || declared.status === 'waiting') {",
    "    await post({ status: 'running', event: 'UserPromptSubmit', current_task: declared.task });",
    '    if (declared.replies.length) transcript();',
    '  }',
    "  // The task first, as a turn that reached a permission dialog had it.",
    "  if (declared.status === 'waiting') await post({ status: 'waiting', waiting_reason: 'permission', opened_at: Date.now(), tool_name: 'Edit', tool_input: { file_path: declared.task } });",
    "  if (declared.status === 'error') await post({ status: 'error', error_kind: 'server_error', error_message: declared.task });",
    '})();',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(agentsFile, JSON.stringify(agents.map(a => ({ ...a, cliPath: file })), null, 2));
  // Autostart starts the agents that were at work; one the seed declares in
  // error is started here, so its stand-in can say why.
  return agents.filter(a => a.status === 'error').map(a => a.id);
}

/**
 * The seed made fit for a public picture: its second project renamed, folder
 * included, and the guillemets of its tasks turned into English quotes.
 * Returns the old name, which no picture may show.
 */
function publicSeed(home) {
  const dir = join(home, '.dorothy');
  const projectsFile = join(dir, 'projects.json');
  const projects = JSON.parse(readFileSync(projectsFile, 'utf8'));
  if (projects.length !== 2) throw new Error(`the seed has ${projects.length} projects, not 2: say which one to rename`);
  const from = projects[1];
  const to = join(dirname(from), SECOND_NAME);
  renameSync(from, to);
  writeFileSync(projectsFile, JSON.stringify(projects.map(p => (p === from ? to : p)), null, 2));
  const agentsFile = join(dir, 'agents.json');
  const agents = JSON.parse(readFileSync(agentsFile, 'utf8')).map(a => ({
    ...a,
    ...(a.projectPath === from ? { projectPath: to } : {}),
    ...(typeof a.currentTask === 'string' ? { currentTask: a.currentTask.replace(/\u00ab\s*/g, '"').replace(/\s*\u00bb/g, '"') } : {}),
  }));
  writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
  return basename(from);
}

/** The stand-in Hermes's board: a few tasks in Hermes's own columns, held by the seed's agents. */
const BOARD = {
  columns: [
    { name: 'triage', tasks: [{ id: 'readme-1', title: 'Flaky e2e on the Usage page', status: 'triage' }] },
    { name: 'todo', tasks: [{ id: 'readme-2', title: 'Retry the invoice webhook on a 502', status: 'todo', assignee: 'Backend Engineer' }] },
    { name: 'scheduled', tasks: [] },
    { name: 'ready', tasks: [{ id: 'readme-3', title: 'Check the scroll lock fix on a long session', status: 'ready', assignee: 'QA' }] },
    { name: 'running', tasks: [
      { id: 'readme-4', title: 'Fix the scroll lock in TerminalGrid', status: 'running', assignee: 'Frontend Engineer' },
      { id: 'readme-5', title: 'npm run build on the release branch', status: 'running', assignee: 'Backend Engineer' },
    ] },
    { name: 'blocked', tasks: [{ id: 'readme-6', title: 'Migrate the invoices table', status: 'blocked', assignee: 'Database migration and schema review' }] },
    { name: 'review', tasks: [] },
    { name: 'done', tasks: [{ id: 'readme-7', title: 'Bump Electron to 44.4.4', status: 'done', assignee: 'Backend Engineer' }] },
  ],
};

/**
 * A Hermes of the script's own, on a free port of 127.0.0.1: what the Chat and
 * the Kanban page ask, it answers (its status, no sign-in needed, and the
 * board); anything else is a 404, printed so a new question shows.
 */
function standInHermes() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://hermes').pathname;
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/api/status') return send(200, { gateway_state: 'running', auth_required: false });
    if (req.method === 'GET' && path === '/api/plugins/kanban/board') return send(200, BOARD);
    console.log(`stand-in Hermes: ${req.method} ${path} answered 404`);
    return send(404, { detail: 'Not Found' });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Spelled /tmp, as the 1.9.0 pictures were taken: the project line shows the
// path, and the system's temp folder is a long random one.
const home = mkdtempSync('/tmp/tars-readme-');
seedSandbox(home);
const oldName = publicSeed(home);
const hermes = await standInHermes();
writeFileSync(join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: hermes.address().port, authMode: 'token' }, null, 2));
const startHere = writeStandIn(home);
const seen = newestChangelogId();
const hideDevIndicator = readFileSync(join('e2e', 'screenshot.css'), 'utf8');
mkdirSync(OUT, { recursive: true });
// Where the shots are taken, until every page has passed its guard.
const stage = mkdtempSync(join(tmpdir(), 'tars-readme-shots-'));

let app;
try {
  app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development',
      DOROTHY_DEV_URL: DEV_URL,
      DOROTHY_API_PORT: API_PORT,
      DOROTHY_E2E: '1',
    },
  });

  const page = await app.firstWindow();
  // Before any page reads it: the changelog counts as read, so no dot and no count.
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage blocked */ }
  }, [seen.key, seen.id]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState('domcontentloaded');
  // The splash runs its real steps; let it finish rather than photographing it.
  // The seeded agents start meanwhile and their stand-ins report their status.
  await page.waitForTimeout(6000);
  for (const id of startHere) {
    await page.evaluate(agentId => window.electronAPI.agent.start({ id: agentId, prompt: '' }), id).catch(() => {});
  }
  await page.waitForTimeout(3000);

  for (const { file, route, whole, ready } of SHOTS) {
    await page.goto(`${DEV_URL}${route}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    // Terminals mount asynchronously and the catalogue fetch settles late.
    await page.waitForTimeout(2500);
    if (ready) await ready(page);
    await page.addStyleTag({ content: hideDevIndicator });
    if (whole) await showWhole(page);
    const shown = await page.evaluate(() => document.body.innerText);
    for (const word of [oldName, '\u00ab', '\u00bb']) {
      if (shown.includes(word)) throw new Error(`${file} would show ${JSON.stringify(word)}`);
    }
    await page.screenshot({ path: join(stage, file), animations: 'disabled' });
    if (whole) await page.setViewportSize({ width: 1440, height: 900 });
  }
  for (const { file } of SHOTS) {
    copyFileSync(join(stage, file), join(OUT, file));
    console.log(`wrote ${join(OUT, file)}`);
  }
} finally {
  await app?.close().catch(() => {});
  hermes.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}
