import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SANDBOX_CLIS, inheritable, sandboxPath } from '../e2e/fixture.mjs';

/**
 * The CLIs an E2E sandbox sees, and what it inherits from whoever runs the suite.
 *
 * The app finds each CLI on its PATH (cliPaths:detect, shell:version), and the
 * PATH launchSandboxed handed it was the caller's. On 2026-10-18 a codex was
 * installed in ~/.local/bin, and two surfaces went red on main at once
 * (settings-ai-providers, overlay-new-agent): the sandbox showed this Mac's
 * CLIs, and its claude, qwen and amp had been there all along.
 *
 * How it can fail, written on 2026-10-19 before the code:
 * 1. A folder of the account's home stays on the PATH the app is handed
 *    (~/.local/bin, nvm's, npm's, pnpm's), and the machine's CLIs with it.
 * 2. The sandbox's own CLIs are not first on it, or one of the four is missing:
 *    claude, codex, qwen and amp, the set the settings-ai-providers reference
 *    shows ready.
 * 3. A stand-in does not answer the app's probes as the real CLI does in an
 *    empty home: `--version` one line and exit 0, `claude auth status` JSON
 *    with loggedIn false and exit 1 (claude 2.1.303, measured).
 * 4. A stand-in started as an agent's CLI exits instead of drawing its screen
 *    and holding its terminal, as fake-cli.cjs does.
 * 5. The node running the suite is not on that PATH, with its npm and npx;
 *    or it is there as a link into the account's home, which a removal of the
 *    sandbox reads as a write there (home-isolation.ts refused it).
 * 6. The app inherits what Tars puts in its agents' terminals, where QA and the
 *    agents run the suite (TARS_CLAUDE_ACCOUNT, TARS_INSTANCE_ID,
 *    TARS_CHATS_READ), beside the CLAUDE, DOROTHY and ANTHROPIC families it was
 *    already kept from.
 */

const accountHome = os.userInfo().homedir;
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-clis-'));
const under = (entry: string, root: string) => entry === root || entry.startsWith(root + path.sep);
const INHERITED = [
  path.join(accountHome, '.local', 'bin'),
  path.join(accountHome, '.nvm', 'versions', 'node', 'v22.23.2', 'bin'),
  path.join(accountHome, 'Library', 'pnpm'),
  '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin',
].join(path.delimiter);

describe.skipIf(process.platform === 'win32')('the PATH an E2E sandbox hands the app', () => {
  it('1. keeps no folder of the account\'s home, and every other folder it inherited', () => {
    const box = sandbox();
    const entries = sandboxPath(box, INHERITED, accountHome).split(path.delimiter);

    // The sandbox's own folder is no inherited one: it lies in the temporary folder, which a terminal Tars runs
    // keeps inside the account's home (~/.tars/tmp/<agent>/t).
    expect(entries.filter(entry => under(entry, accountHome) && !under(entry, box))).toEqual([]);
    expect(entries).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin']));
  });

  it('2. begins with the sandbox\'s own folder, which holds the four CLIs', () => {
    const home = sandbox();
    const [first] = sandboxPath(home, INHERITED, accountHome).split(path.delimiter);

    expect(under(first, home), `${first} is not the sandbox's`).toBe(true);
    expect(Object.keys(SANDBOX_CLIS).sort()).toEqual(['amp', 'claude', 'codex', 'qwen']);
    for (const name of Object.keys(SANDBOX_CLIS)) expect(fs.statSync(path.join(first, name)).mode & 0o111, name).not.toBe(0);
  });

  it('3. has each stand-in answer --version as its CLI does, and claude say it is signed out', () => {
    const home = sandbox();
    const PATH = sandboxPath(home, INHERITED, accountHome);
    const [dir] = PATH.split(path.delimiter);

    for (const [name, version] of Object.entries(SANDBOX_CLIS)) {
      const run = spawnSync(path.join(dir, name), ['--version'], { encoding: 'utf8', env: { PATH }, timeout: 10_000 });
      expect([name, run.status, run.stdout]).toEqual([name, 0, `${version}\n`]);
    }
    const auth = spawnSync(path.join(dir, 'claude'), ['auth', 'status'], { encoding: 'utf8', env: { PATH }, timeout: 10_000 });
    expect(auth.status).toBe(1);
    expect(JSON.parse(auth.stdout)).toMatchObject({ loggedIn: false });
    // Five spawns, each allowed 10 s: vitest's own 5 s ran out first under the full suite's load (2.0.4's trains).
  }, 60_000);

  it('4. has a stand-in started as an agent\'s CLI draw its screen and hold its terminal until it ends', async () => {
    const home = sandbox();
    const PATH = sandboxPath(home, INHERITED, accountHome);
    const [dir] = PATH.split(path.delimiter);
    const child = spawn(path.join(dir, 'codex'), ['--dangerously-bypass-approvals-and-sandbox', 'a task'], { env: { PATH } });
    const screen = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', chunk => resolve(String(chunk)));
      child.once('error', reject);
    });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(screen).toContain('a CLI of the E2E sandbox');
    expect(child.exitCode, 'it exited instead of holding its terminal').toBeNull();
    child.stdin.end();
    const code = await new Promise(resolve => child.once('exit', resolve));
    expect(code).toBe(0);
  });

  it('5. puts the node running the suite on it, with its npm and npx, and no link into the account\'s home', () => {
    const PATH = sandboxPath(sandbox(), INHERITED, accountHome);
    const [dir] = PATH.split(path.delimiter);

    expect(fs.readdirSync(dir).filter(name => fs.lstatSync(path.join(dir, name)).isSymbolicLink())).toEqual([]);
    const node = spawnSync('/bin/sh', ['-c', 'command -v node && node -p process.version'], { encoding: 'utf8', env: { PATH } });
    expect(node.stdout.trim().split('\n')).toEqual([path.join(dir, 'node'), process.version]);
    for (const name of ['npm', 'npx']) {
      if (!fs.existsSync(path.join(path.dirname(process.execPath), name))) continue;
      const run = spawnSync('/bin/sh', ['-c', `command -v ${name} && ${name} --version`], { encoding: 'utf8', env: { PATH }, timeout: 30_000 });
      expect([name, run.status, run.stdout.split('\n')[0]]).toEqual([name, 0, path.join(dir, name)]);
    }
    // node, then npm and npx allowed 30 s each: the test's time is theirs, not vitest's 5 s.
  }, 90_000);
});

describe('what an E2E sandbox inherits', () => {
  it('6. leaves out what Tars puts in its agents\' terminals, with the families it already left out', () => {
    const env = inheritable({
      PATH: '/usr/bin', LANG: 'C.UTF-8',
      TARS_CLAUDE_ACCOUNT: 'default', TARS_INSTANCE_ID: 'an-agent-s-tars', TARS_CHATS_READ: '1',
      CLAUDE_AGENT_ID: 'qa', DOROTHY_API_PORT: '31415', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1',
    });

    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
  });
});
