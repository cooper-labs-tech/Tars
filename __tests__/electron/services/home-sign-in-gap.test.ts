import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { homeSignInGap } from '../../../electron/services/home-sign-in-gap';

/**
 * Why a gemini or a grok agent asks to sign in, when it is this (the Audit's L3 on #645 at 85bc5c575): a Tars started
 * from the Dock or Finder reads no rc file, so the home it writes and hands its agents is the default one, while the
 * user's shell exports another, where their sign-in is. Their agents then get Tars's hooks and servers, and ask to sign
 * in, and nothing says why. As codex's codexSignInGap does for CODEX_HOME, the login shell's value is read once per run,
 * only to say so.
 *
 * Where each keeps a sign-in in its home, read in its own files: gemini 0.70.0 in .gemini/oauth_creds.json under
 * GEMINI_CLI_HOME; grok 1.0.92 in auth.json in GROK_HOME (which replaces ~/.grok).
 *
 * How it fails, written before the code (25/11):
 * 1. Nothing said while the shell's home holds the sign-in and Tars's does not.
 * 2. Something said when it is not that: Tars's home signed in; a key from Settings (taken instead of a sign-in); a
 *    shell that sets no other home, or a relative one, or the same folder under another spelling; that other home not
 *    signed in either.
 * 3. The sentence names the wrong variable or the wrong homes.
 *
 * Written before the code, on the Audit's read of 6f2196a0b (its Info): with GEMINI_FORCE_ENCRYPTED_FILE_STORAGE on,
 * gemini 0.70.0 keeps its sign-in in the keychain (service gemini-cli-oauth, one for every home) or, without one or
 * with GEMINI_FORCE_FILE_STORAGE, in .gemini/gemini-credentials.json (read in its bundle; measured isolated on 25/11,
 * never the real keychain: a planted gemini-credentials.json is what gemini read at its start).
 * 4. A sign-in kept in gemini-credentials.json not seen: no line where one is due, or a line where Tars's home holds it.
 * 5. With encrypted storage on and the keychain possible, a line claiming Tars's home is not signed in: the keychain
 *    is not read here (no `security`, no keychain call), so nothing is claimed.
 */

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-gap-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const signIn = (cli: 'gemini' | 'grok', home: string) => {
  const file = cli === 'gemini' ? path.join(home, '.gemini', 'oauth_creds.json') : path.join(home, 'auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
};
const gap = (cli: 'gemini' | 'grok', home: string, other: string | undefined, keyed = false) =>
  homeSignInGap({ cli, home, keyed, shellHome: async () => other, homeDir: root });

describe('a gemini or grok agent that will ask to sign in says why (1 to 3)', () => {
  it.each(['gemini', 'grok'] as const)('1 and 3. %s: the shell exports the signed-in home, Tars starts it on another', async (cli) => {
    const tars = path.join(root, cli === 'gemini' ? '' : '.grok');
    const theirs = path.join(root, `${cli}-own`);
    signIn(cli, theirs);
    const said = await gap(cli, tars, theirs);
    expect(said).toContain(cli === 'gemini' ? 'GEMINI_CLI_HOME' : 'GROK_HOME');
    expect(said).toContain(`~/${cli}-own`);
    expect(said).toMatch(/sign in/);
  });

  it.each(['gemini', 'grok'] as const)('2. %s: nothing to say', async (cli) => {
    const tars = path.join(root, `${cli}-tars`);
    const theirs = path.join(root, `${cli}-own`);
    signIn(cli, theirs);
    expect(await gap(cli, tars, theirs, true)).toBeUndefined(); // a key from Settings
    expect(await gap(cli, tars, undefined)).toBeUndefined(); // the shell sets none
    expect(await gap(cli, tars, `${cli}-own`)).toBeUndefined(); // a relative one
    fs.symlinkSync(theirs, path.join(root, 'link'));
    expect(await gap(cli, theirs, path.join(root, 'link'))).toBeUndefined(); // the same folder
    expect(await gap(cli, tars, path.join(root, 'nobody'))).toBeUndefined(); // not signed in there either
    signIn(cli, tars);
    expect(await gap(cli, tars, theirs)).toBeUndefined(); // Tars's own home signed in
  });
});

describe("gemini's encrypted storage (4, 5)", () => {
  const encrypted = (home: string) => {
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'gemini-credentials.json'), 'encrypted');
  };

  it('4. a sign-in kept in gemini-credentials.json counts, in the shell\'s home and in Tars\'s', async () => {
    const tars = path.join(root, 'tars-home');
    const theirs = path.join(root, 'own-home');
    encrypted(theirs);
    expect(await gap('gemini', tars, theirs)).toContain('~/own-home');
    encrypted(tars);
    signIn('gemini', theirs);
    expect(await gap('gemini', tars, theirs)).toBeUndefined();
  });

  it('5. with the keychain possible, nothing is claimed', async () => {
    const tars = path.join(root, 'tars-home');
    const theirs = path.join(root, 'own-home');
    signIn('gemini', theirs);
    expect(await homeSignInGap({ cli: 'gemini', home: tars, keyed: false, shellHome: async () => theirs, homeDir: root, keychainPossible: true })).toBeUndefined();
  });
});
