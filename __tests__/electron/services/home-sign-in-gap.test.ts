import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 *
 * Written before the code, on the Audit's read of d69fb357f (25/11):
 * 4. (I-1) gemini-credentials.json counted where gemini does not read it: with encrypted storage off, gemini reads
 *    oauth_creds.json only; under its file storage, gemini-credentials.json only.
 * 6. (L1) The storage read wrong from the variables: encrypted on is the keychain, unless file storage is forced too;
 *    file storage forced alone, or any value but "true", is the plain file.
 * 7. (L1) At a launch, encrypted storage on in Tars's environment, or only in the login shell (an rc file), not taken
 *    for the keychain: a line then claims Tars's home is not signed in.
 * 8. (I-2) A login shell started before the cheap checks: a key from Settings, Tars's home signed in, or the keychain
 *    possible by Tars's own environment each settle it with none.
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

const encrypted = (home: string) => {
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'gemini-credentials.json'), 'encrypted');
};

describe("gemini's encrypted storage (4, 5)", () => {
  const withStorage = (home: string, other: string, storage: 'plain' | 'file' | 'keychain', asRun = storage) =>
    homeSignInGap({ cli: 'gemini', home, keyed: false, shellHome: async () => other, homeDir: root, storage, storageAsRun: async () => asRun });

  it('4. gemini-credentials.json counts only where gemini reads it, under its file storage (I-1)', async () => {
    const tars = path.join(root, 'tars-home');
    const theirs = path.join(root, 'own-home');
    encrypted(theirs);
    expect(await withStorage(tars, theirs, 'plain')).toBeUndefined(); // gemini reads oauth_creds.json then
    expect(await withStorage(tars, theirs, 'file')).toContain('~/own-home');
    encrypted(tars);
    expect(await withStorage(tars, theirs, 'file')).toBeUndefined(); // Tars's home holds it
  });

  it("4. under its file storage, an oauth_creds.json alone is not gemini's sign-in", async () => {
    const tars = path.join(root, 'tars-home');
    const theirs = path.join(root, 'own-home');
    signIn('gemini', theirs);
    expect(await withStorage(tars, theirs, 'file')).toBeUndefined();
    expect(await withStorage(tars, theirs, 'plain')).toContain('~/own-home');
  });

  it('5. with the keychain possible, nothing is claimed, said by Tars\'s environment or only as the CLI runs', async () => {
    const tars = path.join(root, 'tars-home');
    const theirs = path.join(root, 'own-home');
    signIn('gemini', theirs);
    expect(await withStorage(tars, theirs, 'keychain')).toBeUndefined();
    expect(await withStorage(tars, theirs, 'plain', 'keychain')).toBeUndefined();
  });
});

