import { agents } from '../../core/agent-manager';
import { ptyProcesses } from '../../core/pty-manager';
import { hasOrchestratorPowers } from '../../core/agent-role';
import { oneLine } from '../../utils/waiting-on';
import { SLOT_PRIORITIES, type SlotPriority } from '../heavy-slot';
import { askSlot, giveSlotBack, slotStatus, slotTicketOf } from '../heavy-slot-runtime';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * The heavy-run slot over the local API (services/heavy-slot.ts): what the orchestrator MCP server's heavy_slot_*
 * tools and the `tars-slot` command line call. Authenticated like every route under /api/ (api-server.ts): an ask, a
 * ticket and a give-back take an agent's own token, which names the agent; the status any authenticated caller.
 *
 * POST /api/heavy-slot/ask { pid, priority?, label?, untilTurnEnds? }: the lease is held by `pid`, which must be
 * under the asking agent's terminal where the process table can be read; `gate` is an orchestrator's only. A lease
 * the MCP tool takes (`untilTurnEnds`, held by the agent's CLI), and one on the terminal itself, go back when the
 * agent's turn ends.
 * GET  /api/heavy-slot/tickets/:id: the asking agent's own ticket, granted or waiting (position, why, alerts).
 * POST /api/heavy-slot/tickets/:id/give-back
 * GET  /api/heavy-slot: who holds the slot and who waits.
 */

const LABEL_MAX = 120;

function callerAgent(req: RouteRequest, sendJson: SendJson) {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'The heavy-run slot is held by an agent: it takes an agent\'s own token (CLAUDE_MGR_API_TOKEN, in its terminal\'s environment).' }, 403);
    return undefined;
  }
  return agent;
}

export function registerHeavySlotRoutes(app: RouteApp): void {
  app.post('/api/heavy-slot/ask', async (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const { pid, priority, label, untilTurnEnds } = req.body as { pid?: unknown; priority?: unknown; label?: unknown; untilTurnEnds?: unknown };
    if (!Number.isInteger(pid) || (pid as number) <= 1) {
      sendJson({ error: 'pid is the process that holds the lease: your run\'s own, or your CLI\'s.' }, 400);
      return;
    }
    if (priority !== undefined && !(SLOT_PRIORITIES as readonly unknown[]).includes(priority)) {
      sendJson({ error: `priority is one of ${SLOT_PRIORITIES.join(', ')}.` }, 400);
      return;
    }
    const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
    try {
      const ticket = await askSlot({
        agentId: agent.id, agentName: agent.name || agent.id, projectPath: agent.projectPath,
        pid: pid as number, priority: (priority as SlotPriority | undefined) ?? 'normal',
        label: (typeof label === 'string' ? oneLine(label) : '').slice(0, LABEL_MAX) || 'a heavy run',
        // A release gate is a power: the orchestrator's, and a chat's runner's (core/agent-role.ts).
        orchestrator: hasOrchestratorPowers(agent), terminalPid: terminal?.pid,
        // The terminal lives as long as the agent's session: a lease on it is held for the turn, as the tool's is.
        untilTurnEnds: untilTurnEnds === true || (terminal !== undefined && pid === terminal.pid),
      });
      sendJson({ success: true, ticket });
    } catch (err) {
      sendJson({ error: err instanceof Error ? err.message : String(err) }, 403);
    }
  });

  app.get(/^\/api\/heavy-slot\/tickets\/([0-9a-f]+)$/, (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    const ticket = slotTicketOf(req.params.id, agent.id);
    if (ticket) sendJson({ success: true, ticket });
    else sendJson({ error: 'No such ticket of yours: given back, or its process ended.', code: 'gone' }, 404);
  });

  app.post(/^\/api\/heavy-slot\/tickets\/([0-9a-f]+)\/give-back$/, (req, sendJson) => {
    const agent = callerAgent(req, sendJson);
    if (!agent) return;
    if (giveSlotBack(req.params.id, agent.id)) sendJson({ success: true });
    else sendJson({ error: 'No such ticket of yours: given back already, or its process ended.', code: 'gone' }, 404);
  });

  app.get('/api/heavy-slot', async (_req, sendJson) => {
    sendJson({ success: true, ...(await slotStatus()) });
  });
}
