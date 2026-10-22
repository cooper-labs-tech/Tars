import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * memory_search does not hand an agent JeanBrasse's conversation with the super chat
 * (the Audit's table on a3d7c125, #13).
 *
 * SECURITY.md §5 says that conversation lives in ~/.tars-private and is never
 * handed to an agent. The super chat holds it with Hermes, though, and each
 * turn is a Hermes session: a live one (session.create), or a run of its cron
 * job, `cron_<jobId>_<date>_<time>`. memory_search asks Hermes to search every
 * session, and returned those with the rest.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A session the super chat opened live is returned to an agent.
 * 2. A run of the super chat's cron job is returned to an agent.
 * 3. A hit the gateway gives without a session id, which nothing can tell
 *    apart, is returned to an agent.
 * 4. JeanBrasse's own sessions stop being searchable by his agents.
 *
 * Added after the Audit's gate of #190 (2026-09-28), written before the fix:
 * 5. A run of the super chat's cron job, once the job was replaced (deleted on
 *    the gateway and made again, a new id), is returned: the name no longer
 *    matches, and only the run recorded when it happened keeps it out. The
 *    gate removed that record and the four tests above stayed green.
 * 6. The super chat's hits eat an agent's limit: the gateway was asked for
 *    `limit` hits and the filter ran on those, so an agent asking 10 could get
 *    none while JeanBrasse's own sessions matched too.
 * 7. A session Hermes compressed is returned: its search hits carry the
 *    lineage's newest id (`session_id`, never recorded) with its root
 *    (`lineage_root`) and parent (`parent_session_id`), read in
 *    hermes_cli/web_routers/sessions.py of the gateway.
 * 8. (found writing 6) A search with no `limit`, which is how memory_search
 *    asks unless the agent names one, is cut to 1 hit: the route read the
 *    missing parameter as Number(null), 0, which is finite, and clamped it to
 *    1 instead of taking the default 10.
 *
 * Added after the Audit's gate of #225 (2026-09-28), written before the fix.
 * The gateway's search walks a hit's parents to its compression root and
 * stops at a branch or a delegate edge: those stay searchable on their own.
 * 9. A session branched or delegated from a compressed segment of the super
 *    chat is returned: its root is itself, its parent a segment Tars never
 *    recorded (the super chat was compressed inside a turn), and none of the
 *    three ids a hit carries is the super chat's.
 * 10. The same once the branch was compressed too: the tip's parent is the
 *    branch's own segment, and the super chat is two edges further up.
 * 11. An ancestor that cannot be read (the gateway fails, the session is
 *    gone), a chain longer than the bound, or a cycle lets the hit through,
 *    or never ends.
 * 12. Over-correction: JeanBrasse's own branched sessions are dropped; or a hit
 *    with no parent costs a call to the gateway; or an ancestor shared by
 *    several hits is read once per hit; or hits are walked past the limit.
 * 13. The Brain page, which is JeanBrasse's own and filters nothing, walks
 *    anything.
 *
 * The overseer and the memory route are the real ones; the live transport
 * and the gateway's search are fakes.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ branch: 'main', status: [] }) }));
