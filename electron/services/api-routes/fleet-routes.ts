import * as path from 'path';
import { agents } from '../../core/agent-manager';
import { parseCap } from '../../core/project-cap';
import { fleetOperations, governRight, type GovernCaller } from '../fleet-operations';
import { parseSchedule } from '../fleet-schedule';
import { callerId as resolveCallerId } from './utils';
import type { RouteApp, RouteRequest, SendJson } from './types';

/**
 * A project's hours and its cap over the local API (services/fleet-operations.ts, 2.0.7): what the orchestrator MCP
 * server's project_schedule and project_cap tools call. Authenticated like every route under /api/ (api-server.ts).
 *
 * GET  /api/fleet/projects                  every project's hours, cap and last window; any authenticated caller
 * GET  /api/fleet/project?project=<path>    one project's (omitted: the caller's own)
 * POST /api/fleet/schedule        { project?, start, stop, timeZone, onStart? }
 * POST /api/fleet/schedule/clear  { project? }
 * POST /api/fleet/cap             { project?, cap }   cap: 1 to 64, or null to remove it
 *
 * The three that change something take an identity with the right (governRight): Tars's own pass, or the project's own
 * orchestrator by its own token. The shared token names nobody and is refused; allowCrossProject is not read here.
 * The project is a folder some agent of Tars works in, as written in its record: a schedule acts on its agents.
 */

const STATUS = { not_found: 404, no_right: 403, invalid: 400 } as const;

function callerOf(req: RouteRequest): { caller?: GovernCaller; name: string; projectPath?: string } {
  if (req.internal) return { caller: { kind: 'tars' }, name: 'Tars' };
  const id = resolveCallerId(req);
  const agent = id ? agents.get(id) : undefined;
  if (!agent) return { name: 'nobody' };
  return { caller: { kind: 'agent', agent }, name: agent.name || agent.id, projectPath: agent.projectPath };
}

/** The project a call names, or the caller's own; refused (answered) when none, or no agent works in it. */
function projectOf(req: RouteRequest, raw: unknown, sendJson: SendJson): string | undefined {
  const own = callerOf(req).projectPath;
  if (raw !== undefined && (typeof raw !== 'string' || !raw.trim())) {
    sendJson({ error: 'project is the folder of a project, as list_agents gives it.', code: 'invalid_project' }, STATUS.invalid);
    return undefined;
  }
  const asked = typeof raw === 'string' ? raw : own;
  if (!asked) {
    sendJson({ error: 'project is required: this caller has no project of its own.', code: 'invalid_project' }, STATUS.invalid);
    return undefined;
  }
  const known = [...agents.values()].map((a) => a.projectPath).find((p) => p === asked || path.resolve(p) === path.resolve(asked));
  if (!known) {
    sendJson({ error: `No agent of Tars works in ${asked}.`, code: 'unknown_project' }, STATUS.not_found);
    return undefined;
  }
  return known;
}

/** The caller may change this project's hours or cap, or it is answered 403 with why. */
function mayGovern(req: RouteRequest, projectPath: string, sendJson: SendJson): string | undefined {
  const { caller, name } = callerOf(req);
  const right = governRight(caller, projectPath);
  if (right.ok) return name;
  sendJson({ error: right.reason, code: 'not_your_project' }, STATUS.no_right);
  return undefined;
}

export function registerFleetRoutes(app: RouteApp): void {
  app.get('/api/fleet/projects', (_req, sendJson) => {
    const ops = fleetOperations();
    sendJson({ success: true, projects: ops?.views() ?? [] });
  });

  app.get('/api/fleet/project', (req, sendJson) => {
    const ops = fleetOperations();
    const projectPath = projectOf(req, req.url.searchParams.get('project') ?? undefined, sendJson);
    if (!ops || !projectPath) return;
    sendJson({ success: true, project: ops.view(projectPath) });
  });

  app.post('/api/fleet/schedule', async (req, sendJson) => {
    const ops = fleetOperations();
    const body = (req.body ?? {}) as { project?: unknown };
    const projectPath = projectOf(req, body.project, sendJson);
    if (!ops || !projectPath) return;
    const by = mayGovern(req, projectPath, sendJson);
    if (!by) return;
    const parsed = parseSchedule(req.body);
    if (!parsed.ok) { sendJson({ error: parsed.error, code: parsed.code }, STATUS.invalid); return; }
    ops.setSchedule(projectPath, parsed.schedule, by);
    // Set inside its window, it opens at once.
    await ops.tick();
    sendJson({ success: true, project: ops.view(projectPath) });
  });

  app.post('/api/fleet/schedule/clear', (req, sendJson) => {
    const ops = fleetOperations();
    const projectPath = projectOf(req, (req.body as { project?: unknown } | undefined)?.project, sendJson);
    if (!ops || !projectPath) return;
    const by = mayGovern(req, projectPath, sendJson);
    if (!by) return;
    sendJson({ success: true, project: ops.clearSchedule(projectPath, by) });
  });

  app.post('/api/fleet/cap', (req, sendJson) => {
    const ops = fleetOperations();
    const body = (req.body ?? {}) as { project?: unknown; cap?: unknown };
    const projectPath = projectOf(req, body.project, sendJson);
    if (!ops || !projectPath) return;
    const by = mayGovern(req, projectPath, sendJson);
    if (!by) return;
    const parsed = parseCap(body.cap);
    if (!parsed.ok) { sendJson({ error: parsed.error, code: parsed.code }, STATUS.invalid); return; }
    sendJson({ success: true, project: ops.setCap(projectPath, parsed.cap, by) });
  });
}
