import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

/**
 * pi's question whether to trust the project folder, on an agent's screen (#610's L1, the Audit of 20/11).
 *
 * pi 1.5.2 asks it at its start when nothing says whether the folder is trusted: Tars writes the agent's folder into
 * pi's trust.json, but leaves the user's own `false` there, and never trusts the home folder or `/`. Nobody answers it
 * in an agent's terminal, and pi takes no task until it is answered. Drawn as below on the conformance run of 20/11
 * (120x30, the rows as the mirror reads them), its first option selected: Enter answers "Trust".
 *
 * How it fails, written before the code:
 * 1. Not seen as a dialog: nothing keeps a writer from typing into it, and a sender with no deadline (the bots, at
 *    CLI_UP_MS) types its message there; its Enter answers "Trust", the option shown selected, and trusts a folder
 *    the user had refused, or the home folder Tars refused to trust.
 * 2. What it asks about lost: the line must name the folder, which the sender's answer then names.
 * 3. Seen only with its first option selected: an arrow moved to another option is the same question.
 * 4. A folder longer than the terminal is wide, wrapped onto the next row, cut in the line given.
 * 5. A false alarm: the title quoted in the conversation with no answer under it, or the answers' words in prose.
 */

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { attachTerminalMirror, dialogOnScreen, piTrustQuestionOnScreen } from '../../../electron/core/terminal-mirror';
import type { IPty } from 'node-pty';

function mirrored(rows: string[], cols = 120): IPty {
  const data: Array<(chunk: string) => void> = [];
  const pty = {
    onData: (listener: (chunk: string) => void) => { data.push(listener); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    write: vi.fn(), kill: vi.fn(), resize: vi.fn(), pid: 1, process: 'pi',
  };
  attachTerminalMirror(pty as never, { cols, rows: 30, watchRepaint: false, label: 'pi' });
  for (const listener of data) listener('\x1b[2J\x1b[H' + rows.join('\r\n'));
  return pty as never;
}

const FOLDER = '/home/someone/projects/project-a';
/** pi 1.5.2's screen as it asked, on the conformance run of 20/11 (the folder made generic). */
function trustQuestion(selected = 0, folder = FOLDER): string[] {
  const options = [
    'Trust',
    `Trust parent folder (${folder.replace(/\/[^/]+$/, '')})`,
    'Trust (this session only)',
    'Do not trust',
    'Do not trust (this session only)',
  ];
  return [
    "you$ cd '/home/someone/projects/project-a' && '/opt/pi/bin/pi' '--provider' 'tars-endpoint' --model 'stand-in-coder'",
    '─'.repeat(100),
    '',
    ' Trust project folder?',
    ` ${folder}`,
    '',
    ' This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.',
    '',
    ...options.map((option, i) => (i === selected ? ` → ${option}` : `   ${option}`)),
    '',
    ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
    '',
    '─'.repeat(100),
  ];
}

describe("pi's trust question on the screen", () => {
  it('1 and 2: is a dialog nothing is typed into, and names the folder it asks about', () => {
    const pty = mirrored(trustQuestion());
    expect(dialogOnScreen(pty)).toBe(true);
    expect(piTrustQuestionOnScreen(pty)).toBe(`Trust project folder? ${FOLDER}`);
  });

  it('3: whichever option is selected', () => {
    for (const selected of [1, 3, 4]) {
      const pty = mirrored(trustQuestion(selected));
      expect(dialogOnScreen(pty), String(selected)).toBe(true);
      expect(piTrustQuestionOnScreen(pty), String(selected)).toBe(`Trust project folder? ${FOLDER}`);
    }
  });

  it('4: a folder wrapped onto the next row is read whole', () => {
    const long = `/home/someone/${'a-rather-long-folder-name/'.repeat(3)}project-a`;
    const pty = mirrored(trustQuestion(0, long), 52);
    expect(dialogOnScreen(pty)).toBe(true);
    expect(piTrustQuestionOnScreen(pty)).toBe(`Trust project folder? ${long}`);
  });

  it('5: no false alarm from the title or the answers in the conversation', () => {
    const quoted = mirrored([' > pi asked "Trust project folder?" yesterday, and I chose Do not trust.', '', '0.0%/128k (auto)']);
    expect(dialogOnScreen(quoted)).toBe(false);
    expect(piTrustQuestionOnScreen(quoted)).toBeUndefined();
    const prose = mirrored([' Trust project folder?', ' is what it asks; you can answer Trust (this session only).', '', '0.0%/128k (auto)']);
    expect(dialogOnScreen(prose)).toBe(false);
    expect(piTrustQuestionOnScreen(prose)).toBeUndefined();
  });
});
