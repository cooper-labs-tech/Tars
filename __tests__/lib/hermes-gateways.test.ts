import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import { allowedProjects, chipsOf, gatewayAddresses, gatewayCaption, notSavedLine, projectPicks, projectsLine } from '@/lib/hermes-gateways';

/**
 * What Settings, Hermes, Gateways says of each gateway (2.0.4, the window of #469; frames `Gateways · Settings,
 * Hermes` and `· states`). Written before the code. Every way it can be wrong:
 * 1. A gateway's caption: its name not in capitals, or its id and route not the gateway's own.
 * 2. No connection info yet: an address made up from nothing.
 * 3. Tailscale serves Tars: the tailnet address not https, not on the tailnet's name, or another gateway's route.
 * 4. Tailscale running without serve, installed but stopped, or absent, or serve on with no tailnet name: a tailnet
 *    address shown that no Hermes elsewhere can reach, or a line that does not say which.
 * 5. The address on this machine: a port other than the one main answers, or another gateway's route.
 * 6. The projects a gateway reaches: a project Tars lists named otherwise than Tars names it; one Tars no longer lists
 *    lost from the chips or from the pick list (it could not be unticked then); a path with a trailing slash taken
 *    for another project; one allowed twice shown twice; so many that their chips run out of the row instead of the
 *    first ones and how many more.
 * 7. The Projects row: a gateway reaching nothing not said in the waiting tone, or one reaching some said to reach none.
 * 8. A refused save: a folder Tars may not write said as main's raw error, another reason lost, or no reason at all
 *    read as a save that went through.
 */

const gw = (id: string, label: string, projects: string[] = []) => ({
  id, label, projects, path: id === 'default' ? '/api/webhooks/hermes' : `/api/webhooks/hermes/${id}`,
});
const SERVED = { apiPort: 31415, tailscale: { installed: true, running: true, dnsName: 'mac.tailnet.ts.net', serveConfigured: true } };

describe('gatewayCaption', () => {
  it('writes the name in capitals, then its id and its own route (1)', () => {
    expect(gatewayCaption(gw('default', 'Hermes'))).toEqual({ title: 'HERMES', sub: 'default · /api/webhooks/hermes' });
    expect(gatewayCaption(gw('gw-3f9a1c', 'Hermes on the VPS'))).toEqual({
      title: 'HERMES ON THE VPS', sub: 'gw-3f9a1c · /api/webhooks/hermes/gw-3f9a1c',
    });
    expect(gatewayCaption(gw('gw-00aa11', 'Hermès du bureau')).title).toBe('HERMÈS DU BUREAU');
  });
});

describe('gatewayAddresses', () => {
  it('makes up no address before main answers (2)', () => {
    expect(gatewayAddresses(null, '/api/webhooks/hermes')).toEqual({ tailnet: null, local: null, line: 'reading the tailnet…' });
  });

  it("gives the tailnet address on the tailnet's name and the gateway's own route when Tailscale serves Tars (3)", () => {
    expect(gatewayAddresses(SERVED, '/api/webhooks/hermes/gw-3f9a1c')).toEqual({
      tailnet: 'https://mac.tailnet.ts.net/api/webhooks/hermes/gw-3f9a1c',
      local: 'http://127.0.0.1:31415/api/webhooks/hermes/gw-3f9a1c',
      line: 'tailscale serve active · mac.tailnet.ts.net: a Hermes on another machine posts here.',
    });
  });

  it('gives no tailnet address Tailscale does not serve, and says why (4)', () => {
    const at = (tailscale: typeof SERVED.tailscale) => gatewayAddresses({ apiPort: 31415, tailscale }, '/api/webhooks/hermes');
    const running = at({ installed: true, running: true, dnsName: 'mac.tailnet.ts.net', serveConfigured: false });
    expect(running.tailnet).toBeNull();
    expect(running.line).toBe('tailscale running · the API still only listens on this machine');
    const stopped = at({ installed: true, running: false, serveConfigured: false });
    expect(stopped.tailnet).toBeNull();
    expect(stopped.line).toBe('tailscale installed but not running');
    const none = at({ installed: false, running: false, serveConfigured: false });
    expect(none.tailnet).toBeNull();
    expect(none.line).toBe('no tailscale · a Hermes on another machine cannot reach this one');
    const nameless = at({ installed: true, running: true, serveConfigured: true });
    expect(nameless.tailnet).toBeNull();
    expect(nameless.line).toBe('tailscale serve active, without a tailnet name: a Hermes on another machine cannot reach this one');
  });

  it("gives the address on this machine on main's port and the gateway's route (5)", () => {
    expect(gatewayAddresses({ ...SERVED, apiPort: 34698 }, '/api/webhooks/hermes').local).toBe('http://127.0.0.1:34698/api/webhooks/hermes');
    expect(gatewayAddresses({ apiPort: 31415, tailscale: { installed: false, running: false, serveConfigured: false } }, '/api/webhooks/hermes/gw-3f9a1c').local)
      .toBe('http://127.0.0.1:31415/api/webhooks/hermes/gw-3f9a1c');
  });
});

