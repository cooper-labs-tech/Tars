import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { terminalModesAfter } from '../../../electron/utils/terminal-modes';

/**
 * A panel that replays an agent's kept output starts in the modes the CLI left
 * set, however much of the output was trimmed.
 *
 * Found by the Frontend on #101: after a long turn with no input, a Claude Code
 * panel remounted at the same size no longer passed the wheel on. agent.output
 * keeps 600 chunks and trims to 400, and Claude Code 2.1.273 in fullscreen
 * writes the alternate screen, bracketed paste, focus events and the hidden
 * cursor once, at start. The mouse request comes back on a key or a resize,
 * never during a turn. Measured on a real session: 649 chunks and not one mode
 * over a four and a half minute turn, and after the trim that took the start
 * the replay began on the normal screen, with no mouse request and no bracketed
 * paste, which xterm needs to send a paste as a paste rather than as lines.
 *
 * Every case goes through appendAgentOutput, the function the five PTY
 * handlers call, and reads the chunks a panel would replay.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-output-modes-'));

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json') };
});

vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.7.2' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

let manager: typeof import('../../../electron/core/agent-manager');

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
});

afterEach(() => {
  manager.stopAgentAutosave();
});

/** What Claude Code 2.1.273 writes at start in fullscreen, mode sequences only, as measured. */
const CLAUDE_START = [
  '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l',
  '\x1b[?2004h\x1b[?2031h\x1b[?1004h',
];
/** The same modes, as the first chunk of a replay. */
const CLAUDE_MODES = '\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l';

/** Repaints of a turn with no input: they move the cursor and set no mode. */
const frames = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `\x1b[28;3H\x1b[2K✻ Cogitating… ${from + i}s`);

/**
 * The chunks a panel mounted after these would replay. The first trim comes
 * with chunk 601 and drops 201, so a stream of exactly 601 keeps its last 400.
 */
function replayAfter(stream: string[]): string[] {
  const agent = { id: 'replayed', output: [] as string[] };
  for (const chunk of stream) manager.appendAgentOutput(agent as never, chunk);
  return agent.output;
}

