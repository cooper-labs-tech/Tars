import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../../../electron/types';
import {
  TRACES_CONSENT_FILE, TRACES_DB_FILE, TRACES_INSTALL_FILE, configureTraces, consentStands, recordConsent, reconcileConsent,
  saveSettingsFromApi, stopTracesRuntime, traceStore, uploadConsentAt, uploadPersistence, withdrawUploadConsent,
} from '../../../electron/services/traces-runtime';

/**
 * A withdrawal of the consent to upload traces never comes back (the orchestrator's follow-up to the Audit's L2 on
 * #599). The rule is not the one for giving consent: the old state is the consent, so a withdrawal takes effect in
 * memory at once, whatever the disk does, and the stored state must never bring the consent back at the next
 * start. Measured on macOS 26 (APFS) before the code: on a full volume, writing, renaming and even truncating a file
 * fail with ENOSPC, while unlinking it works; in a folder that may not be written (0500), unlinking and renaming
 * fail with EACCES, while truncating works. So the consent counts only while its own file, in the private folder,
 * holds the very time the settings say, and a withdrawal unlinks that file, or else truncates it.
 *
 * How it fails, written before the code:
 * W1. A withdrawal on a private folder that cannot be written and settings that cannot be saved, then a restart:
 *     the consent comes back.
 * W2. An upload after a failed withdrawal: the uploader still reads the consent from memory.
 * W3. "Delete everything" on a full disk (the settings cannot be saved), then a restart: uploads resume.
 * W4. A withdrawal that waits for the write: the consent is still in memory while the write fails or hangs.
 * W5. A withdrawal that could keep nothing on disk is silent: the window and the log are not told, and it is not
 *     tried again until it holds.
 * W6. A start whose settings say consent with no consent file, or a partial one (a write cut short), uploads.
 * W7. A consent given is not written to its file, so it never stands.
 * S1. An endpoint change through the API (saveSettingsFromApi) that cannot be written is held in memory anyway.
 * S2. One that can is no longer written first and then applied.
 * Added before their code after the Audit's re-read at a3c07fbfa (its M1, 24/11). "Delete everything" keeps the
 * moment of the deletion and whether its DELETE is still owed in the settings alone, so on settings that cannot be
 * written and a quit before a retry holds:
 * W8. The next start withdraws the consent and nothing else: no moment, so a later consent sends what was recorded
 *     before the deletion; no owed mark, so a DELETE that never went through is never asked again.
 * W9. Or it rebuilds a moment earlier than the deletion's: one from the settings kept, while a session recorded
 *     since (or under a clock moved backward) started later.
 * W10. A start whose settings say no consent invents a deletion.
 * A consent the settings name and its file does not hold is a withdrawal Tars could not record; whether it came with
 * a deletion is not known then, so the start takes it for one (it fails closed).
 */

const AT = '2026-11-24T10:00:00.000Z';
let memory: AppSettings;
let disk: AppSettings | null;
let events: string[];
let failWrite: NodeJS.ErrnoException | null;
let emitted: string[];

const withConsent = (at = AT) => ({ traces: { projects: [], uploadUrl: 'https://backoffice.example.com', uploadConsentAt: at } }) as unknown as AppSettings;
const consentIn = (s: AppSettings | null) => (s as { traces?: { uploadConsentAt?: string } } | null)?.traces?.uploadConsentAt;
const errno = (code: string) => Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
const privateDir = path.dirname(TRACES_CONSENT_FILE);
const posix = process.platform !== 'win32';

beforeEach(() => {
  memory = withConsent();
  disk = structuredClone(memory);
  events = [];
  emitted = [];
  failWrite = null;
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  configureTraces({
    getSettings: () => memory,
    setSettings: (s) => { events.push('memory'); memory = s; },
    writeSettings: (s) => { events.push('write'); if (failWrite) throw failWrite; disk = structuredClone(s); },
    getAgent: () => undefined,
    emit: (channel) => { emitted.push(channel); },
  });
  recordConsent(AT);
});

afterEach(() => {
  // A retry a failed write left pending (W1 to W4) would stand in for the next test's own (W5).
  stopTracesRuntime();
  vi.useRealTimers();
  if (posix) fs.chmodSync(privateDir, 0o700);
  fs.rmSync(TRACES_CONSENT_FILE, { force: true });
  fs.rmSync(TRACES_INSTALL_FILE, { force: true });
  fs.rmSync(path.dirname(TRACES_DB_FILE), { recursive: true, force: true });
});

const deletionIn = (s: AppSettings | null) => (s as { traces?: { uploadDeletedAt?: number; uploadDeletionOwed?: boolean } } | null)?.traces;

