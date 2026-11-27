// First: the home's guard, before anything loads electron/constants (throwaway-home.ts).
import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AppSettings } from '../../../electron/types';
import type { SessionEnvironment } from '../../../electron/services/session-environment';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

/**
 * What leaves this computer, as the window shows it before any consent: each field a session's upload now carries
 * (its environment, its power events, the harness's own session id, the live count on each request) has its own line,
 * and what is never read (the computer's name, the user's, a serial number, an address) is said to stay.
 *
 * How it fails, written before the code (27/11):
 * N1. A field the upload sends has no line of its own in the notice: a consent given on the notice would not cover it.
 * N2. A field is added to the environment without its line (the list below names every key the environment has, and
 *     a key it does not name fails).
 * N3. The notice does not say that the computer's name, the user's name, a serial number and the addresses stay.
 * Added before their code (27/11, the endpoint's Server-Timing):
 * N4. A request's round trip, its clock offset, its wait for a slot or its wait for the model server, or a session's
 *     median round trip or clock offset, is sent with no line of its own.
 * N6. (Trace feature C2, before its code.) The context window and output cap given to the harness, whether it
 *     compacts on its own, its compactions or the requests after a rewrite are sent with no line of their own.
 * Added before the rewording (27/11, the Audit's read of #681, its Info 2):
 * N5. A line leans on the one before it ("its kernel's version", "their timing"): the window lays the notice out in
 *     two columns read down then across, so a line may open the second column, and its neighbours change as other
 *     features add lines. Each line names its own subject.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); } },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));

let memory: AppSettings;
let runtime: typeof import('../../../electron/services/traces-runtime');

beforeEach(async () => {
  handlers.clear();
  memory = { traces: { projects: [] } } as unknown as AppSettings;
  runtime = await import('../../../electron/services/traces-runtime');
  runtime.configureTraces({ getSettings: () => memory, setSettings: (s) => { memory = s; }, writeSettings: () => {}, getAgent: () => undefined, emit: () => {} });
  const { registerTracesHandlers } = await import('../../../electron/handlers/traces-handlers');
  registerTracesHandlers({ getAppSettings: () => memory, setAppSettings: (s) => { memory = s; }, writeAppSettings: () => {} });
});
afterEach(() => {
  runtime.stopTracesRuntime();
  fs.rmSync(path.dirname(runtime.TRACES_DB_FILE), { recursive: true, force: true });
});

/** Each field the upload carries now, and the words of the line that says it. */
const ENVIRONMENT_LINES: Record<keyof SessionEnvironment, RegExp> = {
  tarsVersion: /Tars's version/,
  osName: /your system's name and version/,
  osVersion: /your system's name and version/,
  kernel: /your system's kernel version/,
  arch: /processor architecture/,
  tarsArch: /processor architecture/,
  machineModel: /your computer's model/,
  chip: /your computer's processor name/,
  cpuCores: /your computer's number of processor cores/,
  ramBytes: /your computer's memory/,
  locale: /language and region/,
  timeZone: /^your time zone \(/,
  utcOffsetMinutes: /offset from UTC/,
  onBattery: /on battery when the session started/,
};
const OTHER_LINES: Record<string, RegExp> = {
  events: /slept or woke.*battery or mains power/,
  nativeSessionId: /the harness's own id for the session/,
  liveSessions: /how many traced sessions were running/,
  'request.rttMs': /each request's round trip to the endpoint/,
  'request.clockOffsetMs': /each request, how far this computer's clock was from the endpoint's/,
  'request.queueMs': /how long each request waited at the endpoint for a free slot/,
  'request.upstreamMs': /how long the endpoint waited for its model server/,
  'session.rttMedianMs': /each session's median round trip/,
  'session.clockOffsetMs': /each session, how far this computer's clock was from the endpoint's, at its fastest round trip/,
  'session.contextWindowGiven': /the context window Tars gave the harness/,
  'session.outputCapGiven': /the output cap Tars gave the harness/,
  'session.autoCompaction': /whether the harness compacts its history on its own/,
  'session.compactions': /when the harness compacted or cut its history, and the prompt's length before and after/,
  'request.contextReset': /which requests came after the history was rewritten, and how many tokens it dropped/,
};

describe('the upload notice', () => {
  it('N1 and N2: every field the upload now carries has its own line', async () => {
    const notice = await handlers.get('traces:uploadNotice')!({}) as { leaves: string[]; stays: string[] };
    const sample: SessionEnvironment = {
      osName: null, osVersion: null, kernel: null, arch: null, machineModel: null, chip: null, cpuCores: null, ramBytes: null,
      tarsVersion: null, tarsArch: 'arm64', locale: null, timeZone: null, utcOffsetMinutes: null, onBattery: null,
    };
    expect(Object.keys(sample).sort()).toEqual(Object.keys(ENVIRONMENT_LINES).sort());
    for (const [field, words] of Object.entries({ ...ENVIRONMENT_LINES, ...OTHER_LINES })) {
      expect(notice.leaves.filter(l => words.test(l)), field).toHaveLength(1);
    }
  });

  it('N5: no line leans on the one before it', async () => {
    const notice = await handlers.get('traces:uploadNotice')!({}) as { leaves: string[]; stays: string[] };
    const leaning = [...notice.leaves, ...notice.stays].filter(l => /^(its|it|their|they|them|this|these|that|those)\b/i.test(l.trim()));
    expect(leaning).toEqual([]);
  });

  it('N3: what is never read is said to stay', async () => {
    const notice = await handlers.get('traces:uploadNotice')!({}) as { leaves: string[]; stays: string[] };
    expect(notice.stays.some(l => /computer's name/.test(l) && /user name/.test(l) && /serial number/.test(l) && /IP address/.test(l))).toBe(true);
  });
});
