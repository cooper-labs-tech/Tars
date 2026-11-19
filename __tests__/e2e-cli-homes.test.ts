import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_HOMES, homesOutside, inheritable, launchSandboxed } from '../e2e/fixture.mjs';

/**
 * The folders of the CLIs Tars drives, as the environment names them, and an E2E sandbox.
 *
 * launchSandboxed moves HOME, and a CLI's home that a variable names does not follow it.
 * Tars reads CODEX_HOME (codex-cli.ts: codex's config.toml, sessions and login), KIMI_CODE_HOME
 * (kimi-cli.ts, #601), PI_CODING_AGENT_DIR (pi-provider.ts: pi's mcp.json), XDG_CONFIG_HOME
 * (opencode-provider.ts: opencode.json; git, through safe-git) and CLAUDE_CONFIG_DIR (an account's
 * Claude Code folder). With one of them exported in the runner, a sandboxed Tars wrote into
 * the owner's real folder, and the CLIs it started ran on the owner's login (#608's Audit, L2).
 * On 20/11 a test that reached the real ~/.codex the same way deleted the owner's config.toml.
 *
 * How it can fail, written on 2026-11-20 before the code:
 * 1. The caller's CODEX_HOME reaches the app.
 * 2. The caller's KIMI_CODE_HOME, PI_CODING_AGENT_DIR or PI_CODING_AGENT_SESSION_DIR, an XDG
 *    home (config, data, state, cache: the CLIs' configs, sessions and logs), or ZDOTDIR reaches
 *    the app. ZDOTDIR makes the login shells of the agents' terminals, and the one Tars asks for
 *    codex's CODEX_HOME, read the owner's rc files, and whatever they export.
 * 3. A spec hands the app one of those folders outside its sandbox, and the app starts on it.
 *    CLAUDE_CONFIG_DIR is in the family too, even though the CLAUDE prefix already keeps the
 *    caller's out.
 * 4. A value reads as inside the sandbox but is not: `<sandbox>/../..`, or a relative path,
 *    which a CLI resolves against whatever folder it runs in.
 * 5. A link inside the sandbox leads outside it.
 * 6. Too much is refused:
 *    - the empty value a spec uses to say "none" (codex-launch-reads.spec.ts: CODEX_HOME '');
 *    - a folder of the sandbox that does not exist yet;
 *    - on macOS, the same folder named through /var or through /private/var;
 *    - a variable outside the family, such as PATH or LANG.
 * 7. The refusal comes after the app has started, so a CLI has already run in the wrong
 *    home, or the error does not say which variable is wrong and where it points.
 */

const accountHome = os.userInfo().homedir;
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-'));
const FAMILY = [
  'CODEX_HOME', 'KIMI_CODE_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ZDOTDIR', 'CLAUDE_CONFIG_DIR',
];
const theOwners = (name: string) => path.join(accountHome, `.${name.toLowerCase()}`);

describe('the CLI homes an E2E sandbox hands the app', () => {
  it('1, 2. leaves out every CLI home the caller has, and keeps the rest', () => {
    const env = inheritable({ PATH: '/usr/bin', LANG: 'C.UTF-8', ...Object.fromEntries(FAMILY.map(name => [name, theOwners(name)])) });

    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
  });

  it('3. names each CLI home a spec points outside the sandbox, with where it points', () => {
    const home = sandbox();
    for (const name of FAMILY) {
      expect(CLI_HOMES.test(name), `${name} is not in the family`).toBe(true);
      expect(homesOutside({ [name]: theOwners(name) }, home)).toEqual([[name, theOwners(name)]]);
    }
  });

  it('4. reads a path where it lands: `..` out of the sandbox, and a relative path, are outside', () => {
    const home = sandbox();
    // Written out, not path.join'd: join would resolve the `..` itself.
    const climbing = [home, '..', '..', '.codex'].join(path.sep);
    expect(homesOutside({ CODEX_HOME: climbing, KIMI_CODE_HOME: 'kimi-home' }, home)).toEqual([
      ['CODEX_HOME', climbing],
      ['KIMI_CODE_HOME', 'kimi-home'],
    ]);
  });

  it.skipIf(process.platform === 'win32')('5. follows a link in the sandbox to where it leads', () => {
    const home = sandbox();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-homes-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(home, '.codex'));
    expect(homesOutside({ CODEX_HOME: path.join(home, '.codex') }, home)).toEqual([['CODEX_HOME', path.join(home, '.codex')]]);
  });

  it('6. takes an empty value, a folder still to be made in the sandbox, and leaves other variables alone', () => {
    const home = sandbox();
    expect(homesOutside({
      CODEX_HOME: '', KIMI_CODE_HOME: '  ', PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
      XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '/usr/bin', LANG: 'C.UTF-8', TMPDIR: os.tmpdir(),
    }, home)).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')('6. takes the sandbox named through /var and through /private/var alike', () => {
    const real = fs.realpathSync(sandbox());
    const linked = real.startsWith('/private/') ? real.slice('/private'.length) : real;
    expect(homesOutside({ CODEX_HOME: path.join(linked, '.codex'), XDG_CONFIG_HOME: path.join(real, '.config') }, linked)).toEqual([]);
    expect(homesOutside({ CODEX_HOME: path.join(linked, '.codex'), XDG_CONFIG_HOME: path.join(real, '.config') }, real)).toEqual([]);
  });

  it('7. refuses the launch before the app starts, naming the variable and where it points', async () => {
    const home = sandbox();
    let launched = 0;
    const electron = { launch: async () => { launched++; throw new Error('the app was started'); } };

    const refusal = await launchSandboxed(electron, home, { env: { CODEX_HOME: theOwners('CODEX_HOME') } }).then(() => null, (error: Error) => error);

    expect(launched).toBe(0);
    expect(refusal?.message).toContain(`CODEX_HOME: ${theOwners('CODEX_HOME')}`);
  });
});
