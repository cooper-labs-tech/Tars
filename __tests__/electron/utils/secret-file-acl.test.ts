import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeSecretFileSync, writeAtomicSync, closeSecretsToOtherAccounts,
} from '../../../electron/utils/secret-file';
import { hasPosixModes } from '../../setup/platform-limits';
import { readDacls, currentUserSid, type Dacl } from '../platform/read-dacl';

// Every call still runs the real program: the spy only lets case 7 say that
// darwin and linux never start icacls or whoami.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync), execFile: vi.fn(real.execFile) };
});

/**
 * The secret files as the app writes them, on Windows: `app-settings.json`,
 * `hermes-connection.json` and `api-token` in ~/.tars, the ones main.ts
 * names at startup, and everything in ~/.tars-private end with the current
 * user and SYSTEM on their access list and nobody else (platform/owner-only.ts
 * holds the primitive and its own failure list). The startup pass is what
 * names them, so each case below starts with it.
 *
 * How it can fail, written before the code:
 *  1. writeSecretFileSync leaves the file with what its folder hands down.
 *  2. The list is set after the rename: for a moment the live file, with the
 *     new secret in it, is open to whoever the folder lets in. Shown by a
 *     rename that cannot happen: the temp file it leaves must already be
 *     closed. (Where the temp is born, and that it is closed from its first
 *     byte, is secret-file-staging.test.ts.) And a temp holding the secret
 *     outlives the failed write, beside the target or in the staging directory.
 *  3. A file that was too open before is still too open after the next save.
 *  4. api-token stays open.
 *  5. At start, the files that exist are not tightened, the private directory
 *     is not, or a file that does not exist makes it throw or log.
 *  6. An icacls that fails throws, loses the write, or says nothing.
 *  7. darwin/linux: icacls or whoami is started, or what lands on disk is not
 *     what it was (the contents, the 0600 mode).
 *  8. Over-reach: an ordinary state file (agents.json, written by
 *     writeAtomicSync) is closed too. ~/.tars is the agents' directory, and
 *     a Codex sandbox reads it through the access list its setup grants there.
 *  9. A secret the startup pass does not name (hermes-session.json, written on
 *     every gateway reply that sets a cookie) starts an icacls on every write,
 *     on the main process: measured, hermes-cookie-jar.test.ts went from 0.6 s
 *     to 13 s on a machine at 100% CPU, and timed out in the full suite. It
 *     keeps what its folder hands down, as before this change.
 * 10. A file written into the closed private directory starts an icacls when
 *     the directory's list already closes it (the Chat writes there on every
 *     turn); or a private directory that does not exist yet at startup is
 *     made later with the home's list.
 */

const onWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const ICACLS = path.join(systemRoot, 'System32', 'icacls.exe');
const realExec = childProcess.execFileSync;

const dacls = readDacls;
const dacl = (p: string): Dacl => readDacls(p)[0];

const made: string[] = [];
function openDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-secret-acl-'));
  made.push(dir);
  if (onWindows) realExec(ICACLS, [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)'], { stdio: 'ignore', windowsHide: true });
  return dir;
}

const HOST = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let userSid = '';
const ownerOnly = () => ({ protectedFromParent: true, aces: [`(A;;FA;;;${userSid})`, '(A;;FA;;;S-1-5-18)'].sort() });

