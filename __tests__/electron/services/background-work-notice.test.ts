import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodeProjectDirName } from '../../../electron/utils/resume-session';

/**
 * The note an orchestrator is owed about work left running in the background
 * (the Audit's gate of #152, its two Lows).
 *
 * A rest with background work left keeps the link to the requester, which is
 * told "you will be told again when it is done".
 *
 * How it fails, written before the code (2026-09-24):
 * 1. The agent is stopped, restarted or crashes before that work reports: the
 *    link names a terminal that is gone, and nothing is ever said. The
 *    orchestrator waits for a note that never comes (on main before #152 it
 *    had at least "has finished its turn").
 * 2. The leftover work is counted from the hand-over, not from the current
 *    session: a resumed session copies the earlier conversation with its old
 *    timestamps, and a background start from before it registered counts as
 *    still running, so every later rest says so and keeps the link.
 */

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
// Made before the imports, with the mock that reads it: a module imported above loads the constants on its way in
// (providers/cline-cli.ts, through utils/resume-session.ts), which runs that mock before a plain const would be set.
const tmp = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  return mkdtempSync(join(tmpdir(), 'tars-bg-notice-'));
});
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), dataPath: (f: string) => path.join(tmp, f) };
});

type AgentStatus = import('../../../electron/types').AgentStatus;
let watch: typeof import('../../../electron/services/agent-watch');
let manager: typeof import('../../../electron/core/agent-manager');
let pty: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');
let truth: typeof import('../../../electron/services/agent-truth');

const PROJECT = '/tars';
const SESSION = '4ab31f00-ce51-4676-ab80-4023cf6e3f4e';
const T0 = Date.now() - 60_000;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function transcript(lines: unknown[]) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}
/** A Bash call run in the background at `s` seconds, as claude 2.1.280 records it. */
const backgroundStart = (s: number, id: string) => [
  { type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input: {} }] } },
  { type: 'user', timestamp: at(s + 1), toolUseResult: { backgroundTaskId: id }, message: { content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: 'running' }] } },
];

function terminal(id: string): string[] {
  const written: string[] = [];
  pty.ptyProcesses.set(`pty-${id}`, { write: (d: string) => { written.push(d); } } as never);
  return written;
}
function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const a = { name: over.id.toUpperCase(), status: 'idle', projectPath: PROJECT, skills: [], output: [], ptyId: `pty-${over.id}`, lastActivity: new Date().toISOString(), ...over } as AgentStatus;
  manager.agents.set(a.id, a);
  return a;
}
const told = (w: string[]) => w.join('').replace(/\x1b\[20[01]~/g, '');
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  pty = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  truth = await import('../../../electron/services/agent-truth');
  manager.agents.clear();
  pty.ptyProcesses.clear();
  truth.clearAgentTruthCache();
  fs.rmSync(path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(PROJECT)), { recursive: true, force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
  // As main.ts starts it.
  watch.watchInterruptedTurns();
});

afterEach(() => { watch.stopAgentWatch(); });

describe('work left running in the background, and the note owed about it', { timeout: 20_000 }, () => {
  it('1. tells the orchestrator when the agent is stopped before that work reported, and spends the link', async () => {
    const orch = terminal('orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle' });
    terminal('w');
    const w = putAgent({
      id: 'w', name: 'Worker', status: 'running', currentSessionId: SESSION,
      workHandedAt: at(0), sessionRegisteredAt: at(0), lastTurnStartedAt: at(1), requestedBy: { agentId: 'orch', ptyId: 'pty-w' },
    });
    transcript(backgroundStart(5, 'bgleft1'));
    w.status = 'idle';
    events.emitAgentStatus('w');
    await settle(800);
    expect(told(orch)).toContain('background work still running');
    orch.length = 0;

    // Stopped, as agent:stop does: the terminal is gone, and nothing is emitted.
    pty.ptyProcesses.delete('pty-w');
    w.ptyId = undefined;
    await settle(3000);

    expect(told(orch)).toContain('was stopped before its background work reported');
    expect(told(orch)).toContain('bgleft1');
    expect(manager.agents.get('w')!.requestedBy).toBeUndefined();
  });

  it('2. does not count a background start copied from before the current session registered', async () => {
    const orch = terminal('orch');
    putAgent({ id: 'orch', name: 'Orchestrator', status: 'idle' });
    terminal('w');
    const w = putAgent({
      id: 'w', name: 'Worker', status: 'running', currentSessionId: SESSION,
      workHandedAt: at(0), sessionRegisteredAt: at(30), lastTurnStartedAt: at(31), requestedBy: { agentId: 'orch', ptyId: 'pty-w' },
    });
    // Copied from the session before the restart, old timestamp and all.
    transcript(backgroundStart(5, 'bgcopied'));
    w.status = 'idle';
    events.emitAgentStatus('w');
    await settle(800);

    expect(told(orch)).toContain('has finished its turn');
    expect(told(orch)).not.toContain('background work still running');
    expect(manager.agents.get('w')!.requestedBy).toBeUndefined();
  });
});
