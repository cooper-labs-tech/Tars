import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IPty } from 'node-pty';

/**
 * A message from an agent must never be submitted with what JeanBrasse was in the
 * middle of writing.
 *
 * Measured on Claude Code 2.1.273 in a real PTY, before any of this existed
 * (`draft-bench`, 2026-09-20). Two shapes, both real:
 *
 *   a draft in the field, then the write:  "je pense quil faut" + the note
 *                                          went out as ONE prompt;
 *   three keys typed inside the 300 ms the carriage return trails by:
 *                                          the note + "oui" went out as one.
 *
 * The rule JeanBrasse gave: never mix, and never block. So while he is typing the
 * message waits; at the first pause Tars sets the draft aside, sends the
 * message on its own, and types the draft back exactly as it was without
 * sending it; and if it cannot promise to give it back, it writes nothing and
 * says so.
 *
 * These drive the real writer against a pseudo-terminal that records what it
 * was given, which is where the bug was: the bytes, in order, with the delays
 * they really have.
 */

const spawned: Array<{ write: (d: string) => void; written: string[] }> = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const written: string[] = [];
    const fake = { written, write: (d: string) => { written.push(d); }, onData: () => {}, onExit: () => {}, kill: () => {} };
    spawned.push(fake);
    return fake;
  }),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const broadcasts: Array<{ channel: string; payload: unknown }> = [];
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, payload: unknown) => { broadcasts.push({ channel, payload }); },
}));

import { emptyDraft, feedDraft } from '../../../electron/core/input-draft';
import {
  PROGRAMMATIC_SUBMIT_DELAY_MS,
  noteSubmitted,
  rememberTerminalOwner,
  TYPING_PAUSE_MS,
  draftOf,
  messagesWaiting,
  resetTerminalInput,
  writeHumanInput,
  writeProgrammaticInput,
} from '../../../electron/core/pty-manager';
import { sid } from '../../fixtures/session-id';

const NOTE = '[Tars] Tars-QA (worker) has completed: the suite is green.';

function makeTerminal() {
  const written: string[] = [];
  const pty = { write: (data: string) => { written.push(data); } } as unknown as IPty;
  return { pty, written, /** Everything the CLI would see as one line of input. */
    get typed() { return written.join(''); } };
}

/**
 * What the CLI submitted, prompt by prompt.
 *
 * The bytes alone do not say: a draft that is written back and then deleted
 * again is in the stream and not in the field. So the stream is replayed
 * through the same model of the field, and what is read off at each carriage
 * return is what the prompt carried. The model answers the real Claude Code
 * here: on the bench, the stream of the first case below submitted
 * "je pense quil faut[Tars] ...", and so does this.
 */
function submissions(written: string[]): string[] {
  const sent: string[] = [];
  let draft = emptyDraft();
  for (const write of written) {
    if (write === '\r') {
      sent.push(draft.text);
      draft = emptyDraft();
      continue;
    }
    draft = feedDraft(draft, write);
  }
  return sent;
}

/** As the panel sends them: one write per key. */
function types(pty: IPty, text: string): void {
  for (const ch of text) writeHumanInput(pty, ch);
}

/** Past the delayed carriage return and the draft going back in. */
function settle(): void {
  vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS + 2000);
}

let terminal: ReturnType<typeof makeTerminal>;

beforeEach(() => {
  vi.useFakeTimers();
  broadcasts.length = 0;
  terminal = makeTerminal();
});

afterEach(() => {
  resetTerminalInput(terminal.pty);
  vi.useRealTimers();
});

describe('a terminal nobody is typing in', () => {
  it('takes the message at once, exactly as it always did', () => {
    expect(writeProgrammaticInput(terminal.pty, NOTE, true)).toBe('written');
    expect(terminal.written).toEqual([NOTE]);
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS);
    expect(terminal.written).toEqual([NOTE, '\r']);
  });

  it('takes it at once when the last thing typed there was sent long ago', () => {
    types(terminal.pty, 'fini');
    writeHumanInput(terminal.pty, '\r');
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, NOTE, true);
    expect(terminal.written).toEqual([NOTE]);
  });
});

describe('while JeanBrasse is typing', () => {
  it('writes nothing at all, rather than into the middle of a word', () => {
    types(terminal.pty, 'je pense quil faut');
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS - 1);
    expect(terminal.written).toEqual([]);
  });

  it('waits as long as the typing lasts, not a fixed delay from the first key', () => {
    types(terminal.pty, 'je pense');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(TYPING_PAUSE_MS - 500);
      writeHumanInput(terminal.pty, 'x');
    }
    expect(terminal.typed).not.toContain(NOTE);
  });

  it('holds the message rather than dropping it, and hands it over at the pause', () => {
    types(terminal.pty, 'je pense quil faut');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(terminal.typed).toContain(NOTE);
  });
});

