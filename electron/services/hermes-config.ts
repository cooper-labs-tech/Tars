import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, privatePath } from '../constants';
import { defaultHermesConnection, type HermesConnection } from '../types/hermes';
import { describeSecretFileError, ensureSecretFileMode, writeSecretFileSync } from '../utils/secret-file';

/**
 * The gateway connection, read from one place. The IPC handlers and the local
 * HTTP API both need it: memory routes serve agents, which never go through
 * the renderer.
 */

export const HERMES_CONNECTION_FILE = path.join(DATA_DIR, 'hermes-connection.json');

/**
 * The dashboard's session token, apart from the rest of the connection: in
 * ~/.tars-private, which no agent is handed, where ~/.dorothy is in every
 * agent's --add-dir (JeanBrasse's decision 6, 2026-10-01). Whoever holds it can drive
 * the dashboard, and, with the tars-relay plugin on the server, write to the
 * user as Tars and read or delete their replies.
 */
export const HERMES_TOKEN_FILE = privatePath('hermes-token');

function readToken(): string | undefined {
  try {
    return fs.readFileSync(HERMES_TOKEN_FILE, 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string | undefined): void {
  if (token) writeSecretFileSync(HERMES_TOKEN_FILE, token);
  else fs.rmSync(HERMES_TOKEN_FILE, { force: true });
}

/**
 * What the file holds once its token is out of it. A connection saved before
 * 1.9.2 kept its token in ~/.dorothy: it moves to ~/.tars-private at the first
 * read, and the file is written again without it. A token found there wins: an
 * older Tars that ran since wrote it last.
 */
function withoutToken(file: Partial<HermesConnection>): Partial<HermesConnection> {
  if (!('token' in file)) return file;
  const { token, ...rest } = file;
  if (typeof token === 'string' && token) writeToken(token);
  writeSecretFileSync(HERMES_CONNECTION_FILE, JSON.stringify(rest, null, 2));
  return rest;
}

export function readHermesConnection(): HermesConnection {
  try {
    if (fs.existsSync(HERMES_CONNECTION_FILE)) {
      // This file holds `token`, the static X-Hermes-Session-Token sent on
      // every gateway call, and it used to be written with a bare
      // writeFileSync - 0644 under a default umask, so any other account on
      // the machine could read the credential. The write is 0600 now, but a
      // file created by an older build keeps its mode forever, and a `mode:`
      // on writeFileSync only applies at creation. main.ts narrows it at
      // startup; do it here too so the guarantee belongs to the module that
      // owns the file rather than to a caller remembering.
      ensureSecretFileMode(HERMES_CONNECTION_FILE);
      const file = withoutToken(JSON.parse(fs.readFileSync(HERMES_CONNECTION_FILE, 'utf-8')));
      return { ...defaultHermesConnection(), ...file, token: readToken() };
    }
  } catch (err) {
    // Same reason as the session jar: this file holds `token`, and a parse
    // error would quote its first characters into the log.
    console.error(`[hermes] cannot read connection config: ${describeSecretFileError(err)}`);
  }
  return defaultHermesConnection();
}

export function writeHermesConnection(conn: HermesConnection): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { token, ...rest } = conn;
  writeToken(token);
  writeSecretFileSync(HERMES_CONNECTION_FILE, JSON.stringify(rest, null, 2));
}

/**
 * The connection the file names, for what must never guess. readHermesConnection()
 * fills whatever the file lacks, or all of it when the file cannot be read, from
 * the default, 127.0.0.1:9119, which on JeanBrasse's machine is the SSH tunnel to his
 * Hermes: a broken file sent a sandbox's kanban to his board (the Backend's gate
 * of #171). Here the file must read, parse to an object and name the address its
 * mode needs. Null when there is no file; otherwise the reason, which never quotes
 * the file: it holds the gateway's token.
 */
export function configuredHermesConnection(): { conn: HermesConnection } | { unusable: string } | null {
  if (!fs.existsSync(HERMES_CONNECTION_FILE)) return null;
  const unusable = (why: string) => ({ unusable: `${HERMES_CONNECTION_FILE} ${why}: save the connection again in Settings, Hermes.` });
  let parsed: unknown;
  try {
    ensureSecretFileMode(HERMES_CONNECTION_FILE);
    parsed = JSON.parse(fs.readFileSync(HERMES_CONNECTION_FILE, 'utf-8'));
  } catch (err) {
    return unusable(`cannot be read (${describeSecretFileError(err)})`);
  }
  if (!parsed || typeof parsed !== 'object') return unusable('holds no connection');
  const file = withoutToken(parsed as Partial<HermesConnection>);
  const conn: HermesConnection = { ...defaultHermesConnection(), ...file, token: readToken() };
  switch (file.mode) {
    case 'local': {
      const port = file.localPort;
      return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
        ? { conn }
        : unusable('names no port for the local gateway');
    }
    case 'ssh':
      return typeof file.ssh?.host === 'string' && file.ssh.host.trim() ? { conn } : unusable('names no SSH host');
    case 'remote':
    case 'cloud':
      return typeof file.url === 'string' && file.url.trim() ? { conn } : unusable('names no gateway URL');
    default:
      return unusable('names no mode Tars knows');
  }
}

let lastUnusable: string | null = null;

/**
 * A connection worth attempting: one a file names (configuredHermesConnection).
 * It was readHermesConnection()'s answer, the default port for a file missing or
 * broken: 127.0.0.1:9119, the SSH tunnel to JeanBrasse's Hermes on his machine, which a
 * sandbox's overseer and memory hub reached (the Audit's gate of #183). What is
 * wrong with a broken file is logged once, when it changes; its callers say
 * Hermes is not configured.
 */
export function usableHermesConnection(): HermesConnection | null {
  const configured = configuredHermesConnection();
  if (configured && 'unusable' in configured) {
    if (configured.unusable !== lastUnusable) console.warn(`[hermes] ${configured.unusable}`);
    lastUnusable = configured.unusable;
    return null;
  }
  lastUnusable = null;
  return configured ? configured.conn : null;
}
