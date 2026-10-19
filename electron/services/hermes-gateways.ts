import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { HERMES_GATEWAYS_FILE, HERMES_WEBHOOK_SECRET_FILE } from '../constants';
import { describeSecretFileError, writeSecretFileSync } from '../utils/secret-file';
import { pathKey, samePath } from '../platform/path-compare';
import { provisionWebhookSecret, readWebhookSecret } from './hermes-webhook-secret';

/**
 * The Hermes gateways Tars takes work from (2.0.4, the Audit's NOW-3 and R4.2, R4.3).
 *
 * Until 2.0.4 one secret opened `POST /api/webhooks/hermes` for whoever held it, the user's Hermes on this machine
 * or on a VPS, or anyone on the tailnet who read that gateway's config, and it reached every agent of every project.
 * Now each gateway has its own secret, minted from 32 random bytes in a file of its own in the private folder
 * (0600, in the 0700 folder no agent is handed), its own route, and the projects the user allows it in Settings,
 * none until they do. The default gateway is the one Hermes had before: its route stays `/api/webhooks/hermes` and
 * its secret `~/.tars-private/hermes-webhook-secret`, so the jobs that hold it keep it. Another is `gw-` and 6 hex,
 * its route `/api/webhooks/hermes/<id>`, its secret `hermes-webhook-<id>.secret` beside the default's.
 *
 * The list of gateways and what each reaches, `~/.tars-private/hermes-gateways.json` (0600), is in the private
 * folder too: an agent that could add a project to it would widen what a gateway's message reaches.
 */

export const DEFAULT_GATEWAY = 'default';
export const DEFAULT_GATEWAY_LABEL = 'Hermes';

export interface HermesGateway {
  id: string;
  label: string;
  /** The projects its messages may reach, by their paths as Tars knows them. None until the user allows some. */
  projects: string[];
}

const GATEWAY_ID = /^gw-[0-9a-f]{6}$/;
const MAX_LABEL = 60;
const MAX_PROJECTS = 500;
const WEBHOOK_PATH = '/api/webhooks/hermes';

/** `default`, or `gw-` and 6 hex: an id never names another file of the private folder, nor another route. */
export function isGatewayId(id: unknown): id is string {
  return id === DEFAULT_GATEWAY || (typeof id === 'string' && GATEWAY_ID.test(id));
}

function assertGatewayId(id: unknown): asserts id is string {
  if (!isGatewayId(id)) throw new Error('Not a gateway: an id is "default" or "gw-" and 6 hex.');
}

/** A gateway's secret file: the default's as it always was, another's beside it. */
function secretFileOf(id: string): string {
  assertGatewayId(id);
  return id === DEFAULT_GATEWAY ? HERMES_WEBHOOK_SECRET_FILE : path.join(path.dirname(HERMES_WEBHOOK_SECRET_FILE), `hermes-webhook-${id}.secret`);
}

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * The gateways as the registry has them, the default always among them. A registry that cannot be read is the
 * default alone, reaching nothing: a broken file never opens more than it did, and never stops the door.
 */
export function listGateways(): HermesGateway[] {
  let listed: unknown;
  try {
    listed = JSON.parse(fs.readFileSync(HERMES_GATEWAYS_FILE, 'utf-8'))?.gateways;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[hermes] cannot read the gateways' registry: ${describeSecretFileError(err)}`);
    listed = [];
  }
  const out: HermesGateway[] = [];
  for (const entry of Array.isArray(listed) ? listed : []) {
    const e = entry as { id?: unknown; label?: unknown; projects?: unknown };
    if (!isGatewayId(e.id) || out.some(g => g.id === e.id)) continue;
    const projects = Array.isArray(e.projects) ? e.projects.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
    out.push({ id: e.id, label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, MAX_LABEL) : (e.id === DEFAULT_GATEWAY ? DEFAULT_GATEWAY_LABEL : e.id), projects });
  }
  if (!out.some(g => g.id === DEFAULT_GATEWAY)) out.unshift({ id: DEFAULT_GATEWAY, label: DEFAULT_GATEWAY_LABEL, projects: [] });
  return out;
}