describe('at the pause, with a draft in the field', () => {
  it('sets the draft aside, sends the message alone, and puts the draft back unsent', () => {
    const draft = 'je pense quil faut';
    types(terminal.pty, draft);
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    // Emptied first: the caret walked to the end, then one delete per character.
    expect(terminal.written[0]).toBe('\x7f'.repeat(draft.length));
    // Then the note, and only the note, and only then the submit.
    expect(terminal.written[1]).toBe(NOTE);
    expect(terminal.written).toHaveLength(2);
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS);
    expect(terminal.written[2]).toBe('\r');

    // What the CLI submitted is the note and nothing else.
    expect(terminal.written.slice(0, 3).join('').replace(/\x7f/g, '')).toBe(NOTE + '\r');

    // And the draft comes back, without a carriage return behind it.
    settle();
    const afterSubmit = terminal.written.slice(3);
    expect(afterSubmit.join('')).toBe(draft);
    expect(afterSubmit.join('')).not.toContain('\r');
  });

  it('puts a two-line draft back with its newlines and its caret where they were', () => {
    types(terminal.pty, 'ligne une');
    writeHumanInput(terminal.pty, '\x1b\r');
    types(terminal.pty, 'et ligne deux');
    writeHumanInput(terminal.pty, '\x1b[D'.repeat(5));
    const before = draftOf(terminal.pty);
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    settle();

    const back = terminal.written.slice(terminal.written.indexOf('\r') + 1).join('');
    expect(back).toBe('ligne une\x1b\ret ligne deux' + '\x1b[D'.repeat(5));
    expect(draftOf(terminal.pty)).toEqual(before);
  });

  it('never writes the draft and the message into the same submission', () => {
    types(terminal.pty, 'je pense quil faut');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    settle();

    // The whole stream, the human's keys included, as the CLI read it. One
    // prompt, and the draft is not in it: on the bench, before this existed,
    // that one prompt was "je pense quil faut" + the note.
    expect(submissions(terminal.written)).toEqual([NOTE]);
  });
});

