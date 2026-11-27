import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { writeAtomicSync, writeSecretFileSync } from '../utils/secret-file';

/**
 * Tars's own Hermes home and its profiles (Hermes Agent, measured on 0.23.4, 26 and 27/11).
 *
 * - **The home** is `~/.tars/hermes`, never the user's `~/.hermes`: that one runs the user's own gateway (their
 *   messaging platforms), memory, skills and kanban. Its Python dependencies are synced once, on the first start
 *   (about 135 MB from PyPI, about 1.2 GB on disk), and kept: a home of its own is a data root of its own.
 * - **One gateway per home runs every session,** multiplexing the profiles (`gateway.multiplex_profiles`), and a chat
 *   hands it only allowlisted, non-secret variables of its terminal. A session's provider key and its MCP servers'
 *   `${VAR}` come from its profile's `.env`, Hermes's secret scope for that profile, never from the terminal.
 * - **So each agent is a profile,** `profiles/<agent id>`, its `HERMES_HOME`, with:
 *   - a `config.yaml` written whole at each start: the endpoint (through Tars's proxy), the guards below, the
 *     approvals of its permission mode, and Tars's MCP servers with their variables, the token by `${...}` only;
 *   - a `.env` at 0600 holding that terminal's proxy token, the proxy's address and its Tars token, and nothing
 *     else: never an endpoint's real key (it stays in ~/.tars-private, the proxy swaps it in) nor a user's
 *     credential. Written when the terminal starts, removed when it ends, and swept at the next start after a crash.
 *     SECURITY.md says what it is and is not.
 * - **The guards,** each a default of Hermes that reaches past the home: the telemetry question at the first start
 *   (answered no), `auth.adopt_external_logins` (it borrows and refreshes the Codex CLI's and Claude Code's logins,
 *   whose refresh tokens are single use), passive update checks, and the catalog fetches those leave on.
 * - **Hooks are not how Tars reads its turns:** a hook runs in the gateway with the profile's HERMES_HOME but neither
 *   token (measured 27/11), so it could not report to Tars as its agent. Each profile has its own `state.db`, which
 *   hermes-agent-turns.ts reads instead.
 * - **The gateway** outlives the terminal that started it (`--idle-exit`). Tars stops its home's gateway by the pid its
 *   record names, once that pid is checked to run a Hermes gateway, when the last Hermes agent's terminal ends and
 *   at quit. hermes-home.test.ts lists each way this goes wrong.
 */

export const HERMES_SECRET_VARS = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CLAUDE_MGR_API_TOKEN'] as const;
type SecretVar = typeof HERMES_SECRET_VARS[number];
export type HermesSecrets = { OPENAI_BASE_URL: string } & Partial<Record<Exclude<SecretVar, 'OPENAI_BASE_URL'>, string>>;

/** The one variable of Tars's MCP servers that is a secret: written as `${...}`, its value in the `.env` only. */
const TOKEN_VAR: SecretVar = 'CLAUDE_MGR_API_TOKEN';

export interface HermesMcpServer {
  command: string;
  args: string[];
  /** The names of the variables it reads (mcp-orchestrator-env.ts). */
  env: readonly string[];
}

export interface HermesProfileSpec {
  /** Tars's endpoint proxy, `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  model: string;
  permissionMode?: string;
  mcpServers: Record<string, HermesMcpServer>;
  /** The values of the servers' variables that are not secrets (the agent's id, name, project, Tars's address). */
  mcpValues: Record<string, string>;
}

export function hermesRoot(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'hermes');
}

const AGENT_ID = /^[A-Za-z0-9._-]+$/;

export function hermesProfileDir(root: string, agentId: string): string {
  if (!AGENT_ID.test(agentId) || agentId === '.' || agentId === '..') throw new Error(`not an agent id: ${JSON.stringify(agentId)}`);
  return path.join(root, 'profiles', agentId);
}

/**
 * Whether a worker may run Hermes, which the owner has yet to choose (SECURITY.md § 10). Hermes 0.23.4 has no way to
 * refuse what other processes send its sessions: any process of the user can start a turn in an agent's profile
 * through its home's gateway, while the rule for every other CLI is that a worker refuses all of it.
 * - `stated-exception`: Hermes workers run, the exception stated, until Hermes can refuse.
 * - `orchestrators-only`: only an agent with the orchestrator's powers starts Hermes until then.
 * Set here, once the owner has chosen; this is what PR 1 ran with.
 */
