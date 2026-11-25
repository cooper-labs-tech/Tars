import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { moveTestHome } from '../../setup/test-home';

/**
 * Import, in Settings > Hermes, copies the connection Hermes Desktop uses.
 *
 * It read connection.json only. That is Hermes Desktop's v1 file: current
 * builds keep a v2 registry beside it, connections.json, import v1 into it
 * once, and from then on the registry is the one they write. Its `primary`
 * names the connection in use, and a token is stored with it as
 * `{ encoding, value }`: `plain` by default, `safeStorage` when the user turns
 * on keychain encryption (secure-token-storage.json holds that choice, not a
 * token). So a gateway or a token set up after the migration was not in the
 * file Tars read, and the import brought the URL and no token.
 *
 * How this can fail, written before the fix:
 * 1. the primary's plain token, in connections.json only, is not imported;
 * 2. the connection imported is not the one `primary` names;
 * 3. a token Hermes Desktop encrypted with its own safeStorage key is imported
 *    as if it were the token, and its ciphertext sent to the gateway;
 * 4. the registry's entry is mapped wrong: the URL, the auth mode, the org of
 *    a cloud gateway, the host of an SSH one;
 * 5. an older Hermes Desktop, with connection.json alone, no longer imports;
 * 6. the import is not offered when connections.json is the only file there;
 * 7. a connections.json that cannot be parsed stops connection.json importing,
 *    or its text, tokens and all, reaches the log;
 * 8. a registry whose primary is the local runtime imports a remote gateway
 *    connection.json still names, v1 being left behind once the registry exists;
 * 9. a connection.json that cannot be parsed has its text, a plain token
 *    included, written to the log;
 * 10. an import that leaves an encrypted token behind does not say so
 *    (`tokenNotImported`), or says so of a token it brought, or of none, or of
 *    an SSH primary's: Tars imports no SSH token, plain or encrypted, and the
 *    page has no token field in SSH mode for the user to paste one.
 *
 * The handler is the real one, over a Hermes Desktop folder in the test's home.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { isPackaged: true },
}));

// A home of this file's own, inside the suite's throwaway one: the handler
// finds Hermes Desktop's folder, and Tars its own, from os.homedir().
const home = path.join(process.env.HOME!, 'hermes-desktop-import');
vi.mock('os', async importOriginal => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => home,
}));

// Where the handler looks on this platform (electron/platform): %APPDATA%\Hermes on
// Windows, moved into this file's home with the rest of the profile there
// (test-home.ts), or the import would read the machine's own Hermes Desktop.
// Imported once `home` exists.
const restoreProfile = process.platform === 'win32' ? moveTestHome(home) : () => {};
const { hermesDesktopConfigPath } = await import('../../../electron/platform');
const desktopDir = path.dirname(hermesDesktopConfigPath({ home }));
const V1 = path.join(desktopDir, 'connection.json');
const V2 = path.join(desktopDir, 'connections.json');

const LOCAL = { id: 'local', kind: 'local', label: 'This Mac' };

function registry(primary: string, ...connections: object[]) {
  return { version: 2, primary, launchMode: 'primary', lastUsed: primary, connections: [LOCAL, ...connections] };
}

function write(file: string, body: unknown) {
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

// Registered once: the handler reads Hermes Desktop's files when it is called,
// and a cold import of its module graph can take longer than one test's 5 s.
beforeAll(async () => {
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
}, 60_000);

/**
 * The import as it lands: the page is answered the token as the mask, never
 * itself (the Audit's L2 on #466), and the token imported is the one saved.
 */
async function importDesktop() {
  const r = await handlers.get('hermes:connection:import')!({}) as { success: boolean; connection?: Record<string, unknown>; error?: string; tokenNotImported?: boolean };
  if (!r.connection || r.connection.token === undefined) return r;
  const { SECRET_MASK } = await import('../../../electron/services/settings-secrets');
  const { readHermesConnection } = await import('../../../electron/services/hermes-config');
  expect(r.connection.token, 'the token answered to the page').toBe(SECRET_MASK);
  return { ...r, connection: { ...r.connection, token: readHermesConnection().token } };
}

