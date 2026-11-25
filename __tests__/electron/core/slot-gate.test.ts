import '../../setup/home-guard';
import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Every start of a chat's runner takes a slot first, whoever starts it
 * (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2; the Audit's M5; PR D of 2.0.0): the
 * gate in electron/core/agent-launch.ts, which services/chat-runners.ts sets
 * and launchAgent and spawnAgentSession consult. Written with its code, and
 * shown to bite by mutants.
 *
 * How it fails:
 * 1. A start the gate refuses is launched anyway, or refused without why.
 * 2. A slot taken for a start is never given back, or given back before the
 *    launch is done.
 * 3. With no gate set (no chats), a start is held up.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { launchAgent, registerAgentLauncher, setSlotGate } from '../../../electron/core/agent-launch';

afterEach(() => setSlotGate(undefined));

describe('the slot gate', () => {
  it('1. a start it refuses is never launched, and says why', async () => {
    const launcher = vi.fn(async () => ({ success: true as const }));
    registerAgentLauncher(launcher);
    setSlotGate(async () => ({ ok: false, error: '2 chats are already working' }));
    expect(await launchAgent('runner', 'hello')).toEqual({ success: false, error: '2 chats are already working' });
    expect(launcher).not.toHaveBeenCalled();
  });

  it('2. a slot taken is given back once the launch is done, and only then', async () => {
    const order: string[] = [];
    registerAgentLauncher(async () => { order.push('launched'); return { success: true }; });
    setSlotGate(async (id) => { order.push(`taken ${id}`); return { ok: true, release: () => { order.push('released'); } }; });
    expect(await launchAgent('runner', 'hello')).toEqual({ success: true });
    expect(order).toEqual(['taken runner', 'launched', 'released']);
  });

  it('2. a launch that throws gives its slot back too', async () => {
    const released = vi.fn();
    registerAgentLauncher(async () => { throw new Error('PTY not found'); });
    setSlotGate(async () => ({ ok: true, release: released }));
    await expect(launchAgent('runner', 'hello')).rejects.toThrow('PTY not found');
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('3. with no gate, a start goes straight to the launcher', async () => {
    const launcher = vi.fn(async () => ({ success: true as const }));
    registerAgentLauncher(launcher);
    expect(await launchAgent('worker', 'hello')).toEqual({ success: true });
    expect(launcher).toHaveBeenCalledWith('worker', 'hello', undefined);
  });
});
