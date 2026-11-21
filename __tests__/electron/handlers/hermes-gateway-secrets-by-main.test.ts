import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * The Hermes gateways' secrets, handed over as #466 hands every other secret (the Audit's L3 on #469,
 * audit-pr469.md): the main process shows a new secret once, in a dialog of its own the page cannot read, and copies
 * it on request; the page is told only that it is set. A page with an XSS that read one could post to Tars as that
 * gateway, into the projects it reaches, long after the page was fixed.
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  G1. hermes:gateways:add answers the new gateway's secret; or mints none; or the user is not shown it, once, by the
 *      main process.
 *  G2. hermes:gateways:rotate answers the new secret; or the user is not shown the new one, once, by the main process.
 *  G3. The secret is copied for the user by an answer that holds it, or not copied at all: an added gateway's, and the
 *      default gateway's, which is the one Hermes jobs made before 2.0.4 hold.
 *  G4. A refusal (an unknown gateway, an id that is no gateway's, a gateway with no name) shows or copies a secret.
 *  G5. A channel still answers a gateway's secret: hermes:gateways:secret, which did, is still registered, or another
 *      gateway channel's answer holds one.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const shown = vi.hoisted(() => [] as Array<{ message?: string; detail?: string }>);
const copied = vi.hoisted(() => [] as string[]);

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.HOME, getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '2.0.4', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [], getFocusedWindow: () => null }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
  shell: { openExternal: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(async (...args: unknown[]) => { shown.push(args[args.length - 1] as { message?: string; detail?: string }); return { response: 1 }; }),
  },
  clipboard: { writeText: (text: string) => { copied.push(text); } },
}));

type Gateways = typeof import('../../../electron/services/hermes-gateways');
let gateways: Gateways;
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<Record<string, unknown>>;
const shownText = () => shown.map((o) => `${o.message} ${o.detail}`).join('\n');
/** Lets the dialog the handler opened without waiting for it come up. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  gateways = await import('../../../electron/services/hermes-gateways');
  (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
}, 60_000);

beforeEach(() => {
  shown.length = 0;
  copied.length = 0;
});

describe('a Hermes gateway\'s secret', () => {
  it('G1. a new gateway: its secret minted and shown once by the main process, never answered', async () => {
    const answer = await call('hermes:gateways:add', { label: 'VPS' });
    await settle();
    const id = (answer.gateway as { id: string }).id;
    const secret = gateways.gatewaySecret(id);

    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(answer).toMatchObject({ success: true, set: true, gateway: { id, label: 'VPS' } });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(shownText()).toContain(secret);
    expect(shown).toHaveLength(1);
  });

  it('G2. a rotated secret: shown once by the main process, never answered', async () => {
    const id = ((await call('hermes:gateways:add', { label: 'Laptop' })).gateway as { id: string }).id;
    await settle();
    const before = gateways.gatewaySecret(id);
    shown.length = 0;

    const answer = await call('hermes:gateways:rotate', { id });
    await settle();
    const after = gateways.gatewaySecret(id);

    expect(after).not.toBe(before);
    expect(answer).toMatchObject({ success: true, set: true });
    expect(JSON.stringify(answer)).not.toContain(after);
    expect(shownText()).toContain(after);
    expect(shownText()).not.toContain(before);
  });

  it('G3. copied for the user, never answered: an added gateway\'s and the default one\'s', async () => {
    const id = ((await call('hermes:gateways:add', { label: 'Desk' })).gateway as { id: string }).id;
    await settle();
    copied.length = 0;

    const answer = await call('hermes:gateways:copySecret', { id });
    expect(answer).toEqual({ success: true, copied: true });
    expect(copied).toEqual([gateways.gatewaySecret(id)]);

    const byDefault = await call('hermes:gateways:copySecret', { id: gateways.DEFAULT_GATEWAY });
    expect(byDefault).toEqual({ success: true, copied: true });
    expect(copied[1]).toBe(gateways.gatewaySecret(gateways.DEFAULT_GATEWAY));
  });

  it('G4. a refusal shows and copies nothing', async () => {
    for (const [channel, params] of [
      ['hermes:gateways:rotate', { id: 'gw-ffffff' }],
      ['hermes:gateways:rotate', { id: '../../.ssh/id_ed25519' }],
      ['hermes:gateways:copySecret', { id: 'gw-ffffff' }],
      ['hermes:gateways:copySecret', { id: '../../.ssh/id_ed25519' }],
      ['hermes:gateways:add', { label: '' }],
    ] as const) {
      const answer = await call(channel, params);
      await settle();
      expect(answer.success, `${channel} ${JSON.stringify(params)}`).toBe(false);
    }
    expect(shown).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('G5. no gateway channel answers a secret', async () => {
    expect(handlers.has('hermes:gateways:secret')).toBe(false);
    const id = ((await call('hermes:gateways:add', { label: 'Office' })).gateway as { id: string }).id;
    await settle();
    const answers = [
      await call('hermes:gateways:list'),
      await call('hermes:gateways:setProjects', { id, projects: ['/Users/someone/projects/alpha'] }),
      await call('hermes:gateways:copySecret', { id }),
      await call('hermes:gateways:rotate', { id }),
    ];
    await settle();
    const secrets = [gateways.gatewaySecret(id), gateways.gatewaySecret(gateways.DEFAULT_GATEWAY)];
    for (const answer of answers) {
      for (const secret of secrets) expect(JSON.stringify(answer)).not.toContain(secret);
    }
  });
});
