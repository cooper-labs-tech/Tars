import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'node:os';

/**
 * A dialog on the screen, before the hook that says so has reached Tars.
 *
 * Measured in the in-app proof of this PR (real claude 2.1.280, fullscreen):
 * the PermissionRequest hook came 3 to 648 ms after the dialog was drawn. A
 * message typed in that window goes into the dialog, and its Enter answers it.
 * Both dialogs measured end on a footer that says "Esc to cancel":
 * "Enter to select · ↑/↓ to navigate · Esc to cancel" (AskUserQuestion) and
 * " Esc to cancel · Tab to amend" (a Bash permission). A turn that runs ends on
 * "esc to interrupt".
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A dialog drawn before its hook arrives is typed into.
 * 2. The words of the footer, drawn with cursor moves between them rather than
 *    spaces, are not recognised.
 * 3. A false alarm holds messages for nothing: "Esc to cancel" said in the
 *    conversation, above the input box, or a running turn's footer.
 * The screen is only ever a reason to hold, never a reason to type: a dialog
 * whose hook said so stays a dialog whatever the screen shows.
 */

const { navigatorBefore } = vi.hoisted(() => ({
  navigatorBefore: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
}));
void navigatorBefore;

type FakePty = {
  onData: (listener: (data: string) => void) => { dispose(): void };
  onExit: (listener: (event: { exitCode: number }) => void) => { dispose(): void };
  emit(data: string): void;
  write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; pid: number; process: string;
};
function fakePty(): FakePty {
  const data: Array<(data: string) => void> = [];
  return {
    onData: listener => { data.push(listener); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    emit: chunk => { for (const listener of data) listener(chunk); },
    write: vi.fn(), kill: vi.fn(), resize: vi.fn(), pid: 1, process: '2.1.280',
  };
}
const spawns: FakePty[] = [];
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { const p = fakePty(); spawns.push(p); return p; }) }));
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() }, BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }), Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../../electron/utils/agents-tick', () => ({ scheduleTick: vi.fn() }));
vi.mock('../../../electron/services/agent-events', () => ({ emitAgentStatus: vi.fn() }));

import { attachTerminalMirror, dialogOnScreen } from '../../../electron/core/terminal-mirror';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { agents, wireDialogProbe } from '../../../electron/core/agent-manager';
import { ptyProcesses, writeProgrammaticInput, resetTerminalInput } from '../../../electron/core/pty-manager';
import type { AgentStatus } from '../../../electron/types';
import type { IPty } from 'node-pty';

/** A 120x30 screen whose bottom rows are `rows`, the rest blank. */
function screen(rows: string[]): string {
  return '\x1b[2J\x1b[H' + rows.join('\r\n');
}
function mirrored(rows: string[]): IPty {
  const p = fakePty();
  attachTerminalMirror(p as never, { cols: 120, rows: 30, watchRepaint: false, label: 't' });
  p.emit(screen(rows));
  return p as never;
}

afterEach(() => { agents.clear(); ptyProcesses.clear(); });

describe('a dialog on the screen', () => {
  it('1. is seen in an AskUserQuestion and a permission, from their footers', () => {
    expect(dialogOnScreen(mirrored([
      ' ☐ Cleanup', 'Delete the build folder?', '❯ 1. Yes, delete it', '  2. No, keep it',
      '─'.repeat(100), '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]))).toBe(true);
    expect(dialogOnScreen(mirrored([
      'Bash command', 'Do you want to proceed?', '❯ 1. Yes', '  4. No', ' Esc to cancel · Tab to amend',
    ]))).toBe(true);
  });

  it('2. is seen when the footer is drawn with cursor moves instead of spaces', () => {
    expect(dialogOnScreen(mirrored(['Do you want to proceed?', '❯ 1. Yes', ' Esc\x1b[1Cto\x1b[1Ccancel\x1b[3C·\x1b[1CTab\x1b[1Cto\x1b[1Camend']))).toBe(true);
  });

  it('3. is not seen in a running turn, nor in the conversation above the input box', () => {
    expect(dialogOnScreen(mirrored(['⏺ Running the suite', '✳ Cogitating… (esc to interrupt)', '─'.repeat(100), '❯ ', '─'.repeat(100), '  ? for shortcuts']))).toBe(false);
    expect(dialogOnScreen(mirrored([
      'It said: Esc to cancel', 'and then it closed.', '', '', '─'.repeat(100), '❯ ', '─'.repeat(100), '  ? for shortcuts',
    ]))).toBe(false);
  });

  it('1. holds a message for an agent whose screen shows a dialog its hook has not reported yet', () => {
    wireDialogProbe();
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: os.tmpdir(), cols: 120, rows: 30, env: { CLAUDE_AGENT_ID: 'racer' },
    });
    ptyProcesses.set('pty-racer', terminal);
    agents.set('racer', {
      id: 'racer', name: 'Racer', status: 'running', provider: 'claude', projectPath: os.tmpdir(), skills: [], output: [],
      lastActivity: new Date().toISOString(), ptyId: 'pty-racer',
    } as AgentStatus);
    spawns.at(-1)!.emit(screen(['Delete the build folder?', '❯ 1. Yes, delete it', 'Enter to select · ↑/↓ to navigate · Esc to cancel']));

    const outcome = writeProgrammaticInput(terminal, 'a room post', true, { agentId: 'racer', from: 'JeanBrasse' });

    expect(outcome).toBe('held');
    expect((terminal as unknown as FakePty).write).not.toHaveBeenCalled();
    resetTerminalInput(terminal);
  });
});

describe('send now, in front of a dialog the status has not caught up with', () => {
  // #169's sendNow sends Esc to a busy claude. In a dialog an Esc is "No":
  // measured with claude 2.1.280 in #174's proof, it rejected the tool use.
  // The status can still say running for 1 to 648 ms after the dialog is drawn.
  it('sends no Esc when the screen shows a dialog while the status still says running', async () => {
    wireDialogProbe();
    const terminal = spawnAgentPty({
      binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd: os.tmpdir(), cols: 120, rows: 30, env: { CLAUDE_AGENT_ID: 'sn' },
    });
    ptyProcesses.set('pty-sn', terminal);
    agents.set('sn', {
      id: 'sn', name: 'SN', status: 'running', provider: 'claude', projectPath: '/sn-project', skills: [], output: [],
      lastActivity: new Date().toISOString(), ptyId: 'pty-sn',
    } as AgentStatus);
    spawns.at(-1)!.emit(screen(['Do you want to proceed?', '❯ 1. Yes', ' Esc to cancel · Tab to amend']));
    const { registerBusHandlers } = await import('../../../electron/handlers/bus-handlers');
    registerBusHandlers();

    const result = await ipcHandlers.get('bus:sendNow')!(null, { roomId: 'project:/sn-project', agentId: 'sn', text: 'NOT-INTO-THE-DIALOG' }) as { success: boolean; interrupted: boolean; error?: string };

    expect(result.success, result.error).toBe(true);
    expect(result.interrupted).toBe(false);
    const written = (terminal as unknown as FakePty).write.mock.calls.map(c => String(c[0])).join('');
    expect(written).not.toContain('\x1b');
    expect(written).not.toContain('NOT-INTO-THE-DIALOG');
    resetTerminalInput(terminal);
  }, 20_000);
});
