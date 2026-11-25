import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The overseer's model, provider and cadence.
 *
 * All three used to be constants: a fixed five-minute watch, and whatever
 * model the Hermes gateway happened to have selected globally (on the author's
 * install, a small fast one). What matters here is not that a setter writes a
 * field, but that the choice actually reaches the gateway: the standing cron
 * job outlives every settings change, so a model picked in the Chat header has
 * to arrive on the PUT that updates an existing job, not only on the POST that
 * created it. The Hermes calls are captured and asserted against for that
 * reason.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-overseer-'));

vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  API_PORT: 31415,
  dataPath: (f: string) => path.join(tmp, f),
  // The conversation lives outside the directory the agents are handed.
  // Both paths, because the module migrates from the old one to the new.
  privatePath: (...segments: string[]) => path.join(tmp, 'private', ...segments),
  OVERSEER_FILE: path.join(tmp, 'private', 'overseer.json'),
  OVERSEER_LEGACY_FILE: path.join(tmp, 'overseer.json'),
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));
vi.mock('../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));

/** Every call Tars makes to the gateway during a turn, in order. */
const calls: { fn: string; args: unknown[] }[] = [];

vi.mock('../../../electron/services/hermes-client', () => ({
  probeHermes: async () => ({ reachable: true, authRequired: false, signedIn: true }),
  createHermesCron: async (...args: unknown[]) => {
    calls.push({ fn: 'create', args });
    return { success: true, job: { id: 'job-1' } };
  },
  updateHermesCron: async (...args: unknown[]) => {
    calls.push({ fn: 'update', args });
    return { success: true, job: { id: 'job-1' } };
  },
  hermesCronAction: async (...args: unknown[]) => {
    calls.push({ fn: 'action', args });
    return { success: true };
  },
  // A run id carries its creation instant (cron_{job}_{YYYYMMDD}_{HHMMSS}) and
  // askOverseer only accepts one at or after the trigger, so it is stamped now
  // rather than hardcoded - a fixed id would read as stale and poll to timeout.
  fetchHermesCronRuns: async () => {
    const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_');
    return { success: true, runs: [{ id: `cron_job-1_${t.slice(0, 8)}_${t.slice(9, 15)}` }] };
  },
  fetchHermesSessionMessages: async () => ({
    success: true,
    messages: [{ role: 'assistant', content: 'the fleet is quiet' }],
  }),
  fetchHermesModelOptions: async () => ({ success: true, provider: '', model: '', providers: [] }),
  setHermesModel: async (...args: unknown[]) => {
    calls.push({ fn: 'setModel', args });
    return { success: true };
  },
}));

const OVERSEER_FILE = path.join(tmp, 'private', 'overseer.json');
// The module writes there through writeSecretFileSync, which creates the
// directory; a test that seeds the file by hand has to exist first.
fs.mkdirSync(path.dirname(OVERSEER_FILE), { recursive: true });
let overseer: typeof import('../../../electron/services/overseer');

beforeEach(async () => {
  calls.length = 0;
  if (fs.existsSync(OVERSEER_FILE)) fs.rmSync(OVERSEER_FILE);
  vi.resetModules();
  overseer = await import('../../../electron/services/overseer');
});

describe('overseer settings', () => {
  it('starts on the five minute default with no model pinned', () => {
    const s = overseer.getOverseerSettings();
    expect(s.watchIntervalMs).toBe(overseer.DEFAULT_WATCH_INTERVAL_MS);
    // Empty means "whatever the gateway is set to", which is what every
    // install already had before the setting existed.
    expect(s.model).toBe('');
    expect(s.provider).toBe('');
  });

  it('persists a change across a reload', async () => {
    overseer.setOverseerSettings({ watchIntervalMs: 900_000, provider: 'anthropic', model: 'claude-opus-5' });

    vi.resetModules();
    const reloaded = await import('../../../electron/services/overseer');

    expect(reloaded.getOverseerSettings()).toMatchObject({
      watchIntervalMs: 900_000,
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('clamps an interval below the floor and above the ceiling', () => {
    expect(overseer.setOverseerSettings({ watchIntervalMs: 1_000 }).watchIntervalMs)
      .toBe(overseer.MIN_WATCH_INTERVAL_MS);
    expect(overseer.setOverseerSettings({ watchIntervalMs: 99 * 60 * 60 * 1000 }).watchIntervalMs)
      .toBe(overseer.MAX_WATCH_INTERVAL_MS);
  });

  it('falls back to the default rather than storing a non-number', () => {
    expect(overseer.setOverseerSettings({ watchIntervalMs: Number.NaN }).watchIntervalMs)
      .toBe(overseer.DEFAULT_WATCH_INTERVAL_MS);
  });

  it('changes one field without clearing the others', () => {
    overseer.setOverseerSettings({ provider: 'anthropic', model: 'claude-opus-5' });
    const after = overseer.setOverseerSettings({ watchIntervalMs: 1_800_000 });
    expect(after).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', watchIntervalMs: 1_800_000 });
  });

  it('reads a state file written before settings existed', async () => {
    // The shape shipped in 1.6.2: no `settings` key at all.
    fs.writeFileSync(OVERSEER_FILE, JSON.stringify({ jobId: 'old', messages: [], paused: true }));
    vi.resetModules();
    const reloaded = await import('../../../electron/services/overseer');

    expect(reloaded.getOverseerSettings().watchIntervalMs).toBe(reloaded.DEFAULT_WATCH_INTERVAL_MS);
    expect(reloaded.isOverseerWatchPaused()).toBe(true);
  });

  it('survives a state file holding only some of the settings', async () => {
    fs.writeFileSync(OVERSEER_FILE, JSON.stringify({ jobId: null, messages: [], settings: { model: 'kimi-k2' } }));
    vi.resetModules();
    const reloaded = await import('../../../electron/services/overseer');

    const s = reloaded.getOverseerSettings();
    expect(s.model).toBe('kimi-k2');
    expect(s.watchIntervalMs).toBe(reloaded.DEFAULT_WATCH_INTERVAL_MS);
  });
});

describe('the chosen model reaches the gateway', () => {
  /**
   * Measured against the live gateway, not assumed: `provider` and `model` on
   * a cron job are accepted and echoed back but ignored at run time, and a job
   * under a non-default profile never answers at all. `POST /api/model/set`
   * with scope "main" is the only one that changes what actually replies, so
   * it is the one this asserts.
   */
  it('sets the gateway model, which is what selects what answers', async () => {
    await overseer.applyOverseerModel('anthropic', 'claude-opus-5');

    const set = calls.find(c => c.fn === 'setModel');
    expect(set).toBeDefined();
    expect(set!.args[1]).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('creates the standing job with the pinned provider and model', async () => {
    overseer.setOverseerSettings({ provider: 'anthropic', model: 'claude-opus-5' });
    await overseer.askOverseer('what is the fleet doing');

    const create = calls.find(c => c.fn === 'create');
    expect(create).toBeDefined();
    expect(create!.args[1]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
  });

  it('carries the model on the prompt update, which is every turn after the first', async () => {
    overseer.setOverseerSettings({ provider: 'anthropic', model: 'claude-opus-5' });
    await overseer.askOverseer('first turn');

    // Second turn: the job already exists, so nothing is created and the only
    // chance to state the model is the PUT.
    calls.length = 0;
    await overseer.askOverseer('second turn');

    expect(calls.some(c => c.fn === 'create')).toBe(false);
    const update = calls.find(c => c.fn === 'update');
    expect(update).toBeDefined();
    expect(update!.args[2]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    expect((update!.args[2] as { prompt?: string }).prompt).toContain('second turn');
  // Two full round trips, each waiting out a real poll interval.
  }, 30_000);

  it('sends no model at all when none is pinned, leaving the gateway its own choice', async () => {
    await overseer.askOverseer('what is the fleet doing');

    const update = calls.find(c => c.fn === 'update');
    expect(update).toBeDefined();
    // Not `model: ''` - an empty string is a value the gateway would try to
    // resolve, and it resolves to nothing.
    expect(Object.keys(update!.args[2] as object)).toEqual(['prompt']);
  });
});
