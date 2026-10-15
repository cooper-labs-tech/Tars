/**
 * A chat's conversation, read from its runner's transcripts (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.5 and row E): electron/services/chat-transcript.ts. One parser, the
 * transcripts being the source of truth.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A user's message, the runner's text or one of its tool calls is missing,
 *    or comes out of the order the transcript has.
 * 2. What is not conversation is shown as if it were: a tool's output, the
 *    runner's thinking, a meta or compaction-summary user line, and the lines
 *    Claude Code keeps for itself (attachments, mode, title, hooks' output,
 *    file history, costs).
 * 3. A message typed in during a turn, which Claude Code files as a
 *    `queued_command` attachment, is lost with the other attachments.
 * 4. A line of a type Tars does not know (a newer Claude Code) is dropped,
 *    where it must be shown as one raw line; a damaged line in the middle
 *    stops the reading, or is dropped.
 * 5. The last line, half written while the CLI appends it, is shown as a
 *    damaged line.
 * 6. A compaction shows as nothing, or as a new chat: one thin divider.
 * 7. Across a chat's sessions: a later session's items come before an earlier
 *    one's; the history a resumed or forked session copies is shown twice; no
 *    divider marks where a session starts; a session whose file is gone loses
 *    the others.
 * 8. A tool call takes more than one line, or carries its whole input.
 * 9. The lines Tars typed are read as the user's own words: a note from Tars,
 *    or a message from another agent or a channel, must say who it is from.
 * 10. An item's id is not its line's uuid, so the window cannot tell an item
 *     it already shows from a new one.
 * 11. The transcripts of 2.1.280, 2.1.289 and 2.1.296 (real lines, their
 *     words replaced) give a raw item: a shape those versions write is unknown.
 * 12. Claude Code's own user lines are read as the user's words: a background
 *     task's report (`<task-notification>`, typed or queued) is Claude Code's
 *     note, a slash command is the command typed, and a command's output
 *     (`<local-command-stdout>`) is folded like a tool's.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { transcriptItems, chatItems, type ChatItem } from '../../../electron/services/chat-transcript';

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'transcripts');
const fixture = (version: string) => fs.readFileSync(path.join(FIXTURES, `claude-${version}.jsonl`), 'utf8');

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();
const user = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', uuid: uuid(), timestamp: at(n), sessionId: 's1', version: '2.1.296', message: { role: 'user', content: text }, ...extra });
const assistant = (content: unknown[]) =>
  ({ type: 'assistant', uuid: uuid(), timestamp: at(n), sessionId: 's1', version: '2.1.296', message: { role: 'assistant', content } });
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const kinds = (items: ChatItem[]) => items.map((i) => [i.kind, i.text]);

describe('a transcript read as a chat', () => {
  it('1. keeps the user, the runner\'s text and its tool calls, in the transcript\'s order', () => {
    const items = transcriptItems(jsonl([
      user('review #280'),
      assistant([{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log -3' } }]),
      assistant([{ type: 'text', text: 'Done.' }]),
    ]), 's1');
    expect(kinds(items)).toEqual([['user', 'review #280'], ['text', 'On it.'], ['tool', 'Bash: git log -3'], ['text', 'Done.']]);
  });

  it('2. leaves out what is not conversation', () => {
    const items = transcriptItems(jsonl([
      user('meta line', { isMeta: true }),
      user('the summary', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      { type: 'user', uuid: uuid(), sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret output' }] }, toolUseResult: {} },
      assistant([{ type: 'thinking', thinking: 'hmm', signature: 'x' }]),
      { type: 'attachment', uuid: uuid(), sessionId: 's1', attachment: { type: 'hook_success', content: 'hook said' } },
      { type: 'mode', sessionId: 's1', mode: 'normal' }, { type: 'ai-title', sessionId: 's1', aiTitle: 't' },
      { type: 'last-prompt', sessionId: 's1' }, { type: 'permission-mode', sessionId: 's1' }, { type: 'file-history-snapshot', messageId: 'm' },
      { type: 'system', subtype: 'turn_duration', uuid: uuid(), sessionId: 's1' }, { type: 'system', subtype: 'stop_hook_summary', uuid: uuid(), sessionId: 's1' },
    ]), 's1');
    expect(items).toEqual([]);
  });

  it('3. keeps a message typed in during a turn', () => {
    const items = transcriptItems(jsonl([
      { type: 'attachment', uuid: uuid(), timestamp: at(1), sessionId: 's1', attachment: { type: 'queued_command', prompt: 'and the changelog too', commandMode: 'prompt' } },
    ]), 's1');
    expect(kinds(items)).toEqual([['user', 'and the changelog too']]);
  });

  it('4. shows a line it does not know, and a damaged one, as one raw line each, and reads on', () => {
    const text = [JSON.stringify(user('before')), JSON.stringify({ type: 'brand-new-thing', uuid: 'u-new', sessionId: 's1', payload: 'x'.repeat(5_000) }), '{"type": "user", torn', JSON.stringify(user('after'))].join('\n') + '\n';
    const items = transcriptItems(text, 's1');
    expect(items.map((i) => i.kind)).toEqual(['user', 'raw', 'raw', 'user']);
    expect(items[1].text.startsWith('brand-new-thing')).toBe(true);
    expect(items[1].text.length).toBeLessThanOrEqual(200);
    expect(items[1].id).toBe('u-new');
    expect(items[3].text).toBe('after');
  });

  it('5. waits for a last line still being written', () => {
    const items = transcriptItems(`${JSON.stringify(user('whole'))}\n{"type":"assistant","mess`, 's1');
    expect(kinds(items)).toEqual([['user', 'whole']]);
  });

  it('6. shows a compaction as one divider', () => {
    const items = transcriptItems(jsonl([user('a'), { type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: at(9), sessionId: 's1', compactMetadata: { trigger: 'auto' } }, user('b')]), 's1');
    expect(items.map((i) => [i.kind, i.text])).toEqual([['user', 'a'], ['divider', 'compacted'], ['user', 'b']]);
  });

  it('8. folds a tool call into one short line', () => {
    const items = transcriptItems(jsonl([assistant([
      { type: 'tool_use', id: 't1', name: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'w1', prompt: 'a long brief\n'.repeat(500) } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo one\necho two' } },
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/work/demo/src/x.ts' } },
      { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: `/work/${'deep/'.repeat(60)}x.ts` } },
    ])]), 's1', { nameOf: (id) => (id === 'w1' ? 'Backend' : undefined) });
    expect(items.map((i) => i.text).slice(0, 3)).toEqual(['delegate_task -> Backend', 'Bash: echo one', 'Read /work/demo/src/x.ts']);
    expect(items[3].text.startsWith('Read /work/deep/')).toBe(true);
    for (const i of items) expect(i.text.length).toBeLessThanOrEqual(120);
  });

  it('9. says who a line Tars typed is from', () => {
    const items = transcriptItems(jsonl([
      user('Message from agent "Backend" ("w1"), task t-1a2b3c4d: PR #364 is open'),
      user('Message from Tars: [Tars] "Backend" ("w1") has finished its turn'),
      user('[Tars] 2 agents you dispatched have reached a result:'),
      user('Message from the user via Telegram: ship it'),
      user('plain words from JeanBrasse'),
    ]), 's1');
    expect(items.map((i) => [i.kind, i.from ?? null, i.text])).toEqual([
      ['message', 'Backend', 'PR #364 is open'],
      ['note', 'Tars', '[Tars] "Backend" ("w1") has finished its turn'],
      ['note', 'Tars', '[Tars] 2 agents you dispatched have reached a result:'],
      ['message', 'Telegram', 'ship it'],
      ['user', null, 'plain words from JeanBrasse'],
    ]);
  });

  it('10. gives each item its line\'s uuid, a line with several parts one id each', () => {
    const line = assistant([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
    const items = transcriptItems(jsonl([line]), 's1');
    expect(items.map((i) => i.id)).toEqual([`${line.uuid}`, `${line.uuid}:1`]);
    expect(transcriptItems(jsonl([line]), 's1').map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});

describe("Claude Code's own lines", () => {
  it('12. a background task\'s report is its note, a slash command the command, a command\'s output folded', () => {
    const report = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed</summary>\n</task-notification>';
    const items = transcriptItems(jsonl([
      user(report),
      { type: 'attachment', uuid: uuid(), sessionId: 's1', attachment: { type: 'queued_command', prompt: report, commandMode: 'task-notification' } },
      user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
      user('<local-command-stdout>Set model to opus</local-command-stdout>'),
    ]), 's1');
    expect(items.map((i) => [i.kind, i.from ?? null, i.text])).toEqual([
      ['note', 'Claude Code', 'background task completed: Background command "npm test" completed'],
      ['note', 'Claude Code', 'background task completed: Background command "npm test" completed'],
      ['user', null, '/model opus'],
    ]);
  });
});

describe("a chat's sessions", () => {
  it('7. in order, the copied history once, a divider where each session after the first starts, and a missing file lost alone', () => {
    const a1 = user('first ask');
    const a2 = assistant([{ type: 'text', text: 'first answer' }]);
    const b1 = user('second ask');
    const items = chatItems([
      { sessionId: 's1', text: jsonl([a1, a2]) },
      // A resumed session's file starts with the history it carries over.
      { sessionId: 's2', text: jsonl([{ ...a1, sessionId: 's2' }, { ...a2, sessionId: 's2' }, { ...b1, sessionId: 's2' }]) },
      { sessionId: 's3', text: null },
    ]);
    expect(items.map((i) => [i.kind, i.text, i.sessionId])).toEqual([
      ['user', 'first ask', 's1'], ['text', 'first answer', 's1'],
      ['divider', 'session', 's2'], ['user', 'second ask', 's2'],
      ['divider', 'session', 's3'], ['raw', 'session s3: its transcript is gone', 's3'],
    ]);
  });
});

describe('the transcripts Claude Code writes', () => {
  for (const version of ['2.1.280', '2.1.289', '2.1.296']) {
    it(`11. ${version}: every shape known, every user line and tool call kept`, () => {
      const text = fixture(version);
      const items = transcriptItems(text, 's');
      const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const parts = (type: string) => lines.filter((l) => l.type === 'assistant').flatMap((l) => l.message.content).filter((p: { type: string }) => p.type === type).length;
      const users = lines.filter((l) => l.type === 'user' && typeof l.message?.content === 'string' && !l.isMeta && !l.isCompactSummary
        && !l.message.content.trimStart().startsWith('<local-command-stdout>')).length;
      const queued = lines.filter((l) => l.type === 'attachment' && l.attachment?.type === 'queued_command').length;
      expect(items.filter((i) => i.kind === 'raw')).toEqual([]);
      expect(items.filter((i) => i.kind === 'tool')).toHaveLength(parts('tool_use'));
      expect(items.filter((i) => i.kind === 'text')).toHaveLength(parts('text'));
      expect(items.filter((i) => ['user', 'message', 'note'].includes(i.kind))).toHaveLength(users + queued);
    });
  }
});
