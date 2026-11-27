import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What a Hermes channel answers the window holds no home path, no token and no
 * URL with credentials (the Audit's I-2 on #658, 27/11).
 *
 * A connection file Tars could not use answered its absolute path: the
 * Schedules page put `/Users/<account>/.tars-private/hermes-connection.json`
 * on screen, the account's name with it. The other handlers of Settings, Hermes
 * answer the write errors of their files as Node words them, with the path.
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. A connection file Tars cannot use (not JSON, not an object, no mode, a
 *    mode Tars does not know, no port, no SSH host, no URL) puts its absolute
 *    path, under the owner's home, in every gateway channel's refusal.
 * 2. The refusal that replaces it loses what it said: which file (its name,
 *    hermes-connection.json) and why, and what to do (save it again).
 * 3. A connection Settings cannot save answers the write error with the home
 *    in it; one imported from Hermes Desktop that cannot be saved throws it
 *    through IPC.
 * 4. A gateway change that cannot be written (add, rotate a secret, set its
 *    projects, remove) answers, or throws, the same home path.
 * 5. Node's own words for a gateway that gives no answer, which the probes of
 *    Settings, Hermes answer as they are (hermes:connection:test,
 *    hermes:testGateway), carry the URL's user name, password or query, or the
 *    dashboard token. The Audit measured they do not, for a URL with
 *    user:password@ and ?token=: this keeps that measured.
 * 6. A connection file written before 1.9.2, still holding its token, whose
 *    one-time move into hermes-token cannot be written: configuredHermesConnection
 *    threw Node's file error through every gateway, overseer and memory channel,
 *    Electron's words and the home's path with it. It is a refusal in words,
 *    the home said ~, and never the token. Added after the fix of 1 to 5.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.6' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));
vi.mock('../../../electron/services/secret-handoff', () => ({ copySecret: () => true, showSecretOnce: async () => {} }));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(Object.assign(new Error('not installed'), { code: 'ENOENT' })),
}));

type Answer = { success?: boolean; error?: string };
const home = os.homedir(); // a throwaway HOME, per __tests__/setup/home-isolation.ts
const privateDir = path.join(home, '.tars-private');
const connectionFile = path.join(privateDir, 'hermes-connection.json');
const tokenFile = path.join(privateDir, 'hermes-token');
const gatewaysFile = path.join(privateDir, 'hermes-gateways.json');
const webhookSecretFile = path.join(privateDir, 'hermes-webhook-secret');

beforeAll(async () => {
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
}, 120_000);

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(null, ...args) as Promise<Answer>;

