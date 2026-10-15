import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  restrictToOwnerSync, restrictToOwner, restrictDirToOwner, parseWhoamiUserSid, SYSTEM_SID,
  type OwnerOnlyDeps,
} from '../../../electron/platform/owner-only';
import { cannotSymlink } from '../../setup/symlink-privilege';
import { readDacls, currentUserSid, type Dacl } from './read-dacl';

/**
 * Closing a secret to every account but its owner, on Windows. `0o600` and
 * `0o700` do nothing there: Node
 * maps chmod to the read-only bit. So `api-token`, `app-settings.json` and
 * everything under `~/.tars-private` get an access list instead: the current
 * user and SYSTEM, full control, nothing inherited. `icacls` by its System32
 * path, with an argv; the user's SID from `whoami /user`.
 *
 * How it can fail, written before the code:
 *  1. Nothing is applied: the file keeps what its folder hands down, here a
 *     folder that lets every member of Users read (as C:\Users\Public does,
 *     and as Codex's sandbox setup does with CodexSandboxUsers on a read root).
 *  2. Inheritance is left on: a grant added to the folder later, with (OI)(CI)
 *     as Codex's setup adds it, flows into the file again.
 *  3. A principal is left over: an explicit entry on a file that already
 *     existed (Everyone:R), or the Administrators group the profile hands down.
 *  4. The owner is locked out, or SYSTEM is: the app, its hooks and the MCP
 *     servers (all run as the user) can no longer read the file, or backups
 *     and services break.
 *  5. The user's SID is wrong or garbage: whoami's output is not parsed from
 *     the right field, a name with a comma or quotes shifts it, or an
 *     unparseable answer is passed to icacls anyway.
 *  6. A failure (icacls missing, a file gone, a hung call) throws into the
 *     caller, or is silent.
 *  7. The private directory is closed but what is in it is not, or a file
 *     made in it later by any code path is open again: the directory must
 *     hand down owner and SYSTEM only.
 *  8. Closing the directory follows a link in it (a junction an agent could
 *     plant, to ~/.ssh say) and resets the access list of what it points at.
 *     Measured: icacls /reset does not follow a junction, so the junction
 *     case holds with or without the check; icacls does follow a symbolic
 *     link (its /L says so), which is the case the check is for, and needs
 *     the symlink privilege (CI windows-latest; skipped on an account without it).
 *  9. darwin/linux: anything at all runs. icacls and whoami do not exist
 *     there, and the modes already do the job.
 * 10. The pass at startup holds its caller until every icacls has run: two
 *     per file, measured at 2 to 4.6 s for three files and a directory of
 *     three on a machine at 100% CPU, with the main process frozen before its
 *     window shows.
 *
 * Cases 1 to 4, 7 and 8 run on real NTFS files with the real icacls, on
 * win32 only; the rest run everywhere, with the process runner injected.
 */

const onWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const ICACLS = path.join(systemRoot, 'System32', 'icacls.exe');
const USERS_SID = 'S-1-5-32-545';
const EVERYONE_SID = 'S-1-1-0';

const dacls = readDacls;
const dacl = (p: string): Dacl => readDacls(p)[0];

function icacls(...args: string[]): void {
  execFileSync(ICACLS, args, { stdio: 'ignore', windowsHide: true });
}

let userSid = '';
const made: string[] = [];

function openDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-owner-only-'));
  made.push(dir);
  if (onWindows) icacls(dir, '/grant', `*${USERS_SID}:(OI)(CI)(RX)`);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ownerOnlyFile = () => [`(A;;FA;;;${userSid})`, '(A;;FA;;;S-1-5-18)'].sort();

