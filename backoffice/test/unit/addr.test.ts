// addr.ts: the client address the limits are keyed on.
//
// Ways it can fail, written before the code (the Audit's L2 on #597):
// 1. X-Real-IP is believed from a peer that is not the local proxy, so a client that reaches the
//    process around nginx names a new address with each request and never runs out of tries.
// 2. X-Real-IP is believed while the operator did not say a proxy is in front.
// 3. A malformed or oversized header is used as a key.
// 4. The local proxy's header is ignored, so every client shares the proxy's one address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../../src/addr.ts';

test('1. only the local proxy is believed', () => {
  assert.equal(clientAddress(true, '203.0.113.9', '198.51.100.1'), '203.0.113.9');
  assert.equal(clientAddress(true, '::ffff:203.0.113.9', '198.51.100.1'), '::ffff:203.0.113.9');
});

test('2. not without the operator saying so', () => {
  assert.equal(clientAddress(false, '127.0.0.1', '198.51.100.1'), '127.0.0.1');
});

test('3. malformed headers are not keys', () => {
  for (const h of ['', 'not an ip', '198.51.100.1, 198.51.100.2', 'x'.repeat(100), '1.2.3']) {
    assert.equal(clientAddress(true, '127.0.0.1', h), '127.0.0.1', h);
  }
});

test('4. the local proxy passes the client on', () => {
  assert.equal(clientAddress(true, '127.0.0.1', '198.51.100.1'), '198.51.100.1');
  assert.equal(clientAddress(true, '::1', '2001:db8::1'), '2001:db8::1');
  assert.equal(clientAddress(true, '::ffff:127.0.0.1', '198.51.100.1'), '198.51.100.1');
});
