import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The chats' records and their migration (ORCHESTRATOR-PER-CHAT.md v2.2, 4.1,
 * 4.5 and 4.6, PR C), in the real app, through the window's own channels.
 *
 * A sandbox HOME with two projects: "demo", whose orchestrator "Lead" already
 * has a conversation, with a worker; and "other", with a worker and no
 * orchestrator. Two stand-in CLIs record what is typed into Lead and the
 * worker; their sessions and turns reach Tars through the real hook route,
 * each with its own token, as Claude Code's hooks post them.
 *
 * Asserted, in order:
 * 1. the first launch makes chat #1 "Main" for demo: bound to Lead, its inbox,
 *    holding Lead's conversation; and no chat for other;
 * 2. system:chatLimit reads the E2E's 16 GB: 3 chats, and says where the
 *    figure came from;
 * 3. create, rename, pin, snooze, settle and delete, each answered and kept;
 *    a deleted chat's number is not handed out again; a project with no
 *    orchestrator gets no chat; the inbox cannot be deleted, and moves;
 * 4. a new session of Lead's is added to Main's sessions;
 * 5. Main cannot be deleted while Lead has a request out at the worker:
 *    `chat_has_work`, naming it;
 * 6. quit, launch again: every chat as it was, and chats.json byte for byte
 *    what the first run left, after the launch and a while later: the
 *    migration ran once.
 * The artefact: values.json with each answer and the file's sha256 at each
 * step, and the file itself after each run (chats-run1.json, chats-run2.json).
 * Sending in a chat is e2e/chat-runners.spec.ts's.
 */

const SESSION_A = 'e2e00000-0000-4000-8000-0000000000aa';
const SESSION_B = 'e2e00000-0000-4000-8000-0000000000bb';
const SESSION_W = 'e2e00000-0000-4000-8000-0000000000cc';

type Chat = {
  id: string; projectPath: string; number: number; title: string; titleSource: string; runnerId: string | null;
  sessionIds: string[]; pinned: boolean; snoozedUntil: string | null; settledAt: string | null; inbox: boolean;
  createdAt: string; updatedAt: string; lastActivityAt: string; runner?: unknown;
};
type Answer = Record<string, unknown>;
type Listing = { seq: number; chats: Chat[]; problem: unknown };

/** One channel of window.electronAPI.chat, called in the page. */
async function chat(page: Page, name: string, arg?: unknown): Promise<Answer> {
  return page.evaluate(([name, arg]) => {
    const api = (window as unknown as { electronAPI: { chat: Record<string, (a?: unknown) => Promise<Answer>> } }).electronAPI;
    return api.chat[name as string](arg);
  }, [name, arg] as const);
}
const list = async (page: Page) => (await chat(page, 'list')) as unknown as Listing;
/** A chat's record as chats.json keeps it: what the window also learns of its runner left out. */
const recordOf = (chat: Chat): Omit<Chat, 'runner'> => {
  const rest = { ...chat };
  delete rest.runner;
  return rest;
};

