import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../constants';
import type { AgentProvider } from '../../types';

/**
 * Which CLIs can be driven over the Agent Client Protocol, and how to launch
 * them. The public registry's agent.json per agent refreshes the launch
 * commands like the model catalogue, but *versions* only: the package executed
 * comes from ALLOWED_PACKAGES below, never from the network (see why there).
 */

const REGISTRY_BASE = 'https://raw.githubusercontent.com/agentclientprotocol/registry/main';
const CACHE_FILE = path.join(DATA_DIR, 'acp-registry.json');
const TTL_MS = 24 * 60 * 60 * 1000;

export interface AcpAgentEntry {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
}

/** Tars provider id to registry agent id. */
const PROVIDER_TO_ACP: Partial<Record<AgentProvider, string>> = {
  claude: 'claude-acp',
  codex: 'codex-acp',
  gemini: 'gemini',
  grok: 'grok',
  opencode: 'opencode',
  // No `pi`: mapped to an id in neither FALLBACK nor ALLOWED_PACKAGES, it said
  // yes to ACP and then failed every launch. It delegates over the PTY. Map it
  // the day upstream ships an ACP mode, with its package in ALLOWED_PACKAGES.
};

/** Known-good launch commands, for when the registry is unreachable. */
const FALLBACK: Record<string, AcpAgentEntry> = {
  'claude-acp': { id: 'claude-acp', name: 'Claude Agent', version: '0.70.0', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'] },
  'codex-acp': { id: 'codex-acp', name: 'Codex', version: '1.6.2', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.6.2'] },
  gemini: { id: 'gemini', name: 'Gemini CLI', version: 'latest', command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
  grok: { id: 'grok', name: 'Grok', version: 'latest', command: 'npx', args: ['-y', '@xai-official/grok', 'agent', 'stdio'] },
  opencode: { id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] },
};

interface RegistryManifest {
  id: string;
  name?: string;
  version?: string;
  distribution?: {
    npx?: { package: string; args?: string[] };
    binary?: Record<string, { url: string; sha256?: string }>;
  };
  /** Some agents declare the subcommand that puts the CLI in ACP mode. */
  acpArgs?: string[];
}

interface CacheShape {
  fetchedAt: number;
  agents: Record<string, AcpAgentEntry>;
}

/**
 * The npm package each agent id is allowed to run, without its version: this
 * module's security boundary. The registry manifest, and the cache built from
 * it, are a *version* hint, never the name of what runs: `manifestToEntry` once
 * spliced `distribution.npx.package` into `npx -y <package>`, so one commit to
 * the third-party agentclientprotocol/registry (or a write to
 * ~/.dorothy/acp-registry.json) could run any npm package as the user, in their
 * project, with their environment, for the cache's whole TTL. An agent id absent
 * here is never launched from the registry: add its package deliberately.
 */
const ALLOWED_PACKAGES: Record<string, readonly string[]> = {
  'claude-acp': ['@agentclientprotocol/claude-agent-acp'],
  'codex-acp': ['@agentclientprotocol/codex-acp'],
  gemini: ['@google/gemini-cli'],
  grok: ['@xai-official/grok'],
  opencode: ['opencode-ai'],
};

let memo: CacheShape | null = null;

/** npm package name, e.g. `@scope/name` or `name`. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/**
 * Version or dist-tag only. `:` and `/` are excluded on purpose: they are what
 * turns a version suffix into a fetch of somebody else's code
 * (`pkg@npm:evil`, `pkg@github:u/r`, `pkg@file:...`, `pkg@https://...`).
 */
const PACKAGE_VERSION_RE = /^[a-z0-9][a-z0-9.+-]*$/i;
/** Conservative shape for a CLI flag we did not compile in ourselves. */
const ARG_RE = /^[a-z0-9][\w.:=@/-]*$/i;
const MAX_ARGS = 8;

/** Splits `@scope/name@1.2.3` into its name and version halves. */
function splitPackageSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * Accepts a launch entry only if it runs a package we compiled in for this
 * agent id, at a plain version. Returns a rebuilt entry - never the caller's
 * object - so nothing unvalidated survives into the spawn.
 */
function sanitizeEntry(agentId: string, entry: Partial<AcpAgentEntry> | null | undefined): AcpAgentEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const fallback = FALLBACK[agentId];
  const version = typeof entry.version === 'string' && entry.version ? entry.version : 'latest';
  const name = typeof entry.name === 'string' && entry.name ? entry.name : agentId;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];

  // A locally installed CLI: only the command we compiled in ourselves.
  if (entry.command && entry.command !== 'npx') {
    if (!fallback || entry.command !== fallback.command) return null;
    return { id: agentId, name, version, command: fallback.command, args: [...fallback.args] };
  }

  const [flag, spec, ...rest] = args;
  if (flag !== '-y' || typeof spec !== 'string') return null;
  const { name: pkg, version: pkgVersion } = splitPackageSpec(spec);
  if (!PACKAGE_NAME_RE.test(pkg)) return null;
  if (pkgVersion !== null && !PACKAGE_VERSION_RE.test(pkgVersion)) return null;
  if (!(ALLOWED_PACKAGES[agentId] ?? []).includes(pkg)) return null;

  // Arguments after the package come from the compiled table whenever we have
  // one; the registry only ever moves the version.
  const tail = fallback ? fallback.args.slice(2) : rest.slice(0, MAX_ARGS).filter(a => ARG_RE.test(a));
  return { id: agentId, name, version, command: 'npx', args: ['-y', spec, ...tail] };
}

