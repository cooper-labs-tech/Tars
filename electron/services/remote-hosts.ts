import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { parseRemoteHost, type RemoteHost, type RemoteHostParse } from '../core/remote-launch';

/**
 * The owner's remote hosts (2.0.7, item 14; reports/remote-agents/PLAN.md): where agents may run their CLI over ssh.
 * Each is an alias of the owner's ssh config and a work root on the host, never a credential (core/remote-launch.ts).
 *
 * In ~/.tars-private (0600), set by the window only (handlers/remote-hosts-handlers.ts): a host is where an agent's
 * code and context go, so no agent adds one; in ~/.tars any agent could point the fleet at a machine of its choosing.
 */

export const REMOTE_HOSTS_FILE = () => privatePath('remote-hosts.json');
const VERSION = 1;

function read(file: string): RemoteHost[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; hosts?: unknown };
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.hosts)) throw new Error('not a version 1 file');
    const hosts: RemoteHost[] = [];
    for (const entry of parsed.hosts) {
      const host = parseRemoteHost(entry);
      if (host.ok) hosts.push(host.host);
      else console.warn(`[remote-hosts] an entry of ${file} was left out: ${host.error}`);
    }
    return hosts;
  } catch (err) {
    console.warn(`[remote-hosts] ${file} is not a file Tars can read (${err instanceof Error ? err.message : err}): no host read from it`);
    return [];
  }
}

export function createRemoteHosts(file: string = REMOTE_HOSTS_FILE()) {
  let hosts = read(file);
  const listeners = new Set<() => void>();
  const save = () => {
    writeSecretFileSync(file, `${JSON.stringify({ version: VERSION, hosts }, null, 2)}\n`);
    for (const l of listeners) {
      try { l(); } catch (err) { console.warn('[remote-hosts] a listener failed:', err); }
    }
  };
  return {
    list(): RemoteHost[] {
      return hosts.map((h) => ({ ...h }));
    },
    get(id: string): RemoteHost | undefined {
      const h = hosts.find((x) => x.id === id);
      return h ? { ...h } : undefined;
    },
    /** Added, or replaced by its id; nothing is written when it does not parse. */
    set(raw: unknown): RemoteHostParse {
      const parsed = parseRemoteHost(raw);
      if (!parsed.ok) return parsed;
      hosts = [...hosts.filter((h) => h.id !== parsed.host.id), parsed.host];
      save();
      return parsed;
    },
    remove(id: string): boolean {
      if (!hosts.some((h) => h.id === id)) return false;
      hosts = hosts.filter((h) => h.id !== id);
      save();
      return true;
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type RemoteHosts = ReturnType<typeof createRemoteHosts>;

let current: RemoteHosts | undefined;
/** The one for the process: made at the first call, from ~/.tars-private. */
export function remoteHosts(): RemoteHosts {
  current ??= createRemoteHosts();
  return current;
}
