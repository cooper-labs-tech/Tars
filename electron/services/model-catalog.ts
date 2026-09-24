import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';

/**
 * Live model and price catalogue, from models.dev (193 providers, USD per
 * million tokens, re-synced hourly, MIT; a conditional GET makes the usual
 * refresh one 304). Three tiers, in order: a fresh fetch, the last good copy on
 * disk whatever its age, then the compiled-in floor. A network failure must
 * never zero out cost accounting.
 */

const CATALOG_URL = 'https://models.dev/api.json';
const MIRROR_URL = 'https://raw.githubusercontent.com/anomalyco/models.dev/dev/models.json';
const CACHE_FILE = path.join(DATA_DIR, 'model-catalog.json');
const META_FILE = path.join(DATA_DIR, 'model-catalog.meta.json');
const TTL_MS = 6 * 60 * 60 * 1000;

export interface ModelCost {
  /** USD per million tokens */
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  cost?: ModelCost;
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values: string[] }>;
  tool_call?: boolean;
  release_date?: string;
  family?: string;
}

interface CatalogProvider {
  id?: string;
  name?: string;
  models: Record<string, CatalogModel>;
}

type Catalog = Record<string, CatalogProvider>;

/**
 * Tars provider id to models.dev key. A provider absent from this map simply
 * has no catalogue entry; its picker falls back to the static registry.
 */
const PROVIDER_KEYS: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  grok: 'xai',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  qwen: 'alibaba',
  zhipu: 'zai',
  minimax: 'minimax',
  mimo: 'xiaomi',
  nvidia: 'nvidia',
  opencode: 'opencode',
  qwencode: 'alibaba',
  venice: 'venice',
  'ollama-cloud': 'ollama-cloud',
  // No 'ollama': local Ollama's catalogue is whatever the user pulled, so
  // ollama-provider.ts's list is the floor for good (Ollama Cloud, above, is
  // the hosted product). No 'custom-openai', ever: a private endpoint's one
  // model is what the user typed in Settings. No 'amp': it picks its own mix
  // per request, so nothing is priced per model (`amp usage` holds its spend).
};

/** Prices of last resort, used only when the catalogue is unreachable and no
 *  copy was ever cached. Kept small on purpose: the catalogue is the source. */
const FLOOR: Record<string, ModelCost> = {
  fable: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  opus: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  sonnet: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  haiku: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

let memo: Catalog | null = null;
let memoAt = 0;
let inFlight: Promise<Catalog | null> | null = null;

function readMeta(): { etag?: string; fetchedAt?: number } {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function readCache(): Catalog | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Catalog;
  } catch {
    return null;
  }
}

function writeCache(catalog: Catalog, etag: string | null): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog));
    fs.writeFileSync(META_FILE, JSON.stringify({ etag: etag ?? undefined, fetchedAt: Date.now() }));
  } catch {
    // A cache we cannot write is a slower app, not a broken one.
  }
}

async function fetchCatalog(url: string, etag?: string): Promise<{ catalog: Catalog | null; etag: string | null; notModified: boolean }> {
  const headers: Record<string, string> = { 'User-Agent': 'Tars' };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 304) return { catalog: null, etag: etag ?? null, notModified: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const catalog = (await res.json()) as Catalog;
  if (!catalog || typeof catalog !== 'object' || !catalog.anthropic) {
    throw new Error('catalogue shape not recognised');
  }
  return { catalog, etag: res.headers.get('etag'), notModified: false };
}

