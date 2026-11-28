import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

/**
 * A message the overseer sends an agent (overseer:confirmAction, sendToAgent)
 * settles when Tars's own API cuts its answer off once it has begun.
 *
 * sendToAgent posts to the local API's /dispatch (postLocalDispatch,
 * services/overseer-gate.ts), which listened to the answer's data and end
 * only: a connection cut after the status and headers never settled, and its
 * timeout cannot fire on a socket that is gone (the Audit's M1 on #660, the
 * same gap as hermesRequest's).
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. The confirmation never answers: the Chat's Send stays pending.
 * 2. It answers, but in words that say nothing of what happened.
 * 3. An answer that ends is no longer read (the mode the route answers).
 */

const api = vi.hoisted(() => ({ port: 0 }));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, get API_PORT() { return api.port; } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { agents } from '../../../electron/core/agent-manager';
import { sendToAgent } from '../../../electron/services/overseer-gate';
import type { AgentStatus } from '../../../electron/types';

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  agents.clear();
});

/** Tars's own API, a stand-in on loopback: each POST answered by `answer`. */
async function localApi(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<void> {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => answer(req, res)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  api.port = (server.address() as net.AddressInfo).port;
}

function anAgent(): string {
  agents.set('a1', { id: 'a1', name: 'Ula', projectPath: '/tmp/project', status: 'idle', output: [] } as unknown as AgentStatus);
  return 'a1';
}

/** The answer, or 'still waiting' once `ms` have passed without one. */
function within<T>(answer: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([answer, new Promise<'still waiting'>(resolve => setTimeout(() => resolve('still waiting'), ms))]);
}

describe('the local API cuts its answer off once it has begun (1, 2)', () => {
  it('sendToAgent answers, saying the answer was cut off', async () => {
    await localApi((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"mode":"', () => setTimeout(() => req.socket.destroy(), 20));
    });

    const answer = await within(sendToAgent(anAgent(), 'ship the thing'), 5_000);

    expect(answer).toEqual({ success: false, error: 'Tars\'s own API cut its answer off before the end.' });
  }, 10_000);
});

describe('the local API answers to its end (3)', () => {
  it('sendToAgent reads the mode', async () => {
    await localApi((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'messaged' })); });

    await expect(sendToAgent(anAgent(), 'ship the thing')).resolves.toMatchObject({ success: true, mode: 'messaged' });
  });
});
