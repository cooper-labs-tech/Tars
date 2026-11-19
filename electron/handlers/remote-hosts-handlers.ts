import { ipcMain } from 'electron';
import { remoteHosts, hostRemovalRefusal } from '../services/remote-hosts';
import { agents } from '../core/agent-manager';
import { broadcastToAllWindows } from '../utils/broadcast';

/**
 * The window's hold on the owner's remote hosts (2.0.7, item 14; services/remote-hosts.ts). Only the window sets them:
 * no route of the API does, since a host is where an agent's code and context go.
 *
 * remoteHosts:list                 -> RemoteHost[]
 * remoteHosts:set(host)            -> { success: true, host } | { success: false, error, code }
 * remoteHosts:remove(id)           -> { success: boolean } | { success: false, error, code: 'host_in_use' }
 * remoteHosts:changed (pushed)     -> RemoteHost[]
 */
export function registerRemoteHostsHandlers(): void {
  const store = remoteHosts();
  store.onChange(() => broadcastToAllWindows('remoteHosts:changed', store.list()));
  ipcMain.handle('remoteHosts:list', () => store.list());
  ipcMain.handle('remoteHosts:set', (_e, host: unknown) => {
    const r = store.set(host);
    return r.ok ? { success: true, host: r.host } : { success: false, error: r.error, code: r.code };
  });
  ipcMain.handle('remoteHosts:remove', (_e, id: unknown) => {
    if (typeof id !== 'string') return { success: false };
    // Never while agents are placed there (the Audit's M1 on #600): their sessions would be out of every stop's reach.
    const refusal = hostRemovalRefusal(id, agents.values());
    if (refusal) return { success: false, error: refusal, code: 'host_in_use' };
    return { success: store.remove(id) };
  });
}