/** Refreshes at most once per TTL. Never throws. */
export async function loadCatalog(force = false): Promise<Catalog | null> {
  if (!force && memo && Date.now() - memoAt < TTL_MS) return memo;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const meta = readMeta();
    const cached = readCache();
    const fresh = !force && meta.fetchedAt && Date.now() - meta.fetchedAt < TTL_MS;

    if (cached && fresh) {
      memo = cached;
      memoAt = Date.now();
      return cached;
    }

    for (const url of [CATALOG_URL, MIRROR_URL]) {
      try {
        const { catalog, etag, notModified } = await fetchCatalog(url, cached ? meta.etag : undefined);
        if (notModified && cached) {
          writeCache(cached, meta.etag ?? null);
          memo = cached;
          memoAt = Date.now();
          return cached;
        }
        if (catalog) {
          writeCache(catalog, etag);
          memo = catalog;
          memoAt = Date.now();
          return catalog;
        }
      } catch {
        // try the mirror, then fall through to the cache
      }
    }

    // Stale beats nothing: an old catalogue still prices yesterday's models.
    if (cached) {
      memo = cached;
      memoAt = Date.now();
      return cached;
    }
    return null;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Synchronous view for hot paths; whatever was last loaded or cached. */
export function catalogSync(): Catalog | null {
  if (memo) return memo;
  const cached = readCache();
  if (cached) {
    memo = cached;
    memoAt = 0; // unknown age, a refresh is still due
  }
  return memo;
}

export interface ResolvedModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  effortValues?: string[];
  cost?: ModelCost;
  releaseDate?: string;
}

/**
 * models.dev suffixes an undated id with "(latest)" (`claude-sonnet-4-5` is
 * "Claude Sonnet 4.5 (latest)", the alias tracking that family's newest build),
 * which does not mean the newest model: shown verbatim, the picker read as if
 * Sonnet 4.5 were current, two rows under Opus 5. The suffix comes off.
 */
function isAliasName(name: string): boolean {
  return /\(latest\)\s*$/i.test(name);
}

function displayName(name: string): string {
  return name.replace(/\s*\(latest\)\s*$/i, '').trim() || name;
}

/** Every model the catalogue knows for a Tars provider, newest first. */
export function modelsForProvider(providerId: string): ResolvedModel[] {
  const key = PROVIDER_KEYS[providerId];
  const catalog = catalogSync();
  if (!key || !catalog?.[key]?.models) return [];

  return Object.values(catalog[key].models)
    .map(m => ({
      id: m.id,
      name: displayName(m.name || m.id),
      alias: isAliasName(m.name || ''),
      contextWindow: m.limit?.context,
      maxOutput: m.limit?.output,
      reasoning: m.reasoning,
      effortValues: m.reasoning_options?.find(o => o.type === 'effort')?.values,
      cost: m.cost,
      releaseDate: m.release_date,
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
}

/**
 * Price for a model id. Tries the exact id first, then a longest-prefix match
 * (transcripts carry dated ids like claude-haiku-4-5-20251001 that the
 * catalogue lists undated), then the family floor.
 */
export function priceFor(modelId: string, providerId?: string): ModelCost | null {
  const catalog = catalogSync();
  const id = modelId.toLowerCase();

  const search = (key: string): ModelCost | null => {
    const models = catalog?.[key]?.models;
    if (!models) return null;
    if (models[modelId]?.cost) return models[modelId].cost!;

    let best: { len: number; cost: ModelCost } | null = null;
    for (const [candidate, model] of Object.entries(models)) {
      if (!model.cost) continue;
      const c = candidate.toLowerCase();
      if (id.startsWith(c) || c.startsWith(id)) {
        const len = Math.min(c.length, id.length);
        if (!best || len > best.len) best = { len, cost: model.cost };
      }
    }
    return best?.cost ?? null;
  };

  if (providerId && PROVIDER_KEYS[providerId]) {
    const hit = search(PROVIDER_KEYS[providerId]);
    if (hit) return hit;
  }
  for (const key of new Set(Object.values(PROVIDER_KEYS))) {
    const hit = search(key);
    if (hit) return hit;
  }

  for (const [family, cost] of Object.entries(FLOOR)) {
    if (id.includes(family)) return cost;
  }
  return null;
}

/** For the UI: is this figure priced from the live catalogue or a fallback? */
export function catalogStatus(): { loaded: boolean; fetchedAt: number | null; providers: number; models: number } {
  const catalog = catalogSync();
  const meta = readMeta();
  let models = 0;
  if (catalog) {
    for (const p of Object.values(catalog)) models += Object.keys(p.models || {}).length;
  }
  return {
    loaded: !!catalog,
    fetchedAt: meta.fetchedAt ?? null,
    providers: catalog ? Object.keys(catalog).length : 0,
    models,
  };
}

/** Test seam. */
export function resetCatalogCache(): void {
  memo = null;
  memoAt = 0;
  inFlight = null;
}
