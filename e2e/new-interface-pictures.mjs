#!/usr/bin/env node
/**
 * The pictures of the new interface, the preview of 2.0.0, that the README and
 * the landing carry:
 *
 * - screenshots/new-interface-chat.png: a chat's page, its conversation followed
 *   live from its orchestrator's transcript, words in its composer while the
 *   orchestrator works, and the chat list with N of M working;
 * - screenshots/new-interface-project.png: a project's page;
 * - screenshots/new-interface-settings.png: Settings, Preferences, its New
 *   interface row on, as a card above the app;
 * - landing/src/assets/new-interface.png: the chat's page again, at twice the
 *   pixels, as the landing's Preview section draws it (design/landing.pen,
 *   Landing · desktop). The landing is dark only, and so is this.
 *
 * Not a spec: a spec would write tracked files at every run. Taken as
 * scripts/readme-shots.mjs takes the README's other pictures: the real app,
 * through launchSandboxed (e2e/fixture.mjs), in a sandbox it seeds, never
 * hand-made. From the repository's root, on Node 22:
 *
 *   npx tsc -p electron/tsconfig.json
 *   npx next dev -H 127.0.0.1 -p 3100     (3100 + E2E_PORT_OFFSET when set, as e2e/ports.mjs says)
 *   node e2e/new-interface-pictures.mjs   writes the four files
 *   PICTURES_DIR=/some/folder node e2e/new-interface-pictures.mjs   writes them there, by name
 *
 * The sandbox, /tmp/tars-preview, removed after (a fixed name: the project's
 * page shows its path):
 * - two projects, tars and harbor-billing, each a git repository whose origin
 *   has its main, from which a chat's runner makes its worktree;
 * - in tars, its orchestrator and three workers, one of them on Codex; in
 *   harbor-billing, its orchestrator and one worker;
 * - chats in every section: both Mains pinned, two chats whose orchestrators
 *   work, two open, one snoozed until tomorrow, three settled;
 * - the new interface on, and the E2E's RAM figure, 15 GB: three chats at once,
 *   so the list reads 2 of 3 working;
 * - the CLIs are stand-ins named claude, as the chat specs write them: they run
 *   Tars's hooks, and write their transcript where Claude Code keeps it. Each
 *   holds its turn until the app closes, so those it was asked to start work,
 *   and the orchestrator of each chat started says what the script has it say:
 *   what it hands to whom, what they answer, the tools it calls.
 *
 * What a public picture must not carry: What's New's dot (marked seen, at the
 * newest entry of src/data/changelog.ts), Next's dev indicator (e2e/
 * screenshot.css), a name or a path of this machine, or a word of the stand-ins.
 * The pictures are taken into a folder of their own and copied out only once
 * every page has passed that guard.
 */
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchSandboxed, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

const ROOT = '/tmp/tars-preview';
const MARK = join(ROOT, '.tars-pictures');
const HOME = join(ROOT, 'home');
const TARS = join(ROOT, 'code', 'tars');
const HARBOR = join(ROOT, 'code', 'harbor-billing');
const OUT = process.env.PICTURES_DIR;
const HOOKS = resolve('hooks');
const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const SIZE = { width: 1440, height: 900 };

/** Where each picture goes, unless PICTURES_DIR says otherwise. */
const PICTURES = {
  chat: 'screenshots/new-interface-chat.png',
  project: 'screenshots/new-interface-project.png',
  settings: 'screenshots/new-interface-settings.png',
  landing: 'landing/src/assets/new-interface.png',
};