describe('which storage gemini keeps its sign-in in (6, the Audit\'s L1)', () => {
  it.each([
    [{}, 'plain'],
    [{ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' }, 'keychain'],
    [{ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true', GEMINI_FORCE_FILE_STORAGE: 'true' }, 'file'],
    [{ GEMINI_FORCE_FILE_STORAGE: 'true' }, 'plain'],
    [{ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: '1' }, 'plain'],
    [{ GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false', GEMINI_FORCE_FILE_STORAGE: 'true' }, 'plain'],
  ] as const)('6. %j is %s', async (env, storage) => {
    const { geminiStorage } = await import('../../../electron/services/home-sign-in-gap');
    expect(geminiStorage(env)).toBe(storage);
  });
});

/**
 * Through the launch hook, as an agent's start calls it, with a login shell of the test's own: SHELL names a script
 * that logs each start and sets what an rc file would, then runs the command it is given.
 */
describe.skipIf(process.platform === 'win32')('at a gemini launch: the login shell, read only when the question is open (7, 8)', () => {
  const kept: Record<string, string | undefined> = {};
  const NAMES = ['SHELL', 'GEMINI_CLI_HOME', 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE', 'GEMINI_FORCE_FILE_STORAGE'];
  let tars: string;
  let theirs: string;
  let rc: string;
  let starts: string;

  beforeEach(() => {
    vi.resetModules();
    for (const n of NAMES) kept[n] = process.env[n];
    delete process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    delete process.env.GEMINI_FORCE_FILE_STORAGE;
    tars = path.join(root, 'tars-home');
    theirs = path.join(root, 'own-home');
    fs.mkdirSync(tars, { recursive: true });
    process.env.GEMINI_CLI_HOME = tars;
    rc = path.join(root, 'rc');
    starts = path.join(root, 'shell-starts.log');
    const shell = path.join(root, 'login-shell');
    fs.writeFileSync(shell, `#!/bin/sh\nprintf 'start\\n' >> '${starts}'\n[ -f '${rc}' ] && . '${rc}'\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
    process.env.SHELL = shell;
  });
  afterEach(() => {
    for (const n of NAMES) { if (kept[n] === undefined) delete process.env[n]; else process.env[n] = kept[n]; }
  });

  const rcSets = (vars: Record<string, string>) =>
    fs.writeFileSync(rc, Object.entries(vars).map(([k, v]) => `export ${k}='${v}'`).join('\n') + '\n');
  const shellStarts = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0);

  /** The launch hook, its answer awaited, and what it said to the agent. */
  async function launch(keyed = false): Promise<string[]> {
    const said: string[] = [];
    const gap = await import('../../../electron/services/home-sign-in-gap');
    gap.setHomeGapDeps({ keyed: () => keyed, notSignedIn: (_id, text) => { said.push(text); } });
    await gap.noteHomeLaunch('g1', 'gemini');
    // At d69fb357f the hook answered nothing to wait on: its shells are given the time they take.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return said;
  }

  it.each([
    ["encrypted storage in Tars's environment", { env: { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' }, rc: {} }],
    ['encrypted storage set only by the login shell', { env: {}, rc: { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true' } }],
  ] as const)('7. %s: the keychain is possible, nothing is claimed', async (_what, set) => {
    signIn('gemini', theirs);
    Object.assign(process.env, set.env);
    rcSets({ GEMINI_CLI_HOME: theirs, ...set.rc });
    expect(await launch()).toEqual([]);
  });

  it('7. file storage forced by the login shell: the sign-in looked for in gemini-credentials.json', async () => {
    encrypted(theirs);
    rcSets({ GEMINI_CLI_HOME: theirs, GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true', GEMINI_FORCE_FILE_STORAGE: 'true' });
    const said = await launch();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('GEMINI_CLI_HOME');
  });

  it('7. neither: oauth_creds.json, and gemini-credentials.json alone is no sign-in (I-1)', async () => {
    signIn('gemini', theirs);
    rcSets({ GEMINI_CLI_HOME: theirs });
    expect(await launch()).toHaveLength(1);
    fs.rmSync(path.join(theirs, '.gemini', 'oauth_creds.json'));
    encrypted(theirs);
    vi.resetModules();
    expect(await launch()).toEqual([]);
  });

  it('8. a key from Settings, or Tars\'s home signed in, starts no login shell (I-2)', async () => {
    rcSets({ GEMINI_CLI_HOME: theirs });
    signIn('gemini', theirs);
    expect(await launch(true)).toEqual([]);
    expect(shellStarts()).toBe(0);
    signIn('gemini', tars);
    expect(await launch()).toEqual([]);
    expect(shellStarts()).toBe(0);
  });

  it("8. encrypted storage in Tars's environment starts none either; an open question starts them", async () => {
    rcSets({ GEMINI_CLI_HOME: theirs });
    signIn('gemini', theirs);
    process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE = 'true';
    expect(await launch()).toEqual([]);
    expect(shellStarts()).toBe(0);
    delete process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE;
    vi.resetModules();
    expect(await launch()).toHaveLength(1);
    expect(shellStarts()).toBeGreaterThan(0);
  });
});