const live = vi.hoisted(() => ({ available: true }));
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => live.available,
  conversationRefused: () => false,
  openConversation: async () => ({
    session: { sessionId: 'live-overseer-1', storedSessionId: 'stored-overseer-1' },
    closed: false,
    ask: async () => ({ ok: true, text: '{"say":"Answered live.","action":null}' }),
    close: () => {},
  }),
}));
const gateway = vi.hoisted(() => ({
  hits: [] as Array<Record<string, unknown>>,
  runId: '',
  /** GET /api/sessions/{id}: each session's parent, null for a root; absent reads as a 404. */
  parents: {} as Record<string, string | null>,
  detailCalls: [] as string[],
}));
/** A run id as the gateway names them: `cron_<job>_<UTC date>_<UTC time>`. */
const runIdFor = (jobId: string, at = new Date()) => `cron_${jobId}_${at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')}`;
vi.mock('../../../electron/services/hermes-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-client')>()),
  // As the gateway does: at most `limit` hits, in its own order.
  searchHermesSessions: async (_conn: unknown, _q: string, limit = 10) => ({ success: true, hits: gateway.hits.slice(0, limit) }),
  fetchHermesSessionParent: async (_conn: unknown, id: string) => {
    gateway.detailCalls.push(id);
    return id in gateway.parents
      ? { success: true, parentSessionId: gateway.parents[id] }
      : { success: false, error: 'HTTP 404' };
  },
  updateHermesCron: async () => ({ success: true }),
  hermesCronAction: async () => ({ success: true }),
  fetchHermesCronRuns: async () => ({ success: true, runs: gateway.runId ? [{ id: gateway.runId }] : [] }),
  fetchHermesSessionMessages: async () => ({ success: true, messages: [{ role: 'assistant', content: '{"say":"Answered by the cron.","action":null}' }] }),
  // A reachable gateway, so the super chat's turn opens its live session.
  probeHermes: async () => ({ baseUrl: 'http://127.0.0.1:1', reachable: true, authRequired: false, authFlows: [], authProviders: [], signedIn: true }),
  createHermesCron: async () => ({ success: false as const, error: 'no cron in this test', needsSignIn: false }),
}));

type Handler = (req: unknown, sendJson: (body: unknown, status?: number) => void) => Promise<void>;
let search: Handler;
let overseer: typeof import('../../../electron/services/overseer');
let store: typeof import('../../../electron/services/overseer-store');

async function agentSearches(q: string, limit?: number): Promise<Array<{ ref?: string; source: string }>> {
  let answer: { hits: Array<{ ref?: string; source: string }> } = { hits: [] };
  const url = new URL(`http://localhost/api/memory/search?q=${encodeURIComponent(q)}&sources=hermes${limit ? `&limit=${limit}` : ''}`);
  await search({ url, body: {}, params: {} }, body => { answer = body as typeof answer; });
  return answer.hits;
}

beforeAll(async () => {
  const { HERMES_CONNECTION_FILE } = await import('../../../electron/services/hermes-config');
  fs.mkdirSync(path.dirname(HERMES_CONNECTION_FILE), { recursive: true });
  fs.writeFileSync(HERMES_CONNECTION_FILE, JSON.stringify({ mode: 'remote', url: 'http://127.0.0.1:1', authMode: 'token' }), { mode: 0o600 });
  overseer = await import('../../../electron/services/overseer');
  store = await import('../../../electron/services/overseer-store');
  const { registerMemoryRoutes } = await import('../../../electron/services/api-routes/memory-routes');
  const routes: Array<{ pattern: unknown; handler: Handler }> = [];
  const app = {
    add(_m: string, pattern: unknown, handler: Handler) { routes.push({ pattern, handler }); },
    get(p: unknown, h: Handler) { this.add('GET', p, h); },
    post(p: unknown, h: Handler) { this.add('POST', p, h); },
    put(p: unknown, h: Handler) { this.add('PUT', p, h); },
    delete(p: unknown, h: Handler) { this.add('DELETE', p, h); },
  };
  registerMemoryRoutes(app as never, { getAppSettings: () => ({}) } as never);
  search = routes.find(r => r.pattern === '/api/memory/search')!.handler;
});

beforeEach(() => {
  overseer.resetLiveSession();
  gateway.hits = [];
  gateway.runId = '';
  gateway.parents = {};
  gateway.detailCalls = [];
  live.available = true;
});

