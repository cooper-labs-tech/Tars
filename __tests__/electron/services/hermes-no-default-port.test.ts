import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * No reader of hermes-connection.json reaches the default port without a file
 * that names a gateway.
 *
 * readHermesConnection() fills whatever the file lacks, or all of it when the
 * file is missing or cannot be read, from the default: 127.0.0.1:9119, which on
 * JeanBrasse's machine is the SSH tunnel to his real Hermes. The agents' kanban stopped
 * doing that in #183; every other reader still did (the Audit's gate of #183): the
 * overseer, the memory hub and the agents' memory routes through
 * usableHermesConnection(), and the Kanban, Schedules and memory-provider pages
 * through the Hermes IPC handlers. A sandbox or a second Tars with no connection
 * file of its own reached JeanBrasse's Hermes through any of them.
 *
 * How this can fail, written before the fix:
 * 1. with no file, usableHermesConnection() answers the default port;
 * 2. with a broken file (unreadable, not JSON, no mode, no port), the same;
 * 3. the pages' IPC handlers call the gateway with the default for a missing or
 *    broken file;
 * 4. a file Settings wrote stops working, in any of its modes;
 * 5. the Settings form stops showing the default connection to save, or a
 *    handler added later reads the connection unchecked to call the gateway;
 * 6. hermes:connection:get hands the pages the default port's URL for a missing
 *    or broken file: Settings > Hermes and the Chat probe the base URL it gives
 *    them as soon as they open (hermes:connection:test), so opening either one
 *    reached the default port. Found on the merge with 1.9.0.
 */

const sent = vi.hoisted(() => [] as string[]);
/** Every request hermes-client makes, recorded and refused: nothing leaves this test, even on the code before its fix. */
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  const { EventEmitter } = await import('node:events');
  const request = (target: unknown) => {
    sent.push(String(target));
    const req = Object.assign(new EventEmitter(), {
      write() {}, destroy() {},
      end() { setImmediate(() => req.emit('error', new Error('connect ECONNREFUSED (no request leaves this test)'))); },
    });
    return req;
  };
  return { ...actual, request, default: { ...actual, request } };
});
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.8.1' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(Object.assign(new Error('not installed'), { code: 'ENOENT' })),
}));

const home = os.homedir(); // a throwaway HOME, per __tests__/setup/home-isolation.ts
const file = path.join(home, '.dorothy', 'hermes-connection.json');

let usableHermesConnection: () => unknown;
// The handlers bring the overseer with them: loaded once, with the time that takes.
beforeAll(async () => {
  ({ usableHermesConnection } = await import('../../../electron/services/hermes-config'));
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
}, 120_000);

beforeEach(() => {
  fs.rmSync(file, { force: true });
  sent.length = 0;
});

