import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Sending from a chat's page (PR D's chat:send; PLAN-2.0.0, step 5).
 * Frames: `Chat · chats · a new chat, its first message`, `· the composer, sending` and
 * `· every slot working`, in chat-redesign-a.pen.
 *
 * A sandbox HOME with one project, a git repository whose origin's main is one commit, which a
 * chat's runner starts from; its orchestrator Lead, chat #1 Main. The CLIs are stand-ins named
 * `claude`, as e2e/chat-runners.spec.ts writes them: they run Tars's hooks with the CLAUDE_PID Claude
 * Code hands them, keep a transcript where Claude Code keeps it, record every launch and every
 * prompt, and hold a turn whose prompt says HOLD until told to end it. The RAM figure is the E2E's:
 * 10 GB, so two chats work at once.
 *
 * The person opens the chats: Main's page, its composer open, and above the list 0 of 2 working.
 * 1. They write in Main and send: Lead starts with those words, which come back into the thread from
 *    its transcript; the list reads 1 of 2 working, and while Lead works the strip says the words go in
 *    when its turn ends.
 * 2. A second message while it works: typed into it, the field cleared; Lead takes it after its turn.
 * 3. New chat, named Release: its page says its conversation starts with its first message; that
 *    message makes its runner and starts it with those words; 2 of 2 working; the name stays.
 * 4. New chat, unnamed, while both work: its first message is refused, the page says why with the
 *    limit's sentence and the two chats working, each with its Stop, and the words stay in the field.
 * 5. Stop on Release: the next send of those words starts the new chat's runner, and its first
 *    message names it.
 * 6. A launch left on its way (the Audit's L1 on this PR): a new chat's first message while its
 *    runner is made, its git fetch held by a remote that never answers (as chat-runners.spec.ts holds
 *    one). The person opens Main and comes back: the page still says the orchestrator is starting with
 *    the words, which wait in the shut field. They open Main again; meanwhile the branch the runner
 *    would take appears, so its worktree cannot be made, and the send is refused while no page of the
 *    chat is open. Back on the chat: Not sent, why, and the words in the field.
 * 7. Release deleted, its runner's worktree holding a file it never committed and a .env git ignores
 *    (the Audit's read of the bullets): the list says its work went to wip/lead-release and its worktree
 *    stays, why and where, until ok puts it away; on disk, the branch and the folder are there.
 *
 * The artefact: a screenshot per state, values.json, launches.jsonl and prompts.jsonl.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
// As Claude Code: --resume <id> continues that session, in its own transcript; with --fork-session, under a new id.
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
// Where Claude Code keeps it: the folder's path, every character but a letter or a digit as '-'.
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, prompt: launchPrompt, cwd: process.cwd() });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  if (prompt.includes('HOLD>>')) {
    const release = path.join(process.env.HOME, 'release-' + id);
    while (!fs.existsSync(release)) await sleep(100);
    fs.rmSync(release, { force: true });
  }
  line({ type: 'assistant', uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else if (ch === '\x7f') buffer = buffer.slice(0, -1);
      else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

type Launch = { id: string; sid: string; prompt: string; cwd: string };
type Agent = { id: string; kind?: string; chatId?: string; status: string; worktreePath?: string };
type ChatRecord = { id: string; number: number; title: string; titleSource: string; runnerId: string | null };

const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test("a chat's page sends: Main and a new chat start with the words written there, a full limit says who works, and Stop frees a slot", async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-send-'));
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });

  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
  const gitSeed = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  gitSeed(home, 'init', '-q', '--bare', origin);
  gitSeed(home, 'init', '-q', '-b', 'main', project);
  fs.writeFileSync(path.join(project, 'README.md'), 'demo\n');
  gitSeed(project, 'add', '.');
  gitSeed(project, 'commit', '-q', '-m', 'main');
  gitSeed(project, 'remote', 'add', 'origin', origin);
  gitSeed(project, 'push', '-q', '-u', 'origin', 'main');

  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'o1', name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  const at = '2026-10-13T08:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [project]: 1 }, chats: [{
    id: 'c0ffee00-0000-4000-8000-000000000001', projectPath: project, number: 1, title: 'Main', titleSource: 'user', runnerId: 'o1',
    sessionIds: [], pinned: false, snoozedUntil: null, settledAt: null, inbox: true, createdAt: at, updatedAt: at, lastActivityAt: at,
  }] }, null, 2));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const promptsFile = path.join(home, 'prompts.jsonl');
  const release = (id: string) => fs.writeFileSync(path.join(home, `release-${id}`), '');
  const seen: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31445), DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '10' },
  });
  const pageErrors: string[] = [];
  let runners: string[] = [];
  try {
    const page: Page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    const call = (ns: string, name: string, arg?: unknown) => page.evaluate(([ns, name, arg]) => {
      const api = (window as unknown as { electronAPI: Record<string, Record<string, (a?: unknown) => Promise<unknown>>> }).electronAPI;
      return api[ns as string][name as string](arg);
    }, [ns, name, arg] as const);
    const chats = async () => (await call('chat', 'list') as { chats: ChatRecord[] }).chats;
    const runnerOf = async (chatId: string) => ((await call('agent', 'list')) as Agent[]).find((a) => a.kind === 'chat' && a.chatId === chatId);
    const launchesOf = (id: string) => lines<Launch>(launchesFile).filter((l) => l.id === id);
    const promptsOf = (id: string) => lines<{ id: string; prompt: string }>(promptsFile).filter((l) => l.id === id).map((l) => l.prompt);

    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    const count = sidebar.locator('[data-chats-working]');
    const main = page.getByRole('main');
    const composer = main.getByRole('group', { name: 'Message composer' });
    const field = composer.getByRole('textbox', { name: 'Message' });
    const send = composer.getByRole('button', { name: 'Send', exact: true });
    const thread = main.getByRole('log', { name: 'Conversation' });
    const said = (text: string) => thread.locator('[data-chat-item][data-kind="user"]').filter({ hasText: text });

    // Main's page: its composer open, and how many chats work of the most this Mac runs.
    await expect(field).toBeEnabled({ timeout: 90_000 });
    await expect(count).toHaveText('0 of 2 working', { timeout: 30_000 });
    await stepShot(page, '01-main-composer');

    // 1. A send in Main starts Lead with those words; they come back into the thread from its transcript.
    await field.fill('HOLD>> Look at the release script.');
    await send.click();
    await expect.poll(() => launchesOf('o1').map((l) => l.prompt).join('\n'), { timeout: 60_000 }).toContain('Look at the release script.');
    await expect(said('Look at the release script.')).toHaveCount(1, { timeout: 60_000 });
    await expect(field).toHaveValue('');
    await expect(count).toHaveText('1 of 2 working', { timeout: 30_000 });
    await expect(composer.getByText('The orchestrator is working: your message goes in when its turn ends.')).toBeVisible({ timeout: 30_000 });
    await stepShot(page, '02-main-working');

    // 2. A second message while Lead works: typed into it, the field cleared.
    await field.fill('Also the changelog.');
    await send.click();
    await expect(field).toHaveValue('', { timeout: 30_000 });
    await expect(composer.getByText(/^Not sent/)).toHaveCount(0);

    // 3. New chat, named: its page waits for its first message, which makes and starts its runner.
    await sidebar.getByRole('button', { name: 'New chat' }).click();
    await main.getByRole('textbox', { name: 'Title' }).fill('Release');
    await main.getByRole('button', { name: 'Create chat' }).click();
    await expect(main.getByText('Its conversation starts with your first message')).toBeVisible({ timeout: 30_000 });
    const releaseChat = (await chats()).find((c) => c.title === 'Release')!;
    await field.fill('HOLD>> Write the release notes.');
    await send.click();
    await expect.poll(async () => (await runnerOf(releaseChat.id))?.id ?? null, { timeout: 90_000 }).not.toBeNull();
    const releaseRunner = (await runnerOf(releaseChat.id))!.id;
    runners = [releaseRunner];
    await expect.poll(() => launchesOf(releaseRunner).map((l) => l.prompt).join('\n'), { timeout: 60_000 }).toContain('Write the release notes.');
    await expect(said('Write the release notes.')).toHaveCount(1, { timeout: 60_000 });
    await expect(count).toHaveText('2 of 2 working', { timeout: 30_000 });
    expect((await chats()).find((c) => c.id === releaseChat.id)?.title, 'a chat its user named keeps its name').toBe('Release');
    await stepShot(page, '03-release-started');

    // 4. New chat, unnamed, while both work: its first message is refused, and the page says who works.
    await sidebar.getByRole('button', { name: 'New chat' }).click();
    await main.getByRole('button', { name: 'Create chat' }).click();
    await expect(main.getByText('Its conversation starts with your first message')).toBeVisible({ timeout: 30_000 });
    const docsChat = (await chats()).find((c) => c.number === 3)!;
    await field.fill('Write the docs.');
    await send.click();
    const limit = main.locator('[data-chat-limit]');
    await expect(limit).toBeVisible({ timeout: 60_000 });
    await expect(limit).toContainText('2 chats are already working, the most this Mac runs at once (10 GB of RAM, one chat per 5 GB)');
    await expect(limit.locator('[data-chat-limit-row]')).toHaveCount(2);
    for (const title of ['Main', 'Release']) {
      const row = limit.locator('[data-chat-limit-row]').filter({ hasText: title });
      await expect(row.getByRole('link', { name: title, exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    }
    await expect(limit).toContainText('Your message stays in the composer.');
    await expect(field).toHaveValue('Write the docs.');
    expect((await chats()).find((c) => c.id === docsChat.id)?.title, 'a refused message names nothing').toBe('New chat');
    seen.limit = (await limit.innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '04-every-slot-working');

    // 5. Stop on Release frees a slot: the same words, sent again, start this chat's runner and name it.
    await limit.locator('[data-chat-limit-row]').filter({ hasText: 'Release' }).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(count).toHaveText('1 of 2 working', { timeout: 30_000 });
    await send.click();
    await expect.poll(async () => (await runnerOf(docsChat.id))?.id ?? null, { timeout: 90_000 }).not.toBeNull();
    const docsRunner = (await runnerOf(docsChat.id))!.id;
    runners = [releaseRunner, docsRunner];
    await expect.poll(() => launchesOf(docsRunner).map((l) => l.prompt).join('\n'), { timeout: 60_000 }).toContain('Write the docs.');
    await expect(limit).toHaveCount(0);
    await expect(field).toHaveValue('');
    await expect.poll(async () => (await chats()).find((c) => c.id === docsChat.id)?.title, { timeout: 30_000 }).toBe('Write the docs.');
    await expect(main.getByRole('heading', { name: 'Write the docs.' })).toBeVisible({ timeout: 30_000 });
    await stepShot(page, '05-docs-started');

    // Lead's held turn ends: the message typed during it reaches it after.
    release('o1');
    await expect.poll(() => promptsOf('o1'), { timeout: 60_000 }).toContain('Also the changelog.');
    seen.leadPrompts = promptsOf('o1');
    seen.launches = lines<Launch>(launchesFile).map((l) => ({ id: l.id, prompt: l.prompt }));

    // 6. A launch left on its way, then refused while no page of its chat is open (the Audit's L1 on this PR).
    // The app's links end with a slash before their query (trailingSlash): /chats/?chat=<id>.
    const linkTo = (id: string) => `a[href$="?chat=${encodeURIComponent(id)}"]`;
    const rowLink = (id: string) => sidebar.locator(`[data-chat-row] ${linkTo(id)}`);
    const mainId = (await chats()).find((c) => c.number === 1)!.id;
    await call('agent', 'stop', docsRunner);
    await expect(count).toHaveText('1 of 2 working', { timeout: 30_000 });
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    gitSeed(project, 'remote', 'set-url', 'origin', `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/demo.git`);
    await sidebar.getByRole('button', { name: 'New chat' }).click();
    await main.getByRole('button', { name: 'Create chat' }).click();
    await expect(main.getByText('Its conversation starts with your first message')).toBeVisible({ timeout: 30_000 });
    const leftChat = (await chats()).find((c) => c.number === 4)!;
    const short = leftChat.id.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
    await field.fill('Patch the login timeout.');
    await send.click();
    // Its runner is being made: past the check of its branch, its fetch is held.
    await expect.poll(() => sockets.size, { timeout: 30_000 }).toBeGreaterThan(0);
    const starting = composer.getByText('Starting the orchestrator with your message.');
    await expect(starting).toBeVisible();
    await rowLink(mainId).click();
    await expect(said('Look at the release script.')).toHaveCount(1, { timeout: 30_000 });
    await rowLink(leftChat.id).click();
    await expect(starting).toBeVisible({ timeout: 30_000 });
    await expect(field).toHaveValue('Patch the login timeout.');
    await expect(field).toBeDisabled();
    await stepShot(page, '06-launch-on-its-way');
    // Away again. The branch its runner would take appears, and the fetch ends: its worktree cannot be made.
    await rowLink(mainId).click();
    await expect(said('Look at the release script.')).toHaveCount(1, { timeout: 30_000 });
    gitSeed(project, 'branch', `chat/${short}`);
    for (const socket of sockets) socket.destroy();
    silent.close();
    // A send behind it in the slots' lock answers once the launch has: it was refused while the chat was away.
    seen.afterTheLaunch = await call('chat', 'send', { chatId: 'no-such-chat', text: 'after the launch' });
    expect(seen.afterTheLaunch).toMatchObject({ error: 'not_found' });
    gitSeed(project, 'remote', 'set-url', 'origin', origin);
    expect(await runnerOf(leftChat.id), 'a refused launch makes no runner').toBeUndefined();
    await rowLink(leftChat.id).click();
    const notSent = composer.getByText(/^Not sent: Its worktree could not be made/);
    await expect(notSent).toBeVisible({ timeout: 30_000 });
    await expect(notSent).toContainText(`chat/${short}`);
    await expect(field).toHaveValue('Patch the login timeout.');
    await expect(field).toBeEnabled();
    seen.notSentWhileAway = (await notSent.innerText()).replace(/\s+/g, ' ').trim();
    await stepShot(page, '07-refused-while-away');

    // 7. Release deleted: its runner's worktree holds a file it never committed and a .env git ignores.
    const releaseWorktree = (await runnerOf(releaseChat.id))!.worktreePath!;
    fs.writeFileSync(path.join(releaseWorktree, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(releaseWorktree, '.env'), 'TOKEN=e2e\n');
    const releaseRow = sidebar.locator('[data-chat-row]').filter({ has: page.locator(linkTo(releaseChat.id)) });
    await releaseRow.hover();
    await releaseRow.getByRole('button', { name: 'Actions for Release', exact: true }).click();
    await page.getByRole('menu', { name: 'Actions for Release', exact: true }).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await sidebar.getByRole('alertdialog').getByRole('button', { name: 'delete', exact: true }).click();
    await expect(releaseRow).toHaveCount(0, { timeout: 30_000 });
    const deleted = sidebar.locator('[data-chat-deleted]');
    await expect(deleted).toBeVisible({ timeout: 30_000 });
    await expect(deleted).toContainText(
      `Deleted demo #2, Release, but not its worktree: it holds files git ignores, which no commit keeps (.env), so its worktree was kept at ${releaseWorktree}.`,
    );
    await expect(deleted).toContainText('Its uncommitted work is on the branch wip/lead-release.');
    seen.deleted = (await deleted.innerText()).replace(/\s+/g, ' ').trim();
    expect(fs.existsSync(path.join(releaseWorktree, '.env')), 'the folder it names is there').toBe(true);
    expect(execFileSync('git', ['show', '--name-only', '--format=', 'wip/lead-release'], { cwd: project, encoding: 'utf8' }), 'the branch it names holds the work').toContain('.gitignore');
    expect((await chats()).some((c) => c.id === releaseChat.id), 'the chat is gone').toBe(false);
    await stepShot(page, '08-deleted-what-stays');
    await deleted.getByRole('button', { name: 'ok', exact: true }).click();
    await expect(deleted).toHaveCount(0);

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    for (const id of ['o1', ...runners]) release(id);
    await app.close().catch(() => {});
    for (const file of [launchesFile, promptsFile]) if (fs.existsSync(file)) fs.copyFileSync(file, test.info().outputPath(path.basename(file)));
    await removeHome(home);
  }
});
