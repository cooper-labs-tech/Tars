// The identity assertion an access proxy sets in front of /admin (Cloudflare Access sends it as
// Cf-Access-Jwt-Assertion). Checked here too, so an origin reached around the proxy still refuses
// the back-office pages. RS256 only; the keys come from the team's certs endpoint.
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

export interface AccessOptions { audience: string; issuer: string; now?: () => number }
export type Jwk = JsonWebKey & { kid?: string };

function part(s: string | undefined): Record<string, unknown> | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function verifyAccessJwt(token: string, keys: Jwk[], opts: AccessOptions): { email?: string; sub?: string } | null {
  const pieces = (token ?? '').split('.');
  if (pieces.length !== 3) return null;
  const [h, p, s] = pieces;
  const header = part(h);
  const claims = part(p);
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || !s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!ok) return null;
  } catch {
    return null;
  }
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience) || claims.iss !== opts.issuer) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 30) return null;
  return { email: typeof claims.email === 'string' ? claims.email : undefined, sub: typeof claims.sub === 'string' ? claims.sub : undefined };
}

/** The team's keys, fetched from <issuer>/cdn-cgi/access/certs and kept for an hour. */
export class AccessKeys {
  private keys: Jwk[] = [];
  private at = 0;
  private issuer: string;
  constructor(issuer: string) { this.issuer = issuer; }
  async get(force = false): Promise<Jwk[]> {
    if (!force && this.keys.length && Date.now() - this.at < 3_600_000) return this.keys;
    const res = await fetch(`${this.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`access certs: ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    this.keys = Array.isArray(body.keys) ? body.keys : [];
    this.at = Date.now();
    return this.keys;
  }
}
