import type { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import {
  applyEndpointPatch, checkHealth, endpointViews, readModels, saveEndpoint, setEndpointKey, takeKeyFromDropFile, ENDPOINT_KEYS_DIR,
} from '../inference-endpoints';
import { saveSettingsFromApi, tellEndpointChanged, traceStore } from '../traces-runtime';
import { sessionDocument } from '../trace-export';
import type { TraceFilter } from '../trace-store';

/**
 * Inference endpoints for agents, and the traces for the external reader.
 *
 * - `/api/endpoints`: any agent, of any project, lists the endpoints (never a key), adds one, changes one, rotates a
 *   key from its drop file, reads the models and checks the health. An endpoint an agent adds, or whose base URL it
 *   changes, waits for the owner's approval in the window (services/inference-endpoints.ts); no route approves. The
 *   shared token reads and changes nothing but the list.
 * - `/api/traces/*`: the external trace reader's token only (api-server.ts resolveCaller), read-only.
 */

const ENDPOINT = /^\/api\/endpoints\/(ep-[0-9a-f]{6})$/;
const ENDPOINT_KEY = /^\/api\/endpoints\/(ep-[0-9a-f]{6})\/key$/;
const ENDPOINT_MODELS = /^\/api\/endpoints\/(ep-[0-9a-f]{6})\/models$/;
const ENDPOINT_CHECK = /^\/api\/endpoints\/(ep-[0-9a-f]{6})\/check$/;
const TRACE = /^\/api\/traces\/sessions\/([A-Za-z0-9_-]{1,80})$/;
const TRACE_REQUEST = /^\/api\/traces\/requests\/([A-Za-z0-9_-]{1,80})$/;

function caller(req: RouteRequest, send: SendJson): { agentId: string; agentName?: string } | null {
  if (!req.callerAgentId) {
    send({ error: 'Endpoints are changed by an agent, with its own token, or by the owner in the window.' }, 403);
    return null;
  }
  return { agentId: req.callerAgentId, agentName: agents.get(req.callerAgentId)?.name };
}

const views = (ctx: RouteContext) => endpointViews(ctx.getAppSettings(), [...agents.values()]);
const viewOf = (ctx: RouteContext, id: string) => views(ctx).find(v => v.id === id);

function filterOf(url: URL): TraceFilter {
  const q = url.searchParams;
  const n = (k: string) => (q.get(k) !== null && /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
  return {
    project: q.get('project') || undefined, harness: q.get('harness') || undefined, model: q.get('model') || undefined,
    endpointId: q.get('endpoint') || undefined, agentId: q.get('agent') || undefined, from: n('from'), to: n('to'),
    cursor: q.get('cursor') || undefined, limit: n('limit'),
  };
}

export function registerEndpointRoutes(app: RouteApp, ctx: RouteContext): void {
  app.get('/api/endpoints', async (req, send) => {
    if (!req.callerAgentId && !req.internal) {
      send({ endpoints: views(ctx).map(v => ({ ...v, agents: v.agents.length })) });
      return;
    }
    send({ endpoints: views(ctx), keyDropFolder: ENDPOINT_KEYS_DIR });
  });

  app.post('/api/endpoints', async (req, send) => {
    const who = caller(req, send);
    if (!who) return;
    const b = req.body;
    const r = saveEndpoint(ctx.getAppSettings(), {
      name: typeof b.name === 'string' ? b.name : undefined, baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl : undefined,
      allowTraces: typeof b.allowTraces === 'boolean' ? b.allowTraces : false,
      holdMaxSeconds: typeof b.holdMaxSeconds === 'number' ? b.holdMaxSeconds : undefined,
    }, who);
    if (!r.ok) { send({ error: r.error }, 400); return; }
    let settings = r.settings;
    let keyNote: string | undefined;
    if (b.keyFile !== undefined) {
      const key = takeKeyFromDropFile(b.keyFile);
      if (!key.ok) keyNote = key.error;
      else {
        const keyed = setEndpointKey(settings, r.endpoint.id, key.key);
        if (keyed.ok) settings = keyed.settings;
      }
    }
    saveSettingsFromApi(settings);
    tellEndpointChanged({ id: r.endpoint.id, by: who, needsApproval: !r.endpoint.approved });
    send({ endpoint: viewOf(ctx, r.endpoint.id), needsApproval: !r.endpoint.approved, ...(keyNote ? { keyNotTaken: keyNote } : {}) }, 201);
  });

  app.post(ENDPOINT, async (req, send) => {
    const who = caller(req, send);
    if (!who) return;
    const b = req.body;
    const r = saveEndpoint(ctx.getAppSettings(), {
      id: req.params.id, name: typeof b.name === 'string' ? b.name : undefined, baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl : undefined,
      allowTraces: typeof b.allowTraces === 'boolean' ? b.allowTraces : undefined,
      holdMaxSeconds: typeof b.holdMaxSeconds === 'number' ? b.holdMaxSeconds : undefined,
    }, who);
    if (!r.ok) { send({ error: r.error }, r.error.startsWith('There is no') ? 404 : 400); return; }
    saveSettingsFromApi(r.settings);
    tellEndpointChanged({ id: r.endpoint.id, by: who, needsApproval: !r.endpoint.approved });
    send({ endpoint: viewOf(ctx, r.endpoint.id), needsApproval: !r.endpoint.approved });
  });

  app.post(ENDPOINT_KEY, async (req, send) => {
    const who = caller(req, send);
    if (!who) return;
    const key = takeKeyFromDropFile(req.body.keyFile);
    if (!key.ok) { send({ error: key.error, keyDropFolder: ENDPOINT_KEYS_DIR }, 400); return; }
    const r = setEndpointKey(ctx.getAppSettings(), req.params.id, key.key);
    if (!r.ok) { send({ error: r.error }, 404); return; }
    saveSettingsFromApi(r.settings);
    tellEndpointChanged({ id: req.params.id, by: who, needsApproval: false });
    send({ ok: true, keySet: true });
  });

  app.post(ENDPOINT_MODELS, async (req, send) => {
    if (!caller(req, send)) return;
    const r = await readModels(ctx.getAppSettings(), req.params.id);
    // Only what the probe owns, onto the settings as they are now (the Audit's M1 on #596).
    saveSettingsFromApi(applyEndpointPatch(ctx.getAppSettings(), req.params.id, r.patch, r.probed));
    send(r.ok ? { models: r.models } : { error: r.error }, r.ok ? 200 : 502);
  });

  app.post(ENDPOINT_CHECK, async (req, send) => {
    if (!caller(req, send)) return;
    const r = await checkHealth(ctx.getAppSettings(), req.params.id);
    saveSettingsFromApi(applyEndpointPatch(ctx.getAppSettings(), req.params.id, r.patch, r.probed));
    send({ health: r.health });
  });

  app.get('/api/traces/sessions', async (req, send) => {
    if (!req.traceReader) { send({ error: 'Unauthorized' }, 401); return; }
    send(traceStore().changes(filterOf(req.url)));
  });

  app.get(TRACE, async (req, send) => {
    if (!req.traceReader) { send({ error: 'Unauthorized' }, 401); return; }
    const doc = sessionDocument(traceStore(), req.params.id);
    if (!doc) { send({ error: 'No such session.' }, 404); return; }
    send(doc);
  });

  app.get(TRACE_REQUEST, async (req, send) => {
    if (!req.traceReader) { send({ error: 'Unauthorized' }, 401); return; }
    const m = traceStore().requestMessages(req.params.id);
    if (!m) { send({ error: 'No such request.' }, 404); return; }
    send(m.raw);
  });
}