describe('a deletion whose bookkeeping could not be written, then a restart (the Audit\'s M1)', () => {
  // "Delete everything": the consent's file dropped, the settings not written, Tars quit before a retry held.
  const deletedThenRestarted = () => {
    fs.rmSync(TRACES_CONSENT_FILE);
    memory = structuredClone(disk!);
  };

  it('W8. the start takes it for a deletion: a moment no earlier than the start, the DELETE owed again, both written', () => {
    fs.writeFileSync(TRACES_INSTALL_FILE, JSON.stringify({ url: 'https://backoffice.example.com', installId: 'i', token: 'tok', secret: 's'.repeat(64), registeredAt: 1 }), { mode: 0o600 });
    deletedThenRestarted();
    const before = Date.now();
    reconcileConsent();
    for (const s of [memory, disk]) {
      expect(consentIn(s)).toBeUndefined();
      expect(deletionIn(s)?.uploadDeletedAt).toBeGreaterThanOrEqual(before);
      expect(deletionIn(s)?.uploadDeletionOwed).toBe(true);
    }
  });

  it('W9. the moment is the latest of the one kept, now, and the newest session; with no install file, nothing is owed', () => {
    const later = Date.now() + 3600_000;
    traceStore().openTrace({ traceId: 't-late', projectPath: '/p', agentId: 'a', agentName: 'A', harness: 'qwen-code', endpointId: 'ep-000001', endpointName: 'E', endpointBaseUrl: 'http://192.0.2.10:9000/v1', model: 'm', startedAt: later });
    deletedThenRestarted();
    reconcileConsent();
    expect(deletionIn(disk)?.uploadDeletedAt).toBe(later);
    expect(deletionIn(disk)?.uploadDeletionOwed).toBeUndefined();
    // A moment kept later still than both stays.
    const kept = later + 3600_000;
    memory = { traces: { ...withConsent().traces, uploadDeletedAt: kept } } as unknown as AppSettings;
    reconcileConsent();
    expect(deletionIn(memory)?.uploadDeletedAt).toBe(kept);
  });

  it('W10. a start whose settings say no consent leaves the deletion marks as they are', () => {
    memory = { traces: { projects: [], uploadUrl: 'https://backoffice.example.com' } } as unknown as AppSettings;
    reconcileConsent();
    expect(deletionIn(memory)?.uploadDeletedAt).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('a consent stands only while its own file says so', () => {
  it('W7. a consent given is written to its file, and stands with the settings that say the same time', () => {
    expect(fs.readFileSync(TRACES_CONSENT_FILE, 'utf8')).toBe(AT);
    expect(consentStands(withConsent())).toBe(true);
  });

  it('W6. settings that say consent with no file, or another time, or a partial one: no consent, and none is uploaded', () => {
    fs.rmSync(TRACES_CONSENT_FILE);
    expect(consentStands(withConsent())).toBe(false);
    expect(uploadConsentAt()).toBeUndefined();
    fs.writeFileSync(TRACES_CONSENT_FILE, AT.slice(0, 10));
    expect(consentStands(withConsent())).toBe(false);
    fs.writeFileSync(TRACES_CONSENT_FILE, '2026-11-23T10:00:00.000Z');
    expect(consentStands(withConsent())).toBe(false);
  });

  it('W6. at start, a consent that does not stand is dropped from the settings', () => {
    fs.rmSync(TRACES_CONSENT_FILE);
    reconcileConsent();
    expect(consentIn(memory)).toBeUndefined();
    expect(consentIn(disk)).toBeUndefined();
  });
});

describe('a withdrawal', () => {
  it('W4. takes effect in memory before anything is written, and uploads stop at once', () => {
    failWrite = errno('ENOSPC');
    withdrawUploadConsent();
    expect(events[0]).toBe('memory');
    expect(consentIn(memory)).toBeUndefined();
    expect(uploadConsentAt()).toBeUndefined();
  });

  it('W2, W3. "delete everything" when the settings cannot be saved: the consent file goes, and a restart has none', () => {
    failWrite = errno('ENOSPC');
    const r = withdrawUploadConsent();
    expect(r.persisted).toBe(true);
    expect(uploadConsentAt()).toBeUndefined();
    // The restart: the settings as they are on disk still say consent, and it does not stand.
    expect(consentIn(disk)).toBe(AT);
    expect(consentStands(disk!)).toBe(false);
  });

  it.skipIf(!posix)('W1. a private folder that may not be written, and settings that cannot be saved: the file is truncated, and a restart has no consent', () => {
    failWrite = errno('EACCES');
    fs.chmodSync(privateDir, 0o500);
    const r = withdrawUploadConsent();
    fs.chmodSync(privateDir, 0o700);
    expect(r.persisted).toBe(true);
    expect(fs.readFileSync(TRACES_CONSENT_FILE, 'utf8')).toBe('');
    expect(consentStands(disk!)).toBe(false);
  });

  it('W5. nothing kept on disk: the window and the log are told, uploads stay off, and it is tried again until it holds', () => {
    vi.useFakeTimers();
    failWrite = errno('ENOSPC');
    // The file cannot be dropped either: a folder in its place, which neither unlink nor truncate takes.
    fs.rmSync(TRACES_CONSENT_FILE);
    fs.mkdirSync(TRACES_CONSENT_FILE);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = withdrawUploadConsent();
      expect(r.persisted).toBe(false);
      expect(uploadPersistence().unsaved).toMatch(/ENOSPC/);
      expect(emitted).toContain('traces:changed');
      expect(log).toHaveBeenCalled();
      expect(uploadConsentAt()).toBeUndefined();
      // Space again: the next try writes the settings, and the notice goes.
      failWrite = null;
      vi.advanceTimersByTime(60_000);
      expect(consentIn(disk)).toBeUndefined();
      expect(uploadPersistence().unsaved).toBeUndefined();
    } finally {
      log.mockRestore();
      fs.rmdirSync(TRACES_CONSENT_FILE);
    }
  });
});

describe('an endpoint change through the API (saveSettingsFromApi)', () => {
  it('S1. a write that fails throws the reason and changes nothing in memory', () => {
    failWrite = errno('ENOSPC');
    const before = structuredClone(memory);
    expect(() => saveSettingsFromApi({ ...memory, inferenceEndpoints: [] } as AppSettings)).toThrow(/ENOSPC.*nothing was changed/);
    expect(memory).toEqual(before);
    expect(events).toEqual(['write']);
  });

  it('S2. a write that works is written first, then applied', () => {
    saveSettingsFromApi({ ...memory, inferenceEndpoints: [] } as AppSettings);
    expect(events).toEqual(['write', 'memory']);
  });
});
