import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The local API when its port is already taken.
 *
 * Port 31415 is a contract: CLAUDE_MGR_API_URL, the shell hooks and the seven
 * bundled MCP servers all assume something is listening on it. The server used
 * to log one line on EADDRINUSE and abandon the port for the life of the
 * process, so a Tars launched while the previous one was still shutting down
 * came up looking perfectly healthy with every path back into the app dead.
 *
 * And from the Audit's gate of #541 (H1), written before the code: claude's
 * MCP calls to Tars's shared servers carry its token to whatever holds the
 * port, with no proof it is this Tars, and agents started while Tars retried
 * its port (about 90 s at launch) handed their token to the process holding it.
 * No agent CLI starts until this Tars listens (apiListening):
 * G1. it waits while the port is retried, and goes on once Tars binds;
 * G2. it refuses (false) once Tars gave the port up;
 * G3. a process that never started an API (the unit tests) is not held.
 * And from the Audit's re-check of #541 (L3): `stopped` reads as "may start", and the app is `stopped` from its boot
 * until initApiServer, the window and the IPC already up; only the order of main.ts kept an agent from starting there.
 * G4. The app does not mark its API starting before it creates the window and registers the IPC: "not started yet"
 *     must wait as a retry does, and a quit's stop never answer true to a start begun before it.
 *
 * These assert the whole chain rather than that a retry was scheduled: the
 * server is raced against a real socket holding the port, and recovery is
 * proved by a real request that comes back 200.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-api-port-'));
/**
 * A port nothing else holds, picked by the system once for this file. It was
 * 31961, fixed, and a suite run by another agent at the same moment took it
 * first: the squatter below then raced a stranger instead of the server. The
 * system never hands out 31415 or 31499, so a running Tars or sandbox still
 * cannot fail this.
 */
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: picked } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(picked));
    });
  });
}

beforeAll(async () => {
  port = await freePort();
});

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  // Read when the server listens, which is after beforeAll has picked it.
  return { ...actual, get API_PORT() { return port; }, API_TOKEN_FILE: path.join(tmp, 'api-token') };
});

let api: typeof import('../../../electron/services/api-server');
let squatter: http.Server | null = null;
const notifications: Array<{ title: string; body: string }> = [];

/** Hold the port the way a still-closing previous instance does. */
function occupyPort(): Promise<void> {
  return new Promise((resolve) => {
    squatter = http.createServer((_req, res) => res.end('busy'));
    squatter.listen(port, '127.0.0.1', resolve);
  });
}

function releasePort(): Promise<void> {
  return new Promise((resolve) => {
    if (!squatter) return resolve();
    squatter.close(() => { squatter = null; resolve(); });
  });
}

function start(): void {
  api.startApiServer(
    null,
    { notificationsEnabled: true } as never,
    () => null,
    () => null,
    null,
    null,
    () => {},
    (title: string, body: string) => { notifications.push({ title, body }); },
    async () => 'pty',
    () => ({ notificationsEnabled: true } as never),
  );
}

/** Resolve once the server reports one of these phases, or time out. */
function waitForPhase(phases: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const { phase } = api.getApiServerState();
      if (phases.includes(phase)) {
        api.apiServerEmitter.off('state', check);
        clearTimeout(timer);
        resolve(phase);
      }
    };
    const timer = setTimeout(() => {
      api.apiServerEmitter.off('state', check);
      reject(new Error(`never reached ${phases.join('/')}, stuck at ${api.getApiServerState().phase}`));
    }, timeoutMs);
    api.apiServerEmitter.on('state', check);
    check();
  });
}

