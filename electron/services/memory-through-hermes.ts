import type { HermesConnection } from '../types/hermes';
import { reachOf, type Reach } from './hermes-mcp-reach';
import type { MemorySettings } from './memory-hub';

/**
 * A direct backend (gbrain, Honcho) filled with the server Hermes registered is saved as Hermes's own URL and
 * "reached through Hermes" (the Settings > Memory Backends notes of #457), never as a port on this Mac: the tunnel's
 * port changes from one session to the next. Whoever uses it (the agents' MCP config, which their CLIs read; the
 * memory hub, which Brain and tars-memory call) is handed the address of the moment, through the tunnel or Tailscale.
 * One that cannot be reached is left out for the session, and why is kept for Brain. The saved settings never change.
 */

export type Backend = 'gbrain' | 'honcho';

export interface ThroughHermesDeps {
  connection: () => HermesConnection | null | Promise<HermesConnection | null>;
  reach: (conn: HermesConnection, server: { url: string; gatewayLocal: boolean }) => Promise<Reach>;
}

const realDeps: ThroughHermesDeps = {
  // Loaded when a backend is reached through Hermes, and only then: the memory hub loads this module, and the
  // Hermes connection's module brings Tars's private paths with it.
  connection: async () => {
    const { configuredHermesConnection } = await import('./hermes-config');
    const configured = configuredHermesConnection();
    return configured && 'conn' in configured ? configured.conn : null;
  },
  reach: (conn, server) => reachOf(conn, server),
};

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

export interface MemorySettingsThroughHermes extends MemorySettings {
  /** gbrain is Hermes's server, saved as Hermes's URL: reached through the SSH tunnel or Tailscale. */
  memoryGbrainViaHermes?: boolean;
  /** The same for Honcho. */
  memoryHonchoViaHermes?: boolean;
}

export async function resolvedMemorySettings<T extends MemorySettingsThroughHermes>(saved: T, deps: ThroughHermesDeps = realDeps): Promise<{
  settings: T;
  unreached: Partial<Record<Backend, string>>;
  reached: Partial<Record<Backend, { via: 'direct' | 'tunnel' | 'tailscale'; address: string }>>;
}> {
  const settings: T = { ...saved };
  const unreached: Partial<Record<Backend, string>> = {};
  const reached: Partial<Record<Backend, { via: 'direct' | 'tunnel' | 'tailscale'; address: string }>> = {};
  const one = async (name: Backend, enabled: boolean | undefined, via: boolean | undefined, url: string | undefined): Promise<string | false | null> => {
    const address = url?.trim();
    if (!enabled || !via || !address) return null;
    const conn = await deps.connection();
    if (!conn) {
      unreached[name] = 'No Hermes connection is saved (Settings, Hermes, Connection): a backend reached through Hermes is left out.';
      return false;
    }
    const reach = await deps.reach(conn, { url: address, gatewayLocal: LOOPBACK.test(address) });
    if (reach.via === 'none') {
      unreached[name] = reach.why;
      return false;
    }
    reached[name] = { via: reach.via, address: reach.address };
    return reach.address;
  };
  const gbrain = await one('gbrain', saved.memoryGbrainEnabled, saved.memoryGbrainViaHermes, saved.memoryGbrainMcpUrl);
  if (gbrain === false) settings.memoryGbrainEnabled = false;
  else if (gbrain) settings.memoryGbrainMcpUrl = gbrain;
  const honcho = await one('honcho', saved.memoryHonchoEnabled, saved.memoryHonchoViaHermes, saved.memoryHonchoMcpUrl);
  if (honcho === false) settings.memoryHonchoEnabled = false;
  else if (honcho) settings.memoryHonchoMcpUrl = honcho;
  return { settings, unreached, reached };
}
