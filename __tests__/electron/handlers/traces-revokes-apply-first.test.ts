// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * The revokes of sharing apply first, on a disk that cannot be written too (the orchestrator's rule for #596: a
 * grant is written before it applies, a revoke applies before it is written and never comes back). Five still wrote
 * first: opting a project out, removing a pair, leaving closed models out, turning an endpoint's traces off, and
 * removing an endpoint. On settings that could not be written each answered ok:false "nothing was changed" while the
 * uploader went on sending exactly what it would have stopped. And three of them did not reach the sending at all:
 * the trace gate was read when a session was recorded, never when it was sent, so a pair removed, closed models left
 * out or an endpoint's traces turned off did not hold back a session recorded before.
 *
 * How it fails, written before the fix (25/11):
 * V1. A project opted out on settings that cannot be written: its sessions are still among those a pass would send.
 * V2. A pair removed: the same, whether or not the settings were written.
 * V3. Closed models left out: the same for a session on a closed model.
 * V4. An endpoint's traces turned off: the same for its sessions.
 * V5. An endpoint removed: the same.
 * V6. The answer is ok:false "nothing was changed", though the revoke must have applied.
 * V7. A restart after a revoke whose write never held reads the old settings, and shares again what it stopped.
 * V8. The write is not tried again until it holds, and the window is not told (`unsaved`).
 * V9. A grant (opting a project in) no longer writes first.
 * The count the window shows, pendingSessions, is a pass's own rule (trace-upload.ts state()), so it is what is
 * measured here.
 * Added before their code after the Audit's re-read at 01b73680c (25/11):
 * V10. (Its L2.) The consent's file can be neither removed nor emptied, and the settings cannot be written: a restart
 *      before a write holds shares the revoke's sessions again, and the window is told only that Tars tries again.
 *      On macOS and Linux only: a read-only file (0o444) refuses the truncate and its folder (0o500) the unlink. On
 *      Windows libuv deletes a read-only file, so no mode makes the case there, and no witness here carries it.
 * V11. (Its L3.) A revoke whose write failed, then the settings written by another save once the disk writes again,
 *      then Tars quits before the next try: the next start finds the consent in the settings and not in its file,
 *      and takes it for a deletion.
 * V12. (Its L4.) An endpoint's address moved in the same save that turns its traces off, on settings that cannot be
 *      written: the new address, approved by the act, applies before it is written, and the answer is ok.
 * V13. (The orchestrator's note for #599, which shows these words as they are.) While a revoke holds the consent
 *      back, the note says only that sharing is stopped and Tars tries again: not that Tars tries once more as it
 *      quits, nor that a start before a write holds takes the consent as withdrawn.
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

const AT = '2026-11-25T10:00:00.000Z';
const P1 = path.join(DATA_DIR, '..', 'projects', 'one');
const P2 = path.join(DATA_DIR, '..', 'projects', 'two');
const EP = 'ep-0a0b0c';
const BASE = 'http://127.0.0.1:9/v1';
const AGENT = 'agent-r';
let memory: AppSettings;
let disk: AppSettings;
let failWith: NodeJS.ErrnoException | null;
let runtime: typeof import('../../../electron/services/traces-runtime');

const settings = (): AppSettings => ({
  inferenceEndpoints: [{ id: EP, name: 'Local', baseUrl: BASE, allowTraces: true, approved: true, approvedBaseUrl: BASE, models: ['open-coder-1'] }],
  traces: { projects: [P1, P2], pairs: [{ harness: 'qwen-code', models: '*' }], excludeClosedModels: false, uploadUrl: 'https://backoffice.example.com', uploadConsentAt: AT },
}) as unknown as AppSettings;

const record = (traceId: string, model = 'open-coder-1', projectPath = P1) => {
  const store = runtime.traceStore();
  const startedAt = Date.now();
  store.openTrace({ traceId, projectPath, agentId: AGENT, agentName: 'R', harness: 'qwen-code', endpointId: EP, endpointName: 'Local', endpointBaseUrl: BASE, model, startedAt });
  const body = (v: unknown) => Buffer.from(JSON.stringify(v));
  store.ingest({ traceId, agentId: AGENT, surface: 'openai_chat', startedAt, endedAt: startedAt + 10, status: 200, contentType: 'application/json',
    requestBody: body({ model, messages: [{ role: 'user', content: traceId }] }),
    responseBody: body({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    attempts: 1, heldMs: 0 });
};
const pending = () => runtime.traceUploader().state().pendingSessions;
const full = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) as NodeJS.ErrnoException;

beforeEach(async () => {
  handlers.clear();
  failWith = null;
  memory = settings();
  disk = structuredClone(memory);
  runtime = await import('../../../electron/services/traces-runtime');
  const write = (s: AppSettings) => { if (failWith) throw failWith; disk = structuredClone(s); };
  const getAgent = (id: string) => (id === AGENT ? ({ id, traces: true, projectPath: P1 } as unknown as AgentStatus) : undefined);
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: write, getAgent, emit: () => {} });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { memory = s; }, writeAppSettings: write });
  runtime.recordConsent(AT);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  runtime.stopTracesRuntime();
  fs.rmSync(runtime.TRACES_CONSENT_FILE, { force: true });
  fs.rmSync(path.dirname(runtime.TRACES_DB_FILE), { recursive: true, force: true });
});

