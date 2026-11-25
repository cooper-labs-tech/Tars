import '../../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { tarsInstanceId } from '../../../../electron/core/agent-tokens';
import { registerHealthRoutes } from '../../../../electron/services/api-routes/health-routes';
import { RouteApp, RouteContext, RouteRequest, SendJson } from '../../../../electron/services/api-routes/types';

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

const mockCtx = {} as RouteContext;

describe('health-routes', () => {
  it('registers GET /api/health', () => {
    const app = makeRouteApp();
    registerHealthRoutes(app, mockCtx);
    expect(app.routes).toHaveLength(1);
    expect(app.routes[0].method).toBe('GET');
    expect(app.routes[0].pattern).toBe('/api/health');
  });

  it('returns { ok: true }', async () => {
    const app = makeRouteApp();
    registerHealthRoutes(app, mockCtx);

    const sendJson = vi.fn() as unknown as SendJson;
    const req = { params: {} } as RouteRequest;
    await app.routes[0].handler(req, sendJson, mockCtx);
    expect(sendJson).toHaveBeenCalledWith({ ok: true });
  });
});

/**
 * The proof a hook asks for before it sends its token (#11): the port answers
 * sha256("<instance id>:<challenge>") for the challenge the hook sends, and a
 * process that holds the port while Tars is down cannot, not knowing the id.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. No proof, so the hook cannot tell Tars from a squatter.
 * 2. The id itself in the answer: whoever asked once could prove to be Tars.
 * 3. Any string taken as a challenge: an empty one gives a proof reusable for
 *    ever, a huge one is hashed on the main thread.
 * 4. Over-correction: /api/health without a challenge answers anything else.
 */
describe('/api/health, asked for a proof', () => {
  const ask = async (query: string) => {
    const app = makeRouteApp();
    registerHealthRoutes(app, mockCtx);
    const sendJson = vi.fn() as unknown as SendJson;
    const req = { params: {}, url: new URL(`http://127.0.0.1/api/health${query}`) } as RouteRequest;
    await app.routes[0].handler(req, sendJson, mockCtx);
    return (sendJson as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
  };

  it('1, 2. answers the proof for the challenge, and never the id', async () => {
    const challenge = crypto.randomBytes(16).toString('hex');
    const answer = await ask(`?challenge=${challenge}`);

    expect(answer.proof).toBe(crypto.createHash('sha256').update(`${tarsInstanceId()}:${challenge}`).digest('hex'));
    expect(JSON.stringify(answer)).not.toContain(tarsInstanceId());
  });

  it('3. gives no proof for a challenge that is not 32 to 64 hex digits', async () => {
    for (const bad of ['', 'abc', 'z'.repeat(32), 'a'.repeat(65), `${'a'.repeat(32)}%0A`]) {
      expect((await ask(`?challenge=${bad}`)).proof, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('4. still answers { ok: true } with no challenge', async () => {
    expect(await ask('')).toEqual({ ok: true });
  });
});
