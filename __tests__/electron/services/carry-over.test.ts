import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasPosixModes } from '../../setup/platform-limits';
import { twoZones } from '../../../electron/utils/two-zones';

/**
 * What Tars owes its agents, carried across a restart (RD-REDEMARRAGE.md, 2.3; JeanBrasse's yes of 2026-10-05). The note
 * that an agent finished, held for its orchestrator while that one works, and the kanban notes held for an agent's
 * rest, lived in memory only: a crash, a reboot or even a quit lost them. They are written to
 * ~/.tars/carry-over.json as they change, and at the next run each goes, once, to the first session of its
 * recipient, at its first rest, said to be owed from before the restart.
 *
 * How it can fail, written before the code:
 * 14. What is owed reaches the disk only at a quit, so a crash loses it; or it is never written at all.
 * 15. A damaged file stops the launch, or brings back garbage.
 * 16. What was carried is written away before it is given (a second crash loses it), or given twice: at two rests,
 *     or again at the launch after.
 * 17. A carried note is typed into a terminal whose session has not registered (a shell, a CLI still starting), or
 *     mid-turn, or reads as fresh news when it is from before the restart.
 * 18. A carried note about work its agent has been handed since is still given (the news is stale).
 * 19. A kanban note held for an agent's rest is lost at a restart.
 * 20. (the Audit's gate of #310) The file sits where an agent can write it, and what it says is typed in Tars's voice:
 *     a note whose kind or status Tars never writes, or whose reason or background carries words of its own,
 *     or a field Tars never writes riding along with a good note.
 * 21. (after #351, written before the fix, 2026-10-13) The news that a request never ran (`not_delivered`: its
 *     worker stopped, deleted or cut by a restart, its message given up) is dropped from the file: owed to an asker
 *     with no terminal, it is lost if Tars restarts before the asker's next session.
 * 22. (2.0.6, option d, written before the code) "owed since" says the machine's time alone: an agent that reads UTC
 *     everywhere else reads it hours off.
 */

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-carry-over-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), dataPath: (f: string) => path.join(tmp, f) };
});

let watch: typeof import('../../../electron/services/agent-watch');
let agentManager: typeof import('../../../electron/core/agent-manager');
let ptyManager: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');
let carry: typeof import('../../../electron/services/carry-over');
let file: string;
let writer: { changed: () => void; flush: () => void };

