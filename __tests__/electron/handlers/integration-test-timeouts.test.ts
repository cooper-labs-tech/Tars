import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

/**
 * Settings' Test buttons for X and SocialData give up on a host that never
 * answers, and say so in words.
 *
 * xapi:test and socialdata:test set no timeout: a host that takes the
 * connection and never answers kept the call pending, the button spinning,
 * where every other test of Settings (Discord, Ollama, Tasmania, Hermes) gives
 * up and says why (#660, 27/11).
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. xapi:test never answers when the host takes the connection and says nothing.
 * 2. socialdata:test, the same.
 * 3. The refusal says nothing a person can act on: not which service, not how
 *    long Tars waited.
 * 4. A host that answers is no longer read: X's user name, SocialData's success.
 *
 * Nothing leaves the test: https.request is sent to a loopback stand-in, over
 * plain http, with everything the handler asked for but the address.
 */

const target = vi.hoisted(() => ({ port: 0, asked: [] as string[] }));
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('https')>();
  const plain = await import('node:http');
  const request = (options: Record<string, unknown>, cb?: (res: http.IncomingMessage) => void) => {
    target.asked.push(`${String(options.hostname)}${String(options.path)}`);
    return plain.request({ ...options, protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', port: target.port, agent: undefined }, cb);
  };
  return { ...actual, request, default: { ...actual, request } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.6', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AppSettings } from '../../../electron/types';

const SETTINGS = { xApiKey: 'k', xApiSecret: 's', xAccessToken: 't', xAccessTokenSecret: 'ts', socialDataApiKey: 'sd-key' } as AppSettings;
function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => SETTINGS };
  return new Proxy(fixed, {
    get(store, key: string) {
      if (key in store) return store[key];
      store[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return store[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  target.asked.length = 0;
});

/** A loopback host that takes every connection and never says a word. */
async function silentHost(): Promise<void> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  target.port = (server.address() as net.AddressInfo).port;
}

/** A loopback host that answers every request 200 with `body`. */
async function answeringHost(body: unknown): Promise<void> {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  target.port = (server.address() as net.AddressInfo).port;
}

/** The answer, or 'still waiting' once `ms` have passed without one. */
function within<T>(answer: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([answer, new Promise<'still waiting'>(resolve => setTimeout(() => resolve('still waiting'), ms))]);
}

describe('a host that takes the connection and never answers (1, 2, 3)', () => {
  it('xapi:test gives up after 10 s and says X did not answer', async () => {
    await silentHost();

    const answer = await within(handlers.get('xapi:test')!(null), 14_000);

    expect(target.asked).toEqual(['api.x.com/2/users/me']);
    expect(answer).toEqual({ success: false, error: 'X did not answer within 10 s.' });
  }, 20_000);

  it('socialdata:test gives up after 10 s and says SocialData did not answer', async () => {
    await silentHost();

    const answer = await within(handlers.get('socialdata:test')!(null), 14_000);

    expect(target.asked).toEqual(['api.socialdata.tools/twitter/user/elonmusk']);
    expect(answer).toEqual({ success: false, error: 'SocialData did not answer within 10 s.' });
  }, 20_000);
});

describe('a host that answers (4)', () => {
  it('xapi:test still reads the user name', async () => {
    await answeringHost({ data: { username: 'tars' } });

    await expect(handlers.get('xapi:test')!(null)).resolves.toEqual({ success: true, username: 'tars' });
  });

  it('socialdata:test still answers success', async () => {
    await answeringHost({ status: 'ok' });

    await expect(handlers.get('socialdata:test')!(null)).resolves.toEqual({ success: true });
  });
});