export type HermesWorkerPolicy = 'stated-exception' | 'orchestrators-only';
export const HERMES_WORKER_POLICY: HermesWorkerPolicy = 'stated-exception';

/** Why this agent may not start Hermes under the policy, or null. */
export function hermesRoleRefusal(orchestrator: boolean, policy: HermesWorkerPolicy = HERMES_WORKER_POLICY): string | null {
  if (orchestrator || policy === 'stated-exception') return null;
  return 'Hermes runs as an orchestrator only for now: it cannot refuse what other processes send its sessions, which a worker must.';
}

/** normal (and plan, which Hermes does not have) ask before a dangerous command; auto and bypass let Hermes judge. */
export function approvalsModeFor(permissionMode: string | undefined): 'manual' | 'smart' {
  return permissionMode === 'auto' || permissionMode === 'bypass' ? 'smart' : 'manual';
}

// ---- YAML, written by hand: maps, lists of strings, strings, booleans and numbers. Every string is a double-quoted
// scalar whose characters outside printable ASCII are escapes, so no value can end a line, start a comment or a key.

function yamlString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return `${out}"`;
}

type Yaml = string | boolean | number | string[] | { [key: string]: Yaml | undefined };

function yamlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : yamlString(key);
}

function yamlMap(map: { [key: string]: Yaml | undefined }, indent = ''): string {
  let out = '';
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    const head = `${indent}${yamlKey(key)}:`;
    if (Array.isArray(value)) out += `${head} [${value.map(yamlString).join(', ')}]\n`;
    else if (typeof value === 'object') {
      const inner = yamlMap(value, `${indent}  `);
      out += inner ? `${head}\n${inner}` : `${head} {}\n`;
    } else if (typeof value === 'string') out += `${head} ${yamlString(value)}\n`;
    else out += `${head} ${String(value)}\n`;
  }
  return out;
}

const HEADER = '# Written by Tars at each start of the agent: changes made here are replaced.\n';

/** What every config of Tars's home says, the root's and each profile's. */
const GUARDS = {
  telemetry: { shared_metrics: { enabled: false, send: false, offer_version: 2 } },
  auth: { adopt_external_logins: false },
  updates: { check: false },
  // updates.check off leaves three fetches on (27/11, through a logging proxy): the model catalog
  // (raw.githubusercontent.com), the plugin catalog (hermes-agent.nousresearch.com) and a model capability list
  // (openrouter.ai). With these two, a chat and a minute of its gateway idling reached no host but the proxy.
  model_catalog: { enabled: false },
  plugins: { auto_update_check_hours: 0 },
  // The first start still asked two more (27/11, the real binary, then the bench's stack traces): the default plugins
  // step fetches the plugin catalog (hermes-agent.nousresearch.com) and the plugins' sources (github.com). Lazy
  // installs off stops it; the first sync of the home still runs (measured on the installed binary).
  security: { allow_lazy_installs: false },
};

/**
 * The origin of Tars's proxy, which a profile's base URL must be: a profile only ever talks to Tars on the loopback,
 * so neither an endpoint's own address nor a lookup of Hermes's reaches another host through it.
 */
function proxyOrigin(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('A Hermes profile talks to Tars\'s proxy only, and this base URL is not one.'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('A Hermes profile talks to Tars\'s proxy on the loopback only.');
  }
  return url.origin;
}

/**
 * What both configs say besides the guards. models.dev's registry is fetched by the model picker's warm-up at every
 * interactive start, which no setting turns off; its URL is the one thing Hermes lets a config change
 * (`models_dev.url`), so it goes to the proxy, which answers it 401 without forwarding anything.
 */
function lookupsAt(baseUrl: string) {
  return { models_dev: { url: `${proxyOrigin(baseUrl)}/models-dev` } };
}

/**
 * The root's config: the gateway's own settings, which every profile's sessions run under. It names the custom
 * provider at the proxy, as each profile does: the gateway resolves its own home's provider as it starts, and with
 * none named it walks the auto chain down to the AWS SDK, which asks the cloud metadata address (measured 27/11). It
 * names no model and holds no key.
 */
