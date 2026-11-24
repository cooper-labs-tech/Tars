import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A key from the drop folder is never lost to a save that failed (the orchestrator's follow-up on #596). The drop
 * file is how the owner hands Tars a production key, and it was deleted as soon as it was read: an endpoint whose
 * settings could not be written then lost its key for good.
 *
 * How it fails, written before the code:
 * K1. A drop-file key whose save fails is consumed: the file is gone, or its bytes changed.
 * K2. The endpoint, or its key, is held in memory although the save failed.
 * K3. A save that works leaves the drop file in the folder.
 * K4. The key lands in the answer, an error message or a log line.
 * K5. The file is taken away before the write is tried (the consumption does not wait for the write).
 * Both routes that read the drop folder: POST /api/endpoints with keyFile, and POST /api/endpoints/:id/key. The
 * window's endpoints:save and endpoints:setKey take a key typed in Settings, never a drop file.
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/test' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({ agents: new Map(), saveAgents: vi.fn() }));
vi.mock('../../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn() }));

import { registerEndpointRoutes } from '../../../../electron/services/api-routes/endpoint-routes';
import { configureTraces } from '../../../../electron/services/traces-runtime';
import { ENDPOINT_KEYS_DIR, ensureDropFolder } from '../../../../electron/services/inference-endpoints';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AppSettings } from '../../../../electron/types';
import { DATA_DIR, PRIVATE_DIR } from '../../../../electron/constants';
import { assertThrowaway } from '../../../setup/throwaway-dirs';

// The hooks below write and remove a drop file under the data folder, and the settings' keys: only in a throwaway home.
assertThrowaway({ DATA_DIR, PRIVATE_DIR });

/** Made up here, for this test only: no real key, and not the sandbox key file's value. */
const KEY = 'sk-made-up-in-this-test-7f3a9c2e1b';
const EP = 'ep-0a0b0c';
const FILE = 'prod.key';
let memory: AppSettings;
let events: string[];
let failWrite: boolean;
let logged: string[];

function route(method: 'POST', pathname: string, body: Record<string, unknown>, params: Record<string, string> = {}) {
  const app: RouteApp = {
    routes: [],
    add(m, pattern, handler) { this.routes.push({ method: m, pattern, handler }); },
    get(p, h) { this.add('GET', p, h); },
    post(p, h) { this.add('POST', p, h); },
    put(p, h) { this.add('PUT', p, h); },
    delete(p, h) { this.add('DELETE', p, h); },
  };
  const ctx = { getAppSettings: () => memory } as unknown as RouteContext;
  registerEndpointRoutes(app, ctx);
  const r = app.routes.find(x => x.method === method && (typeof x.pattern === 'string' ? x.pattern === pathname : x.pattern.test(pathname)))!;
  const sent = vi.fn();
  const req = { method, pathname, url: new URL(`http://localhost${pathname}`), body, raw: {} as never, res: {} as never, params, callerAgentId: 'agent-1' } as RouteRequest;
  return Promise.resolve(r.handler(req, sent, ctx)).then(() => ({ status: sent.mock.calls[0]?.[1] ?? 200, body: sent.mock.calls[0]?.[0] as Record<string, unknown> }));
}

const dropFile = () => path.join(ENDPOINT_KEYS_DIR, FILE);
const endpointOf = (s: AppSettings) => (s as { inferenceEndpoints?: Array<{ id: string; name: string }> }).inferenceEndpoints ?? [];
const keyOf = (s: AppSettings, id: string) => (s as { endpointKeys?: Record<string, string> }).endpointKeys?.[id];

beforeEach(() => {
  memory = {
    inferenceEndpoints: [{ id: EP, name: 'Local', baseUrl: 'http://127.0.0.1:9/v1', approvedBaseUrl: 'http://127.0.0.1:9/v1', approved: true, allowTraces: false, models: [], holdMaxSeconds: 120 }],
  } as unknown as AppSettings;
  events = [];
  failWrite = false;
  logged = [];
  configureTraces({
    getSettings: () => memory,
    setSettings: (s) => { events.push('memory'); memory = s; },
    writeSettings: () => {
      events.push(fs.existsSync(dropFile()) ? 'write (file still there)' : 'write (file already gone)');
      if (failWrite) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
    getAgent: () => undefined,
    emit: () => {},
  });
  ensureDropFolder();
  fs.writeFileSync(dropFile(), `${KEY}\n`, { mode: 0o600 });
  for (const level of ['error', 'warn', 'log'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(a => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')); });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dropFile(), { force: true });
});

const cases = [
  { name: 'POST /api/endpoints with keyFile', call: () => route('POST', '/api/endpoints', { name: 'Remote', baseUrl: 'https://inference.example.com/v1', keyFile: FILE }) },
  { name: 'POST /api/endpoints/:id/key', call: () => route('POST', `/api/endpoints/${EP}/key`, { keyFile: FILE }, { id: EP }) },
];

describe('a key from the drop folder and a save that fails', () => {
  for (const c of cases) {
    it(`K1, K2, K4. ${c.name}: the drop file stays with the same bytes, nothing is held, and the key is said nowhere`, async () => {
      failWrite = true;
      const before = structuredClone(memory);
      const answer = await c.call();
      expect(answer.status).toBe(500);
      expect(String(answer.body.error)).toMatch(/ENOSPC/);
      expect(fs.readFileSync(dropFile(), 'utf8')).toBe(`${KEY}\n`);
      expect(memory).toEqual(before);
      expect(endpointOf(memory).map(e => e.name)).not.toContain('Remote');
      expect(JSON.stringify(answer.body)).not.toContain(KEY);
      expect(logged.join('\n')).not.toContain(KEY);
    });
  }
});

describe('a key from the drop folder and a save that works', () => {
  for (const c of cases) {
    it(`K3, K5. ${c.name}: written while the file is still there, then the file is taken away, and the key is held`, async () => {
      const answer = await c.call();
      expect([200, 201]).toContain(answer.status);
      expect(events[0]).toBe('write (file still there)');
      expect(fs.existsSync(dropFile())).toBe(false);
      const id = c.name.endsWith('/key') ? EP : String((answer.body.endpoint as { id: string }).id);
      expect(keyOf(memory, id)).toBe(KEY);
      expect(JSON.stringify(answer.body)).not.toContain(KEY);
      expect(logged.join('\n')).not.toContain(KEY);
    });
  }
});
