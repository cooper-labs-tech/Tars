import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { chatSections, chatStateWord } from '../../src/lib/chat-sections';
import type { ChatView } from '../../src/types/electron';

/**
 * Where each chat of the new shell's list goes (src/lib/chat-sections.ts),
 * from the chats' records (chat:list, #361). Frames: `Shell · chats · list, a
 * chat open` and `Chats · the list from the records · notes`. Written before
 * the code. How it can fail:
 * 1. a settled chat shows among the open ones, or twice;
 * 2. a snoozed chat whose time has passed stays hidden under Snoozed, or one
 *    still snoozed shows among the open ones;
 * 3. a chat both settled and snoozed is counted in both;
 * 4. a pinned chat whose runner works shows twice, or leaves Pinned;
 * 5. a chat whose runner is in a turn stays in Active;
 * 6. a section reads oldest first, or two chats of the same moment swap
 *    places from one listing to the next;
 * 7. the project filter keeps another project's chats, or drops the
 *    project's Main;
 * 8. a section with no chat is given anyway, to be drawn empty;
 * 9. a date that does not parse snoozes a chat for ever, or settles it;
 * 10. the state word: a chat with no runner, or an idle one, says something;
 *     a runner in a turn does not read working, one waiting does not read
 *     waiting on you, one in error says nothing;
 * 11. a chat pinned and still snoozed shows under Pinned, where its snooze
 *     should keep it under Snoozed until it ends (added after the code, at the
 *     Audit's L2 on #365, and shown to bite by its mutant S1, the pin read
 *     before the snooze).
 */

const NOW = Date.UTC(2026, 9, 12, 11, 0);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 12, 10, minutes)).toISOString();
const runner = (status: string) => ({ id: 'lead', name: 'Lead', status, waking: false, live: true, lastActivity: at(0) }) as ChatView['runner'];

function chat(over: Partial<ChatView> & { id: string }): ChatView {
  return {
    projectPath: '/p/tars', number: 1, title: 'Main', titleSource: 'user', runnerId: null, sessionIds: [],
    pinned: false, snoozedUntil: null, settledAt: null, inbox: false,
    createdAt: at(0), updatedAt: at(0), lastActivityAt: at(0), runner: null,
    ...over,
  };
}

const names = (chats: ChatView[], project: string | null = null) =>
  chatSections(chats, { now: NOW, project }).map(s => [s.name, s.chats.map(c => c.id)]);

describe('chatSections', () => {
  it('puts a settled chat under Settled alone (1)', () => {
    expect(names([chat({ id: 'a', settledAt: at(5) }), chat({ id: 'b', number: 2 })])).toEqual([
      ['Active', ['b']],
      ['Settled', ['a']],
    ]);
  });

  it('keeps a chat under Snoozed until its time, and brings it back after (2)', () => {
    expect(names([chat({ id: 'a', snoozedUntil: new Date(NOW + 60_000).toISOString() })])).toEqual([['Snoozed', ['a']]]);
    expect(names([chat({ id: 'a', snoozedUntil: new Date(NOW - 60_000).toISOString() })])).toEqual([['Active', ['a']]]);
    expect(names([chat({ id: 'a', pinned: true, snoozedUntil: new Date(NOW - 60_000).toISOString() })])).toEqual([['Pinned', ['a']]]);
  });

  it('counts a chat settled and snoozed once, under Settled (3)', () => {
    expect(names([chat({ id: 'a', settledAt: at(5), snoozedUntil: new Date(NOW + 60_000).toISOString() })])).toEqual([['Settled', ['a']]]);
  });

  it('keeps a pinned chat under Pinned, its runner working or not (4)', () => {
    expect(names([chat({ id: 'a', pinned: true, runner: runner('running') })])).toEqual([['Pinned', ['a']]]);
  });

  it('puts a chat whose runner is in a turn under Working, one waiting under Active (5)', () => {
    expect(names([
      chat({ id: 'a', runner: runner('running') }),
      chat({ id: 'b', number: 2, runner: runner('waiting') }),
    ])).toEqual([
      ['Active', ['b']],
      ['Working', ['a']],
    ]);
  });

  it('reads the most recent first, and the same moment in project then number order, whatever order it came in (6)', () => {
    const a = chat({ id: 'a', number: 3, lastActivityAt: at(10) });
    const b = chat({ id: 'b', number: 2, lastActivityAt: at(30) });
    const c = chat({ id: 'c', number: 1, lastActivityAt: at(10) });
    const d = chat({ id: 'd', projectPath: '/p/alpha', number: 4, lastActivityAt: at(10) });
    expect(names([a, b, c, d])).toEqual([['Active', ['b', 'd', 'c', 'a']]]);
    expect(names([d, c, b, a])).toEqual([['Active', ['b', 'd', 'c', 'a']]]);
  });

  it('keeps the filtered project\'s chats only, its Main among them (7)', () => {
    const main = chat({ id: 'main', inbox: true });
    const other = chat({ id: 'other', projectPath: '/p/harbor', number: 1 });
    const second = chat({ id: 'second', number: 2, lastActivityAt: at(20) });
    expect(names([main, other, second], '/p/tars')).toEqual([['Active', ['second', 'main']]]);
  });

  it('gives no section that has no chat (8)', () => {
    expect(names([])).toEqual([]);
    expect(names([chat({ id: 'a', pinned: true })])).toEqual([['Pinned', ['a']]]);
  });

  it('reads a snooze whose date does not parse as no snooze (9)', () => {
    expect(names([chat({ id: 'a', snoozedUntil: 'not a date' })])).toEqual([['Active', ['a']]]);
  });

  it('keeps a pinned chat under Snoozed while its snooze runs (11)', () => {
    expect(names([chat({ id: 'a', pinned: true, snoozedUntil: new Date(NOW + 60_000).toISOString() })])).toEqual([['Snoozed', ['a']]]);
  });

  it('gives Pinned, Active, Working, Snoozed, Settled in that order', () => {
    expect(names([
      chat({ id: 's', settledAt: at(1) }),
      chat({ id: 'z', snoozedUntil: new Date(NOW + 1000).toISOString() }),
      chat({ id: 'w', runner: runner('running') }),
      chat({ id: 'a' }),
      chat({ id: 'p', pinned: true }),
    ]).map(([name]) => name)).toEqual(['Pinned', 'Active', 'Working', 'Snoozed', 'Settled']);
  });
});

describe('chatStateWord (10)', () => {
  it('says nothing of a chat with no runner or an idle one', () => {
    expect(chatStateWord(chat({ id: 'a' }))).toBeNull();
    expect(chatStateWord(chat({ id: 'a', runner: runner('idle') }))).toBeNull();
    expect(chatStateWord(chat({ id: 'a', runner: runner('completed') }))).toBeNull();
  });

  it('reads working, waiting on you or error from the runner', () => {
    expect(chatStateWord(chat({ id: 'a', runner: runner('running') }))).toBe('working');
    expect(chatStateWord(chat({ id: 'a', runner: runner('waiting') }))).toBe('waiting');
    expect(chatStateWord(chat({ id: 'a', runner: runner('error') }))).toBe('error');
  });
});
