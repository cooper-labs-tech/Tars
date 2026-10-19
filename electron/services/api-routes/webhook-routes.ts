import { agents } from '../../core/agent-manager';
import { isPermissionLevel, levelOf, raises } from '../../core/permission-ceiling';
import { samePath } from '../../platform/path-compare';
import type { AgentStatus } from '../../types';
import { DEFAULT_GATEWAY, gatewayById, gatewayReaches } from '../hermes-gateways';
import { performDispatch } from './agent-routes';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';

const HERMES_ONLY =
  'This route is Hermes\'s, and only the webhook secret Settings hands Hermes opens it. '
  + 'An agent gives another work through /api/agents/:id/dispatch.';
const OTHER_GATEWAY =
  'This secret is not this route\'s: each Hermes gateway posts to its own route, with its own secret, '
  + 'both shown in Tars, Settings, Hermes.';
const NOT_FOUND =
  'No agent by that id or name among the projects this gateway may reach. '
  + 'Which projects each gateway reaches is set in Tars, Settings, Hermes.';
const AMBIGUOUS = 'More than one agent this gateway reaches goes by that name: pass agent_id, or project_path.';
const MODE_INVALID = 'permission_mode is one of plan, normal, auto, bypass.';
const MODE_WIDER =
  'A gateway\'s message may keep an agent\'s mode, or lower it for the session it starts, never raise it.';

/**
 * Incoming webhooks: an external scheduler, the user's Hermes, gives Tars agents work. Tars deliberately has no
 * scheduler of its own: Hermes cron jobs and automation blueprints call this endpoint instead.
 *
 * Each Hermes gateway has its own route and its own secret (services/hermes-gateways.ts): the default one,
 * `/api/webhooks/hermes`, with `~/.tars-private/hermes-webhook-secret`, the one Hermes had before 2.0.4; another,
 * `/api/webhooks/hermes/<id>`, with its own. The door names the gateway a secret is (api-server.ts, resolveCaller),
 * and nothing else opens these routes: not the shared token, which every agent reads; not an agent's own token,
 * which has /dispatch inside its own project; not another gateway's secret.
 *
 * What a gateway's message may do (the Audit's NOW-3, R4.1 and R4.2, 2.0.4): be typed into an agent's terminal as
 * a task, under "Message from Hermes", for an agent of a project the user allowed that gateway (none until they do).
 * It may keep the agent's mode or lower it for the session it starts, never raise it: until 2.0.4 a
 * `permission_mode` here won over the agent's own, and whoever held the one secret started any agent of any project
 * in bypass. A refusal names nothing: the 404 listed every agent of every project, with its status, and the 409 the
 * agents a name matched.
 *
 * Reachability from a VPS: run `tailscale serve` (Settings, Hermes, gives the line) or an equivalent tunnel, so
 * Hermes reaches the localhost-bound API.
 *
 * POST /api/webhooks/hermes[/<gateway id>]
 * Body: {
 *   agent_id?: string;        // exact agent id, or…
 *   agent_name?: string;      // …case-insensitive exact name match
 *   project_path?: string;    // narrows agent_name when the same name is in several projects
 *   message: string;          // the task
 *   model?: string;
 *   permission_mode?: 'plan' | 'normal' | 'auto' | 'bypass';  // the agent's own, or narrower
 *   dry_run?: boolean;        // validate auth + agent resolution without dispatching
 * }
 * Responds like /api/agents/:id/dispatch ({ success, mode, agent }); poll GET /api/agents/:id for status/output.
 */
export function registerWebhookRoutes(app: RouteApp, ctx: RouteContext): void {
  app.post('/api/webhooks/hermes', (req, sendJson) => fromGateway(DEFAULT_GATEWAY, req, sendJson, ctx));
  app.post(/^\/api\/webhooks\/hermes\/(gw-[0-9a-f]{6})$/, (req, sendJson) => fromGateway(req.params.id, req, sendJson, ctx));
}

async function fromGateway(routeGateway: string, req: RouteRequest, sendJson: SendJson, ctx: RouteContext): Promise<void> {
  if (!req.hermes) {
    sendJson({ error: HERMES_ONLY }, 403);
    return;
  }
  const gateway = req.hermesGateway === routeGateway ? gatewayById(routeGateway) : undefined;
  if (!gateway) {
    sendJson({ error: OTHER_GATEWAY }, 403);
    return;
  }

  const body = req.body as {
    agent_id?: unknown;
    agent_name?: unknown;
    project_path?: unknown;
    message?: unknown;
    model?: string;
    permission_mode?: unknown;
    dry_run?: boolean;
  };

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    sendJson({ error: 'message is required' }, 400);
    return;
  }
  const asked = body.permission_mode;
  if (asked !== undefined && asked !== null && !isPermissionLevel(asked)) {
    sendJson({ error: MODE_INVALID }, 400);
    return;
  }

  // What this gateway reaches, and nothing else: an agent outside it is no agent here.
  const projectPath = typeof body.project_path === 'string' && body.project_path ? body.project_path : undefined;
  if (projectPath !== undefined && !gatewayReaches(gateway, projectPath)) {
    sendJson({ error: NOT_FOUND }, 404);
    return;
  }
  const reached = Array.from(agents.values()).filter(a => gatewayReaches(gateway, a.projectPath));
  let agent: AgentStatus | undefined = typeof body.agent_id === 'string' ? reached.find(a => a.id === body.agent_id) : undefined;
  if (!agent && typeof body.agent_name === 'string' && body.agent_name.trim()) {
    const nameLc = body.agent_name.trim().toLowerCase();
    const matches = reached.filter(a => (a.name || '').toLowerCase() === nameLc && (!projectPath || samePath(a.projectPath, projectPath)));
    if (matches.length > 1) {
      sendJson({ error: AMBIGUOUS }, 409);
      return;
    }
    agent = matches[0];
  }
  if (!agent) {
    sendJson({ error: NOT_FOUND }, 404);
    return;
  }

  if (isPermissionLevel(asked) && raises(asked, levelOf(agent))) {
    sendJson({ error: MODE_WIDER }, 403);
    return;
  }

  if (body.dry_run) {
    // Config check for the Hermes side: auth passed, agent resolved among what it reaches. Nothing dispatched.
    sendJson({
      success: true,
      dry_run: true,
      agent: { id: agent.id, name: agent.name, projectPath: agent.projectPath, status: agent.status },
    });
    return;
  }

  await performDispatch(agent, {
    message,
    model: body.model,
    permissionMode: isPermissionLevel(asked) ? asked : undefined,
    from: 'Hermes',
    sender: { kind: 'channel', channel: 'Hermes' },
    // Hermes dispatches a task: it waits its turn in the agent's queue (core/one-task.ts).
    task: true,
  }, ctx, sendJson);
}