beforeEach(() => { fs.rmSync(desktopDir, { recursive: true, force: true }); });
afterAll(() => {
  restoreProfile();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('importing Hermes Desktop\'s connection', () => {
  it('brings the primary\'s token when only connections.json holds it (1, 2)', async () => {
    // v1 as the migration left it: the URL, no token.
    write(V1, { mode: 'remote', remote: { url: 'http://old.example:9119', authMode: 'token' } });
    write(V2, registry('box',
      { id: 'other', kind: 'remote', label: 'Other', url: 'http://other.example:9119', authMode: 'token', token: { encoding: 'plain', value: 'not-this-one' } },
      { id: 'box', kind: 'remote', label: 'Box', url: 'http://box.example:9119', authMode: 'token', token: { encoding: 'plain', value: 'tok-box' } },
    ));

    const r = await importDesktop();

    expect(r.success).toBe(true);
    expect(r.connection).toEqual({ mode: 'remote', url: 'http://box.example:9119', authMode: 'token', token: 'tok-box' });
  });

  it('leaves a token Hermes Desktop encrypted out of the import (3)', async () => {
    write(V2, registry('box',
      { id: 'box', kind: 'remote', label: 'Box', url: 'http://box.example:9119', authMode: 'token', token: { encoding: 'safeStorage', value: 'djEwY2lwaGVydGV4dA==' } },
    ));

    const r = await importDesktop();

    expect(r.success).toBe(true);
    expect(r.connection).toEqual({ mode: 'remote', url: 'http://box.example:9119', authMode: 'token' });
  });

  it('maps a cloud gateway and an SSH host as Hermes Desktop stores them (4)', async () => {
    write(V2, registry('cloud',
      { id: 'cloud', kind: 'cloud', label: 'Cloud', url: 'https://gw.hermes.example', authMode: 'oauth', org: 'acme', token: { encoding: 'plain', value: 'tok-cloud' } },
    ));
    expect((await importDesktop()).connection).toEqual({ mode: 'cloud', url: 'https://gw.hermes.example', authMode: 'oauth', org: 'acme', token: 'tok-cloud' });

    write(V2, registry('vps',
      { id: 'vps', kind: 'ssh', label: 'vps', host: 'vps.example', user: 'root', port: 2222, keyPath: '~/.ssh/id_ed25519' },
    ));
    expect((await importDesktop()).connection).toEqual({
      mode: 'ssh', authMode: 'token',
      ssh: { host: 'vps.example', user: 'root', port: 2222, keyPath: '~/.ssh/id_ed25519', remotePort: 9119 },
    });
  });

  it('still imports connection.json when there is no registry (5)', async () => {
    write(V1, { mode: 'remote', remote: { url: 'http://box.example:9119', authMode: 'token', token: { encoding: 'plain', value: 'tok-v1' } } });

    const r = await importDesktop();

    expect(r.connection).toEqual({ mode: 'remote', url: 'http://box.example:9119', authMode: 'token', token: 'tok-v1' });
  });

  it('is offered when connections.json is the only file there (6)', async () => {
    write(V2, registry('box', { id: 'box', kind: 'remote', label: 'Box', url: 'http://box.example:9119', authMode: 'token' }));

    const r = await handlers.get('hermes:connection:get')!({}) as { desktopConfigAvailable: boolean };

    expect(r.desktopConfigAvailable).toBe(true);
  });

  it('falls back to connection.json when connections.json cannot be parsed, and does not log it (7)', async () => {
    write(V1, { mode: 'remote', remote: { url: 'http://box.example:9119', authMode: 'token', token: { encoding: 'plain', value: 'tok-v1' } } });
    // Node's parse error quotes the text it choked on.
    fs.writeFileSync(V2, '{"value":leaked}');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await importDesktop();
    const log = logged.mock.calls.flat().map(String).join('\n');
    logged.mockRestore();

    expect(r.connection).toEqual({ mode: 'remote', url: 'http://box.example:9119', authMode: 'token', token: 'tok-v1' });
    expect(log).not.toContain('leaked');
  });

  it('imports Local when the registry\'s primary is the local runtime, whatever connection.json says (8)', async () => {
    write(V1, { mode: 'remote', remote: { url: 'http://stale.example:9119', authMode: 'token', token: { encoding: 'plain', value: 'tok-stale' } } });
    write(V2, registry('local', { id: 'box', kind: 'remote', label: 'Box', url: 'http://box.example:9119', authMode: 'token' }));
    expect((await importDesktop()).connection).toEqual({ mode: 'local', authMode: 'token', localPort: 9119 });

    // The port connection.json gives the local runtime, when it gives one.
    write(V1, { mode: 'remote', local: { port: 9200 }, remote: { url: 'http://stale.example:9119', authMode: 'token' } });
    expect((await importDesktop()).connection).toEqual({ mode: 'local', authMode: 'token', localPort: 9200 });
  });

  it('does not log the text of a connection.json that cannot be parsed (9)', async () => {
    // Node's parse error quotes the text it choked on.
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(V1, '{"value":plaintok}');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await importDesktop();
    const log = logged.mock.calls.flat().map(String).join('\n');
    logged.mockRestore();

    expect(r.success).toBe(false);
    expect(log).not.toContain('plaintok');
  });

  it('says when it left an encrypted token behind, and only then (10)', async () => {
    const box = (token?: object) => registry('box', { id: 'box', kind: 'remote', label: 'Box', url: 'http://box.example:9119', authMode: 'token', ...(token ? { token } : {}) });

    write(V2, box({ encoding: 'safeStorage', value: 'djEwY2lwaGVydGV4dA==' }));
    expect((await importDesktop()).tokenNotImported).toBe(true);

    write(V2, box({ encoding: 'plain', value: 'tok-box' }));
    expect((await importDesktop()).tokenNotImported).toBeFalsy();

    write(V2, box());
    expect((await importDesktop()).tokenNotImported).toBeFalsy();

    write(V2, registry('vps', { id: 'vps', kind: 'ssh', label: 'vps', host: 'vps.example', user: 'root', token: { encoding: 'safeStorage', value: 'djEwY2lwaGVydGV4dA==' } }));
    expect((await importDesktop()).tokenNotImported).toBe(false);

    // connection.json alone, as an older Hermes Desktop writes it.
    fs.rmSync(V2);
    write(V1, { mode: 'remote', remote: { url: 'http://box.example:9119', authMode: 'token', token: { encoding: 'safeStorage', value: 'djEwY2lwaGVydGV4dA==' } } });
    expect((await importDesktop()).tokenNotImported).toBe(true);
  });
});
