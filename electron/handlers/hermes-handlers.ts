import { app, ipcMain } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { API_PORT, DATA_DIR, dataPath } from '../constants';
import { configuredHermesConnection, readHermesConnection, writeHermesConnection } from '../services/hermes-config';
import { resetLiveSession } from '../services/overseer';
import { relayStatus } from '../services/hermes-relay';
import { describeSecretFileError } from '../utils/secret-file';
// The webhook's own secret, not the master token, which over the tailnet would
// hand out every route. Kept in the private directory: see that module.
import { provisionWebhookSecret } from '../services/hermes-webhook-secret';
import {
  fetchHermesCrons,
  hermesCronAction,
  updateHermesCron,
  deleteHermesCron,
  probeHermes,
  signInHermes,
  clearHermesSession,
  fetchHermesBoard,
  getHermesTask,
  createHermesTask,
  updateHermesTask,
  deleteHermesTask,
  addHermesTaskComment,
  fetchHermesMcpServers,
  fetchHermesMemoryProviders,
  setHermesMemoryProvider,
} from '../services/hermes-client';
import {
  HermesConnection,
  defaultHermesConnection,
  resolveHermesBaseUrl,
  HERMES_DEFAULT_PORT,
} from '../types/hermes';

const execFileAsync = promisify(execFile);

/** Where Hermes Desktop keeps its own connection config on macOS. */
const HERMES_DESKTOP_CONFIG = path.join(
  os.homedir(), 'Library', 'Application Support', 'Hermes', 'connection.json',
);
/**
 * Its v2 registry, beside it. connection.json is the v1 file, which Hermes
 * Desktop imports into the registry once and keeps for older builds; a gateway
 * or a token set up after that lives here, and `primary` names the one in use.
 */
const HERMES_DESKTOP_REGISTRY = path.join(path.dirname(HERMES_DESKTOP_CONFIG), 'connections.json');

const readConnection = readHermesConnection;
const writeConnection = writeHermesConnection;

/**
 * A call to the gateway, with the connection a file names: never the default
 * port for a file that is missing or broken (configuredHermesConnection), which
 * on JeanBrasse's machine is the SSH tunnel to his Hermes. The Settings form still
 * shows the default, to be saved (hermes:connection:get).
 */
async function viaGateway<T>(call: (conn: HermesConnection) => Promise<T>): Promise<T | { success: false; error: string }> {
  const configured = configuredHermesConnection();
  if (!configured) return { success: false, error: 'Hermes is not configured. Set it up in Settings.' };
  if ('unusable' in configured) return { success: false, error: configured.unusable };
  return call(configured.conn);
}

/**
 * A token Hermes Desktop stored in the clear, its default. One it encrypted
 * with its own safeStorage key (keychain encryption turned on) is that app's
 * secret: Tars cannot read it and does not try.
 */
function plainToken(token: unknown): string | undefined {
  const t = token as { encoding?: unknown; value?: unknown } | undefined;
  return t?.encoding === 'plain' && typeof t.value === 'string' && t.value ? t.value : undefined;
}

/** A token Hermes Desktop encrypted: the one an import has to leave behind, and say so. */
function encryptedToken(token: unknown): boolean {
  const t = token as { encoding?: unknown; value?: unknown } | undefined;
  return t?.encoding === 'safeStorage' && typeof t.value === 'string' && t.value.length > 0;
}

/** What an import brings, and whether it left an encrypted token behind. */
interface DesktopImport { conn: HermesConnection; tokenNotImported: boolean }

/**
 * The port connection.json gives Hermes Desktop's local runtime, or the
 * default. Only the port is read from it: once the registry exists, the rest of
 * v1 is what it was when the registry was made. A v1 that is missing or cannot
 * be read gives no port, which is what the default is for.
 */
function desktopLocalPort(): number {
  try {
    const port = JSON.parse(fs.readFileSync(HERMES_DESKTOP_CONFIG, 'utf-8'))?.local?.port;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : HERMES_DEFAULT_PORT;
  } catch {
    return HERMES_DEFAULT_PORT;
  }
}

/**
 * The registry's primary: a gateway over the network or SSH, or the local
 * runtime. Null when there is no registry, when it cannot be read, or when its
 * primary names no entry: connection.json then describes it, as before.
 */
