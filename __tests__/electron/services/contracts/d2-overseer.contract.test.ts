import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The contract of the overseer (the super chat's engine), recorded before the
 * refactor (group D2) and held byte for byte after it: its exported names, the
 * prompt it composes, how it reads a reply, the fleet snapshot, what it keeps
 * on disk, and one whole turn (what reaches Hermes, what comes back, what is
 * written). The overseer is the real one; Hermes and the dispatch endpoint are
 * recorders, the clock is fixed.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-d2-overseer-contract-'));
let dispatchPort = 0;
vi.mock('../../../../electron/constants', () => ({
  DATA_DIR: tmp,
  get API_PORT() { return dispatchPort; },
  dataPath: (f: string) => path.join(tmp, f),
  privatePath: (...segments: string[]) => path.join(tmp, 'private', ...segments),
  OVERSEER_FILE: path.join(tmp, 'private', 'overseer.json'),
  OVERSEER_LEGACY_FILE: path.join(tmp, 'overseer.json'),
}));
const agents = new Map<string, Record<string, unknown>>();
vi.mock('../../../../electron/core/agent-manager', () => ({ agents }));
vi.mock('../../../../electron/services/git-review', () => ({
  repoSummary: async (p: string) => ({ success: true, branch: 'main', ahead: 0, behind: 0, dirty: p.endsWith('b') ? 2 : 0 }),
}));
vi.mock('../../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));
vi.mock('../../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => false,
  createLiveSession: async () => { throw new Error('no live transport in tests'); },
  askLiveSession: async () => ({ ok: false, error: 'unavailable' }),
  getReasoningEffort: () => 'medium',
}));

const hermesCalls: Array<Record<string, unknown>> = [];
let nextReply = '';
vi.mock('../../../../electron/services/hermes-client', () => ({
  probeHermes: async () => { hermesCalls.push({ call: 'probeHermes' }); return { reachable: true, authRequired: false, signedIn: true }; },
  createHermesCron: async (_c: unknown, job: Record<string, unknown>) => { hermesCalls.push({ call: 'createHermesCron', job }); return { success: true, job: { id: 'job-1' } }; },
  updateHermesCron: async (_c: unknown, id: string, patch: Record<string, unknown>) => { hermesCalls.push({ call: 'updateHermesCron', id, patch }); return { success: true, job: { id } }; },
  hermesCronAction: async (_c: unknown, action: string, id: string) => { hermesCalls.push({ call: 'hermesCronAction', action, id }); return { success: true }; },
  fetchHermesCronRuns: async () => ({ success: true, runs: [{ id: 'cron_job-1_20260923_120001', status: 'ok' }] }),
  fetchHermesSessionMessages: async (_c: unknown, id: string) => { hermesCalls.push({ call: 'fetchHermesSessionMessages', id }); return { success: true, messages: [{ role: 'assistant', content: nextReply }] }; },
  fetchHermesModelOptions: async () => ({ success: true, provider: '', model: '', providers: [] }),
  setHermesModel: async () => ({ success: true }),
  uploadHermesAttachment: async () => ({ success: true, attachment: { path: '/u/a.txt' } }),
}));

const OVERSEER_FILE = path.join(tmp, 'private', 'overseer.json');
const dispatched: Array<{ url: string; body: string }> = [];
let dispatchServer: http.Server;
let overseer: typeof import('../../../../electron/services/overseer');

/** Ids and times are generated per run: named by order instead. */
function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value, null, 1)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => {
      if (!ids.has(id)) ids.set(id, `<uuid ${ids.size + 1}>`);
      return ids.get(id)!;
    })
    .split(String(dispatchPort)).join('<port>');
  return JSON.parse(text);
}

beforeAll(async () => {
  dispatchServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      dispatched.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'pty' }));
    });
  });
  await new Promise<void>(resolve => dispatchServer.listen(0, '127.0.0.1', () => resolve()));
  dispatchPort = (dispatchServer.address() as { port: number }).port;
  overseer = await import('../../../../electron/services/overseer');
});

