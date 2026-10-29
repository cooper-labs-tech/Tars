import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A seam for E2E specs of the no-terminal path (2.0.6; the QA's finding on #555, 29/10: agent-no-terminal seeded an
 * agent in 'error', and main's boot load turns every agent that is neither stopped nor asleep to idle, so the state
 * must come from main at run time, through the real start path). DOROTHY_E2E_PTY_MAX, read under DOROTHY_E2E only and
 * never by a packaged build, makes the pool Tars's own open terminals out of that many: deterministic on a machine
 * whose other programs move the real count, and the same on macOS, Linux and Windows. Once it is full, spawnPty
 * refuses as a full machine does, NoTerminalLeft, before node-pty is asked.
 *
 * How it fails, written before the code (29/10):
 * E1. It is read where it must not be: without DOROTHY_E2E, by a packaged build, or from a value that is not a whole
 *     count of at least 1 (0, negative, a fraction, a word, empty).
 * E2. The pool under the seam is the machine's, which other programs move, instead of Tars's own open terminals out
 *     of the seam's limit; or it is none on Windows, where a spec must run too.
 * E3. A start once the seam's pool is full asks node-pty anyway (and succeeds, so no no-terminal path is reached), or
 *     refuses with other words than a full machine's; a terminal that ended does not give its place back.
 * E4. Without the seam anything changes: the pool is the machine's, read as before.
 */

const spawned: Array<{ exit: () => void }> = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let onExit: (() => void) | undefined;
    const term = { pid: 1, onExit: (cb: () => void) => { onExit = cb; }, kill: () => onExit?.(), write: vi.fn(), resize: vi.fn(), onData: vi.fn() };
    spawned.push({ exit: () => onExit?.() });
    return term;
  }),
}));
const machine = { inUse: 51, max: 511, tars: 0 };
vi.mock('../../../electron/core/pty-pool', async (orig) => ({ ...(await orig<object>()), readPtyPool: () => ({ ...machine }) }));

beforeEach(async () => {
  spawned.length = 0;
  vi.mocked((await import('node-pty')).spawn).mockClear();
});
afterEach(async () => {
  const { useTestPtyMax } = await import('../../../electron/core/pty-spawn');
  useTestPtyMax(null);
  for (const t of spawned) t.exit();
});

describe('the no-terminal seam for E2E specs', () => {
  it('E1. read under DOROTHY_E2E only, never by a packaged build, and only as a whole count', async () => {
    const { ptyTestMax } = await import('../../../electron/core/pty-pool');
    expect(ptyTestMax({ DOROTHY_E2E: '1', DOROTHY_E2E_PTY_MAX: '3' }, false)).toBe(3);
    expect(ptyTestMax({ DOROTHY_E2E: '1', DOROTHY_E2E_PTY_MAX: '3' }, true)).toBeNull();
    expect(ptyTestMax({ DOROTHY_E2E_PTY_MAX: '3' }, false)).toBeNull();
    for (const bad of ['0', '-2', '2.5', 'x', '', ' 3']) expect(ptyTestMax({ DOROTHY_E2E: '1', DOROTHY_E2E_PTY_MAX: bad }, false)).toBeNull();
  });

  it('E2. the pool is Tars\'s own open terminals out of the seam\'s limit, on every platform', async () => {
    const { spawnPty, useTestPtyMax, readTerminals } = await import('../../../electron/core/pty-spawn');
    useTestPtyMax(4);
    expect(readTerminals()).toEqual({ inUse: 0, max: 4, tars: 0, open: 0 });
    spawnPty('/bin/sh', [], {});
    expect(readTerminals()).toEqual({ inUse: 1, max: 4, tars: 1, open: 1 });
  });

  it('E3. once full, a start is refused as on a full machine, node-pty not asked; an ended terminal frees its place', async () => {
    const pty = await import('node-pty');
    const { spawnPty, useTestPtyMax } = await import('../../../electron/core/pty-spawn');
    const { NoTerminalLeft } = await import('../../../electron/core/pty-pool');
    useTestPtyMax(3);
    let started = 0;
    let refused: unknown;
    for (let i = 0; i < 5 && !refused; i++) {
      try { spawnPty('/bin/sh', [], {}); started++; } catch (err) { refused = err; }
    }
    // A start opens two PTYs on macOS (node-pty's spare master, then the terminal's), one elsewhere.
    expect(started).toBe(process.platform === 'darwin' ? 2 : 3);
    expect(refused).toBeInstanceOf(NoTerminalLeft);
    expect((refused as Error).message).toMatch(/^No terminal can be opened on this machine: \d of 3 are in use, \d of them held by Tars for its \d open terminals\./);
    expect(vi.mocked(pty.spawn)).toHaveBeenCalledTimes(started);
    spawned[0].exit();
    expect(() => spawnPty('/bin/sh', [], {})).not.toThrow();
  });

  it('E4. without the seam, the pool is the machine\'s, as before', async () => {
    const { spawnPty, useTestPtyMax, readTerminals } = await import('../../../electron/core/pty-spawn');
    useTestPtyMax(null);
    expect(readTerminals()).toMatchObject({ inUse: 51, max: 511 });
    for (let i = 0; i < 5; i++) spawnPty('/bin/sh', [], {});
    expect(spawned).toHaveLength(5);
  });
});