describe('allowedProjects and projectPicks', () => {
  const known = [
    { path: '/Users/you/code/tars', name: 'tars' },
    { path: '/Users/you/code/harbor-billing', name: 'Harbor billing' },
    { path: '/Users/you/code/landing-site', name: 'landing-site' },
  ];

  it("names a project as Tars names it, one Tars no longer lists by its folder, each once, a trailing slash the same (6)", () => {
    expect(allowedProjects(['/Users/you/code/harbor-billing/', '/Users/you/old/gone', '/Users/you/code/harbor-billing'], known)).toEqual([
      { path: '/Users/you/code/harbor-billing/', name: 'Harbor billing' },
      { path: '/Users/you/old/gone', name: 'gone' },
    ]);
    expect(allowedProjects([], known)).toEqual([]);
  });

  it('lists every project Tars lists, ticked as the gateway reaches it, then those it reaches that Tars no longer lists (6)', () => {
    expect(projectPicks(['/Users/you/old/gone', '/Users/you/code/tars/'], known)).toEqual([
      { path: '/Users/you/code/tars', name: 'tars', ticked: true },
      { path: '/Users/you/code/harbor-billing', name: 'Harbor billing', ticked: false },
      { path: '/Users/you/code/landing-site', name: 'landing-site', ticked: false },
      { path: '/Users/you/old/gone', name: 'gone', ticked: true },
    ]);
  });
});

describe('chipsOf', () => {
  it('shows up to three projects whole, and of more the first two and how many others (6)', () => {
    expect(chipsOf([])).toEqual({ shown: [], more: 0 });
    expect(chipsOf(['tars', 'harbor-billing', 'landing-site'])).toEqual({ shown: ['tars', 'harbor-billing', 'landing-site'], more: 0 });
    expect(chipsOf(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b'], more: 3 });
  });
});

describe('projectsLine', () => {
  it('says a gateway reaching nothing in the waiting tone, and one reaching some what the others get (7)', () => {
    expect(projectsLine(0)).toEqual({ hint: 'Reaches no project yet. Its Hermes jobs get not found until you allow one.', waiting: true });
    expect(projectsLine(2)).toEqual({ hint: 'A job for any other project is answered not found.', waiting: false });
  });
});

describe('notSavedLine', () => {
  it("says a folder Tars may not write in the page's words, main's own reason otherwise, and not saved always (8)", () => {
    expect(notSavedLine("EACCES: permission denied, open '/Users/you/.tars-private/hermes-gateways.json.tmp'"))
      .toBe('Not saved: Tars could not write its private settings (permission denied).');
    expect(notSavedLine("EPERM: operation not permitted, rename '/Users/you/.tars-private/x.tmp'"))
      .toBe('Not saved: Tars could not write its private settings (permission denied).');
    expect(notSavedLine("ENOSPC: no space left on device, write"))
      .toBe('Not saved: Tars could not write its private settings (the disk is full).');
    expect(notSavedLine('There is no such gateway.')).toBe('Not saved: There is no such gateway.');
    expect(notSavedLine(undefined)).toBe('Not saved.');
    expect(notSavedLine('')).toBe('Not saved.');
  });
});
