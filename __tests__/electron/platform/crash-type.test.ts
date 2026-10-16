import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { crashTypeSince } from '../../../electron/platform/crash-type';

/**
 * What the OS named the crash of a run that ended abruptly, without memory (2.0.3, monitoring option 1): on macOS the
 * exception type of the .ips report it wrote, `EXC_BREAKPOINT`; on Linux and Windows nothing, since neither writes
 * such a report without the process's memory.
 *
 * How it fails, written before the code:
 * 1. An older crash (before that run started) is taken for this one.
 * 2. Another app's report (a name that starts with Tars, another bundle) is read.
 * 3. More than the exception type leaves: its codes, the threads, a path, the whole file.
 * 4. A report that is not what macOS writes (one line, broken JSON, no exception, a type that is not one) throws, or
 *    gives a type.
 * 5. Linux or Windows read a folder, or give a type.
 * 6. A missing folder throws.
 *
 * And on Linux and Windows (the parity program's P8, R7 of the audit, 2026-10-17), which write no report beside the
 * memory, but keep a record of the crash: systemd-coredump's (`coredumpctl --json=short list`: its signal), and the
 * Application log's event 1000 that Windows Error Reporting writes for a program that crashed (its exception code).
 * Tars starts no crash handler of its own (no native dumps, services/error-reports), so its crash reaches both. 5 now
 * reads: Linux and Windows read nothing of macOS's folder.
 * 7. Linux: systemd-coredump's record of that run's crash is not read: no type where it names the signal (SIGTRAP).
 * 8. Linux: another program's crash, another user's, or one older than that run is taken; or more than the signal's
 *    name leaves (the core, its path, the pid).
 * 9. Linux: no coredumpctl (Ubuntu runs apport, which writes nothing for a program it did not install), one older than
 *    --json, or an answer that is not its list: anything but no type, or a throw.
 * 10. Windows: event 1000 of that run's crash is not read: no type where it names the exception (EXCEPTION_BREAKPOINT).
 * 11. Windows: another program's event, or one older than that run, is taken; a code that is not an exception code
 *    gives a type; or more than the exception's name leaves (the module, the offset, the path).
 * 12. Windows: PowerShell fails, finds no event, or answers something that is not the list: anything but no type.
 * 13. The launch waits on those programs: the read is asynchronous.
 */

const BUNDLE = 'xyz.cooperlabs.tars';
let dir: string;
const START = Date.UTC(2026, 9, 13, 0, 0, 0);

