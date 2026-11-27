import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { memoryStatus, searchMemory } from '../../../electron/services/memory-hub';

/**
 * Brain's Hermes memory row, and the memory search, say why Hermes gave
 * nothing in the same words as the gateway's other channels (#660, 27/11).
 *
 * The row is memory:sources' `detail`, made in the main process (memoryStatus,
 * services/memory-hub.ts): it said the transport's raw "connect ECONNREFUSED
 * 127.0.0.1:9" while the gateway's two cards below it said "Tars could not
 * reach Hermes at ...". And a gateway answering 200 with a page that is not
 * JSON was "reachable, provider built-in, 0 files readable".
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. The Hermes row's detail, for a gateway that gives no answer, is the
 *    transport's raw words, not the sentence (memory:sources).
 * 2. The memory search's Hermes error, the same (memory:search, and an agent's
 *    memory_search through the same function).
 * 3. A gateway answering 200 with something that is not JSON is reachable,
 *    with a provider and files it never named.
 * 4. The search, for that answer, is a success with no hits.
 * 5. A gateway that answers as Hermes does stops being read.
 */

const closing: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });

/** A loopback port nothing listens on. */
async function refusingPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A loopback gateway answering every request with `answer(url)`. */
async function gateway(answer: (url: string) => { type: string; body: string }): Promise<number> {
  const server = http.createServer((req, res) => {
    const { type, body } = answer(req.url ?? '');
    res.setHeader('Content-Type', type);
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closing.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}

const at = (port: number) => ({ mode: 'remote' as const, url: `http://127.0.0.1:${port}`, authMode: 'token' as const });
const hermesRow = async (port: number) => (await memoryStatus({ settings: {} as never, hermes: at(port) })).find(s => s.id === 'hermes');
const HTML = () => ({ type: 'text/html', body: '<!doctype html><title>Sign in</title>' });

describe('a gateway that gives no answer (1, 2)', () => {
  it('the Hermes row says which gateway Tars could not reach, and why', async () => {
    const port = await refusingPort();

    expect(await hermesRow(port)).toMatchObject({
      configured: true, reachable: false,
      detail: `Tars could not reach Hermes at http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}`,
    });
  });

  it('the memory search says the same for its Hermes source', async () => {
    const port = await refusingPort();

    const found = await searchMemory({ query: 'deploy', settings: {} as never, hermes: at(port), sources: ['hermes'] });

    expect(found).toEqual({ hits: [], errors: [{ source: 'hermes', error: `Tars could not reach Hermes at http://127.0.0.1:${port}: connect ECONNREFUSED 127.0.0.1:${port}` }] });
  });
});

describe('a gateway that answers 200 with something that is not JSON (3, 4)', () => {
  it('the Hermes row is not reachable, and says the answer is not what Tars expected', async () => {
    const port = await gateway(HTML);

    expect(await hermesRow(port)).toMatchObject({
      configured: true, reachable: false,
      detail: 'Tars could not read the memory settings Hermes sent: its answer is not what Tars expected.',
    });
  });

  it('the memory search is an error for its Hermes source, not a success with no hits', async () => {
    const port = await gateway(HTML);

    const found = await searchMemory({ query: 'deploy', settings: {} as never, hermes: at(port), sources: ['hermes'] });

    expect(found).toEqual({ hits: [], errors: [{ source: 'hermes', error: 'Tars could not read the search results Hermes sent: its answer is not what Tars expected.' }] });
  });
});

describe('a gateway that answers as Hermes does (5)', () => {
  it('is reachable, with its provider and files', async () => {
    const port = await gateway(url => ({
      type: 'application/json',
      body: url.startsWith('/api/memory')
        ? JSON.stringify({ active: 'holographic', providers: [] })
        : JSON.stringify({ data_url: `data:text/markdown;base64,${Buffer.from('# notes').toString('base64')}` }),
    }));

    expect(await hermesRow(port)).toMatchObject({ reachable: true, detail: 'provider holographic, 2 files readable' });
  });

  it('the memory search reads its hits', async () => {
    const port = await gateway(() => ({ type: 'application/json', body: JSON.stringify({ results: [{ session_id: 's1', title: 'Deploy', snippet: 'deploy on friday' }] }) }));

    const found = await searchMemory({ query: 'deploy', settings: {} as never, hermes: at(port), sources: ['hermes'] });

    expect(found).toEqual({ hits: [{ source: 'hermes', title: 'Deploy', content: 'deploy on friday', ref: 's1' }], errors: [] });
  });
});
