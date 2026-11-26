// Install and reader tokens: 32 random bytes, base64url, behind a prefix that says what the token
// opens. Only the SHA-256 is stored. The tokens are random, not chosen by a person, so a plain
// SHA-256 is enough: there is nothing to guess, and a lookup by hash needs no comparison loop.
import { createHash, randomBytes } from 'node:crypto';

export type TokenKind = 'install' | 'reader';
const PREFIX: Record<TokenKind, string> = { install: 'tbi_', reader: 'tbr_' };
const SHAPE: Record<TokenKind, RegExp> = { install: /^tbi_[A-Za-z0-9_-]{43}$/, reader: /^tbr_[A-Za-z0-9_-]{43}$/ };

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function mintToken(kind: TokenKind): { token: string; hash: Buffer } {
  const token = PREFIX[kind] + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** The hash of the one Bearer token in an Authorization header, if it is a well-formed token of that kind. */
export function bearerHash(header: string | undefined, kind: TokenKind): Buffer | null {
  if (!header) return null;
  const m = /^[Bb]earer ([^\s]+)$/.exec(header);
  if (!m?.[1] || !SHAPE[kind].test(m[1])) return null;
  return hashToken(m[1]);
}