/** Words no picture may show: this machine's, and the stand-ins'. */
const NEVER = [/\/Users\//, /stand-in/i, /\bHOLD\b/, /\be2e\b/i, /dorothy/i];
/**
 * Nor a name from the private list `npm run check:names` reads, which no file
 * here may spell: ~/.tars-private/private-names.txt, or TARS_PRIVATE_NAMES.
 * Without it, none.
 */
const PRIVATE_NAMES = (() => {
  let list = '';
  try { list = readFileSync(process.env.TARS_PRIVATE_NAMES || join(homedir(), '.tars-private', 'private-names.txt'), 'utf8'); } catch { return []; }
  return list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map((name) => new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu'));
})();

/** What each chat's orchestrator, and each worker, says and does in its turn: by the words it was started with. */
const SCRIPTS = [
  {
    prompt: 'The terminal grid jumps to the bottom when an agent writes while I read its history. Fix the scroll lock, with a test that fails first.',
    lines: [
      { text: 'I am splitting it: QA writes the test that fails first, the Frontend Engineer fixes TerminalGrid.tsx, and I check the two together.' },
      { tool: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'qa', task: 'Write the failing test for the scroll lock' } },
      { tool: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'fe', task: 'Keep the grid where you scrolled while an agent writes' } },
      { from: ['QA', 'qa'], text: 'The test is in `__tests__/components/terminal-scroll-lock.test.tsx`. It fails on main: the grid sets scrollTop on every write, even when you have scrolled up.' },
      { text: 'QA\'s test fails as it should. While the fix is made, I am reading how the grid scrolls.' },
      { tool: 'Read', input: { file_path: 'src/components/TerminalsView/TerminalGrid.tsx' } },
      { tool: 'Grep', input: { pattern: 'scrollTop', path: 'src/components/TerminalsView' } },
      { from: ['Frontend Engineer', 'fe'], text: 'Fixed: the grid follows new output only while you are at the bottom of it. QA\'s test passes.' },
      { text: 'Both are in. I am running QA\'s test and the grid\'s on the fix before I tell you.' },
      { tool: 'Bash', input: { command: 'npx vitest run __tests__/components/terminal-scroll-lock.test.tsx __tests__/components/terminal-grid.test.tsx' } },
    ],
  },
  {
    prompt: 'Write the release notes for 2.0.0 from the changelog and the pull requests merged since 1.9.6.',
    lines: [
      { text: 'I am reading the changelog and the merged pull requests first.' },
      { tool: 'Read', input: { file_path: 'src/data/changelog.ts' } },
      { tool: 'Bash', input: { command: 'gh pr list --state merged --search "merged:>=2026-10-13" --limit 50' } },
    ],
  },
  { prompt: 'Keep the terminal grid where you scrolled while an agent writes, in TerminalGrid.tsx.', lines: [{ tool: 'Edit', input: { file_path: 'src/components/TerminalsView/TerminalGrid.tsx' } }] },
  { prompt: 'Write the failing test for the scroll lock, then run it on the fix.', lines: [{ tool: 'Write', input: { file_path: '__tests__/components/terminal-scroll-lock.test.tsx' } }] },
];

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
// Where Claude Code keeps it: the folder's path, every character but a letter or a digit as '-'.
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Its turn: the words it was given, then what its script says, and it works on until the app closes.
async function turn(prompt) {
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  const script = SCRIPTS.find((s) => prompt.includes(s.prompt));
  for (const step of script ? script.lines : []) {
    await sleep(150);
    if (step.from) line({ type: 'user', message: { role: 'user', content: 'Message from agent ' + JSON.stringify(step.from[0]) + ' (' + JSON.stringify(step.from[1]) + '): ' + step.text } });
    else if (step.tool) line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + crypto.randomUUID().slice(0, 8), name: step.tool, input: step.input }] } });
    else line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.text }] } });
  }
  await new Promise(() => {});
}
process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('\r\n> ');
if (launchPrompt.trim()) void turn(launchPrompt);
process.stdin.resume();
`;

/** The sandbox's own folder, made empty: one this script made before is removed, anything else there is left and refused. */
function freshRoot() {
  if (existsSync(ROOT)) {
    if (!existsSync(MARK)) throw new Error(`${ROOT} exists and this script did not make it: move it away, and run again`);
    rmSync(ROOT, { recursive: true, force: true });
  }
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(MARK, 'made by e2e/new-interface-pictures.mjs, removed when it ends\n');
}

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Tars', GIT_AUTHOR_EMAIL: 'tars@example.com', GIT_COMMITTER_NAME: 'Tars', GIT_COMMITTER_EMAIL: 'tars@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

/** A project in git whose origin has its main, as a chat's runner needs one to make its worktree from. */
function project(dir, readme) {
  const origin = join(ROOT, 'origin', `${dir.split('/').pop()}.git`);
  mkdirSync(dir, { recursive: true });
  git(ROOT, 'init', '-q', '--bare', origin);
  git(ROOT, 'init', '-q', '-b', 'main', dir);
  writeFileSync(join(dir, 'README.md'), readme);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first commit');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
}

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Tomorrow, 9:00 here: what Snooze's second choice sets. */
function tomorrowAtNine() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function seed(cli) {
  const dir = join(HOME, '.dorothy');
  mkdirSync(dir, { recursive: true });
  const agent = (id, name, projectPath, extra) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath, skills: [], cliPath: cli, createdAt: ago(600), lastActivity: ago(40), ...extra,
  });
  writeFileSync(join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Orchestrator', TARS, { role: 'orchestrator', model: 'opus' }),
    agent('fe', 'Frontend Engineer', TARS, { model: 'sonnet' }),
    agent('be', 'Backend Engineer', TARS, { provider: 'codex', model: 'gpt-5.3-codex', cliPath: undefined }),
    agent('qa', 'QA', TARS, { model: 'sonnet' }),
    agent('o2', 'Orchestrator', HARBOR, { role: 'orchestrator', model: 'opus' }),
    agent('hb', 'Backend Engineer', HARBOR, { model: 'sonnet' }),
  ], null, 2));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify([TARS, HARBOR]));
  const chat = (projectPath, number, title, extra) => ({
    id: randomUUID(), projectPath, number, title, titleSource: 'user', runnerId: null, sessionIds: [], pinned: false,
    snoozedUntil: null, settledAt: null, inbox: false, createdAt: ago(190 - number * 20), updatedAt: ago(30), lastActivityAt: ago(120 - number * 10), ...extra,
  });
  const chats = [
    chat(TARS, 1, 'Main', { runnerId: 'o1', pinned: true, inbox: true, lastActivityAt: ago(35) }),
    chat(HARBOR, 1, 'Main', { runnerId: 'o2', pinned: true, inbox: true, lastActivityAt: ago(90) }),
    chat(TARS, 2, 'Fix the scroll lock'),
    chat(TARS, 3, 'Release notes for 2.0.0'),
    chat(TARS, 4, 'Speed up the Usage scan', { lastActivityAt: ago(70) }),
    chat(HARBOR, 2, 'Retry the invoice webhook on a 502', { lastActivityAt: ago(110) }),
    chat(TARS, 5, 'Flaky test on the Usage page', { snoozedUntil: tomorrowAtNine() }),
    chat(TARS, 6, 'Bump Electron to 44.4.4', { settledAt: ago(1500) }),
    chat(TARS, 7, 'Usage by hour', { settledAt: ago(2900) }),
    chat(HARBOR, 3, 'Invoice PDFs in the customer\'s language', { settledAt: ago(4300) }),
  ];
  writeFileSync(join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [TARS]: 7, [HARBOR]: 3 }, chats }, null, 2));
  writeFileSync(join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  writeFileSync(join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface: true }));
  return chats;
}

/** What's New's newest entry, as the page compares it with what was last seen. */
function newestChangelogId() {
  const source = readFileSync('src/data/changelog.ts', 'utf8');
  const key = /WHATS_NEW_STORAGE_KEY = '([^']+)'/.exec(source)?.[1];
  const id = /\bid:\s*(\d+)/.exec(source)?.[1];
  if (!key || !id) throw new Error('src/data/changelog.ts no longer says its storage key or its newest id');
  return { key, id };
}

async function until(what, check, timeout = 90_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`waited ${timeout / 1000} s for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The page's words, checked against NEVER before its picture is kept. */
async function guard(page, name) {
  const shown = await page.evaluate(() => document.body.innerText);
  const hit = NEVER.find((word) => word.test(shown));
  if (hit) throw new Error(`${name} would show ${hit}: no picture was written`);
  if (PRIVATE_NAMES.some((word) => word.test(shown))) throw new Error(`${name} would show a name from the private list: no picture was written`);
}

