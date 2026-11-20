/**
 * The rules a chat's runner is made and scheduled by (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.2; PR D of 2.0.0): its name, its worktree and where its branch
 * starts, which runner sleeps to free a slot, which runners a launch after a
 * crash resumes, and the sentence a full limit answers with
 * (electron/core/chat-slots.ts). Pure: the fleet, git and the RAM are read by
 * services/chat-runners.ts and handed in.
 *
 * How it fails, written before the code (2026-10-12):
 * The runner
 * 1. A runner is named like the orchestrator, so a worker cannot tell two
 *    chats apart in its sender line: it must read "<orchestrator> · <title>".
 * 2. Its worktree lands outside the project's .worktrees, or under a name a
 *    chat id can steer (a path, `..`), or two chats share one.
 * 3. Its branch starts from the root's current branch (whatever someone
 *    checked out there) instead of origin's default branch, or from nothing
 *    when there is no remote though a local default branch exists.
 * The slots
 * 4. Main's runner (the persistent orchestrator, which never sleeps) is put to
 *    sleep to free a slot.
 * 5. A runner the sleep rule refuses (in a turn, a message on its way, work
 *    out, a draft) is put to sleep anyway.
 * 6. The most recently active idle runner is chosen rather than the least.
 * 7. A choice is made when nobody may sleep: a slot freed by killing work.
 * After a crash
 * 8. More runners are resumed than the limit leaves slots, or the least
 *    recently active ones first, or a negative count of slots resumes some.
 * The refusal
 * 9. The sentence of a full limit does not say how many, the RAM and the rule,
 *    and who works: the user cannot act on it.
 * The record's runner (the Audit's Info on #361, written before the code, 2026-10-13)
 * chats.json sits in ~/.tars, which every agent may write: a record's
 * runnerId is a claim, which the fleet confirms or not.
 * 10. A chat other than Main names an agent that is not its runner (a worker,
 *     the orchestrator, another chat's runner), and Tars types into it,
 *     launches it, counts it in a slot or puts it to sleep.
 * 11. Main names an agent that is not the project's orchestrator (a worker, a
 *     chat's runner, another project's orchestrator), and is treated as Main.
 * 12. A runner of this chat's id but of another project passes.
 * 13. A chat with no runner yet, or whose agent was deleted, reads as a forged
 *     one: the first must make its runner, the second say it is gone.
 * A runner's kind (the Audit's L1 on #379, written before the code, 2026-10-13)
 * agents.json is in ~/.tars too, and `kind: 'chat'` gives the orchestrator's
 * powers: at launch, a runner keeps it only while a chat names it.
 * 14. An agent marked kind chat that no chat names (no chatId, a chat that is
 *     gone, a chat naming another agent, a chat of another project) keeps the
 *     kind, and the powers with it.
 * 15. A runner its chat names loses its kind; an agent of no chat is listed.
 * The place (the Audit's R9 on #379)
 * 16. A letter that is not hex reaches the runner's folder name.
 * The refusal of its worktree (#394's gate, written before the code, 2026-10-13)
 * git writes its progress to stderr too, and the page shows that text whole.
 * 17. The page reads git's progress line ("Preparing worktree (new branch
 *     'chat/1a2b3c4d')") before the reason, or the "fatal: " that heads it.
 * 18. A refusal of several lines (an error, then the fatal) loses one, or keeps
 *     git's hints with them.
 * 19. git says nothing a user can read (no stderr, only its progress, a git
 *     stopped by the timeout): the page gets an empty reason or the progress,
 *     instead of Tars's own sentence.
 * 20. git's line ends with a period, and the page reads two.
 * The orchestrator off claude (2.0.1, written before the code, 2026-10-13)
 * A chat other than Main runs on its orchestrator's CLI, claude only (the
 * Audit's L4 on #379). 2.0.0 read that rule only on the way to a launch: a
 * runner still running when its orchestrator left claude took its chat's
 * messages on claude.
 * 21. A send to a chat other than Main goes in while the orchestrator is off
 *     claude, because its runner is still running.
 * 22. Main is refused, though its runner is the orchestrator itself, on
 *     whatever CLI it runs.
 * 23. A chat is refused while its orchestrator runs claude, or a project with
 *     no orchestrator answers this refusal instead of its own.
 * 24. The refusal does not say why, or the one of a runner still running does
 *     not say what becomes of it: its turn, the answers it waits for, and that
 *     nothing more from the chat reaches it.
 * 25. The refusal of a runner that is not running says that it runs.
 * And from `git worktree remove` (the Audit's L1 on #398, written before the code, 2026-10-13)
 * 26. git ends its line with a semicolon before an unprefixed hint ("cannot
 *     remove a locked working tree;" then "use 'remove -f -f' ..."): the
 *     sentence reads "tree;)".
 * A start on its way (2.0.2, QA's Info on #397, written before the code, 2026-10-13)
 * A runner restarting with no prompt (to follow a new orchestrator) holds its
 * slot while its start is on its way, and is idle a moment later.
 * 27. A full limit answers chat_limit at its first look at such a runner,
 *     naming a chat that has nothing to do, instead of looking again.
 * 28. Main, or a runner being started for the send in hand, is looked at
 *     again: the first never sleeps, the second is about to work.
 * 29. A refusal that does not pass by itself (in a turn, work owed, a draft
 *     that does not settle) is looked at again, or one that does (a Stop
 *     hook's tail, no process table, a message settling) no longer is.
 */
