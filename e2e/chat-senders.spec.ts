import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { startFakeRelay, type FakeRelay } from '../__tests__/fixtures/fake-tars-relay';
import { BOT_TOKEN, OWNER_ID, startFakeTelegram } from '../__tests__/fixtures/fake-telegram';

/**
 * Who writes to "the project's orchestrator" reaches the project's inbox chat, Telegram names a chat by its number,
 * and the room keeps its rules (ORCHESTRATOR-PER-CHAT.md v2.2, 4.6 and 5 row F; PR F of 2.0.0), in the real app.
 *
 * A sandbox HOME with one project "demo" (a git repository with origin's main), its orchestrator "Lead" and a worker.
 * The CLIs are stand-ins named `claude` that run Tars's own hook scripts and record every turn's prompt. Three chats:
 * #1 Main (the orchestrator), #2 "Inbox", made the project's inbox, and #3 "Release". Telegram is a stand-in of its
 * Bot API on the loopback (DOROTHY_TELEGRAM_API_URL, read under DOROTHY_E2E only); Hermes is a stand-in of the gateway:
 * the tars-relay plugin's routes and the two kanban routes a parked task takes.
 *
 * Asserted, in order:
 * 1. Tars's own Telegram bot: a fresh message lands in the inbox chat (#2), not in Main; "#3 text" in chat #3;
 *    "@demo #3 text" in chat #3; an unknown "#9" gets the numbered list and reaches nobody;
 * 2. what chat #3 sends to Telegram starts "[demo #3 Release]", and a reply to it lands in chat #3;
 * 3. a kanban task a worker files is noted in the inbox chat; the error triage's note lands there too;
 * 4. through the Hermes relay: what chat #3 sends starts "[demo #3 Release]", and a reply to it lands in chat #3; a
 *    fresh "@demo #3 text" lands in chat #3, "@demo text" in the inbox, "@demo #9 text" gets the list;
 * 5. a question chat #3 asks the user is prefixed with its chat, and the user's answer lands in chat #3;
 * 6. the room: JeanBrasse's message to the project lands in the room and in Main, not in a chat's runner; chat #3's post
 *    reaches the room named "chat #3 "Release""; JeanBrasse's answer to it lands in chat #3, not in Main;
 * 7. a worker nobody asked for work, running and silent for 40 minutes, is reported to the inbox chat, not to Main.
 * The artefact: values.json (each answer, what each stand-in received), prompts.jsonl (every turn of every CLI).
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

type Agent = { id: string; name?: string; kind?: string; chatId?: string; status: string };
type ChatRecord = { id: string; number: number; title: string; inbox: boolean };
type Answer = Record<string, unknown>;

const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('every sender reaches the inbox chat, Telegram names a chat by its number, and the room keeps its rules', async () => {
  test.setTimeout(480_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-senders-'));
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  const dir = path.join(home, '.dorothy');
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
  const agent = (id: string, name: string, role: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('o1', 'Lead', 'orchestrator'), agent('w1', 'Worker', 'worker')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    telegramEnabled: true, telegramBotToken: BOT_TOKEN, telegramAuthToken: 'e2e-auth-token',
    telegramAuthorizedChatIds: [String(OWNER_ID)], telegramChatId: String(OWNER_ID), hermesRelayEnabled: false,
  }));
  // Hermes may reach the project, as the user allows it in Settings, Hermes: "@demo" through the relay reaches it.
  const privateDir = path.join(home, '.tars-private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(privateDir, 'hermes-gateways.json'), JSON.stringify({ gateways: [{ id: 'default', label: 'Hermes', projects: [project] }] }), { mode: 0o600 });

  const telegram = await startFakeTelegram();
  // Hermes: the relay plugin's routes, and the kanban's create and park of a parked task.
  const board = new Map<string, Record<string, unknown>>();
  let nextTask = 1;
  const hermes: FakeRelay = await startFakeRelay('e2e-hermes-token', {
    extra: ({ method, path: p, body }) => {
      if (method === 'POST' && p === '/api/plugins/kanban/tasks') {
        const task = { id: `t_${nextTask++}`, status: 'ready', priority: 0, tenant: null, assignee: null, ...body };
        board.set(task.id as string, task);
        return { status: 200, body: { task } };
      }
      const patched = /^\/api\/plugins\/kanban\/tasks\/([^/]+)$/.exec(p);
      if (method === 'PATCH' && patched && board.has(patched[1])) {
        const task = { ...board.get(patched[1]), ...body };
        board.set(patched[1], task);
        return { status: 200, body: { task } };
      }
      return undefined;
    },
  });
  const promptsFile = path.join(home, 'prompts.jsonl');
  const port = apiPort(31457);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, project };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '20',
      DOROTHY_TELEGRAM_API_URL: telegram.url,
    },
  });
  try {
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    await app.evaluate((_e, { dist, port, token }) => {
      const req = process.mainModule!.require;
      req(`${dist}/services/hermes-config.js`).writeHermesConnection({ mode: 'local', localPort: port, authMode: 'token', token });
    }, { dist, port: hermes.port, token: hermes.token });
    const call = (ns: string, name: string, arg?: unknown, arg2?: unknown) => page.evaluate(([ns, name, arg, arg2]) => {
      const api = (window as unknown as { electronAPI: Record<string, Record<string, (a?: unknown, b?: unknown) => Promise<Answer>>> }).electronAPI;
      return api[ns as string][name as string](arg, arg2);
    }, [ns, name, arg, arg2] as const);
    const chats = async () => (await call('chat', 'list') as unknown as { chats: ChatRecord[] }).chats;
    const send = (chatId: string, text: string) => call('chat', 'send', { chatId, text, clientRequestId: `e2e-${Math.random()}` });
    const fleet = async () => await page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Agent[]> } } }).electronAPI.agent.list());
    const agentOf = async (id: string) => (await fleet()).find((a) => a.id === id);
    const runnerOf = async (chatId: string) => (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chatId);
    const prompts = () => lines<{ id: string; prompt: string }>(promptsFile);
    const reached = (needle: string) => prompts().filter((l) => l.prompt.includes(needle)).map((l) => l.id);
    const atRest = (id: string) => expect.poll(async () => (await agentOf(id))?.status, { timeout: 30_000 }).toMatch(/^(idle|completed)$/);
    // The agent's own token: the one its running CLI was handed (minting another would end that one, and its
    // hooks with it); minted only for an agent with no terminal yet.
    const tokenOf = async (id: string) => lines<{ id: string; token: string | null }>(path.join(home, 'tokens.jsonl')).filter((l) => l.id === id && l.token).at(-1)?.token
      ?? app.evaluate((_e, { dist, id }) => {
        const req = process.mainModule!.require;
        return req(`${dist}/core/agent-tokens.js`).mintAgentToken(id) as string;
      }, { dist, id });
    const api = async (id: string, route: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenOf(id)}` }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Answer };
    };

    // The three chats, the second made the inbox, and each conversation started.
    const main = (await chats()).find((c) => c.number === 1)!;
    const inbox = await call('chat', 'create', { projectPath: project, title: 'Inbox' }) as unknown as ChatRecord;
    const release = await call('chat', 'create', { projectPath: project, title: 'Release' }) as unknown as ChatRecord;
    keep({ main, inbox, release });
    expect([main.number, inbox.number, release.number]).toEqual([1, 2, 3]);
    expect(await call('chat', 'setInbox', { chatId: inbox.id })).toMatchObject({ inbox: true });
    for (const [chat, text] of [[main, 'MAIN>> hello'], [inbox, 'INBOX>> hello'], [release, 'RELEASE>> hello']] as const) {
      expect(await send(chat.id, text)).toMatchObject({ success: true });
    }
    const inboxRunner = (await runnerOf(inbox.id))!.id;
    const releaseRunner = (await runnerOf(release.id))!.id;
    keep({ inboxRunner, releaseRunner });
    for (const id of ['o1', inboxRunner, releaseRunner]) await atRest(id);

    // 1. Tars's own bot.
    telegram.write('TG1>> fresh, for the inbox');
    await expect.poll(() => reached('TG1>>'), { timeout: 30_000 }).toEqual([inboxRunner]);
    await atRest(inboxRunner);
    // After the line Tars writes for its sender, as the orchestrator gets it.
    expect(prompts().find((l) => l.prompt.includes('TG1>>'))!.prompt.startsWith('Message from Telegram: ')).toBe(true);
    telegram.write('#3 TG2>> named by its number');
    await expect.poll(() => reached('TG2>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);
    telegram.write('@demo #3 TG3>> named with its project');
    await expect.poll(() => reached('TG3>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);
    const before = telegram.sent.length;
    telegram.write('#9 TG4>> to no chat');
    await expect.poll(() => telegram.sent.slice(before).map((m) => m.text).join('\n'), { timeout: 30_000 }).toContain('#3 Release');
    const listed = telegram.sent.slice(before).map((m) => m.text).join('\n');
    keep({ listed });
    expect(listed).toContain('#1 Main');
    expect(listed).toContain('#2 Inbox');
    expect(reached('TG4>>')).toEqual([]);

    // 2. What chat #3 sends carries its chat, and a reply to it reaches chat #3.
    const fromRelease = await api(releaseRunner, '/api/telegram/send', { message: 'TG5 news from the release chat' });
    keep({ fromRelease });
    expect(fromRelease.status).toBe(200);
    const tagged = telegram.sent.find((m) => m.text.includes('TG5 news'))!;
    keep({ tagged });
    expect(tagged.text.startsWith('[demo #3 Release]')).toBe(true);
    telegram.write('TG6>> my reply to the release chat', tagged.message_id);
    await expect.poll(() => reached('TG6>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);

    // 3. A kanban task a worker files, and the error triage's note: in the inbox chat.
    const filed = await api('w1', '/api/kanban/tasks', { title: 'KANBAN>> fix the flaky test' });
    keep({ filed });
    expect(filed.status).toBe(200);
    await expect.poll(() => reached('KANBAN>>'), { timeout: 30_000 }).toEqual([inboxRunner]);
    await atRest(inboxRunner);
    const triage = await app.evaluate((_e, { dist, project }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/services/api-routes/kanban-routes.js`).tellOrchestratorAsTars(project, 'TRIAGE>> a Sentry error to hand out') as Promise<string>;
    }, { dist, project });
    keep({ triage });
    expect(triage).toBe('typed');
    await expect.poll(() => reached('TRIAGE>>'), { timeout: 30_000 }).toEqual([inboxRunner]);
    await atRest(inboxRunner);

    // 4. Through the Hermes relay.
    const switched = await call('appSettings', 'save', { hermesRelayEnabled: true });
    keep({ switched });
    const relayStatus = () => page.evaluate(() => (window as unknown as { electronAPI: { hermes: { relayStatus(): Promise<Record<string, unknown>> } } }).electronAPI.hermes.relayStatus());
    await expect.poll(async () => { const st = await relayStatus(); keep({ relayStatus: st, hermesCalls: hermes.calls.slice(-5) }); return st.state; }, { timeout: 30_000 }).toBe('ready');
    const relayed = await api(releaseRunner, '/api/telegram/send', { message: 'RELAY news from the release chat' });
    keep({ relayed });
    expect(relayed.status).toBeLessThan(300);
    const relaySent = hermes.sends.find((s) => s.text.includes('RELAY news'))!;
    keep({ relaySent });
    expect(relaySent.text.startsWith('[demo #3 Release]')).toBe(true);
    hermes.reply({ messageId: relaySent.messageId }, 'RL1>> my reply through Hermes');
    await expect.poll(() => reached('RL1>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);
    hermes.projectMessage('demo', '#3 RL2>> fresh, named by its number');
    await expect.poll(() => reached('RL2>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);
    hermes.projectMessage('demo', 'RL3>> fresh, for the inbox');
    await expect.poll(() => reached('RL3>>'), { timeout: 30_000 }).toEqual([inboxRunner]);
    await atRest(inboxRunner);
    expect(prompts().find((l) => l.prompt.includes('RL3>>'))!.prompt.startsWith('Message from the user via Telegram: ')).toBe(true);
    const sendsBefore = hermes.sends.length;
    hermes.projectMessage('demo', '#9 RL4>> to no chat');
    await expect.poll(() => hermes.sends.slice(sendsBefore).map((s) => s.text).join('\n'), { timeout: 30_000 }).toContain('#3 Release');
    expect(reached('RL4>>')).toEqual([]);

    // 5. A question from chat #3, and the user's answer.
    const asked = await api(releaseRunner, '/api/user/ask', { question: 'Q1 ship 1.9.7 tonight?' });
    keep({ asked });
    expect(asked.status).toBe(200);
    const question = hermes.sends.find((s) => s.text.includes('Q1 ship'))!;
    keep({ question });
    expect(question.text.startsWith('[demo #3 Release]')).toBe(true);
    hermes.reply({ messageId: question.messageId }, 'ANS>> yes, ship it');
    await expect.poll(() => reached('ANS>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);

    // 6. The room.
    const roomId = `project:${project}`;
    const posted = await call('bus', 'postMessage', { roomId, text: 'ROOM1>> JeanBrasse to the project' });
    keep({ posted });
    expect(posted).toMatchObject({ success: true });
    await expect.poll(() => reached('ROOM1>>'), { timeout: 30_000 }).toEqual(['o1']);
    await atRest('o1');
    const fromChat = await api(releaseRunner, '/api/bus/post', { text: 'ROOM2>> the release chat to the room' });
    keep({ fromChat });
    expect(fromChat.body).toMatchObject({ success: true });
    const room = await call('bus', 'getRoom', roomId) as unknown as { messages: Array<{ authorName: string; authorId: string; text: string }> };
    const named = room.messages.find((m) => m.text.includes('ROOM2>>'))!;
    keep({ named });
    expect(named.authorName).toContain('chat #3 "Release"');
    const answered = await call('bus', 'postMessage', { roomId, text: 'ROOM3>> JeanBrasse answers the release chat', mentions: [named.authorId] });
    keep({ answered });
    expect(answered).toMatchObject({ success: true });
    await expect.poll(() => reached('ROOM3>>'), { timeout: 30_000 }).toEqual([releaseRunner]);
    await atRest(releaseRunner);

    // 7. A stall nobody asked for: to the inbox chat. The worker's session as its SessionStart registered it, marked
    // running on a transcript last written 40 minutes ago, and the check run once, as its timer would.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'w1', prompt: '' }));
    await expect.poll(() => app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      return !!req(`${dist}/core/agent-manager.js`).agents.get('w1').currentSessionId;
    }, { dist }), { timeout: 30_000 }).toBe(true);
    const stalledTranscript = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get('w1');
      req(`${dist}/core/agent-launch.js`).resetLaunches();
      a.status = 'running';
      return req(`${dist}/utils/resume-session.js`).transcriptPath(a.ptyCwd, a.currentSessionId) as string;
    }, { dist });
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000);
    fs.mkdirSync(path.dirname(stalledTranscript), { recursive: true });
    if (!fs.existsSync(stalledTranscript)) fs.writeFileSync(stalledTranscript, '{"type":"user"}\n');
    fs.utimesSync(stalledTranscript, fortyMinutesAgo, fortyMinutesAgo);
    await app.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      await req(`${dist}/services/stall-watch.js`).checkStalls();
    }, { dist });
    await expect.poll(() => reached('nothing to its transcript for 40 minutes'), { timeout: 30_000 }).toEqual([inboxRunner]);
    keep({ prompts: prompts(), telegramSent: telegram.sent, hermesSends: hermes.sends });
  } finally {
    await app.close();
    await telegram.close();
    await hermes.close();
  }
});
