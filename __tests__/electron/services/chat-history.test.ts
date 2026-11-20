/**
 * Reading and following a chat's transcripts (electron/services/chat-history.ts),
 * from the Audit's gate of #371 (2026-10-13).
 *
 * Measured there: the follower re-read and re-parsed a live chat's whole
 * transcripts, synchronously, every second while they changed, from launch,
 * for every orchestrator's Main, whether a window asked or not. A 159 MB
 * transcript cost 2.35 s to read and 2.34 s to parse (339 MB of heap): the
 * main thread, so the API, the hooks' posts and the terminals, waited that
 * long every second.
 *
 * How it fails, written before the code:
 *  1. A tick reads a transcript whole when it grew: its cost follows the
 *     file, not what was appended.
 *  2. A line split across two reads (a write landing mid-line, a character of
 *     several bytes cut at a read's end) is lost, doubled or garbled.
 *  3. A file that shrank, or was replaced by another, is not read again from
 *     its start: the old file's items stay, or the new file is read from the
 *     old offset.
 *  4. The first read of a large transcript holds the main thread from its
 *     first byte to its last: nothing else runs until it is parsed.
 *  5. A chat no window asked chat:history for is read at every tick.
 *  6. With the new interface off (no window shows chats), anything is read
 *     or sent.
 *  7. (M1) A session whose transcript does not exist yet (Claude Code writes
 *     it lazily) reads as "gone"; once written, the items shift and the
 *     follower, counting by position, never sends one of them.
 *  8. (L1) The runner's session ids, taken from agents.json unchecked, put
 *     another path into the file read: `../../x` reads ~/.claude/x.jsonl.
 *  9. Two ticks at once (a slow read) send an item twice.
 * 10. A session in the middle whose transcript is gone no longer says so.
 * 11. (The Audit's Y1 on #371's delta) An item that lands before the last one
 *     told (an earlier session's file that gains a line) is never sent by a
 *     follower that counts by position.
 * 12. (GATE-PR371-DELTA2, Info) That late item moves every item after it one
 *     place on: told at n=1, the later session's line is now n=2, with no
 *     event, and a window that places items by n puts the late one after them
 *     until its next snapshot. An item whose n changed is sent again (the
 *     same id: it replaces the one the window holds).
 * 13. (2.0.0 follow-up, found by the Frontend) A session's transcript that
 *     disappears between two ticks (Claude Code's cleanupPeriodDays, a user's
 *     delete) is replaced by its "gone" line, and the lines after it move back
 *     and are sent again, but the vanished items are never declared gone: a
 *     window keeps them, mixed with the moved ones, until it reads again. Or
 *     they are declared at every tick, or one still there is declared, or
 *     after the items that moved back (GATE-PR371-DELTA4, L1).
 * 14. (GATE-PR371-DELTA4 and DELTA5, Info) Main follows a change of
 *     orchestrator; a session the former one ran in a worktree of its own was
 *     looked for under the new runner's folders and the project's only, and
 *     read as gone while its file was there, its items declared removed. Its
 *     folder is recorded with it (chats.ts, sessionFolders): it stays
 *     readable, in a fresh read and live, and nothing of it is removed.
 * 16. (GATE-PR391-DELTA2, probe PC) A spelling kept unchecked while a linked
 *     project's target is away (chats.json is agents' to write) is read: a
 *     folder outside the project, holding another project's transcript, shows
 *     in the chat while the target is away, and for the rest of the run after
 *     it comes back. A recorded spelling is read only when the project's real
 *     path reads and the spelling is inside the project.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sent: Array<{ seq: number; type: string; chatId: string; item?: { id: string; n: number; text: string }; itemIds?: string[] }> = [];
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (_channel: string, payload: never) => { sent.push(payload); },
}));

import { readTranscript, readChatItems, followChats, noteChatSnapshot, resetChatHistory } from '../../../electron/services/chat-history';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';
import type { Chat } from '../../../electron/services/chats';
import type { AgentStatus } from '../../../electron/types';

let home: string;
let project: string;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const S = (k: string) => `${k.repeat(8)}-${k.repeat(4)}-4${k.repeat(3)}-8${k.repeat(3)}-${k.repeat(12)}`;
const userLine = (text: string) => JSON.stringify({ type: 'user', uuid: uuid(), timestamp: '2026-10-13T08:00:00.000Z', message: { role: 'user', content: text } }) + '\n';
const fileOf = (sessionId: string) => path.join(home, '.claude', 'projects', encodeProjectDirName(project), `${sessionId}.jsonl`);
const write = (sessionId: string, text: string) => { fs.mkdirSync(path.dirname(fileOf(sessionId)), { recursive: true }); fs.writeFileSync(fileOf(sessionId), text); };
const append = (sessionId: string, text: string) => fs.appendFileSync(fileOf(sessionId), text);
const chatOf = (over: Partial<Chat> = {}): Chat => ({
  id: 'c1', projectPath: project, number: 1, title: 'Main', titleSource: 'user', runnerId: 'orch', sessionIds: [S('a')], pinned: false,
  snoozedUntil: null, settledAt: null, inbox: true, createdAt: '2026-10-13T08:00:00.000Z', updatedAt: '2026-10-13T08:00:00.000Z',
  ...over,
} as Chat);
const runnerOf = (over: Partial<AgentStatus> = {}) => ({ id: 'orch', status: 'running', ...over }) as AgentStatus;
const texts = (items: Array<{ text: string }>) => items.map((i) => i.text);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-chat-history-'));
  project = path.join(home, 'proj');
  fs.mkdirSync(project);
  sent.length = 0;
  resetChatHistory();
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('one transcript, read as it grows', () => {
  it('1. reads only what was appended, however large the file', async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => userLine(`line ${i} ${'x'.repeat(900)}`)).join('');
    write(S('a'), big);
    const first = { bytes: 0, slices: 0 };
    const t0 = performance.now();
    expect((await readTranscript(fileOf(S('a')), S('a'), { stats: first }))!.length).toBe(20_000);
    const firstMs = performance.now() - t0;
    const added = userLine('one more') + userLine('and another');
    append(S('a'), added);
    const next = { bytes: 0, slices: 0 };
    const t1 = performance.now();
    const items = (await readTranscript(fileOf(S('a')), S('a'), { stats: next }))!;
    const nextMs = performance.now() - t1;
    expect(first.bytes).toBe(Buffer.byteLength(big));
    expect(next.bytes, 'the second read reads what was appended').toBe(Buffer.byteLength(added));
    expect(texts(items.slice(-2))).toEqual(['one more', 'and another']);
    // The bench, for the run log: a tick costs what was appended.
    console.log(`[bench] first read ${(first.bytes / 1e6).toFixed(1)} MB in ${firstMs.toFixed(0)} ms; next ${next.bytes} B in ${nextMs.toFixed(1)} ms`);
    // Unchanged: nothing read.
    const none = { bytes: 0, slices: 0 };
    await readTranscript(fileOf(S('a')), S('a'), { stats: none });
    expect(none.bytes).toBe(0);
  }, 60_000);

  it('2. keeps a line written in two halves, and characters cut at a read\'s end', async () => {
    const line = userLine('déjà vu 🎉 ünïcödé');
    write(S('a'), line.slice(0, 25));
    expect(await readTranscript(fileOf(S('a')), S('a'))).toEqual([]);
    append(S('a'), line.slice(25));
    // A read of 7 bytes at a time cuts the accents and the emoji in two.
    const items = (await readTranscript(fileOf(S('a')), S('a'), { chunkBytes: 7 }))!;
    expect(texts(items)).toEqual(['déjà vu 🎉 ünïcödé']);
    const again = await readTranscript(fileOf(S('a')), S('a'), { chunkBytes: 7 });
    expect(texts(again!)).toEqual(['déjà vu 🎉 ünïcödé']);
  });

  it('3. reads a file that shrank, or was replaced, from its start', async () => {
    write(S('a'), userLine('one') + userLine('two') + userLine('three'));
    expect(texts((await readTranscript(fileOf(S('a')), S('a')))!)).toEqual(['one', 'two', 'three']);
    fs.truncateSync(fileOf(S('a')), 0);
    append(S('a'), userLine('fresh'));
    expect(texts((await readTranscript(fileOf(S('a')), S('a')))!)).toEqual(['fresh']);
    const other = `${fileOf(S('a'))}.new`;
    fs.writeFileSync(other, userLine('replaced') + userLine('by') + userLine('another file'));
    fs.renameSync(other, fileOf(S('a')));
    expect(texts((await readTranscript(fileOf(S('a')), S('a')))!)).toEqual(['replaced', 'by', 'another file']);
  });

  it('4. lets the main thread run while a large transcript is read the first time', async () => {
    write(S('a'), Array.from({ length: 4_000 }, (_, i) => userLine(`line ${i} ${'y'.repeat(200)}`)).join(''));
    let ran = 0;
    let on = true;
    const ticker = () => { ran += 1; if (on) setImmediate(ticker); };
    setImmediate(ticker);
    const stats = { bytes: 0, slices: 0 };
    await readTranscript(fileOf(S('a')), S('a'), { chunkBytes: 64 * 1024, stats });
    on = false;
    expect(stats.slices).toBeGreaterThan(10);
    expect(ran, 'other work ran between the slices').toBeGreaterThanOrEqual(stats.slices - 1);
  });

  it('says null for a file that does not exist', async () => {
    expect(await readTranscript(fileOf(S('z')), S('z'))).toBeNull();
  });
});

describe('a chat, followed', () => {
  const follow = (over: { enabled?: () => boolean; chats?: Chat[]; runner?: AgentStatus } = {}) => {
    const chats = over.chats ?? [chatOf()];
    const runner = over.runner ?? runnerOf();
    return followChats({
      chats: () => chats, runnerOf: () => runner, isLive: () => true, nameOf: () => undefined, homeDir: home,
      enabled: over.enabled ?? (() => true), everyMs: 3_600_000,
    });
  };
  const itemsSent = () => sent.filter((e) => e.type === 'item').map((e) => e.item!.text);

  it('5. reads no chat a window has not asked for', async () => {
    write(S('a'), userLine('hello'));
    const spy = vi.spyOn(fs.promises, 'open');
    const f = follow();
    await f.tick();
    append(S('a'), userLine('more'));
    await f.tick();
    f.stop();
    expect(spy).not.toHaveBeenCalled();
    expect(itemsSent()).toEqual([]);
    spy.mockRestore();
  });

  it('6. reads and sends nothing while the new interface is off', async () => {
    write(S('a'), userLine('hello'));
    const chat = chatOf();
    noteChatSnapshot(chat.id, await readChatItems(chat, { runner: runnerOf(), homeDir: home }));
    const spy = vi.spyOn(fs.promises, 'open');
    let on = false;
    const f = follow({ enabled: () => on, chats: [chat] });
    append(S('a'), userLine('while off'));
    await f.tick();
    expect(spy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    on = true;
    await f.tick();
    f.stop();
    expect(itemsSent()).toEqual(['while off']);
    spy.mockRestore();
  });

  it('7. sends every item of a session whose transcript is written after the snapshot', async () => {
    write(S('a'), userLine('hello'));
    const chat = chatOf();
    const runner = runnerOf({ currentSessionId: S('b'), resumableSessionId: S('b') });
    const snapshot = await readChatItems(chat, { runner, homeDir: home });
    expect(texts(snapshot)).toEqual(['hello', 'session']);
    noteChatSnapshot(chat.id, snapshot);
    write(S('b'), userLine('first of B') + userLine('second of B'));
    const f = follow({ chats: [chat], runner });
    await f.tick();
    f.stop();
    expect(itemsSent()).toEqual(['first of B', 'second of B']);
  });

  it('8. never reads a runner\'s session id that is not one', async () => {
    write(S('a'), userLine('hello'));
    const outside = path.join(home, '.claude', 'x.jsonl');
    fs.writeFileSync(outside, userLine('SECRET'));
    const items = await readChatItems(chatOf(), { runner: runnerOf({ resumableSessionId: '../../x', currentSessionId: '../../x' }), homeDir: home });
    expect(texts(items)).toEqual(['hello']);
  });

  it('9. sends an item once when two ticks run at once', async () => {
    write(S('a'), userLine('hello'));
    const chat = chatOf();
    noteChatSnapshot(chat.id, await readChatItems(chat, { runner: runnerOf(), homeDir: home }));
    append(S('a'), userLine('once'));
    const f = follow({ chats: [chat] });
    await Promise.all([f.tick(), f.tick()]);
    f.stop();
    expect(itemsSent()).toEqual(['once']);
  });

  it('11. sends an item that lands before the last one told', async () => {
    write(S('a'), userLine('hello'));
    write(S('b'), userLine('in b'));
    const chat = chatOf({ sessionIds: [S('a'), S('b')] });
    const runner = runnerOf({ currentSessionId: S('b') });
    noteChatSnapshot(chat.id, await readChatItems(chat, { runner, homeDir: home }));
    append(S('a'), userLine('late in a'));
    const f = follow({ chats: [chat], runner });
    await f.tick();
    f.stop();
    // The late item, then the two it moved one place on, sent again (12).
    expect(itemsSent()).toEqual(['late in a', 'session', 'in b']);
  });

  it('12. sends again, with its new place, an item a late one moved on', async () => {
    write(S('a'), userLine('hello'));
    write(S('b'), userLine('in b'));
    const chat = chatOf({ sessionIds: [S('a'), S('b')] });
    const runner = runnerOf({ currentSessionId: S('b') });
    const snapshot = await readChatItems(chat, { runner, homeDir: home });
    const inB = snapshot.find((i) => i.text === 'in b')!;
    noteChatSnapshot(chat.id, snapshot);
    append(S('a'), userLine('late in a'));
    const f = follow({ chats: [chat], runner });
    await f.tick();
    f.stop();
    const items = sent.filter((e) => e.type === 'item').map((e) => e.item!);
    const late = items.find((i) => i.text === 'late in a')!;
    const moved = items.filter((i) => i.id === inB.id);
    // hello 0, late in a 1, the divider 2, in b 3 (it was 2).
    expect(inB.n).toBe(2);
    expect(late.n).toBe(1);
    expect(moved.map((i) => i.n), 'the later items, sent again where they now are').toEqual([3]);
    // A second tick sends nothing: what moved was told.
    sent.length = 0;
    const g = follow({ chats: [chat], runner });
    await g.tick();
    g.stop();
    expect(sent.filter((e) => e.type === 'item')).toEqual([]);
  });

  it('13. declares the items of a transcript that disappeared, once, and sends its "gone" line', async () => {
    write(S('a'), userLine('hello'));
    write(S('b'), userLine('in b 1') + userLine('in b 2'));
    write(S('c'), userLine('later'));
    const chat = chatOf({ sessionIds: [S('a'), S('b'), S('c')] });
    const runner = runnerOf({ currentSessionId: S('c') });
    const snapshot = await readChatItems(chat, { runner, homeDir: home });
    const vanished = snapshot.filter((i) => i.text.startsWith('in b')).map((i) => i.id);
    expect(vanished).toHaveLength(2);
    noteChatSnapshot(chat.id, snapshot);
    fs.rmSync(fileOf(S('b')));
    const f = follow({ chats: [chat], runner });
    await f.tick();
    f.stop();
    const removed = sent.filter((e) => e.type === 'removed');
    expect(removed.map((e) => [...e.itemIds!].sort())).toEqual([[...vanished].sort()]);
    expect(removed[0].chatId).toBe(chat.id);
    expect(itemsSent()).toContain(`session ${S('b')}: its transcript is gone`);
    // Before the items that moved back are sent again: a window that placed them
    // first would hold the vanished ones among them until the event came (W4).
    const removedAt = sent.findIndex((e) => e.type === 'removed');
    const movedAt = sent.findIndex((e) => e.type === 'item' && e.item!.text === 'later');
    expect(movedAt, '"later" moved back a place and was sent again').toBeGreaterThan(-1);
    expect(removedAt).toBeLessThan(movedAt);
    // Declared once: the next tick says nothing more.
    sent.length = 0;
    const g = follow({ chats: [chat], runner });
    await g.tick();
    g.stop();
    expect(sent).toEqual([]);
  });

  it("14. after a change of orchestrator, the former one's session stays readable where it ran", async () => {
    // Where Tars makes an agent's worktree: inside its project.
    const worktree = path.join(project, '.worktrees', 'old-lead');
    fs.mkdirSync(worktree, { recursive: true });
    const inWorktree = path.join(home, '.claude', 'projects', encodeProjectDirName(worktree), `${S('a')}.jsonl`);
    fs.mkdirSync(path.dirname(inWorktree), { recursive: true });
    fs.writeFileSync(inWorktree, userLine('ran in the old lead\'s worktree'));
    write(S('b'), userLine('the new lead'));
    const chat = chatOf({ sessionIds: [S('a'), S('b')], sessionFolders: { [S('a')]: [worktree] } });
    const before = await readChatItems(chat, { runner: runnerOf({ id: 'old', worktreePath: worktree, currentSessionId: S('a') }), homeDir: home });
    expect(texts(before)).toContain("ran in the old lead's worktree");
    noteChatSnapshot(chat.id, before);
    const newLead = runnerOf({ id: 'new', currentSessionId: S('b') });
    const f = follow({ chats: [chat], runner: newLead });
    await f.tick();
    f.stop();
    const fresh = await readChatItems(chat, { runner: newLead, homeDir: home });
    expect(texts(fresh)).toContain("ran in the old lead's worktree");
    expect(texts(fresh)).not.toContain(`session ${S('a')}: its transcript is gone`);
    expect(sent.filter((e) => e.type === 'removed')).toEqual([]);
  });

  it('15. reads a session from the real spelling recorded for it, its folder gone (GATE-PR391, L2)', async () => {
    const real = path.join(fs.realpathSync(project), '.worktrees', 'old-lead');
    const link = path.join(project, '.worktrees', 'old-lead');
    // As Claude Code files it: under the real path of where its CLI ran.
    const filed = path.join(home, '.claude', 'projects', encodeProjectDirName(real), `${S('a')}.jsonl`);
    fs.mkdirSync(path.dirname(filed), { recursive: true });
    fs.writeFileSync(filed, userLine('filed under the real path'));
    write(S('b'), userLine('the new lead'));
    // Neither folder exists any more: no spelling can be found from the link.
    const chat = chatOf({ sessionIds: [S('a'), S('b')], sessionFolders: { [S('a')]: [link, real] } });
    const items = await readChatItems(chat, { runner: runnerOf({ id: 'new', currentSessionId: S('b') }), homeDir: home });
    expect(texts(items)).toContain('filed under the real path');
  });

  it('16. never reads a recorded spelling outside the project, the target away or back', async () => {
    const real = path.join(home, 'real-project');
    fs.mkdirSync(real);
    const link = path.join(home, 'linked-project');
    fs.symlinkSync(real, link);
    // Another project's session, filed where Claude Code files it.
    const elsewhere = path.join(home, 'other-project');
    const theirs = path.join(home, '.claude', 'projects', encodeProjectDirName(elsewhere), `${S('a')}.jsonl`);
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, userLine('another project\'s words'));
    const mine = path.join(home, '.claude', 'projects', encodeProjectDirName(fs.realpathSync(real)), `${S('b')}.jsonl`);
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, userLine('the new lead'));
    const chat = chatOf({ projectPath: link, sessionIds: [S('a'), S('b')], sessionFolders: { [S('a')]: [elsewhere] } });
    const read = async () => texts(await readChatItems(chat, { runner: runnerOf({ id: 'new', currentSessionId: S('b') }), homeDir: home }));
    const away = path.join(home, 'real-project-away');
    fs.renameSync(real, away);
    expect(await read()).not.toContain("another project's words");
    fs.renameSync(away, real);
    expect(await read()).not.toContain("another project's words");
  });

  it('10. says so for a session in the middle whose transcript is gone', async () => {
    write(S('a'), userLine('hello'));
    write(S('c'), userLine('later'));
    const items = await readChatItems(chatOf({ sessionIds: [S('a'), S('b'), S('c')] }), { runner: runnerOf({ currentSessionId: S('c') }), homeDir: home });
    expect(texts(items)).toEqual(['hello', 'session', `session ${S('b')}: its transcript is gone`, 'session', 'later']);
  });
});
