import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Codex agents that start not signed in, and why (the Audit's L7 on #465, 2.0.4).
 *
 * Tars hands the codex it starts its own home (`env CODEX_HOME=<Tars's home>` on the line, the Audit's L4), so that
 * Tars and codex read and write one config.toml and one sessions folder. A user whose rc files set CODEX_HOME
 * elsewhere, where their login is, with Tars started from the Dock or Finder (no rc file read: Tars's home is then
 * ~/.codex), gets codex agents that are not signed in. Measured on codex-cli 0.163.0: a codex whose home has no login
 * shows "Welcome to Codex ... Sign in with ChatGPT ... Press enter to continue" and writes no session, so Tars saw
 * nothing, and the agent read as starting, then running, for good.
 *
 * The ways it fails:
 * 1. Not said: the agent's status says nothing of it, and whoever handed it a task waits.
 * 2. Said when it is not so: Tars's home signed in (its auth.json, or a login codex keeps elsewhere, its keyring:
 *    then asked of codex itself, `codex login status`, measured on 0.163: exit 0 "Logged in using ChatGPT", exit 1
 *    "Not logged in"); a key from Settings, which codex takes instead of a login (services/cli-keys.ts); a shell that
 *    sets no CODEX_HOME, or Tars's own folder under another writing; or the shell's home not signed in either, which
 *    is then not this.
 * 3. Said on a guess: a codex that could not answer (not there, failed, hung past its time) is no answer, and nothing
 *    is said; nor is a codex that exits 1 for something else than its login (a config it cannot read): only exit 1
 *    with its own words, "Not logged in", says a home is not signed in.
 * 4. The shell's CODEX_HOME misread: what an rc file prints on the way (a greeting, a prompt's escapes) taken for it,
 *    or one the shell does not set taken for a folder. It is read from a marked line of a login shell's own output.
 * 5. The window frozen while it is asked, or the login shell started at every launch: the shell and codex run off the
 *    main thread, the shell once per run once it has answered (one that failed or hung is asked again next time), and
 *    nothing on Windows, which reads no rc file. Hung: an interactive shell ignores SIGTERM (macOS's /bin/zsh -ilc,
 *    measured: a timeout's SIGTERM left it running), and what its rc files start can hold its output open after it.
 *    Such a shell would never be given up on, the answer waited for for good and never asked again, and the shell
 *    left running: it is ended at its time with what it started, and given up on then. Its time is not a healthy
 *    shell's under load: 20 s, where a login zsh with its rc files took 7.6 s at a load average of 150.
 * 6. The login shown: signed in, `codex login status` names the account. Its output is looked at for "Not logged in"
 *    only, and never kept, logged or said.
 */

import { codexSignInGap, codexSignedIn, codexHomeFromShell, loginShellCodexHome } from '../../../electron/providers/codex-cli';

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-sign-in-')));

/**
 * A codex whose `login status` exits `code` after `before` (shell lines), saying what 0.163 says for that exit, and
 * logging each ask and its CODEX_HOME.
 */
function fakeCodex(code: number, before = ''): { bin: string; asks: () => string[] } {
  const dir = scratch();
  const log = path.join(dir, 'asked');
  const bin = path.join(dir, 'codex');
  const says = code === 0 ? 'Logged in using ChatGPT (someone@example.com)' : code === 1 ? 'Not logged in' : 'Error loading config.toml';
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s %s %s\\n' "$1" "$2" "$CODEX_HOME" >> '${log}'\n${before}echo '${says}'\nexit ${code}\n`, { mode: 0o755 });
  return { bin, asks: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

describe('why a codex agent is not signed in', () => {
  const tars = '/Users/someone/.codex';
  const elsewhere = '/Users/someone/elsewhere';
  const signedIn = (signed: Record<string, boolean | undefined>) => async (_bin: string, home: string) => signed[home];

  it("1. Tars's home not signed in, the shell's CODEX_HOME another folder that is: said, with both folders", async () => {
    const text = await codexSignInGap({
      binaryPath: 'codex', home: tars, keyed: false, homeDir: '/Users/someone',
      shellHome: async () => elsewhere, signedIn: signedIn({ [tars]: false, [elsewhere]: true }),
    });
    expect(text).toContain('~/.codex');
    expect(text).toContain('~/elsewhere');
    expect(text).toMatch(/sign in/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it("2. not said when Tars's home is signed in: the shell is not even asked", async () => {
    let shellAsked = 0;
    const text = await codexSignInGap({
      binaryPath: 'codex', home: tars, keyed: false, homeDir: '/Users/someone',
      shellHome: async () => { shellAsked++; return elsewhere; }, signedIn: signedIn({ [tars]: true, [elsewhere]: true }),
    });
    expect(text).toBeUndefined();
    expect(shellAsked).toBe(0);
  });

  it('2. not said with a key from Settings, which codex takes instead of a login', async () => {
    expect(await codexSignInGap({
      binaryPath: 'codex', home: tars, keyed: true, homeDir: '/Users/someone',
      shellHome: async () => elsewhere, signedIn: signedIn({ [tars]: false, [elsewhere]: true }),
    })).toBeUndefined();
  });

  it("2. not said when the shell sets no CODEX_HOME, sets Tars's own under another writing, or one not signed in either", async () => {
    const dir = scratch();
    const real = path.join(dir, '.codex');
    fs.mkdirSync(real);
    const link = path.join(dir, 'codex-link');
    fs.symlinkSync(real, link);
    const base = { binaryPath: 'codex', keyed: false, homeDir: dir };
    expect(await codexSignInGap({ ...base, home: real, shellHome: async () => undefined, signedIn: signedIn({ [real]: false }) })).toBeUndefined();
    expect(await codexSignInGap({ ...base, home: real, shellHome: async () => `${real}/`, signedIn: signedIn({ [real]: false, [`${real}/`]: true }) })).toBeUndefined();
    expect(await codexSignInGap({ ...base, home: real, shellHome: async () => link, signedIn: signedIn({ [real]: false, [link]: true }) })).toBeUndefined();
    expect(await codexSignInGap({ ...base, home: tars, shellHome: async () => elsewhere, signedIn: signedIn({ [tars]: false, [elsewhere]: false }) })).toBeUndefined();
  });

  it('3. not said on a guess: a codex that could not answer, for either folder', async () => {
    const base = { binaryPath: 'codex', home: tars, keyed: false, homeDir: '/Users/someone', shellHome: async () => elsewhere };
    expect(await codexSignInGap({ ...base, signedIn: signedIn({ [tars]: undefined, [elsewhere]: true }) })).toBeUndefined();
    expect(await codexSignInGap({ ...base, signedIn: signedIn({ [tars]: false, [elsewhere]: undefined }) })).toBeUndefined();
  });
});

describe('whether a codex home is signed in', () => {
  it('its auth.json, where codex keeps a login: codex is not even run', async () => {
    const home = scratch();
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    const { bin, asks } = fakeCodex(1);
    expect(await codexSignedIn(bin, home)).toBe(true);
    expect(asks()).toEqual([]);
  });

  it("else codex's own login status, run on that home: exit 0 signed in, exit 1 not", async () => {
    const home = scratch();
    const yes = fakeCodex(0);
    expect(await codexSignedIn(yes.bin, home)).toBe(true);
    expect(yes.asks()).toEqual([`login status ${home}`]);
    const no = fakeCodex(1);
    expect(await codexSignedIn(no.bin, home)).toBe(false);
  });

  it('3. no answer from a codex that fails otherwise, exits 1 on something else, hangs past its time, or is not there', async () => {
    const home = scratch();
    expect(await codexSignedIn(fakeCodex(3).bin, home)).toBeUndefined();
    const dir = scratch();
    const other = path.join(dir, 'codex');
    fs.writeFileSync(other, "#!/bin/sh\necho 'Error loading config.toml: expected a table' >&2\nexit 1\n", { mode: 0o755 });
    expect(await codexSignedIn(other, home)).toBeUndefined();
    const asked = Date.now();
    expect(await codexSignedIn(fakeCodex(0, 'exec sleep 30\n').bin, home, 300)).toBeUndefined();
    expect(Date.now() - asked).toBeLessThan(5_000);
    expect(await codexSignedIn(path.join(home, 'no-such-codex'), home)).toBeUndefined();
  }, 15_000);
});

describe("the CODEX_HOME the user's shell sets", () => {
  const MARK = '__TARS_CODEX_HOME__=';

  it("4. read from its marked line, whatever the rc files print around it; none when the shell sets none", () => {
    expect(codexHomeFromShell(`Welcome back!\n\u001b]0;title\u0007\n${MARK}/Users/someone/elsewhere\nbye\n`)).toBe('/Users/someone/elsewhere');
    expect(codexHomeFromShell(`${MARK}\n`)).toBeUndefined();
    expect(codexHomeFromShell('no mark at all\n')).toBeUndefined();
    expect(codexHomeFromShell(`${MARK}/first\n${MARK}/second\n`)).toBe('/second');
  });

  /** A login shell that prints a greeting, then runs its -c script with CODEX_HOME as its rc files would set it. */
  function fakeShell(codexHome: string, exitFirst = false): { shell: string; runs: () => number } {
    const dir = scratch();
    const runs = path.join(dir, 'runs');
    const failed = path.join(dir, 'failed-once');
    const shell = path.join(dir, 'zsh');
    fs.writeFileSync(shell, [
      '#!/bin/sh',
      `echo x >> '${runs}'`,
      exitFirst ? `if [ ! -f '${failed}' ]; then : > '${failed}'; exit 1; fi` : '',
      'echo "Last login: today"',
      `CODEX_HOME='${codexHome}'; export CODEX_HOME`,
      'shift; exec /bin/sh -c "$1"',
      '',
    ].join('\n'), { mode: 0o755 });
    return { shell, runs: () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n').length : 0) };
  }

  it('5. asked of a login shell once per run, off the main thread', async () => {
    const { shell, runs } = fakeShell('/Users/someone/elsewhere');
    expect(await loginShellCodexHome(shell, 'darwin')).toBe('/Users/someone/elsewhere');
    expect(await loginShellCodexHome(shell, 'darwin')).toBe('/Users/someone/elsewhere');
    expect(runs()).toBe(1);
  });

  it('5. a shell that failed is asked again next time; Windows reads no rc file', async () => {
    const { shell, runs } = fakeShell('/Users/someone/elsewhere', true);
    expect(await loginShellCodexHome(shell, 'linux')).toBeUndefined();
    expect(await loginShellCodexHome(shell, 'linux')).toBe('/Users/someone/elsewhere');
    expect(runs()).toBe(2);
    const windows = fakeShell('C:\\Users\\someone\\elsewhere');
    expect(await loginShellCodexHome(windows.shell, 'win32')).toBeUndefined();
    expect(windows.runs()).toBe(0);
  });

  it('5. a shell its rc files hold past its time, deaf to SIGTERM as an interactive zsh is, is ended with what they started, and asked again next time', async () => {
    const dir = scratch();
    const runs = path.join(dir, 'runs');
    const pids = path.join(dir, 'pids');
    const shell = path.join(dir, 'zsh');
    // The shell ignores SIGTERM, and so does what its rc file starts, which holds the shell's output open.
    fs.writeFileSync(shell, [
      '#!/bin/sh',
      `echo x >> '${runs}'`,
      "trap '' TERM",
      `sleep 30 & echo "$$ $!" >> '${pids}'`,
      'wait',
      '',
    ].join('\n'), { mode: 0o755 });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

    // Its time is long enough for the shell to reach its `wait` under load: at its time the whole process group is
    // killed (SIGKILL), and a shell cut before its echo line never writes the pids this reads (ENOENT at a load of
    // 12.8, 25/11). Still well inside the bound below, which is what says it was ended at its time and not waited for.
    const asked = Date.now();
    expect(await loginShellCodexHome(shell, 'darwin', 6_000)).toBeUndefined();
    expect(Date.now() - asked).toBeLessThan(10_000);
    await expect.poll(() => fs.existsSync(pids), { timeout: 5_000, message: 'the shell wrote its pid and its child\'s' }).toBe(true);
    const [shellPid, rcPid] = fs.readFileSync(pids, 'utf8').trim().split('\n')[0].split(' ').map(Number);
    await expect.poll(() => alive(shellPid), { timeout: 3_000 }).toBe(false);
    await expect.poll(() => alive(rcPid), { timeout: 3_000 }).toBe(false);

    expect(await loginShellCodexHome(shell, 'darwin', 6_000)).toBeUndefined();
    expect(fs.readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 45_000);
});
