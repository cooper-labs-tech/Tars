import * as path from 'path';
import * as os from 'os';

// Overridable so an E2E-sandboxed instance can run beside the real app
export const API_PORT = Number(process.env.DOROTHY_API_PORT) || 31415;

/**
 * Loopback-only port for Tars's OpenAI-compatible translation bridge (see
 * services/openai-bridge.ts for why it exists and why it is a separate server
 * rather than a route on the main API server). One server, one port, serving
 * every OpenAI-only vendor (Venice, and the user's own custom endpoint) - each
 * addressed by a path segment, not a port of its own; see that file's header
 * for why. Derived from API_PORT so a sandboxed or E2E instance running beside
 * the real app never collides.
 */
export const OPENAI_BRIDGE_PORT = API_PORT + 1;

export const OLD_DATA_DIR = path.join(os.homedir(), '.claude-manager');

/**
 * Everything the app owns on disk lives here.
 *
 * The directory still carries the pre-rename name because it holds live user
 * data - agents, settings, the API token, observations, memory - and moving it
 * is a migration, not a rename. This constant is the single place that decides;
 * it used to be ignored by ~70 call sites that each rebuilt the path by hand,
 * which is what made the rename look impossible.
 */
export const DATA_DIR_NAME = '.dorothy';
export const DATA_DIR = path.join(os.homedir(), DATA_DIR_NAME);

/** Join a path inside the data directory. */
export const dataPath = (...segments: string[]) => path.join(DATA_DIR, ...segments);

/**
 * What the app owns that its agents are not handed.
 *
 * Every agent is started with `--add-dir ~/.dorothy`: the directory holds the
 * Tars CLAUDE.md they are meant to read and the vault they are meant to write,
 * so it is handed over deliberately. JeanBrasse's own conversation with the super
 * chat was in it too, in clear, and reading it took no API call and no token -
 * an `ls` of the directory the agent was given, and a `cat`.
 *
 * So there is a second directory, and the difference between the two is the
 * whole of its documentation: `.dorothy` is what agents work in, this is what
 * they have no business in. Nothing here is ever passed to a CLI.
 *
 * What it is not. `--add-dir` sets tool permissions, not an access boundary,
 * and on this machine 37 of 42 agents run with `--dangerously-skip-permissions`
 * anyway: an agent that goes looking still reads any file its user can read,
 * here as anywhere else in $HOME. What moving the file out does is take it out
 * of the directory an agent is pointed at, off the listing it gets for free,
 * and out of reach of anything that walks `~/.dorothy` on purpose. Closing the
 * rest takes a sandbox, not a path.
 */
export const PRIVATE_DIR_NAME = '.tars-private';
export const PRIVATE_DIR = path.join(os.homedir(), PRIVATE_DIR_NAME);

/** Join a path inside the private directory. */
export const privatePath = (...segments: string[]) => path.join(PRIVATE_DIR, ...segments);

/**
 * The data directory as it must appear inside a generated shell script.
 *
 * Uses $HOME rather than the resolved path so a script written on one machine
 * and run under another HOME (an E2E sandbox, a scheduled job) still resolves
 * correctly. Quote it at the use site.
 */
export const DATA_DIR_SHELL = `$HOME/${DATA_DIR_NAME}`;

export const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
export const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
export const KANBAN_FILE = path.join(DATA_DIR, 'kanban-tasks.json');
export const TELEGRAM_DOWNLOADS_DIR = path.join(DATA_DIR, 'telegram-downloads');
export const VAULT_DIR = path.join(DATA_DIR, 'vault');
export const VAULT_DB_FILE = path.join(DATA_DIR, 'vault.db');
export const API_TOKEN_FILE = path.join(DATA_DIR, 'api-token');
/** The agent bus journal: rooms, threads, messages and deliveries. One file,
 *  written the way agents.json is (temp file then rename), no new service. */
export const BUS_FILE = path.join(DATA_DIR, 'bus.json');
/** JeanBrasse's conversation with the super chat: the private directory, not the
 *  one the agents are handed. OVERSEER_LEGACY_FILE is where it used to be,
 *  read and migrated away from at startup. */
export const OVERSEER_FILE = path.join(PRIVATE_DIR, 'overseer.json');
export const OVERSEER_LEGACY_FILE = path.join(DATA_DIR, 'overseer.json');
/** The secret Settings hands Hermes, the one credential that opens the
 *  webhook: private, since through it Hermes drives any agent of any project.
 *  The legacy path is where it was minted until 1.7.6, moved away at startup. */
export const HERMES_WEBHOOK_SECRET_FILE = path.join(PRIVATE_DIR, 'hermes-webhook-secret');
export const HERMES_WEBHOOK_SECRET_LEGACY_FILE = path.join(DATA_DIR, 'hermes-webhook-secret');

// Updates come from the fork. Pointing this at the upstream repo offered an
// upstream build as an update to a fork install, which would overwrite it.
export const GITHUB_REPO = 'cooper-labs-tech/Tars';

export const MIME_TYPES: { [key: string]: string } = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  // Next's client router fetches RSC payloads as .txt. Served as
  // octet-stream it rejects them and falls back to a full document reload
  // on every first visit to a route (the white flash).
  '.txt': 'text/plain',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export const TG_CHARACTER_FACES: Record<string, string> = {
  robot: '🤖',
  ninja: '🥷',
  wizard: '🧙',
  astronaut: '👨‍🚀',
  knight: '⚔️',
  pirate: '🏴‍☠️',
  alien: '👽',
  viking: '🪓',
  frog: '🐸',
};

export const SLACK_CHARACTER_FACES: Record<string, string> = {
  'robot': ':robot_face:',
  'ninja': ':ninja:',
  'wizard': ':mage:',
  'astronaut': ':astronaut:',
  'knight': ':crossed_swords:',
  'pirate': ':pirate_flag:',
  'alien': ':alien:',
  'viking': ':axe:',
};