function get(pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

beforeEach(async () => {
  vi.resetModules();
  notifications.length = 0;
  api = await import('../../../electron/services/api-server');
});

afterEach(async () => {
  api.stopApiServer();
  await releasePort();
});

describe('the local API when the port is busy', () => {
  it('starts clean and reports it', async () => {
    start();
    await waitForPhase(['listening'], 3000);

    const state = api.getApiServerState();
    expect(state.phase).toBe('listening');
    expect(state.port).toBe(port);
    expect(state.attempts).toBe(1);
    expect(state.lastError).toBeNull();
    expect(state.listeningSince).toBeTypeOf('number');
  });

  it('keeps retrying, then serves for real once the port frees up', async () => {
    await occupyPort();
    start();

    await waitForPhase(['retrying'], 3000);
    const retrying = api.getApiServerState();
    expect(retrying.phase).toBe('retrying');
    expect(retrying.lastError).toMatch(/EADDRINUSE/);
    expect(retrying.nextRetryInMs).toBeGreaterThan(0);
    expect(retrying.listeningSince).toBeNull();

    await releasePort();
    await waitForPhase(['listening'], 15000);

    const recovered = api.getApiServerState();
    expect(recovered.phase).toBe('listening');
    expect(recovered.attempts).toBeGreaterThan(1);
    expect(recovered.lastError).toBeNull();

    // The whole point: it is not merely in a good state, it is answering.
    const health = await get('/api/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
  }, 20000);

  it('bounds the retries instead of spinning forever', () => {
    const { maxAttempts } = api.getApiServerState();
    expect(maxAttempts).toBeGreaterThan(1);
    expect(maxAttempts).toBeLessThanOrEqual(12);
  });

  it('backs off between attempts rather than hammering the port', async () => {
    await occupyPort();
    start();

    const delays: number[] = [];
    api.apiServerEmitter.on('state', (s: { phase: string; nextRetryInMs: number | null }) => {
      if (s.phase === 'retrying' && s.nextRetryInMs) delays.push(s.nextRetryInMs);
    });

    await vi.waitUntil(() => delays.length >= 3, { timeout: 15000, interval: 100 });
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  }, 20000);

  it('drops a pending retry when it is stopped', async () => {
    await occupyPort();
    start();
    await waitForPhase(['retrying'], 3000);

    api.stopApiServer();
    const stopped = api.getApiServerState();
    expect(stopped.phase).toBe('stopped');
    expect(stopped.nextRetryInMs).toBeNull();
    expect(stopped.attempts).toBe(0);

    // A retry that fired after the stop would take the port back. Give the
    // longest scheduled delay a chance to prove it does not.
    await releasePort();
    await new Promise((r) => setTimeout(r, 1500));
    expect(api.getApiServerState().phase).toBe('stopped');
  }, 10000);
});

describe('the local API when it has given up', () => {
  /**
   * The full schedule spans about ninety seconds of wall clock, which no unit
   * test should sit through. Fake timers skip the waiting; the bind failures
   * themselves are still real EADDRINUSE errors from a real occupied port.
   */
  async function runToGiveUp(): Promise<void> {
    await occupyPort();
    // Only the backoff is faked. Date.now() and setImmediate stay real so the
    // loop can still yield to the event loop and let each bind actually fail.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      start();
      for (let i = 0; i < 40; i++) {
        if (api.getApiServerState().phase === 'failed') return;
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(60_000);
      }
      throw new Error(`never gave up, stuck at ${api.getApiServerState().phase}`);
    } finally {
      vi.useRealTimers();
    }
  }

  it('gives up loudly and leaves the failure consultable', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToGiveUp();

    const failed = api.getApiServerState();
    expect(failed.phase).toBe('failed');
    expect(failed.attempts).toBe(failed.maxAttempts);
    expect(failed.lastError).toMatch(/EADDRINUSE/);
    expect(failed.nextRetryInMs).toBeNull();
    expect(failed.listeningSince).toBeNull();
    // The state is still there to read, which is the whole difference from a
    // console line that scrolled away.
    expect(api.getApiServerState().phase).toBe('failed');

    const said = errors.mock.calls.flat().join(' ');
    expect(said).toMatch(new RegExp(String(port)));
    expect(said).toMatch(/hooks/i);
    errors.mockRestore();
  }, 20000);

  it('tells the user, because nothing on screen would', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToGiveUp();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toMatch(/port/i);
    expect(notifications[0].body).toMatch(new RegExp(String(port)));
    vi.restoreAllMocks();
  }, 20000);

  it('can still be started again once the port frees up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToGiveUp();
    expect(api.getApiServerState().phase).toBe('failed');

    await releasePort();
    start();
    await waitForPhase(['listening'], 5000);

    const recovered = api.getApiServerState();
    expect(recovered.phase).toBe('listening');
    // A fresh budget, or the next collision would give up on the first try.
    expect(recovered.attempts).toBeLessThan(recovered.maxAttempts);

    const health = await get('/api/health');
    expect(health.status).toBe(200);
    vi.restoreAllMocks();
  }, 25000);

  it('G1. no agent starts while Tars retries its port: apiListening waits, then answers true once it binds', async () => {
    await occupyPort();
    start();
    await waitForPhase(['retrying'], 5_000);
    let answered: boolean | undefined;
    void api.apiListening().then(v => { answered = v; });
    await new Promise(r => setTimeout(r, 300));
    expect(answered, 'answered while another process held the port').toBeUndefined();
    await releasePort();
    await waitForPhase(['listening'], 10_000);
    await vi.waitFor(() => expect(answered).toBe(true));
    expect(await api.apiListening()).toBe(true);
  }, 20_000);

  it('G2. once Tars gave its port up, apiListening answers false', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await occupyPort();
      start();
      const pending = api.apiListening();
      for (let i = 0; i < 10 && api.getApiServerState().phase !== 'failed'; i++) await vi.advanceTimersByTimeAsync(60_000);
      expect(api.getApiServerState().phase).toBe('failed');
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('G4. the app marks its API starting before its window and its IPC, so no start runs before Tars listens', async () => {
    const main = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');
    const ready = main.indexOf('app.whenReady().then(');
    const starting = main.indexOf("noteApiPhase('starting')", ready);
    expect(starting).toBeGreaterThan(ready);
    expect(starting).toBeLessThan(main.indexOf('createWindow();', ready));
    expect(starting).toBeLessThan(main.indexOf('registerIpcHandlers(deps)', ready));
    const { noteApiPhase } = await import('../../../electron/core/api-listening');
    noteApiPhase('starting');
    let answered: boolean | undefined;
    void api.apiListening().then(v => { answered = v; });
    await new Promise(r => setTimeout(r, 20));
    expect(answered).toBeUndefined();
    noteApiPhase('listening');
    await new Promise(r => setTimeout(r, 0));
    expect(answered).toBe(true);
  });

  it('G3. a process that never started an API is not held', async () => {
    expect(api.getApiServerState().phase).toBe('stopped');
    expect(await api.apiListening()).toBe(true);
  });
});

