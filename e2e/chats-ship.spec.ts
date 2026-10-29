import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { startFakeRelay } from '../__tests__/fixtures/fake-tars-relay';

/**
 * Two things of the chats that ship to everyone (GATE-2.0.0-BULLETS), in the real app.
 *
 * 1. Deleting a chat removes its worktree on a usual Mac. Claude Code writes `**\/.claude/settings.local.json` into
 *    the global git ignore (~/.config/git/ignore); a chat's runner gets the project's settings.local.json copied into
 *    its worktree, so git called it an ignored file, and the removal kept the whole worktree for it. The sandbox HOME
 *    here has that global ignore. Asserted: a chat deleted goes with its worktree, and one whose worktree holds
 *    another ignored file keeps it and says so, and one whose .claude is a link to the project's leaves the
 *    project's file alone (#394's gate, M1), and one whose worktree git refuses to remove (locked) says git's reason
 *    and where the worktree stays (the Audit's L1 on #398).
 * 2. With the new interface off and a project that has only Main, Telegram and the room read as 1.9.7 had them:
 *    a message that starts with "#2 " (an issue's number) reaches the orchestrator as typed, what the orchestrator
 *    sends carries no "[demo #1 Main]", and it posts in the room under its own name. Telegram through Hermes (the
 *    relay's stand-in) since 2.0.5, when Tars's own bot went.
 * The artefact: values.json of each test; prompts.jsonl of the stand-ins.
 */

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[/.]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
// The token its MCP servers present for it, as Tars handed it to this process.
record('tokens.jsonl', { token: process.env.CLAUDE_MGR_API_TOKEN || null });
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
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

type Agent = { id: string; kind?: string; chatId?: string; status: string; worktreePath?: string };
type Answer = Record<string, unknown>;
const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function seedProject(home: string) {
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  fs.mkdirSync(project, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com', HOME: home };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  git(home, 'init', '-q', '--bare', origin);
  git(home, 'init', '-q', '-b', 'main', project);
  fs.writeFileSync(path.join(project, 'README.md'), 'demo\n');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'main');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  return project;
}

async function boot(home: string, project: string, port: number, extraEnv: Record<string, string> = {}, settings: Record<string, unknown> = {}) {
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'o1', name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', ...settings }));
  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: String(port), DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '20', ...extraEnv },
  });
  const page: Page = await app.firstWindow();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
  const call = (ns: string, name: string, arg?: unknown) => page.evaluate(([ns, name, arg]) => {
    const api = (window as unknown as { electronAPI: Record<string, Record<string, (a?: unknown) => Promise<Answer>>> }).electronAPI;
    return api[ns as string][name as string](arg);
  }, [ns, name, arg] as const);
  const fleet = async () => await page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Agent[]> } } }).electronAPI.agent.list());
  const atRest = (id: string) => expect.poll(async () => (await fleet()).find((a) => a.id === id)?.status, { timeout: 30_000 }).toMatch(/^(idle|completed)$/);
  return { app, page, call, fleet, atRest };
}

test('deleting a chat removes its worktree, a global git ignore of settings.local.json included', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-delete-'));
  const project = seedProject(home);
  // As Claude Code writes it on a usual Mac.
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'git', 'ignore'), '**/.claude/settings.local.json\n*.keepme\n');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  const values: Record<string, unknown> = {};
  const { app, call, fleet, atRest } = await boot(home, project, apiPort(31443));
  try {
    const runnerFor = async (chatId: string) => (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chatId);
    const startChat = async (title: string) => {
      const chat = await call('chat', 'create', { projectPath: project, title }) as unknown as { id: string };
      expect(await call('chat', 'send', { chatId: chat.id, text: `${title.toUpperCase()}>> hello`, clientRequestId: `e2e-${title}` })).toMatchObject({ success: true });
      const runner = (await runnerFor(chat.id))!;
      await atRest(runner.id);
      return { chat, runner };
    };

    // A chat whose worktree holds Tars's copy of the grants, and what Claude Code adds to them.
    const one = await startChat('Release');
    const grants = path.join(one.runner.worktreePath!, '.claude', 'settings.local.json');
    expect(fs.existsSync(grants), 'the project\'s grants were copied into the runner\'s worktree').toBe(true);
    fs.writeFileSync(grants, JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Bash(git status)'] } }));
    const deleted = await call('chat', 'delete', { chatId: one.chat.id });
    values.deleted = deleted;
    recordValues(values);
    expect(deleted).toMatchObject({ success: true });
    expect(deleted.worktreeKept, 'the worktree was kept for its settings.local.json').toBeUndefined();
    expect(fs.existsSync(one.runner.worktreePath!)).toBe(false);

    // Another file git ignores still keeps the worktree, and says so.
    const two = await startChat('Notes');
    fs.writeFileSync(path.join(two.runner.worktreePath!, 'draft.keepme'), 'not in any commit');
    const kept = await call('chat', 'delete', { chatId: two.chat.id });
    values.kept = kept;
    recordValues(values);
    expect(String(kept.worktreeKept ?? '')).toContain('draft.keepme');
    expect(fs.existsSync(path.join(two.runner.worktreePath!, 'draft.keepme'))).toBe(true);

    // A worktree whose .claude is a link to the project's (#394's M1): the project's grants stay.
    const projectGrants = path.join(project, '.claude', 'settings.local.json');
    const before = fs.readFileSync(projectGrants, 'utf8');
    const three = await startChat('Linked');
    fs.rmSync(path.join(three.runner.worktreePath!, '.claude'), { recursive: true });
    fs.symlinkSync('../../.claude', path.join(three.runner.worktreePath!, '.claude'));
    expect(fs.readFileSync(path.join(three.runner.worktreePath!, '.claude', 'settings.local.json'), 'utf8'), 'the link reaches the project\'s file').toBe(before);
    values.linked = await call('chat', 'delete', { chatId: three.chat.id });
    recordValues(values);
    expect(values.linked).toMatchObject({ success: true });
    expect(fs.existsSync(projectGrants), 'the project\'s own settings.local.json was deleted through the link').toBe(true);
    expect(fs.readFileSync(projectGrants, 'utf8')).toBe(before);

    // A worktree git refuses to remove (locked, the Audit's L1 on #398): the answer says why, and where it stays.
    const four = await startChat('Locked');
    execFileSync('git', ['worktree', 'lock', '--reason', 'kept by hand', four.runner.worktreePath!], { cwd: project });
    values.locked = await call('chat', 'delete', { chatId: four.chat.id });
    recordValues(values);
    expect(values.locked).toMatchObject({ success: true });
    expect(String((values.locked as Answer).worktreeKept ?? ''), 'the chat list is told nothing of the worktree still on disk')
      .toBe(`git could not remove it (cannot remove a locked working tree, lock reason: kept by hand), so its worktree was kept at ${four.runner.worktreePath}`);
    expect(fs.existsSync(four.runner.worktreePath!)).toBe(true);
  } finally {
    await app.close();
  }
});

