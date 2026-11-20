import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readDacls, currentUserSid, type Dacl } from '../platform/read-dacl';

// Every call still reaches the real function: the spies only let a case look at
// a temp file the moment it is opened, before a byte is written to it.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, openSync: vi.fn(real.openSync) };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync), execFile: vi.fn(real.execFile) };
});

let tokenFile = '';
let privateHome = '';
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  // Read by api-server at each call, after the case has picked its folders.
  return {
    ...actual,
    get API_TOKEN_FILE() { return tokenFile; },
    get privatePath() { return (...segments: string[]) => path.join(privateHome, ...segments); },
  };
});

/**
 * Where a secret is born, on Windows (the review of win/secret-acl). Access is
 * checked when a handle is opened, Node opens with full sharing, and a handle
 * keeps what it was granted: `/inheritance:r` and `/reset` revoke nothing on a
 * handle already open. So a list set after the file exists is too late for
 * anyone who opened it in between, and keeps reading through that handle.
 *
 * How it can fail, written before the code:
 *  1. The temp of a secret save is made beside the target, under
 *     ~\.tars's list (which grants CodexSandboxUsers on this machine), and
 *     only closed afterwards: a process of those accounts watching the folder
 *     opens it in that window and keeps the handle.
 *  2. The temp is made in the staging directory before that directory is
 *     closed, so it is born with the home's list all the same.
 *  3. When the staging directory cannot be made or closed, the write is lost,
 *     or falls back without saying so.
 *  4. api-token is written in place: a handle opened on it before its list was
 *     set (an older build, a reader of the sandbox accounts) reads every token
 *     written after, since the file object stays the same.
 *  5. At startup, an api-token that already exists is closed in place: the same
 *     object, so a handle held from before keeps it, and `/reset` hands it the
 *     folder's list for a moment on the way.
 *  6. The token itself never changes: Tars reuses any api-token of 32
 *     characters or more, so one read before this build closed the file (by an
 *     older build's reader, a sandbox account) stays valid for ever. It must be
 *     minted anew once, the first time this build starts, and only once: every
 *     start after keeps it, as upstream does. darwin/linux never rotate.
 *  7. A holder that keeps api-token open makes the rename fail (EPERM, measured)
 *     and the app does not start: minting the token must never throw. It falls
 *     back to writing the file in place, closed, and says so.
 *  8. The staging directory is removed after it was closed (by the user, by an
 *     agent): its readiness is remembered, the temp cannot be created (ENOENT),
 *     and the save of the settings throws. It must make the directory again,
 *     closed, and try once more, or fall back and say so; never fail.
 *  9. A staging directory made beforehand with a grant of its own (an explicit
 *     entry: Everyone, CodexSandboxUsers) keeps it when closed, and every temp
 *     born in it inherits that grant.
 *
 * Real NTFS files, the real icacls; win32 only (darwin and linux: see
 * secret-file-acl.test.ts, case 7).
 */

const onWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const ICACLS = path.join(systemRoot, 'System32', 'icacls.exe');
const realExec = (childProcess.execFileSync as unknown as { getMockImplementation(): typeof childProcess.execFileSync }).getMockImplementation()!;
const realOpen = vi.mocked(fs.openSync).getMockImplementation()!;

const dacls = readDacls;
const made: string[] = [];
/** A folder that, like ~\.tars here, hands a group of other accounts read. */
function openHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-staging-'));
  made.push(dir);
  realExec(ICACLS, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], { stdio: 'ignore', windowsHide: true });
  return dir;
}

