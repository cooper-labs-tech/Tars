import { describe, it, expect, vi } from 'vitest';

/**
 * The window's endpoint picker shows, for each harness an endpoint can run, how it was measured on one
 * (handlers/traces-handlers.ts, HARNESS_SUPPORT, served as endpoints:harnesses): whether its tool calls went through
 * Tars's proxy, on which API, at which version.
 *
 * How it fails, written before Cline's entry:
 * 1. A harness an endpoint can run (services/inference-endpoints.ts, ENDPOINT_HARNESSES) with no entry: the window
 *    says nothing of how it was measured, as for Cline when it joined the endpoints (t-87f42909).
 * 2. An entry for a harness no endpoint runs: the window offers what the main process refuses.
 * 3. An entry that names no version it was measured on.
 */

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/nowhere' } }));

import { HARNESS_SUPPORT } from '../../../electron/handlers/traces-handlers';
import { ENDPOINT_HARNESSES } from '../../../electron/services/inference-endpoints';

describe('how each harness an endpoint runs was measured', () => {
  it('every harness an endpoint can run has its entry, and no other (1, 2)', () => {
    expect(HARNESS_SUPPORT.map((h) => h.harness).sort()).toEqual([...ENDPOINT_HARNESSES].sort());
  });

  it('each names the version it was measured on (3)', () => {
    for (const h of HARNESS_SUPPORT) expect(h.measuredOn, h.harness).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
