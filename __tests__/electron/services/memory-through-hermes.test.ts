import { describe, it, expect, vi } from 'vitest';
import { resolvedMemorySettings } from '../../../electron/services/memory-through-hermes';
import type { AppSettings } from '../../../electron/types';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * A direct backend (gbrain, Honcho) filled with the server Hermes registered: saved as Hermes's own URL, "reached
 * through Hermes", never as a port on this Mac (the Settings > Memory Backends notes of #457). Each time Tars writes
 * the agents' MCP config or calls the backend itself, it is given the address of the moment: through the tunnel or
 * Tailscale (services/hermes-mcp-reach.ts). That is how Hermes's MCP reaches the agents, whose CLIs read the address
 * Tars writes, without "the gateway's own loopback address".
 *
 * How it fails, written before the code:
 * 1. A backend not reached through Hermes is resolved anyway, or its URL changed.
 * 2. One reached through Hermes keeps Hermes's loopback URL, which no CLI on this Mac can reach; or loses its token or
 *    its workspace header on the way.
 * 3. One that cannot be reached this session is written anyway, so every agent's CLI fails on it: it is left out for
 *    the session, and why is kept for Brain.
 * 4. The saved settings are changed: the tunnel's port lands in app-settings.json, where the next session finds a
 *    port that is gone.
 * 5. Hermes on this Mac: its loopback is this Mac's, used as it is.
 */

const ssh: HermesConnection = { mode: 'ssh', ssh: { host: 'hermes', user: 'jb' } };
const saved = (): AppSettings => ({
  memoryGbrainEnabled: true, memoryGbrainMcpUrl: 'http://localhost:8484/mcp', memoryGbrainAuthToken: 'gb-token', memoryGbrainViaHermes: true,
  memoryHonchoEnabled: true, memoryHonchoMcpUrl: 'https://honcho.example/mcp', memoryHonchoApiKey: 'ho-key', memoryHonchoWorkspaceId: 'ws',
} as AppSettings);

describe('a backend reached through Hermes', () => {
  it('1 and 2. resolved to the address of the moment, its token kept; the other left as it is', async () => {
    const reach = vi.fn(async () => ({ via: 'tunnel' as const, address: 'http://127.0.0.1:62011/mcp' }));
    const { settings, unreached } = await resolvedMemorySettings(saved(), { connection: () => ssh, reach });

    expect(settings).toMatchObject({ memoryGbrainEnabled: true, memoryGbrainMcpUrl: 'http://127.0.0.1:62011/mcp', memoryGbrainAuthToken: 'gb-token' });
    expect(settings).toMatchObject({ memoryHonchoMcpUrl: 'https://honcho.example/mcp', memoryHonchoApiKey: 'ho-key', memoryHonchoWorkspaceId: 'ws' });
    expect(reach).toHaveBeenCalledTimes(1);
    expect(reach).toHaveBeenCalledWith(ssh, { url: 'http://localhost:8484/mcp', gatewayLocal: true });
    expect(unreached).toEqual({});
  });

  it('3. one that cannot be reached is left out for the session, and why is kept', async () => {
    const reach = vi.fn(async () => ({ via: 'none' as const, why: 'Neither path works.', answers: {} }));
    const { settings, unreached } = await resolvedMemorySettings(saved(), { connection: () => ssh, reach });

    expect(settings.memoryGbrainEnabled).toBe(false);
    expect(unreached).toEqual({ gbrain: 'Neither path works.' });
  });

  it('3. no Hermes connection saved: left out, and why', async () => {
    const { settings, unreached } = await resolvedMemorySettings(saved(), { connection: () => null, reach: vi.fn() });
    expect(settings.memoryGbrainEnabled).toBe(false);
    expect(unreached.gbrain).toMatch(/Hermes/);
  });

  it('4. the saved settings are never changed', async () => {
    const before = saved();
    const copy = JSON.parse(JSON.stringify(before));
    await resolvedMemorySettings(before, { connection: () => ssh, reach: vi.fn(async () => ({ via: 'tunnel' as const, address: 'http://127.0.0.1:1/mcp' })) });
    expect(before).toEqual(copy);
  });

  it('5. Hermes on this Mac: its loopback used as it is', async () => {
    const reach = vi.fn(async () => ({ via: 'direct' as const, address: 'http://localhost:8484/mcp' }));
    const { settings } = await resolvedMemorySettings(saved(), { connection: () => ({ mode: 'local', localPort: 9119 }), reach });
    expect(settings.memoryGbrainMcpUrl).toBe('http://localhost:8484/mcp');
  });
});