afterEach(() => {
  vi.mocked(fs.openSync).mockImplementation(realOpen);
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) {
    try { realExec(ICACLS, [dir, '/reset', '/T', '/Q'], { stdio: 'ignore', windowsHide: true }); } catch { /* removed below or not at all */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let userSid = '';
const ownerOnly = () => ({ protectedFromParent: true, aces: [`(A;;FA;;;${userSid})`, '(A;;FA;;;S-1-5-18)'].sort() });
const inheritedOwnerOnly = () => [`(A;ID;FA;;;${userSid})`, '(A;ID;FA;;;S-1-5-18)'].sort();

describe.runIf(onWindows)('a secret is born closed', { timeout: 180_000 }, () => {
  beforeAll(() => {
    userSid = currentUserSid();
  }, 180_000);

  it('1, 2: the temp is created in the closed staging directory, already closed, before a byte is written', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    await sf.closeSecretsToOtherAccounts([file], privateDir);

    const born: Array<{ at: string; size: number; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), size: fs.fstatSync(fd).size, list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);

    sf.writeSecretFileSync(file, '{"telegramBotToken":"x"}');

    expect(born).toHaveLength(1);
    expect(path.dirname(born[0].at).toLowerCase()).toBe(path.join(privateDir, '.staging').toLowerCase());
    expect(born[0].size, 'looked at before any content').toBe(0);
    expect(born[0].list.aces).toEqual(inheritedOwnerOnly());
    expect(dacls(file)[0]).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('{"telegramBotToken":"x"}');
    expect(fs.existsSync(`${file}.tmp`), 'nothing made beside the target').toBe(false);
  });

  it('2: a save made while the startup pass is still running is born closed too', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');

    const born: Array<{ at: string; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);

    // Not awaited: the pass has named the file and nothing is closed yet.
    const pass = sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"slackBotToken":"x"}');
    await pass;

    // The save's temp. The pass looked for the file before the save made it,
    // so it has no copy of its own to make.
    expect(born.map(b => path.basename(b.at).replace(/-[0-9a-f]{12}/, ''))).toEqual(['app-settings.json.tmp']);
    for (const b of born) {
      expect(path.dirname(b.at).toLowerCase()).toBe(path.join(privateDir, '.staging').toLowerCase());
      expect(b.list.aces, b.at).toEqual(inheritedOwnerOnly());
    }
    expect(dacls(file)[0]).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('{"slackBotToken":"x"}');
  });

  it('3: a staging directory that cannot be made falls back to the old order, says so, and keeps the write', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    fs.mkdirSync(privateDir);
    fs.writeFileSync(path.join(privateDir, '.staging'), 'a file where the directory should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"a":1}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(dacls(file)[0]).toEqual(ownerOnly());
    const said = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(said).toContain(file);
    expect(said).toMatch(/staging/);
  });

  it('4: with no holder, a new api-token is a new file object: a handle on the old one never reads it', async () => {
    vi.resetModules();
    const home = openHome();
    tokenFile = path.join(home, 'api-token');
    privateHome = path.join(home, '.tars-private');
    fs.writeFileSync(tokenFile, 'too-short-to-keep');
    const oldObject = fs.statSync(tokenFile, { bigint: true }).ino;
    const api = await import('../../../electron/services/api-server');
    const minted = api.getApiToken();
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(tokenFile, { bigint: true }).ino).not.toBe(oldObject);
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(minted);
  });

  it('7: a holder keeping api-token open does not stop the app: the token lands in place, closed, and it is said', async () => {
    vi.resetModules();
    const home = openHome();
    tokenFile = path.join(home, 'api-token');
    privateHome = path.join(home, '.tars-private');
    fs.writeFileSync(tokenFile, 'too-short-to-keep');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = fs.openSync(tokenFile, 'r');
    let minted = '';
    try {
      const api = await import('../../../electron/services/api-server');
      minted = api.getApiToken();
    } finally {
      fs.closeSync(held);
    }
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(minted);
    expect(dacls(tokenFile)[0]).toEqual(ownerOnly());
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain(tokenFile);
  });

  it('6: the first start of this build mints a new api-token and a new file object; the next start keeps it', async () => {
    const home = openHome();
    tokenFile = path.join(home, 'api-token');
    privateHome = path.join(home, '.tars-private');
    const older = 'c'.repeat(64);
    fs.writeFileSync(tokenFile, older);
    const oldObject = fs.statSync(tokenFile, { bigint: true }).ino;

    vi.resetModules();
    const first = (await import('../../../electron/services/api-server')).getApiToken();
    expect(first).not.toBe(older);
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(first);
    const rotatedObject = fs.statSync(tokenFile, { bigint: true }).ino;
    expect(rotatedObject).not.toBe(oldObject);

    vi.resetModules();
    const second = (await import('../../../electron/services/api-server')).getApiToken();
    expect(second).toBe(first);
    expect(fs.statSync(tokenFile, { bigint: true }).ino).toBe(rotatedObject);
  });

  it('8: the staging directory removed between two saves: the second save lands, born closed', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    const stagingDir = path.join(privateDir, '.staging');
    await sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"a":1}');
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const born: Array<{ at: string; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);

    sf.writeSecretFileSync(file, '{"a":2}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":2}');
    expect(born).toHaveLength(1);
    expect(path.dirname(born[0].at).toLowerCase()).toBe(stagingDir.toLowerCase());
    expect(born[0].list.aces).toEqual(inheritedOwnerOnly());
    expect(dacls(file)[0]).toEqual(ownerOnly());
  });

  it('9: a staging directory made beforehand loses the explicit grant it carried, at startup', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const privateDir = path.join(home, '.tars-private');
    const stagingDir = path.join(privateDir, '.staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    realExec(ICACLS, [stagingDir, '/grant', '*S-1-1-0:(OI)(CI)(R)'], { stdio: 'ignore', windowsHide: true });
    expect(dacls(stagingDir)[0].aces.some(a => a.endsWith(';S-1-1-0)')), 'the grant is there to begin with').toBe(true);

    await sf.closeSecretsToOtherAccounts([path.join(home, 'app-settings.json')], privateDir);

    expect(dacls(stagingDir)[0]).toEqual({ protectedFromParent: true, aces: [`(A;OICI;FA;;;${userSid})`, '(A;OICI;FA;;;S-1-5-18)'].sort() });
  });

  it('9: and so does one closed by a save that comes before the startup pass is done', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'app-settings.json');
    const privateDir = path.join(home, '.tars-private');
    const stagingDir = path.join(privateDir, '.staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    realExec(ICACLS, [stagingDir, '/grant', '*S-1-1-0:(OI)(CI)(R)'], { stdio: 'ignore', windowsHide: true });

    const born: Array<{ at: string; list: Dacl }> = [];
    vi.mocked(fs.openSync).mockImplementation(((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
      const fd = realOpen(p, flags, mode);
      if (String(p).endsWith('.tmp')) born.push({ at: String(p), list: dacls(String(p))[0] });
      return fd;
    }) as typeof fs.openSync);
    const pass = sf.closeSecretsToOtherAccounts([file], privateDir);
    sf.writeSecretFileSync(file, '{"a":1}');
    await pass;

    expect(born.length).toBeGreaterThan(0);
    expect(born[0].list.aces, 'the save, the first temp born').toEqual(inheritedOwnerOnly());
  });

  it('5: at startup an existing api-token becomes a new file object, same token, closed', async () => {
    vi.resetModules();
    const sf = await import('../../../electron/utils/secret-file');
    const home = openHome();
    const file = path.join(home, 'api-token');
    fs.writeFileSync(file, 'b'.repeat(64));
    const before = fs.statSync(file, { bigint: true }).ino;

    await sf.closeSecretsToOtherAccounts([file], path.join(home, '.tars-private'));

    expect(fs.statSync(file, { bigint: true }).ino).not.toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('b'.repeat(64));
    expect(dacls(file)[0]).toEqual(ownerOnly());
  });
});

describe('darwin and linux never rotate api-token (case 6)', () => {
  const HOST = process.platform;
  afterEach(() => Object.defineProperty(process, 'platform', { value: HOST, configurable: true }));
  // The first import of api-server transforms the main process's module graph: 8.3 s of the darwin case's 5 at a
  // load of 70 and 11.4 s at 130, then 81 ms for the linux case (QA's runs of 2.0.1). Paid here, once, with the
  // time it takes; each case still imports api-server anew, under its platform, after vi.resetModules().
  beforeAll(async () => { await import('../../../electron/services/api-server'); }, 60_000);

  it.each(['darwin', 'linux'] as const)('%s: a usable token is kept, the file untouched, no marker made', async (platform) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-rotation-posix-'));
    made.push(home);
    tokenFile = path.join(home, 'api-token');
    privateHome = path.join(home, '.tars-private');
    const older = 'd'.repeat(64);
    fs.writeFileSync(tokenFile, older);
    const before = fs.statSync(tokenFile, { bigint: true });
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.resetModules();
    const token = (await import('../../../electron/services/api-server')).getApiToken();
    Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
    expect(token).toBe(older);
    const after = fs.statSync(tokenFile, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(fs.existsSync(privateHome)).toBe(false);
  });
});
