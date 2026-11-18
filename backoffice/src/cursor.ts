// The readers' cursor: an opaque base64url of a position in the change sequence.
const MAX = 9223372036854775807n; // a Postgres bigint

export function encodeCursor(n: bigint): string {
  return Buffer.from(n.toString()).toString('base64url');
}

/** 0 for no cursor, the position for a valid one, null for anything else. */
export function decodeCursor(c: string | undefined | null): bigint | null {
  if (c === undefined || c === null || c === '') return 0n;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(c)) return null;
  const s = Buffer.from(c, 'base64url').toString();
  if (!/^(0|[1-9][0-9]{0,18})$/.test(s) || Buffer.from(s).toString('base64url') !== c) return null;
  const n = BigInt(s);
  return n <= MAX ? n : null;
}
