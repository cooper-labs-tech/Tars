import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../../../electron/types';

/**
 * Every answer of main's that carries the upload state carries what the window warns with, `unsaved` (the Audit's
 * I-2 on #599). traces:uploadState had it; traces:abandonDeletion answered the uploader's state alone, so after a
 * give-up whose settings could not be written the window's warning went off until its next read.
 *
 * How it fails, written before the fix (24/11):
 * A1. An answer that carries the upload state lacks `unsaved` while a write is pending.
 * A2. It says `unsaved` once the write held.
 * A3. traces:uploadState and the give-up's answer disagree on the same state.
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

let memory: AppSettings;
let failWith: NodeJS.ErrnoException | null;
let runtime: typeof import('../../../electron/services/traces-runtime');

beforeEach(async () => {
  handlers.clear();
  failWith = null;
  memory = { traces: { projects: [], uploadUrl: 'https://backoffice.example.com', uploadDeletedAt: 5000, uploadDeletionOwed: true } } as unknown as AppSettings;
  runtime = await import('../../../electron/services/traces-runtime');
  const write = (s: AppSettings) => { if (failWith) throw failWith; void s; };
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: write, getAgent: () => undefined, emit: () => {} });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { memory = s; }, writeAppSettings: write });
  fs.mkdirSync(path.dirname(runtime.TRACES_INSTALL_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(runtime.TRACES_INSTALL_FILE, JSON.stringify({ url: 'https://backoffice.example.com', installId: 'i', token: 'tok', secret: 's'.repeat(64), registeredAt: 1 }), { mode: 0o600 });
});

afterEach(() => {
  runtime.stopTracesRuntime();
  fs.rmSync(runtime.TRACES_INSTALL_FILE, { force: true });
  fs.rmSync(path.dirname(runtime.TRACES_DB_FILE), { recursive: true, force: true });
});

describe('the answers that carry the upload state', () => {
  it('A1, A3. a give-up whose settings cannot be written answers its state with the warning, as uploadState does', async () => {
    failWith = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) as NodeJS.ErrnoException;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const answer = await call('traces:abandonDeletion') as { ok: boolean; state?: { unsaved?: string; deletionOwed?: boolean } };
      expect(answer.ok).toBe(true);
      expect(answer.state?.deletionOwed).toBe(false);
      expect(answer.state?.unsaved).toMatch(/ENOSPC.*tries again every minute/);
      const read = await call('traces:uploadState') as { unsaved?: string };
      expect(answer.state?.unsaved).toBe(read.unsaved);
    } finally {
      log.mockRestore();
    }
  });

  it('A2. one whose settings were written carries no warning', async () => {
    const answer = await call('traces:abandonDeletion') as { ok: boolean; state?: Record<string, unknown> };
    expect(answer.ok).toBe(true);
    expect(answer.state).not.toHaveProperty('unsaved');
  });
});