function readCache(): CacheShape | null {
  if (memo) return memo;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as unknown;
    memo = sanitizeCache(raw);
    return memo;
  } catch {
    return null;
  }
}

/**
 * Re-validates the cache file on every read: it is a plain 0644 JSON file in
 * DATA_DIR, so it is not more trustworthy than the registry response it was
 * built from. Entries that fail validation are dropped, not repaired.
 */
function sanitizeCache(raw: unknown): CacheShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const { fetchedAt, agents } = raw as { fetchedAt?: unknown; agents?: unknown };
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
  if (!agents || typeof agents !== 'object') return null;

  const clean: Record<string, AcpAgentEntry> = {};
  for (const [agentId, entry] of Object.entries(agents as Record<string, unknown>)) {
    const safe = sanitizeEntry(agentId, entry as Partial<AcpAgentEntry>);
    if (safe) clean[agentId] = safe;
  }
  // A clock-ahead timestamp would pin a stale table forever.
  return { fetchedAt: Math.min(fetchedAt, Date.now()), agents: clean };
}

function writeCache(cache: CacheShape): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    memo = cache;
  } catch {
    // a cache we cannot write costs a fetch, not correctness
  }
}

/**
 * A launch entry for `agentId` from its manifest, or null if it asks for anything
 * we will not execute. The agent id is ours, not `manifest.id`: a manifest cannot
 * rename itself into another agent's allowlist row.
 */
function manifestToEntry(agentId: string, manifest: RegistryManifest, fallbackArgs?: string[]): AcpAgentEntry | null {
  const npx = manifest.distribution?.npx;
  if (!npx?.package) return null;
  return sanitizeEntry(agentId, {
    id: agentId,
    name: manifest.name || agentId,
    version: manifest.version || 'latest',
    command: 'npx',
    args: ['-y', npx.package, ...(npx.args ?? manifest.acpArgs ?? fallbackArgs ?? [])],
  });
}

/** Refreshes the launch table at most once a day. Never throws. */
export async function loadAcpRegistry(force = false): Promise<Record<string, AcpAgentEntry>> {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.agents;

  const agents: Record<string, AcpAgentEntry> = { ...FALLBACK, ...(cached?.agents ?? {}) };

  await Promise.all(Object.values(PROVIDER_TO_ACP).map(async agentId => {
    if (!agentId) return;
    try {
      const res = await fetch(`${REGISTRY_BASE}/${agentId}/agent.json`, {
        headers: { 'User-Agent': 'Tars' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const entry = manifestToEntry(agentId, await res.json() as RegistryManifest, FALLBACK[agentId]?.args.slice(2));
      if (entry) agents[agentId] = entry;
    } catch {
      // keep whatever we already had for this agent
    }
  }));

  writeCache({ fetchedAt: Date.now(), agents });
  return agents;
}

/** How to launch this provider over ACP, or null if it has no ACP mode. */
export function acpLaunchFor(provider: AgentProvider): AcpAgentEntry | null {
  const agentId = PROVIDER_TO_ACP[provider];
  if (!agentId) return null;
  // Last gate before client.ts spawns this: a cached entry the allowlist would
  // not accept today falls back to the compiled command rather than running.
  const cached = readCache()?.agents[agentId];
  return (cached && sanitizeEntry(agentId, cached)) ?? FALLBACK[agentId] ?? null;
}

export function providerSupportsAcp(provider: AgentProvider): boolean {
  return acpLaunchFor(provider) !== null;
}

/** Test seam. */
export function resetAcpRegistryCache(): void {
  memo = null;
}