export function hermesRootConfig(baseUrl: string): string {
  return HEADER + yamlMap({
    gateway: { multiplex_profiles: true },
    model: { provider: 'custom', base_url: baseUrl },
    ...GUARDS,
    ...lookupsAt(baseUrl),
  });
}

/**
 * Tars's per-terminal variables that are no secret: the agent's identity, its project, its temporary folders. One
 * gateway runs every profile's sessions with the environment of the terminal that started it, so without this a
 * session's tools ran with that agent's (measured 27/11 on the real binary: B's tool had A's CLAUDE_AGENT_ID and
 * TMPDIR). `terminal.client_env_passthrough` has each session's tools take these from its own chat's terminal, and
 * unset the ones it does not hold. Its tokens are the profile's `.env`'s, never these.
 */
export const HERMES_PASSTHROUGH = [
  'CLAUDE_AGENT_ID', 'CLAUDE_AGENT_NAME', 'CLAUDE_PROJECT_PATH', 'CLAUDE_SKILLS', 'CLAUDE_PROVIDER', 'CLAUDE_MGR_API_URL',
  'TARS_INSTANCE_ID', 'TARS_CHATS_READ', 'TMPDIR', 'CLAUDE_CODE_TMPDIR',
] as const;

/** One agent's config: its endpoint, the guards, its approvals, its tools' own variables and Tars's MCP servers. */
export function hermesProfileConfig(spec: HermesProfileSpec): string {
  const lookups = lookupsAt(spec.baseUrl);
  const servers: { [name: string]: Yaml } = {};
  for (const [name, server] of Object.entries(spec.mcpServers)) {
    const env: { [name: string]: string } = {};
    for (const v of server.env) {
      if (v === TOKEN_VAR) env[v] = `\${${TOKEN_VAR}}`;
      else if (spec.mcpValues[v] !== undefined) env[v] = spec.mcpValues[v];
    }
    servers[name] = { command: server.command, args: [...server.args], env };
  }
  return HEADER + yamlMap({
    model: { provider: 'custom', base_url: spec.baseUrl, default: spec.model },
    ...GUARDS,
    ...lookups,
    approvals: { mode: approvalsModeFor(spec.permissionMode) },
    terminal: { client_env_passthrough: [...HERMES_PASSTHROUGH] },
    mcp_servers: servers,
  });
}

/** A value of the `.env`: one word Hermes's reader takes as it is, nothing it could expand or end a line with. */
const ENV_VALUE = /^[A-Za-z0-9._:/+=-]+$/;

