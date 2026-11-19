import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The endpoints' probe routes, POST /api/endpoints/:id/models and /check (native traces; the re-audit's L2 on #596):
 * what they write, and when.
 *
 * How it fails, written before the route-level test (19/11), each a way the Audit's M1 comes back:
 * 1. A route saves the settings it read before its fetch, so a change the owner made while the probe was in flight
 *    (a project taken out of traces, the upload address cleared) is undone.
 * 2. A route saves nothing of the probe (its models, its health).
 * 3. A probe of an address the endpoint has left since lands on the new address (the re-audit's I1).
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map(), saveAgents: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn() }));

import { registerEndpointRoutes } from '../../../../electron/services/api-routes/endpoint-routes';
import { configureTraces } from '../../../../electron/services/traces-runtime';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AppSettings } from '../../../../electron/types';

let upstream: http.Server;
let release: () => void = () => {};
let arrived: Promise<void>;
let settings: AppSettings;
let base: string;

function makeRouteApp(): RouteApp {
  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  return app;
}

/** Starts a route call and resolves once the probe has reached the endpoint, with the call's own end. */
function callRoute(suffix: 'models' | 'check') {
  const app = makeRouteApp();
  const ctx = { getAppSettings: () => settings } as unknown as RouteContext;
  registerEndpointRoutes(app, ctx);
  const pathname = `/api/endpoints/ep-0a0b0c/${suffix}`;
  const route = app.routes.find(r => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test(pathname))!;
  const sent = vi.fn();
  const req = { method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body: {}, raw: {} as never, res: {} as never, params: { id: 'ep-0a0b0c' }, callerAgentId: 'agent-1' } as RouteRequest;
  return { done: route.handler(req, sent, ctx), sent };
}

beforeEach(async () => {
  let arrive!: () => void;
  arrived = new Promise(r => { arrive = r; });
  upstream = http.createServer((_q, res) => {
    arrive();
    let sent = false;
    release = () => {
      if (sent) return;
      sent = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fresh-model' }] }));
    };
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  settings = {
    inferenceEndpoints: [{ id: 'ep-0a0b0c', name: 'Local', baseUrl: base, approvedBaseUrl: base, approved: true, allowTraces: true, models: [], holdMaxSeconds: 120 }],
    traces: { projects: ['/p/project-a'], capBytes: 1e9, retentionDays: 30, pairs: [], excludeClosedModels: true, uploadUrl: 'https://backoffice.example.com' },
  } as unknown as AppSettings;
  configureTraces({ getSettings: () => settings, saveSettings: (s) => { settings = s; }, getAgent: () => undefined, emit: () => {} });
});
afterEach(async () => {
  release();
  await new Promise(r => upstream.close(() => r(undefined)));
});

describe('the probe routes write what they own, onto the settings as they are when they end', () => {
  for (const suffix of ['models', 'check'] as const) {
    it(`1 and 2: /${suffix}: the owner's change made while it ran survives, and the probe's result is saved`, async () => {
      const call = callRoute(suffix);
      await arrived;
      // The owner, while the probe is in flight: a project out of traces, the upload address cleared.
      settings = { ...settings, traces: { ...settings.traces!, projects: [], uploadUrl: '' } };
      release();
      await call.done;
      expect(settings.traces).toMatchObject({ projects: [], uploadUrl: '' });
      const e = settings.inferenceEndpoints![0];
      if (suffix === 'models') expect(e.models).toEqual(['fresh-model']);
      else expect(e.health).toMatchObject({ ok: true, status: 200 });
    });

    it(`3: /${suffix}: a probe of an address the endpoint has left lands nowhere`, async () => {
      const call = callRoute(suffix);
      await arrived;
      settings = { ...settings, inferenceEndpoints: [{ ...settings.inferenceEndpoints![0], baseUrl: 'https://moved.example.com/v1', approved: false }] };
      release();
      await call.done;
      const e = settings.inferenceEndpoints![0];
      expect(e.models).toEqual([]);
      expect(e.health).toBeUndefined();
    });
  }
});
