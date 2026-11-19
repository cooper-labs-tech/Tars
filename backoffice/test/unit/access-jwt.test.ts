// access-jwt.ts: checking the identity assertion an access proxy (Cloudflare Access) puts in
// front of /admin, when the operator configures one.
//
// Ways it can fail, written before the code:
// 1. alg "none", or HS256 signed with the public key as a secret, is accepted.
// 2. A token for another audience or another issuer is accepted.
// 3. An expired token, or one not valid yet, is accepted.
// 4. A token signed by a key that is not in the key set (unknown kid, or a known kid with another
//    key's signature) is accepted.
// 5. Malformed input (two parts, bad base64, a non-object payload) throws instead of failing.
// 6. A valid token is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { verifyAccessJwt } from '../../src/access-jwt.ts';

const k1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk1 = { ...k1.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const keys = [jwk1];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = 1_800_000_000;
const opts = { audience: 'aud-1', issuer: 'https://team.example.com', now: () => now * 1000 };
const claims = { aud: ['aud-1'], iss: 'https://team.example.com', email: 'owner@example.com', exp: now + 60, iat: now - 5, nbf: now - 5 };
function sign(header: object, payload: object, key = k1.privateKey) {
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(key).toString('base64url')}`;
}

test('6. a valid token passes', () => {
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, claims), keys, opts)?.email, 'owner@example.com');
});

test('1. no alg none, no HS256', () => {
  assert.equal(verifyAccessJwt(`${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.`, keys, opts), null);
  const data = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(claims)}`;
  const pem = k1.publicKey.export({ format: 'pem', type: 'spki' });
  assert.equal(verifyAccessJwt(`${data}.${createHmac('sha256', pem).update(data).digest('base64url')}`, keys, opts), null);
});

test('2. audience and issuer', () => {
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, { ...claims, aud: ['other'] }), keys, opts), null);
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, { ...claims, iss: 'https://evil.example.com' }), keys, opts), null);
});

test('3. time', () => {
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, { ...claims, exp: now - 1 }), keys, opts), null);
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, { ...claims, nbf: now + 120 }), keys, opts), null);
});

test('4. keys', () => {
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k9' }, claims, k1.privateKey), keys, opts), null);
  assert.equal(verifyAccessJwt(sign({ alg: 'RS256', kid: 'k1' }, claims, k2.privateKey), keys, opts), null);
});

test('5. malformed input fails quietly', () => {
  for (const t of ['', 'a.b', 'a.b.c', `${b64({ alg: 'RS256', kid: 'k1' })}.${Buffer.from('[1]').toString('base64url')}.x`, '...']) {
    assert.equal(verifyAccessJwt(t, keys, opts), null, t);
  }
});