import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  runnerNameOf, runnerPlaceOf, startPointOf, victimOf, runnersToResume, chatLimitSentence, recordedRunner, unconfirmedRunners,
  gitRefusal, offClaudeRefusal, looksAgain,
} from '../../../electron/core/chat-slots';

describe('a runner', () => {
  it('1. is named after the orchestrator and the chat, so a worker tells chats apart', () => {
    expect(runnerNameOf('Tars-Orchestrator', 'Release 1.9.4')).toBe('Tars-Orchestrator · Release 1.9.4');
    expect(runnerNameOf(undefined, 'Bug #12')).toBe('Orchestrator · Bug #12');
    expect(runnerNameOf('  ', 'Bug #12')).toBe('Orchestrator · Bug #12');
  });

  it("2. works in the project's .worktrees/chat-<8 hex of its id>, on chat/<the same>", () => {
    const project = '/Users/me/projects/demo';
    expect(runnerPlaceOf(project, '4F2A9C11-0b3d-4e5f-8a6b-7c8d9e0f1a2b')).toEqual({
      worktreePath: path.join(project, '.worktrees', 'chat-4f2a9c11'), branchName: 'chat/4f2a9c11',
    });
    // Two chats, two places.
    expect(runnerPlaceOf(project, 'aaaaaaaa-0000-4000-8000-000000000001')?.worktreePath)
      .not.toBe(runnerPlaceOf(project, 'bbbbbbbb-0000-4000-8000-000000000001')?.worktreePath);
  });

  it('2. refuses a chat id that cannot name a place: too short, or with path characters only', () => {
    expect(runnerPlaceOf('/p', '../../etc')).toBeNull();
    expect(runnerPlaceOf('/p', 'abc')).toBeNull();
    expect(runnerPlaceOf('/p', '')).toBeNull();
    // What is not hex never reaches the path.
    expect(runnerPlaceOf('/p', '../../4f2a9c11-zz')?.worktreePath).toBe(path.join('/p', '.worktrees', 'chat-4f2a9c11'));
  });

  it("3. starts from origin's default branch, never the root's current one", () => {
    expect(startPointOf({ originHead: 'origin/main', refs: ['origin/main', 'feature-x', 'main'] })).toBe('origin/main');
    expect(startPointOf({ originHead: 'origin/trunk', refs: ['origin/trunk'] })).toBe('origin/trunk');
    // No origin/HEAD recorded: origin/main, then origin/master.
    expect(startPointOf({ originHead: null, refs: ['origin/master', 'feature-x'] })).toBe('origin/master');
    expect(startPointOf({ originHead: null, refs: ['origin/main', 'origin/master'] })).toBe('origin/main');
    // origin's branch before the local one of the same name, which may be anywhere.
    expect(startPointOf({ originHead: null, refs: ['main', 'origin/main', 'feature-x'] })).toBe('origin/main');
    expect(startPointOf({ originHead: null, refs: ['master', 'origin/master'] })).toBe('origin/master');
  });

  it('3. with no remote, from the local default branch; with none at all, nowhere', () => {
    expect(startPointOf({ originHead: null, refs: ['main', 'feature-x'] })).toBe('main');
    expect(startPointOf({ originHead: null, refs: ['master'] })).toBe('master');
    expect(startPointOf({ originHead: null, refs: ['feature-x'] })).toBeNull();
  });
});

