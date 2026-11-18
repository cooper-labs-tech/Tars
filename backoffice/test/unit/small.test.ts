// Three small units: the read cursor, the per-install rate limit, the owner's password.
//
// Ways each can fail, written before the code:
// cursor.ts
//   1. A garbage, negative or oversized cursor is taken as a position (or throws) instead of
//      being refused.
//   2. A cursor does not round-trip, so a reader skips or repeats changes.
// ratelimit.ts
//   3. More than the burst passes at once.
//   4. A refused call gives no Retry-After, or one of 0.
//   5. Tokens never come back with time, or come back faster than the rate.
//   6. One key's use is charged to another key.
// password.ts
//   7. A wrong password is accepted.
//   8. A malformed stored hash throws, or accepts anything.
//   9. Two hashes of one password are equal (no salt), or a hash holds the password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../../src/cursor.ts';
import { RateLimiter } from '../../src/ratelimit.ts';
import { hashPassword, verifyPassword } from '../../src/password.ts';

test('1. bad cursors are refused', () => {
  for (const c of ['%%%', 'abc', encodeCursor(5n) + 'x', Buffer.from('-4').toString('base64url'), Buffer.from('9'.repeat(30)).toString('base64url'), Buffer.from('1.5').toString('base64url')]) {
    assert.equal(decodeCursor(c), null, c);
  }
  assert.equal(decodeCursor(undefined), 0n);
  assert.equal(decodeCursor(''), 0n);
});

test('2. cursors round-trip', () => {
  for (const n of [0n, 1n, 123456789012n, 9223372036854775807n]) assert.equal(decodeCursor(encodeCursor(n)), n);
});

test('3, 4, 5, 6. the rate limit', () => {
  let now = 0;
  const rl = new RateLimiter(() => now);
  const cfg = { perMinute: 60, burst: 3 };
  const r = [1, 2, 3, 4].map(() => rl.take('a', cfg));
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, false]);
  assert.ok(!r[3]!.ok && r[3]!.retryAfter >= 1);
  assert.equal(rl.take('b', cfg).ok, true, 'another key is not charged');
  now += 500;
  assert.equal(rl.take('a', cfg).ok, false, 'faster than the rate');
  now += 600;
  assert.equal(rl.take('a', cfg).ok, true, 'one token back after a second');
  rl.reset();
  assert.equal(rl.take('a', cfg).ok, true);
});

test('7, 8, 9. the owner password', async () => {
  const h1 = await hashPassword('s3cret pass');
  const h2 = await hashPassword('s3cret pass');
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes('s3cret'));
  assert.equal(await verifyPassword('s3cret pass', h1), true);
  assert.equal(await verifyPassword('s3cret pasS', h1), false);
  assert.equal(await verifyPassword('', h1), false);
  for (const bad of ['', 'scrypt$', 'plain', 'scrypt$1$2$3$zz$zz', h1.slice(0, -4)]) assert.equal(await verifyPassword('s3cret pass', bad), false, bad);
});
