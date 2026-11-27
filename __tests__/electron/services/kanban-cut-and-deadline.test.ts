import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { listTasks, type KanbanCaller, type KanbanHermes } from '../../../electron/services/kanban-board';
import { hermesRequest } from '../../../electron/services/hermes-client';

/**
 * The agents' kanban says, in words, why Hermes gave no answer when its answer
 * was cut off or ran past its deadline, and keeps them in the class of a
 * failure that may have come after Hermes did the work (the Audit's I-b on
 * #660).
 *
 * The kanban quotes the transport's own message: "Hermes did not answer: <it>."
 * hermesRequest's deadline rejected with the one word "deadline", so an agent
 * read "Hermes did not answer: deadline."
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. A deadline is quoted as "deadline", which says nothing of what happened.
 * 2. A cut answer, or a deadline, is put with the failures Hermes never
 *    received ("Nothing was written"), when it may have written the task and
 *    lost only its answer.
 * 3. Either loses the kanban's own words: what to do, and where.
 *
 * The board is read through hermesRequest itself, against loopback stand-ins
 * (a cut after 9 bytes; a trickle past a 1 s deadline), so the error is the
 * one the real kanban meets.
 */

const dune: KanbanCaller = { agentId: 'aaaa1111-0000-4000-8000-000000000001', name: 'Dune', projectPath: '/Users/you/tars' };
const closing: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });

async function gateway(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => answer(req, Object.assign(res, { timers })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { for (const t of timers) clearInterval(t); server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** A kanban whose board is read through hermesRequest at `base`, with a 1 s deadline. */
function boardAt(base: string): KanbanHermes {
  return { board: () => hermesRequest(base, '/api/plugins/kanban/board', { timeoutMs: 1_000, deadlineMs: 1_000 } as never) } as unknown as KanbanHermes;
}

const MAY_HAVE = /Hermes may have done it before its answer was lost/;

describe('the agents\' kanban, for an answer Hermes began and never ended (1, 2, 3)', () => {
  it('past its deadline: says so in words, and that Hermes may have done it', async () => {
    const base = await gateway((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      const timer = setInterval(() => { if (!res.destroyed) res.write(' '); }, 200);
      (res as unknown as { timers: Set<NodeJS.Timeout> }).timers.add(timer);
    });

    const r = await listTasks(boardAt(base), dune, {});

    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toMatch(/^Hermes did not answer: its answer did not end within 1 s\. /);
    expect(error).toMatch(MAY_HAVE);
    expect(error).not.toMatch(/Nothing was written/);
    expect(error).toMatch(/Settings, Hermes/);
  }, 10_000);

  it('cut off: says so in words, and that Hermes may have done it', async () => {
    const base = await gateway((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{"columns', () => setTimeout(() => req.socket.destroy(), 20));
    });

    const r = await listTasks(boardAt(base), dune, {});

    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toMatch(/^Hermes did not answer: its answer was cut off before the end\. /);
    expect(error).toMatch(MAY_HAVE);
    expect(error).not.toMatch(/Nothing was written/);
  }, 10_000);
});
