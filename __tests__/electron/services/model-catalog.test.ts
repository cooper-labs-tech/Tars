import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The catalogue is what keeps prices and model lists current without a
 * release, so what matters is that it degrades in the right order: fresh
 * fetch, then the last copy on disk whatever its age, then the compiled floor.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-catalog-'));

vi.mock('../../../electron/constants', () => ({ DATA_DIR: tmp }));

const CATALOG = {
  anthropic: {
    models: {
      'claude-opus-9': {
        id: 'claude-opus-9',
        name: 'Claude Opus 9',
        cost: { input: 7, output: 35, cache_read: 0.7, cache_write: 8.75 },
        limit: { context: 2_000_000, output: 128_000 },
        release_date: '2026-08-01',
      },
      'claude-haiku-9': {
        id: 'claude-haiku-9',
        name: 'Claude Haiku 9',
        cost: { input: 1, output: 5 },
        release_date: '2026-07-01',
      },
    },
  },
  openai: { models: { 'gpt-9': { id: 'gpt-9', name: 'GPT-9', cost: { input: 2, output: 8 } } } },
};

let catalog: typeof import('../../../electron/services/model-catalog');

beforeEach(async () => {
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  vi.resetModules();
  catalog = await import('../../../electron/services/model-catalog');
  catalog.resetCatalogCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch));
}

function ok(body: unknown, etag = '"v1"') {
  return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
}

describe('model catalogue', () => {
  it('serves models and prices from a fresh fetch', async () => {
    stubFetch(() => ok(CATALOG));

    await catalog.loadCatalog(true);

    expect(catalog.modelsForProvider('claude').map(m => m.id)).toEqual(['claude-opus-9', 'claude-haiku-9']);
    expect(catalog.priceFor('claude-opus-9')).toEqual({ input: 7, output: 35, cache_read: 0.7, cache_write: 8.75 });
    expect(catalog.modelsForProvider('codex')[0].id).toBe('gpt-9');
  });

  it('prices a dated transcript id from its undated catalogue entry', async () => {
    stubFetch(() => ok(CATALOG));
    await catalog.loadCatalog(true);

    expect(catalog.priceFor('claude-haiku-9-20260701')?.input).toBe(1);
  });

  it('keeps serving the cached copy when the network is down', async () => {
    stubFetch(() => ok(CATALOG));
    await catalog.loadCatalog(true);

    catalog.resetCatalogCache();
    stubFetch(() => { throw new Error('offline'); });
    await catalog.loadCatalog(true);

    expect(catalog.priceFor('claude-opus-9')?.output).toBe(35);
  });

  it('falls back to the compiled floor when nothing was ever cached', async () => {
    stubFetch(() => { throw new Error('offline'); });
    await catalog.loadCatalog(true);

    expect(catalog.priceFor('claude-sonnet-5')).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 });
    expect(catalog.priceFor('some-model-nobody-knows')).toBeNull();
  });

  it('revalidates with the stored etag and keeps the body on 304', async () => {
    stubFetch(() => ok(CATALOG, '"abc"'));
    await catalog.loadCatalog(true);

    const seen: (string | undefined)[] = [];
    stubFetch((_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push(headers?.['If-None-Match']);
      return new Response(null, { status: 304 });
    });
    catalog.resetCatalogCache();
    await catalog.loadCatalog(true);

    expect(seen[0]).toBe('"abc"');
    expect(catalog.priceFor('claude-opus-9')?.input).toBe(7);
  });

  it('refuses a response that is not a catalogue', async () => {
    stubFetch(() => ok({ nonsense: true }));
    await catalog.loadCatalog(true);

    expect(catalog.catalogStatus().loaded).toBe(false);
  });

  it('exposes context window and effort values for the model picker', async () => {
    stubFetch(() => ok(CATALOG));
    await catalog.loadCatalog(true);

    const opus = catalog.modelsForProvider('claude')[0];
    expect(opus.contextWindow).toBe(2_000_000);
    expect(opus.maxOutput).toBe(128_000);
  });
});