afterAll(async () => {
  overseer.stopOverseerWatch();
  await new Promise<void>(r => { dispatchServer.close(() => r()); });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
  agents.clear();
  agents.set('a1', {
    id: 'a1', name: 'Frontend', role: 'orchestrator', status: 'running', provider: 'claude', projectPath: '/tars',
    currentTask: 'Draw the notice', lastActivity: '2026-09-23T11:58:00.000Z', output: ['\x1b[32mbuilding\x1b[0m the panel\n'],
    lastCleanOutput: 'Drew the notice.', model: 'claude-opus-5-5',
  });
  agents.set('b1', {
    id: 'b1', name: 'Backend', role: 'worker', status: 'waiting', waitingReason: 'idle', provider: 'codex', projectPath: '/tars-b',
    currentTask: '', lastActivity: '2026-09-23T11:00:00.000Z', output: [], error: undefined,
  });
  hermesCalls.length = 0;
  dispatched.length = 0;
  fs.rmSync(path.join(tmp, 'private'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'overseer.json'), { force: true });
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
});

describe('the overseer, as recorded before the D2 refactor', () => {
  it('exports the same names', async () => {
    expect(Object.keys(overseer).sort()).toMatchSnapshot('overseer');
    expect(Object.keys(await import('../../../../electron/services/overseer-auto')).sort()).toMatchSnapshot('overseer-auto');
    expect(Object.keys(await import('../../../../electron/services/overseer-runs')).sort()).toMatchSnapshot('overseer-runs');
  });

  it('builds the same fleet snapshot and composes the same prompt', async () => {
    const snapshot = await overseer.buildFleetSnapshot();
    expect(stable(snapshot)).toMatchSnapshot('snapshot');
    const history = [
      { id: 'm1', role: 'user', text: 'What is everyone doing?', action: null, timestamp: '2026-09-23T11:50:00.000Z' },
      { id: 'm2', role: 'overseer', text: 'Frontend draws the notice; Backend waits.', action: null, timestamp: '2026-09-23T11:50:05.000Z' },
    ] as never;
    expect(overseer.composeTurn(snapshot, history, 'And now?')).toMatchSnapshot('turn');
    expect(overseer.composeTurn(snapshot, [], '', { isBriefing: true })).toMatchSnapshot('briefing');
  });

  it('reads replies the same way', () => {
    const replies = [
      '{"say":"All quiet.","action":null}',
      'Here you go:\n```json\n{"say":"Frontend is done.","action":{"agentId":"a1","text":"Ship it"}}\n```',
      'prose before {"say":"with prose","action":null} and after',
      '{"say":"broken json, "action":',
      '{"say":"<what you tell JeanBrasse, plain text or light markdown>","action":null}',
      '',
      'no json at all, just words',
      '{"say":"nested {braces} and \\"quotes\\"","action":{"agentId":"b1","text":"a {b} c"}}',
    ];
    expect(replies.map(r => overseer.parseEnvelope(r))).toMatchSnapshot('envelopes');
    expect(['', 'ok', '<what you tell JeanBrasse, plain text or light markdown>', 'Frontend is building. <something>', 'All quiet.']
      .map(s => overseer.isTemplateEcho(s))).toMatchSnapshot('template echo');
    expect([
      ['Frontend has been running for 2 minutes.', 'Frontend has been running for 3 minutes.'],
      ['All quiet.', 'Something changed.'],
      ['Backend waits (12s).', 'Backend waits (40s).'],
    ].map(([a, b]) => overseer.isSameThingSaidAgain(a, b))).toMatchSnapshot('repetition');
  });

  it('resolves targets the same way', () => {
    expect(['a1', 'b1', 'zz', ''].map(id => stable(overseer.resolveTarget(id)))).toMatchSnapshot('targets');
  });

  it('keeps the same file on disk: read, cleared, and after a whole turn', async () => {
    fs.mkdirSync(path.dirname(OVERSEER_FILE), { recursive: true });
    fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
      jobId: 'job-1',
      messages: [{ id: 'seed-0', role: 'user', text: 'hello', action: null, timestamp: '2026-09-23T11:00:00.000Z' }],
      previousSnapshot: null, longRunningReported: [], paused: false,
    }, null, 2));
    expect(stable(overseer.getOverseerHistory())).toMatchSnapshot('history read');
    overseer.clearOverseerHistory();
    expect(fs.readFileSync(OVERSEER_FILE, 'utf-8')).toMatchSnapshot('file after clear');

    nextReply = '{"say":"Frontend is drawing the notice; Backend is idle.","action":{"agentId":"b1","text":"Pick up the review"}}';
    const result = await overseer.askOverseer('What next?');
    expect(stable(result)).toMatchSnapshot('turn result');
    expect(stable(hermesCalls)).toMatchSnapshot('what reached Hermes');
    expect(stable(JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8')))).toMatchSnapshot('file after a turn');
    expect(stable(dispatched)).toMatchSnapshot('dispatched');
  });

  it('keeps the same settings', () => {
    expect(stable(overseer.getOverseerSettings())).toMatchSnapshot('settings');
    expect(overseer.isOverseerBusy()).toBe(false);
    expect(overseer.isOverseerWatchPaused()).toMatchSnapshot('paused');
  });

  it('sends through the same gate: an approval, a repeat, a stranger, a refusal, an echo', async () => {
    const action = (actionId: string, agentId: string, text: string) => ({
      actionId, agentId, agentName: 'Backend', projectPath: '/tars-b', provider: 'codex',
      pane: 'no live pane, a fresh session will start', text, resolvedAt: '2026-09-23T11:59:00.000Z',
    });
    fs.mkdirSync(path.dirname(OVERSEER_FILE), { recursive: true });
    fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
      jobId: 'job-1',
      messages: [
        { id: 'o1', role: 'overseer', text: 'Backend is idle.', action: action('act-1', 'b1', 'Pick up the review'), timestamp: '2026-09-23T11:59:00.000Z' },
        { id: 'o2', role: 'overseer', text: 'Frontend could ship.', action: action('act-2', 'a1', 'Ship it'), timestamp: '2026-09-23T11:59:30.000Z' },
        { id: 'o3', role: 'overseer', text: '<what you tell JeanBrasse, plain text or light markdown>', action: action('act-3', 'b1', 'Echoed'), timestamp: '2026-09-23T11:59:40.000Z' },
      ],
      previousSnapshot: null, longRunningReported: [], paused: false,
    }, null, 2));
    const outcomes = [
      // Only the id is the caller's: what goes out is what was proposed.
      await overseer.confirmPendingAction(action('act-1', 'a1', 'Something never proposed'), true),
      await overseer.confirmPendingAction(action('act-1', 'b1', 'Pick up the review'), true),
      await overseer.confirmPendingAction(action('act-9', 'b1', 'Unknown'), true),
      await overseer.confirmPendingAction(action('act-2', 'a1', 'Ship it'), false),
      await overseer.confirmPendingAction(action('act-2', 'a1', 'Ship it'), true),
      await overseer.confirmPendingAction(action('act-3', 'b1', 'Echoed'), true),
      await overseer.confirmPendingAction({ actionId: '', agentId: 'b1', text: 'x' } as never, true),
    ];
    expect(outcomes).toMatchSnapshot('outcomes');
    expect(stable(dispatched)).toMatchSnapshot('dispatched');
  });

  it('watches the same way: a first look, a change, a pause, and a rule that sends on its own', async () => {
    const ticks: unknown[] = [];
    // The first look has nothing to compare with.
    ticks.push(await overseer.watchTick());
    agents.get('a1')!.status = 'error';
    nextReply = '{"say":"Frontend errored.","action":null}';
    ticks.push(stable(await overseer.watchTick()));
    overseer.pauseOverseerWatch();
    agents.get('a1')!.status = 'waiting';
    ticks.push(await overseer.watchTick());
    const paused = overseer.isOverseerWatchPaused();
    overseer.resumeOverseerWatch();
    expect({ ticks, paused, failure: overseer.getLastWatchFailure() }).toMatchSnapshot('ticks');
    expect(stable(hermesCalls)).toMatchSnapshot('what reached Hermes on the watch');

    hermesCalls.length = 0;
    expect(stable(overseer.setOverseerSettings({ autoActions: ['nudge-waiting', 'no-such-rule'] }))).toMatchSnapshot('auto settings');
    nextReply = '{"say":"Backend has waited an hour.","action":{"kind":"message_agent","agent_id":"b1","text":"Carry on"}}';
    expect(stable(await overseer.askOverseer('Anyone stuck?'))).toMatchSnapshot('auto result');
    expect(stable(dispatched)).toMatchSnapshot('auto dispatched');
    expect(stable(JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8')))).toMatchSnapshot('file after the watch');
  }, 30_000);
});
