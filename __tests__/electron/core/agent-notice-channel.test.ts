import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Tars's notices about an agent, as the window reads them (2.0.7, the main-process channel the Frontend's frames
 * "Agent notices (2.0.7)" need, draft #623): each line agentNotice writes into an agent's kept output (core/
 * agent-notices.ts: a Goose or Cline agent whose conversation starts over) and each session the hook route refuses
 * (hooks-routes.ts), also kept as a notice of its own, with its kind, and told to every window: while the agent has a
 * terminal, Logs and its panel read that terminal's screen, which these lines never reach.
 *
 * The contract: AgentNotice { id, agentId, at (ms), line (the sentence, without "[Tars] "), kind, seenAt? };
 * agent.notices(agentId?) newest first, every agent's when none is named; agent.onNotice, the event agent:notice;
 * agent.markNoticesSeen(agentId, ids?), the event agent:notice-seen.
 *
 * How it fails, written before the code:
 * 1. A notice written into the kept output and not emitted: the window, whose panel reads the live screen, never hears
 *    of it. It is emitted (agent:notice) as it is written, with its id, agent, time, sentence and kind.
 * 2. Lost at a restart of Tars: the notices live in memory only, and Logs shows none of a night's.
 * 3. Over the cap: an agent's notices grow for good. At most 50 per agent, the oldest dropped, the others' untouched.
 * 4. Seen without its event: another window keeps showing it unseen. markNoticesSeen sets seenAt and emits
 *    agent:notice-seen with the agent and the ids it marked, once; no ids marks all the agent's; nothing new to mark,
 *    no event; and seenAt is kept across a restart.
 * 5. A removed agent's notices left behind: in the file, and in Logs, which reads every agent's. removeAgent takes them.
 * 6. A kind wrongly inferred from the sentence: the kind is its writer's. Goose's and Cline's starts-over lines are
 *    conversation-restart, a refused session session-refused, any other line other, a sentence that only reads like
 *    one of those included.
 * 7. The file is one an agent running as the same user could edit: an entry of another shape, of an unknown kind, or
 *    a line with control characters or past the length a line has, is read as a notice the window shows.
 * The Audit's FIX FIRST on #624 (4cac79592):
 * 8. (L1) The file is in ~/.tars, which every agent is handed: it is Tars's own, in ~/.tars-private, at 0600.
 * 9. (L1) Read back for any agent: a notice of an agent the fleet does not hold is read as Tars's, on Logs. Only the
 *    fleet's are kept.
 * 10. (L1) A file of any size is parsed on the main thread at the first read: one over 1 MB is not read, and the log
 *     says so; and Tars's own file never grows past that bound (the oldest notices, every agent's, dropped first), so a
 *     large fleet's notices are never thrown away whole at the next start.
 * 11. (M1) A flood of refused sessions: each post a notice, a file write and a broadcast. At most one refusal notice per
 *     agent per minute; another agent's, and another kind, are not held back.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-notice-channel-'));
const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-notice-channel-private-'));
const FILE = path.join(priv, 'agent-notices.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'),
    PRIVATE_DIR: priv, privatePath: (...segments: string[]) => path.join(priv, ...segments),
  };
});

const sent: Array<[string, unknown]> = [];
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '2.0.7' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push([channel, payload]); } } }] },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }, on: () => undefined, removeHandler: () => undefined },
}));

type Notice = { id: string; agentId: string; at: number; line: string; kind: string; seenAt?: number };

let manager: typeof import('../../../electron/core/agent-manager');
let notices: typeof import('../../../electron/core/agent-notices');
let handlersModule: typeof import('../../../electron/handlers/agent-notices-handlers');
let logModule: typeof import('../../../electron/services/agent-notice-log');
type LogOptions = Parameters<typeof import('../../../electron/services/agent-notice-log').createNoticeLog>[0];
/** A log of its own, on a file and a clock the case gives it. */
const createLog = (o: LogOptions) => logModule.createNoticeLog(o);

/** A fresh Tars: modules loaded again, so the notices are what the file holds. */
async function boot(): Promise<void> {
  vi.resetModules();
  handlers.clear();
  manager = await import('../../../electron/core/agent-manager');
  notices = await import('../../../electron/core/agent-notices');
  handlersModule = await import('../../../electron/handlers/agent-notices-handlers');
  logModule = await import('../../../electron/services/agent-notice-log');
  handlersModule.registerAgentNoticeHandlers();
}

function addAgent(id: string): { id: string; output: string[] } {
  const agent = { id, name: id, status: 'idle', provider: 'claude', projectPath: '/p', skills: [], output: [] as string[], lastActivity: new Date().toISOString() };
  manager.agents.set(id, agent as never);
  return agent;
}

/** A fresh Tars whose fleet holds `ids`, as main loads the fleet before anything reads the notices. */
async function reboot(...ids: string[]): Promise<void> {
  await boot();
  for (const id of ids) addAgent(id);
}

