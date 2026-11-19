import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { getApiToken, resolveCaller } from '../../../electron/services/api-server';
import { isReaderToken, readerTokenStatus, revokeReaderToken, rotateReaderToken, TRACES_READER_TOKEN_FILE } from '../../../electron/services/traces-runtime';
import { mintAgentToken } from '../../../electron/core/agent-tokens';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The external trace reader's token (native traces): `~/.tars-private/traces-reader-token`, which opens the traces'
 * read routes and nothing else, the way a Hermes gateway's secret opens its own route (services/hermes-gateways.ts).
 *
 * How it fails, written before the code (19/11):
 * 1. The reader's token opens a path outside `/api/traces/`.
 * 2. Another credential opens `/api/traces/`: an agent's own token (one agent would read every other's sessions),
 *    the shared token, a made-up one.
 * 3. A rotated token still opens the routes; a revoked one does.
 * 4. The token file is readable by others.
 * 5. The status says the token.
 */

beforeEach(() => { revokeReaderToken(); });

describe("the trace reader's token", () => {
  it('1: opens the traces routes, and nothing else', () => {
    const token = rotateReaderToken();
    expect(resolveCaller({ authorization: `Bearer ${token}` }, '/api/traces/sessions')).toMatchObject({ ok: true, traceReader: true });
    expect(resolveCaller({ authorization: `Bearer ${token}` }, '/api/traces/sessions/tr_1')).toMatchObject({ ok: true, traceReader: true });
    for (const p of ['/api/agents', '/api/endpoints', '/api/webhooks/hermes', '/api/tracesX', '/api/hooks/status']) {
      expect(resolveCaller({ authorization: `Bearer ${token}` }, p), p).toMatchObject({ ok: false, status: 401 });
    }
  });

  it('2: no other credential opens the traces routes', () => {
    rotateReaderToken();
    for (const presented of [getApiToken(), mintAgentToken('agent-1'), 'trd_made_up', '']) {
      expect(resolveCaller({ authorization: `Bearer ${presented}` }, '/api/traces/sessions')).toMatchObject({ ok: false, status: 401 });
    }
  });

  it('3: a rotated or revoked token opens nothing', () => {
    const first = rotateReaderToken();
    const second = rotateReaderToken();
    expect(isReaderToken(first)).toBe(false);
    expect(isReaderToken(second)).toBe(true);
    revokeReaderToken();
    expect(isReaderToken(second)).toBe(false);
    expect(resolveCaller({ authorization: `Bearer ${second}` }, '/api/traces/sessions')).toMatchObject({ ok: false });
  });

  it.skipIf(!hasPosixModes())('4: the file is the owner\'s alone', () => {
    rotateReaderToken();
    expect(fs.statSync(TRACES_READER_TOKEN_FILE).mode & 0o077).toBe(0);
  });

  it('5: the status never says the token', () => {
    const token = rotateReaderToken();
    isReaderToken(token);
    const status = readerTokenStatus();
    expect(status).toMatchObject({ exists: true, route: '/api/traces/', listen: 'loopback' });
    expect(status.lastUsedAt).toBeDefined();
    expect(JSON.stringify(status)).not.toContain(token);
  });
});