describe('a slot freed by a sleep', () => {
  const at = (minutes: number) => Date.parse('2026-10-12T08:00:00.000Z') + minutes * 60_000;

  it("4, 6. sleeps the least recently active runner the rule allows, never Main's", () => {
    expect(victimOf([
      { agentId: 'main', isMain: true, lastActivity: at(0), refusal: null },
      { agentId: 'recent', isMain: false, lastActivity: at(30), refusal: null },
      { agentId: 'older', isMain: false, lastActivity: at(10), refusal: null },
    ])).toBe('older');
  });

  it('5. passes over a runner the sleep rule refuses', () => {
    expect(victimOf([
      { agentId: 'busy', isMain: false, lastActivity: at(0), refusal: 'not-at-rest' },
      { agentId: 'owed', isMain: false, lastActivity: at(1), refusal: 'owes' },
      { agentId: 'free', isMain: false, lastActivity: at(5), refusal: null },
    ])).toBe('free');
  });

  it('7. chooses nobody when nobody may sleep', () => {
    expect(victimOf([
      { agentId: 'main', isMain: true, lastActivity: at(0), refusal: null },
      { agentId: 'busy', isMain: false, lastActivity: at(1), refusal: 'field' },
    ])).toBeNull();
    expect(victimOf([])).toBeNull();
  });
});

describe('after a crash', () => {
  it('8. resumes the most recently active runners, as many as the slots left, and leaves the rest asleep', () => {
    const working = [
      { agentId: 'a', lastActivity: 1 }, { agentId: 'b', lastActivity: 3 }, { agentId: 'c', lastActivity: 2 },
    ];
    expect(runnersToResume(working, 2)).toEqual({ resume: ['b', 'c'], leave: ['a'] });
    expect(runnersToResume(working, 5)).toEqual({ resume: ['b', 'c', 'a'], leave: [] });
    expect(runnersToResume(working, 0)).toEqual({ resume: [], leave: ['b', 'c', 'a'] });
    expect(runnersToResume(working, -1)).toEqual({ resume: [], leave: ['b', 'c', 'a'] });
  });
});

describe('the sentence of a full limit', () => {
  it('9. says how many, the RAM and the rule, and who works', () => {
    expect(chatLimitSentence(3, 16, 5, ['Release 1.9.4', 'Bug #12', 'Design'])).toBe(
      '3 chats are already working, the most this Mac runs at once (16 GB of RAM, one chat per 5 GB). '
      + 'Wait for one to finish, or stop one: Release 1.9.4, Bug #12, Design.',
    );
    expect(chatLimitSentence(1, 8, 5, ['Main'])).toBe(
      '1 chat is already working, the most this Mac runs at once (8 GB of RAM, one chat per 5 GB). '
      + 'Wait for it to finish, or stop it: Main.',
    );
  });
});

