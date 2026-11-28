import '../../setup/throwaway-home';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStatus, AppSettings } from '../../../electron/types';
import type { HarnessCompaction } from '../../../electron/services/harness-compactions';
import { DATA_DIR } from '../../../electron/constants';
import { TraceStore } from '../../../electron/services/trace-store';
import {
  TRACES_DB_FILE, closeEndpointSession, liveTraceOf, openEndpointSession, startTracesRuntime, stopTracesRuntime, traceStore,
} from '../../../electron/services/traces-runtime';

/**
 * A harness's log read at a session's end, landing after the runtime stopped (the Audit of #687 at 94e4693b8, its Info).
 * Written before the fix. How it can fail:
 *
 * C19. The read resolves after stopTracesRuntime (Tars quitting while a session's log is still being read): its result
 *     is applied through traceStore(), which opens a store when none is open. The store the stop closed is opened
 *     again past the quit, and the compactions are written into it.
 *
 * The control: the same read, resolving while the runtime runs, writes its compactions (the path is reached).
 *
 * Only what would leave the process is stood in for: the endpoint proxy (no port bound), git (no process), the
 * machine's probes (no process) and the reader itself, which answers when the test says.
 */

const held = vi.hoisted(() => ({ reads: 0, resolve: undefined as undefined | ((events: HarnessCompaction[]) => void) }));

vi.mock('../../../electron/services/harness-compactions', async (orig) => ({
  ...(await orig<typeof import('../../../electron/services/harness-compactions')>()),
  readHarnessCompactions: () => {
    held.reads++;
    return new Promise<HarnessCompaction[]>((resolve) => { held.resolve = resolve; });
  },
}));
vi.mock('../../../electron/services/endpoint-proxy', async (orig) => ({
  ...(await orig<typeof import('../../../electron/services/endpoint-proxy')>()),
  startEndpointProxy: () => {},
  stopEndpointProxy: () => {},
}));
vi.mock('../../../electron/utils/safe-git', () => ({ safeGit: () => Promise.reject(new Error('no git in this test')) }));
vi.mock('../../../electron/services/session-environment', async (orig) => {
  const m = await orig<typeof import('../../../electron/services/session-environment')>();
  return {
    ...m,
    nodeEnvironmentIo: (v?: () => string) => ({
      ...m.nodeEnvironmentIo(v),
      run: () => Promise.reject(new Error('no process in this test')),
      readFile: () => Promise.reject(new Error('no file in this test')),
    }),
  };
});

const project = path.join(DATA_DIR, '..', 'work', 'project-a');
const ENDPOINT = {
  id: 'ep-0a0b0c', name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', allowTraces: true, models: ['open-coder'],
  approved: true, approvedBaseUrl: 'http://127.0.0.1:9/v1', holdMaxSeconds: 120,
};
const agent = { id: 'a1', name: 'Coder', provider: 'qwen-code', model: 'open-coder', endpointId: ENDPOINT.id, projectPath: project, traces: true } as unknown as AgentStatus;
let settings: AppSettings;

const wal = () => fs.existsSync(`${TRACES_DB_FILE}-wal`) || fs.existsSync(`${TRACES_DB_FILE}-shm`);
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 50); });

/** A traced Qwen Code session opened and ended: its log read is now held, its trace id returned. */
async function endedSession(): Promise<string> {
  const { token } = openEndpointSession(agent.id);
  const traceId = liveTraceOf(agent.id);
  expect(token && traceId, 'the session is traced').toBeTruthy();
  closeEndpointSession(token);
  await vi.waitFor(() => expect(held.reads).toBe(1));
  return traceId!;
}

beforeEach(() => {
  fs.mkdirSync(project, { recursive: true });
  held.reads = 0;
  held.resolve = undefined;
  settings = {
    inferenceEndpoints: [ENDPOINT], traces: { projects: [project], pairs: [{ harness: 'qwen-code', models: '*' }] },
  } as unknown as AppSettings;
  startTracesRuntime({
    getSettings: () => settings, setSettings: (s) => { settings = s; }, writeSettings: () => {},
    getAgent: (id) => (id === agent.id ? agent : undefined), emit: () => {},
  });
});
afterEach(() => {
  stopTracesRuntime();
});

describe('a harness log read landing after the runtime stopped', () => {
  it('the control: a read landing while the runtime runs writes its compactions', async () => {
    const traceId = await endedSession();
    held.resolve!([{ at: Date.now(), kind: 'summarize', before: 5000, after: 900 }]);
    await vi.waitFor(() => expect(traceStore().session(traceId)!.session.compactions).toHaveLength(1));
  });

  it('C19: a read landing after the stop writes nothing, and the store the stop closed stays closed', async () => {
    const traceId = await endedSession();
    expect(wal(), 'the store is open while the runtime runs').toBe(true);
    stopTracesRuntime();
    expect(wal(), 'the stop closed the store').toBe(false);

    held.resolve!([{ at: Date.now(), kind: 'summarize', before: 5000, after: 900 }]);
    await settle();
    expect(wal(), 'the store was opened again past the stop').toBe(false);

    const after = new TraceStore(TRACES_DB_FILE);
    try {
      expect(after.session(traceId)!.session.compactions, 'written past the stop').toEqual([]);
    } finally {
      after.close();
    }
  });
});
