import { describe, it, expect } from 'vitest';
import { processesNow } from '../../../electron/services/janitor-processes';

/**
 * The processes the disk janitor checks a folder against (L2 of the Audit's re-check of #542): every process's command
 * line, and the paths it is in, each resolved once.
 *
 * How it fails, written before the code (28/10):
 * P1. An ordinary ps and lsof are misread: a process's command line, its working folder or its executable is lost.
 * P2. A failed lsof with some output, or a failed ps, is read as the whole table: a process the janitor cannot see
 *     would let its folder go (the Audit's Info 2). Null, and nothing that needs "nothing runs in it" is proposed.
 * P3. Windows, where neither tool is, reads as "no process at all": null.
 * P4. A path is resolved again and again: each distinct path once (and a link is read to where it leads).
 */

type Run = (file: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
const PS = '  101 node /h/.npm/_npx/abc/node_modules/.bin/sentry-mcp\n  202 /bin/zsh -l\n';
const LSOF = 'p101\nfcwd\nn/w/proj\nftxt\nn/usr/local/bin/node\np202\nfcwd\nn/w/proj\n';
const runner = (ps: { ok: boolean; stdout: string }, lsof: { ok: boolean; stdout: string }): Run =>
  async (file) => (file === 'ps' ? ps : lsof);

describe('the processes the janitor checks against', () => {
  it('P1, P4. command lines and paths read, each distinct path resolved once', async () => {
    const resolved: string[] = [];
    const got = await processesNow({ run: runner({ ok: true, stdout: PS }, { ok: true, stdout: LSOF }), platform: 'darwin', realpath: async (p) => { resolved.push(p); return p === '/w/proj' ? '/Volumes/w/proj' : p; } });
    expect(got).toEqual([
      { pid: 101, command: 'node /h/.npm/_npx/abc/node_modules/.bin/sentry-mcp', paths: ['/Volumes/w/proj', '/usr/local/bin/node'] },
      { pid: 202, command: '/bin/zsh -l', paths: ['/Volumes/w/proj'] },
    ]);
    expect(resolved.sort()).toEqual(['/usr/local/bin/node', '/w/proj']);
  });

  it('P2. a failed lsof, even with some output, or a failed ps, is unreadable', async () => {
    expect(await processesNow({ run: runner({ ok: true, stdout: PS }, { ok: false, stdout: 'p101\nfcwd\nn/w/proj\n' }), platform: 'darwin', realpath: async p => p })).toBeNull();
    expect(await processesNow({ run: runner({ ok: false, stdout: '' }, { ok: true, stdout: LSOF }), platform: 'darwin', realpath: async p => p })).toBeNull();
  });

  it('P3. Windows reads as unreadable, never as no process', async () => {
    expect(await processesNow({ run: runner({ ok: true, stdout: PS }, { ok: true, stdout: LSOF }), platform: 'win32', realpath: async p => p })).toBeNull();
  });

  it('P1. Linux: /proc\'s cwd, exe and open files', async () => {
    const links: Record<string, string> = { '/proc/101/cwd': '/w/proj', '/proc/101/exe': '/usr/bin/node', '/proc/101/fd/3': '/h/.npm/_npx/abc/x.js' };
    const got = await processesNow({
      run: runner({ ok: true, stdout: '  101 node x\n' }, { ok: false, stdout: '' }), platform: 'linux', realpath: async p => p,
      proc: { readlink: (p) => { if (!(p in links)) throw new Error('gone'); return links[p]; }, readdir: (p) => (p === '/proc/101/fd' ? ['3'] : []) },
    });
    expect(got).toEqual([{ pid: 101, command: 'node x', paths: ['/w/proj', '/usr/bin/node', '/h/.npm/_npx/abc/x.js'] }]);
  });
});
