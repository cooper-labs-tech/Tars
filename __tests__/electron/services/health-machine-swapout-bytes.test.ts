import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The swapouts readMachine gives the heavy-run slot are bytes, at the page size each system says (2.0.6; the Audit's
 * I8 on #573: no unit held the conversion, and its two mutants, the page size dropped on macOS and on Linux, left
 * every test green). The commands and /proc files are stood in for, with page sizes other than the usual ones.
 *
 * How it fails, written before this test (29/10; the code is #573's 52af53077):
 * B1. macOS: vm_stat's Swapouts counted in pages, or at a page size other than the one vm_stat's own header says
 *     (8 KB here, not Apple silicon's 16 KB).
 * B2. Linux: /proc/vmstat's pswpout counted in pages, or at a page size other than `getconf PAGESIZE` says (64 KB
 *     here, as on some arm64 kernels); 4 KB when getconf cannot be read.
 */

const { outputs, files } = vi.hoisted(() => ({
  outputs: {} as Record<string, string | undefined>,
  files: {} as Record<string, string>,
}));

vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (file: string, _args: string[], _opts: unknown, done: (err: Error | null, out: string) => void) => {
    const out = outputs[file];
    if (out === undefined) done(new Error(`${file}: not here`), '');
    else done(null, out);
  },
}));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  const readFileSync = ((p: string, enc?: unknown) => (p in files ? files[p] : (actual.readFileSync as (a: string, b?: unknown) => unknown)(p, enc))) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const VM_STAT_8K = `Mach Virtual Memory Statistics: (page size of 8192 bytes)
Pages free:                                    1000.
Pages speculative:                              100.
Pages occupied by compressor:                  2000.
Swapouts:                                      3000.
`;

beforeEach(() => {
  vi.resetModules();
  for (const k of Object.keys(outputs)) delete outputs[k];
  for (const k of Object.keys(files)) delete files[k];
});

describe('the swapouts readMachine gives, in bytes', () => {
  it('B1. macOS: Swapouts at the page size vm_stat says', async () => {
    outputs.vm_stat = VM_STAT_8K;
    outputs.sysctl = 'total = 1024.00M  used = 10.00M  free = 1014.00M';
    outputs.memory_pressure = 'System-wide memory free percentage: 42%';
    const { readMachine } = await import('../../../electron/services/health/machine');
    expect((await readMachine({ platform: 'darwin' })).swapOutBytes).toBe(3000 * 8192);
  });

  it('B2. Linux: pswpout at the page size getconf says, 4 KB when it cannot be read', async () => {
    files['/proc/meminfo'] = 'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
    files['/proc/vmstat'] = 'pswpin 1\npswpout 3000\n';
    outputs.getconf = '65536\n';
    let { readMachine } = await import('../../../electron/services/health/machine');
    expect((await readMachine({ platform: 'linux' })).swapOutBytes).toBe(3000 * 65536);
    vi.resetModules();
    delete outputs.getconf;
    ({ readMachine } = await import('../../../electron/services/health/machine'));
    expect((await readMachine({ platform: 'linux' })).swapOutBytes).toBe(3000 * 4096);
  });
});
