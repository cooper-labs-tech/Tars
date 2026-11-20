import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

import { killTree, KillTreeError } from '../../../electron/platform/kill-tree';

/**
 * Ending a process and every process under it on win32.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. The kill goes through a shell string instead of taskkill's argv
 *    `/PID <pid> /T /F`.
 * 2. taskkill is looked up on the PATH (a planted taskkill.exe in an agent's
 *    project would run) instead of %SystemRoot%\System32\taskkill.exe.
 * 3. A process already gone (taskkill exit 128, whatever the language of
 *    its message) is reported as a failure: it is the outcome wanted.
 * 4. Any other failure (access denied, taskkill missing) is swallowed.
 * 5. A pid that is not a positive integer reaches taskkill.
 * 6. darwin/linux: anything runs. The callers keep their process-group
 *    kill there (acp/client.ts `process.kill(-pid)`), untouched here.
 * 7. For real: a child of the process survives.
 */

type Call = { file: string; args: string[] };
const recorder = (fail?: unknown) => {
  const calls: Call[] = [];
  return {
    calls,
    execFile: async (file: string, args: string[]) => { calls.push({ file, args }); if (fail) throw fail; },
  };
};

describe('killTree', () => {
  it('1, 2. taskkill by absolute path, argv only', async () => {
    const r = recorder();
    await expect(killTree(4242, 'win32', { execFile: r.execFile, env: { SystemRoot: 'D:\\Win' } })).resolves.toEqual({ outcome: 'killed' });
    expect(r.calls).toEqual([{ file: 'D:\\Win\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'] }]);
  });

  it('2. SystemRoot read case-insensitively, C:\\Windows when unset', async () => {
    const a = recorder();
    await killTree(7, 'win32', { execFile: a.execFile, env: { systemroot: 'E:\\W' } });
    const b = recorder();
    await killTree(7, 'win32', { execFile: b.execFile, env: {} });
    expect([a.calls[0].file, b.calls[0].file]).toEqual(['E:\\W\\System32\\taskkill.exe', 'C:\\Windows\\System32\\taskkill.exe']);
  });

  it('3. exit 128 is already-gone', async () => {
    const r = recorder(Object.assign(new Error('Command failed'), { code: 128 }));
    await expect(killTree(4242, 'win32', { execFile: r.execFile, env: {} })).resolves.toEqual({ outcome: 'already-gone' });
  });

  it.each([
    ['access denied', Object.assign(new Error('Command failed'), { code: 1 })],
    ['taskkill missing', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })],
  ])('4. %s throws a KillTreeError carrying the cause', async (_label, err) => {
    const r = recorder(err);
    const p = killTree(4242, 'win32', { execFile: r.execFile, env: {} });
    await expect(p).rejects.toBeInstanceOf(KillTreeError);
    await expect(p).rejects.toMatchObject({ code: 'taskkill-failed', cause: err });
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, '12 & calc' as unknown as number])('5. refuses pid %j', async (pid) => {
    const r = recorder();
    await expect(killTree(pid, 'win32', { execFile: r.execFile, env: {} })).rejects.toMatchObject({ code: 'invalid-pid' });
    expect(r.calls).toEqual([]);
  });

  it.each(['darwin', 'linux'] as const)('6. %s runs nothing', async (platform) => {
    const r = recorder();
    await expect(killTree(4242, platform, { execFile: r.execFile, env: {} })).resolves.toEqual({ outcome: 'not-win32' });
    expect(r.calls).toEqual([]);
  });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('killTree for real', () => {
  it.runIf(process.platform === 'win32')('7. a parent and its child both end; a second call finds them gone', async () => {
    // node -> node, the shape of npx-cli.js -> adapter -> CLI.
    const parent = spawn(process.execPath, ['-e', [
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(c.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const childPid = await new Promise<number>((resolve) => parent.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    const parentExit = new Promise((resolve) => parent.once('exit', resolve));
    expect([alive(parent.pid!), alive(childPid)]).toEqual([true, true]);

    await expect(killTree(parent.pid!, 'win32')).resolves.toEqual({ outcome: 'killed' });
    await parentExit;
    for (let i = 0; i < 50 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
    expect([alive(parent.pid!), alive(childPid)]).toEqual([false, false]);

    await expect(killTree(parent.pid!, 'win32')).resolves.toEqual({ outcome: 'already-gone' });
  }, 30_000);
});
