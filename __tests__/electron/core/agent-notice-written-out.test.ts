import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A notice Tars says in an agent's kept output is written to be printed (27/11, the Audit's read of #666 at c1384cdd7,
 * which found the same Low here).
 *
 * gemini's and Qwen Code's notice of a folder split at a comma, and grok's of the secondary folder it is not handed,
 * name a folder the agent was saved with. Every save path refuses a folder holding control characters; a direct edit of
 * agents.json or templates.json does not. The sink in core/agent-manager.ts writes the notice into the kept output,
 * which the Logs page replays in a terminal and get_agent_output hands an orchestrator.
 *
 * How it fails, written before the code:
 *  1. A notice naming such a folder carries its control characters into the kept output as they are: replayed, they
 *     clear the screen, move the cursor up over an earlier line, set a title, or end the line and start a forged
 *     [Tars] line (ESC, BEL, CR, LF, the C1 CSI, DEL).
 *  2. The notice is cut into two lines by a newline or a tab in the folder.
 *  3. One provider's notice is written out and another's is not: the fix belongs in the one sink, not in each sentence.
 *  4. Over-escaping: a notice naming a plain folder reads differently from before.
 *  5. A notice for an agent not in the store goes to the log with the same characters.
 *
 * The negative witness is #636 at 3f2c521b7, whose sink writes the line as it comes.
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
import { GrokProvider } from '../../../electron/providers/grok-provider';
import { splitFolderSentence } from '../../../electron/providers/added-folders';
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

const EARLIER = 'earlier line\r\n';
let agent: AgentStatus;

beforeEach(() => {
  agent = {
    id: `ag-${Math.random().toString(16).slice(2, 8)}`, status: 'idle', projectPath: os.homedir(), skills: [],
    output: [EARLIER], lastActivity: '', provider: 'grok',
  } as AgentStatus;
  agents.set(agent.id, agent);
});

/** The kept output replayed in the headless xterm a panel's mirror runs: the earlier line stays, one [Tars] row. */
function expectTerminalAsItWas(): void {
  const rows = replayText(agent.output, { cols: 400, rows: 20 })!;
  expect(rows).toContain('earlier line');
  expect(rows.filter(r => r.startsWith('[Tars]'))).toHaveLength(1);
  expect(rows.join('\n')).toContain('[U+000A][Tars] Forged line');
}

describe('a notice naming a saved folder that holds control characters', () => {
  it('1 and 2. grok\'s, at its launch: one line, none of them, each written out, the terminal as it was', () => {
    new GrokProvider().buildInteractiveCommand({
      agentId: agent.id, binaryPath: '/opt/bin/grok', prompt: 'go', secondaryProjectPath: path.join(os.homedir(), '.ssh', FORGED),
    } as never);
    const said = agent.output.slice(1);
    expect(said).toHaveLength(1);
    expect(controls(inner(said[0]))).toEqual([]);
    expect(said[0]).toContain(WRITTEN_OUT);
    expectTerminalAsItWas();
  });

  it('3. gemini\'s sentence (and Qwen Code\'s, the same) through the same sink', () => {
    agentNotice(agent.id, splitFolderSentence('gemini', path.join(os.homedir(), `${FORGED}, Inc`)));
    const said = agent.output.slice(1);
    expect(said).toHaveLength(1);
    expect(controls(inner(said[0]))).toEqual([]);
    expect(said[0]).toContain(`${WRITTEN_OUT}, Inc`);
    expectTerminalAsItWas();
  });

  it('4. a plain folder reads as before', () => {
    new GrokProvider().buildInteractiveCommand({
      agentId: agent.id, binaryPath: '/opt/bin/grok', prompt: 'go', secondaryProjectPath: '/home/me/other',
    } as never);
    expect(agent.output.slice(1)).toEqual([
      '\r\n[Tars] Tars does not hand grok its secondary folder yet, so /home/me/other is not in this agent\'s workspace\r\n',
    ]);
  });

  it('5. an agent not in the store: the log line holds none of them either', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    agentNotice('ag-gone', splitFolderSentence('Qwen Code', `/home/me/${FORGED}, Inc`));
    const said = log.mock.calls.map(c => c.join(' ')).filter(l => l.includes('Forged line'));
    log.mockRestore();
    expect(said).toHaveLength(1);
    expect(controls(said[0])).toEqual([]);
    expect(said[0]).toContain(WRITTEN_OUT);
  });
});