/** The `.env` of a profile: the three variables, in order, each checked. */
export function hermesEnvText(secrets: HermesSecrets): string {
  const extra = Object.keys(secrets).filter(k => !(HERMES_SECRET_VARS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`a Hermes profile's .env holds only ${HERMES_SECRET_VARS.join(', ')}, not ${extra.join(', ')}`);
  let out = '';
  for (const name of HERMES_SECRET_VARS) {
    const value = secrets[name];
    if (value === undefined) continue;
    if (!ENV_VALUE.test(value)) throw new Error(`${name} is not a value a Hermes .env can hold as it is`);
    if (name === 'OPENAI_BASE_URL') proxyOrigin(value);
    out += `${name}=${value}\n`;
  }
  return out;
}

/**
 * At an agent terminal's start: the root's config, the agent's config and its `.env` (0600, written as every secret
 * of Tars is, with no readable temporary copy). The `.env` first goes, so a failure leaves no stale token behind.
 */
export function writeHermesProfile(root: string, agentId: string, spec: HermesProfileSpec, secrets: HermesSecrets): void {
  const dir = hermesProfileDir(root, agentId);
  // Every text checked before anything is written: a refused one writes nothing.
  const rootText = hermesRootConfig(spec.baseUrl);
  const profileText = hermesProfileConfig(spec);
  const envText = hermesEnvText(secrets);
  removeHermesSecrets(root, agentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomicSync(path.join(root, 'config.yaml'), rootText);
  writeAtomicSync(path.join(dir, 'config.yaml'), profileText);
  writeSecretFileSync(path.join(dir, '.env'), envText);
}

/** At the terminal's end: its `.env`, the tokens it held being revoked with the terminal anyway. */
export function removeHermesSecrets(root: string, agentId: string): void {
  fs.rmSync(path.join(hermesProfileDir(root, agentId), '.env'), { force: true });
}

/**
 * At Tars's start, and whenever asked: the `.env` of every profile whose terminal is gone (a crash, a quit that did
 * not finish). A link named `.env` is removed as a link. Returns the profiles swept.
 */
export function sweepHermesSecrets(root: string, isLive: (agentId: string) => boolean): string[] {
  let names: string[];
  try { names = fs.readdirSync(path.join(root, 'profiles')); } catch { return []; }
  const swept: string[] = [];
  for (const name of names) {
    if (!AGENT_ID.test(name) || name === '.' || name === '..' || isLive(name)) continue;
    const file = path.join(root, 'profiles', name, '.env');
    try { fs.lstatSync(file); } catch { continue; }
    fs.rmSync(file, { force: true });
    swept.push(name);
  }
  return swept;
}

export interface GatewayStopDeps {
  platform?: NodeJS.Platform;
  /** The command line of the process under the pid, or null when there is none (or it cannot be read). */
  commandOf: (pid: number) => Promise<string | null>;
  /** macOS and Linux: the HERMES_HOME of the process's own environment; null when it has none or it cannot be read. */
  homeOf: (pid: number) => Promise<string | null>;
  /** Windows: when the process started (ms since the epoch); null when it cannot be read. */
  startedAt: (pid: number) => Promise<number | null>;
  stop: (pid: number) => Promise<void>;
}

/** How far a gateway's start may be from its record's writing: it writes the record as it starts (seconds). */
const RECORD_SLACK_MS = 120_000;

const samePath = (a: string, b: string) => {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

/** A Hermes gateway's command line: `python3 -m hermes_cli.main [--profile <p>] gateway run ...` (measured). */
const GATEWAY_COMMAND = /\bhermes_cli[./\\]main\b.*\bgateway\s+run\b/;

/** A path with every symlink resolved, its missing tail (a profile not written yet, or removed) kept as it is. */
function resolvedPath(p: string): string {
  const missing: string[] = [];
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync(at), ...missing.reverse());
    } catch {
      if (path.dirname(at) === at) return path.resolve(p);
      missing.push(path.basename(at));
    }
  }
}

/**
 * The home as Hermes names it: Hermes resolves its home (measured 27/11: a home under macOS's /tmp is
 * /private/tmp/... in its gateway's environment and record), so the folders above it are resolved. The home itself
 * must not be a symlink: any agent can write in ~/.tars, and one to the user's ~/.hermes would make that home's
 * gateway pass for Tars's. Null when it is one, or is gone.
 */
function resolvedHome(root: string): string | null {
  try {
    return fs.lstatSync(root).isSymbolicLink() ? null : fs.realpathSync(root);
  } catch {
    return null;
  }
}

