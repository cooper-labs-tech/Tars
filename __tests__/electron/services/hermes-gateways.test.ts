import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The Hermes gateways Tars takes work from, and the secret each one holds (the Audit's NOW-3 and R4.3, 2.0.4).
 *
 * Until 2.0.4 one secret, `~/.tars-private/hermes-webhook-secret`, opened `POST /api/webhooks/hermes` for whoever held
 * it: the user's Hermes on this machine, a Hermes on a VPS, anyone on the tailnet who read that gateway's config. Each
 * gateway now has its own secret and its own route, and reaches the projects the user allows it, none until then.
 *
 * The ways it fails:
 * 1. One secret for every gateway: whoever holds gateway A's dispatches as gateway B, and B cannot be cut off without
 *    A. Each gateway has its own, minted from 32 random bytes (64 hex), in its own file of the private folder, 0600 in
 *    a 0700 folder, and never in ~/.dorothy, which every agent is handed.
 * 2. A rotated secret still opening, or a removed gateway's: its file left behind, or the old value still matched.
 * 3. The secret the Hermes of before 2.0.4 holds lost: its jobs stop. The default gateway keeps
 *    `~/.tars-private/hermes-webhook-secret` as it is.
 * 4. A gateway id that names a file outside the private folder, or a route other than its own: an id is `default`
 *    or `gw-` and 6 hex, and anything else is refused, never written.
 * 5. A gateway reaching a project the user did not allow: a gateway added, and the default one, reach none until
 *    the user allows some. A list that is not absolute paths is refused.
 * 6. What a gateway may reach kept where an agent can change it: the list is in the private folder, 0600.
 * 7. A presented secret matched loosely: empty, another gateway's, a prefix of one, or one of another length.
 * 8. A registry that cannot be read opening anything but the default gateway, with nothing allowed, or crashing the
 *    door.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gateways-data-'));
const privateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-gateways-private-')), 'private');
const SECRET_FILE = path.join(privateDir, 'hermes-webhook-secret');
const REGISTRY = path.join(privateDir, 'hermes-gateways.json');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual,
    DATA_DIR: dataDir,
    HERMES_WEBHOOK_SECRET_FILE: SECRET_FILE,
    HERMES_WEBHOOK_SECRET_LEGACY_FILE: path.join(dataDir, 'hermes-webhook-secret'),
    HERMES_GATEWAYS_FILE: REGISTRY,
  };
});

type Gateways = typeof import('../../../electron/services/hermes-gateways');
let g: Gateways;

