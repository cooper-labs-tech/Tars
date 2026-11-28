// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';
import { hasPosixModes } from '../../setup/platform-limits';
import Database from 'better-sqlite3';

/**
 * Trace feature A5 (27/11): the owner's switch "May be used to train models", in the window, and what it stamps.
 *
 * How it fails, written before the code:
 * W1. With nothing chosen, the switch reads off (the owner's ruling of 11/11 is on).
 * W2. Something other than the window's own channel changes it: the trace settings' save (`traces:setSettings`) with a
 *     training field, or the settings file, which every agent can write (`~/.tars` is in their --add-dir). Or the
 *     window's channel takes something other than true or false.
 * W3. The switch is kept anywhere an agent is handed, or readable by others than the user (not 0600 in the private
 *     folder).
 * W4. A session opened while it is off is stamped true; one turned off while it runs keeps true; turning it on again
 *     brings that session back to true; a session opened after it is on again is not true.
 * W5. A change is not marked owed to the back-office where a restart finds it, so a restart before it was sent loses
 *     it; or an unchanged value (on, then on) is marked owed again for nothing.
 * W6. A change does not start a pass soon, so the back-office learns it only at the 5-minute pass, or never with
 *     sharing off.
 * W7. The upload notice does not say what the switch does or where it stands; the preview of a session does not show
 *     the consent it would carry.
 * W8. Turning it off on a disk that refuses the write: the off does not apply at once (sessions still stamped true),
 *     or the window is told it holds. Turning it on there: the on applies though not written.
 * W9. (Found by the Frontend building the toggle, #693.) The back-office takes an owed change and the window is not
 *     told (`traces:changed`), so its "not yet sent" line stays until its next read; or it is told when nothing
 *     changed (a value that is not the owed one, or nothing owed).
 * Added before their fix (the Audit's M1 and its notes on #690 at 050c79fd9): each session's "no" lived only in the
 * trace store, under ~/.tars, which every agent is handed.
 * W10. A session opened while the switch is off, or one running when it was turned off, whose stamp an agent set back
 *      to 1 in the store, previews or uploads as trainable: its "no" is not also kept in the private folder.
 * W11. The private list of denied sessions cannot be read (garbage in it): a session leaves as trainable.
 * W12. The list keeps the ids of sessions the store no longer holds after a sweep, and grows for ever.
 * W13. A change while a pass is running waits for the 5-minute pass: the 2-second pass finds the uploader busy and
 *      does not run once it is free.
 * W14. An off held in memory (its write refused) and taken by the back-office: the window is not told.
 * W15. The running sessions could not be marked in the store: the answer to the off says nothing of it.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));

const call = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args) as Record<string, unknown>;
};

const AT = '2026-11-27T10:00:00.000Z';
const P1 = path.join(DATA_DIR, '..', 'projects', 'one');
const EP = 'ep-0a0b0d';
const BASE = 'http://127.0.0.1:9/v1';
const AGENT = 'agent-t';
const TRAINING_FILE = path.join(PRIVATE_DIR, 'traces-training.json');
const DENIED_FILE = path.join(PRIVATE_DIR, 'traces-training-denied.json');
let memory: AppSettings;
let runtime: typeof import('../../../electron/services/traces-runtime');
let emitted: string[] = [];

const settings = (): AppSettings => ({
  inferenceEndpoints: [{ id: EP, name: 'Local', baseUrl: BASE, allowTraces: true, approved: true, approvedBaseUrl: BASE, models: ['open-coder-1'] }],
  traces: { projects: [P1], pairs: [{ harness: 'qwen-code', models: '*' }], excludeClosedModels: false, uploadUrl: 'https://backoffice.example.com', uploadConsentAt: AT },
}) as unknown as AppSettings;

const consentOf = (traceId: string) => runtime.traceStore().session(traceId)?.session.consent;
/** The session a terminal just opened: the one trace of the store not seen before. */
const seen = new Set<string>();
const traceOf = (token: string | undefined): string | undefined => {
  if (!token) return undefined;
  const fresh = runtime.traceStore().list({}).sessions.map(s => s.traceId).filter(t => !seen.has(t));
  if (fresh.length !== 1) throw new Error(`expected one new session, found ${fresh.length}`);
  seen.add(fresh[0]);
  return fresh[0];
};

