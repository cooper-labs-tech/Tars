import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';

/**
 * What searchHermesSessions reads from the gateway's /api/sessions/search.
 *
 * A session Hermes compressed is split: a child session carries on, with
 * `parent_session_id` naming the one before. The gateway's search answers per
 * lineage: `session_id` is the lineage's newest session and `lineage_root` its
 * first (hermes_cli/web_routers/sessions.py), so the super chat's session,
 * once compressed, is found under an id Tars never recorded.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. `lineage_root` and `parent_session_id` are dropped, so nothing can tell
 *    the child from anybody's session.
 * 2. A caller that asks for more than 50, to filter before it cuts, is
 *    capped at 50 where the gateway gives 100.
 *
 * The Audit's gate of #225 (2026-09-28), written before the code: the search
 * stops its root walk at a branch or a delegate edge, so a caller has to read
 * the parents further up itself, from GET /api/sessions/{id}.
 * 3. A session's parent is not read, or read from another field; a session
 *    with none reads as having one; an id is sent unencoded (a slash, a `?`).
 * 4. A session the gateway cannot give (404, a failure) reads as one with no
 *    parent, which would end a walk as if it had reached a root.
 */

const { TMP } = vi.hoisted(() => ({ TMP: `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/tars-hermes-lineage-${process.pid}` }));
vi.mock('../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/constants')>()),
  DATA_DIR: TMP,
}));

let server: http.Server;
let port: number;
let asked = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    asked = req.url ?? '';
    const detail = /^\/api\/sessions\/([^/?]+)$/.exec(req.url ?? '');
    if (detail && detail[1] !== 'search') {
      const sessions: Record<string, unknown> = {
        'branch%2F1': { id: 'branch/1', parent_session_id: 'segment-7', source: 'tool' },
        root: { id: 'root', parent_session_id: null },
      };
      const found = sessions[detail[1]];
      res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(found ?? { detail: 'Session not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { session_id: 'tip', lineage_root: 'root', parent_session_id: 'mid', id: 'tip', snippet: 'compressed' },
      { session_id: 'plain', lineage_root: 'plain', parent_session_id: null, snippet: 'never compressed' },
    ] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('searchHermesSessions', () => {
  it('1. keeps each hit\'s lineage root and parent', async () => {
    const { searchHermesSessions } = await import('../../../electron/services/hermes-client');
    const res = await searchHermesSessions({ mode: 'local', localPort: port, authMode: 'token', token: 't' } as never, 'x', 10);

    expect(res.success && res.hits.map(h => [h.sessionId, h.lineageRoot, h.parentSessionId])).toEqual([
      ['tip', 'root', 'mid'],
      ['plain', 'plain', undefined],
    ]);
  });

  it('2. asks the gateway for up to 100', async () => {
    const { searchHermesSessions } = await import('../../../electron/services/hermes-client');
    await searchHermesSessions({ mode: 'local', localPort: port, authMode: 'token', token: 't' } as never, 'x', 100);
    expect(new URL(asked, 'http://x').searchParams.get('limit')).toBe('100');
  });

  it('3, 4. reads a session\'s parent from its detail, and fails for a session it cannot read', async () => {
    const client = await import('../../../electron/services/hermes-client') as Record<string, unknown>;
    const read = client.fetchHermesSessionParent as ((conn: unknown, id: string) => Promise<unknown>) | undefined;
    expect(typeof read).toBe('function');
    const conn = { mode: 'local', localPort: port, authMode: 'token', token: 't' };

    expect(await read!(conn, 'branch/1')).toEqual({ success: true, parentSessionId: 'segment-7' });
    expect(asked).toBe('/api/sessions/branch%2F1');
    expect(await read!(conn, 'root')).toEqual({ success: true, parentSessionId: null });
    expect(await read!(conn, 'gone')).toMatchObject({ success: false });
  });
});
