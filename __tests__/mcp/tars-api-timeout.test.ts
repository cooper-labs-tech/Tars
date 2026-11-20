import '../setup/home-guard';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * What an agent's MCP tool says when Tars does not answer: apiRequest
 * (mcp-shared/src/tars-api.ts), which mcp-orchestrator and mcp-memory call Tars
 * with. It said "This operation was aborted" after 30 s, where mcp-kanban says
 * "Tars did not answer at <origin>: no answer within 60 s" (QA's gate of #196).
 *
 * How this can fail, written before the code:
 * 1. it does not say that Tars is what did not answer, nor how long it waited;
 * 2. it names a delay it did not wait: the 30 s default for a call that gave its
 *    own (wait_for_agent's segments, delegate_task's run);
 * 3. it stops being an AbortError: delegate_task reads that name as its own wait
 *    running out, and anything else sends it on to type the task into the
 *    agent's terminal as well, so the task runs twice;
 * 4. it says Tars did not answer when Tars did: an answer in time, an error
 *    Tars returned, or a connection refused, each is reported as what it is;
 * 5. an answer whose headers came and whose body stopped is waited on for ever,
 *    or said another way.
 *
 * A real server on a free port stands in for Tars and holds what it is told to
 * hold. Each call gives its own delay, in milliseconds, so nothing here waits
 * 30 s: the contract (__tests__/mcp/contracts) replays the defaults in the
 * built servers.
 */

type ApiRequest = typeof import('../../mcp-shared/src/tars-api').apiRequest;

/** tars-api reads CLAUDE_MGR_API_URL once, when it loads: a fresh copy of it pointed at `url`. */
async function apiRequestAt(url: string): Promise<ApiRequest> {
  vi.resetModules();
  process.env.CLAUDE_MGR_API_URL = url;
  return (await import('../../mcp-shared/src/tars-api')).apiRequest;
}

/** Why a call failed, or a note that it did not. */
async function failure(call: Promise<unknown>): Promise<Error> {
  return call.then(
    value => { throw new Error(`answered: ${JSON.stringify(value)}`); },
    (err: Error) => err,
  );
}

let tars: http.Server;
let origin: string;
let apiRequest: ApiRequest;
const urlBefore = process.env.CLAUDE_MGR_API_URL;

beforeAll(async () => {
  tars = http.createServer((req, res) => {
    if (req.url === '/api/hold') return;
    if (req.url === '/api/half') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"agent":');
      return;
    }
    if (req.url === '/api/refused') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'This token names no agent' }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agent: { id: 'a1' } }));
    }, 20);
  });
  await new Promise<void>(resolve => tars.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(tars.address() as AddressInfo).port}`;
  apiRequest = await apiRequestAt(origin);
});

afterAll(async () => {
  tars.closeAllConnections();
  await new Promise(resolve => tars.close(resolve));
  if (urlBefore === undefined) delete process.env.CLAUDE_MGR_API_URL;
  else process.env.CLAUDE_MGR_API_URL = urlBefore;
});

describe('apiRequest, when Tars does not answer', () => {
  it('says Tars did not answer, where, and after how long (1)', async () => {
    const err = await failure(apiRequest('/api/hold', 'GET', undefined, 150));

    expect(err.message).toBe(`Tars did not answer at ${origin}: no answer within 0.15 s`);
  });

  it('names the delay the call gave, not the default (2)', async () => {
    const err = await failure(apiRequest('/api/hold', 'POST', { task: 'x' }, 250));

    expect(err.message).toBe(`Tars did not answer at ${origin}: no answer within 0.25 s`);
  });

  it('is still an AbortError, which delegate_task reads as its own wait running out (3)', async () => {
    const err = await failure(apiRequest('/api/hold', 'GET', undefined, 150));

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
  });

  it('says the same when the headers came and the body stopped (5)', async () => {
    const err = await failure(apiRequest('/api/half', 'GET', undefined, 150));

    expect(err.message).toBe(`Tars did not answer at ${origin}: no answer within 0.15 s`);
    expect(err.name).toBe('AbortError');
  });
});

describe('apiRequest, when Tars answers (4)', () => {
  it('returns an answer that came in time', async () => {
    await expect(apiRequest('/api/agents/a1', 'GET', undefined, 1_000)).resolves.toEqual({ agent: { id: 'a1' } });
  });

  it('reports an error Tars returned as that error', async () => {
    const err = await failure(apiRequest('/api/refused', 'GET', undefined, 1_000));

    expect(err.message).toBe('This token names no agent');
    expect(err.name).not.toBe('AbortError');
  });

  it('does not call a refused connection a timeout', async () => {
    const closed = http.createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise(resolve => closed.close(resolve));
    const toNobody = await apiRequestAt(`http://127.0.0.1:${port}`);

    const err = await failure(toNobody('/api/agents/a1', 'GET', undefined, 1_000));

    expect(err.message).not.toMatch(/no answer within/);
    expect(err.name).not.toBe('AbortError');
  });
});
