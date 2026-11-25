import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import { assertThrowaway } from '../../setup/throwaway-dirs';
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
 * Added before their code after the Audit's re-read of #596 at 1e9571eab (its L1, 24/11): revoking must apply first
 * and never come back, whatever the disk does.
 * 6. A private folder that refuses an unlink (0500, measured on macOS 26): the revoke throws, and the old token still
 *    opens the routes, now and after a restart.
 * 7. A rotation whose new write fails (a full disk): it throws before it touches the old token, which still opens the
 *    routes, now and after a restart.
 */

assertThrowaway({ DATA_DIR, PRIVATE_DIR });

// 7: the new token's write lands on a full volume.
const fullDisk = vi.hoisted(() => ({ on: false }));
vi.mock('../../../electron/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/secret-file')>();
  return {
    ...actual,
    writeSecretFileSync: (file: string, contents: string) => {
      if (fullDisk.on && file.endsWith('traces-reader-token')) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return actual.writeSecretFileSync(file, contents);
    },
  };
});

const posix = process.platform !== 'win32';
const onDisk = () => { try { return fs.readFileSync(TRACES_READER_TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };

beforeEach(() => {
  fullDisk.on = false;
  if (posix && fs.existsSync(path.dirname(TRACES_READER_TOKEN_FILE))) fs.chmodSync(path.dirname(TRACES_READER_TOKEN_FILE), 0o700);
  revokeReaderToken();
});

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

  it.skipIf(!posix)('6: a revoke in a folder that refuses the unlink: the old token opens nothing, now or after a restart', () => {
    const token = rotateReaderToken();
    const folder = path.dirname(TRACES_READER_TOKEN_FILE);
    fs.chmodSync(folder, 0o500);
    try {
      try { revokeReaderToken(); } catch { /* the old build throws here; what counts is what the token opens */ }
      expect(isReaderToken(token)).toBe(false);
      expect(resolveCaller({ authorization: `Bearer ${token}` }, '/api/traces/sessions')).toMatchObject({ ok: false, status: 401 });
      // A restart reads the file: it says no token.
      expect(onDisk()).toBe('');
      expect(readerTokenStatus().exists).toBe(false);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });

  it('7: a rotation whose write fails: the old token opens nothing, now or after a restart, and the failure is said', () => {
    const token = rotateReaderToken();
    fullDisk.on = true;
    let thrown: unknown;
    try { rotateReaderToken(); } catch (err) { thrown = err; } finally { fullDisk.on = false; }
    expect(isReaderToken(token)).toBe(false);
    expect(resolveCaller({ authorization: `Bearer ${token}` }, '/api/traces/sessions')).toMatchObject({ ok: false, status: 401 });
    expect(onDisk()).toBe('');
    expect(String(thrown)).toMatch(/ENOSPC/);
  });
});