function ips(name: string, at: number, type: string | null, bundle = BUNDLE, body?: string): void {
  const header = JSON.stringify({ app_name: 'Tars', bundleID: bundle, app_version: '2.0.2', bug_type: '309' });
  const content = body ?? JSON.stringify({ exception: type ? { type, signal: 'SIGTRAP', codes: '0x1' } : undefined, threads: [{ frames: ['/Users/someone/x'] }] });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${header}\n${content}`);
  fs.utimesSync(file, new Date(at), new Date(at));
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-ips-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('the crash type of a run that ended abruptly', () => {
  it('3. on macOS, the newest report of Tars since that start gives its exception type, and only that', async () => {
    ips('Tars-2026-10-12-120000.ips', START - 3_600_000, 'EXC_BAD_ACCESS');
    ips('Tars-2026-10-13-002759.ips', START + 5_000_000, 'EXC_BREAKPOINT');
    expect(await crashTypeSince(START, 'darwin', dir)).toBe('EXC_BREAKPOINT');
  });

  it('1. a crash from before that start is not this one', async () => {
    ips('Tars-2026-10-12-120000.ips', START - 3_600_000, 'EXC_BAD_ACCESS');
    expect(await crashTypeSince(START, 'darwin', dir)).toBeNull();
  });

  it('2. another app\'s report is never read', async () => {
    ips('Tarsnap-2026-10-13-010000.ips', START + 60_000, 'EXC_CRASH');
    ips('Tars-2026-10-13-010000.ips', START + 60_000, 'EXC_CRASH', 'com.example.other');
    expect(await crashTypeSince(START, 'darwin', dir)).toBeNull();
  });

  it('4. a report that is not what macOS writes gives nothing, and throws nothing', async () => {
    ips('Tars-a.ips', START + 1_000, null);
    ips('Tars-b.ips', START + 2_000, null, BUNDLE, '{broken');
    ips('Tars-c.ips', START + 3_000, 'segfault at /Users/someone');
    fs.writeFileSync(path.join(dir, 'Tars-d.ips'), 'one line only');
    await expect(crashTypeSince(START, 'darwin', dir)).resolves.toBeNull();
  });

  it('5, 13. Linux and Windows read nothing of macOS\'s folder, and wait aside', async () => {
    ips('Tars-2026-10-13-002759.ips', START + 5_000_000, 'EXC_BREAKPOINT');
    const nothing = async () => null;
    const linux = crashTypeSince(START, 'linux', dir, { read: nothing });
    const win32 = crashTypeSince(START, 'win32', dir, { read: nothing });
    expect(linux).toBeInstanceOf(Promise);
    expect(await linux).toBeNull();
    expect(await win32).toBeNull();
  });

  it('6. a missing folder throws nothing', async () => {
    expect(await crashTypeSince(START, 'darwin', path.join(dir, 'none'))).toBeNull();
  });
});

/** coredumpctl as it answers: its JSON list only when asked for it, its table otherwise. */
function coredumpctl(rows: unknown) {
  return async (file: string, args: string[]) => {
    if (file !== 'coredumpctl' || !args.includes('list')) return null;
    if (!args.includes('--json=short')) return 'TIME                           PID  UID  GID SIG     COREFILE EXE\n';
    return typeof rows === 'string' ? rows : JSON.stringify(rows);
  };
}
const dump = (over: Record<string, unknown> = {}) => ({
  time: (START + 60_000) * 1000, pid: 4242, uid: 1000, gid: 1000, sig: 5, corefile: 'present', exe: '/tmp/.mount_TarsAbc/tars', size: 123456, ...over,
});

describe('on Linux, from systemd-coredump', () => {
  const linux = (rows: unknown) => crashTypeSince(START, 'linux', dir, { read: coredumpctl(rows), exe: 'tars', uid: 1000 });

  it("7, 8. names the signal of that run's crash, and only its name", async () => {
    expect(await linux([dump()])).toBe('SIGTRAP');
  });

  it("7. names the newest of that run's crashes, and a signal it has no name for by its number", async () => {
    expect(await linux([dump({ sig: 11, time: (START + 1_000) * 1000 }), dump({ sig: 6, time: (START + 2_000) * 1000 })])).toBe('SIGABRT');
    expect(await linux([dump({ sig: 24 })])).toBe('SIG24');
  });

  it("8. takes no other program's crash, no other user's, none older than that run", async () => {
    expect(await linux([dump({ exe: '/usr/bin/tarsnap' }), dump({ uid: 0 }), dump({ time: (START - 1_000) * 1000 })])).toBeNull();
  });

  it('9. gives none, and throws nothing, without coredumpctl, with an old one, or with an answer that is not its list', async () => {
    expect(await crashTypeSince(START, 'linux', dir, { read: async () => null, exe: 'tars', uid: 1000 })).toBeNull();
    for (const answer of ['Unknown option --json', '{}', '[{"sig":"5","exe":"/x/tars","uid":1000}]', '[null, 7]']) {
      await expect(linux(answer)).resolves.toBeNull();
    }
  });
});

/** The Windows PowerShell under %SystemRoot%, as it answers: the events of the Application log since the run began. */
function applicationLog(rows: unknown, since = START) {
  return async (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
    if (!/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(file)) return null;
    if (!args.join(' ').includes('Get-WinEvent') || env?.TARS_SINCE !== String(since)) return null;
    return typeof rows === 'string' ? rows : JSON.stringify(rows);
  };
}
const event = (over: Record<string, unknown> = {}) => ({ app: 'Tars.exe', code: '80000003', at: new Date(START + 60_000).toISOString(), ...over });

describe('on Windows, from the Application log', () => {
  const win32 = (rows: unknown) => crashTypeSince(START, 'win32', dir, { read: applicationLog(rows), exe: 'Tars.exe', env: { SystemRoot: 'C:\\Windows' } });

  it("10, 11. names the exception of that run's crash, and only its name", async () => {
    expect(await win32([event()])).toBe('EXCEPTION_BREAKPOINT');
    expect(await win32(event({ code: 'c0000005' }))).toBe('EXCEPTION_ACCESS_VIOLATION');
  });

  it('10. names the newest, and an exception it has no name for by its code', async () => {
    expect(await win32([event({ code: 'c0000005', at: new Date(START + 1_000).toISOString() }), event({ code: 'c0000409', at: new Date(START + 2_000).toISOString() })]))
      .toBe('STATUS_STACK_BUFFER_OVERRUN');
    expect(await win32([event({ code: '0xC0000135' })])).toBe('EXCEPTION_C0000135');
  });

  it("11. takes no other program's event, none older than that run, no code that is not one", async () => {
    expect(await win32([event({ app: 'Code.exe' }), event({ at: new Date(START - 1_000).toISOString() }), event({ code: 'not a code' }), event({ code: 'c0000005 at C:\\x' })])).toBeNull();
    expect(await win32([event({ at: new Date(START - 1_000).toISOString() })])).toBeNull();
    // A newer event whose code is not one is passed over, as macOS passes over a report it cannot read.
    expect(await win32([event({ code: 'not a code', at: new Date(START + 2_000).toISOString() }), event({ at: new Date(START + 1_000).toISOString() })])).toBe('EXCEPTION_BREAKPOINT');
  });

  it('12. gives none, and throws nothing, when PowerShell fails, finds nothing, or answers something else', async () => {
    expect(await crashTypeSince(START, 'win32', dir, { read: async () => null, exe: 'Tars.exe', env: { SystemRoot: 'C:\\Windows' } })).toBeNull();
    for (const answer of ['', 'Get-WinEvent : No events were found', '{"app":1}', '[7]']) {
      await expect(win32(answer)).resolves.toBeNull();
    }
  });
});