/** This home, or a profile of it, both resolved: where a gateway of Tars's runs from. */
function inThisHome(home: string, root: string): boolean {
  const real = resolvedHome(root);
  if (!real) return false;
  const own = resolvedPath(home);
  if (samePath(own, real)) return true;
  const rel = path.relative(path.join(real, 'profiles'), own);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/**
 * Stops the gateway of Tars's home: the pid its record (`<home>/gateway.pid`, `{"pid", "hermes_home", ...}`) names,
 * only when the process under that pid runs a Hermes gateway of this home. The record alone is not believed (the
 * Audit's L1 on #654): a crash can leave it while the pid goes to another process, the user's own gateway included,
 * whose command line is the same, and any agent can write it (~/.tars is in every agent's --add-dir). So the process
 * decides: on macOS and Linux its own HERMES_HOME is this home or one of its profiles; on Windows, where another
 * process's environment cannot be read, it started when the record was written. Anything else stops nothing. Paths
 * are compared resolved, as Hermes resolves its home, and a home that is itself a symlink stops nothing.
 */
export async function stopHermesGateway(root: string, deps: GatewayStopDeps): Promise<'stopped' | 'none' | 'not-this-home' | 'not-a-gateway'> {
  const verdict = await judgeHermesGateway(root, deps);
  if (typeof verdict !== 'object') return verdict;
  await deps.stop(verdict.pid);
  return 'stopped';
}

/**
 * The live gateway of Tars's home, by the stop's own checks, or null: what Tars reuses rather than start another, and
 * waits for before a Hermes chat starts (a chat that finds none starts its own, with its terminal's environment).
 */
export async function findHermesGateway(root: string, deps: Omit<GatewayStopDeps, 'stop'>): Promise<number | null> {
  const verdict = await judgeHermesGateway(root, deps);
  return typeof verdict === 'object' ? verdict.pid : null;
}

/** The checks of the stop (above), as one verdict: the gateway's pid, or why its record is not believed. */
async function judgeHermesGateway(root: string, deps: Omit<GatewayStopDeps, 'stop'>): Promise<{ pid: number } | 'none' | 'not-this-home' | 'not-a-gateway'> {
  const file = path.join(root, 'gateway.pid');
  let record: unknown;
  let written: number;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
    written = fs.statSync(file).mtimeMs;
  } catch {
    return 'none';
  }
  const { pid, hermes_home: home } = (record && typeof record === 'object' ? record : {}) as { pid?: unknown; hermes_home?: unknown };
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return 'none';
  const real = resolvedHome(root);
  if (typeof home !== 'string' || !real || !samePath(resolvedPath(home), real)) return 'not-this-home';
  const command = await deps.commandOf(pid);
  if (!command) return 'none';
  if (!GATEWAY_COMMAND.test(command)) return 'not-a-gateway';
  if ((deps.platform ?? process.platform) === 'win32') {
    const started = await deps.startedAt(pid);
    if (started === null || Math.abs(started - written) > RECORD_SLACK_MS) return 'not-this-home';
  } else {
    const own = await deps.homeOf(pid);
    if (!own || !inThisHome(own, root)) return 'not-this-home';
  }
  return { pid };
}

/** What the gateway takes from Tars's own environment, when Tars has it: the user's home, locale and network proxy. */
const GATEWAY_FROM_TARS = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy',
] as const;
/** And on Windows, what Python and Hermes need of the system there. */
const GATEWAY_FROM_TARS_WIN32 = [
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
] as const;

/**
 * The environment Tars starts its Hermes gateway with (core/hermes-gateway.ts): no agent's identity in it. One gateway
 * runs every Hermes agent's sessions; started from an agent's terminal, as Hermes does by itself, it carried that
 * agent's id, token, project and temporary folder (measured 27/11): every session's tools had them, and that agent's
 * stop ended the gateway the others shared (core/born-processes.ts tags a process by the agent id in its environment).
 * So, exactly:
 * - PATH: Tars's own, as its agents get it, so the MCP servers a session starts (`node`) and its tools are found;
 * - the user's home, name, shell and locale, and the user's network proxy when Tars has one (the first start syncs
 *   Hermes's packages from PyPI); on Windows, the system variables Python needs;
 * - HERMES_HOME, Tars's Hermes home (the root); a temporary folder of its own there, never an agent's;
 * - AWS_EC2_METADATA_DISABLED=true (hermes-provider.ts says why).
 * Nothing else: no agent's id, name, project or token, no Tars address or instance, no endpoint token, no provider key.
 * It needs none: each session's model calls carry its own profile's proxy token, and the MCP servers it starts for a
 * session get that agent's address and token from its profile (`${CLAUDE_MGR_API_TOKEN}` from its `.env`).
 */
export function hermesGatewayEnv(source: NodeJS.ProcessEnv, root: string, fullPath: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...GATEWAY_FROM_TARS, ...(platform === 'win32' ? GATEWAY_FROM_TARS_WIN32 : [])]) {
    const value = source[name];
    if (typeof value === 'string' && value) env[name] = value;
  }
  const tmp = path.join(root, 'tmp');
  if (platform === 'win32') { env.TEMP = tmp; env.TMP = tmp; } else env.TMPDIR = tmp;
  env.PATH = fullPath;
  env.HERMES_HOME = root;
  env.AWS_EC2_METADATA_DISABLED = 'true';
  return env;
}
