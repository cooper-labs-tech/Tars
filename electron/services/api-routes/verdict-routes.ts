import type { RouteApp } from './types';
import { agents } from '../../core/agent-manager';
import { parseVerdict, type RecordResult, type VerdictCaller, type VerdictInput } from '../gate-verdicts';
import { recordGateVerdict } from '../traces-runtime';

/**
 * `POST /api/verdicts`: a gate's verdict on a pull request's head, recorded as data and linked to the traced turns
 * that made it (services/gate-verdicts.ts; the MCP tool `record_verdict`).
 *
 * Who records is the agent whose own token the call carries, for its own project: the shared token, Tars's own pass
 * and a gateway's secret name no agent and are refused (403), and so is a body naming another agent (`agentId`,
 * `by`) than the token's. Any agent of a project may record `qa` or `audit`, never on its own work (403); the record
 * keeps who did, with its name and role from the fleet, never from the body. `ci` is Tars's alone (403), read from
 * the pull request's checks.
 */

export interface VerdictRouteDeps {
  callerOf(agentId: string): VerdictCaller | undefined;
  record(caller: VerdictCaller, v: VerdictInput): Promise<RecordResult>;
}

const NAMED = ['agentId', 'agent', 'by', 'recordedBy'] as const;

const defaultDeps: VerdictRouteDeps = {
  callerOf: (id) => {
    const agent = agents.get(id);
    if (!agent?.projectPath) return undefined;
    return { agentId: id, projectPath: agent.projectPath, folder: agent.worktreePath || agent.projectPath, name: agent.name, role: agent.role ?? 'worker' };
  },
  record: (caller, v) => recordGateVerdict(caller, v),
};

export function registerVerdictRoutes(app: RouteApp, deps: VerdictRouteDeps = defaultDeps): void {
  app.post('/api/verdicts', async (req, send) => {
    if (!req.callerAgentId) {
      send({ error: 'A verdict is recorded by an agent, with its own token.' }, 403);
      return;
    }
    const body = req.body ?? {};
    for (const k of NAMED) {
      if (body[k] !== undefined && body[k] !== req.callerAgentId) {
        send({ error: 'A verdict is recorded in the name of the agent whose token it carries, and no other.' }, 403);
        return;
      }
    }
    const parsed = parseVerdict(body);
    if (!parsed.ok) { send({ error: parsed.error }, 400); return; }
    if (parsed.verdict.gate === 'ci') {
      send({ error: 'CI\'s verdict is recorded by Tars alone, from the pull request\'s checks.' }, 403);
      return;
    }
    const caller = deps.callerOf(req.callerAgentId);
    if (!caller) { send({ error: 'This agent has no project to record a verdict for.' }, 403); return; }
    const result = await deps.record(caller, parsed.verdict);
    if (result.refused === 'own-work') {
      send({ error: 'A verdict on your own work: your traced turns made this head, or a commit before it on the branch.' }, 403);
      return;
    }
    send(result);
  });
}