test('a project with only Main, the new interface off, reads on Telegram and in the room as 1.9.7', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-only-main-'));
  const project = seedProject(home);
  const hermes = await startFakeRelay('e2e-hermes-token');
  const port = apiPort(31444);
  const values: Record<string, unknown> = {};
  const { app, call, atRest } = await boot(home, project, port, {}, { hermesRelayEnabled: true, newInterface: false });
  try {
    const dist = path.resolve('electron', 'dist');
    await app.evaluate((_e, { dist, port, token }) => {
      const req = process.mainModule!.require;
      req(`${dist}/services/hermes-config.js`).writeHermesConnection({ mode: 'local', localPort: port, authMode: 'token', token });
    }, { dist, port: hermes.port, token: hermes.token });
    const prompts = () => lines<{ id: string; prompt: string }>(path.join(home, 'prompts.jsonl'));
    const chats = (await call('chat', 'list') as unknown as { chats: Array<{ id: string; number: number }> }).chats;
    values.chats = chats;
    expect(chats.map((c) => c.number), 'the project has only Main').toEqual([1]);
    // The orchestrator running, as it is when JeanBrasse writes to it.
    expect(await call('chat', 'send', { chatId: chats[0].id, text: 'MAIN>> hello', clientRequestId: 'e2e-main' })).toMatchObject({ success: true });
    await atRest('o1');

    // An issue's number at the start: to the orchestrator, as typed.
    hermes.projectMessage('demo', '#2 fix the login issue');
    await expect.poll(() => prompts().filter((p) => p.id === 'o1' && p.prompt.includes('#2 fix the login issue')).length, { timeout: 30_000 }).toBe(1);
    await atRest('o1');
    expect(hermes.sends.map((m) => m.text).join('\n'), 'answered as reaching nobody').not.toContain('reached nobody');

    // What the orchestrator sends: no chat prefix.
    const token = lines<{ id: string; token: string | null }>(path.join(home, 'tokens.jsonl')).filter((l) => l.id === 'o1' && l.token).at(-1)!.token!;
    const api = (route: string, body: unknown) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Answer }));
    expect((await api('/api/telegram/send', { message: 'MAIN news' })).status).toBeLessThan(300);
    await expect.poll(() => hermes.sends.some((m) => m.text.includes('MAIN news')), { timeout: 30_000 }).toBe(true);
    const sent = hermes.sends.find((m) => m.text.includes('MAIN news'))!;
    values.sent = sent;
    expect(sent.text).not.toContain('[demo #1 Main]');

    // The room: under its own name.
    const roomId = `project:${project}`;
    expect(await call('bus', 'postMessage', { roomId, text: 'ROOM>> JeanBrasse to the project' })).toMatchObject({ success: true });
    await expect.poll(() => prompts().some((p) => p.id === 'o1' && p.prompt.includes('ROOM>>')), { timeout: 30_000 }).toBe(true);
    await atRest('o1');
    expect((await api('/api/bus/post', { text: 'ROOM2>> the lead answers' })).body).toMatchObject({ success: true });
    const room = await call('bus', 'getRoom', roomId) as unknown as { messages: Array<{ authorName: string; text: string }> };
    const posted = room.messages.find((m) => m.text.includes('ROOM2>>'))!;
    values.posted = posted;
    expect(posted.authorName).toBe('Lead');
  } finally {
    values.hermesSends = hermes.sends;
    recordValues(values);
    await app.close();
    await hermes.close();
  }
});
