import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The renderer contract of a chat's conversation (ORCHESTRATOR-PER-CHAT.md v2.2,
 * 4.5; PR E, its main-process half), in the real app.
 *
 * A project's orchestrator ("Lead") is chat 1, Main. Its two sessions are
 * written in the sandbox's ~/.claude/projects as Claude Code writes them: the
 * second, a resume, starts with the history of the first. Lead and a worker
 * run stand-in CLIs that record what they are sent.
 *
 * Asserted:
 * 1. chat:history reads Main across both sessions, oldest first, the copied
 *    history once, a divider at the second session, a compaction as a
 *    divider, tool calls folded with the worker's name, Tars's note said to
 *    be from Tars, and answers the seq it is a snapshot at;
 * 2. `before` and `limit` page backwards through it;
 * 3. a line the live runner's transcript gains arrives as a chat:events
 *    `item`, its seq after the snapshot's;
 * 4. a rename arrives as a `meta` event, its seq after the item's;
 * 5. agent:queue answers a worker's work in hand and its queue, and a request
 *    sent to it arrives as an `agent:queue` event;
 * 6. (2.0.0 follow-up) a session's transcript that disappears (Claude Code's
 *    cleanup, a delete) has the items the window was told of declared in one
 *    `removed` event: that session's own, none of the other's.
 * And, in a second test (GATE-PR371-DELTA5, Info): the project's orchestrator
 * ran its session in a worktree of its own; the role moves to another agent,
 * and Main follows it. The former one's session stays readable in Main, found
 * in the folder recorded with it, where it read as gone.
 * The artefact: values.json with every answer and every event.
 */

const S1 = 'e2e00000-0000-4000-8000-00000000c001';
const S2 = 'e2e00000-0000-4000-8000-00000000c002';
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => unknown>> };

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 12, 10, 0, n)).toISOString();
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (sessionId: string, text: string) => ({ type: 'user', uuid: uuid(), timestamp: at(), sessionId, version: '2.1.296', message: { role: 'user', content: text } });
const said = (sessionId: string, content: unknown[]) => ({ type: 'assistant', uuid: uuid(), timestamp: at(), sessionId, version: '2.1.296', message: { role: 'assistant', content } });
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

