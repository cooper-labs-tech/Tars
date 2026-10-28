import { agents } from '../../core/agent-manager';
import { janitorScan } from '../disk-janitor';
import type { RouteApp } from './types';

/**
 * GET /api/janitor/scan: what the disk janitor would propose now (services/janitor-rules.ts), for an agent that asks
 * (disk_scan, mcp-orchestrator). Read only: no route takes an approval, which is the owner's, in the window.
 */
export function registerJanitorRoutes(app: RouteApp): void {
  app.get('/api/janitor/scan', async (req, sendJson) => {
    if (!req.callerAgentId || !agents.get(req.callerAgentId)) {
      sendJson({ error: 'A scan is asked for by an agent: with its own token (CLAUDE_MGR_API_TOKEN).' }, 403);
      return;
    }
    const agent = agents.get(req.callerAgentId)!;
    // Its own project's items, once in five minutes; the window sees the whole scan and who asked (janitor-state.ts).
    sendJson({ success: true, items: await janitorScan({ name: agent.name || agent.id, project: agent.projectPath }), approvedBy: 'the owner, in the window' });
  });
}