test("chats: Main made once from the project's orchestrator, and every change kept across a relaunch", async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chats-'));
  const project = path.join(home, 'projects', 'demo');
  const other = path.join(home, 'projects', 'other');
  const dir = path.join(home, '.dorothy');
  for (const d of [project, other, dir]) fs.mkdirSync(d, { recursive: true });
  const cliFor = (id: string) => {
    const file = path.join(home, `${id}.received`);
    const cli = path.join(home, `${id}-cli.cjs`);
    fs.writeFileSync(cli, [
      `#!${process.execPath}`,
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
      "process.stdout.write('stand-in ready\\n');",
      '',
    ].join('\n'), { mode: 0o755 });
    return cli;
  };
  const agent = (id: string, name: string, role: string, projectPath: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath, skills: [], cliPath: cliFor(id),
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-10T09:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Lead', 'orchestrator', project, { resumableSessionId: SESSION_A }),
    agent('w1', 'Worker', 'worker', project),
    agent('w2', 'Helper', 'worker', other),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, other]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31456);
  const dist = path.resolve('electron', 'dist');
  const env = { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '16' };
  const chatsFile = path.join(dir, 'chats.json');
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(chatsFile)).digest('hex');
  const values: Record<string, unknown> = { home, project, other };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await launchSandboxed(electron, home, { env });
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    return { app, page };
  };

  // ---- First run
  let { app, page } = await launch();
  let finalRun1: Chat[] = [];
  try {
    // 1. Main, from Lead's conversation; nothing for the project with no orchestrator.
    const first = await list(page);
    keep({ migration: first, shaAfterMigration: sha() });
    expect(first.problem).toBeNull();
    expect(first.chats).toHaveLength(1);
    const main = first.chats[0];
    expect(recordOf(main)).toMatchObject({
      projectPath: project, number: 1, title: 'Main', titleSource: 'user', runnerId: 'o1', inbox: true,
      sessionIds: [SESSION_A], pinned: false, snoozedUntil: null, settledAt: null, createdAt: '2026-10-01T08:00:00.000Z',
    });
    expect(main.runner).toMatchObject({ id: 'o1', name: 'Lead', live: false });

    // 2. The limit, from the E2E's RAM figure.
    const chatLimit = () => page.evaluate(() => (window as unknown as { electronAPI: { system: { chatLimit(): Promise<Answer> } } }).electronAPI.system.chatLimit());
    const limit = await chatLimit();
    keep({ limit });
    expect(limit).toMatchObject({ limit: 3, ramGb: 16, perChatGb: 5, min: 1, max: 8, source: 'override', working: 0 });

    // 3. The records' lifecycle.
    const two = await chat(page, 'create', { projectPath: project, title: 'Release 1.9.4' }) as unknown as Chat;
    const three = await chat(page, 'create', { projectPath: project }) as unknown as Chat;
    const none = await chat(page, 'create', { projectPath: other, title: 'No orchestrator here' });
    const renamed = await chat(page, 'rename', { chatId: three.id, title: 'Bug #12' });
    const blank = await chat(page, 'rename', { chatId: three.id, title: '   ' });
    const pinned = await chat(page, 'pin', { chatId: two.id, pinned: true });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const snoozed = await chat(page, 'snooze', { chatId: three.id, until });
    const past = await chat(page, 'snooze', { chatId: three.id, until: '2020-01-01T00:00:00.000Z' });
    const settled = await chat(page, 'settle', { chatId: two.id, settled: true });
    const deleted = await chat(page, 'delete', { chatId: three.id });
    const four = await chat(page, 'create', { projectPath: project, title: 'After the delete' }) as unknown as Chat;
    const inboxRefused = await chat(page, 'delete', { chatId: main.id });
    const moved = await chat(page, 'setInbox', { chatId: two.id });
    const afterChanges = await list(page);
    keep({ two, three, none, renamed, blank, pinned, snoozed, past, settled, deleted, four, inboxRefused, moved, afterChanges, shaAfterChanges: sha() });
    expect(two).toMatchObject({ number: 2, title: 'Release 1.9.4', titleSource: 'user', runnerId: null, inbox: false });
    expect(three).toMatchObject({ number: 3, title: 'New chat', titleSource: 'auto' });
    expect(none).toMatchObject({ error: 'no_orchestrator' });
    expect(renamed).toMatchObject({ title: 'Bug #12', titleSource: 'user' });
    expect(blank).toMatchObject({ error: 'invalid_title' });
    expect(pinned).toMatchObject({ pinned: true });
    expect(snoozed).toMatchObject({ snoozedUntil: until });
    expect(past).toMatchObject({ error: 'invalid_until' });
    expect(typeof (settled as Chat).settledAt).toBe('string');
    expect(deleted).toEqual({ success: true });
    expect(four.number).toBe(4);
    expect(inboxRefused).toMatchObject({ error: 'inbox' });
    expect(moved).toMatchObject({ id: two.id, inbox: true });
    expect(afterChanges.chats.map(c => [c.number, c.title, c.inbox, c.pinned, !!c.settledAt])).toEqual([
      [1, 'Main', false, false, false],
      [2, 'Release 1.9.4', true, true, true],
      [4, 'After the delete', false, false, false],
    ]);
    expect(afterChanges.chats.some(c => c.projectPath === other)).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(chatsFile, 'utf8')) as { version: number; numbers: Record<string, number>; chats: Chat[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.numbers).toEqual({ [project]: 4 });
    expect(onDisk.chats).toEqual(afterChanges.chats.map(recordOf));

    // 4 and 5 need the agents' terminals and their own tokens, as their hooks have them.
    const agentList = () => page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Array<{ id: string; cliRunning?: boolean }>> } } }).electronAPI.agent.list());
    for (const id of ['o1', 'w1']) {
      await page.evaluate((id) => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id, prompt: '' }), id);
      await expect.poll(async () => (await agentList()).find(a => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    }
    // Lead's terminal is up: Main's runner is live, and it is the one chat working.
    const limitLive = await chatLimit();
    const mainLive = (await list(page)).chats.find(c => c.number === 1);
    keep({ limitLive, mainLive });
    expect(limitLive).toMatchObject({ limit: 3, working: 1 });
    expect(mainLive?.runner).toMatchObject({ id: 'o1', live: true });
    const tokens = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const out: Record<string, string> = {};
      for (const id of ['o1', 'w1']) {
        agents.get(id).sessionRegisteredAt = new Date().toISOString();
        out[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
      }
      return out;
    }, { dist });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Answer }));

    // 4. Lead's new session, registered as its SessionStart hook does.
    const registered = await api('/api/hooks/status', 'o1', { agent_id: 'o1', session_id: SESSION_B, status: 'idle', source: 'startup' });
    await expect.poll(async () => (await list(page)).chats.find(c => c.number === 1)?.sessionIds, { timeout: 10_000 }).toEqual([SESSION_A, SESSION_B]);
    keep({ registered, sessionsAfterRegistration: (await list(page)).chats.find(c => c.number === 1)?.sessionIds });

    // 5. Lead asks the worker, busy with a turn of its own: a request out, and Main cannot go.
    const workerHook = (body: Record<string, unknown>) => api('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: SESSION_W, ...body });
    await workerHook({ status: 'idle', source: 'startup' });
    await workerHook({ status: 'running', event: 'UserPromptSubmit', current_task: 'something JeanBrasse asked earlier' });
    const asked = await api('/api/agents/w1/message', 'o1', { message: 'TASK-A review #280' });
    expect(asked.status).toBe(200);
    const queue = () => app.evaluate((_e, { dist }) => {
      const w = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1');
      return (w.taskQueue ?? []).map((r: { ref: string; requesterAgentId: string; state: string }) => ({ ref: r.ref, requesterAgentId: r.requesterAgentId, state: r.state }));
    }, { dist });
    await expect.poll(async () => (await queue()).filter((r: { requesterAgentId: string }) => r.requesterAgentId === 'o1').length, { timeout: 20_000 }).toBe(1);
    const out = (await queue()).find((r: { requesterAgentId: string }) => r.requesterAgentId === 'o1')!;
    const hasWork = await chat(page, 'delete', { chatId: main.id });
    keep({ asked, workerQueue: await queue(), hasWork });
    expect(hasWork).toMatchObject({ error: 'chat_has_work', tasks: [{ workerId: 'w1', workerName: 'Worker', ref: out.ref, state: out.state }] });
    expect(typeof hasWork.reason).toBe('string');
    expect((await list(page)).chats.some(c => c.id === main.id)).toBe(true);

    finalRun1 = (await list(page)).chats;
    keep({ finalRun1 });
  } finally {
    await app.close();
  }
  const shaAtQuit = sha();
  fs.copyFileSync(chatsFile, test.info().outputPath('chats-run1.json'));
  keep({ shaAtQuit });

  // ---- 6. Second run: the same chats, and the file untouched.
  ({ app, page } = await launch());
  try {
    const again = await list(page);
    const shaAfterRelaunch = sha();
    keep({ relaunch: again, shaAfterRelaunch });
    expect(again.problem).toBeNull();
    expect(again.chats.map(recordOf)).toEqual(finalRun1.map(recordOf));
    expect(again.chats.filter(c => c.number === 1)).toHaveLength(1);
    expect(shaAfterRelaunch).toBe(shaAtQuit);
    // And a while later, once every watch of the launch has run.
    await page.waitForTimeout(3_000);
    await list(page);
    const shaLater = sha();
    keep({ shaLater });
    expect(shaLater).toBe(shaAtQuit);
  } finally {
    await app.close();
  }
  fs.copyFileSync(chatsFile, test.info().outputPath('chats-run2.json'));
});
