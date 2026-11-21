import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { openPtyHeard, ptyBacklog } from '../../src/lib/pty-backlog';

/**
 * What a project's shell writes before its terminal is there to hear it
 * (src/lib/pty-backlog.ts). The Projects page asks main for a PTY, then mounts
 * <Terminal>, a dynamic import away, which only then listens to the PTY: the
 * shell's banner and first prompt, written in between, reached nobody, and the
 * terminal opened empty (the QA's WHEEL-QA.md, 05/10). The page now listens
 * before it asks, and hands the terminal what came. Written before the code.
 * How it can fail:
 * 1. a chunk the PTY writes before the page knows its id (pty:create has not
 *    answered yet) is lost: the page must listen before it asks;
 * 2. another PTY's chunks are handed over: every PTY's data comes through the
 *    one channel;
 * 3. the order is lost;
 * 4. the listening never ends: once the terminal has taken the chunks it hears
 *    the PTY itself, and a page that went on listening kept every chunk of
 *    every PTY for as long as it lived; a terminal that never came (the dialog
 *    closed first, pty:create failed) left it listening too;
 * 5. the chunks are handed over twice: React runs an effect twice in
 *    development, the terminal's subscription with it.
 *
 * Opening the PTY with its listening (openPtyHeard), the Audit's Low at the
 * gate of #328, written before the code:
 * 6. the page that asked is gone when pty:create answers (it was left while
 *    the PTY was being made): nothing would take the backlog or kill the
 *    shell, so the listening, which hears every agent's output, went on for
 *    the window's life, and the shell lived on with nobody attached. The
 *    listening ends and the PTY is killed;
 * 7. over-correction: a page still there gets its PTY, and its backlog still
 *    listens, until its terminal takes it;
 * 8. pty:create fails: the listening ends, and the failure reaches the page.
 */

type Chunk = { id: string; data: string };

/** The bridge's pty.onData, with its listeners in view. */
function channel() {
  const listeners = new Set<(chunk: Chunk) => void>();
  return {
    onData: (cb: (chunk: Chunk) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    send: (id: string, data: string) => { for (const cb of [...listeners]) cb({ id, data }); },
    get listening() { return listeners.size; },
  };
}

describe('what a PTY writes before its terminal listens', () => {
  it('is kept from before the PTY was asked for, in order, and handed to its terminal (1, 3)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    // pty:create has not answered: the id is not known yet.
    pty.send('p1', 'Last login: Mon Oct  5 21:40\r\n');
    pty.send('p1', 'the recorder holds the alternate screen\r\n');
    pty.send('p1', '% ');
    expect(backlog.take('p1')).toEqual(['Last login: Mon Oct  5 21:40\r\n', 'the recorder holds the alternate screen\r\n', '% ']);
  });

  it('hands over only that PTY\'s chunks (2)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('other', 'an agent\'s shell\r\n');
    pty.send('p1', 'mine\r\n');
    pty.send('other', 'more of it\r\n');
    expect(backlog.take('p1')).toEqual(['mine\r\n']);
  });

  it('stops listening once the terminal has taken them, and keeps nothing after (4)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    expect(pty.listening).toBe(1);
    backlog.take('p1');
    expect(pty.listening).toBe(0);
    pty.send('p1', 'heard by the terminal itself\r\n');
    expect(backlog.take('p1')).toEqual([]);
  });

  it('stops listening, and keeps nothing, for a terminal that never came (4)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    backlog.drop();
    expect(pty.listening).toBe(0);
    expect(backlog.take('p1')).toEqual([]);
  });

  it('hands them over once, however often it is asked (5)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    expect(backlog.take('p1')).toEqual(['banner\r\n']);
    expect(backlog.take('p1')).toEqual([]);
  });
});

describe('opening a PTY with its listening', () => {
  /** The bridge's pty, with what it was asked in view: create answers when the test says. */
  function bridge() {
    const data = channel();
    const killed: string[] = [];
    let answer!: (value: { id: string }) => void;
    let refuse!: (reason: unknown) => void;
    const created = new Promise<{ id: string }>((resolve, reject) => { answer = resolve; refuse = reject; });
    return {
      data, killed, answer, refuse,
      pty: {
        onData: data.onData,
        create: async () => created,
        kill: async ({ id }: { id: string }) => { killed.push(id); return { success: true }; },
      },
    };
  }

  it('lets go of the listening and kills the shell when the page is gone by the answer (6)', async () => {
    const b = bridge();
    let mounted = true;
    const opening = openPtyHeard(b.pty, { cwd: '/p' }, () => mounted);
    expect(b.data.listening).toBe(1);
    mounted = false;
    b.data.send('p1', 'Last login: Mon Oct  5 21:40\r\n');
    b.answer({ id: 'p1' });
    expect(await opening).toBeNull();
    expect(b.data.listening).toBe(0);
    expect(b.killed).toEqual(['p1']);
  });

  it('hands a page still there its PTY, with what it wrote so far (7)', async () => {
    const b = bridge();
    const opening = openPtyHeard(b.pty, { cwd: '/p' }, () => true);
    b.data.send('p1', 'Last login: Mon Oct  5 21:40\r\n');
    b.answer({ id: 'p1' });
    const opened = await opening;
    expect(opened?.id).toBe('p1');
    expect(b.killed).toEqual([]);
    expect(b.data.listening).toBe(1);
    expect(opened!.backlog.take('p1')).toEqual(['Last login: Mon Oct  5 21:40\r\n']);
    expect(b.data.listening).toBe(0);
  });

  it('stops listening when pty:create fails, and says so (8)', async () => {
    const b = bridge();
    const opening = openPtyHeard(b.pty, { cwd: '/p' }, () => true);
    b.refuse(new Error('Tars is quitting: no terminal'));
    await expect(opening).rejects.toThrow('Tars is quitting');
    expect(b.data.listening).toBe(0);
  });
});