test("a chat's conversation is read across its sessions, then followed live, and a worker's queue is read", async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-chat-history-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const cliFor = (id: string) => {
    const cli = path.join(home, `${id}-cli.cjs`);
    fs.writeFileSync(cli, [
      `#!${process.execPath}`,
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(path.join(home, `${id}.received`))}, d));`,
      "process.stdout.write('stand-in ready\\n');",
      '',
    ].join('\n'), { mode: 0o755 });
    return cli;
  };
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [], cliPath: cliFor(id),
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Lead', { role: 'orchestrator', orchestratorMode: true, resumableSessionId: S1 }), agent('w1', 'Worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface: true }));

  // The two sessions, where Claude Code files them: under the project's real path.
  const transcripts = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const first = [
    user(S1, 'ship the receipts'),
    said(S1, [{ type: 'text', text: 'Handing it to the worker.' }, { type: 'tool_use', id: 't1', name: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'w1', prompt: 'build it\n'.repeat(50) } }]),
    { type: 'user', uuid: uuid(), sessionId: S1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT-NOT-SHOWN' }] }, toolUseResult: {} },
    user(S1, 'Message from Tars: [Tars] "Worker" ("w1") has finished its turn'),
  ];
  fs.writeFileSync(path.join(transcripts, `${S1}.jsonl`), jsonl(first));
  const second = [
    ...first.map((l) => ({ ...l, sessionId: S2 })),
    { type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: at(), sessionId: S2, compactMetadata: { trigger: 'auto' } },
    user(S2, 'now the docs'),
  ];
  const s2File = path.join(transcripts, `${S2}.jsonl`);
  fs.writeFileSync(s2File, jsonl(second));

  const port = apiPort(31452);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  let heardSoFar: () => Promise<unknown> = async () => null;
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const call = (group: string, name: string, arg?: unknown) => page.evaluate(([g, c, a]) =>
      (window as unknown as Api).electronAPI[g as string][c as string](a), [group, name, arg] as const) as Promise<Record<string, unknown>>;
    // Every chat:events and agent:queue event the window hears, in order.
    await page.evaluate(() => {
      const w = window as unknown as Api & { __heard: unknown[] };
      w.__heard = [];
      w.electronAPI.chat.onEvent((e: unknown) => w.__heard.push({ channel: 'chat:events', ...(e as object) }));
      w.electronAPI.agent.onQueue((e: unknown) => w.__heard.push({ channel: 'agent:queue', ...(e as object) }));
    });
    const heard = () => page.evaluate(() => (window as unknown as { __heard: Array<Record<string, unknown>> }).__heard);
    heardSoFar = heard;

    // The second session, registered as hooks-routes would: Main mirrors it.
    await app.evaluate((_e, { dist, S2 }) => {
      const req = process.mainModule!.require;
      const lead = req(`${dist}/core/agent-manager.js`).agents.get('lead');
      lead.resumableSessionId = S2;
      req(`${dist}/services/agent-events.js`).agentStatusEmitter.emit('fleet-change', 'lead');
    }, { dist, S2 });
    const listing = await call('chat', 'list') as { seq: number; chats: Array<{ id: string; number: number; sessionIds: string[] }> };
    const main = listing.chats.find((c) => c.number === 1)!;
    values.main = main;
    expect(main.sessionIds).toEqual([S1, S2]);

    // 1. The history, both sessions.
    const history = await call('chat', 'history', { chatId: main.id }) as { seq: number; total: number; items: Array<{ id: string; n: number; kind: string; text: string; from?: string; sessionId: string }> };
    values.history = history;
    expect(history.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'ship the receipts'],
      ['text', 'Handing it to the worker.'],
      ['tool', 'delegate_task -> Worker'],
      ['note', '[Tars] "Worker" ("w1") has finished its turn'],
      ['divider', 'session'],
      ['divider', 'compacted'],
      ['user', 'now the docs'],
    ]);
    expect(JSON.stringify(history)).not.toContain('TOOL-OUTPUT-NOT-SHOWN');
    expect(history.items.map((i) => i.n)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(history.total).toBe(7);
    expect(typeof history.seq).toBe('number');

    // 2. Paged backwards.
    const page1 = await call('chat', 'history', { chatId: main.id, limit: 3 }) as { items: Array<{ n: number }> };
    const page2 = await call('chat', 'history', { chatId: main.id, before: 4, limit: 3 }) as { items: Array<{ n: number }> };
    values.pages = { page1, page2 };
    expect(page1.items.map((i) => i.n)).toEqual([4, 5, 6]);
    expect(page2.items.map((i) => i.n)).toEqual([1, 2, 3]);

    // 3. Followed live. The line lands before Lead's CLI is first seen live,
    // after the window's snapshot: it is still sent (a race the full suite
    // lost under load when the follower counted from its first live sight).
    fs.appendFileSync(s2File, jsonl([said(S2, [{ type: 'text', text: 'Docs updated.' }])]));
    await call('agent', 'start', { id: 'lead', prompt: '' });
    await expect.poll(async () => ((await call('agent', 'list')) as unknown as Array<{ id: string; cliRunning?: boolean }>).find((a) => a.id === 'lead')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await heard()).some((e) => e.channel === 'chat:events' && e.type === 'item'), { timeout: 15_000 }).toBe(true);
    const item = (await heard()).find((e) => e.channel === 'chat:events' && e.type === 'item') as { seq: number; chatId: string; item: { id: string; kind: string; text: string; n: number } };
    values.itemEvent = item;
    expect(item.chatId).toBe(main.id);
    expect(item.item).toMatchObject({ kind: 'text', text: 'Docs updated.', n: 7 });
    expect(item.seq).toBeGreaterThan(history.seq);

    // 4. A rename, after it.
    await call('chat', 'rename', { chatId: main.id, title: 'Release' });
    // The rename's own event: the session mirror tells its own before it.
    const renamed = (e: Record<string, unknown>) => e.channel === 'chat:events' && e.type === 'meta' && (e.chat as { title?: string } | undefined)?.title === 'Release';
    await expect.poll(async () => (await heard()).some(renamed), { timeout: 10_000 }).toBe(true);
    const meta = (await heard()).find(renamed) as unknown as { seq: number; chatId: string; chat: { title: string } };
    values.metaEvent = meta;
    expect(meta.chatId).toBe(main.id);
    expect(meta.chat.title).toBe('Release');
    expect(meta.seq).toBeGreaterThan(item.seq);
    // chat:list is a snapshot on the same counter: at or after the rename's event.
    const relisted = await call('chat', 'list') as { seq: number };
    values.relistedSeq = relisted.seq;
    expect(relisted.seq).toBeGreaterThanOrEqual(meta.seq);

    // 6. The second session's transcript disappears: what the window holds of it
    // is declared removed, at once and once; nothing of the first session.
    fs.rmSync(s2File);
    const removedOf = (e: Record<string, unknown>) => e.channel === 'chat:events' && e.type === 'removed' && e.chatId === main.id;
    await expect.poll(async () => (await heard()).some(removedOf), { timeout: 15_000 }).toBe(true);
    const removed = (await heard()).filter(removedOf) as unknown as Array<{ seq: number; itemIds: string[] }>;
    values.removed = removed;
    const ofS2 = [history.items.find((i) => i.text === 'now the docs')!.id, item.item.id];
    const ofS1 = history.items.filter((i) => i.n < 4).map((i) => i.id);
    expect(removed).toHaveLength(1);
    expect(removed[0].itemIds).toEqual(expect.arrayContaining(ofS2));
    expect(removed[0].itemIds.filter((id) => ofS1.includes(id))).toEqual([]);
    expect(removed[0].seq).toBeGreaterThan(meta.seq);

    // 5. A worker's queue: a request from Lead, read and heard.
    const token = await app.evaluate((_e, { dist }) => process.mainModule!.require(`${dist}/core/agent-tokens.js`).mintAgentToken('lead'), { dist });
    await app.evaluate((_e, { dist }) => {
      const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('lead');
      a.sessionRegisteredAt = new Date().toISOString(); a.status = 'idle';
    }, { dist });
    const sent = await fetch(`http://127.0.0.1:${port}/api/agents/w1/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': 'lead' },
      body: JSON.stringify({ message: 'QUEUE-ME write the notes' }), signal: AbortSignal.timeout(60_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    values.sent = sent;
    const queue = await call('agent', 'queue', 'w1') as { agentId: string; current: { requesterAgentId: string; requesterName: string } | null; queue: Array<{ requesterAgentId: string }> };
    values.queue = queue;
    expect(queue.agentId).toBe('w1');
    expect([queue.current, ...queue.queue].filter(Boolean).map((r) => r!.requesterAgentId)).toEqual(['lead']);
    await expect.poll(async () => (await heard()).some((e) => e.channel === 'agent:queue' && e.agentId === 'w1'), { timeout: 10_000 }).toBe(true);
  } finally {
    values.heard = await heardSoFar().catch(() => null);
    recordValues(values);
    await app.close();
    await removeHome(home);
  }
});