// A PowerShell start reads the access lists: one to three seconds, far more on a machine
// running other suites (100% CPU, measured).
describe.runIf(onWindows)('the secret files on NTFS', { timeout: 180_000 }, () => {
  beforeAll(() => {
    userSid = currentUserSid();
  }, 180_000);

  it('1: writeSecretFileSync closes the file to everyone but the user and SYSTEM', async () => {
    const file = path.join(openDir(), 'app-settings.json');
    await closeSecretsToOtherAccounts([file], path.join(path.dirname(file), '.tars-private'));
    writeSecretFileSync(file, '{"slackBotToken":"x"}');
    expect(dacl(file)).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('{"slackBotToken":"x"}');
  });

  it('2: a write whose rename fails leaves no temp behind', async () => {
    const dir = openDir();
    const target = path.join(dir, 'app-settings.json');
    await closeSecretsToOtherAccounts([target], path.join(dir, '.tars-private'));
    // A directory where the file should go: the rename can never land.
    fs.mkdirSync(target);
    expect(() => writeSecretFileSync(target, '{"slackBotToken":"x"}')).toThrow();
    const staging = path.join(dir, '.tars-private', '.staging');
    expect(fs.readdirSync(staging).filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('3: a file that was too open is closed by the next save', async () => {
    const file = path.join(openDir(), 'app-settings.json');
    await closeSecretsToOtherAccounts([file], path.join(path.dirname(file), '.tars-private'));
    fs.writeFileSync(file, '{}');
    realExec(ICACLS, [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true });
    writeSecretFileSync(file, '{"a":1}');
    expect(dacl(file)).toEqual(ownerOnly());
  });

  it('4: api-token is closed', async () => {
    const file = path.join(openDir(), 'api-token');
    await closeSecretsToOtherAccounts([file], path.join(path.dirname(file), '.tars-private'));
    writeSecretFileSync(file, 'f'.repeat(64));
    expect(dacl(file)).toEqual(ownerOnly());
    expect(fs.readFileSync(file, 'utf8')).toBe('f'.repeat(64));
  });

  it('5: at start, the existing files and the private directory are closed; a missing one is skipped quietly', async () => {
    const home = openDir();
    const settings = path.join(home, 'app-settings.json');
    fs.writeFileSync(settings, '{}');
    realExec(ICACLS, [settings, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true });
    const privateDir = path.join(home, '.tars-private');
    fs.mkdirSync(privateDir);
    const aside = path.join(privateDir, 'overseer.superseded-1.json');
    fs.writeFileSync(aside, '{}');
    const warn = vi.spyOn(console, 'warn');

    await closeSecretsToOtherAccounts([settings, path.join(home, 'api-token')], privateDir);

    const [ofSettings, ofDir, ofAside] = dacls(settings, privateDir, aside);
    expect(ofSettings).toEqual(ownerOnly());
    expect(ofDir.protectedFromParent).toBe(true);
    expect(ofAside.aces).toEqual([`(A;ID;FA;;;${userSid})`, '(A;ID;FA;;;S-1-5-18)'].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  it('6: an icacls that fails is logged, and the write lands all the same', async () => {
    const file = path.join(openDir(), 'app-settings.json');
    await closeSecretsToOtherAccounts([file], path.join(path.dirname(file), '.tars-private'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = path.join(os.tmpdir(), 'no-windows-here');
    try {
      writeSecretFileSync(file, '{"a":1}');
    } finally {
      process.env.SystemRoot = saved;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain(file);
  });

  it('9: a secret the startup pass does not name is written without an icacls, as before', async () => {
    const home = openDir();
    await closeSecretsToOtherAccounts([path.join(home, 'app-settings.json')], path.join(home, '.tars-private'));
    const spy = vi.mocked(childProcess.execFileSync);
    spy.mockClear();
    const jar = path.join(home, 'hermes-session.json');
    writeSecretFileSync(jar, '{}');
    expect(spy.mock.calls.filter(c => /icacls|whoami/i.test(String(c[0])))).toEqual([]);
    expect(dacl(jar).protectedFromParent).toBe(false);
  });

  it('10: the private directory is made and closed at start, and a write into it needs no icacls', async () => {
    const home = openDir();
    const privateDir = path.join(home, '.tars-private');
    await closeSecretsToOtherAccounts([], privateDir);
    const spy = vi.mocked(childProcess.execFileSync);
    spy.mockClear();
    const turn = path.join(privateDir, 'overseer.json');
    writeSecretFileSync(turn, '{"messages":[]}');
    expect(spy.mock.calls.filter(c => /icacls|whoami/i.test(String(c[0])))).toEqual([]);
    const [ofDir, ofTurn] = dacls(privateDir, turn);
    expect(ofDir.protectedFromParent).toBe(true);
    expect(ofTurn.aces).toEqual([`(A;ID;FA;;;${userSid})`, '(A;ID;FA;;;S-1-5-18)'].sort());
  });

  it('8: an ordinary state file is left as its folder hands it down', () => {
    const file = path.join(openDir(), 'agents.json');
    writeAtomicSync(file, '[]');
    expect(dacl(file).protectedFromParent).toBe(false);
  });
});

describe('darwin and linux (case 7)', () => {
  it.each(['darwin', 'linux'] as const)('%s: no icacls, no whoami, the same bytes and mode', async (platform) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-secret-posix-'));
    made.push(dir);
    const spy = vi.mocked(childProcess.execFileSync);
    const spyAsync = vi.mocked(childProcess.execFile);
    spyAsync.mockClear();
    spy.mockClear();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    writeSecretFileSync(path.join(dir, 'app-settings.json'), '{"a":1}');
    writeSecretFileSync(path.join(dir, 'api-token'), 'tok');
    await closeSecretsToOtherAccounts([path.join(dir, 'app-settings.json')], path.join(dir, '.tars-private'));
    // Named by the startup pass now: still nothing started.
    writeSecretFileSync(path.join(dir, 'app-settings.json'), '{"a":1}');

    Object.defineProperty(process, 'platform', { value: HOST, configurable: true });
    expect([...spy.mock.calls, ...spyAsync.mock.calls].filter(c => /icacls|whoami/i.test(String(c[0])))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'app-settings.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(path.join(dir, 'api-token'), 'utf8')).toBe('tok');
    expect(fs.existsSync(path.join(dir, '.tars-private')), 'no private directory made at start').toBe(false);
    if (hasPosixModes()) {
      expect(fs.statSync(path.join(dir, 'app-settings.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, 'api-token')).mode & 0o777).toBe(0o600);
    }
  });
});
