// tokens.ts: the install and reader tokens.
//
// Ways it can fail, written before the code:
// 1. What is stored (the hash) equals or contains the token, so a database leak hands out tokens.
// 2. A reader token is accepted where an install token is asked for, or the reverse.
// 3. A token with the right prefix but the wrong length or alphabet gets through to a lookup.
// 4. Two mints give the same token (weak randomness).
// 5. A header that is not "Bearer <token>" (another scheme, two tokens, nothing) yields a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, bearerHash, hashToken } from '../../src/tokens.ts';

test('1. the stored hash never contains the token', () => {
  const { token, hash } = mintToken('install');
  assert.equal(hash.length, 32);
  assert.ok(!hash.toString('hex').includes(token.slice(4)));
  assert.ok(!hash.toString('latin1').includes(token.slice(4, 20)));
  assert.deepEqual(hashToken(token), hash);
});

test('2. a token opens only its own kind', () => {
  const i = mintToken('install');
  const r = mintToken('reader');
  assert.match(i.token, /^tbi_/);
  assert.match(r.token, /^tbr_/);
  assert.deepEqual(bearerHash(`Bearer ${i.token}`, 'install'), i.hash);
  assert.equal(bearerHash(`Bearer ${i.token}`, 'reader'), null);
  assert.equal(bearerHash(`Bearer ${r.token}`, 'install'), null);
});

test('3. a malformed token is refused before any lookup', () => {
  const { token } = mintToken('install');
  for (const bad of [token.slice(0, -1), token + 'A', token.replace(/.$/, '!'), 'tbi_', 'tbi_' + 'a'.repeat(200)]) {
    assert.equal(bearerHash(`Bearer ${bad}`, 'install'), null, bad);
  }
});

test('4. mints differ', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(mintToken('reader').token);
  assert.equal(seen.size, 1000);
});

test('5. only one Bearer token is read', () => {
  const { token, hash } = mintToken('install');
  assert.deepEqual(bearerHash(`bearer ${token}`, 'install'), hash);
  for (const bad of [undefined, '', token, `Basic ${token}`, `Bearer ${token} ${token}`, `Bearer  ${token}`, `Token ${token}`]) {
    assert.equal(bearerHash(bad, 'install'), null, String(bad));
  }
});