// A PowerShell start reads the access lists: one to three seconds, far more on a machine
// running other suites (100% CPU, measured).
describe.runIf(onWindows)('restrictToOwnerSync on NTFS, with the real icacls', { timeout: 180_000 }, () => {
  beforeAll(() => {
    userSid = currentUserSid();
    expect(userSid).toMatch(/^S-1-5-21-/);
  }, 180_000);

  it('1, 4: leaves exactly the user and SYSTEM, full control, inheritance removed', () => {
    const file = path.join(openDir(), 'api-token');
    fs.writeFileSync(file, 'secret');
    // The fixture is open to begin with, or the case proves nothing.
    expect(dacl(file).aces.some(a => a.includes(USERS_SID))).toBe(true);

    expect(restrictToOwnerSync(file)).toBe('restricted');

    expect(dacl(file)).toEqual({ protectedFromParent: true, aces: ownerOnlyFile() });
  });

  it('4: a process of the same user (a hook, an MCP server) still reads the file', () => {
    const file = path.join(openDir(), 'app-settings.json');
    fs.writeFileSync(file, '{"telegramBotToken":"x"}');
    restrictToOwnerSync(file);
    const read = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', file], { encoding: 'utf8' });
    expect(read.status).toBe(0);
    expect(read.stdout).toBe('{"telegramBotToken":"x"}');
  });

  it('2: a grant added to the folder afterwards, as Codex adds a read root, does not reach the file', () => {
    const dir = openDir();
    const file = path.join(dir, 'app-settings.json');
    fs.writeFileSync(file, '{}');
    restrictToOwnerSync(file);
    icacls(dir, '/grant', `*${EVERYONE_SID}:(OI)(CI)(RX)`);
    expect(dacl(file)).toEqual({ protectedFromParent: true, aces: ownerOnlyFile() });
  });

  it('3: an existing file with an explicit extra entry is tightened when asked to replace explicit entries', () => {
    const file = path.join(openDir(), 'hermes-connection.json');
    fs.writeFileSync(file, '{}');
    icacls(file, '/grant', `*${EVERYONE_SID}:(R)`);
    expect(dacl(file).aces.some(a => a.endsWith(';S-1-1-0)'))).toBe(true);

    expect(restrictToOwnerSync(file, { replaceExplicit: true })).toBe('restricted');

    expect(dacl(file)).toEqual({ protectedFromParent: true, aces: ownerOnlyFile() });
  });

  it('6: a file that is not there is logged and reported, never thrown', () => {
    const warned: string[] = [];
    const missing = path.join(openDir(), 'gone');
    expect(restrictToOwnerSync(missing, {}, { warn: m => warned.push(m) })).toBe('failed');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(missing);
  });

  it('6: an icacls that cannot be found is logged and reported, never thrown', () => {
    const warned: string[] = [];
    const file = path.join(openDir(), 'api-token');
    fs.writeFileSync(file, 'secret');
    const result = restrictToOwnerSync(file, {}, { env: { ...process.env, SystemRoot: path.join(os.tmpdir(), 'no-windows-here') }, warn: m => warned.push(m) });
    expect(result).toBe('failed');
    expect(warned.join('\n')).toContain(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('secret');
  });

  it('7: the private directory hands down owner and SYSTEM only, to what is in it and to what is made in it later', async () => {
    const dir = path.join(openDir(), '.tars-private');
    fs.mkdirSync(dir);
    const before = path.join(dir, 'overseer.superseded-1.json');
    fs.writeFileSync(before, '{}');
    icacls(before, '/grant', `*${EVERYONE_SID}:(R)`);

    expect(await restrictDirToOwner(dir)).toBe('restricted');
    const after = path.join(dir, 'made-later.json');
    fs.writeFileSync(after, '{}');

    const [ofDir, ofBefore, ofAfter] = dacls(dir, before, after);
    expect(ofDir).toEqual({ protectedFromParent: true, aces: [`(A;OICI;FA;;;${userSid})`, '(A;OICI;FA;;;S-1-5-18)'].sort() });
    const inherited = [`(A;ID;FA;;;${userSid})`, '(A;ID;FA;;;S-1-5-18)'].sort();
    expect(ofBefore.aces).toEqual(inherited);
    expect(ofAfter.aces).toEqual(inherited);
  });

  it('8: a junction in the private directory is not followed', async () => {
    const outside = path.join(openDir(), 'victim');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'key');
    icacls(outside, '/grant', `*${EVERYONE_SID}:(R)`);
    const before = dacls(outside, path.join(outside, 'id_rsa'));

    const dir = path.join(openDir(), '.tars-private');
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
    await restrictDirToOwner(dir);

    expect(dacls(outside, path.join(outside, 'id_rsa'))).toEqual(before);
    expect(before[0].aces.some(a => a.endsWith(';S-1-1-0)')), 'the fixture carries its own entry').toBe(true);
  });

  it.skipIf(cannotSymlink())('8: a symbolic link in the private directory is not followed', async () => {
    const outside = path.join(openDir(), 'id_rsa');
    fs.writeFileSync(outside, 'key');
    icacls(outside, '/grant', `*${EVERYONE_SID}:(R)`);
    const before = dacls(outside);
    const dir = path.join(openDir(), '.tars-private');
    fs.mkdirSync(dir);
    fs.symlinkSync(outside, path.join(dir, 'link'), 'file');
    await restrictDirToOwner(dir);
    expect(dacls(outside)).toEqual(before);
  });

  it('3, 10: the startup form closes an existing file the same way', async () => {
    const file = path.join(openDir(), 'app-settings.json');
    fs.writeFileSync(file, '{}');
    icacls(file, '/grant', `*${EVERYONE_SID}:(R)`);
    expect(await restrictToOwner(file, { replaceExplicit: true })).toBe('restricted');
    expect(dacl(file)).toEqual({ protectedFromParent: true, aces: ownerOnlyFile() });
  });

  it('7: a missing private directory is left alone and reported as such', async () => {
    const warned: string[] = [];
    expect(await restrictDirToOwner(path.join(openDir(), 'never-made'), { warn: m => warned.push(m) })).toBe('skipped');
    expect(warned).toEqual([]);
  });
});

