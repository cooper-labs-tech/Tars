import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A stall, from the check to whoever must hear of it (PLAN-1.9.2.md item B).
 *
 * The rule itself is stall-watch.test.ts. Here the fleet, the terminals and
 * agent-watch are the real ones; ps and the transcripts' dates are handed in.
 *
 * How it fails, written before the code (2026-10-01):
 * 1. The agent is not marked: the window has nothing to show.
 * 2. Nobody is told, or the wrong agent: whoever handed it the work, else its
 *    project's orchestrator, never another project's.
 * 3. It is told at every check for as long as the stall lasts.
 * 4. A write to the transcript, or a status other than running, leaves the
 *    mark; a new silence after that is not reported again.
 */

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-stall-watch-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), dataPath: (f: string) => path.join(tmp, f) };
});

type AgentStatus = import('../../../electron/types').AgentStatus;
let watch: typeof import('../../../electron/services/agent-watch');
let stall: typeof import('../../../electron/services/stall-watch');
let agentManager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 1, 4, 0, 0);
type Proc = { pid: number; ppid: number; stat: string; command: string };

/** A terminal Tars holds, with its pid, recording what is typed into it. */
function terminal(ptyId: string, pid: number): string[] {
  const written: string[] = [];
  ptyManager.ptyProcesses.set(ptyId, { pid, write: (d: string) => { written.push(d); } } as never);
  return written;
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = { status: 'idle', projectPath: '/tars', skills: [], output: [], lastActivity: '', provider: 'claude', ptyId: `pty-${over.id}`, ...over } as AgentStatus;
  if (agent.requestedBy && !agent.requestedBy.ptyId) agent.requestedBy = { ...agent.requestedBy, ptyId: agent.ptyId ?? '' };
  agentManager.agents.set(agent.id, agent);
  return agent;
}

/** The frozen worker's CLI, pid 501 under its shell 500: MCP servers and a dead caffeinate, nothing at work. */
const frozen: Proc[] = [
  { pid: 500, ppid: 1, stat: 'S', command: '/bin/zsh -l' },
  { pid: 501, ppid: 500, stat: 'S', command: '/Users/x/.local/bin/claude' },
  { pid: 502, ppid: 501, stat: 'S', command: 'node /x/mcp-orchestrator/dist/bundle.js' },
  { pid: 503, ppid: 501, stat: 'Z', command: '(caffeinate)' },
];

let writtenAt = NOW - 40 * MIN;
const check = (now = NOW) => stall.checkStalls(now, { procs: async () => frozen, writtenAt: () => writtenAt });
const typed = (t: string[]) => t.join('').replace(/\x1b\[20[01]~/g, '');
/** Long enough for a note being typed in to be done, so the next one is not held behind it. */
const typingDone = () => vi.advanceTimersByTime(ptyManager.TYPING_PAUSE_MS * 20);

beforeEach(async () => {
  vi.resetModules();
  agentManager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  watch = await import('../../../electron/services/agent-watch');
  stall = await import('../../../electron/services/stall-watch');
  agentManager.agents.clear();
  ptyManager.ptyProcesses.clear();
  watch.resetAgentWatch();
  watch.startAgentWatch();
  writtenAt = NOW - 40 * MIN;
});

afterEach(() => {
  watch.stopAgentWatch();
  vi.useRealTimers();
});

describe('a stalled agent', () => {
  it('1, 2. is marked since its last write, and whoever handed it the work is told', async () => {
    const orch = terminal('pty-orch', 400);
    putAgent({ id: 'orch', name: 'Orchestrator', ptyId: 'pty-orch' });
    terminal('pty-w', 500);
    const w = putAgent({ id: 'w', name: 'Frozen Worker', status: 'running', requestedBy: { agentId: 'orch', ptyId: '' } });

    await check();

    expect(w.stalledSince).toBe(new Date(NOW - 40 * MIN).toISOString());
    expect(typed(orch)).toContain('Frozen Worker');
    expect(typed(orch)).toMatch(/nothing to its transcript for 40 minutes/);
  });

  it("2. tells its project's orchestrator when nobody handed it the work, and no other project's", async () => {
    // Another project's orchestrator first in the fleet, so taking the first one found would be seen.
    const other = terminal('pty-other', 401);
    putAgent({ id: 'other', name: 'Elsewhere', role: 'orchestrator', projectPath: '/elsewhere', ptyId: 'pty-other' });
    const lead = terminal('pty-lead', 400);
    putAgent({ id: 'lead', name: 'Lead', role: 'orchestrator', ptyId: 'pty-lead' });
    terminal('pty-w', 500);
    putAgent({ id: 'w', name: 'Frozen Worker', status: 'running' });

    await check();

    expect(typed(lead)).toContain('Frozen Worker');
    expect(typed(other)).toBe('');
  });

  it('3. is told once, however many checks the stall lasts', async () => {
    vi.useFakeTimers();
    const orch = terminal('pty-orch', 400);
    putAgent({ id: 'orch', name: 'Orchestrator', ptyId: 'pty-orch' });
    terminal('pty-w', 500);
    putAgent({ id: 'w', name: 'Frozen Worker', status: 'running', requestedBy: { agentId: 'orch', ptyId: '' } });

    await check();
    typingDone();
    const once = typed(orch);
    expect(once).toContain('Frozen Worker');
    await check(NOW + MIN);
    typingDone();
    await check(NOW + 2 * MIN);
    typingDone();

    expect(typed(orch)).toBe(once);
  });

  it('4. loses its mark when it writes again, or stops running, and a new silence is told again', async () => {
    vi.useFakeTimers();
    const lead = terminal('pty-lead', 400);
    putAgent({ id: 'lead', name: 'Lead', role: 'orchestrator', ptyId: 'pty-lead' });
    terminal('pty-w', 500);
    const w = putAgent({ id: 'w', name: 'Frozen Worker', status: 'running' });

    await check();
    typingDone();
    writtenAt = NOW;
    await check(NOW + MIN);
    expect(w.stalledSince).toBeUndefined();

    await check(NOW + 31 * MIN);
    typingDone();
    expect(w.stalledSince).toBe(new Date(NOW).toISOString());
    expect(typed(lead).match(/Frozen Worker/g)).toHaveLength(2);

    w.status = 'waiting';
    await check(NOW + 32 * MIN);
    expect(w.stalledSince).toBeUndefined();
  });
});
