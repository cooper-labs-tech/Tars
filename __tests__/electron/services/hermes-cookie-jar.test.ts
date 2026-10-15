import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The jar that said yes while every call came back 401.
 *
 * A gateway clears a cookie by sending `name=""`. That is two characters, not
 * zero, so a jar testing the value for emptiness without unquoting kept the
 * quotes as if they were a token, sent them back on every request, and went on
 * reporting a session. JeanBrasse had `hasHermesSession` saying yes, the test button
 * green, and Schedules answering Unauthorized, all reading the same jar, for a
 * week.
 *
 * These drive the real client against a real server and assert on the two
 * things the rest of the app can actually observe: what goes out on the wire
 * on the NEXT request, and what `hasHermesSession` answers. Nothing here
 * reaches for `storeCookies`, which is private and should stay free to be
 * rewritten - a jar that keeps these promises by other means still passes.
 */

// DATA_DIR is redirected before the client is imported. It writes its jar at
// import time and on every stored cookie, and the real one is a live 0600
// credential in ~/.dorothy that these tests must never read or overwrite.
// vi.hoisted runs before this file's imports exist, so the path is built from
// globals here and the directory is created in beforeAll.
const { TMP_DATA_DIR } = vi.hoisted(() => {
  const base = process.getBuiltinModule('node:os').tmpdir();
  return { TMP_DATA_DIR: process.getBuiltinModule('node:path').join(base, `tars-hermes-jar-${process.pid}-${Date.now()}`) };
});

vi.mock('../../../electron/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../electron/constants')>()),
  DATA_DIR: TMP_DATA_DIR,
}));

const SESSION_FILE = path.join(TMP_DATA_DIR, 'hermes-session.json');