describe("a record's runner, as the fleet confirms it", () => {
  const project = '/Users/me/projects/demo';
  const other = '/Users/me/projects/other';
  const fleet = new Map([
    ['lead', { id: 'lead', role: 'orchestrator', projectPath: project }],
    ['worker', { id: 'worker', role: 'worker', projectPath: project }],
    ['runner-a', { id: 'runner-a', role: 'worker', kind: 'chat', chatId: 'chat-a', projectPath: project }],
    ['runner-b', { id: 'runner-b', role: 'worker', kind: 'chat', chatId: 'chat-b', projectPath: project }],
    ['elsewhere', { id: 'elsewhere', role: 'worker', kind: 'chat', chatId: 'chat-a', projectPath: other }],
    ['other-lead', { id: 'other-lead', role: 'orchestrator', projectPath: other }],
  ]);
  const main = (runnerId: string | null) => ({ id: 'chat-main', number: 1, projectPath: project, runnerId });
  const chatA = (runnerId: string | null) => ({ id: 'chat-a', number: 2, projectPath: project, runnerId });

  it("10. a chat other than Main runs on the runner made for it, and on no other agent", () => {
    expect(recordedRunner(chatA('runner-a'), fleet)).toEqual({ agent: fleet.get('runner-a') });
    for (const forged of ['worker', 'lead', 'runner-b']) {
      expect(recordedRunner(chatA(forged), fleet), forged).toEqual({ why: 'not_its_own' });
    }
  });

  it("11. Main runs on the project's orchestrator, and on no other agent", () => {
    expect(recordedRunner(main('lead'), fleet)).toEqual({ agent: fleet.get('lead') });
    for (const forged of ['worker', 'runner-a', 'other-lead']) {
      expect(recordedRunner(main(forged), fleet), forged).toEqual({ why: 'not_its_own' });
    }
  });

  it("12. a runner made for this chat's id in another project is not its runner", () => {
    expect(recordedRunner(chatA('elsewhere'), fleet)).toEqual({ why: 'not_its_own' });
  });

  it('13. no runner yet, and a runner deleted since, each say so', () => {
    expect(recordedRunner(chatA(null), fleet)).toEqual({ why: 'none' });
    expect(recordedRunner(main(null), fleet)).toEqual({ why: 'none' });
    expect(recordedRunner(chatA('deleted'), fleet)).toEqual({ why: 'gone' });
    expect(recordedRunner(main('deleted'), fleet)).toEqual({ why: 'gone' });
  });
});

describe("a runner's kind, as the chats confirm it (the Audit's L1 on #379)", () => {
  const project = '/Users/me/projects/demo';
  const chats = new Map([
    ['chat-a', { id: 'chat-a', number: 2, projectPath: project, runnerId: 'runner-a' }],
    ['chat-b', { id: 'chat-b', number: 3, projectPath: project, runnerId: 'runner-x' }],
    ['chat-o', { id: 'chat-o', number: 2, projectPath: '/Users/me/projects/other', runnerId: 'runner-o' }],
  ]);
  const fleet = new Map([
    ['lead', { id: 'lead', role: 'orchestrator', projectPath: project }],
    ['worker', { id: 'worker', role: 'worker', projectPath: project }],
    ['runner-a', { id: 'runner-a', role: 'worker', kind: 'chat', chatId: 'chat-a', projectPath: project }],
    ['no-chat-id', { id: 'no-chat-id', role: 'worker', kind: 'chat', projectPath: project }],
    ['gone', { id: 'gone', role: 'worker', kind: 'chat', chatId: 'chat-gone', projectPath: project }],
    ['named-other', { id: 'named-other', role: 'worker', kind: 'chat', chatId: 'chat-b', projectPath: project }],
    ['runner-o', { id: 'runner-o', role: 'worker', kind: 'chat', chatId: 'chat-o', projectPath: project }],
    // Claims chat A, whose record names runner-a, which exists.
    ['thief', { id: 'thief', role: 'worker', kind: 'chat', chatId: 'chat-a', projectPath: project }],
  ]);

  it('14, 15. lists every agent marked kind chat that no chat names, and nothing else', () => {
    const ids = unconfirmedRunners(fleet, (chatId) => chats.get(chatId)).map((a) => a.id).sort();
    expect(ids).toEqual(['gone', 'named-other', 'no-chat-id', 'runner-o', 'thief']);
  });
});