function importDesktopRegistry(): DesktopImport | null {
  if (!fs.existsSync(HERMES_DESKTOP_REGISTRY)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(HERMES_DESKTOP_REGISTRY, 'utf-8'));
  } catch (err) {
    // Not the error itself: a parse error quotes the file, which holds tokens.
    console.error(`[hermes] cannot read Hermes Desktop's connections.json: ${describeSecretFileError(err)}`);
    return null;
  }
  const entry = Array.isArray(raw?.connections)
    ? raw.connections.find((c: { id?: unknown }) => c?.id === raw.primary)
    : undefined;
  if (entry?.kind === 'remote' || entry?.kind === 'cloud') {
    const conn: HermesConnection = { mode: entry.kind, url: entry.url, authMode: entry.authMode === 'oauth' ? 'oauth' : 'token' };
    const token = plainToken(entry.token);
    if (token) conn.token = token;
    if (entry.org) conn.org = entry.org;
    return { conn, tokenNotImported: encryptedToken(entry.token) };
  }
  if (entry?.kind === 'ssh') {
    const conn: HermesConnection = {
      mode: 'ssh', authMode: 'token',
      ssh: { host: entry.host, user: entry.user, port: entry.port, keyPath: entry.keyPath, remotePort: HERMES_DEFAULT_PORT },
    };
    // No SSH token is imported, plain or encrypted, as before, and the page has
    // no token field in SSH mode: a notice asking to paste one could not be answered.
    return { conn, tokenNotImported: false };
  }
  if (entry?.kind === 'local') return { conn: { mode: 'local', authMode: 'token', localPort: desktopLocalPort() }, tokenNotImported: false };
  return null;
}

/** Hermes Desktop's config shape -> ours (same vocabulary, nested differently). */
function importDesktopConfig(): DesktopImport | null {
  try {
    const fromRegistry = importDesktopRegistry();
    if (fromRegistry) return fromRegistry;
    if (!fs.existsSync(HERMES_DESKTOP_CONFIG)) return null;
    const raw = JSON.parse(fs.readFileSync(HERMES_DESKTOP_CONFIG, 'utf-8'));
    const mode = raw?.mode as HermesConnection['mode'];
    if (!mode) return null;
    const conn: HermesConnection = { mode, authMode: 'token' };
    const section = raw?.[mode] ?? {};
    let tokenNotImported = false;
    if (mode === 'remote' || mode === 'cloud') {
      conn.url = section.url;
      conn.authMode = section.authMode === 'oauth' ? 'oauth' : 'token';
      if (section.token?.encoding === 'plain' && section.token?.value) conn.token = section.token.value;
      tokenNotImported = encryptedToken(section.token);
      if (section.org) conn.org = section.org;
    } else if (mode === 'ssh') {
      conn.ssh = {
        host: section.host, user: section.user,
        port: section.port, keyPath: section.keyPath || section.identityFile,
        remotePort: section.remotePort || HERMES_DEFAULT_PORT,
        localPort: section.localPort,
      };
    } else {
      conn.localPort = section.port || HERMES_DEFAULT_PORT;
    }
    return { conn, tokenNotImported };
  } catch (err) {
    // The kind only: a parse error quotes the file, which can hold a plain token.
    console.error(`[hermes] cannot import Hermes Desktop config: ${describeSecretFileError(err)}`);
    return null;
  }
}

/** GET a Hermes endpoint, following the gateway's own auth conventions. */
function hermesGet(baseUrl: string, pathname: string, token?: string, timeoutMs = 6000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(baseUrl + pathname); } catch { reject(new Error('Invalid gateway URL')); return; }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, {
      method: 'GET',
      timeout: timeoutMs,
      headers: token ? { 'X-Hermes-Session-Token': token } : undefined,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Hermes integration handlers: everything the Settings → Hermes section
 * needs to wire a remote (VPS) Hermes instance to this Tars:
 * - connection info: the incoming-webhook URL/token to paste into Hermes
 *   cron jobs, plus Tailscale state (DNS name, serve status) so the user
 *   knows exactly how the VPS reaches this machine
 * - a local dry-run test of the webhook (auth + agent resolution, no dispatch)
 * - a reachability check of the Hermes gateway URL itself
 */

interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  dnsName?: string;
  ip?: string;
  serveConfigured: boolean;
}

const TAILSCALE_PLACES = ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/**
 * Where to look for `tailscale`. A development run may name the one binary to
 * ask, or none with an empty value (DOROTHY_TAILSCALE_BIN): the e2e fixture
 * does, since two of the places are absolute paths no sandbox HOME hides, and
 * a sandbox asked the Mac's own Tailscale, whose MagicDNS name ended up in the
 * reference screenshots (QA's note on #222). A packaged Tars never reads it.
 */
function tailscalePlaces(): string[] {
  const named = app?.isPackaged ? undefined : process.env.DOROTHY_TAILSCALE_BIN;
  if (named === undefined) return TAILSCALE_PLACES;
  return named.trim() ? [named] : [];
}

