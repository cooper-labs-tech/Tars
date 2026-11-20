import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { agentDeletedNotice, deletedNotice } from '../../src/lib/chat-deleted';

/**
 * What the chat list says once a chat is deleted (src/lib/chat-deleted.ts), from
 * chat:delete's answer: savedTo, the wip/ branch its runner's uncommitted work was
 * saved on, and worktreeKept, why its runner's worktree stays on disk, and where.
 * Frame: `Shell · chats · a chat's actions · states`, DELETED: WHAT STAYS, AND
 * WHERE, in tars-redesign.pen. The Audit's read of the bullets of PR 392. Written
 * before the code. How it can fail:
 * 1. a worktree kept says nothing: the chat goes and its folder stays on disk in
 *    silence;
 * 2. where it stays, or why, is lost: the main process's sentence cut or replaced;
 * 3. the branch the work was saved on is not named;
 * 4. both stay, and only one is said;
 * 5. a deletion where nothing stays says something, on every delete;
 * 6. a refusal reads as a deletion;
 * 7. an answer it cannot read (a field that is not text, or blank) says "kept:"
 *    with nothing after, or "undefined";
 * 8. it names another chat than the one deleted;
 * 9. a sentence that ends with a full stop gets a second one, the chat's own
 *    title included (a first message names a chat "Write the docs.").
 *
 * Added with the Agents page (2.0.1), before its code: agent:remove answers the
 * same two fields, and the page says them as the chat list does. How it can fail:
 * 10. an agent deleted is named otherwise than by its name, or its notice reads
 *     otherwise than a chat's for the same answer;
 * 11. an agent whose deletion failed, or of which nothing stays, says something.
 */

const chat = { project: 'tars', number: 2, title: 'Release notes for 1.9.4' };
const kept = 'it holds files git ignores, which no commit keeps (.env), so its worktree was kept at /Users/me/code/tars/.worktrees/chat-1a2b3c4d';

describe('deletedNotice', () => {
  it('says the worktree stays, why and where, in the main process\'s words (1, 2, 8)', () => {
    expect(deletedNotice({ success: true, worktreeKept: kept }, chat)).toEqual({
      text: `Deleted tars #2, Release notes for 1.9.4, but not its worktree: ${kept}.`,
      saved: null,
    });
  });

  it('names the branch the uncommitted work was saved on (3)', () => {
    expect(deletedNotice({ success: true, savedTo: 'wip/lead-release' }, chat)).toEqual({
      text: 'Deleted tars #2, Release notes for 1.9.4.',
      saved: 'Its uncommitted work is on the branch wip/lead-release.',
    });
  });

  it('says both when both stay (4)', () => {
    expect(deletedNotice({ success: true, savedTo: 'wip/lead-release', worktreeKept: kept }, chat)).toEqual({
      text: `Deleted tars #2, Release notes for 1.9.4, but not its worktree: ${kept}.`,
      saved: 'Its uncommitted work is on the branch wip/lead-release.',
    });
  });

  it('says nothing when nothing stays, and nothing for a refusal (5, 6)', () => {
    expect(deletedNotice({ success: true }, chat)).toBeNull();
    expect(deletedNotice({ error: 'work_out', reason: 'This chat has work out at the team.' }, chat)).toBeNull();
    expect(deletedNotice({ error: 'work_out', reason: 'No.', savedTo: 'wip/x', worktreeKept: kept }, chat)).toBeNull();
    expect(deletedNotice(null, chat)).toBeNull();
    expect(deletedNotice(undefined, chat)).toBeNull();
  });

  it('never leaves a gap where the place or the branch goes (7)', () => {
    for (const odd of [{ worktreeKept: '' }, { worktreeKept: '   ' }, { worktreeKept: 42 }, { savedTo: '' }, { savedTo: ' ' }, { savedTo: {} }]) {
      expect(deletedNotice({ success: true, ...odd }, chat), JSON.stringify(odd)).toBeNull();
    }
    const both = deletedNotice({ success: true, savedTo: 7, worktreeKept: kept }, chat);
    expect(both?.saved).toBeNull();
    expect(JSON.stringify(both)).not.toMatch(/undefined|null\.|: \./);
  });

  it('ends each sentence with one full stop (9)', () => {
    const notice = deletedNotice({ success: true, savedTo: 'wip/lead-release', worktreeKept: `${kept}.` }, chat);
    expect(notice?.text.endsWith('chat-1a2b3c4d.')).toBe(true);
    expect(notice?.text.endsWith('..')).toBe(false);
    const titled = deletedNotice({ success: true, savedTo: 'wip/lead-write-the-docs' }, { project: 'tars', number: 3, title: 'Write the docs.' });
    expect(titled?.text).toBe('Deleted tars #3, Write the docs.');
  });
});

describe('agentDeletedNotice', () => {
  it('says what stays of an agent deleted, by its name, in the words a chat\'s notice has (10)', () => {
    expect(agentDeletedNotice({ success: true, savedTo: 'wip/backend-engineer', worktreeKept: kept }, 'Backend Engineer')).toEqual({
      text: `Deleted Backend Engineer, but not its worktree: ${kept}.`,
      saved: 'Its uncommitted work is on the branch wip/backend-engineer.',
    });
    expect(agentDeletedNotice({ success: true, savedTo: 'wip/qa' }, 'QA')).toEqual({
      text: 'Deleted QA.',
      saved: 'Its uncommitted work is on the branch wip/qa.',
    });
  });

  it('says nothing of an agent whose deletion failed, or of which nothing stays (11)', () => {
    expect(agentDeletedNotice({ success: true }, 'QA')).toBeNull();
    expect(agentDeletedNotice({ success: false, savedTo: 'wip/qa', worktreeKept: kept }, 'QA')).toBeNull();
    expect(agentDeletedNotice(undefined, 'QA')).toBeNull();
  });
});
