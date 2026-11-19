// body.ts: decoding a request body under its two limits.
//
// Ways it can fail, written before the code:
// 1. A body over the wire limit is accepted.
// 2. A small gzip or zstd body that expands past the decoded limit (a bomb) is accepted, or is
//    expanded in full in memory before being refused.
// 3. An encoding other than identity, gzip or zstd (br, deflate, a list of two) is accepted.
// 4. A corrupt compressed body throws something other than a 400 the server can answer with.
// 5. An identity body is altered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, zstdCompressSync, deflateSync } from 'node:zlib';
import { decodeBody, HttpError } from '../../src/body.ts';

const limits = { wire: 1024, decoded: 64 * 1024 };
const status = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof HttpError ? `${e.status} ${e.code}` : `not an HttpError: ${e}`; }
  return 'accepted';
};

test('1. over the wire limit', () => {
  assert.equal(status(() => decodeBody(Buffer.alloc(1025), undefined, limits)), '413 too_large');
});

test('2. a bomb is refused, and not expanded in full', () => {
  const bomb = Buffer.alloc(50 * 1024 * 1024);
  for (const enc of ['gzip', 'zstd']) {
    const packed = enc === 'gzip' ? gzipSync(bomb) : zstdCompressSync(bomb);
    assert.ok(packed.length < 1024 * 64, `${enc} bomb is small on the wire`);
    const before = process.memoryUsage().arrayBuffers;
    assert.equal(status(() => decodeBody(packed, enc, { wire: 1024 * 1024, decoded: limits.decoded })), '413 too_large', enc);
    assert.ok(process.memoryUsage().arrayBuffers - before < 20 * 1024 * 1024, `${enc} expanded in memory`);
  }
});

test('3. only identity, gzip and zstd', () => {
  const data = Buffer.from('hello');
  assert.equal(status(() => decodeBody(deflateSync(data), 'deflate', limits)), '400 bad_encoding');
  assert.equal(status(() => decodeBody(data, 'br', limits)), '400 bad_encoding');
  assert.equal(status(() => decodeBody(gzipSync(gzipSync(data)), 'gzip, gzip', limits)), '400 bad_encoding');
  assert.equal(decodeBody(gzipSync(data), 'GZIP', limits).toString(), 'hello');
  assert.equal(decodeBody(zstdCompressSync(data), 'zstd', limits).toString(), 'hello');
});

test('4. corrupt bodies are a 400', () => {
  assert.equal(status(() => decodeBody(Buffer.from('not gzip'), 'gzip', limits)), '400 bad_encoding');
  assert.equal(status(() => decodeBody(Buffer.from('not zstd'), 'zstd', limits)), '400 bad_encoding');
});

test('5. identity is untouched', () => {
  const data = Buffer.from([0, 1, 2, 255]);
  assert.ok(decodeBody(data, undefined, limits).equals(data));
  assert.ok(decodeBody(data, 'identity', limits).equals(data));
});