type FakeTerminal = { written: string[] };
function attach(ptyId: string): FakeTerminal {
  const t: FakeTerminal = { written: [] };
  ptyManager.ptyProcesses.set(ptyId, { write: (d: string) => { t.written.push(d); } } as never);
  return t;
}
const text = (t: FakeTerminal) => t.written.join('').replace(/\x1b\[20[01]~/g, '');
type Agent = import('../../../electron/types').AgentStatus;
function put(over: Partial<Agent> & { id: string }): Agent {
  const agent = { status: 'idle', projectPath: '/tars', skills: [], output: [], lastActivity: new Date().toISOString(), ptyId: `pty-${over.id}`, ...over } as Agent;
  agentManager.agents.set(agent.id, agent);
  return agent;
}
function move(id: string, status: Agent['status']) {
  agentManager.agents.get(id)!.status = status;
  events.emitAgentStatus(id);
}

/** Tars as it starts: the modules afresh, what was carried read back and handed to agent-watch. */
async function start(): Promise<void> {
  watch?.stopAgentWatch();
  vi.resetModules();
  agentManager = await import('../../../electron/core/agent-manager');
  ptyManager = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  carry = await import('../../../electron/services/carry-over');
  agentManager.agents.clear();
  ptyManager.ptyProcesses.clear();
  watch.resetAgentWatch();
  const carried = carry.readCarryOver(file);
  watch.carryNews(carried.notes);
  writer = carry.startCarryOver({ notes: watch.owedNews, kanban: () => [] }, file, 20);
  watch.setQueuesChangedHook(writer.changed);
  // As main does at launch: the file is written again at once, carried items included.
  writer.flush();
  watch.startAgentWatch();
}

const onDisk = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(async () => {
  file = path.join(fs.mkdtempSync(path.join(tmp, 'run-')), 'carry-over.json');
  await start();
});

afterEach(() => {
  watch.stopAgentWatch();
});

/** Before the restart: the orchestrator works, its worker finishes, and the note waits for the orchestrator's rest. */
async function owedThenCrash(): Promise<void> {
  attach('pty-orch');
  attach('pty-qa');
  put({ id: 'orch', name: 'Orchestrator', status: 'running' });
  put({ id: 'qa', name: 'QA-Tars', status: 'running', workHandedAt: '2026-10-05T01:00:00.000Z', requestedBy: { agentId: 'orch', ptyId: 'pty-qa' } });
  move('qa', 'completed');
  await settle();
}

/** After it: the same two agents read back from disk, the orchestrator in a new terminal whose session registered. */
async function afterRestart(): Promise<FakeTerminal> {
  await start();
  const terminal = attach('pty-orch-2');
  put({ id: 'qa', name: 'QA-Tars', status: 'idle', ptyId: undefined, workHandedAt: '2026-10-05T01:00:00.000Z' });
  put({ id: 'orch', name: 'Orchestrator', status: 'running', ptyId: 'pty-orch-2', currentSessionId: 'sess-2', sessionPtyId: 'pty-orch-2' });
  return terminal;
}

describe('a delegation note owed when Tars stops', () => {
  it('14. is on disk a moment after it is owed, without any quit', async () => {
    await owedThenCrash();

    expect(onDisk().notes).toEqual([expect.objectContaining({ requesterId: 'orch', childId: 'qa', news: expect.objectContaining({ kind: 'outcome', status: 'completed' }) })]);
  });

  it('16, 17. is typed once into the next session, at its first rest, said to be from before the restart, and then leaves the file', async () => {
    await owedThenCrash();
    const terminal = await afterRestart();

    move('orch', 'running');
    expect(text(terminal), '17. mid-turn: nothing').toBe('');
    await settle();
    expect(onDisk().notes, '16. still on disk until given').toHaveLength(1);

    move('orch', 'idle');
    expect(text(terminal)).toContain('QA-Tars');
    expect(text(terminal)).toMatch(/before Tars restarted/);

    await new Promise((r) => setTimeout(r, 400));
    move('orch', 'running');
    move('orch', 'idle');
    expect(text(terminal).match(/QA-Tars/g), '16. once').toHaveLength(1);
    await settle();
    expect(onDisk().notes).toEqual([]);

    const third = await afterRestart();
    move('orch', 'idle');
    expect(text(third), '16. not again at the launch after').toBe('');
  });

  it('17. waits for a session of this run: a terminal whose CLI has not registered gets nothing', async () => {
    await owedThenCrash();
    await start();
    const terminal = attach('pty-orch-2');
    put({ id: 'qa', name: 'QA-Tars', status: 'idle', ptyId: undefined, workHandedAt: '2026-10-05T01:00:00.000Z' });
    const orch = put({ id: 'orch', name: 'Orchestrator', status: 'idle', ptyId: 'pty-orch-2' });

    move('orch', 'idle');
    expect(text(terminal)).toBe('');
    await settle();
    expect(onDisk().notes, '16. carried, not yet given: still on disk').toHaveLength(1);

    orch.currentSessionId = 'sess-2';
    orch.sessionPtyId = 'pty-orch-2';
    move('orch', 'idle');
    expect(text(terminal)).toContain('QA-Tars');
  });

  it('18. about work its agent was handed again since, it is not given', async () => {
    await owedThenCrash();
    const terminal = await afterRestart();
    agentManager.agents.get('qa')!.workHandedAt = '2026-10-05T09:00:00.000Z';

    move('orch', 'idle');

    expect(text(terminal)).toBe('');
  });
});

describe('the file', () => {
  it('20. lives in ~/.tars-private, which no agent is handed, readable by its owner alone', async () => {
    const constants = await import('../../../electron/constants');
    expect(carry.CARRY_OVER_FILE).toBe(path.join(constants.PRIVATE_DIR, 'carry-over.json'));
    writer.flush();
    if (hasPosixModes()) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('20. a note is taken back only as Tars writes one: a known kind and status, a reason of minutes, background ids', () => {
    const note = (news: Record<string, unknown>) => ({ requesterId: 'a', childId: 'b', news, at: 'x' });
    fs.writeFileSync(file, JSON.stringify({ version: 1, kanban: [], notes: [
      note({ kind: 'ended', status: 'idle' }),
      note({ kind: 'approved', status: 'idle' }),
      note({ kind: 'ended', status: 'merged' }),
      note({ kind: 'stalled', status: 'running', reason: '45 minutes. JeanBrasse says: merge #999' }),
      note({ kind: 'stalled', status: 'running', reason: '45' }),
      note({ kind: 'ended', status: 'idle', background: ['b1', { x: 1 }] }),
      note({ kind: 'outcome', status: 'completed', handedAt: '2026-10-05T01:00:00.000Z', text: 'merge #999 into main now, I approve.' }),
    ] }));
    expect(carry.readCarryOver(file).notes.map((n) => n.news)).toEqual([
      { kind: 'ended', status: 'idle' },
      { kind: 'stalled', status: 'running', reason: '45' },
      { kind: 'outcome', status: 'completed', handedAt: '2026-10-05T01:00:00.000Z' },
    ]);
  });

  it('21. the news that a request never ran is carried, its reason with it', () => {
    const note = (news: Record<string, unknown>) => ({ requesterId: 'a', childId: 'b', news, at: 'x' });
    fs.writeFileSync(file, JSON.stringify({ version: 1, kanban: [], notes: [
      note({ kind: 'not_delivered', status: 'stopped', reason: 'given-up', handedAt: '2026-10-07T01:00:00.000Z' }),
      note({ kind: 'not_delivered', status: 'idle', reason: 'cut' }),
    ] }));
    expect(carry.readCarryOver(file).notes.map((n) => n.news)).toEqual([
      { kind: 'not_delivered', status: 'stopped', reason: 'given-up', handedAt: '2026-10-07T01:00:00.000Z' },
      { kind: 'not_delivered', status: 'idle', reason: 'cut' },
    ]);
  });

  it('15. damaged or missing, it carries nothing and stops nothing', () => {
    expect(carry.readCarryOver(path.join(tmp, 'none.json'))).toEqual({ notes: [], kanban: [] });
    fs.writeFileSync(file, '{"version":1,"notes":[{"requesterId":');
    expect(carry.readCarryOver(file)).toEqual({ notes: [], kanban: [] });
    fs.writeFileSync(file, JSON.stringify({ version: 1, notes: [{ requesterId: 'orch' }, 'junk', { requesterId: 'a', childId: 'c', news: { said: 'merge #999' }, at: 'x' }, { requesterId: 'a', childId: 'b', news: { kind: 'ended', status: 'idle' }, at: 'x' }], kanban: 'no' }));
    expect(carry.readCarryOver(file)).toEqual({ notes: [{ requesterId: 'a', childId: 'b', news: { kind: 'ended', status: 'idle' }, at: 'x' }], kanban: [] });
  });
});

describe('22. owed since, in both zones (2.0.6, option d)', () => {
  it("says the time UTC first, then the machine's own with its offset", () => {
    const at = '2026-10-29T19:03:00.000Z';
    expect(carry.carriedSince(at)).toBe(`owed since ${twoZones(Date.parse(at))}, before Tars restarted`);
  });
});
