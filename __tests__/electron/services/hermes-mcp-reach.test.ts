import { describe, it, expect, vi } from 'vitest';
import { reachOf, tailnetAddressIn, NO_TOKEN_REFUSAL, type ReachDeps } from '../../../electron/services/hermes-mcp-reach';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * How Tars reaches each MCP server Hermes registered (2.0.4, "Memory in one picture", the Brain > Backends frames and
 * their notes for the Backend): the path that worked and its address on this Mac, or each path's answer when none did.
 *
 * How it fails, written before the code:
 * 1. Hermes runs on this Mac and a tunnel or Tailscale is tried anyway, or its loopback URL is called unreachable.
 * 2. A server whose URL is not Hermes's loopback (a public gbrain) is sent through a tunnel.
 * 3. Hermes's machine is on the tailnet and the server listens on its tailnet address, and a tunnel is opened anyway
 *    (the notes: "Tars uses that address and keeps no forward").
 * 4. Through the tunnel, the address loses the server's scheme or path, or keeps Hermes's own host and port.
 * 5. A server that answers through the tunnel without a token is handed out (R3.2): it must be refused with the
 *    Audit's reason, and its tunnel closed at once.
 * 6. Neither path works and the answer says one reason only, or none: each path's answer is kept for the window.
 * 7. A remote URL or Hermes Cloud (no shell, no tunnel) is promised a tunnel.
 * 8. Tailscale's own status is read wrong: Hermes's machine not found by its name, its DNS name or its address, an
 *    IPv6 address handed out where the server listens on IPv4, or a status that is not JSON taken for a tailnet.
 */

const ssh: HermesConnection = { mode: 'ssh', ssh: { host: 'hermes', user: 'jb', port: 22 } };
const gbrain = { name: 'gbrain', url: 'http://localhost:8484/mcp', gatewayLocal: true };

function deps(over: Partial<ReachDeps> = {}): ReachDeps & { opened: unknown[]; closed: unknown[] } {
  const opened: unknown[] = [];
  const closed: unknown[] = [];
  return {
    opened, closed,
    tunnel: vi.fn(async (_c, remote) => { opened.push(remote); return { ok: true as const, localPort: 62011 }; }),
    closeTunnel: vi.fn((_c, remote) => { closed.push(remote); }),
    tailnetAddress: vi.fn(async () => null),
    listens: vi.fn(async () => false),
    answersWithoutToken: vi.fn(async () => false),
    ...over,
  };
}

describe('the path to an MCP server Hermes registered', () => {
  it('1. Hermes on this Mac: its loopback is this Mac\'s, reached directly', async () => {
    const d = deps();
    expect(await reachOf({ mode: 'local', localPort: 9119 }, gbrain, d)).toEqual({ via: 'direct', address: 'http://localhost:8484/mcp' });
    expect(d.opened).toEqual([]);
  });

  it('2. a URL that is not Hermes\'s loopback is reached as it is', async () => {
    const d = deps();
    expect(await reachOf(ssh, { name: 'gbrain', url: 'https://gbrain.example/mcp', gatewayLocal: false }, d))
      .toEqual({ via: 'direct', address: 'https://gbrain.example/mcp' });
    expect(d.opened).toEqual([]);
  });

  it('3. Hermes on the tailnet, the server listening there: its tailnet address, and no tunnel', async () => {
    const d = deps({ tailnetAddress: vi.fn(async () => '100.101.12.4'), listens: vi.fn(async () => true) });
    expect(await reachOf(ssh, gbrain, d)).toEqual({ via: 'tailscale', address: 'http://100.101.12.4:8484/mcp' });
    expect(d.listens).toHaveBeenCalledWith('100.101.12.4', 8484);
    expect(d.opened).toEqual([]);
  });

  it('4. otherwise through the SSH tunnel: this Mac\'s loopback and the tunnel\'s port, the scheme and path kept', async () => {
    const d = deps();
    expect(await reachOf(ssh, gbrain, d)).toEqual({ via: 'tunnel', address: 'http://127.0.0.1:62011/mcp' });
    expect(d.opened).toEqual([{ host: 'localhost', port: 8484 }]);
  });

  it('5. a server that answers through the tunnel without a token is refused, and its tunnel closed at once', async () => {
    const d = deps({ answersWithoutToken: vi.fn(async () => true) });
    const reach = await reachOf(ssh, gbrain, d);

    expect(reach).toEqual({ via: 'none', why: NO_TOKEN_REFUSAL, answers: { tunnel: NO_TOKEN_REFUSAL, tailscale: expect.any(String) } });
    expect(NO_TOKEN_REFUSAL).toMatch(/answers without a token/);
    expect(d.closed).toEqual([{ host: 'localhost', port: 8484 }]);
  });

  it('6. neither path: each path\'s answer, and one sentence with both', async () => {
    const d = deps({
      tunnel: vi.fn(async () => ({ ok: false as const, why: 'ssh did not open the tunnel: hermes port 22: Connection refused' })),
      tailnetAddress: vi.fn(async () => '100.101.12.4'),
      listens: vi.fn(async () => false),
    });
    const reach = await reachOf(ssh, gbrain, d);

    expect(reach).toMatchObject({ via: 'none', answers: {
      tunnel: 'ssh did not open the tunnel: hermes port 22: Connection refused',
      tailscale: expect.stringMatching(/does not listen on 100\.101\.12\.4:8484/),
    } });
    expect((reach as { why: string }).why).toMatch(/Connection refused[\s\S]*100\.101\.12\.4/);
  });

  it('7. a remote URL or Hermes Cloud: no tunnel is promised', async () => {
    for (const conn of [{ mode: 'remote', url: 'https://hermes.example' }, { mode: 'cloud', url: 'https://cloud.example' }] as HermesConnection[]) {
      const d = deps();
      const reach = await reachOf(conn, gbrain, d);
      expect(reach).toMatchObject({ via: 'none', answers: { tunnel: expect.stringMatching(/SSH/) } });
      expect(d.opened).toEqual([]);
    }
  });
});

describe('Hermes\'s machine on the tailnet, as Tailscale\'s own status says', () => {
  const status = JSON.stringify({
    Self: { HostName: 'macbook', DNSName: 'macbook.tail1234.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c::1'] },
    Peer: {
      'nodekey:a': { HostName: 'hermes', DNSName: 'hermes.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c::5', '100.101.12.4'] },
      'nodekey:b': { HostName: 'nas', DNSName: 'nas.tail1234.ts.net.', TailscaleIPs: ['100.90.0.2'] },
    },
  });

  it('8. found by its name, its DNS name or one of its addresses, its IPv4 address handed out', () => {
    for (const host of ['hermes', 'HERMES', 'hermes.tail1234.ts.net', 'hermes.tail1234.ts.net.', '100.101.12.4', 'fd7a:115c::5']) {
      expect(tailnetAddressIn(status, host), host).toBe('100.101.12.4');
    }
  });

  it('8. not on the tailnet, or a status that is not Tailscale\'s: nothing', () => {
    expect(tailnetAddressIn(status, 'hermes.example')).toBeNull();
    expect(tailnetAddressIn('not json', 'hermes')).toBeNull();
    expect(tailnetAddressIn(JSON.stringify({ Peer: null }), 'hermes')).toBeNull();
  });
});
