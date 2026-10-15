import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The agents' kanban writes to a Hermes someone configured, never to a guess.
 *
 * Without ~/.dorothy/hermes-connection.json, readHermesConnection() answers the
 * default, 127.0.0.1:9119, and on this machine that port is an SSH tunnel to a
 * real Hermes. A sandbox, a test home or a second Tars that has a
 * kanban-tasks.json and no connection file of its own would have moved its
 * tasks onto that board at launch, and its agents' tasks with them.
 *
 * How this can fail, written before the code:
 * 1. with no connection file, the kanban tools or the move of the local board reach the default port;
 * 2. with one, they do not reach it (the guard refuses a configured gateway);
 * 3. with one that cannot be read, is not JSON, or lacks the address its mode needs,
 *    readHermesConnection() fills in the default and the kanban reaches the default
 *    port all the same (the Backend's gate of #171, its fifth point);
 * 4. that file is refused without saying why, or the reason quotes the file, which
 *    holds the gateway's token.
 */

/**
 * Every request hermes-client makes goes through http.request: recorded here and
 * refused, so that no test, even one run against the code before its fix, reaches
 * 127.0.0.1:9119.
 */
const sent = vi.hoisted(() => [] as string[]);
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

const home = os.homedir(); // a throwaway HOME, per __tests__/setup/home-isolation.ts
const file = path.join(home, '.dorothy', 'hermes-connection.json');

let hermesKanban: () => unknown;
let listTasks: typeof import('../../../electron/services/kanban-board').listTasks;
// The routes bring half the main process with them: loaded once, with the time that takes.
beforeAll(async () => {
  ({ hermesKanban } = await import('../../../electron/services/api-routes/kanban-routes'));
  ({ listTasks } = await import('../../../electron/services/kanban-board'));
}, 120_000);

beforeEach(() => {
  fs.rmSync(file, { force: true });
  sent.length = 0;
});

function writeConnection(content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A board the kanban can write to: it has the methods, and says nothing of a problem. */
const isBoard = (h: unknown) => !!h && typeof (h as { board?: unknown }).board === 'function';
const reasonOf = (h: unknown) => (h && typeof h === 'object' ? (h as { unusable?: string }).unusable : undefined);

describe('the Hermes the kanban writes to', () => {
  it('is none when nobody configured one', () => {
    expect(fs.existsSync(file)).toBe(false);
    expect(hermesKanban()).toBeNull();
  });

  it('is the configured one when there is a connection file', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    expect(hermesKanban()).not.toBeNull();
  });
});

describe('a connection file the kanban cannot use', () => {
  const unusable: Array<[string, string]> = [
    ['not JSON', '{"mode": "local", "localPort": 9119'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"local"'],
    ['no mode', '{}'],
    ['a port and no mode', '{"localPort":9119,"token":"t"}'],
    ['a mode Tars does not know', '{"mode":"telepathy","localPort":9}'],
    ['local with no port', '{"mode":"local","authMode":"token"}'],
    ['local with a port that is not one', '{"mode":"local","localPort":"9"}'],
    ['local with port 0', '{"mode":"local","localPort":0}'],
    ['ssh with no host', '{"mode":"ssh","ssh":{"user":"demo"}}'],
    ['remote with no URL', '{"mode":"remote"}'],
  ];

  it.each(unusable)('is no board when the file is %s, and says why', (_what, content) => {
    writeConnection(content);
    const h = hermesKanban();
    expect(isBoard(h)).toBe(false);
    expect(reasonOf(h)).toMatch(/hermes-connection\.json/);
  });

  it('is no board when the file cannot be read', () => {
    writeConnection('{"mode":"local","localPort":9}');
    fs.chmodSync(file, 0o000);
    try {
      // Root reads through a 000 mode, and some CI runners are root: then it is readable, and valid.
      let readable = true;
      try { fs.readFileSync(file); } catch { readable = false; }
      const h = hermesKanban();
      if (readable) expect(isBoard(h)).toBe(true);
      else {
        expect(isBoard(h)).toBe(false);
        expect(reasonOf(h)).toMatch(/hermes-connection\.json/);
      }
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it('never quotes the file, which holds the gateway token', () => {
    writeConnection('{"mode":"local","localPort":9119,"token":"hunter2-gateway-token"');
    const reason = reasonOf(hermesKanban()) ?? '';
    expect(reason).toMatch(/hermes-connection\.json/);
    expect(reason).not.toContain('hunter2');
  });

  it('answers a kanban tool with the reason, and sends no request anywhere', async () => {
    writeConnection('{"mode": "local", "localPort": 9119');
    const r = await listTasks(hermesKanban() as never, { agentId: 'aaaa1111-0000-4000-8000-000000000001', name: 'Dune', projectPath: '/Users/you/tars' }, {});
    expect(sent, 'requests the kanban sent').toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.ok ? 0 : r.status).toBe(503);
    expect(r.ok ? '' : r.error).toMatch(/hermes-connection\.json/);
  });

  it('still uses a file Settings wrote, in each mode', () => {
    for (const content of [
      '{"mode":"local","localPort":9119,"authMode":"token","token":"t"}',
      '{"mode":"ssh","ssh":{"host":"hermes.example","user":"demo"},"authMode":"token"}',
      '{"mode":"remote","url":"https://hermes.example","authMode":"oauth"}',
    ]) {
      writeConnection(content);
      expect(isBoard(hermesKanban()), content).toBe(true);
    }
    expect(sent).toEqual([]);
  });
});