const list = (agentId?: string) => handlers.get('agent:notices')!({}, agentId) as Promise<Notice[]> | Notice[];
const markSeen = (agentId: string, ids?: string[]) => handlers.get('agent:notices-seen')!({}, agentId, ids);
const events = (channel: string) => sent.filter(([c]) => c === channel).map(([, p]) => p);

const RESTART = 'Its conversation starts over: Cline cannot fork a session, and a restart cannot continue the one it stops.';

beforeEach(async () => {
  fs.rmSync(FILE, { force: true });
  sent.length = 0;
  await boot();
});

afterEach(() => {
  manager.stopAgentAutosave();
  manager.agents.clear();
});

describe("an agent's notices", () => {
  it('1. a notice written into the kept output is emitted as it is written, with its id, agent, time, sentence and kind', async () => {
    const a = addAgent('a1');
    const before = Date.now();
    notices.agentNotice('a1', RESTART, 'conversation-restart');
    expect(a.output.join('')).toContain(`[Tars] ${RESTART}`);
    const emitted = events('agent:notice') as Notice[];
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ agentId: 'a1', line: RESTART, kind: 'conversation-restart' });
    expect(emitted[0].id).toMatch(/\S{8,}/);
    expect(emitted[0].at).toBeGreaterThanOrEqual(before);
    expect(emitted[0].seenAt).toBeUndefined();
    expect(await list('a1')).toEqual(emitted);
  });

  it('2. kept across a restart of Tars, every agent\'s newest first', async () => {
    addAgent('a1');
    addAgent('a2');
    notices.agentNotice('a1', 'first', 'other');
    await new Promise((r) => setTimeout(r, 5));
    notices.agentNotice('a2', RESTART, 'conversation-restart');
    const kept = await list();
    await reboot('a1', 'a2');
    const read = await list();
    expect(read).toEqual(kept);
    expect(read.map((n) => n.line)).toEqual([RESTART, 'first']);
    expect((await list('a1')).map((n) => n.line)).toEqual(['first']);
  });

  it('3. at most 50 per agent, the oldest dropped, another agent\'s untouched', async () => {
    addAgent('a1');
    addAgent('a2');
    notices.agentNotice('a2', 'theirs', 'other');
    for (let i = 1; i <= 55; i++) notices.agentNotice('a1', `notice ${i}`, 'other');
    const mine = await list('a1');
    expect(mine).toHaveLength(50);
    expect(mine[0].line).toBe('notice 55');
    expect(mine[49].line).toBe('notice 6');
    expect((await list('a2')).map((n) => n.line)).toEqual(['theirs']);
    await reboot('a1', 'a2');
    expect(await list('a1')).toHaveLength(50);
  });

  it('4. marked seen: seenAt set and told once, all of the agent\'s with no ids, kept across a restart', async () => {
    addAgent('a1');
    addAgent('a2');
    notices.agentNotice('a1', 'one', 'other');
    notices.agentNotice('a1', 'two', 'other');
    notices.agentNotice('a2', 'theirs', 'other');
    const [two, one] = await list('a1');
    await markSeen('a1', [one.id]);
    const seen = events('agent:notice-seen') as Array<{ agentId: string; ids: string[]; seenAt: number }>;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: 'a1', ids: [one.id] });
    const afterOne = await list('a1');
    expect(afterOne.find((n) => n.id === one.id)?.seenAt).toBe(seen[0].seenAt);
    expect(afterOne.find((n) => n.id === two.id)?.seenAt).toBeUndefined();
    // Nothing new to mark: no event.
    await markSeen('a1', [one.id]);
    expect(events('agent:notice-seen')).toHaveLength(1);
    // No ids: every one of the agent's not seen yet, and no other agent's.
    await markSeen('a1');
    expect(events('agent:notice-seen')).toHaveLength(2);
    expect((events('agent:notice-seen')[1] as { ids: string[] }).ids).toEqual([two.id]);
    await reboot('a1', 'a2');
    expect((await list('a1')).every((n) => typeof n.seenAt === 'number')).toBe(true);
    expect((await list('a2'))[0].seenAt).toBeUndefined();
  });

  it('5. a removed agent\'s notices go with it, from the list and the file', async () => {
    addAgent('a1');
    addAgent('a2');
    notices.agentNotice('a1', 'mine', 'other');
    notices.agentNotice('a2', 'theirs', 'other');
    const { removeAgent } = await import('../../../electron/core/agent-remove');
    await removeAgent('a1');
    expect(await list('a1')).toEqual([]);
    expect(fs.readFileSync(FILE, 'utf8')).not.toContain('mine');
    expect((await list()).map((n) => n.line)).toEqual(['theirs']);
  });

  it('6. the kind is the writer\'s, never read from the sentence', async () => {
    addAgent('a1');
    notices.agentNotice('a1', 'Refused a session (abc): its CLI is not this terminal\'s.');
    notices.agentNotice('a1', 'Its conversation starts over: as written by someone else');
    expect((await list('a1')).map((n) => n.kind)).toEqual(['other', 'other']);
  });

  it('7. a file an agent wrote: only notices of the right shape, a known kind and one line are read', async () => {
    const good = { id: 'n-good-0001', agentId: 'a1', at: 1_000, line: 'a line', kind: 'session-refused' };
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, notices: [
      good,
      { ...good, id: 'n-kind-0002', kind: 'urgent' },
      { ...good, id: 'n-shape-0003', at: 'yesterday' },
      { ...good, id: 'n-ctrl-0004', at: 2_000, line: 'two\nlines \x1b[31mred\x1b[0m' },
      { ...good, id: 'n-long-0005', at: 3_000, line: 'x'.repeat(5_000) },
      'not a notice',
    ] }));
    await reboot('a1');
    const read = await list('a1');
    expect(read.map((n) => n.id)).toEqual(['n-long-0005', 'n-ctrl-0004', 'n-good-0001']);
    expect(read[0].line.length).toBeLessThanOrEqual(1_000);
    expect(read[1].line).not.toMatch(/[\u0000-\u001f\u007f]/);
    fs.writeFileSync(FILE, 'not json');
    await reboot('a1');
    expect(await list()).toEqual([]);
  });

  it("8. Tars's own file, in ~/.tars-private at 0600, never in ~/.tars", () => {
    addAgent('a1');
    notices.agentNotice('a1', 'kept', 'other');
    expect(fs.existsSync(FILE)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'agent-notices.json'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
  });

  it("9. read back: only the fleet's agents' notices, and the others gone from the file at the next write", async () => {
    const at = (n: number) => ({ id: `n-${n}-000000`, at: n, line: `notice ${n}`, kind: 'other' });
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, notices: [
      { ...at(1), agentId: 'a1' }, { ...at(2), agentId: 'ghost' }, { ...at(3), agentId: 'gone-while-tars-was-down' },
    ] }));
    await reboot('a1');
    expect((await list()).map((n) => n.agentId)).toEqual(['a1']);
    expect(await list('ghost')).toEqual([]);
    notices.agentNotice('a1', 'new', 'other');
    expect(fs.readFileSync(FILE, 'utf8')).not.toContain('ghost');
  });

  it('10. a file over 1 MB is not read, and the log says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = { id: 'n-good-0001', agentId: 'a1', at: 1, line: 'a line', kind: 'other' };
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, notices: [good], pad: 'x'.repeat(1_100_000) }));
    await reboot('a1');
    expect(await list()).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/agent-notices.*(larger|over|past).*1 MB/i);
    warn.mockRestore();
  });

  it("10. Tars's own file stays under its bound: the oldest notices, every agent's, go first, and the rest read back", () => {
    const file = path.join(priv, 'bounded.json');
    let clock = 0;
    const log = createLog({ file, emit: () => undefined, now: () => ++clock, isAgent: () => true, maxFileBytes: 20_000 });
    for (let i = 1; i <= 60; i++) log.record(`agent-${i % 3}`, `${i} ${'y'.repeat(500)}`, 'other');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(20_000);
    const kept = log.list();
    expect(kept[0].line.startsWith('60 ')).toBe(true);
    const oldest = Number(kept[kept.length - 1].line.split(' ')[0]);
    expect(kept.map((n) => Number(n.line.split(' ')[0]))).toEqual(Array.from({ length: 61 - oldest }, (_, k) => 60 - k));
    const again = createLog({ file, emit: () => undefined, isAgent: () => true, maxFileBytes: 20_000 });
    expect(again.list()).toEqual(kept);
  });

  it('11. at most one refusal notice per agent per minute; another agent\'s and another kind are not held back', () => {
    const file = path.join(priv, 'refusals.json');
    const told: unknown[] = [];
    let clock = 1_000_000;
    const log = createLog({ file, emit: (c, p) => { if (c === 'agent:notice') told.push(p); }, now: () => clock, isAgent: () => true });
    expect(log.record('a1', 'Refused a session (one)', 'session-refused')).toBeDefined();
    const written = fs.statSync(file).mtimeMs;
    const before = fs.readFileSync(file, 'utf8');
    clock += 59_999;
    expect(log.record('a1', 'Refused a session (two)', 'session-refused')).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(written);
    expect(log.record('a2', 'Refused a session (theirs)', 'session-refused')).toBeDefined();
    expect(log.record('a1', RESTART, 'conversation-restart')).toBeDefined();
    clock += 1;
    expect(log.record('a1', 'Refused a session (three)', 'session-refused')).toBeDefined();
    expect(told).toHaveLength(4);
    expect(log.list('a1').map((n) => n.line)).toEqual(['Refused a session (three)', RESTART, 'Refused a session (one)']);
  });
});
