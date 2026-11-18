import { ipcMain } from 'electron';
import { remoteHosts } from '../services/remote-hosts';
import { broadcastToAllWindows } from '../utils/broadcast';

/**
 * The window's hold on the owner's remote hosts (2.0.7, item 14; services/remote-hosts.ts). Only the window sets them:
 * no route of the API does, since a host is where an agent's code and context go.
 *
 * remoteHosts:list                 -> RemoteHost[]
 * remoteHosts:set(host)            -> { success: true, host } | { success: false, error, code }
 * remoteHosts:remove(id)           -> { success: boolean }
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
  ipcMain.handle('remoteHosts:remove', (_e, id: unknown) => ({ success: typeof id === 'string' && store.remove(id) }));
}
