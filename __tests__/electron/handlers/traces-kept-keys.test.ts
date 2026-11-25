// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import type { AppSettings } from '../../../electron/types';
import { APP_SETTINGS_FILE, DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

/**
 * A key a failed save kept must stay kept (the Audit's I-2a at ae56b8d6e). When app-settings.json cannot be written
 * and the keys' file cannot be put back either, the new key stays on disk and the window is told it was kept and
 * loads at the next start. The window's apply() and the API's saveSettingsFromApi kept the old settings in memory
 * then, so the next save that held in the same run, the minute's retry included, wrote the old key back: the key
 * said to be kept did not load at the next start.
 *
 * How it fails, written before the fix (24/11):
 * K1. Through the window's channel (endpoints:setKey), a key set on a failed save whose put-back fails, then another
 *     save that holds (endpoints:save), then a restart: the old key loads.
 * K2. Through the API (saveSettingsFromApi), the same: the old key loads.
 * K3. Memory then holds the rest of a save that did not hold (only the keys were kept, nothing else).
 *
 * Real files, in the throwaway home: saveSettingsSplit writes them; the put-back is made to fail through the write
 * module, as settings-secrets.test.ts P15 does.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

const putBack = vi.hoisted(() => ({ fail: false, writes: 0 }));
vi.mock('../../../electron/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/secret-file')>();
  return {
    ...actual,
    writeSecretFileSync: (file: string, contents: string) => {
      if (putBack.fail && file.endsWith('settings-secrets.json') && ++putBack.writes === 2) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return actual.writeSecretFileSync(file, contents);
    },
  };
});

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

let memory: AppSettings;
let secrets: typeof import('../../../electron/services/settings-secrets');
let runtime: typeof import('../../../electron/services/traces-runtime');
const EP = { name: 'Remote', baseUrl: 'https://inference.example.com/v1' };

// app-settings.json cannot be written (a folder in its place) and the keys' file cannot be put back.
const full = () => {
  fs.rmSync(APP_SETTINGS_FILE, { force: true });
  fs.mkdirSync(APP_SETTINGS_FILE);
  putBack.fail = true;
  putBack.writes = 0;
};
const room = () => {
  putBack.fail = false;
  fs.rmSync(APP_SETTINGS_FILE, { recursive: true, force: true });
};

beforeEach(async () => {
  handlers.clear();
  putBack.fail = false;
  secrets = await import('../../../electron/services/settings-secrets');
  runtime = await import('../../../electron/services/traces-runtime');
  memory = { slackEnabled: true, deepSeekApiKey: 'ds-old-111', traces: { projects: [] } } as unknown as AppSettings;
  secrets.saveSettingsSplit(memory);
  runtime.configureTraces({
    getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: (s) => secrets.saveSettingsSplit(s),
    getAgent: () => undefined, emit: () => {},
  });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { memory = s; }, writeAppSettings: (s) => secrets.saveSettingsSplit(s) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  room();
  runtime.stopTracesRuntime();
  fs.rmSync(APP_SETTINGS_FILE, { force: true });
  fs.rmSync(secrets.SECRETS_FILE, { force: true });
});

describe('a key a failed save kept stays kept', () => {
  it('K1, K3. through the window: set on a failed save, another save holds, and the kept key loads at the restart', () => {
    const saved = call('endpoints:save', EP) as { ok: boolean; endpoint: { id: string } };
    expect(saved.ok).toBe(true);
    const id = saved.endpoint.id;
    expect(call('endpoints:setKey', id, 'ep-key-old')).toMatchObject({ ok: true });

    full();
    const set = call('endpoints:setKey', id, 'ep-key-new') as { ok: boolean; error?: string };
    expect(set.ok).toBe(false);
    expect(set.error).toMatch(/kept/);
    room();

    expect(call('endpoints:save', { ...EP, id, name: 'Remote 2' })).toMatchObject({ ok: true });
    expect((secrets.loadSettingsWithSecrets() as AppSettings).endpointKeys?.[id]).toBe('ep-key-new');
    expect((memory as AppSettings).endpointKeys?.[id]).toBe('ep-key-new');
  });

  it('K2, K3. through the API: set on a failed save, another save holds, and the kept key loads at the restart', () => {
    full();
    expect(() => runtime.saveSettingsFromApi({ ...memory, deepSeekApiKey: 'ds-new-999', slackEnabled: false } as AppSettings)).toThrow(/kept/);
    room();
    // Only the keys were kept: the rest of that save is not in memory.
    expect((memory as { slackEnabled?: boolean }).slackEnabled).toBe(true);
    runtime.saveSettingsFromApi({ ...memory, terminalFontSize: 15 } as AppSettings);
    const loaded = secrets.loadSettingsWithSecrets() as AppSettings & { terminalFontSize?: number };
    expect(loaded.deepSeekApiKey).toBe('ds-new-999');
    expect(loaded.slackEnabled).toBe(true);
    expect(loaded.terminalFontSize).toBe(15);
  });
});
