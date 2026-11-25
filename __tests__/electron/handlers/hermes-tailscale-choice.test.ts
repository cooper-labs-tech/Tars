import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tailscaleCandidates } from '../../../electron/platform';

/**
 * Which `tailscale` the Hermes settings page asks (QA's note on #222).
 *
 * hermes:getConnectionInfo runs `tailscale status` from PATH and from two
 * absolute paths, so an e2e sandbox asked the Mac's own Tailscale: its
 * MagicDNS name was in settings-hermes.png, and a mask had to hide it. A
 * development run may now name the binary to ask, or none
 * (DOROTHY_TAILSCALE_BIN), which the e2e fixture sets.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. With DOROTHY_TAILSCALE_BIN naming a binary, the machine's tailscale is
 *    still run, from PATH or its absolute paths.
 * 2. With it empty, anything is run: the page must read "not installed".
 * 3. A packaged Tars obeys it: an environment variable would choose the
 *    program Tars runs for a user who never asked.
 * 4. Over-correction: unset, the three places are no longer tried.
 *
 * The places are this platform's (tailscaleCandidates): the three of macOS
 * and Linux (integration-paths-posix.test.ts), tailscale.exe on the PATH or
 * under Program Files on Windows (integration-paths.test.ts).
 *
 * Two more, found at QA's gate of #226 (2026-09-28): each passes on the code
 * and fails on a mutant that the four above let through.
 * 1b. With a binary named, `tailscale serve status` is asked of another one,
 *     so the page's serve line comes from the Mac again.
 * 5. The named binary fails (moved, not executable), and the three places
 *    are tried after it, so the sandbox asks the Mac's own tailscale again.
 * And 2 with a blank value, which is none too.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const packaged = vi.hoisted(() => ({ value: false }));
const ran = vi.hoisted(() => [] as string[]);
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  app: { get isPackaged() { return packaged.value; } },
}));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    ran.push(`${file} ${args.join(' ')}`);
    if (file === '/sandbox/fake-tailscale' && args[0] === 'status') {
      cb(null, { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'tars-sandbox.example.ts.net.', TailscaleIPs: ['100.64.0.1'] } }), stderr: '' });
      return;
    }
    cb(Object.assign(new Error('not installed'), { code: 'ENOENT' }));
  },
}));

interface Info { tailscale?: { installed: boolean; dnsName?: string } ; webhookTailnetUrl?: string }

async function info(): Promise<Info> {
  vi.resetModules();
  handlers.clear();
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  return await handlers.get('hermes:getConnectionInfo')!({}) as Info;
}

let saved: string | undefined;
beforeEach(() => { saved = process.env.DOROTHY_TAILSCALE_BIN; ran.length = 0; packaged.value = false; });
afterEach(() => {
  if (saved === undefined) delete process.env.DOROTHY_TAILSCALE_BIN;
  else process.env.DOROTHY_TAILSCALE_BIN = saved;
});

// The program, whole: on Windows it is C:\Program Files\Tailscale\tailscale.exe, spaces and all.
const status = () => ran.filter(r => r.endsWith(' status --json')).map(r => r.slice(0, -' status --json'.length));

describe('the tailscale the Hermes page asks', () => {
  // The first cold import of the handlers' module graph, which can take
  // longer than one test's 5 s on a loaded machine.
  it('1. is the one DOROTHY_TAILSCALE_BIN names, and no other', async () => {
    process.env.DOROTHY_TAILSCALE_BIN = '/sandbox/fake-tailscale';
    const result = await info();
    expect(status()).toEqual(['/sandbox/fake-tailscale']);
    expect(result.webhookTailnetUrl).toBe('https://tars-sandbox.example.ts.net/api/webhooks/hermes');
    // 1b. serve status too
    expect(ran).toEqual(['/sandbox/fake-tailscale status --json', '/sandbox/fake-tailscale serve status']);
  }, 60_000);

  it.each([['empty', ''], ['blank', '   ']])('2. is none when it is %s', async (_what, value) => {
    process.env.DOROTHY_TAILSCALE_BIN = value;
    const result = await info();
    expect(ran).toEqual([]);
    expect(result.webhookTailnetUrl).toBeUndefined();
  });

  it('3. is never chosen by it in a packaged Tars', async () => {
    packaged.value = true;
    process.env.DOROTHY_TAILSCALE_BIN = '/sandbox/fake-tailscale';
    await info();
    expect(status()).toEqual(tailscaleCandidates());
  });

  it('4. is looked for in the three places when it is unset', async () => {
    delete process.env.DOROTHY_TAILSCALE_BIN;
    await info();
    expect(status()).toEqual(tailscaleCandidates());
  });

  it('5. is still the named one alone when that one fails, and the page reads not installed', async () => {
    process.env.DOROTHY_TAILSCALE_BIN = '/sandbox/missing-tailscale';
    const result = await info();
    expect(ran).toEqual(['/sandbox/missing-tailscale status --json']);
    expect(result.tailscale?.installed).toBe(false);
    expect(result.webhookTailnetUrl).toBeUndefined();
  });
});
