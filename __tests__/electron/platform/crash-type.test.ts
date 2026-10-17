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
  it('3. on macOS, the newest report of Tars since that start gives its exception type, and only that', () => {
    ips('Tars-2026-10-12-120000.ips', START - 3_600_000, 'EXC_BAD_ACCESS');
    ips('Tars-2026-10-13-002759.ips', START + 5_000_000, 'EXC_BREAKPOINT');
    expect(crashTypeSince(START, 'darwin', dir)).toBe('EXC_BREAKPOINT');
  });

  it('1. a crash from before that start is not this one', () => {
    ips('Tars-2026-10-12-120000.ips', START - 3_600_000, 'EXC_BAD_ACCESS');
    expect(crashTypeSince(START, 'darwin', dir)).toBeNull();
  });

  it('2. another app\'s report is never read', () => {
    ips('Tarsnap-2026-10-13-010000.ips', START + 60_000, 'EXC_CRASH');
    ips('Tars-2026-10-13-010000.ips', START + 60_000, 'EXC_CRASH', 'com.example.other');
    expect(crashTypeSince(START, 'darwin', dir)).toBeNull();
  });

  it('4. a report that is not what macOS writes gives nothing, and throws nothing', () => {
    ips('Tars-a.ips', START + 1_000, null);
    ips('Tars-b.ips', START + 2_000, null, BUNDLE, '{broken');
    ips('Tars-c.ips', START + 3_000, 'segfault at /Users/someone');
    fs.writeFileSync(path.join(dir, 'Tars-d.ips'), 'one line only');
    expect(() => crashTypeSince(START, 'darwin', dir)).not.toThrow();
    expect(crashTypeSince(START, 'darwin', dir)).toBeNull();
  });

  it('5. Linux and Windows give none, and read nothing', () => {
    ips('Tars-2026-10-13-002759.ips', START + 5_000_000, 'EXC_BREAKPOINT');
    expect(crashTypeSince(START, 'linux', dir)).toBeNull();
    expect(crashTypeSince(START, 'win32', dir)).toBeNull();
  });

  it('6. a missing folder throws nothing', () => {
    expect(crashTypeSince(START, 'darwin', path.join(dir, 'none'))).toBeNull();
  });
});