freshRoot();
project(TARS, '# tars\n');
project(HARBOR, '# harbor-billing\n');
mkdirSync(join(HOME, 'bin'), { recursive: true });
const cli = join(HOME, 'bin', 'claude');
writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst SCRIPTS = ${JSON.stringify(SCRIPTS)};\n${STAND_IN}`, { mode: 0o755 });
const chats = seed(cli);
const byTitle = (title) => chats.find((c) => c.title === title);
const seen = newestChangelogId();
const hideDevIndicator = readFileSync(join('e2e', 'screenshot.css'), 'utf8');
const stage = mkdtempSync(join(tmpdir(), 'tars-pictures-'));

let app;
try {
  app = await launchSandboxed(electron, HOME, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31447), DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '15' },
  });
  const page = await app.firstWindow();
  await page.addInitScript(([key, id]) => {
    try { localStorage.setItem(key, id); } catch { /* storage blocked */ }
  }, [seen.key, seen.id]);
  await page.setViewportSize(SIZE);
  await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
  await page.locator(SPLASH).waitFor({ state: 'detached', timeout: 60_000 });
  const call = (ns, name, arg) => page.evaluate(([ns, name, arg]) => window.electronAPI[ns][name](arg), [ns, name, arg]);
  const agents = () => call('agent', 'list');

  // The workers the scroll lock went to, at work.
  for (const [id, prompt] of [['fe', SCRIPTS[2].prompt], ['qa', SCRIPTS[3].prompt]]) {
    const started = await call('agent', 'start', { id, prompt });
    if (!started?.success) throw new Error(`${id} did not start: ${JSON.stringify(started)}`);
  }
  // Two chats' orchestrators started by their first message, each in a worktree of its own.
  for (const [title, prompt] of [['Fix the scroll lock', SCRIPTS[0].prompt], ['Release notes for 2.0.0', SCRIPTS[1].prompt]]) {
    const sent = await call('chat', 'send', { chatId: byTitle(title).id, text: prompt, clientRequestId: randomUUID(), mode: 'auto' });
    if (!sent?.success) throw new Error(`${title} was not started: ${JSON.stringify(sent)}`);
  }
  await until('the workers and both chats at work', async () => (await agents()).filter((a) => a.status === 'running').length === 4);

  // 1. The scroll lock's chat: its conversation, its orchestrator at work, words in its composer.
  const scroll = byTitle('Fix the scroll lock');
  await page.goto(`${DEV_URL}/chats?chat=${encodeURIComponent(scroll.id)}`, { waitUntil: 'domcontentloaded' });
  const main = page.getByRole('main');
  const thread = main.getByRole('log', { name: 'Conversation' });
  await thread.getByText('Both are in.', { exact: false }).waitFor({ timeout: 60_000 });
  await thread.locator('[data-kind="tool"]').filter({ hasText: 'Bash: npx vitest run' }).first().waitFor({ timeout: 60_000 });
  await page.getByRole('complementary', { name: 'Sidebar' }).locator('[data-chats-working]').filter({ hasText: '2 of 3 working' }).waitFor({ timeout: 60_000 });
  const composer = main.getByRole('group', { name: 'Message composer' });
  await composer.getByRole('textbox', { name: 'Message' }).fill('Also check it with two terminals side by side.');
  await composer.getByText('The orchestrator is working: your message goes in when its turn ends.').waitFor({ timeout: 30_000 });
  await page.mouse.move(SIZE.width - 2, SIZE.height - 2);
  await page.addStyleTag({ content: hideDevIndicator });
  await guard(page, 'the chat');
  await page.screenshot({ path: join(stage, 'chat.png'), animations: 'disabled' });
  // The landing's, at twice the pixels, as its other picture is: taken by the page itself, which Playwright's
  // screenshot would take again at the window's own scale.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(500);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  const landing = Buffer.from(data, 'base64');
  if (landing.readUInt32BE(16) !== SIZE.width * 2 || landing.readUInt32BE(20) !== SIZE.height * 2) {
    throw new Error(`the landing's picture is ${landing.readUInt32BE(16)} by ${landing.readUInt32BE(20)}, not ${SIZE.width * 2} by ${SIZE.height * 2}`);
  }
  writeFileSync(join(stage, 'landing.png'), landing);
  await page.waitForTimeout(500);

  // 2. The project's page: its chats, its team at work, its terminals and its room.
  await page.goto(`${DEV_URL}/project?path=${encodeURIComponent(TARS)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Team' }).locator('[data-team-member]').filter({ hasText: 'Frontend Engineer' }).waitFor({ timeout: 60_000 });
  await page.getByRole('region', { name: 'Chats in tars' }).locator('[data-project-chat]').filter({ hasText: 'Fix the scroll lock' }).waitFor({ timeout: 60_000 });
  await page.mouse.move(SIZE.width - 2, SIZE.height - 2);
  await page.addStyleTag({ content: hideDevIndicator });
  await guard(page, 'the project');
  await page.screenshot({ path: join(stage, 'project.png'), animations: 'disabled' });

  // 3. Settings, as a card above the scroll lock's chat: Preferences, its New interface row on.
  await page.goto(`${DEV_URL}/chats?chat=${encodeURIComponent(scroll.id)}`, { waitUntil: 'domcontentloaded' });
  await thread.getByText('Both are in.', { exact: false }).waitFor({ timeout: 60_000 });
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const row = settings.locator('[data-settings-row]', { hasText: 'New interface' });
  await row.getByRole('switch', { name: 'New interface', checked: true }).waitFor({ timeout: 60_000 });
  await settings.getByText('Opening the page').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(SIZE.width - 2, SIZE.height - 2);
  await page.addStyleTag({ content: hideDevIndicator });
  await guard(page, 'Settings');
  await page.screenshot({ path: join(stage, 'settings.png'), animations: 'disabled' });

  for (const [name, file] of Object.entries(PICTURES)) {
    const to = OUT ? join(OUT, file.split('/').pop()) : file;
    if (OUT) mkdirSync(OUT, { recursive: true });
    copyFileSync(join(stage, `${name}.png`), to);
    console.log(`wrote ${to}`);
  }
} finally {
  await app?.close().catch(() => {});
  rmSync(stage, { recursive: true, force: true });
  await removeHome(ROOT);
}
