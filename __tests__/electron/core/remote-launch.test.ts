import { describe, expect, it } from 'vitest';
import {
  parseRemoteHost, sshArgv, remoteCommand, remoteEnvFile, remotePort, REMOTE_ENV_KEYS,
} from '../../../electron/core/remote-launch';

/**
 * An agent whose CLI runs on a remote Linux host over ssh (2.0.7, item 14): the pure part, what Tars hands ssh and the
 * host (core/remote-launch.ts). The plan: reports/remote-agents/PLAN.md.
 *
 * How it fails, written before the code:
 * 1. A host entry is taken with no ssh target, a target ssh would read as an option ("-oProxyCommand=..."), one with
 *    a space, a quote, a semicolon or a control character, or a work root that is relative, holds "..", a quote or a
 *    control character; or an entry carries a key, a password or a path to a key (the owner's ssh config holds those).
 * 2. The ssh command line forwards the owner's ssh agent (-A, ForwardAgent yes), prompts for a passphrase or an
 *    unknown host in an agent's terminal (no BatchMode), keeps the session when its tunnel failed (no
 *    ExitOnForwardFailure), opens the API on the host's network instead of its loopback, or lets the target be read
 *    as an option (no "--" before it).
 * 3. The tunnel's port on the host is not the one the environment names, or is outside the range, or differs between
 *    two launches of the same agent (a reconnect would point the CLI at a closed port).
 * 4. The remote command can be broken out of: a folder or an id with a quote, a space or "$(...)" runs something on
 *    the host; or the command needs the remote login shell to expand a quoted "~".
 * 5. The environment handed to the host carries what is this Mac's (PATH, HOME, TMPDIR, the slot's shim, the state
 *    mod's local folder, an account folder, the ssh agent's socket), names the Mac's API address instead of the
 *    tunnel's, or loses the agent's token, its identity or a provider's key; or a value breaks out of its quotes when
 *    sourced; or a key that is not a variable name is written.
 */

const host = { id: 'build-1', name: 'Build host', sshTarget: 'buildbox', workRoot: '/home/agent/work' };

describe('parseRemoteHost', () => {
  it('1. takes a clean entry, and nothing that ssh or a shell would read as more', () => {
    expect(parseRemoteHost(host)).toEqual({ ok: true, host });
    expect(parseRemoteHost({ ...host, sshTarget: 'agent@192.0.2.10' })).toMatchObject({ ok: true });
    for (const sshTarget of ['', '-oProxyCommand=touch /tmp/x', 'a b', "a'b", 'a;b', 'a\nb', 'a$(id)', 'a`id`', 'a|b']) {
      expect(parseRemoteHost({ ...host, sshTarget }), JSON.stringify(sshTarget)).toMatchObject({ ok: false, code: 'invalid_target' });
    }
    for (const workRoot of ['work', '/home/../etc', "/home/a'b", '/home/a\nb', '', '~/work']) {
      expect(parseRemoteHost({ ...host, workRoot }), JSON.stringify(workRoot)).toMatchObject({ ok: false, code: 'invalid_work_root' });
    }
    for (const extra of [{ identityFile: '/Users/x/.ssh/id' }, { password: 'x' }, { key: 'x' }]) {
      expect(parseRemoteHost({ ...host, ...extra })).toMatchObject({ ok: false, code: 'no_credentials_here' });
    }
    expect(parseRemoteHost({ ...host, id: 'Has Space' })).toMatchObject({ ok: false, code: 'invalid_id' });
    expect(parseRemoteHost({ ...host, name: 'x'.repeat(81) })).toMatchObject({ ok: false, code: 'invalid_name' });
  });
});