function writeConnection(content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const BROKEN: Array<[string, string]> = [
  ['not JSON', '{"mode": "local", "localPort": 9119'],
  ['an object with no mode', '{}'],
  ['local with no port', '{"mode":"local","authMode":"token"}'],
  ['ssh with no host', '{"mode":"ssh","ssh":{"user":"demo"}}'],
];

describe('usableHermesConnection, what the overseer and the memory hub use', () => {
  it('is none when there is no connection file', () => {
    expect(fs.existsSync(file)).toBe(false);
    expect(usableHermesConnection()).toBeNull();
  });

  it.each(BROKEN)('is none when the file is %s', (_what, content) => {
    writeConnection(content);
    expect(usableHermesConnection()).toBeNull();
  });

  it('is the file\'s gateway when Settings wrote one, in each mode', () => {
    writeConnection('{"mode":"local","localPort":9,"authMode":"token","token":"t"}');
    expect(usableHermesConnection()).toMatchObject({ mode: 'local', localPort: 9, token: 't' });
    writeConnection('{"mode":"ssh","ssh":{"host":"hermes.example","user":"demo"},"authMode":"token"}');
    expect(usableHermesConnection()).toMatchObject({ mode: 'ssh', ssh: { host: 'hermes.example' } });
    writeConnection('{"mode":"remote","url":"https://hermes.example","authMode":"oauth"}');
    expect(usableHermesConnection()).toMatchObject({ mode: 'remote', url: 'https://hermes.example' });
  });
});

/** Every handler of the Kanban, Schedules and memory-provider pages that calls the gateway, with what it is sent. */
const GATEWAY_CALLS: Array<[string, unknown[]]> = [
  ['hermes:crons:list', []],
  ['hermes:crons:action', [{ action: 'pause', jobId: 'j1' }]],
  ['hermes:crons:update', [{ jobId: 'j1', updates: { enabled: false } }]],
  ['hermes:crons:delete', [{ jobId: 'j1' }]],
  ['hermes:kanban:board', [{}]],
  ['hermes:kanban:createTask', [{ title: 'T' }]],
  ['hermes:kanban:updateTask', [{ taskId: 't1', patch: { status: 'done' } }]],
  ['hermes:kanban:getTask', [{ taskId: 't1' }]],
  ['hermes:kanban:deleteTask', [{ taskId: 't1' }]],
  ['hermes:kanban:addComment', [{ taskId: 't1', body: 'B' }]],
  ['hermes:mcp:servers', []],
  ['hermes:memory:providers', []],
  ['hermes:memory:setProvider', [{ provider: 'builtin' }]],
];

/** A handler's answer; a call the stub refused, as a dead port would, answers what it threw. */
async function call(channel: string, args: unknown[]): Promise<{ success?: boolean; error?: string }> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  try {
    return await handler({}, ...args) as { success?: boolean; error?: string };
  } catch (err) {
    return { success: false, error: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

describe('the Hermes pages\' handlers', () => {
  it.each(GATEWAY_CALLS)('%s calls no gateway when there is no connection file, and says so', async (channel, args) => {
    const r = await call(channel, args);
    expect(sent, `${channel} sent`).toEqual([]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not configured/);
  });

  it.each(GATEWAY_CALLS)('%s calls no gateway when the file is broken, and says what is wrong with it', async (channel, args) => {
    writeConnection('{"mode": "local", "localPort": 9119');
    const r = await call(channel, args);
    expect(sent, `${channel} sent`).toEqual([]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/hermes-connection\.json/);
  });

  it('calls the gateway the file names', async () => {
    writeConnection('{"mode":"local","localPort":9,"authMode":"token"}');
    await call('hermes:kanban:board', [{}]);
    await call('hermes:crons:list', []);
    expect(sent.map(u => new URL(u).origin)).toEqual(['http://127.0.0.1:9', 'http://127.0.0.1:9']);
  });

  type Shown = { connection: { mode: string; localPort?: number }; baseUrl: string };

  it('still shows the default connection in the Settings form, to be saved, and gives no base URL to probe', async () => {
    const r = await call('hermes:connection:get', []) as unknown as Shown;
    expect(r.connection).toMatchObject({ mode: 'local', localPort: 9119 });
    expect(r.baseUrl).toBe('');
    expect(sent).toEqual([]);
  });

  it.each(BROKEN)('gives no base URL to probe when the file is %s', async (_what, content) => {
    writeConnection(content);
    const r = await call('hermes:connection:get', []) as unknown as Shown;
    expect(r.baseUrl).toBe('');
    expect(sent).toEqual([]);
  });

  it('gives the base URL of the gateway the file names', async () => {
    writeConnection('{"mode":"local","localPort":9,"authMode":"token"}');
    const r = await call('hermes:connection:get', []) as unknown as Shown;
    expect(r.connection).toMatchObject({ mode: 'local', localPort: 9 });
    expect(r.baseUrl).toBe('http://127.0.0.1:9');
  });

  it('reads the saved connection unchecked only to show it, and to lend its token to a URL under test', () => {
    // A handler added later that called the gateway with it would reach the default port again.
    const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'handlers', 'hermes-handlers.ts'), 'utf-8');
    const channels = [...source.matchAll(/readConnection\(\)|readHermesConnection\(\)/g)].map(m => {
      const before = source.slice(0, m.index);
      const handle = [...before.matchAll(/ipcMain\.handle\('([^']+)'/g)].pop();
      return handle?.[1] ?? '(outside any handler)';
    });
    expect(channels.sort()).toEqual(['hermes:connection:get', 'hermes:testGateway']);
  });
});
