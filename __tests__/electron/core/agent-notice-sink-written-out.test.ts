import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The sink of an agent's notices writes each one to be printed (27/11, the Audit's read of #666 at c1384cdd7; the same
 * change as the gemini trust PR's, at the same sink, so it holds whichever lands first).
 *
 * core/agent-manager.ts writes a notice into the agent's kept output, which the Logs page replays in a terminal and
 * get_agent_output hands an orchestrator. A notice can name a folder or a file the agent was saved with, and a direct
 * edit of agents.json or templates.json can put there what every save path refuses, control characters among them.
 *
 * How it fails, written before the code:
 *  1. A notice holding control characters is kept as it comes: replayed, they clear the screen, move the cursor up over
 *     an earlier line, set a title, or end the line and start a forged [Tars] line (ESC, BEL, CR, LF, the C1 CSI, DEL).
 *  2. The notice is cut into two lines by a newline or a tab.
 *  3. Over-escaping: gemini's own notice (its settings file could not be read) reads differently from before.
 *  4. A notice for an agent not in the store goes to the log with the same characters.
 *
 * The negative witness is this PR at d153f347f, whose sink writes the line as it comes.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { agents } from '../../../electron/core/agent-manager';
import { agentNotice } from '../../../electron/core/agent-notices';
import { replayText } from '../../../electron/core/terminal-mirror';
import { geminiSettingsLeft } from '../../../electron/providers/gemini-provider';
import type { AgentStatus } from '../../../electron/types';

/** The Audit's path: a title (OSC 0), a cleared screen, a line end and a forged line, a C1 CSI moving the cursor up, DEL. */
const FORGED = 'x\u{1b}]0;forged\u{7}\u{1b}[2J\r\n[Tars] Forged line\u{9b}1A\u{7f}';
const WRITTEN_OUT = 'x[U+001B]]0;forged[U+0007][U+001B][2J[U+000A][Tars] Forged line[U+009B]1A[U+007F]';
const controls = (s: string) => Array.from(s).filter((ch) => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
});
/** A notice as the sink keeps it, without the line ends it is framed in. */
const inner = (chunk: string) => chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
/** A notice naming a folder the agent was saved with, as the gemini trust PR's say one. */
const naming = (folder: string) => `${folder} is not in this agent's workspace`;

let agent: AgentStatus;

beforeEach(() => {
  agent = {
    id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: os.homedir(), skills: [],
    output: ['earlier line\r\n'], lastActivity: '', provider: 'gemini',
  } as AgentStatus;
  agents.set(agent.id, agent);
});

describe('a notice holding control characters', () => {
  it('1 and 2. is kept as one line, none of them, each written out, and leaves the terminal as it was', () => {
    agentNotice(agent.id, naming(path.join(os.homedir(), '.ssh', FORGED)));
    const said = agent.output.slice(1);
    expect(said).toHaveLength(1);
    expect(controls(inner(said[0]))).toEqual([]);
    expect(said[0]).toContain(WRITTEN_OUT);
    // Replayed in the headless xterm a panel's mirror runs: the earlier line stays, and there is one [Tars] row.
    const rows = replayText(agent.output, { cols: 400, rows: 20 })!;
    expect(rows).toContain('earlier line');
    expect(rows.filter(r => r.startsWith('[Tars]'))).toHaveLength(1);
    expect(rows.join('\n')).toContain('[U+000A][Tars] Forged line');
  });

  it('3. gemini\'s own notice reads as before', () => {
    const sentence = geminiSettingsLeft('unreadable', path.join(os.homedir(), '.gemini', 'settings.json'))!;
    agentNotice(agent.id, sentence);
    expect(agent.output.slice(1)).toEqual([`\r\n[Tars] ${sentence}\r\n`]);
  });

  it('4. an agent not in the store: the log line holds none of them either', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    agentNotice('ag-gone', naming(`/home/me/${FORGED}`));
    const said = log.mock.calls.map(c => c.join(' ')).filter(l => l.includes('Forged line'));
    log.mockRestore();
    expect(said).toHaveLength(1);
    expect(controls(said[0])).toEqual([]);
    expect(said[0]).toContain(WRITTEN_OUT);
  });
});
