import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A notice of Tars's about an agent (core/agent-notices.ts: its conversation starts over, a Goose agent's when its
 * servers changed, a Cline agent's at every restart) goes into the agent's kept output, where a person reads it: Logs
 * replays that output through a headless terminal (services/log-search.ts, core/terminal-mirror.ts replayText) and
 * shows the lines it leaves.
 *
 * How it fails, written before the code:
 * 1. (Found by the Cline conformance on 187508db4) The notice written while the kept output is on an alternate
 *    screen: a restart kills a TUI that never left it (Cline's, Goose's), the notice lands on that screen, and the
 *    next TUI's own switch to it wipes the notice. Logs never shows it, and its check in the conformance found nothing.
 * 2. The alternate screen left by restoring a saved cursor (?1049l) on a stream already on the normal screen: the
 *    notice is printed over the lines before it.
 * 3. The modes a trimmed replay starts in no longer read the stream: after the notice the screen is the normal one,
 *    and the next TUI's switch sets the alternate one again.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-notice-shown-'));

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
let notices: typeof import('../../../electron/core/agent-notices');
let mirror: typeof import('../../../electron/core/terminal-mirror');
let modes: typeof import('../../../electron/utils/terminal-modes');

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  notices = await import('../../../electron/core/agent-notices');
  mirror = await import('../../../electron/core/terminal-mirror');
  modes = await import('../../../electron/utils/terminal-modes');
});

afterEach(() => {
  manager.stopAgentAutosave();
  manager.agents.clear();
});

const LINE = 'Its conversation starts over: Cline cannot fork a session, and a restart cannot continue the one it stops.';
const banner = 'project-a $ exec cline -i\r\n';
/** A full-screen TUI's start, and its field and footer, as Cline 3.0.74 draws them. */
const tui = (n: number) => `\x1b[?1049h\x1b[H\x1b[2J\x1b[1;1H❯ the field of the TUI ${n}\x1b[3;1HAuto-approve all enabled (Shift+Tab)`;

/** An agent of the fleet whose kept output already holds `chunks`, and what Logs shows once `then` follows the notice. */
function shown(chunks: string[], then: string[]): { lines: string[]; output: string[] } {
  const agent = { id: 'eeee5555-0000-4000-8000-0000000000c2', name: 'Worker', output: [] as string[] };
  manager.agents.set(agent.id, agent as never);
  for (const chunk of chunks) manager.appendAgentOutput(agent as never, chunk);
  notices.agentNotice(agent.id, LINE);
  for (const chunk of then) manager.appendAgentOutput(agent as never, chunk);
  return { lines: mirror.replayText(agent.output, { cols: 120, rows: 40 }) ?? [], output: agent.output };
}

describe("a notice of Tars's, as Logs shows it", () => {
  it('is shown after a TUI killed on its alternate screen, and the next TUI started on its own (1)', () => {
    const { lines } = shown([banner, tui(1)], [banner, tui(2)]);
    expect(lines.some((l) => l.includes(`[Tars] ${LINE}`)), lines.join('\n')).toBe(true);
    expect(lines.some((l) => l.includes('the field of the TUI 2'))).toBe(true);
  });

  it('is printed after the lines of a stream on the normal screen, over none of them, a cursor saved or not (2)', () => {
    const { lines } = shown(['\x1b7', 'line A\r\nline B\r\nline C\r\n'], []);
    expect(lines).toEqual(['line A', 'line B', 'line C', `[Tars] ${LINE}`]);
  });

  it('leaves the modes a replay starts in reading the stream: normal after it, the next TUI\'s screen after that (3)', () => {
    const before = shown([banner, tui(1)], []);
    expect(modes.terminalModesAfter(before.output.join('')).screen).toBe(0);
    const after = shown([banner, tui(1)], [banner, tui(2)]);
    expect(modes.terminalModesAfter(after.output.join('')).screen).toBe(1049);
  });
});
