import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '../../../electron/types';

/**
 * A trace setting main cannot write (the Audit's L2, found reading #599; it was already in #596).
 *
 * traces:giveUploadConsent set the consent in memory, then saved; the save caught and logged every error
 * (main.ts saveAppSettingsToFile), so on a full disk the window was answered ok and its notice closed on "consent
 * given", while the consent lived in memory only, where the uploader reads it, until the next start forgot it.
 *
 * How it fails, written before the fix:
 * 1. A write that fails is answered ok: the window is told the consent (or any trace or endpoint setting) is given.
 * 2. The settings are set in memory before they are written, so a failed write leaves the consent where the
 *    uploader reads it for the rest of the run.
 * 3. The answer does not say why: it must be ok:false with main's reason (the error's code) and that nothing changed.
 * 4. A write that works is no longer applied in memory, or no longer answered ok.
 * 5. Another trace or endpoint setting of the same handlers keeps the old order: traces:setSettings, the pairs,
 *    endpoints:save, :approve, :setKey and :remove.
 * Since 25/11 only the grants among these write first. The revokes of sharing (a project opted out, a pair removed,
 * closed models left out, an endpoint's traces off, an endpoint removed) apply first, and are held in
 * traces-revokes-apply-first.test.ts.
 */

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
  return fn({}, ...args) as Promise<Record<string, unknown>> | Record<string, unknown>;
};

const BASE = { traces: { projects: [], uploadUrl: 'http://127.0.0.1:9/backoffice' } } as unknown as AppSettings;
let memory: AppSettings;
let disk: AppSettings | null;
let events: string[];
let failWith: NodeJS.ErrnoException | null;

beforeEach(async () => {
  handlers.clear();
  memory = structuredClone(BASE);
  disk = null;
  events = [];
  failWith = null;
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({
    getAppSettings: () => memory,
    setAppSettings: (s) => { events.push('memory'); memory = s; },
    writeAppSettings: (s) => {
      events.push('write');
      if (failWith) throw failWith;
      disk = structuredClone(s);
    },
  });
});

const full = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) as NodeJS.ErrnoException;
const consentOf = (s: AppSettings | null) => (s as { traces?: { uploadConsentAt?: string } } | null)?.traces?.uploadConsentAt;

describe('the upload consent, written before it is given', () => {
  it('1, 2, 3. a write that fails: ok:false with the reason, and the consent is nowhere, not even in memory', async () => {
    failWith = full();
    const answer = await call('traces:giveUploadConsent');
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toMatch(/ENOSPC/);
    expect(String(answer.error)).toMatch(/nothing was changed/i);
    expect(consentOf(memory)).toBeUndefined();
    expect(disk).toBeNull();
    expect(events).not.toContain('memory');
  });

  it('2, 4. a write that works: written first, then set in memory, and answered ok', async () => {
    const answer = await call('traces:giveUploadConsent');
    expect(answer).toMatchObject({ ok: true });
    expect(events).toEqual(['write', 'memory']);
    expect(consentOf(disk)).toBe(answer.at);
    expect(consentOf(memory)).toBe(answer.at);
  });
});

describe('the other trace and endpoint settings of the same handlers (5)', () => {
  const cases: Array<[string, unknown[]]> = [
    ['traces:setSettings', [{ retentionDays: 7 }]],
    ['traces:addPair', [{ harness: 'codex', models: '*' }]],
    ['endpoints:save', [{ name: 'Local', baseUrl: 'http://127.0.0.1:9/v1' }]],
  ];

  for (const [channel, args] of cases) {
    it(`${channel}: a write that fails is ok:false with the reason and changes nothing in memory`, async () => {
      failWith = full();
      const before = structuredClone(memory);
      const answer = await call(channel, ...args);
      expect(answer.ok, JSON.stringify(answer)).toBe(false);
      expect(String(answer.error)).toMatch(/ENOSPC/);
      expect(memory).toEqual(before);
      expect(events).not.toContain('memory');
    });

    it(`${channel}: a write that works is written first, then applied`, async () => {
      const answer = await call(channel, ...args);
      expect(answer.ok, JSON.stringify(answer)).toBe(true);
      expect(events).toEqual(['write', 'memory']);
    });
  }

  // endpoints:remove is a revoke of sharing, which applies first since 25/11 (traces-revokes-apply-first.test.ts V5).
  it('endpoints:approve and :setKey: a write that fails changes nothing in memory', async () => {
    const saved = await call('endpoints:save', { name: 'Local', baseUrl: 'http://127.0.0.1:9/v1' });
    const id = String((saved.endpoint as { id: string }).id);
    failWith = full();
    events = [];
    const before = structuredClone(memory);
    for (const [channel, args] of [['endpoints:setKey', [id, 'sk-test-not-a-key']], ['endpoints:approve', [id]]] as const) {
      const answer = await call(channel, ...args);
      expect(answer.ok, `${channel}: ${JSON.stringify(answer)}`).toBe(false);
      expect(String(answer.error), channel).toMatch(/ENOSPC/);
    }
    expect(memory).toEqual(before);
    expect(events).not.toContain('memory');
  });
});