describe('a revoke of sharing on settings that cannot be written applies at once', () => {
  it('V1, V6. a project opted out: none of its sessions would be sent, and the answer is ok with the reason it is unsaved', () => {
    record('s-one');
    expect(pending()).toBe(1);
    failWith = full();
    const answer = call('traces:setSettings', { projects: [P2] }) as { ok: boolean; unsaved?: string; error?: string };
    expect(pending()).toBe(0);
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(answer.unsaved).toMatch(/ENOSPC/);
  });

  it('V2. a pair removed: none of its sessions would be sent', () => {
    record('s-pair');
    expect(pending()).toBe(1);
    failWith = full();
    const answer = call('traces:removePair', { harness: 'qwen-code', models: '*' });
    expect(pending()).toBe(0);
    expect(answer).toMatchObject({ ok: true });
  });

  it('V3. closed models left out: a session on a closed model would not be sent', () => {
    record('s-closed', 'gpt-5-mini');
    expect(pending()).toBe(1);
    failWith = full();
    const answer = call('traces:setSettings', { excludeClosedModels: true });
    expect(pending()).toBe(0);
    expect(answer).toMatchObject({ ok: true });
  });

  it('V4. an endpoint\'s traces turned off: none of its sessions would be sent', () => {
    record('s-endpoint');
    expect(pending()).toBe(1);
    failWith = full();
    const answer = call('endpoints:save', { id: EP, allowTraces: false });
    expect(pending()).toBe(0);
    expect(answer).toMatchObject({ ok: true });
  });

  it('V5. an endpoint removed: none of its sessions would be sent', () => {
    record('s-removed');
    expect(pending()).toBe(1);
    failWith = full();
    const answer = call('endpoints:remove', EP);
    expect(pending()).toBe(0);
    expect(answer).toMatchObject({ ok: true });
  });

  it('V7. a restart after a revoke whose write never held reads closed: no consent stands', () => {
    record('s-restart');
    failWith = full();
    call('traces:setSettings', { projects: [P2] });
    // The restart: the settings on disk are the old ones, the project still opted in.
    memory = structuredClone(disk);
    runtime.stopTracesRuntime();
    runtime.reconcileConsent();
    expect(runtime.uploadConsentAt()).toBeUndefined();
  });

  it('V8. the write is tried again every minute until it holds, the window told meanwhile, and sharing goes on after', () => {
    vi.useFakeTimers();
    failWith = full();
    call('traces:setSettings', { projects: [P2] });
    expect(runtime.uploadPersistence().unsaved).toMatch(/ENOSPC/);
    failWith = null;
    vi.advanceTimersByTime(60_000);
    expect((disk.traces as { projects: string[] }).projects).toEqual([P2]);
    expect(runtime.uploadPersistence().unsaved).toBeUndefined();
    expect(runtime.uploadConsentAt()).toBe(AT);
  });

  it('V9. a grant (opting a project in) is still written first: a write that fails changes nothing', () => {
    memory = { ...memory, traces: { ...(memory.traces as object), projects: [P2] } } as AppSettings;
    failWith = full();
    const answer = call('traces:setSettings', { projects: [P1, P2] }) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect((memory.traces as { projects: string[] }).projects).toEqual([P2]);
  });

  it.skipIf(process.platform === 'win32')('V10. a revoke whose consent file stays and whose settings are refused: the window is told a restart would share again', () => {
    const file = runtime.TRACES_CONSENT_FILE;
    const folder = path.dirname(file);
    fs.chmodSync(file, 0o444);
    fs.chmodSync(folder, 0o500);
    failWith = full();
    let answer: { ok: boolean; unsaved?: string };
    try {
      answer = call('traces:removePair', { harness: 'qwen-code', models: '*' }) as { ok: boolean; unsaved?: string };
    } finally {
      fs.chmodSync(folder, 0o700);
      fs.chmodSync(file, 0o600);
    }
    expect(answer.ok).toBe(true);
    expect(answer.unsaved).toMatch(/restart/);
    expect(answer.unsaved).toMatch(/once more as it quits/);
    expect(runtime.uploadPersistence().unsaved).toMatch(/restart/);
  });

  it('V11. a revoke written by another save before Tars quits: the next start still finds the consent', () => {
    failWith = full();
    call('traces:removePair', { harness: 'qwen-code', models: '*' });
    // The disk writes again, and the window saves a grant through its own write (not the runtime's retry).
    failWith = null;
    const answer = call('traces:setSettings', { projects: [P1, P2, path.join(DATA_DIR, '..', 'projects', 'three')] });
    expect(answer).toMatchObject({ ok: true });
    expect(disk.traces).toMatchObject({ pairs: [] });
    // Tars quits before the minute's retry, then starts again on what is on disk.
    runtime.stopTracesRuntime();
    memory = structuredClone(disk);
    runtime.reconcileConsent();
    expect(runtime.uploadConsentAt()).toBe(AT);
  });

  it('V12. an address moved with traces turned off, on settings that cannot be written: the move is not applied, and the answer says so', () => {
    failWith = full();
    const answer = call('endpoints:save', { id: EP, baseUrl: 'http://127.0.0.1:10/v1', allowTraces: false }) as { ok: boolean };
    const ep = (memory.inferenceEndpoints ?? []).find(e => e.id === EP);
    expect(ep?.allowTraces).toBe(false);
    expect(ep?.baseUrl).toBe(BASE);
    expect(answer.ok).toBe(false);
  });

  it('V13. while a revoke holds the consent back, the note says what a quit before it is saved does', () => {
    failWith = full();
    const answer = call('traces:removePair', { harness: 'qwen-code', models: '*' }) as { ok: boolean; unsaved?: string };
    expect(answer.unsaved).toMatch(/once more as it quits/);
    expect(answer.unsaved).toMatch(/the next start takes your consent as withdrawn/);
    expect(runtime.uploadPersistence().unsaved).toBe(answer.unsaved);
  });
});
