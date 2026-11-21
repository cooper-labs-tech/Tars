import { ipcMain } from 'electron';
import { noticeLog } from '../services/agent-notice-log';

/**
 * The window's hold on Tars's notices about its agents (2.0.7, services/agent-notice-log.ts). Pushed as they are
 * written, agent:notice (the notice); and agent:notice-seen ({ agentId, ids, seenAt }) when a window marks some seen.
 *
 * agent:notices(agentId?)              -> AgentNotice[], newest first: that agent's, or every agent's
 * agent:notices-seen(agentId, ids?)    -> void: those ids of that agent's, or all its notices not seen yet
 */
export function registerAgentNoticeHandlers(): void {
  ipcMain.handle('agent:notices', (_e, agentId?: unknown) => noticeLog().list(typeof agentId === 'string' ? agentId : undefined));
  ipcMain.handle('agent:notices-seen', (_e, agentId: unknown, ids?: unknown) => {
    if (typeof agentId !== 'string') return;
    noticeLog().markSeen(agentId, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined);
  });
}