describe('parseWhoamiUserSid (case 5)', () => {
  it('reads the SID from the last field of `whoami /user /fo csv /nh`', () => {
    expect(parseWhoamiUserSid('"warmachine\\owner","S-1-5-21-1252805805-404670591-934153705-1001"\r\n'))
      .toBe('S-1-5-21-1252805805-404670591-934153705-1001');
  });

  it('is not shifted by a user name holding a comma or a quote', () => {
    expect(parseWhoamiUserSid('"corp\\o""brien, jean","S-1-5-21-1-2-3-500"')).toBe('S-1-5-21-1-2-3-500');
  });

  it('refuses anything that is not a SID', () => {
    for (const out of ['', 'ERROR: access denied', '"a\\b","owner"', '"a\\b","S-1-5-21-1-2;rm"', '"a\\b","S-1-"']) {
      expect(parseWhoamiUserSid(out), out).toBeNull();
    }
  });
});

describe('restrictToOwnerSync with an injected runner', () => {
  function runner(answers: Record<string, string | Error>) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const deps: OwnerOnlyDeps = {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      execFileSync: (file, args) => {
        calls.push({ file, args: [...args] });
        const answer = answers[path.win32.basename(file).toLowerCase()];
        if (answer instanceof Error) throw answer;
        return answer ?? '';
      },
      execFile: async (file, args) => {
        calls.push({ file, args: [...args] });
        const answer = answers[path.win32.basename(file).toLowerCase()];
        if (answer instanceof Error) throw answer;
        return answer ?? '';
      },
      warn: () => {},
    };
    return { calls, deps };
  }

  it('9: darwin and linux run nothing and report it', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, deps } = runner({});
      expect(restrictToOwnerSync('/home/u/.dorothy/api-token', {}, { ...deps, platform })).toBe('skipped');
      expect(await restrictToOwner('/home/u/.dorothy/api-token', {}, { ...deps, platform })).toBe('skipped');
      expect(await restrictDirToOwner('/home/u/.tars-private', { ...deps, platform })).toBe('skipped');
      expect(calls).toEqual([]);
    }
  });

  it('5: an unparseable whoami answer never reaches icacls', () => {
    const warned: string[] = [];
    const { calls, deps } = runner({ 'whoami.exe': 'ERROR: something' });
    expect(restrictToOwnerSync('C:\\u\\.dorothy\\api-token', {}, { ...deps, warn: m => warned.push(m) })).toBe('failed');
    expect(calls.map(c => path.win32.basename(c.file))).toEqual(['whoami.exe']);
    expect(warned).toHaveLength(1);
  });

  it('runs icacls and whoami from System32, never a name looked up on the PATH, with the path as one argument', () => {
    const { calls, deps } = runner({ 'whoami.exe': '"a\\b","S-1-5-21-1-2-3-1001"' });
    const target = 'C:\\Users\\a b\\.dorothy\\app-settings.json" /grant *S-1-1-0:(F)';
    expect(restrictToOwnerSync(target, {}, deps)).toBe('restricted');
    expect(calls.map(c => c.file)).toEqual(['C:\\Windows\\System32\\whoami.exe', 'C:\\Windows\\System32\\icacls.exe']);
    expect(calls[1].args).toEqual([target, '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(F)', `*${SYSTEM_SID}:(F)`]);
  });

  it('6: a failing icacls is logged once, with the file, and reported', () => {
    const warned: string[] = [];
    const { deps } = runner({ 'whoami.exe': '"a\\b","S-1-5-21-1-2-3-1001"', 'icacls.exe': Object.assign(new Error('Command failed'), { status: 5 }) });
    expect(restrictToOwnerSync('C:\\u\\f', {}, { ...deps, warn: m => warned.push(m) })).toBe('failed');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('C:\\u\\f');
  });

  it('10: the startup form hands its caller back before icacls has answered', async () => {
    const waiting: Array<(out: string) => void> = [];
    const started: string[] = [];
    const deps: OwnerOnlyDeps = {
      platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, warn: () => {},
      execFile: (file) => { started.push(path.win32.basename(file)); return new Promise<string>(r => { waiting.push(r); }); },
    };
    const tick = () => new Promise(r => setImmediate(r));
    let settled = false;
    const pending = restrictToOwner('C:\\u\\.dorothy\\app-settings.json', { replaceExplicit: true }, deps).then(r => { settled = true; return r; });
    // Back in the caller's hands while whoami has not answered.
    expect(started).toEqual(['whoami.exe']);
    waiting.shift()!('"a\\b","S-1-5-21-1-2-3-1001"');
    await tick();
    expect(started).toEqual(['whoami.exe', 'icacls.exe']);
    expect(settled).toBe(false);
    waiting.shift()!('');
    await tick();
    waiting.shift()!('');
    expect(await pending).toBe('restricted');
    expect(started).toEqual(['whoami.exe', 'icacls.exe', 'icacls.exe']);
  });
});
