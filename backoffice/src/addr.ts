// The client address the limits are keyed on.
//
// Behind the documented deploy, nginx sets X-Real-IP from Cloudflare's CF-Connecting-IP, and only
// for connections that come from Cloudflare's published ranges (real_ip_header with
// set_real_ip_from, deploy/nginx.conf). So X-Real-IP is "CF-Connecting-IP from Cloudflare's
// ranges only". The process believes it only from the local proxy itself (a loopback peer): a
// client that reached the process around nginx could otherwise name a new address on every
// request and never run out of tries.
import { isIP } from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function clientAddress(trustProxy: boolean, peer: string, realIp: string | undefined): string {
  if (!trustProxy || !LOOPBACK.has(peer) || !realIp || realIp.length > 45 || !isIP(realIp)) return peer;
  return realIp;
}
