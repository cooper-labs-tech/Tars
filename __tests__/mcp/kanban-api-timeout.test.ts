import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A kanban tool does not wait on a Tars that stopped answering.
 *
 * mcp-kanban asks Tars for everything, and its request had no timeout: a Tars
 * that hangs (a stuck main process, a gateway call that never returns) left the
 * tool waiting until the MCP client gave up, with nothing to tell the agent.
 * The Backend's gate of #171.
 *
 * How this can fail, written before the code:
 * 1. the request sets no timeout, so a silent Tars is waited on for ever;
 * 2. a timeout that fires does not end the request, or ends it without saying Tars did not answer.
 *
 * The transport is replaced and nothing else: the real client builds the
 * request, and these read what it asked for and what it does when the socket
 * times out. Nothing reaches a Tars.
 */

const requests: Array<{ options: Record<string, unknown>; req: EventEmitter & { destroyed: boolean } }> = [];

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    request: vi.fn((options: Record<string, unknown>) => {
      const req = Object.assign(new EventEmitter(), {
        destroyed: false,
        write: () => {},
        end: () => {},
        setTimeout: (ms: number) => { options.timeout = ms; },
        destroy: (err?: Error) => { req.destroyed = true; if (err) req.emit('error', err); },
      });
      requests.push({ options, req });
      return req;
    }),
  };
});

beforeEach(() => { requests.length = 0; });

describe('the request a kanban tool makes to Tars', () => {
  it('has a timeout, and ends with a message that says Tars did not answer', async () => {
    vi.resetModules();
    const { apiRequest } = await import('../../mcp-kanban/src/api');
    const pending = apiRequest('GET', '/api/kanban/tasks');
    expect(requests).toHaveLength(1);
    const { options, req } = requests[0];
    expect(Number(options.timeout)).toBeGreaterThan(0);
    expect(Number(options.timeout)).toBeLessThanOrEqual(120_000);
    req.emit('timeout');
    await expect(pending).rejects.toThrow(/Tars did not answer/);
    expect(req.destroyed).toBe(true);
  });
});
