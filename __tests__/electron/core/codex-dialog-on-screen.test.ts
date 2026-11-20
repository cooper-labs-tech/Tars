import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';

/**
 * codex's approval dialogs on an agent's screen (2.0.4).
 *
 * codex says in no file that it waits on an approval: its terminal is where Tars sees one (codexDialogOnScreen),
 * for the agent's status (services/codex-sessions.ts) and so that nothing is typed into it (dialogOnScreen), where
 * an Enter answers it. Measured on codex-cli 0.163.0 in normal mode, asked to call a tool of an MCP server: before
 * each call it draws a form, the rows below as the PTY drew them (120x30, rendered by xterm), and calls nothing
 * until it is answered; Enter submits the option it shows selected, Allow. A command it wants to run outside its
 * sandbox gets the other dialog, its title and answers from codex's own strings.
 *
 * The ways it fails:
 * 1. The tool call's form not seen: the agent reads running while codex waits for good, and a message delivered
 *    into it ends on an Enter that allows the call in the user's name.
 * 2. A command's dialog not seen.
 * 3. What it asks about lost: the line must name the tool, or the command.
 * 4. An option row read as what it asks about, or the end of one carried onto the next row: in a terminal narrower
 *    than the form (an agent's panel, 86 columns in the specs), "Always allow"'s description runs onto a row of
 *    its own.
 * 5. A false alarm: a title quoted in the conversation, with no answer under it.
 * 6. (Train 2b of 2.0.4, written before the fix) A title longer than the terminal is wide not seen: the
 *    orchestrator layout gives a worker about 52 columns, and `Allow the claude-mgr-orchestrator MCP server to run
 *    tool "send_message"?` is 72 characters. Wrapped by the terminal onto the next row (the stand-in prints it as
 *    one line), or laid out by codex itself over two rows, it was read one row at a time, matched no title, and
 *    dialogOnScreen fell with it: a message typed into the terminal could answer the dialog.
 */

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { attachTerminalMirror, codexDialogOnScreen, dialogOnScreen } from '../../../electron/core/terminal-mirror';
import type { IPty } from 'node-pty';

function mirrored(rows: string[], cols = 120): IPty {
  const data: Array<(chunk: string) => void> = [];
  const pty = {
    onData: (listener: (chunk: string) => void) => { data.push(listener); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    write: vi.fn(), kill: vi.fn(), resize: vi.fn(), pid: 1, process: 'codex',
  };
  attachTerminalMirror(pty as never, { cols, rows: 30, watchRepaint: false, label: 'codex' });
  for (const listener of data) listener('\x1b[2J\x1b[H' + rows.join('\r\n'));
  return pty as never;
}

/** codex 0.163.0's screen as it waited to call ping, a tool of the MCP server named probe (measured 2026-10-18). */
const TOOL_CALL = [
  '',
  ' >_ OpenAI Codex (v0.163.0)',
  '    /private/var/folders/yp/j2nr6k4915z_bnf3tjv22t940000gn/T/dbe-codex-mcp-approval/home/projects/demo',
  '', '',
  '› Call the ping tool of the probe MCP server exactly once, then reply with exactly: PONG DONE',
  '', '',
  '◦ Calling probe.ping',
  '    + Show details',
  '', '', '', '', '', '', '', '', '', '', '', '',
  '  Field 1/1',
  '  Allow the probe MCP server to run tool "ping"?',
  '  › 1. Allow                   Run the tool and continue',
  '    2. Allow for this session  Run the tool and remember this choice for this session',
  '    3. Always allow            Run the tool and remember this choice for future tool calls',
  '    4. Cancel                  Cancel this tool call',
  '  enter to submit | esc to cancel',
];

describe("codex's approval on the screen", () => {
  it("1, 3, 4. a tool call's form is seen, named by its title, not by an option", () => {
    const pty = mirrored(TOOL_CALL);
    expect(codexDialogOnScreen(pty)).toBe('Allow the probe MCP server to run tool "ping"?');
    expect(dialogOnScreen(pty)).toBe(true);
  });

  it('4. the end of an option, on a row of its own in a narrower terminal, is not what it asks about', () => {
    const title = 'Allow the probe MCP server to run tool "ping"?';
    expect(codexDialogOnScreen(mirrored(TOOL_CALL, 86))).toBe(title);
    const at = TOOL_CALL.findIndex(row => row.includes('3. Always allow'));
    expect(codexDialogOnScreen(mirrored([
      ...TOOL_CALL.slice(0, at), '    3. Always allow            Run the tool and remember this choice for future tool', '                               calls', ...TOOL_CALL.slice(at + 1),
    ]))).toBe(title);
  });

  it("2, 3. a command's dialog is seen, with the command", () => {
    const pty = mirrored([
      '  Would you like to run the following command?', '', '  $ npm test', '',
      '› 1. Yes, proceed (y)', "  2. Yes, and don't ask again for this command in this session (a)",
      '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel',
    ]);
    expect(codexDialogOnScreen(pty)).toBe('Would you like to run the following command? $ npm test');
    expect(dialogOnScreen(pty)).toBe(true);
  });

  it('5. a title quoted in the conversation is no dialog, nor the form once it is answered', () => {
    expect(codexDialogOnScreen(mirrored([
      '› Should it say: Allow the probe MCP server to run tool "ping"?', '', '• It asks before each call.', '', '› ',
    ]))).toBeUndefined();
    expect(codexDialogOnScreen(mirrored([...TOOL_CALL.slice(0, 9), '• Called probe.ping', '  └ pong', '', '• PONG DONE', '', '› ']))).toBeUndefined();
  });
});

describe('a title wider than the terminal', () => {
  const title = 'Allow the claude-mgr-orchestrator MCP server to run tool "send_message"?';
  const at = TOOL_CALL.findIndex(row => row.includes('MCP server to run tool'));
  const withTitle = (...rows: string[]) => [...TOOL_CALL.slice(0, at), ...rows, ...TOOL_CALL.slice(at + 1)];

  it.each([72, 60, 52])('6. wrapped by a terminal of %i columns onto the next row, is seen whole', (cols) => {
    const pty = mirrored(withTitle(`  ${title}`), cols);
    expect(codexDialogOnScreen(pty)).toBe(title);
    expect(dialogOnScreen(pty)).toBe(true);
  });

  it('6. laid out by codex over two rows of 52 columns, is seen whole', () => {
    const pty = mirrored(withTitle('  Allow the claude-mgr-orchestrator MCP server to', '  run tool "send_message"?'), 52);
    expect(codexDialogOnScreen(pty)).toBe(title);
    expect(dialogOnScreen(pty)).toBe(true);
  });
});