test("Main reads a former orchestrator's session where it ran, after the role moves", async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-chat-folder-'));
  const project = path.join(home, 'projects', 'demo');
  const worktree = path.join(project, '.worktrees', 'old-lead');
  const dir = path.join(home, '.tars');
  for (const d of [worktree, dir]) fs.mkdirSync(d, { recursive: true });
  const SOLD = 'e2e00000-0000-4000-8000-00000000f001';
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('old', 'Old lead', { role: 'orchestrator', orchestratorMode: true, worktreePath: worktree, branchName: 'old-lead', resumableSessionId: SOLD }),
    agent('new', 'New lead'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface: true }));
  // The old lead's session, where Claude Code files it: under its worktree's real path.
  const transcripts = path.join(home, '.claude', 'projects', fs.realpathSync(worktree).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, `${SOLD}.jsonl`), jsonl([user(SOLD, 'planned in the old worktree')]));

  const values: Record<string, unknown> = {};
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31442), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const call = (group: string, name: string, arg?: unknown) => page.evaluate(([g, c, a]) =>
      (window as unknown as Api).electronAPI[g as string][c as string](a), [group, name, arg] as const) as Promise<Record<string, unknown>>;
    const mainOf = async () => ((await call('chat', 'list')) as unknown as { chats: Array<{ id: string; number: number; runnerId: string; sessionIds: string[] }> }).chats.find((c) => c.number === 1)!;
    const texts = async (chatId: string) => ((await call('chat', 'history', { chatId })) as unknown as { items: Array<{ text: string }> }).items.map((i) => i.text);

    const before = await mainOf();
    values.before = { main: before, texts: await texts(before.id) };
    expect(before).toMatchObject({ runnerId: 'old', sessionIds: [SOLD] });
    expect(await texts(before.id)).toContain('planned in the old worktree');

    // The role moves: Main follows the new orchestrator.
    expect(await call('agent', 'update', { id: 'new', role: 'orchestrator' })).toMatchObject({ success: true });
    await expect.poll(async () => (await mainOf()).runnerId, { timeout: 15_000 }).toBe('new');
    const after = await mainOf();
    const read = await texts(after.id);
    values.after = { main: after, texts: read };
    expect(read).toContain('planned in the old worktree');
    expect(read.join('\n')).not.toContain('its transcript is gone');
  } finally {
    recordValues(values);
    await app.close();
    await removeHome(home);
  }
});

