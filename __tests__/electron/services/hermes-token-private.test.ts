import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Hermes dashboard's token moves from ~/.dorothy to ~/.tars-private (JeanBrasse's decision 6 of 2026-10-01,
 * DESIGN-RELAIS-HERMES-V2.md). ~/.dorothy is in every agent's --add-dir: an agent could read the token there, and with
 * the relay plugin installed the token also lets its holder write to the user as Tars, and read or delete their
 * replies. Nothing under ~/.tars-private is passed to a CLI.
 *
 * How this can fail, written before the code:
 * 1. Saving a connection writes the token into ~/.dorothy/hermes-connection.json.
 * 2. The token in ~/.tars-private can be read by others: not 0600, in a folder not 0700.
 * 3. A connection saved before this version keeps its token in ~/.dorothy: it is not moved at the first read; or it is
 *    moved and lost, so the gateway calls go out unauthenticated; or the old file keeps a copy.
 * 4. A connection read back lacks its token, by either reader (the one the IPC uses, and the one that never guesses).
 * 5. A connection saved with no token leaves the old one in ~/.tars-private.
 */

const dorothyFile = () => path.join(os.homedir(), '.dorothy', 'hermes-connection.json');
const privateFile = () => path.join(os.homedir(), '.tars-private', 'hermes-token');
type Config = typeof import('../../../electron/services/hermes-config');
let config: Config;

beforeEach(async () => {
  fs.rmSync(path.join(os.homedir(), '.dorothy'), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  vi.resetModules();
  config = await import('../../../electron/services/hermes-config');
});

describe('the dashboard token', () => {
  it('1, 2, 4. is saved in ~/.tars-private, 0600 in 0700, never in ~/.dorothy, and read back by both readers', () => {
    config.writeHermesConnection({ mode: 'local', localPort: 9119, authMode: 'token', token: 'secret-dashboard-token' });

    expect(fs.readFileSync(dorothyFile(), 'utf-8')).not.toContain('secret-dashboard-token');
    expect(fs.readFileSync(privateFile(), 'utf-8').trim()).toBe('secret-dashboard-token');
    expect(fs.statSync(privateFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(privateFile())).mode & 0o777).toBe(0o700);
    expect(config.readHermesConnection().token).toBe('secret-dashboard-token');
    expect(config.usableHermesConnection()?.token).toBe('secret-dashboard-token');
  });

  it('3. one saved before this version is moved at the first read, kept working, and gone from ~/.dorothy', () => {
    fs.mkdirSync(path.dirname(dorothyFile()), { recursive: true });
    fs.writeFileSync(dorothyFile(), JSON.stringify({ mode: 'local', localPort: 9119, authMode: 'token', token: 'old-token' }), { mode: 0o600 });

    const conn = config.usableHermesConnection();

    expect(conn).toMatchObject({ mode: 'local', localPort: 9119, token: 'old-token' });
    expect(fs.readFileSync(dorothyFile(), 'utf-8')).not.toContain('old-token');
    expect(JSON.parse(fs.readFileSync(dorothyFile(), 'utf-8'))).toMatchObject({ mode: 'local', localPort: 9119 });
    expect(fs.readFileSync(privateFile(), 'utf-8').trim()).toBe('old-token');
  });

  it('5. a connection saved with no token leaves none behind', () => {
    config.writeHermesConnection({ mode: 'local', localPort: 9119, authMode: 'token', token: 'secret-dashboard-token' });
    config.writeHermesConnection({ mode: 'local', localPort: 9119, authMode: 'oauth', token: '' });

    expect(fs.existsSync(privateFile())).toBe(false);
    expect(config.readHermesConnection().token).toBeFalsy();
  });
});
