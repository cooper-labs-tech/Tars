import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';
import { LOAD_HARNESSES, type LoadHarness } from './load-pool';

/**
 * The owner's load grants (trace feature C3, 27/11): which projects a load window may run in, and how.
 *
 * Kept in `~/.tars-private/load-grants.json` (0600): `~/.tars` is in every agent's `--add-dir`, so a list kept there
 * would let an agent allow its own project. Written by the window's `load:grant` alone (handlers/load-handlers.ts),
 * never by an agent, a token or an API route (load-approval-boundary.test.ts). Per project, as the Projects view of
 * #672's frames sets it, its settings kept whether its switch is on or off:
 * - `path`: the project, one of Tars's;
 * - `enabled`: the "load windows" switch, kept on only for a project that can run (load-window.ts settle);
 * - `allowedByName`: the owner allows it whatever its repository's visibility (a private one, or none);
 * - `endpointId` and `model`: the inference endpoint its load agents run on, approved, and a model it serves; none
 *   until chosen;
 * - `harnesses`: the endpoint harnesses its load agents run, one load agent each, never claude; none until chosen.
 */

export const LOAD_GRANTS_FILE = privatePath('load-grants.json');

export interface LoadGrant {
  path: string;
  enabled: boolean;
  allowedByName: boolean;
  endpointId: string | null;
  model: string | null;
  harnesses: LoadHarness[];
}

export interface GrantContext {
  /** Tars's projects. */
  projects: string[];
  endpoints: Array<{ id: string; baseUrl: string; approved?: boolean; approvedBaseUrl?: string; models?: string[] }>;
}

const isHarness = (h: unknown): h is LoadHarness => (LOAD_HARNESSES as readonly unknown[]).includes(h);

/** Whether an entry has a grant's shape (a file edited by hand may hold anything). */
function shaped(v: unknown): v is LoadGrant {
  const g = v as Partial<LoadGrant> | null;
  return !!g && typeof g === 'object' && typeof g.path === 'string' && typeof g.enabled === 'boolean' && typeof g.allowedByName === 'boolean'
    && (g.endpointId === null || typeof g.endpointId === 'string') && (g.model === null || typeof g.model === 'string')
    && Array.isArray(g.harnesses) && g.harnesses.every(isHarness);
}

/** An endpoint a grant may name: one the owner approved, at the address approved. */
export function approvedEndpoint<E extends GrantContext['endpoints'][number]>(endpoints: E[], id: string | null | undefined): E | undefined {
  const e = endpoints.find(x => x.id === id);
  return e && e.approved === true && e.approvedBaseUrl === e.baseUrl ? e : undefined;
}

/**
 * A grant as the window asks for it, checked against Tars's projects and endpoints; else the reason, naming the field.
 * An endpoint, a model and harnesses may be none yet; whether the switch can hold is load-window.ts's (settle).
 */
export function checkGrant(input: unknown, ctx: GrantContext): LoadGrant | string {
  const g = (input ?? {}) as Partial<LoadGrant>;
  if (typeof g.path !== 'string' || !ctx.projects.includes(g.path)) return 'project: one of Tars\'s projects';
  if (typeof g.enabled !== 'boolean') return 'enabled: true or false';
  if (typeof g.allowedByName !== 'boolean') return 'allowedByName: true or false';
  const endpointId = g.endpointId ?? null;
  const endpoint = endpointId === null ? undefined : approvedEndpoint(ctx.endpoints, endpointId);
  if (endpointId !== null && !endpoint) return 'endpoint: an inference endpoint you approved, or none yet';
  const model = g.model ?? null;
  if (model !== null && (typeof model !== 'string' || !model || !endpoint || (endpoint.models?.length && !endpoint.models.includes(model)))) {
    return 'model: one the chosen endpoint serves, or none yet';
  }
  if (!Array.isArray(g.harnesses) || !g.harnesses.every(isHarness)) return `harnesses: a list of ${LOAD_HARNESSES.join(', ')}`;
  return { path: g.path, enabled: g.enabled, allowedByName: g.allowedByName, endpointId: endpoint?.id ?? null, model, harnesses: [...new Set(g.harnesses)] };
}

/** The grants in the file, each entry of a grant's shape; none when the file is missing or unreadable. Never throws. */
export function readGrants(file: string = LOAD_GRANTS_FILE): LoadGrant[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: unknown };
    return Array.isArray(raw?.projects) ? raw.projects.filter(shaped) : [];
  } catch {
    return [];
  }
}

/** A project's grant written, or removed, in the file (0600, its folder 0700). Throws when it cannot write. */
export function writeGrant(change: LoadGrant | { path: string; remove: true }, file: string = LOAD_GRANTS_FILE): void {
  const kept = readGrants(file).filter(g => g.path !== change.path);
  const projects = 'remove' in change ? kept : [...kept, change];
  writeSecretFileSync(file, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
}
