/**
 * Receipts for requests sent with a clientRequestId (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.4 item 1; DESIGN-REVIEW-CHATS.md L1): electron/services/request-receipts.ts.
 *
 * An MCP tool call that timed out at 30 s was called again, and the worker got
 * the same work typed in twice. A receipt keyed by the caller and the id it
 * sent answers a retry with the first outcome, and nothing is sent again.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A retry with the same id and payload is sent again: nothing was kept, or
 *    it was kept and not read.
 * 2. Two callers that happen to send the same id collide: one's receipt
 *    answers the other's request. The key is the caller and the id.
 * 3. The same id with another payload is taken for a retry (answered with an
 *    outcome that was never its own) or sent: it must be refused as a conflict.
 * 4. The message text, or any field beyond the outcome's ids and states, is
 *    written to the file.
 * 5. A receipt older than 24 h still answers, or the file only ever grows.
 * 6. A retry that arrives while the first call is still being answered is
 *    sent again.
 * 7. A first call that did nothing (refused before anything was typed) is
 *    remembered, and its retry is answered with the refusal and never tried.
 * 8. The file can be read by others, or is written in place: a crash mid-write
 *    leaves a torn file that loses every receipt. A damaged line loses more
 *    than itself.
 * 9. A store opened again (a relaunch) has forgotten what it kept.
 * 10. A malformed id (empty, too long, with a space or a control character)
 *     is accepted as a key.
 * 11. An outcome updated later (a delegated run that ends) loses what it
 *     already held, or the update reaches another caller's receipt.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createReceiptStore, payloadHash, clientRequestIdOf, RECEIPT_TTL_MS } from '../../../electron/services/request-receipts';

let dir: string;
let file: string;
let clock: number;
const now = () => clock;
const open = () => createReceiptStore({ file, now });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
  file = path.join(dir, 'private', 'request-receipts.jsonl');
  clock = Date.parse('2026-10-12T10:00:00Z');
});

const hashA = payloadHash({ route: 'dispatch', target: 'w1', message: 'SECRET-TEXT review #280' });
const hashB = payloadHash({ route: 'dispatch', target: 'w1', message: 'another text' });
const typed = { status: 200, body: { success: true, mode: 'message', taskRef: 't-0123abcd', agent: { id: 'w1', name: 'Worker', status: 'running' } } };

describe('a request sent with a clientRequestId', () => {
  it('1. its retry gets the first outcome, marked a duplicate, and is not sent again', () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    expect(first.kind).toBe('new');
    if (first.kind === 'new') first.settle(typed);
    const again = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    expect(again).toEqual({ kind: 'duplicate', outcome: typed });
  });

  it('2. the same id from another caller is a request of its own', () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    if (first.kind === 'new') first.settle(typed);
    expect(store.begin({ caller: 'b1', id: 'cr-1' }, hashA).kind).toBe('new');
    expect(store.begin({ caller: 'tars', id: 'cr-1' }, hashB).kind).toBe('new');
  });

  it('3. the same id with another payload is a conflict, done or in flight', () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    expect(store.begin({ caller: 'o1', id: 'cr-1' }, hashB)).toEqual({ kind: 'conflict' });
    if (first.kind === 'new') first.settle(typed);
    expect(store.begin({ caller: 'o1', id: 'cr-1' }, hashB)).toEqual({ kind: 'conflict' });
  });

  it('4. the file holds the key, the hash and the outcome, never the text nor fields beyond the outcome', () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    if (first.kind === 'new') first.settle({ status: 200, body: { ...typed.body, message: 'SECRET-TEXT review #280', text: 'reply SECRET', heldReason: 'x' } });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('cr-1');
    expect(raw).toContain(hashA);
    expect(raw).not.toMatch(/SECRET|review #280|heldReason/);
    const again = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    expect(again.kind === 'duplicate' && again.outcome.body).toEqual(typed.body);
  });

  it('5. a receipt older than 24 h is gone, from the answers and from the file', () => {
    const store = open();
    const old = store.begin({ caller: 'o1', id: 'cr-old' }, hashA);
    if (old.kind === 'new') old.settle(typed);
    clock += RECEIPT_TTL_MS + 1;
    const fresh = store.begin({ caller: 'o1', id: 'cr-new' }, hashA);
    if (fresh.kind === 'new') fresh.settle(typed);
    expect(store.begin({ caller: 'o1', id: 'cr-old' }, hashB).kind).toBe('new');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cr-old');
  });

  it('6. a retry while the first is still being answered waits for that answer, and sends nothing', async () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    const retry = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    expect(retry.kind).toBe('pending');
    if (first.kind === 'new') first.settle(typed);
    if (retry.kind === 'pending') expect(await retry.outcome).toEqual(typed);
  });

  it('7. a first call that did nothing is forgotten: its retry is tried, and its waiter hears to try', async () => {
    const store = open();
    const first = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    const waiting = store.begin({ caller: 'o1', id: 'cr-1' }, hashA);
    if (first.kind === 'new') first.settle(null);
    if (waiting.kind === 'pending') expect(await waiting.outcome).toBeNull();
    expect(store.begin({ caller: 'o1', id: 'cr-1' }, hashB).kind).toBe('new');
  });

  it('8. the file is its owner\'s only, rewritten whole, and a damaged line loses only itself', () => {
    const store = open();
    for (const id of ['cr-1', 'cr-2']) {
      const b = store.begin({ caller: 'o1', id }, hashA);
      if (b.kind === 'new') b.settle(typed);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    fs.appendFileSync(file, '{"torn": \n');
    const reopened = open();
    expect(reopened.begin({ caller: 'o1', id: 'cr-1' }, hashA).kind).toBe('duplicate');
    expect(reopened.begin({ caller: 'o1', id: 'cr-2' }, hashA).kind).toBe('duplicate');
  });

  it('9. a store opened again knows what the last one kept', () => {
    const first = open().begin({ caller: 'o1', id: 'cr-1' }, hashA);
    if (first.kind === 'new') first.settle(typed);
    expect(open().begin({ caller: 'o1', id: 'cr-1' }, hashA)).toEqual({ kind: 'duplicate', outcome: typed });
  });

  it('10. only an id of 8 to 128 plain characters is one', () => {
    expect(clientRequestIdOf(undefined)).toBeNull();
    expect(clientRequestIdOf('cr-e2e-0001')).toBe('cr-e2e-0001');
    expect(clientRequestIdOf('7f0c1b9e-3a5d-4c1e-9f7a-2b8d6e4c0a11')).toBe('7f0c1b9e-3a5d-4c1e-9f7a-2b8d6e4c0a11');
    for (const bad of ['', 'short', 'x'.repeat(129), 'has space1', 'line\nbreak1', 'bidi\u202eid1', 42, {}]) {
      expect(clientRequestIdOf(bad)).toBe('invalid');
    }
  });

  it('11. an outcome updated later keeps what it held, and touches no other caller\'s receipt', () => {
    const store = open();
    const run = store.begin({ caller: 'p1', id: 'cr-acp-1' }, hashA);
    if (run.kind === 'new') run.settle({ status: 200, body: { started: true, taskId: '9a1f6c1e-0d4b-4f53-9a3e-2b1c0d9e8f70' } });
    const other = store.begin({ caller: 'b1', id: 'cr-acp-1' }, hashA);
    if (other.kind === 'new') other.settle({ status: 200, body: { started: true, taskId: '00000000-0000-4000-8000-000000000000' } });
    store.update({ caller: 'p1', id: 'cr-acp-1' }, { ok: true, stopReason: 'end_turn' });
    const mine = open().find({ caller: 'p1', id: 'cr-acp-1' });
    expect(mine?.outcome.body).toEqual({ started: true, taskId: '9a1f6c1e-0d4b-4f53-9a3e-2b1c0d9e8f70', ok: true, stopReason: 'end_turn' });
    expect(open().find({ caller: 'b1', id: 'cr-acp-1' })?.outcome.body).toEqual({ started: true, taskId: '00000000-0000-4000-8000-000000000000' });
  });
});
