import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';

/**
 * A gateway that answers 200 with something that is not JSON (a proxy's sign-in
 * page, a web server on the gateway's port) is a refusal in words, never a
 * success with no rows (#660, 27/11).
 *
 * hermesRequest keeps a body JSON cannot read as its raw text, and the readers
 * of the pages took that text for an answer: Schedules showed no schedule,
 * the board no task, Brain no MCP server and no memory provider, the Chat's
 * model picker no model, all as successes.
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. hermes:crons:list answers success, with the page's text as its jobs.
 * 2. The board, a task, the gateway's MCP servers, its memory providers and
 *    the overseer's models answer success the same way, with nothing in them.
 * 3. The refusal says nothing a person can act on: not what Tars was reading.
 * 4. A gateway that answers JSON, as Hermes does, stops being read.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.6' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(Object.assign(new Error('not installed'), { code: 'ENOENT' })),
}));

type Answer = { success?: boolean; error?: string; jobs?: unknown };
let writeHermesConnection: (conn: object) => void;

beforeAll(async () => {
  ({ writeHermesConnection } = await import('../../../electron/services/hermes-config') as never);
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  (await import('../../../electron/handlers/overseer-handlers')).registerOverseerHandlers();
}, 120_000);

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args) as Promise<Answer>;

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });

/** The saved gateway: a loopback server answering every request 200 with `type` and `body`. */
async function gatewayAnswering(type: string, body: string): Promise<void> {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', type); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  writeHermesConnection({ mode: 'remote', url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, authMode: 'token', token: 't' });
}

const READERS: Array<[string, string, ...unknown[]]> = [
  ['the schedules', 'hermes:crons:list'],
  ['the board', 'hermes:kanban:board'],
  ['the task', 'hermes:kanban:getTask', { taskId: 't1' }],
  ['the MCP servers', 'hermes:mcp:servers'],
  ['the memory providers', 'hermes:memory:providers'],
  ['the models', 'overseer:modelOptions'],
];

describe('a 200 whose body is not JSON (1, 2, 3)', () => {
  for (const [what, channel, ...args] of READERS) {
    it(`${channel} refuses, naming what Tars was reading`, async () => {
      await gatewayAnswering('text/html', '<!doctype html><title>Sign in</title>');

      await expect(call(channel, ...args)).resolves.toEqual({
        success: false,
        error: `Tars could not read ${what} Hermes sent: its answer is not what Tars expected.`,
      });
    });
  }
});

describe('a 200 whose body is JSON, as Hermes answers (4)', () => {
  it('hermes:crons:list reads the jobs', async () => {
    await gatewayAnswering('application/json', JSON.stringify({ jobs: [{ id: 'j1', name: 'Overseer' }] }));

    await expect(call('hermes:crons:list')).resolves.toEqual({ success: true, jobs: { jobs: [{ id: 'j1', name: 'Overseer' }] } });
  });

  it('hermes:mcp:servers reads an empty list as one', async () => {
    await gatewayAnswering('application/json', JSON.stringify({ servers: [] }));

    await expect(call('hermes:mcp:servers')).resolves.toEqual({ success: true, servers: [] });
  });
});