describe('a draft Tars cannot promise to give back', () => {
  it('leaves the field alone and writes nothing, for ever if need be', () => {
    types(terminal.pty, 'je pense quil faut');
    writeHumanInput(terminal.pty, '\t');
    expect(draftOf(terminal.pty).state).toBe('unknown');
    terminal.written.length = 0;

    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 20);
    expect(terminal.written).toEqual([]);
  });

  it('says so, by name, so the wait is never silent', () => {
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');
    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(broadcasts).toContainEqual({
      channel: 'agent:message-waiting',
      payload: { agentId: 'orch', waiting: 1, from: ['Tars-QA'] },
    });
  });

  it('is still there to be read by a panel that opens after the wait began', () => {
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');
    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    // An event is only heard by a window that was already listening. This is
    // the same state, for one that was not.
    expect(messagesWaiting()).toEqual([{ agentId: 'orch', waiting: 1, from: ['Tars-QA'] }]);

    writeProgrammaticInput(terminal.pty, 'et encore un', true, { agentId: 'orch', from: 'Tars-Frontend' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(messagesWaiting()).toEqual([{ agentId: 'orch', waiting: 2, from: ['Tars-QA', 'Tars-Frontend'] }]);

    // And an agent holding nothing is absent, rather than listed as zero.
    writeHumanInput(terminal.pty, '\x03');
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    expect(messagesWaiting()).toEqual([]);
  });

  it('delivers, and takes the notice down, the moment the draft is cleared', () => {
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');
    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    writeHumanInput(terminal.pty, '\x03');
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(terminal.typed).toContain(NOTE);
    expect(broadcasts.at(-1)).toEqual({
      channel: 'agent:message-waiting',
      payload: { agentId: 'orch', waiting: 0, from: [] },
    });
  });

  it('stops taking messages once it is holding all it can, rather than growing without end', () => {
    writeHumanInput(terminal.pty, '\t');
    for (let i = 0; i < 20; i++) {
      expect(writeProgrammaticInput(terminal.pty, `${NOTE} ${i}`, true)).toBe('held');
    }
    expect(writeProgrammaticInput(terminal.pty, NOTE, true)).toBe('refused');
  });
});

describe('a wait that ends by itself', () => {
  it('ends when the person sends what was in the field, with no Ctrl+C needed', () => {
    types(terminal.pty, 'je pense');
    // Tab: the field is now something Tars cannot vouch for.
    writeHumanInput(terminal.pty, '\t');
    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    terminal.written.length = 0;

    // He finishes his sentence and sends it himself.
    types(terminal.pty, ' quand meme');
    writeHumanInput(terminal.pty, '\r');
    // The hook that follows every submission says the field emptied.
    noteSubmitted(terminal.pty);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(terminal.typed).toContain(NOTE);
    expect(messagesWaiting()).toEqual([]);
  });

  it('survived a whole submission and a whole turn before, and only Ctrl+C got out of it', () => {
    // The shape the QA measured, as the counter-case: without the two changes
    // above, everything below leaves the message exactly where it was.
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');
    writeProgrammaticInput(terminal.pty, NOTE, true, { agentId: 'orch', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    writeHumanInput(terminal.pty, '\r');
    noteSubmitted(terminal.pty);
    // A turn of the agent goes by, and another submission after it.
    vi.advanceTimersByTime(60_000);
    types(terminal.pty, 'autre chose');
    writeHumanInput(terminal.pty, '\r');
    noteSubmitted(terminal.pty);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(draftOf(terminal.pty).state).toBe('known');
    expect(terminal.typed).toContain(NOTE);
  });
});

describe('a message whose caller said nothing about itself', () => {
  it('is named from the terminal itself, which says whose it is at the spawn', async () => {
    // Not from a call to rememberTerminalOwner in a test: from the one
    // function that spawns an agent's terminal, which is where a caller that
    // has to remember is a caller that will not.
    const { spawnAgentPty } = await import('../../../electron/core/agent-pty');
    const real = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: '/tmp', cols: 80, rows: 24,
      env: { CLAUDE_AGENT_ID: 'worker-9' },
    });

    writeHumanInput(real, '\t');
    writeProgrammaticInput(real, 'do the thing', true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(messagesWaiting()).toEqual([{ agentId: 'worker-9', waiting: 1, from: [] }]);
    resetTerminalInput(real);
  });

  it('is still announced, under the agent whose terminal it is', () => {
    // /dispatch, /message, Telegram, Slack and the redelivery passed no
    // origin, so `announce` had no agent to name and said nothing at all:
    // no event, nothing in the list, no line.
    rememberTerminalOwner(terminal.pty, 'worker-7');
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');

    writeProgrammaticInput(terminal.pty, 'do the thing', true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(messagesWaiting()).toEqual([{ agentId: 'worker-7', waiting: 1, from: [] }]);
    expect(broadcasts).toContainEqual({
      channel: 'agent:message-waiting',
      payload: { agentId: 'worker-7', waiting: 1, from: [] },
    });
  });

  it('leaves a line saying it is waiting, and another when it goes out', () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(m => { lines.push(String(m)); });
    try {
      rememberTerminalOwner(terminal.pty, 'worker-7');
      types(terminal.pty, 'je pense');
      writeProgrammaticInput(terminal.pty, 'do the thing', true);
      vi.advanceTimersByTime(1000);
      expect(lines.filter(l => l.includes('is waiting for a terminal'))).toHaveLength(1);

      vi.advanceTimersByTime(TYPING_PAUSE_MS);
      settle();
      expect(lines.filter(l => l.includes('is going out now'))).toHaveLength(1);
      // Once per message, not once per attempt: the pause re-arms on every key.
      expect(lines.filter(l => l.includes('is waiting for a terminal'))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('counts what is held even when nobody named its sender', () => {
    rememberTerminalOwner(terminal.pty, 'worker-7');
    types(terminal.pty, 'je pense');
    writeHumanInput(terminal.pty, '\t');

    writeProgrammaticInput(terminal.pty, 'one', true);
    writeProgrammaticInput(terminal.pty, 'two', true, { agentId: 'worker-7', from: 'Tars-QA' });
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    expect(messagesWaiting()).toEqual([{ agentId: 'worker-7', waiting: 2, from: ['Tars-QA'] }]);
  });
});

describe('the write window belongs to Tars alone', () => {
  it('holds the keys typed inside it and replays them after, in order', () => {
    types(terminal.pty, 'je pense');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    terminal.written.length = 0;

    // Three keys landing inside the 300 ms the carriage return trails by:
    // the very race that put "oui" into the note on the bench.
    vi.advanceTimersByTime(120);
    types(terminal.pty, 'oui');
    vi.advanceTimersByTime(PROGRAMMATIC_SUBMIT_DELAY_MS);
    expect(terminal.typed).toBe('\r');

    settle();
    expect(terminal.typed).toBe('\rje penseoui');
    expect(draftOf(terminal.pty).text).toBe('je penseoui');
  });

  it('replays an Enter typed inside it, so a draft finished mid-window is still sent by hand', () => {
    types(terminal.pty, 'je pense');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);

    vi.advanceTimersByTime(100);
    writeHumanInput(terminal.pty, '!');
    writeHumanInput(terminal.pty, '\r');
    settle();

    expect(terminal.typed.endsWith('je pense!\r')).toBe(true);
    expect(draftOf(terminal.pty)).toEqual({ text: '', cursor: 0, state: 'known' });
  });

  it('writes a second message on its own line, never inside the first', () => {
    types(terminal.pty, 'je pense');
    writeProgrammaticInput(terminal.pty, 'premier', true);
    writeProgrammaticInput(terminal.pty, 'second', true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    settle();
    settle();

    expect(submissions(terminal.written)).toEqual(['premier', 'second']);
    // And between the two, and after them, the draft is back where it was.
    expect(draftOf(terminal.pty)).toEqual({ text: 'je pense', cursor: 8, state: 'known' });
  });
});

describe('what a key is', () => {
  it('does not let a mouse report count as typing and hold a message back', () => {
    writeHumanInput(terminal.pty, '\x1b[<64;40;12M');
    writeProgrammaticInput(terminal.pty, NOTE, true);
    expect(terminal.typed).toContain(NOTE);
  });
});

describe('a shell command is not a message', () => {
  it('goes out unchanged: the field there is a shell line, not the CLI field', () => {
    types(terminal.pty, 'echo');
    terminal.written.length = 0;
    writeProgrammaticInput(terminal.pty, "cd '/tars' && claude");
    expect(terminal.written).toEqual(["cd '/tars' && claude\r"]);
  });
});

/**
 * The other half of the hedge: something has to settle it.
 *
 * An Enter on a line beginning with `/` may run a command or open a dialog,
 * and the keys alone cannot tell which, so the model stops vouching for the
 * field. Without a way back, one `/model` would leave a terminal refusing
 * every message until somebody pressed Ctrl+C. The way back is the hook that
 * says a prompt was submitted, and this drives it through the real route.
 */
describe('the hook that says a prompt was submitted', () => {
  it('unblocks a terminal that a slash command left unvouched for', async () => {
    const { agents } = await import('../../../electron/core/agent-manager');
    const { ptyProcesses } = await import('../../../electron/core/pty-manager');
    const { registerHooksRoutes } = await import('../../../electron/services/api-routes/hooks-routes');
    const { EventEmitter } = await import('events');
    type Route = { pattern: string; handler: (req: unknown, res: unknown) => void };
    const routes: Route[] = [];
    const app = {
      routes, add: (_m: string, pattern: string, handler: Route['handler']) => { routes.push({ pattern, handler }); },
      get: () => {}, put: () => {}, delete: () => {},
      post(pattern: string, handler: Route['handler']) { routes.push({ pattern, handler }); },
    };
    registerHooksRoutes(app as never, {
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
      appSettings: {}, getAppSettings: () => ({}), getTelegramBot: () => null, getSlackApp: () => null,
      slackResponseChannel: null, slackResponseThreadTs: null,
      handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(),
      initAgentPtyCallback: vi.fn(), agentStatusEmitter: new EventEmitter(),
    } as never);

    agents.clear();
    ptyProcesses.clear();
    ptyProcesses.set('pty-orch', terminal.pty);
    agents.set('orch', {
      id: 'orch', name: 'Orchestrator', status: 'running', projectPath: process.cwd(),
      skills: [], output: [], ptyId: 'pty-orch', currentSessionId: sid('s1'),
      lastActivity: new Date().toISOString(),
    } as never);

    types(terminal.pty, '/model');
    writeHumanInput(terminal.pty, '\r');
    expect(draftOf(terminal.pty).state).toBe('pending');

    writeProgrammaticInput(terminal.pty, NOTE, true);
    vi.advanceTimersByTime(TYPING_PAUSE_MS * 3);
    expect(terminal.typed).not.toContain(NOTE);

    routes.find(r => r.pattern === '/api/hooks/status')!.handler(
      { body: { agent_id: 'orch', session_id: sid('s1'), status: 'running', event: 'UserPromptSubmit' }, params: {} },
      vi.fn(),
    );
    vi.advanceTimersByTime(TYPING_PAUSE_MS);
    expect(terminal.typed).toContain(NOTE);
    agents.clear();
    ptyProcesses.clear();
  });
});
