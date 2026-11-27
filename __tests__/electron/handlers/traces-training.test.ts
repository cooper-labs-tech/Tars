// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';
import { hasPosixModes } from '../../setup/platform-limits';

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
let memory: AppSettings;
let runtime: typeof import('../../../electron/services/traces-runtime');

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
  runtime = await import('../../../electron/services/traces-runtime');
  const getAgent = (id: string) => (id === AGENT ? ({ id, name: 'T', traces: true, projectPath: P1, provider: 'qwen-code', model: 'open-coder-1', endpointId: EP } as unknown as AgentStatus) : undefined);
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: () => {}, getAgent, emit: () => {} });
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