describe('what a trim carries into the replay', () => {
  it('puts the alternate screen and the mouse request back in front once the chunks that asked are gone', () => {
    const stream = [...CLAUDE_START, 'welcome', ...frames(598)];

    const replay = replayAfter(stream);

    expect(replay.some(chunk => CLAUDE_START.includes(chunk)), 'the start was not trimmed, so this proves nothing').toBe(false);
    expect(replay[0]).toBe(CLAUDE_MODES);
    expect(replay.slice(1)).toEqual(stream.slice(-400));
  });

  it('does not bring back a mode that was set and then reset', () => {
    const replay = replayAfter([
      ...CLAUDE_START,
      ...frames(3),
      // Leaving fullscreen: the mouse and the paste mode go, the screen stays.
      '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l',
      ...frames(600, 3),
    ]);

    expect(replay[0]).toBe('\x1b[?1049h\x1b[?1004h\x1b[?25l');
  });

  it('adds nothing once every mode that was set has been reset', () => {
    const stream = [...CLAUDE_START, '\x1b[?1049l\x1b[?1000l\x1b[?2004l\x1b[?1004l\x1b[?1006l\x1b[?25h', ...frames(598)];

    const replay = replayAfter(stream);

    expect(replay).toEqual(stream.slice(-400));
  });

  it('keeps one mouse protocol and one encoding, the last requested, as the terminal does', () => {
    const replay = replayAfter(['\x1b[?1003h\x1b[?1016h', '\x1b[?1000h\x1b[?1006h', '\x1b[?1049h', '\x1b[?47h', ...frames(600)]);

    expect(replay[0]).toBe('\x1b[?47h\x1b[?1000h\x1b[?1006h');
  });

  it('starts over at ESC c, which leaves the hidden cursor hidden as xterm 5.3 does', () => {
    // RIS resets the screen, the mouse and the DEC private modes; in xterm
    // 5.3 only 25 and DECSTR change the cursor's visibility.
    const replay = replayAfter([...CLAUDE_START, 'a screen', '\x1bc', '\x1b[?1002h', ...frames(600)]);

    expect(replay[0]).toBe('\x1b[?1002h\x1b[?25l');
  });

  it('reads every mode of a mixed request, and writes each one back on its own', () => {
    // ?25;1002h shows the cursor again and asks for the mouse. The renderer
    // swallows a mouse request only when all its modes are mouse modes, so a
    // mixed one written back would hand the mouse to xterm itself.
    const replay = replayAfter(['\x1b[?25l', '\x1b[?1049;1006h', '\x1b[?25;1002h', ...frames(600)]);

    expect(replay[0]).toBe('\x1b[?1049h\x1b[?1002h\x1b[?1006h');
  });

  it('reads a request written with the 8-bit CSI, and keeps application cursor keys', () => {
    const replay = replayAfter(['\x9b?1049h', '\x1b[?1h', ...frames(600)]);

    expect(replay[0]).toBe('\x1b[?1049h\x1b[?1h');
  });

  it('adds nothing for output that set no mode', () => {
    const stream = ['plain text\r\n', '\x1b[31mred\x1b[0m', '\x1b[2J\x1b[H', '\x1b[?2031h', ...frames(597)];

    const replay = replayAfter(stream);

    expect(replay).toEqual(stream.slice(-400));
  });

  it('clears the DEC private modes at a soft reset, and leaves the screen and the mouse', () => {
    const replay = replayAfter([...CLAUDE_START, '\x1b[?1h', '\x1b[!p', ...frames(600)]);

    expect(replay[0]).toBe('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
  });
});

describe('across trims', () => {
  it('follows the state through every later trim, a reset trimmed in between included', () => {
    const replay = replayAfter([...CLAUDE_START, ...frames(700), '\x1b[?1000l\x1b[?2004l', ...frames(1500, 700)]);

    expect(replay[0]).toBe('\x1b[?1049h\x1b[?1006h\x1b[?1004h\x1b[?25l');
    expect(replay.filter(chunk => chunk.includes('\x1b[?1049h'))).toHaveLength(1);
  });

  it.each([['7-bit', '\x1b['], ['8-bit', '\x9b']])('finishes a request that the trim cut in two (%s CSI)', (_, csi) => {
    // The first trim happens at chunk 601 and drops 201 chunks: chunk 200
    // ends inside the request and chunk 201 holds its end.
    const stream = [...frames(200), `${csi}?10`, '49h\x1b[?1003h\x1b[?1006h', ...frames(399, 200)];

    const replay = replayAfter(stream);

    expect(replay[0]).toBe(`${csi}?10`);
    expect(replay[1]).toBe(stream[201]);
    expect(terminalModesAfter(replay.join(''))).toMatchObject({ screen: 1049, mouse: 1003, encoding: 1006 });
  });

  it('replays into the same modes as the whole stream, for any mix of requests, resets and cuts', () => {
    // A fixed seed: the same 150 streams on every run.
    let seed = 0x9e3779b9;
    const random = (n: number) => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed % n;
    };
    const pieces = [
      '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1b[?1047l', '\x1b[?1000h', '\x1b[?1002h', '\x1b[?1003l',
      '\x1b[?9h', '\x1b[?1006h', '\x1b[?1016h', '\x1b[?1006l', '\x1b[?2004h', '\x1b[?2004l', '\x1b[?1004h',
      '\x1b[?1h', '\x1b[?1l', '\x1b[?25l', '\x1b[?25h', '\x1b[?25;1002h', '\x1bc', '\x1b[!p', '\x9b?1049h',
      'text', '\x1b[2K', '\r\n',
    ];

    for (let run = 0; run < 150; run++) {
      const text = Array.from({ length: 900 + random(900) }, () => pieces[random(pieces.length)]).join('');
      // Cut anywhere, sequences included, as PTY reads do.
      const stream: string[] = [];
      for (let at = 0; at < text.length;) {
        const size = 1 + random(12);
        stream.push(text.slice(at, at + size));
        at += size;
      }

      const replay = replayAfter(stream);

      expect(terminalModesAfter(replay.join('')), `stream ${run}`).toEqual(terminalModesAfter(text));
    }
  });
});