async function detectTailscale(): Promise<TailscaleInfo> {
  const candidates = tailscalePlaces();
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 4000 });
      const status = JSON.parse(stdout);
      const dnsName = typeof status?.Self?.DNSName === 'string'
        ? status.Self.DNSName.replace(/\.$/, '')
        : undefined;
      const ip = Array.isArray(status?.Self?.TailscaleIPs) ? status.Self.TailscaleIPs[0] : undefined;

      let serveConfigured = false;
      try {
        const { stdout: serveOut } = await execFileAsync(bin, ['serve', 'status'], { timeout: 4000 });
        serveConfigured = !/no serve config/i.test(serveOut) && serveOut.trim().length > 0;
      } catch { /* serve status exits non-zero when unconfigured on some versions */ }

      return {
        installed: true,
        running: status?.BackendState === 'Running',
        dnsName,
        ip,
        serveConfigured,
      };
    } catch { /* try next candidate */ }
  }
  return { installed: false, running: false, serveConfigured: false };
}

function readApiToken(): string {
  try {
    return fs.readFileSync(dataPath('api-token'), 'utf-8').trim();
  } catch {
    return '';
  }
}

/** POST JSON to the local API and resolve with {status, body}. */
function postLocal(pathname: string, token: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
      timeout: 5000,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let body: unknown = raw;
        try { body = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

export function registerHermesHandlers(): void {
  ipcMain.handle('hermes:getConnectionInfo', async () => {
    const [tailscale, token] = await Promise.all([detectTailscale(), Promise.resolve(provisionWebhookSecret())]);
    const tailnetUrl = tailscale.dnsName ? `https://${tailscale.dnsName}/api/webhooks/hermes` : undefined;
    return {
      apiPort: API_PORT,
      webhookPath: '/api/webhooks/hermes',
      webhookLocalUrl: `http://127.0.0.1:${API_PORT}/api/webhooks/hermes`,
      webhookTailnetUrl: tailnetUrl,
      apiToken: token,
      tailscale,
      serveCommand: `tailscale serve --bg --set-path /api/webhooks/hermes ${API_PORT}`,
    };
  });

  // The relay to the user's Telegram through their Hermes, as Settings, Hermes
  // shows it (services/hermes-relay.ts). Its changes are pushed on the same
  // channel name; the switch is hermesRelayEnabled, saved with app:saveSettings.
  ipcMain.handle('hermes:relay:status', async () => relayStatus());

  ipcMain.handle('hermes:connection:get', async () => {
    const connection = readConnection();
    // The form shows the default, to be saved. The base URL is what Settings >
    // Hermes and the Chat probe as soon as they open (hermes:connection:test),
    // so it is the gateway a file names, or none: for a missing or broken file
    // it was the default port's, the SSH tunnel to JeanBrasse's Hermes on his machine.
    const configured = configuredHermesConnection();
    return {
      connection,
      baseUrl: configured && !('unusable' in configured) ? resolveHermesBaseUrl(configured.conn) : '',
      desktopConfigAvailable: fs.existsSync(HERMES_DESKTOP_CONFIG) || fs.existsSync(HERMES_DESKTOP_REGISTRY),
    };
  });

  // The Chat remembers that a gateway refused its live session, so a gateway
  // without one does not pay for the attempt on every turn. A new connection,
  // a new sign-in or a sign-out is a new gateway as far as that goes, so each
  // of them forgets it, and drops a session opened under the old one: nothing
  // did, and one refusal kept the Chat on the slower cron path until Tars
  // restarted.
  ipcMain.handle('hermes:connection:save', async (_event, connection: HermesConnection) => {
    try {
      writeConnection(connection);
      resetLiveSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('hermes:connection:import', async () => {
    const imported = importDesktopConfig();
    if (!imported) return { success: false, error: 'No Hermes Desktop configuration found on this machine.' };
    writeConnection(imported.conn);
    resetLiveSession();
    return {
      success: true,
      connection: imported.conn,
      baseUrl: resolveHermesBaseUrl(imported.conn),
      tokenNotImported: imported.tokenNotImported,
    };
  });

  /**
   * Probes the gateway the way Hermes Desktop does: /api/status is public and
   * advertises the version plus which auth model is in force, so we can tell
   * "unreachable" from "reachable but you still need to sign in".
   */
  ipcMain.handle('hermes:connection:test', async (_event, connection: HermesConnection) => {
    const probe = await probeHermes(connection);
    return {
      success: probe.reachable && (!probe.authRequired || probe.signedIn),
      baseUrl: probe.baseUrl,
      status: probe.status,
      version: probe.version,
      gatewayState: probe.gatewayState,
      authRequired: probe.authRequired,
      authFlows: probe.authFlows,
      authProviders: probe.authProviders,
      signedIn: probe.signedIn,
      needsSignIn: probe.authRequired && !probe.signedIn,
      error: probe.error,
    };
  });

  ipcMain.handle('hermes:signIn', async (_event, params: { connection: HermesConnection; username: string; password: string; provider?: string }) => {
    const result = await signInHermes(params.connection, {
      username: params.username, password: params.password, provider: params.provider,
    });
    if (!result.success) return result;
    resetLiveSession();
    const probe = await probeHermes(params.connection);
    return { success: true, version: probe.version, gatewayState: probe.gatewayState };
  });

  ipcMain.handle('hermes:signOut', async (_event, connection: HermesConnection) => {
    clearHermesSession(resolveHermesBaseUrl(connection));
    resetLiveSession();
    return { success: true };
  });

  // ── Crons (schedules live in Hermes) ──
  ipcMain.handle('hermes:crons:list', async () => viaGateway(fetchHermesCrons));

  ipcMain.handle('hermes:crons:action', async (_event, params: { action: 'pause' | 'resume' | 'trigger'; jobId: string; profile?: string }) =>
    viaGateway(conn => hermesCronAction(conn, params.action, params.jobId, params.profile)));

  // Editing a schedule. The page could only run/pause/delete before this
  // channel existed, so there was nothing behind an edit control to call.
  ipcMain.handle('hermes:crons:update', async (_event, params: { jobId: string; updates: Record<string, unknown>; profile?: string }) =>
    viaGateway(conn => updateHermesCron(conn, params.jobId, params.updates ?? {}, params.profile)));

  ipcMain.handle('hermes:crons:delete', async (_event, params: { jobId: string; profile?: string }) =>
    viaGateway(conn => deleteHermesCron(conn, params.jobId, params.profile)));

  // ── Kanban (the board lives in Hermes; Tars is a client) ──
  ipcMain.handle('hermes:kanban:board', async (_event, params: { board?: string } = {}) => {
    return viaGateway(conn => fetchHermesBoard(conn, params?.board));
  });

  ipcMain.handle('hermes:kanban:createTask', async (_event, task: Record<string, unknown>) => {
    return viaGateway(conn => createHermesTask(conn, task));
  });

  ipcMain.handle('hermes:kanban:updateTask', async (_event, params: { taskId: string; patch: Record<string, unknown> }) => {
    return viaGateway(conn => updateHermesTask(conn, params.taskId, params.patch));
  });

  ipcMain.handle('hermes:kanban:getTask', async (_event, params: { taskId: string }) => {
    return viaGateway(conn => getHermesTask(conn, params.taskId));
  });

  ipcMain.handle('hermes:kanban:deleteTask', async (_event, params: { taskId: string }) => {
    return viaGateway(conn => deleteHermesTask(conn, params.taskId));
  });

  ipcMain.handle('hermes:kanban:addComment', async (_event, params: { taskId: string; body: string }) => {
    return viaGateway(conn => addHermesTaskComment(conn, params.taskId, params.body));
  });

  // ── MCP servers the gateway itself has registered (gbrain, pencil, …) ──
  // Distinct from Tars' own mcp-* fleet: this asks the gateway what it knows,
  // so Settings > Memory Backends can offer a found URL instead of an empty
  // field, and can say plainly when that URL is the gateway's own loopback.
  ipcMain.handle('hermes:mcp:servers', async () => viaGateway(fetchHermesMcpServers));

  // ── Gateway's own pluggable memory provider (holographic, mem0, …) ──
  ipcMain.handle('hermes:memory:providers', async () => viaGateway(fetchHermesMemoryProviders));

  ipcMain.handle('hermes:memory:setProvider', async (_event, params: { provider: string }) =>
    viaGateway(conn => setHermesMemoryProvider(conn, params.provider)));

  /**
   * Test a gateway URL, including whether the session it would use works.
   *
   * This used to open a socket, take any HTTP response at all, and answer
   * `success: true`. Against a gateway that answers its public routes and
   * rejects every authenticated one, that is a green light on a dead session:
   * the exact reading that hid a week of Unauthorized. It now goes through the
   * same probe the Settings page uses, so the two cannot disagree, and it
   * distinguishes the three states that matter rather than two.
   *
   * `reachable` and `signedIn` are the contract; `success` stays and keeps its
   * meaning of "nothing more to do here", so an existing caller reading only
   * that gets a truthful answer without knowing about the third state.
   */
  ipcMain.handle('hermes:testGateway', async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url.trim())) {
      return { success: false, reachable: false, signedIn: false, error: 'Enter an http(s):// URL first' };
    }
    // The saved connection's token comes along, because a token gateway is
    // authenticated by that header and testing without it would call a working
    // setup broken. Only the URL under test is overridden.
    const probe = await probeHermes({ ...readConnection(), mode: 'remote', url: url.trim() });
    return {
      success: probe.reachable && (!probe.authRequired || probe.signedIn),
      reachable: probe.reachable,
      signedIn: probe.signedIn,
      needsSignIn: probe.reachable && probe.authRequired && !probe.signedIn,
      status: probe.status,
      version: probe.version,
      error: probe.error,
    };
  });
}