function saveGateways(gateways: HermesGateway[]): void {
  writeSecretFileSync(HERMES_GATEWAYS_FILE, `${JSON.stringify({ gateways }, null, 2)}\n`);
}

export function gatewayById(id: string): HermesGateway | undefined {
  return listGateways().find(g => g.id === id);
}

/** A new gateway, reaching nothing, with its own secret. */
export function addGateway(label: string): HermesGateway {
  const name = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL) : '';
  if (!name) throw new Error('A gateway is added with a name.');
  const gateways = listGateways();
  let id: string;
  do id = `gw-${randomBytes(3).toString('hex')}`; while (gateways.some(g => g.id === id));
  const gateway: HermesGateway = { id, label: name, projects: [] };
  saveGateways([...gateways, gateway]);
  rotateGatewaySecret(id);
  return gateway;
}

/** A gateway removed, with its secret: false for the default one, or one there is not. */
export function removeGateway(id: string): boolean {
  if (!isGatewayId(id) || id === DEFAULT_GATEWAY) return false;
  const gateways = listGateways();
  if (!gateways.some(g => g.id === id)) return false;
  fs.rmSync(secretFileOf(id), { force: true });
  saveGateways(gateways.filter(g => g.id !== id));
  return true;
}

/** The projects a gateway may reach, as the user chose them: absolute paths only, each once. */
export function setGatewayProjects(id: string, projects: string[]): HermesGateway {
  assertGatewayId(id);
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS
    || !projects.every(p => typeof p === 'string' && p.length > 0 && path.isAbsolute(p))) {
    throw new Error('A gateway reaches projects named by their absolute paths.');
  }
  const gateways = listGateways();
  const gateway = gateways.find(g => g.id === id);
  if (!gateway) throw new Error('There is no such gateway.');
  const seen = new Set<string>();
  gateway.projects = projects.filter(p => !seen.has(pathKey(p)) && seen.add(pathKey(p)));
  saveGateways(gateways);
  return gateway;
}

/** Whether a gateway's messages may reach an agent of this project. */
export function gatewayReaches(gateway: HermesGateway, projectPath: string | undefined): boolean {
  return !!projectPath && gateway.projects.some(p => samePath(p, projectPath));
}

/** A gateway's secret, minted the first time it is asked for. */
export function gatewaySecret(id: string): string {
  assertGatewayId(id);
  if (id === DEFAULT_GATEWAY) return provisionWebhookSecret();
  if (!gatewayById(id)) throw new Error('There is no such gateway.');
  return readTrimmed(secretFileOf(id)) || rotateGatewaySecret(id);
}

/** A new secret for a gateway: the one before opens nothing from now on. */
export function rotateGatewaySecret(id: string): string {
  const file = secretFileOf(id);
  if (id !== DEFAULT_GATEWAY && !gatewayById(id)) throw new Error('There is no such gateway.');
  const secret = randomBytes(32).toString('hex');
  writeSecretFileSync(file, secret);
  return secret;
}

/** The gateway whose secret this is, compared whole and in constant time; none for anything else. */
export function gatewayOfSecret(presented: string): string | undefined {
  if (!presented) return undefined;
  const given = Buffer.from(presented);
  for (const gateway of listGateways()) {
    const expected = gateway.id === DEFAULT_GATEWAY ? readWebhookSecret() : readTrimmed(secretFileOf(gateway.id));
    if (!expected) continue;
    const held = Buffer.from(expected);
    if (held.length === given.length && timingSafeEqual(held, given)) return gateway.id;
  }
  return undefined;
}

/** The gateway a webhook path is the route of: the default's, `/api/webhooks/hermes`, or `/api/webhooks/hermes/<id>`. */
export function gatewayOfPath(pathname: string): string | undefined {
  if (pathname === WEBHOOK_PATH) return DEFAULT_GATEWAY;
  if (!pathname.startsWith(`${WEBHOOK_PATH}/`)) return undefined;
  const id = pathname.slice(WEBHOOK_PATH.length + 1);
  return id !== DEFAULT_GATEWAY && isGatewayId(id) ? id : undefined;
}

/** The route a gateway posts to. */
export function webhookPathOf(id: string): string {
  return id === DEFAULT_GATEWAY ? WEBHOOK_PATH : `${WEBHOOK_PATH}/${id}`;
}