beforeEach(async () => {
  handlers.clear();
  memory = settings();
  fs.rmSync(TRAINING_FILE, { force: true });
  fs.rmSync(DENIED_FILE, { force: true });
  runtime = await import('../../../electron/services/traces-runtime');
  const getAgent = (id: string) => (id === AGENT ? ({ id, name: 'T', traces: true, projectPath: P1, provider: 'qwen-code', model: 'open-coder-1', endpointId: EP } as unknown as AgentStatus) : undefined);
  emitted = [];
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: () => {}, getAgent, emit: (channel: string) => { emitted.push(channel); } });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { memory = s; }, writeAppSettings: () => {} });
  runtime.recordConsent(AT);
  seen.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  runtime.stopTracesRuntime();
  fs.rmSync(runtime.TRACES_CONSENT_FILE, { force: true });
  fs.rmSync(TRAINING_FILE, { force: true });
  fs.rmSync(DENIED_FILE, { force: true });
  fs.rmSync(path.dirname(runtime.TRACES_DB_FILE), { recursive: true, force: true });
});

describe('the training switch', () => {
  it('W1. on with nothing chosen', () => {
    expect(fs.existsSync(TRAINING_FILE)).toBe(false);
    expect(call('traces:training')).toMatchObject({ training: true, owed: false });
  });

  it('W2. only the window\'s own channel changes it', () => {
    call('traces:setSettings', { uploadTraining: false, training: false });
    memory = { ...memory, traces: { ...memory.traces, uploadTraining: false, training: false } } as unknown as AppSettings;
    expect(call('traces:training')).toMatchObject({ training: true });
    for (const bad of ['false', 0, null, undefined, { training: false }]) {
      expect(call('traces:setTraining', bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(call('traces:training')).toMatchObject({ training: true });
    expect(call('traces:setTraining', false)).toMatchObject({ ok: true });
    expect(call('traces:training')).toMatchObject({ training: false });
  });

  it('W3. kept in the private folder, 0600', () => {
    call('traces:setTraining', false);
    expect(fs.existsSync(TRAINING_FILE)).toBe(true);
    if (hasPosixModes()) expect(fs.statSync(TRAINING_FILE).mode & 0o077).toBe(0);
    expect(path.dirname(TRAINING_FILE)).toBe(PRIVATE_DIR);
  });

  it('W4. a session opened while off is false; turned off while it runs, false for good; a new one after on, true', () => {
    call('traces:setTraining', false);
    const off = runtime.openEndpointSession(AGENT);
    expect(consentOf(traceOf(off.token)!)).toEqual({ training: false });
    runtime.closeEndpointSession(off.token);
    call('traces:setTraining', true);
    const running = runtime.openEndpointSession(AGENT);
    const id = traceOf(running.token)!;
    expect(consentOf(id)).toEqual({ training: true });
    call('traces:setTraining', false);
    expect(consentOf(id), 'turned off while it runs').toEqual({ training: false });
    call('traces:setTraining', true);
    expect(consentOf(id), 'on again').toEqual({ training: false });
    runtime.closeEndpointSession(running.token);
    const after = runtime.openEndpointSession(AGENT);
    expect(consentOf(traceOf(after.token)!)).toEqual({ training: true });
    runtime.closeEndpointSession(after.token);
  });

  it('W5. a change is owed where a restart finds it; the same value again owes nothing', () => {
    call('traces:setTraining', true);
    expect(fs.existsSync(TRAINING_FILE) ? JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8')).owed : false, 'on, then on').toBe(false);
    call('traces:setTraining', false);
    const kept = JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8'));
    expect(kept).toMatchObject({ training: false, owed: true });
    expect(runtime.readTraining()).toMatchObject({ value: false, owed: true });
  });

  it('W6. a change starts a pass soon, with sharing off too', () => {
    vi.useFakeTimers();
    const runs = vi.spyOn(runtime.traceUploader(), 'runOnce').mockResolvedValue({ sent: 0, failed: 0 });
    call('traces:setTraining', false);
    vi.advanceTimersByTime(5_000);
    expect(runs).toHaveBeenCalled();
    runs.mockClear();
    memory = { ...memory, traces: { ...memory.traces!, uploadConsentAt: undefined } } as unknown as AppSettings;
    call('traces:setTraining', true);
    vi.advanceTimersByTime(5_000);
    expect(runs, 'with sharing off').toHaveBeenCalled();
  });

  it('W7. the notice says it and where it stands; the preview shows the consent a session carries', () => {
    const notice = call('traces:uploadNotice') as { training?: boolean; leaves: string[] };
    expect(notice.training).toBe(true);
    expect(notice.leaves.join('\n')).toMatch(/train/i);
    call('traces:setTraining', false);
    expect((call('traces:uploadNotice') as { training?: boolean }).training).toBe(false);
    const s = runtime.openEndpointSession(AGENT);
    const id = traceOf(s.token)!;
    const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'user', content: 'hello' }] }));
    const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    runtime.traceStore().ingest({ traceId: id, agentId: AGENT, surface: 'openai_chat', startedAt: Date.now(), endedAt: Date.now() + 5, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
    const preview = runtime.previewUpload(id) as { consent?: unknown; document: { batches: Array<{ body: { sessions?: Array<{ consent?: unknown }> } }> } };
    expect(preview.consent, 'what the window shows').toEqual({ training: false });
    expect(preview.document.batches[0].body.sessions?.[0].consent, 'what would be sent').toEqual({ training: false });
    runtime.closeEndpointSession(s.token);
  });

  it('W9. the back-office taking the owed change tells the window once; nothing taken, nothing told', () => {
    // What a PUT answered 2xx calls: the runtime's own dependency of its uploader.
    const sent = (value: boolean) => (runtime.traceUploader() as unknown as { deps: { trainingSent(v: boolean): void } }).deps.trainingSent(value);
    call('traces:setTraining', false);
    expect(call('traces:training')).toMatchObject({ training: false, owed: true });
    emitted = [];
    sent(true);
    expect(emitted, 'not the owed value').toEqual([]);
    expect(call('traces:training')).toMatchObject({ owed: true });
    sent(false);
    expect(emitted, 'the owed change taken').toEqual(['traces:changed']);
    expect(call('traces:training')).toMatchObject({ training: false, owed: false });
    emitted = [];
    sent(false);
    expect(emitted, 'nothing owed any more').toEqual([]);
  });

  it.skipIf(!hasPosixModes())('W8. off applies at once on a disk that refuses it, and says so; on is not applied unwritten', () => {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(TRAINING_FILE, JSON.stringify({ training: true, owed: false }), { mode: 0o400 });
    fs.chmodSync(PRIVATE_DIR, 0o500);
    try {
      const s = runtime.openEndpointSession(AGENT);
      const id = traceOf(s.token)!;
      const off = call('traces:setTraining', false) as { ok: boolean; unsaved?: string };
      expect(off.ok).toBe(true);
      expect(off.unsaved).toMatch(/not (be )?saved|could not/i);
      expect(call('traces:training')).toMatchObject({ training: false });
      expect(consentOf(id)).toEqual({ training: false });
      runtime.closeEndpointSession(s.token);
    } finally {
      fs.chmodSync(PRIVATE_DIR, 0o700);
      fs.chmodSync(TRAINING_FILE, 0o600);
    }
    fs.writeFileSync(TRAINING_FILE, JSON.stringify({ training: false, owed: false }), { mode: 0o400 });
    fs.chmodSync(PRIVATE_DIR, 0o500);
    try {
      const on = call('traces:setTraining', true) as { ok: boolean };
      expect(on.ok).toBe(false);
      expect(call('traces:training')).toMatchObject({ training: false });
    } finally {
      fs.chmodSync(PRIVATE_DIR, 0o700);
      fs.chmodSync(TRAINING_FILE, 0o600);
    }
  });
});

describe('a session\'s "no" kept where no agent reaches it (the Audit\'s M1 on #690)', () => {
  /** What an agent can do: it is handed ~/.tars, and so the trace store. */
  const forge = (traceId: string) => {
    const db = new Database(runtime.TRACES_DB_FILE);
    db.prepare('UPDATE traces SET training = 1 WHERE trace_id = ?').run(traceId);
    db.close();
  };
  const ingest = (traceId: string) => {
    const req = Buffer.from(JSON.stringify({ model: 'open-coder-1', messages: [{ role: 'user', content: traceId }] }));
    const resp = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    runtime.traceStore().ingest({ traceId, agentId: AGENT, surface: 'openai_chat', startedAt: Date.now(), endedAt: Date.now() + 5, status: 200, contentType: 'application/json', requestBody: req, responseBody: resp, attempts: 1, heldMs: 0 });
  };
  type Preview = { consent: unknown; document: { batches: Array<{ body: { sessions?: Array<{ consent?: unknown }> } }> } };
  const leaves = (traceId: string) => {
    const p = runtime.previewUpload(traceId) as Preview;
    return { preview: p.consent, sent: p.document.batches[0].body.sessions?.[0].consent };
  };

  it('W10. opened while off, or running when turned off: false, though an agent sets the stamp back to 1', () => {
    call('traces:setTraining', false);
    const off = runtime.openEndpointSession(AGENT);
    const openedOff = traceOf(off.token)!;
    ingest(openedOff);
    runtime.closeEndpointSession(off.token);
    call('traces:setTraining', true);
    const run = runtime.openEndpointSession(AGENT);
    const running = traceOf(run.token)!;
    ingest(running);
    call('traces:setTraining', false);
    runtime.closeEndpointSession(run.token);
    for (const id of [openedOff, running]) {
      forge(id);
      expect(runtime.traceStore().session(id)?.session.consent, 'the store says yes now').toEqual({ training: true });
      expect(leaves(id), id).toEqual({ preview: { training: false }, sent: { training: false } });
    }
    expect(fs.existsSync(DENIED_FILE), 'kept in the private folder').toBe(true);
    if (hasPosixModes()) expect(fs.statSync(DENIED_FILE).mode & 0o077).toBe(0);
  });

  it('W11. a list that cannot be read denies every session', () => {
    const s = runtime.openEndpointSession(AGENT);
    const id = traceOf(s.token)!;
    ingest(id);
    runtime.closeEndpointSession(s.token);
    expect(leaves(id).sent).toEqual({ training: true });
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(DENIED_FILE, 'not json {', { mode: 0o600 });
    expect(leaves(id), 'an unreadable list').toEqual({ preview: { training: false }, sent: { training: false } });
  });

  it('W12. the sweep drops the ids of sessions the store no longer holds', () => {
    call('traces:setTraining', false);
    const a = runtime.openEndpointSession(AGENT);
    const kept = traceOf(a.token)!;
    runtime.closeEndpointSession(a.token);
    const b = runtime.openEndpointSession(AGENT);
    const gone = traceOf(b.token)!;
    runtime.closeEndpointSession(b.token);
    expect(JSON.parse(fs.readFileSync(DENIED_FILE, 'utf8')).ids.sort()).toEqual([kept, gone].sort());
    runtime.traceStore().remove({ traceIds: [gone] });
    runtime.sweepTraces();
    expect(JSON.parse(fs.readFileSync(DENIED_FILE, 'utf8')).ids).toEqual([kept]);
  });

  it('W13. a change while a pass runs: the 2-second pass runs once the busy one ends', async () => {
    vi.useFakeTimers();
    const runs = vi.spyOn(runtime.traceUploader(), 'runOnce')
      .mockResolvedValueOnce({ sent: 0, failed: 0, skipped: 'busy' })
      .mockResolvedValue({ sent: 0, failed: 0 });
    call('traces:setTraining', false);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(runs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runs, 'once the busy pass is over').toHaveBeenCalledTimes(2);
  });

  it.skipIf(!hasPosixModes())('W14. an off held in memory, taken by the back-office: the window is told', () => {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(TRAINING_FILE, JSON.stringify({ training: true, owed: false }), { mode: 0o400 });
    fs.chmodSync(PRIVATE_DIR, 0o500);
    try {
      call('traces:setTraining', false);
      emitted = [];
      (runtime.traceUploader() as unknown as { deps: { trainingSent(v: boolean): void } }).deps.trainingSent(false);
      expect(call('traces:training')).toMatchObject({ training: false, owed: false });
      expect(emitted).toEqual(['traces:changed']);
    } finally {
      fs.chmodSync(PRIVATE_DIR, 0o700);
      fs.chmodSync(TRAINING_FILE, 0o600);
    }
  });

  it('W15. sessions the store could not mark: the answer to the off says so', () => {
    const s = runtime.openEndpointSession(AGENT);
    traceOf(s.token);
    vi.spyOn(runtime.traceStore(), 'denyTraining').mockImplementation(() => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); });
    const off = call('traces:setTraining', false) as { ok: boolean; unsaved?: string };
    expect(off.ok).toBe(true);
    expect(off.unsaved ?? '').toMatch(/SQLITE_BUSY|database is locked/);
    expect((call('traces:training') as { unsaved?: string }).unsaved ?? '').toMatch(/SQLITE_BUSY|database is locked/);
    runtime.closeEndpointSession(s.token);
  });
});