describe("the runner's place, hex only (the Audit's R9 on #379)", () => {
  it('16. a letter that is not hex never reaches the folder name', () => {
    expect(runnerPlaceOf('/p', 'ghijklmn-0123-4567-89ab-cdef01234567')?.worktreePath).toBe(path.join('/p', '.worktrees', 'chat-01234567'));
    expect(runnerPlaceOf('/p', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBeNull();
  });
});

describe("the refusal of a runner's worktree (#394's gate)", () => {
  // As git 2.39 writes them, measured on 2026-10-13.
  const progress = "Preparing worktree (new branch 'chat/1a2b3c4d')\n";

  it('17. only the reason reaches the page, without the progress or the "fatal: "', () => {
    expect(gitRefusal(`${progress}fatal: a branch named 'chat/1a2b3c4d' already exists\n`)).toBe("a branch named 'chat/1a2b3c4d' already exists");
    expect(gitRefusal(`${progress}fatal: could not create leading directories of '/p/.worktrees/chat-1a2b3c4d/.git': Permission denied\n`))
      .toBe("could not create leading directories of '/p/.worktrees/chat-1a2b3c4d/.git': Permission denied");
  });

  it('18. every error and fatal line, and no hint', () => {
    expect(gitRefusal(`${progress}error: could not lock config file .git/config: File exists\r\nhint: remove the lock\nfatal: unable to write new index file\n`))
      .toBe('could not lock config file .git/config: File exists; unable to write new index file');
  });

  it("19. Tars's own sentence when git gives no reason", () => {
    for (const stderr of ['', '\n', progress, `${progress}hint: something\n`]) expect(gitRefusal(stderr)).toBe('git refused it without saying why');
  });

  it('20. no period of its own: the sentence adds one', () => {
    expect(gitRefusal(`${progress}fatal: not a valid object name: 'origin/main'.\n`)).toBe("not a valid object name: 'origin/main'");
  });

  it('26. no semicolon git ends its line with before a hint', () => {
    expect(gitRefusal("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first\n")).toBe('cannot remove a locked working tree');
  });
});

describe('a send while the orchestrator is off claude (2.0.1)', () => {
  it('21. a chat other than Main is refused, its runner running or not', () => {
    for (const number of [2, 7]) {
      expect(offClaudeRefusal(number, false, true)).not.toBeNull();
      expect(offClaudeRefusal(number, false, false)).not.toBeNull();
    }
  });

  it('22. never Main: its runner is the orchestrator itself', () => {
    expect(offClaudeRefusal(1, false, true)).toBeNull();
    expect(offClaudeRefusal(1, false, false)).toBeNull();
  });

  it('23. not while the orchestrator runs claude, nor in a project with no orchestrator', () => {
    for (const live of [true, false]) {
      expect(offClaudeRefusal(2, true, live)).toBeNull();
      expect(offClaudeRefusal(2, undefined, live)).toBeNull();
    }
  });

  it('24. says why, and of a runner still running what becomes of it', () => {
    const why = offClaudeRefusal(2, false, false)!;
    expect(why).toMatch(/orchestrator runs a CLI whose conversations Tars cannot resume/);
    expect(why).toMatch(/chats other than Main work with claude/);
    const running = offClaudeRefusal(2, false, true)!;
    expect(running.startsWith(`${why} `)).toBe(true);
    const after = running.slice(why.length);
    expect(after).toMatch(/still running on claude/);
    expect(after).toMatch(/turn ends as it would/);
    expect(after).toMatch(/still answer it/);
    expect(after).toMatch(/nothing more from this chat reaches it until the orchestrator runs claude again/);
  });

  it('25. a runner that is not running is not said to run', () => {
    expect(offClaudeRefusal(2, false, false)).not.toMatch(/running|turn/);
  });
});

describe('a runner a full limit looks at again (2.0.2)', () => {
  const runner = (refusal: string | null, more: Partial<{ isMain: boolean; settlesInMs: number; forSend: boolean }> = {}) => ({ isMain: false, refusal, ...more });

  it('27. one whose start is on its way: idle a moment later, when it carries no message', () => {
    expect(looksAgain(runner('starting'))).toBe(true);
  });

  it('28. never Main, nor a runner being started for the send in hand', () => {
    expect(looksAgain(runner('starting', { isMain: true }))).toBe(false);
    expect(looksAgain(runner('busy', { isMain: true }))).toBe(false);
    expect(looksAgain(runner('starting', { forSend: true }))).toBe(false);
  });

  it('29. only what passes by itself', () => {
    for (const refusal of ['busy', 'no-process-table']) expect(looksAgain(runner(refusal)), refusal).toBe(true);
    expect(looksAgain(runner('field', { settlesInMs: 1200 }))).toBe(true);
    expect(looksAgain(runner('field'))).toBe(false);
    for (const refusal of ['not-at-rest', 'owed', 'owes', 'pending', 'no-cli', 'not-resumable', null]) {
      expect(looksAgain(runner(refusal)), String(refusal)).toBe(false);
    }
  });
});