/** Set-Cookie headers the server will answer with next, and what it received. */
let nextSetCookies: string[] = [];
let lastCookieHeader: string | undefined;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  fs.mkdirSync(TMP_DATA_DIR, { recursive: true });
  server = http.createServer((req, res) => {
    lastCookieHeader = req.headers.cookie;
    if (nextSetCookies.length) res.setHeader('Set-Cookie', nextSetCookies);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

import { hermesRequest, hasHermesSession, clearHermesSession } from '../../../electron/services/hermes-client';

/** A response carrying these Set-Cookie headers, then the request after it. */
async function respondWith(...setCookies: string[]): Promise<void> {
  nextSetCookies = setCookies;
  await hermesRequest(baseUrl, '/set');
  nextSetCookies = [];
}

/** What the client actually sends back, which is the only thing that matters. */
async function cookiesSentNext(): Promise<string> {
  lastCookieHeader = undefined;
  await hermesRequest(baseUrl, '/read');
  return lastCookieHeader ?? '';
}

const PAST = new Date(Date.now() - 86_400_000).toUTCString();
const FUTURE = new Date(Date.now() + 86_400_000).toUTCString();

beforeEach(() => {
  clearHermesSession(baseUrl);
  nextSetCookies = [];
  lastCookieHeader = undefined;
});

afterEach(() => {
  clearHermesSession(baseUrl);
});

describe('a cookie the gateway has cleared', () => {
  // The four spellings of "delete this". The first is the one that got us; the
  // others are the same instruction written differently, and a jar that only
  // reads the value keeps a revoked token forever.
  it.each([
    ['an empty quoted value', 'hermes_session_at=""'],
    ['Max-Age=0', 'hermes_session_at=stillhere; Max-Age=0'],
    ['a negative Max-Age', 'hermes_session_at=stillhere; Max-Age=-1'],
    ['an Expires in the past', `hermes_session_at=stillhere; Expires=${PAST}`],
  ])('is dropped when it arrives as %s', async (_label, clearing) => {
    await respondWith('hermes_session_at=realtoken');
    expect(await cookiesSentNext()).toContain('hermes_session_at=realtoken');

    await respondWith(clearing);

    expect(await cookiesSentNext()).not.toContain('hermes_session_at');
    expect(hasHermesSession(baseUrl)).toBe(false);
  });

  it('is kept when the gateway is renewing it rather than clearing it', async () => {
    await respondWith('hermes_session_at=realtoken; Max-Age=3600');

    expect(await cookiesSentNext()).toContain('hermes_session_at=realtoken');
    expect(hasHermesSession(baseUrl)).toBe(true);
  });

  it('is dropped whatever the value was, since the attribute is the instruction', async () => {
    // Max-Age=0 with a full value is how a gateway revokes without blanking:
    // reading the value alone would call this a healthy session.
    await respondWith('hermes_session_at=a-perfectly-good-looking-token; Max-Age=0');

    expect(await cookiesSentNext()).not.toContain('hermes_session_at');
    expect(hasHermesSession(baseUrl)).toBe(false);
  });
});

describe('Max-Age against Expires', () => {
  it('keeps the cookie when Max-Age says live and Expires says dead', async () => {
    // RFC 6265 5.3: Max-Age wins. Reading Expires first would delete a session
    // the gateway just renewed.
    await respondWith(`hermes_session_at=realtoken; Max-Age=3600; Expires=${PAST}`);

    expect(await cookiesSentNext()).toContain('hermes_session_at=realtoken');
    expect(hasHermesSession(baseUrl)).toBe(true);
  });

  it('drops the cookie when Max-Age says dead and Expires says live', async () => {
    await respondWith(`hermes_session_at=realtoken; Max-Age=0; Expires=${FUTURE}`);

    expect(await cookiesSentNext()).not.toContain('hermes_session_at');
    expect(hasHermesSession(baseUrl)).toBe(false);
  });

  it('ignores a malformed Max-Age instead of reading it as an instruction', async () => {
    // `Number('later')` is NaN, and NaN <= 0 is false, but a jar that coerced
    // it to 0 would delete a live session on a gateway with a sloppy header.
    await respondWith('hermes_session_at=realtoken; Max-Age=later');

    expect(await cookiesSentNext()).toContain('hermes_session_at=realtoken');
    expect(hasHermesSession(baseUrl)).toBe(true);
  });

  it('falls through to Expires when Max-Age is malformed', async () => {
    await respondWith(`hermes_session_at=realtoken; Max-Age=later; Expires=${PAST}`);

    expect(await cookiesSentNext()).not.toContain('hermes_session_at');
    expect(hasHermesSession(baseUrl)).toBe(false);
  });
});

describe('the lie that cost a week', () => {
  it('does not call a jar full of cleared cookies a session', async () => {
    // Exactly what JeanBrasse's jar held: every name present, every value two
    // quotes. `hasHermesSession` read the names and answered yes, so the
    // Settings page said signed in while every authenticated call was 401.
    await respondWith(
      'hermes_session_at=""',
      'hermes_session_rt=""',
      'hermes_session=""',
    );

    expect(hasHermesSession(baseUrl)).toBe(false);
    expect(await cookiesSentNext()).toBe('');
  });

  it('still says yes when one of them carries something', async () => {
    // The other half of the property: this must not answer no out of caution.
    await respondWith('hermes_session_at=""', 'hermes_session_rt=realtoken');

    expect(hasHermesSession(baseUrl)).toBe(true);
  });
});

describe('cookie names that only mean something over https', () => {
  it.each(['__Host-hermes_session_at', '__Secure-hermes_session_at'])(
    'does not keep %s handed over a plain http origin',
    async name => {
      // No browser stores these off https, and sending them back turned three
      // session cookies into nine in the jar JeanBrasse had to read.
      await respondWith(`${name}=realtoken; Path=/`);

      expect(await cookiesSentNext()).not.toContain(name);
      expect(hasHermesSession(baseUrl)).toBe(false);
    },
  );

  it('keeps an ordinary name on the same origin, so the rule is about the prefix', async () => {
    await respondWith('hermes_session_at=realtoken; Path=/');

    expect(await cookiesSentNext()).toContain('hermes_session_at=realtoken');
  });
});

describe('a jar already on disk', () => {
  /** Put a jar on disk and boot the client fresh against it. */
  async function bootWith(contents: string): Promise<typeof import('../../../electron/services/hermes-client')> {
    fs.writeFileSync(SESSION_FILE, contents);
    vi.resetModules();
    return import('../../../electron/services/hermes-client');
  }

  afterEach(() => {
    fs.rmSync(SESSION_FILE, { force: true });
  });

  it('heals itself of cleared cookies written by an older build', async () => {
    // The jar that shipped before this fix holds `""` entries. Restoring them
    // would send revoked tokens back and go on claiming a session.
    const client = await bootWith(JSON.stringify({
      [baseUrl]: { hermes_session_at: '""', hermes_session_rt: '""' },
    }));

    expect(client.hasHermesSession(baseUrl)).toBe(false);
  });

  it('keeps the cookies from that jar that are still real', async () => {
    const client = await bootWith(JSON.stringify({
      [baseUrl]: { hermes_session_at: '""', hermes_session_rt: 'realtoken' },
    }));

    expect(client.hasHermesSession(baseUrl)).toBe(true);
  });

  it('does not restore a prefixed name an insecure origin should never have held', async () => {
    const client = await bootWith(JSON.stringify({
      [baseUrl]: { '__Host-hermes_session_at': 'realtoken' },
    }));

    expect(client.hasHermesSession(baseUrl)).toBe(false);
  });
});

describe('a jar file that is not a jar', () => {
  // It is read at import, so anything it can throw takes the main process with
  // it before a window exists. Every shape here has been seen on a real disk:
  // a truncated atomic write, an empty file, a file of zeroes, a hand edit.
  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['truncated mid-value', '{"http://gw":{"hermes_session_at":"abc'],
    ['not JSON at all', 'hermes_session_at=abc'],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    ['a bare string', '"just a string"'],
    ['NUL bytes', '\u0000\u0000\u0000'],
    ['jar of nulls', '{"http://gw":null}'],
    ['jar of strings', '{"http://gw":"not-an-object"}'],
    ['deeply wrong values', '{"http://gw":{"a":{"b":1}}}'],
  ])('boots the client anyway when the file is %s', async (_label, contents) => {
    fs.writeFileSync(SESSION_FILE, contents);
    vi.resetModules();

    const client = await import('../../../electron/services/hermes-client');

    // Importing is the assertion: a throw here is a main process that never
    // reaches a window, over a file the user cannot see or repair.
    expect(client.hasHermesSession('http://gw')).toBe(false);
    fs.rmSync(SESSION_FILE, { force: true });
  });
});

describe('the file is a credential', () => {
  it.skipIf(!hasPosixModes())('is still 0600 after the jar is written', async () => {
    await respondWith('hermes_session_at=realtoken');

    const mode = fs.statSync(SESSION_FILE).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it.skipIf(!hasPosixModes())('is still 0600 after a write over a file left world-readable', async () => {
    // A jar from an older build, or restored from a backup, can arrive at
    // 0644. The write has to narrow it rather than inherit it.
    await respondWith('hermes_session_at=realtoken');
    fs.chmodSync(SESSION_FILE, 0o644);

    await respondWith('hermes_session_at=anothertoken');

    expect((fs.statSync(SESSION_FILE).mode & 0o777).toString(8)).toBe('600');
  });

  it('never writes a cleared cookie to disk', async () => {
    await respondWith('hermes_session_at=realtoken');
    await respondWith('hermes_session_at=""');

    const onDisk = fs.readFileSync(SESSION_FILE, 'utf-8');
    expect(onDisk).not.toContain('hermes_session_at');
  });
});