describe('memory_search, as an agent calls it', () => {
  it('1, 4. leaves out a session the super chat opened live, and keeps JeanBrasse\'s own', async () => {
    await overseer.askOverseer('What is everyone doing?');
    gateway.hits = [
      { sessionId: 'live-overseer-1', title: 'overseer', snippet: 'JeanBrasse asked the super chat' },
      { sessionId: 'stored-overseer-1', title: 'overseer', snippet: 'the same, by its stored id' },
      { sessionId: 'user-own-1', title: 'deploy notes', snippet: 'the deploy key rotates on Fridays' },
    ];

    const hits = await agentSearches('deploy');

    expect(hits.map(h => h.ref)).toEqual(['user-own-1']);
  });

  it('2. leaves out the runs of the super chat\'s cron job', async () => {
    const state = store.loadState();
    store.saveState({ ...state, jobId: 'job-overseer' });
    gateway.hits = [
      { sessionId: 'cron_job-overseer_20260924_101010', snippet: 'a fallback turn' },
      { sessionId: 'cron_other-job_20260924_101010', snippet: 'another cron of JeanBrasse\'s' },
    ];

    const hits = await agentSearches('turn');

    expect(hits.map(h => h.ref)).toEqual(['cron_other-job_20260924_101010']);
  });

  it('3. leaves out a hit that names no session', async () => {
    gateway.hits = [{ title: 'untitled', snippet: 'no session id at all' }, { sessionId: 'user-own-2', snippet: 'kept' }];

    const hits = await agentSearches('id');

    expect(hits.map(h => h.ref)).toEqual(['user-own-2']);
  });

  it('remembers the super chat\'s live sessions across a restart of Tars', async () => {
    await overseer.askOverseer('And now?');
    // A file of its own in the private directory: a turn saves the state it
    // loaded when it began, which would drop an id recorded meanwhile.
    const saved = fs.readFileSync(path.join(os.homedir(), '.tars-private', 'overseer-hermes-sessions.json'), 'utf-8');
    expect(saved).toContain('live-overseer-1');
    expect(saved).toContain('stored-overseer-1');
  });

  it('5. leaves out a run of the super chat\'s cron job once the job was replaced', async () => {
    live.available = false;
    store.saveState({ ...store.loadState(), jobId: 'job-before' });
    gateway.runId = runIdFor('job-before');
    const turn = await overseer.askOverseer('Answer through the cron.');
    expect(turn, JSON.stringify(turn)).toMatchObject({ ok: true });

    // The job is made again on the gateway, under another id.
    store.saveState({ ...store.loadState(), jobId: 'job-after' });
    gateway.hits = [{ sessionId: gateway.runId, snippet: 'the fallback turn' }, { sessionId: 'user-own-5', snippet: 'kept' }];

    expect((await agentSearches('turn')).map(h => h.ref)).toEqual(['user-own-5']);
  }, 20_000);

  it('6. hands an agent its limit of JeanBrasse\'s own hits, however many of the super chat\'s come first', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.hits = [
      ...Array.from({ length: 12 }, () => ({ sessionId: 'live-overseer-1', snippet: 'the super chat' })),
      ...Array.from({ length: 15 }, (_, i) => ({ sessionId: `user-own-${i}`, snippet: 'JeanBrasse' })),
    ];

    const hits = await agentSearches('x', 10);

    expect(hits.map(h => h.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `user-own-${i}`));
  });

  it('7. leaves out a compressed session whose lineage root or parent is the super chat\'s', async () => {
    await overseer.askOverseer('Seed the live session.');
    // JeanBrasse's lineage is read up to its root, which the gateway gives with no parent.
    gateway.parents = { 'user-root': null };
    gateway.hits = [
      { sessionId: 'tip-after-compression', lineageRoot: 'live-overseer-1', snippet: 'the super chat, compressed' },
      { sessionId: 'tip-2', parentSessionId: 'stored-overseer-1', snippet: 'its child' },
      { sessionId: 'user-tip', lineageRoot: 'user-root', parentSessionId: 'user-root', snippet: 'JeanBrasse, compressed' },
    ];

    expect((await agentSearches('x')).map(h => h.ref)).toEqual(['user-tip']);
  });

  it('8. takes 10 hits when the agent names no limit', async () => {
    gateway.hits = Array.from({ length: 15 }, (_, i) => ({ sessionId: `user-own-${i}`, snippet: 'JeanBrasse' }));

    expect(await agentSearches('x')).toHaveLength(10);
  });

  it('9. leaves out a session branched from a segment of the super chat Tars never recorded', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.parents = { 'segment-7': 'segment-6', 'segment-6': 'stored-overseer-1', 'stored-overseer-1': null };
    gateway.hits = [
      { sessionId: 'branch-1', lineageRoot: 'branch-1', parentSessionId: 'segment-7', snippet: 'a delegate of the super chat' },
      { sessionId: 'user-own-9', lineageRoot: 'user-own-9', snippet: 'kept' },
    ];

    expect((await agentSearches('x')).map(h => h.ref)).toEqual(['user-own-9']);
  });

  it('10. leaves it out once the branch was compressed too', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.parents = { 'branch-mid': 'branch-root', 'branch-root': 'segment-7', 'segment-7': 'live-overseer-1' };
    gateway.hits = [{ sessionId: 'branch-tip', lineageRoot: 'branch-root', parentSessionId: 'branch-mid', snippet: 'compressed branch' }];

    expect(await agentSearches('x')).toEqual([]);
  });

  it('11. leaves out a hit whose ancestry cannot be read to its end, and ends on a cycle', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.parents = {
      'cycle-a': 'cycle-b', 'cycle-b': 'cycle-a',
      ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`link-${i}`, `link-${i + 1}`])),
    };
    gateway.hits = [
      { sessionId: 'orphan', lineageRoot: 'orphan', parentSessionId: 'deleted-segment', snippet: 'parent gone' },
      { sessionId: 'looping', lineageRoot: 'looping', parentSessionId: 'cycle-a', snippet: 'a cycle' },
      { sessionId: 'deep', lineageRoot: 'deep', parentSessionId: 'link-0', snippet: 'longer than the bound' },
    ];

    expect(await agentSearches('x')).toEqual([]);
    expect(gateway.detailCalls.length).toBeLessThan(60);
  });

  it('12. keeps JeanBrasse\'s own branches, reads a shared ancestor once, and asks nothing for a hit with no parent or past the limit', async () => {
    await overseer.askOverseer('Seed the live session.');
    gateway.parents = { 'user-chat': 'user-first', 'user-first': null };
    gateway.hits = [
      { sessionId: 'user-plain', lineageRoot: 'user-plain', snippet: 'no parent' },
      { sessionId: 'user-branch-1', lineageRoot: 'user-branch-1', parentSessionId: 'user-chat', snippet: 'a branch of JeanBrasse\'s' },
      { sessionId: 'user-branch-2', lineageRoot: 'user-branch-2', parentSessionId: 'user-chat', snippet: 'another' },
      { sessionId: 'user-branch-3', lineageRoot: 'user-branch-3', parentSessionId: 'never-read', snippet: 'past the limit' },
    ];

    expect((await agentSearches('x', 3)).map(h => h.ref)).toEqual(['user-plain', 'user-branch-1', 'user-branch-2']);
    expect(gateway.detailCalls).toEqual(['user-chat', 'user-first']);
  });

  it('13. walks nothing for the Brain page, which filters nothing', async () => {
    const { searchMemory } = await import('../../../electron/services/memory-hub');
    gateway.hits = [{ sessionId: 'branch-1', lineageRoot: 'branch-1', parentSessionId: 'segment-7', snippet: 'JeanBrasse\'s own view' }];

    const res = await searchMemory({ query: 'x', settings: {} as never, hermes: {} as never, sources: ['hermes'] });

    expect(res.hits.map(h => h.ref)).toEqual(['branch-1']);
    expect(gateway.detailCalls).toEqual([]);
  });
});