describe('sshArgv', () => {
  const argv = sshArgv(host, { rport: 41234, apiPort: 31415, tty: true, command: 'echo hi' });

  it('2. never forwards the ssh agent, never prompts, ends with its tunnel, binds the loopback, ends options before the target', () => {
    expect(argv).not.toContain('-A');
    const opts = argv.filter((_, i) => argv[i - 1] === '-o');
    expect(opts).toEqual(expect.arrayContaining(['BatchMode=yes', 'ForwardAgent=no', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'ServerAliveCountMax=3']));
    expect(argv[argv.indexOf('-R') + 1]).toBe('127.0.0.1:41234:127.0.0.1:31415');
    const dd = argv.indexOf('--');
    expect(dd).toBeGreaterThan(0);
    expect(argv.slice(dd + 1)).toEqual(['buildbox', 'echo hi']);
    expect(argv).toContain('-tt');
    expect(sshArgv(host, { rport: 41234, apiPort: 31415, tty: false, command: 'true' })).not.toContain('-tt');
    expect(sshArgv(host, { apiPort: 31415, tty: false, command: 'true' })).not.toContain('-R');
  });
});

describe('remotePort', () => {
  it('3. one port per agent, in the range, the same at every launch', () => {
    const a = remotePort('agent-a');
    expect(a).toBe(remotePort('agent-a'));
    expect(a).toBeGreaterThanOrEqual(41000);
    expect(a).toBeLessThan(43000);
    expect(remotePort('agent-a', 1)).not.toBe(a);
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => remotePort(x))).size).toBeGreaterThan(3);
  });
});

describe('remoteCommand', () => {
  it('4. every word quoted, the wrapper found from $HOME, nothing for the host to run but it', () => {
    const cmd = remoteCommand('start', ['agent-1', "/home/agent/work/it's $(id)", 'claude --model x']);
    expect(cmd.startsWith('"$HOME"/.tars-remote/bin/tars-remote ')).toBe(true);
    expect(cmd).toContain("'start'");
    expect(cmd).toContain(`'/home/agent/work/it'\\''s $(id)'`);
    expect(cmd).not.toMatch(/'~/);
  });
});

describe('remoteEnvFile', () => {
  const local = {
    PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me', TMPDIR: '/Users/me/.tars/tmp/x/t', CLAUDE_CODE_TMPDIR: '/Users/me/.tars/tmp/x/c',
    TARS_SLOT: '/Users/me/.tars/bin/tars-slot', TARS_SLOT_SCRIPT: '/Applications/x', TARS_NODE: '/Applications/node',
    CLAUDE_CODE_PLUGIN_DIRS: '/Users/me/Library/mods', CLAUDE_CONFIG_DIR: '/Users/me/.claude-accounts/2', SSH_AUTH_SOCK: '/private/tmp/ssh',
    CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415', CLAUDE_MGR_API_TOKEN: 'tok', TARS_INSTANCE_ID: 'inst', CLAUDE_AGENT_ID: 'agent-1',
    CLAUDE_PROJECT_PATH: '/Users/me/p', CLAUDE_SKILLS: 'a,b', ANTHROPIC_BASE_URL: 'https://example.com/v1', ANTHROPIC_AUTH_TOKEN: "k'ey$(id)",
    'NOT-A-NAME': 'x',
  };
  const text = remoteEnvFile(local, { rport: 41234 });

  it("5. only what the CLI needs, the tunnel's address, quoted to be sourced", () => {
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'TARS_SLOT', 'TARS_SLOT_SCRIPT', 'TARS_NODE', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK', 'NOT-A-NAME']) {
      expect(text, k).not.toMatch(new RegExp(`^export ${k.replace('-', '\\-')}=`, 'm'));
    }
    expect(text).toMatch(/^export CLAUDE_MGR_API_URL='http:\/\/127\.0\.0\.1:41234'$/m);
    for (const k of ['CLAUDE_MGR_API_TOKEN', 'TARS_INSTANCE_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PROJECT_PATH', 'CLAUDE_SKILLS', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(text, k).toMatch(new RegExp(`^export ${k}=`, 'm'));
    }
    expect(text).toContain(`export ANTHROPIC_AUTH_TOKEN='k'\\''ey$(id)'`);
    expect(REMOTE_ENV_KEYS).not.toContain('PATH');
  });
});
