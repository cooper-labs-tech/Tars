import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hermesDesktopConfigPath } from '../../../electron/platform';
import { moveTestHome } from '../../setup/test-home';

// Windows: Hermes Desktop's folder is under %APPDATA%, moved into the suite's
// home with the rest of the profile (test-home.ts), or the import would read
// the machine's own Hermes Desktop.
const restoreProfile = process.platform === 'win32' ? moveTestHome(os.homedir()) : () => {};
afterAll(() => restoreProfile());

/**
 * The Chat goes back to the live conversation once the Hermes connection
 * changes.
 *
 * The overseer answers over the gateway's live session, in about nine seconds,
 * and falls back to a cron job, about thirty, when the gateway will not open
 * one. It remembers the refusal so an install with no live transport does not
 * pay for the attempt on every turn, and its own comment says the memory is
 * cleared whenever the connection settings change. Nothing ever cleared it:
 * resetLiveSession had no caller since the live session arrived (ade3eee), so
 * one refusal, an expired sign-in say, put every later turn on the slow path
 * until Tars restarted. And signing out left a socket opened under the old
 * session in use. Found in D2.
 *
 * How this can fail, written before the fix:
 * 1. saving a connection leaves the Chat on the slow path;
 * 2. signing in again leaves it there;
 * 3. importing Hermes Desktop's connection leaves it there;
 * 4. signing out leaves the socket opened before it in use, open;
 * 5. the attempt is made again on every turn, which an install with no live transport pays each time.
 *
 * The overseer and the Hermes handlers are the real ones; the live transport
 * and the gateway calls are fakes that count what is asked of them.
 */

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
}));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ branch: 'main', status: [] }) }));

const live = vi.hoisted(() => ({
  refuse: true,
  attempts: 0,
  closed: 0,
}));
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => true,
  createLiveSession: async () => {
    live.attempts++;
    if (live.refuse) throw new Error('the gateway refused the socket');
    return { session: { id: `s${live.attempts}` }, control: { close: () => { live.closed++; } } };
  },
  askLiveSession: async () => ({ ok: true, envelope: '{"say":"Answered live.","action":null}' }),
}));
vi.mock('../../../electron/services/hermes-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/services/hermes-client')>()),
  probeHermes: async () => ({ baseUrl: 'http://127.0.0.1:1', reachable: true, authRequired: false, authFlows: [], authProviders: [], signedIn: true }),
  signInHermes: async () => ({ success: true }),
  clearHermesSession: () => {},
  // The slow path ends at once here: only whether the live one was tried matters.
  createHermesCron: async () => ({ success: false as const, error: 'no cron in this test', needsSignIn: false }),
}));

const CONNECTION = { mode: 'remote' as const, url: 'http://127.0.0.1:1', authMode: 'token' as const };
let overseer: typeof import('../../../electron/services/overseer');
const ask = () => overseer.askOverseer('What is everyone doing?');
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

beforeAll(async () => {
  overseer = await import('../../../electron/services/overseer');
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  // A gateway is configured. With no connection file the Chat says Hermes is not
  // configured and asks nothing; it used to take the default port, 127.0.0.1:9119.
  (await import('../../../electron/services/hermes-config')).writeHermesConnection(CONNECTION);
  // Hermes Desktop's own file, which the import reads, where this platform keeps it.
  const desktop = hermesDesktopConfigPath({ home: os.homedir() });
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, JSON.stringify({ mode: 'remote', remote: { url: 'http://127.0.0.1:1' } }));
});

beforeEach(() => {
  // A session the last test left open is closed here, before the count starts.
  overseer.resetLiveSession();
  live.refuse = true;
  live.attempts = 0;
  live.closed = 0;
});

describe('after the live session was refused', () => {
  it('tries it once, then not on every turn', async () => {
    await ask();
    await ask();
    await ask();
    expect(live.attempts).toBe(1);
  });

  for (const [change, run] of [
    ['a connection is saved', () => call('hermes:connection:save', CONNECTION)],
    ['JeanBrasse signs in again', () => call('hermes:signIn', { connection: CONNECTION, username: 'demo', password: 'pw' })],
    ['Hermes Desktop\'s connection is imported', () => call('hermes:connection:import')],
  ] as const) {
    it(`tries it again once ${change}`, async () => {
      await ask();
      await ask();
      expect(live.attempts).toBe(1);

      expect(await run()).toMatchObject({ success: true });
      await ask();
      expect(live.attempts).toBe(2);
    });
  }
});

describe('a live session opened before a sign-out', () => {
  it('is closed by the sign-out, and the next turn opens a new one', async () => {
    live.refuse = false;
    expect(await ask()).toMatchObject({ ok: true });
    expect(await ask()).toMatchObject({ ok: true });
    expect(live.attempts).toBe(1);

    await call('hermes:signOut', CONNECTION);
    expect(live.closed).toBe(1);

    expect(await ask()).toMatchObject({ ok: true });
    expect(live.attempts).toBe(2);
  });
});
