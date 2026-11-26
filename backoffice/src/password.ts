// The operator's password, kept as an scrypt hash: scrypt$N$r$p$salt$hash (base64url).
// Unlike the tokens, a password is chosen by a person, so it gets a slow, salted hash.
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((ok, fail) => scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? fail(e) : ok(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{43})$/.exec(stored ?? '');
  if (!m || !password) return false;
  const n = Number(m[1]), r = Number(m[2]), p = Number(m[3]);
  if (n < 2 ** 14 || n > 2 ** 20 || (n & (n - 1)) !== 0 || r < 1 || p < 1) return false;
  const want = Buffer.from(m[5]!, 'base64url');
  try {
    const got = await derive(password, Buffer.from(m[4]!, 'base64url'), n, r, p);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
