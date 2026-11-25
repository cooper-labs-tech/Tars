import { agents } from '../../core/agent-manager';
import { janitorReportFor, janitorRequest, janitorScanFor } from '../disk-janitor';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * The disk janitor for agents (services/janitor-rules.ts), each with its own token, for its own project:
 * - GET /api/janitor/scan?wait=<s> (disk_scan): what the janitor proposes in the caller's project. Answered when the
 *   scan ends, or after `wait` seconds (20 when not given, 110 at most) with `running: true` and what the last ended
 *   scan found: under load the whole scan outlasted the 30 s an MCP call waits (an orchestrator's report of 19/11).
 * - POST /api/janitor/request { ids, why } (disk_cleanup_request): asks the owner for a cleanup of those items, which
 *   the window shows; nothing goes until the owner approves it, in one click.
 * - GET /api/disk/report?wait=<s> (disk_report): what agents leave behind in the caller's project, per worktree and
 *   per agent, with the machine's free disk and swap; made after each scan, every 6 hours at least.
 * No route takes an approval, which is the owner's, in the window.
 */
const WAIT_DEFAULT_S = 20;
const WAIT_MAX_S = 110;

function askerOf(req: RouteRequest, sendJson: SendJson): { id: string; name: string; project: string } | undefined {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'The disk janitor is asked by an agent: with its own token (CLAUDE_MGR_API_TOKEN).' }, 403);
    return undefined;
  }
  return { id: agent.id, name: agent.name || agent.id, project: agent.projectPath };
}

function waitOf(req: RouteRequest): number {
  const raw = req.url.searchParams.get('wait');
  const asked = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return (Number.isFinite(asked) && asked >= 0 ? Math.min(asked, WAIT_MAX_S) : WAIT_DEFAULT_S) * 1000;
}

export function registerJanitorRoutes(app: RouteApp): void {
  app.get('/api/janitor/scan', async (req, sendJson) => {
    const asker = askerOf(req, sendJson);
    if (!asker) return;
    // Its own project's items, once in five minutes; the window sees the whole scan and who asked (janitor-state.ts).
    const answer = await janitorScanFor(asker, waitOf(req));
    sendJson({
      success: true, running: answer.running, ...(answer.progress ? { progress: answer.progress } : {}),
      items: answer.items, scannedAt: answer.at, approvedBy: 'the owner, in the window',
    });
  });

  app.post('/api/janitor/request', (req, sendJson) => {
    const asker = askerOf(req, sendJson);
    if (!asker) return;
    const { ids, why } = (req.body ?? {}) as { ids?: unknown; why?: unknown };
    const answer = janitorRequest(asker, ids, why);
    if (!answer.ok) {
      sendJson({ error: answer.error }, answer.status);
      return;
    }
    sendJson({ success: true, requested: answer.id, items: answer.items, bytes: answer.bytes, approvedBy: 'the owner, in the window, in one click' });
  });

  app.get('/api/disk/report', async (req, sendJson) => {
    const asker = askerOf(req, sendJson);
    if (!asker) return;
    let report = janitorReportFor(asker.project);
    // None yet (no scan since Tars started): one is started and waited for, as a scan is.
    if (!report) {
      const answer = await janitorScanFor(asker, waitOf(req));
      report = janitorReportFor(asker.project);
      if (!report) {
        sendJson({ success: true, running: answer.running, report: null });
        return;
      }
    }
    sendJson({ success: true, running: false, report });
  });
}
