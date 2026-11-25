import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import type { AppSettings } from '../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * Emptying or changing the back-office address takes the consent back (the Audit's L2 at 1e9571eab): a consent is
 * given for one address. traces:setSettings dropped it from the settings it then wrote first, and changed nothing in
 * memory when that write failed, so on a full disk a user who emptied the address to stop sharing was told it was
 * not saved, while the uploader kept the old address and the consent and went on sending.
 *
 * How it fails, written before the fix (24/11):
 * R1. The address emptied on settings that cannot be written: the consent still stands where the uploader reads it.
 * R2. The address changed to another one, the same.
 * R3. The window is told nothing changed, though sharing must have stopped.
 * R4. A change that drops no consent (none was given) is no longer written first and applied after.
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

const AT = '2026-11-24T10:00:00.000Z';
let memory: AppSettings;
let failWith: NodeJS.ErrnoException | null;
let events: string[];
let runtime: typeof import('../../../electron/services/traces-runtime');

beforeEach(async () => {
  handlers.clear();
  failWith = null;
  events = [];
  memory = { traces: { projects: [], uploadUrl: 'https://backoffice.example.com', uploadConsentAt: AT } } as unknown as AppSettings;
  runtime = await import('../../../electron/services/traces-runtime');
  const write = (s: AppSettings) => { events.push('write'); if (failWith) throw failWith; void s; };
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { events.push('memory'); memory = s; }, writeSettings: write, getAgent: () => undefined, emit: () => {} });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { events.push('memory'); memory = s; }, writeAppSettings: write });
  runtime.recordConsent(AT);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  runtime.stopTracesRuntime();
  fs.rmSync(runtime.TRACES_CONSENT_FILE, { force: true });
});

const full = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) as NodeJS.ErrnoException;

describe('the back-office address, changed on settings that cannot be written', () => {
  it('R1, R3. emptied: the consent no longer stands at once, and the window is told sharing stopped', () => {
    expect(runtime.uploadConsentAt()).toBe(AT);
    failWith = full();
    const answer = call('traces:setSettings', { uploadUrl: '' }) as { ok: boolean; error?: string };
    expect(runtime.uploadConsentAt()).toBeUndefined();
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/ENOSPC/);
    expect(answer.error).toMatch(/sharing stopped/i);
    expect(answer.error).not.toMatch(/nothing was changed/);
  });

  it('R2. changed to another address: the same', () => {
    failWith = full();
    call('traces:setSettings', { uploadUrl: 'https://other.example.com' });
    expect(runtime.uploadConsentAt()).toBeUndefined();
  });

  it('R4. a change that drops no consent is written first, then applied', () => {
    runtime.withdrawUploadConsent();
    events = [];
    const answer = call('traces:setSettings', { uploadUrl: '' }) as { ok: boolean };
    expect(answer.ok).toBe(true);
    expect(events).toEqual(['write', 'memory']);
  });
});
