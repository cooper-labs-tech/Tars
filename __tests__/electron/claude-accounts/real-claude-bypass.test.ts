/**
 * An agent started in bypass mode on an account Tars provisioned reaches its
 * prompt, with the real claude binary (the Audit's B1).
 *
 * Measured on claude 2.1.283: `claude --dangerously-skip-permissions` in a
 * configuration folder whose .claude.json lacks bypassPermissionsModeAccepted
 * stops on "WARNING: Claude Code running in Bypass Permissions mode" with
 * "No, exit" preselected. An agent switched to such a folder would sit there,
 * and one Enter would end its CLI.
 *
 * What would make this test lie, first:
 * - a real sign-in reached: HOME is a throwaway folder and `security` on the
 *   PATH is a stand-in that knows no item, so the CLI is "Not logged in", which
 *   still draws the prompt. The real keychain is never asked;
 * - the network reached: every request goes to a dead proxy;
 * - a dialog read as its absence: the negative witness, a folder provisioned
 *   from a ~/.claude.json without the flag, must show the dialog in the same run;
 * - a claude left running: each is killed by the PID this test started.
 *
 * Needs the claude binary (~/.local/bin/claude of the account running the
 * suite, or TARS_REAL_CLAUDE) and python3 for a real terminal (node-pty here
 * is built for Electron). Skipped where there is none, as on CI.
 */
import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { provisionAccountDir } from '../../../electron/services/claude-accounts/provision';

function realClaude(): string | null {
  const candidates = [process.env.TARS_REAL_CLAUDE, path.join(os.userInfo().homedir, '.local', 'bin', 'claude')];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const resolved = fs.realpathSync(c);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* not there */
    }
  }
  return null;
}

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE = realClaude();

/**
 * Runs argv in a real terminal until its screen shows one of the markers (or
 * `seconds` pass, loaded machines start claude slowly), then kills that PID,
 * and prints the screen as plain text without spaces.
 */
const PTY_RUN = `
import os, pty, sys, time, select, signal, json, re, fcntl, termios, struct
secs, cwd, env, markers = float(sys.argv[1]), sys.argv[2], json.loads(sys.argv[3]), sys.argv[4].split('|')
argv = sys.argv[5:]
def plain(b):
    s = b.decode('utf-8', 'replace')
    s = re.sub(r'\\x1b\\[[0-9;?<>=]*[A-Za-z~]|\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)|\\x1b[()][A-Z0-9]|\\x1b[=>78]', '', s)
    return re.sub(r'\\s+', '', s)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execve(argv[0], argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
out = b''; t0 = time.time()
while time.time() - t0 < secs:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        out += d
        if any(m in plain(out) for m in markers):
            time.sleep(0.5)
            break
for sig in (signal.SIGTERM, signal.SIGKILL):
    try: os.kill(pid, sig)
    except ProcessLookupError: break
    time.sleep(1)
sys.stdout.write(plain(out))
`;

describe.skipIf(!CLAUDE || !hasPython())('bypass mode on a provisioned account, real claude', () => {
  it('reaches the prompt; the same folder without the copied flag stops on the warning', () => {
    const home = fs.realpathSync(os.homedir());
    const project = fs.mkdtempSync(path.join(home, 'project-'));
    const bin = fs.mkdtempSync(path.join(home, 'bin-'));
    // A keychain that holds nothing, so no sign-in is ever read.
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho "security: The specified item could not be found in the keychain." >&2\nexit 44\n', { mode: 0o755 });
    const runner = path.join(bin, 'pty_run.py');
    fs.writeFileSync(runner, PTY_RUN);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

    const screenFor = (accepted: boolean, id: string): string => {
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
        hasCompletedOnboarding: true,
        ...(accepted ? { bypassPermissionsModeAccepted: true } : {}),
        projects: { [project]: { hasTrustDialogAccepted: true } },
      }));
      const dir = path.join(home, '.claude-accounts', id);
      provisionAccountDir(dir, home, { projectPath: project });
      const env = {
        HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, USER: os.userInfo().username, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
        DISABLE_AUTOUPDATER: '1', CLAUDE_CONFIG_DIR: dir,
        HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '', https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
      };
      return execFileSync('python3', [runner, '45', project, JSON.stringify(env), 'bypasspermissionson|No,exit', CLAUDE as string, '--dangerously-skip-permissions'], { encoding: 'utf-8', timeout: 70_000 });
    };

    const provisioned = screenFor(true, 'acct-b1b1b1');
    expect(provisioned).toContain('bypasspermissionson');
    expect(provisioned).not.toContain('No,exit');

    const witness = screenFor(false, 'acct-b1b1b2');
    expect(witness).toContain('BypassPermissionsmode');
    expect(witness).toContain('No,exit');
  }, 150_000);
});