beforeEach(async () => {
  fs.rmSync(privateDir, { recursive: true, force: true });
  vi.resetModules();
  g = await import('../../../electron/services/hermes-gateways');
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(privateDir), { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("a gateway's own secret", () => {
  it('1. each gateway has its own, 64 hex, in a 0600 file of the 0700 private folder, never in the data folder', () => {
    const vps = g.addGateway('VPS');
    const laptop = g.addGateway('Laptop');
    const a = g.gatewaySecret(vps.id);
    const b = g.gatewaySecret(laptop.id);
    const d = g.gatewaySecret(g.DEFAULT_GATEWAY);
    for (const secret of [a, b, d]) expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a, b, d]).size).toBe(3);
    expect(g.gatewayOfSecret(a)).toBe(vps.id);
    expect(g.gatewayOfSecret(b)).toBe(laptop.id);
    expect(g.gatewayOfSecret(d)).toBe(g.DEFAULT_GATEWAY);
    const files = fs.readdirSync(privateDir).filter(f => f.startsWith('hermes-webhook-'));
    expect(files.sort()).toEqual([`hermes-webhook-${laptop.id}.secret`, 'hermes-webhook-secret', `hermes-webhook-${vps.id}.secret`].sort());
    if (hasPosixModes()) {
      for (const f of files) expect(mode(path.join(privateDir, f)), f).toBe(0o600);
      expect(mode(privateDir)).toBe(0o700);
    }
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it('2. rotated, the old secret opens nothing; removed, the gateway and its file are gone', () => {
    const vps = g.addGateway('VPS');
    const old = g.gatewaySecret(vps.id);
    const fresh = g.rotateGatewaySecret(vps.id);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    expect(g.gatewayOfSecret(old)).toBeUndefined();
    expect(g.gatewayOfSecret(fresh)).toBe(vps.id);

    expect(g.removeGateway(vps.id)).toBe(true);
    expect(g.gatewayOfSecret(fresh)).toBeUndefined();
    expect(g.gatewayById(vps.id)).toBeUndefined();
    expect(fs.existsSync(path.join(privateDir, `hermes-webhook-${vps.id}.secret`))).toBe(false);
    expect(g.removeGateway(g.DEFAULT_GATEWAY), 'the default gateway is not removed').toBe(false);
  });

  it('3. the default gateway keeps the secret the Hermes of before holds, and its file', () => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const held = 'a'.repeat(64);
    fs.writeFileSync(SECRET_FILE, held, { mode: 0o600 });
    expect(g.gatewaySecret(g.DEFAULT_GATEWAY)).toBe(held);
    expect(g.gatewayOfSecret(held)).toBe(g.DEFAULT_GATEWAY);
    const rotated = g.rotateGatewaySecret(g.DEFAULT_GATEWAY);
    expect(fs.readFileSync(SECRET_FILE, 'utf8').trim()).toBe(rotated);
    expect(g.gatewayOfSecret(held)).toBeUndefined();
  });

  it('7. matched whole: empty, a prefix, another length, or nothing on file opens nothing', () => {
    const vps = g.addGateway('VPS');
    const a = g.gatewaySecret(vps.id);
    for (const presented of ['', a.slice(0, 63), `${a}0`, a.toUpperCase(), ' '.repeat(64)]) {
      expect(g.gatewayOfSecret(presented), JSON.stringify(presented)).toBeUndefined();
    }
  });
});

describe('which gateways there are, and what each reaches', () => {
  it('4. an id is default or gw- and 6 hex: anything else is refused and writes nothing', () => {
    for (const id of ['../x', 'default/../x', 'gw-1a2b3c/..', 'GW-1A2B3C', 'gw-1a2b3', '', 'gw-zzzzzz', '..\\x']) {
      expect(g.isGatewayId(id), id).toBe(false);
      expect(() => g.rotateGatewaySecret(id), id).toThrow();
      expect(() => g.setGatewayProjects(id, []), id).toThrow();
    }
    expect(g.isGatewayId('default')).toBe(true);
    expect(g.isGatewayId(g.addGateway('VPS').id)).toBe(true);
    expect(fs.readdirSync(privateDir).filter(f => f.includes('..'))).toEqual([]);
  });

  it("5. a gateway added, and the default one, reach no project until the user allows some", () => {
    const vps = g.addGateway('VPS');
    expect(g.gatewayById(vps.id)!.projects).toEqual([]);
    expect(g.gatewayById(g.DEFAULT_GATEWAY)!.projects).toEqual([]);
    expect(g.gatewayReaches(g.gatewayById(vps.id)!, '/projects/alpha')).toBe(false);

    g.setGatewayProjects(vps.id, ['/projects/alpha']);
    expect(g.gatewayReaches(g.gatewayById(vps.id)!, '/projects/alpha')).toBe(true);
    expect(g.gatewayReaches(g.gatewayById(vps.id)!, '/projects/alpha/../beta')).toBe(false);
    expect(g.gatewayReaches(g.gatewayById(vps.id)!, '/projects/beta')).toBe(false);
    expect(g.gatewayReaches(g.gatewayById(g.DEFAULT_GATEWAY)!, '/projects/alpha'), "another gateway's list").toBe(false);
  });

  it('5. a list that is not absolute paths is refused, and the list as it was is kept', () => {
    const vps = g.addGateway('VPS');
    g.setGatewayProjects(vps.id, ['/projects/alpha']);
    for (const bad of [['relative/path'], [''], [42], 'not a list', [null]]) {
      expect(() => g.setGatewayProjects(vps.id, bad as never), JSON.stringify(bad)).toThrow();
    }
    expect(g.gatewayById(vps.id)!.projects).toEqual(['/projects/alpha']);
  });

  it('6. the list is in the private folder, 0600, read back by a fresh start', async () => {
    const vps = g.addGateway('VPS');
    g.setGatewayProjects(vps.id, ['/projects/alpha', '/projects/alpha']);
    if (hasPosixModes()) expect(mode(REGISTRY)).toBe(0o600);
    vi.resetModules();
    const again: Gateways = await import('../../../electron/services/hermes-gateways');
    expect(again.gatewayById(vps.id)).toMatchObject({ id: vps.id, label: 'VPS', projects: ['/projects/alpha'] });
  });

  it('8. a registry that cannot be read: the default gateway alone, reaching nothing, and no throw', () => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(REGISTRY, '{ not json', { mode: 0o600 });
    expect(g.listGateways().map(x => x.id)).toEqual([g.DEFAULT_GATEWAY]);
    expect(g.gatewayById(g.DEFAULT_GATEWAY)!.projects).toEqual([]);
    expect(g.gatewayOfSecret('f'.repeat(64))).toBeUndefined();
  });
});

describe('the route a gateway posts to', () => {
  it('is its own: /api/webhooks/hermes for the default, /api/webhooks/hermes/<id> for another; nothing else is one', () => {
    const vps = g.addGateway('VPS');
    expect(g.gatewayOfPath('/api/webhooks/hermes')).toBe(g.DEFAULT_GATEWAY);
    expect(g.gatewayOfPath(`/api/webhooks/hermes/${vps.id}`)).toBe(vps.id);
    for (const p of ['/api/webhooks/hermes/', '/api/webhooks/hermes/default', '/api/webhooks/hermes/../agents', `/api/webhooks/hermes/${vps.id}/x`, '/api/agents/x/dispatch']) {
      expect(g.gatewayOfPath(p), p).toBeUndefined();
    }
  });
});
