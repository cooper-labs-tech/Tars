import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * The address the Hermes settings page hands out is this Tars's own.
 *
 * The page shows the webhook URL to paste into a Hermes cron job and the
 * `tailscale serve` command that exposes it to a VPS, and both were built on a
 * port written into the handler, 31415, rather than the one the server listens
 * on. A second Tars, a sandbox on 31499 or an E2E run, told its user to point
 * the VPS at whichever Tars owned 31415: the live one. Found in D2.
 *
 * How this can fail, written before the fix:
 * 1. the port shown is 31415 while this Tars listens on another;
 * 2. the local URL and the serve command disagree with the port shown;
 * 3. the default install stops showing 31415.
 *
 * The handler is the real one; tailscale is absent, as on most machines.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { isPackaged: true },
}));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => cb(Object.assign(new Error('not installed'), { code: 'ENOENT' })),
}));

// tailscale's reads are CLI probes since 20/11 (core/cli-probe.ts): refused here as their execFile was, so no real
// tailscale is asked.
vi.mock('../../../electron/core/cli-probe', () => ({
  probeCli: async () => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }); },
}));

interface ConnectionInfo { apiPort: number; webhookLocalUrl: string; serveCommand: string }

async function connectionInfoOn(port: string | undefined): Promise<ConnectionInfo> {
  vi.resetModules();
  handlers.clear();
  if (port === undefined) delete process.env.DOROTHY_API_PORT;
  else process.env.DOROTHY_API_PORT = port;
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  return await handlers.get('hermes:getConnectionInfo')!({}) as ConnectionInfo;
}

let saved: string | undefined;
beforeAll(() => { saved = process.env.DOROTHY_API_PORT; });

describe('the address the Hermes settings page shows', () => {
  it('is the port this Tars listens on, in the URL and in the serve command alike', async () => {
    const info = await connectionInfoOn('31499');
    expect(info.apiPort).toBe(31499);
    expect(info.webhookLocalUrl).toBe('http://127.0.0.1:31499/api/webhooks/hermes');
    expect(info.serveCommand).toBe('tailscale serve --bg --set-path /api/webhooks/hermes 31499');
  });

  it('is still 31415 on a default install', async () => {
    const info = await connectionInfoOn(undefined);
    expect(info.apiPort).toBe(31415);
    expect(info.serveCommand.endsWith(' 31415')).toBe(true);
    if (saved === undefined) delete process.env.DOROTHY_API_PORT;
    else process.env.DOROTHY_API_PORT = saved;
  });
});
