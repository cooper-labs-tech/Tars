import './home-guard';
import { describe, it, expect } from 'vitest';
import * as pty from 'node-pty';

/**
 * A terminal spawned in-process still works under home-isolation.ts's guard.
 *
 * Found on 2026-09-25: node-pty on Windows opens the ConPTY
 * input pipe with fs.openSync(conin, 'w'), which the guard wraps. The guard
 * resolved the target with realpathSync.native first, and resolving a named
 * pipe (\\.\pipe\...) opens it, taking its only connection: node-pty's own
 * open then failed with EBUSY, in every test that spawns a pty under the
 * guard. A pipe is not a file under any home, and is not resolved.
 *
 * Not mocked, unlike the other files here: the real node-pty, the real guard.
 */

const command: [string, string[]] = process.platform === 'win32'
  ? ['cmd.exe', ['/c', 'echo ok']]
  : ['/bin/sh', ['-c', 'echo ok']];

describe('a pty spawned in-process under the home guard', () => {
  it('starts, and its output comes back', async () => {
    const guard = (globalThis as Record<symbol, { violations: unknown[] } | undefined>)[Symbol.for('tars.test.homeGuard')];
    expect(guard, 'home-isolation.ts is not among the setup files').toBeDefined();

    const [file, args] = command;
    const term = pty.spawn(file, args, { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    const out = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`no exit within 10s; output so far: ${JSON.stringify(text)}`)), 10_000);
      term.onData(data => { text += data; });
      term.onExit(() => {
        clearTimeout(timer);
        resolve(text);
      });
    });

    expect(out).toContain('ok');
    expect(guard!.violations).toEqual([]);
  }, 20_000);
});