const made: string[] = [];
afterEach(() => { for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

/** A directory where a file Tars writes should be: its write fails, and Node's error quotes the path. */
function blockWith(file: string): void {
  fs.mkdirSync(path.join(file, 'held'), { recursive: true });
  made.push(file);
}

function writeConnectionFile(content: string): void {
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(connectionFile, content);
  made.push(connectionFile);
}

describe('a connection file Tars cannot use (1, 2)', () => {
  const UNUSABLE: Array<[string, string, string]> = [
    ['not JSON', '{"mode": "local", "localPort": 9119', 'cannot be read (not valid JSON)'],
    ['an array', '[]', 'names no mode Tars knows'],
    ['null', 'null', 'holds no connection'],
    ['no mode', '{}', 'names no mode Tars knows'],
    ['a mode Tars does not know', '{"mode":"telepathy","localPort":9}', 'names no mode Tars knows'],
    ['local with no port', '{"mode":"local","authMode":"token"}', 'names no port for the local gateway'],
    ['ssh with no host', '{"mode":"ssh","ssh":{"user":"demo"}}', 'names no SSH host'],
    ['remote with no URL', '{"mode":"remote"}', 'names no gateway URL'],
  ];

  it.each(UNUSABLE)('when it is %s, Schedules is told which file and why, never where it lives', async (_what, content, why) => {
    writeConnectionFile(content);

    const answer = await call('hermes:crons:list');

    expect(answer).toEqual({ success: false, error: `The Hermes connection file (hermes-connection.json) ${why}: save the connection again in Settings, Hermes.` });
    expect(answer.error).not.toContain(home);
  });
});

describe('a connection file holding its token, which cannot be moved out of it (6)', () => {
  const OLD = JSON.stringify({ mode: 'remote', url: 'http://127.0.0.1:9', authMode: 'token', token: 'old-token-secret' });

  it('Schedules is told why in words, the home said ~, never the token', async () => {
    writeConnectionFile(OLD);
    blockWith(tokenFile);

    const answer = await call('hermes:crons:list');

    expect(answer.success).toBe(false);
    expect(answer.error).toMatch(/^The Hermes connection file \(hermes-connection\.json\) holds a token Tars could not move out of it \(.*hermes-token.*\): save the connection again in Settings, Hermes\.$/);
    expect(answer.error).not.toContain(home);
    expect(answer.error).not.toContain('old-token-secret');
  });

  it('the overseer and memory channels refuse too, never a throw', async () => {
    writeConnectionFile(OLD);
    blockWith(tokenFile);
    const { usableHermesConnection } = await import('../../../electron/services/hermes-config');

    expect(usableHermesConnection()).toBeNull(); // memory:sources and memory:search read it so
    await expect(call('hermes:connection:get')).resolves.toBeTruthy();
    await expect(call('hermes:mcp:servers')).resolves.toMatchObject({ success: false });
  });
});

describe('a connection Settings cannot save (3)', () => {
  it('Save answers why, with the home said ~', async () => {
    blockWith(tokenFile);

    const answer = await call('hermes:connection:save', { mode: 'remote', url: 'http://127.0.0.1:9', authMode: 'token', token: 'typed-token' });

    expect(answer.success).toBe(false);
    expect(answer.error).toContain('hermes-token');
    expect(answer.error).not.toContain(home);
    expect(answer.error).not.toContain('typed-token');
  });

  it('Import from Hermes Desktop answers why, never a throw, with the home said ~', async () => {
    const { hermesDesktopConfigPath } = await import('../../../electron/platform');
    const desktop = hermesDesktopConfigPath({ home });
    expect(desktop.startsWith(home)).toBe(true); // never the account's own Hermes Desktop
    fs.mkdirSync(path.dirname(desktop), { recursive: true });
    fs.writeFileSync(desktop, JSON.stringify({ mode: 'local', local: { port: 9119 } }));
    made.push(desktop);
    blockWith(tokenFile);

    const answer = await call('hermes:connection:import');

    expect(answer.success).toBe(false);
    expect(answer.error).toContain('hermes-token');
    expect(answer.error).not.toContain(home);
  });
});

describe('a gateway change that cannot be written (4)', () => {
  it('adding one answers why, with the home said ~', async () => {
    blockWith(gatewaysFile);

    const answer = await call('hermes:gateways:add', { label: 'Second' });

    expect(answer.success).toBe(false);
    expect(answer.error).toContain('hermes-gateways.json');
    expect(answer.error).not.toContain(home);
  });

  it('a new secret for the default one answers why, with the home said ~', async () => {
    blockWith(webhookSecretFile);

    const answer = await call('hermes:gateways:rotate', { id: 'default' });

    expect(answer.success).toBe(false);
    expect(answer.error).toContain('hermes-webhook-secret');
    expect(answer.error).not.toContain(home);
  });

  it('setting its projects answers why, with the home said ~', async () => {
    blockWith(gatewaysFile);

    const answer = await call('hermes:gateways:setProjects', { id: 'default', projects: [path.join(home, 'project')] });

    expect(answer.success).toBe(false);
    expect(answer.error).toContain('hermes-gateways.json');
    expect(answer.error).not.toContain(home);
  });

  it('removing one answers why, never a throw, with the home said ~', async () => {
    made.push(gatewaysFile);
    const added = await call('hermes:gateways:add', { label: 'Second' }) as Answer & { gateway?: { id: string } };
    expect(added.success, added.error).toBe(true);
    const id = added.gateway!.id;
    const secret = path.join(privateDir, `hermes-webhook-${id}.secret`);
    fs.rmSync(secret, { force: true });
    blockWith(secret);

    const answer = await call('hermes:gateways:remove', { id });

    expect(answer.success).toBe(false);
    expect(answer.error).toContain(`hermes-webhook-${id}.secret`);
    expect(answer.error).not.toContain(home);
  });
});

/** A loopback port nothing listens on. */
async function refusingPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });

/** A loopback server that does `onSocket` with each connection, closed with them after the test. */
async function standIn(onSocket: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}

describe('Node\'s own words for a gateway that gives no answer (5, the Audit\'s measure kept)', () => {
  const SECRETS = ['jean', 'pw-secret', 'q-secret', 'tok-secret-123'];
  const GATEWAYS: Array<[string, () => Promise<number>]> = [
    ['nothing listens', refusingPort],
    ['an SSH server answers', () => standIn(socket => socket.end('SSH-2.0-OpenSSH_9.6\r\n'))],
    ['it hangs up', () => standIn(socket => socket.destroy())],
  ];

  for (const [what, gateway] of GATEWAYS) {
    it(`when ${what}, the probes of Settings, Hermes say no user name, password, query or token`, async () => {
      const port = await gateway();
      const url = `http://jean:pw-secret@127.0.0.1:${port}/?token=q-secret`;

      const tested = await call('hermes:connection:test', { mode: 'remote', url, authMode: 'token', token: 'tok-secret-123' });
      const gatewayTested = await call('hermes:testGateway', url);

      for (const answer of [tested, gatewayTested]) {
        expect(answer.success).toBe(false);
        expect(answer.error).toMatch(/\S/);
        for (const secret of SECRETS) expect(answer.error).not.toContain(secret);
        expect(answer.error).not.toContain(home);
      }
    });
  }
});
