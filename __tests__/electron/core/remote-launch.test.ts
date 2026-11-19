import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseRemoteHost, parseAgentRemote, sshArgv, remoteCommand, remoteEnvFile, remotePort, REMOTE_ENV_KEYS,
  remoteHookSettings, remoteMcpConfig, remoteBootstrap, remoteStartCommand, remoteLaunchLine,
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
 * 6. An agent is placed on a host the owner never added, or in a folder outside that host's work root ("..", another
 *    path, a quote, a relative path); or with no folder said, it gets none instead of its project's name under the
 *    work root; or null does not take it back to this computer.
 *
 * The launch (part B), written before its code:
 * 7. The hooks handed to a CLI on a host point at this Mac's scripts, run a file name a shell reads as more ("a;b.sh",
 *    "../x.sh"), carry any other setting, or lose an event.
 * 8. Its MCP servers keep a server started as a program (a program of this Mac), keep an HTTP server of the owner's
 *    (another host or port, with what its headers hold), name this Tars's port instead of the tunnel's, write the
 *    agent's token literally instead of by name, or fail on a file that is not JSON instead of giving none.
 * 9. What prepares the host lets the shell read a file's content ("$(...)", a line that ends the file early), writes
 *    outside ~/.tars-remote ("../.ssh/authorized_keys"), leaves a file readable by others or half written, writes the
 *    environment before the other files, or takes an agent id or a folder that is not one; or leaves the host's Claude
 *    Code asking whether to trust the agent's folder (it takes the first task as the answer), or changes anything else
 *    of its ~/.claude.json. Run in a real sh: each file arrives byte for byte, at 0600 or 0700.
 * 10. The agent's terminal starts the CLI before the host is prepared, or after a preparation that failed; leaves the
 *    file that holds the token on this computer, after a success or a failure; hides ssh's own words or exit code; or
 *    lets the folder or the CLI's command line break out of their words. Run in a real sh with an ssh stand-in.
 * 11. (claude-provider.test.ts) The claude command for a host names a path of this Mac (its binary, ~/.tars, the MCP
 *    file, a secondary folder, the orchestrator's instructions), or leaves out the settings or the MCP file.
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

describe('parseAgentRemote', () => {
  const hosts = [host];
  const project = '/Users/me/projects/project-a';

  it("6. a host the owner added, a folder under its work root, the project's name by default, null to come back", () => {
    expect(parseAgentRemote({ hostId: 'build-1' }, hosts, project)).toEqual({ ok: true, remote: { hostId: 'build-1', folder: '/home/agent/work/project-a' } });
    expect(parseAgentRemote({ hostId: 'build-1', folder: '/home/agent/work/a/b' }, hosts, project)).toEqual({ ok: true, remote: { hostId: 'build-1', folder: '/home/agent/work/a/b' } });
    expect(parseAgentRemote(null, hosts, project)).toEqual({ ok: true, remote: null });
    expect(parseAgentRemote({ hostId: 'nowhere' }, hosts, project)).toMatchObject({ ok: false, code: 'unknown_host' });
    for (const folder of ['/etc', '/home/agent/work/../x', '/home/agent/workshop', 'project-a', "/home/agent/work/a'b", '/home/agent/work']) {
      expect(parseAgentRemote({ hostId: 'build-1', folder }, hosts, project), folder).toMatchObject({ ok: false, code: 'invalid_folder' });
    }
    expect(parseAgentRemote('build-1', hosts, project)).toMatchObject({ ok: false, code: 'invalid_remote' });
  });
});

describe('remoteHookSettings', () => {
  it("7. Tars's hooks from their copies on the host, every event kept, nothing a shell reads as more, no other setting", () => {
    const specs = [
      { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
      { type: 'Stop', file: 'on-stop.sh' },
      { type: 'UserPromptSubmit', file: 'user-prompt-submit.sh' },
      { type: 'Stop', file: 'a;b.sh' },
      { type: 'Notification', file: '../x.sh' },
      { type: 'Bad Event', file: 'notification.sh' },
    ];
    const settings = JSON.parse(remoteHookSettings(specs));
    expect(Object.keys(settings)).toEqual(['hooks']);
    expect(Object.keys(settings.hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks.SessionStart).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: '"$HOME"/.tars-remote/hooks/session-start.sh', timeout: 30 }] }]);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('"$HOME"/.tars-remote/hooks/on-stop.sh');
    expect(JSON.stringify(settings)).not.toMatch(/\/Users\/|\/Applications\/|app\.asar|\.\.\/|;/);
  });
});

describe('remoteMcpConfig', () => {
  const local = JSON.stringify({ mcpServers: {
    'claude-mgr-orchestrator': { type: 'http', url: 'http://127.0.0.1:31415/api/mcp/claude-mgr-orchestrator', headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } },
    'tars-memory': { type: 'http', url: 'http://127.0.0.1:31415/api/mcp/tars-memory', headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } },
    'claude-mgr-vault': { command: '/Applications/Tars.app/Contents/Resources/node', args: ['/Applications/Tars.app/Contents/Resources/mcp-vault/dist/bundle.js'] },
    'owners-memory': { type: 'http', url: 'https://memory.example.com/mcp', headers: { Authorization: 'Bearer literal-secret' } },
    'other-tars': { type: 'http', url: 'http://127.0.0.1:31499/api/mcp/other-tars', headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } },
    'renamed': { type: 'http', url: 'http://127.0.0.1:31415/api/mcp/tars-memory' },
  } });

  it("8. only Tars's own servers on this Tars's API, through the tunnel, the token by name", () => {
    const remote = JSON.parse(remoteMcpConfig(local, { apiPort: 31415, rport: 41234 }));
    expect(Object.keys(remote.mcpServers).sort()).toEqual(['claude-mgr-orchestrator', 'tars-memory']);
    expect(remote.mcpServers['tars-memory']).toEqual({ type: 'http', url: 'http://127.0.0.1:41234/api/mcp/tars-memory', headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } });
    const text = JSON.stringify(remote);
    expect(text).not.toMatch(/31415|31499|literal-secret|\/Applications\//);
    expect(JSON.parse(remoteMcpConfig('not json', { apiPort: 31415, rport: 41234 }))).toEqual({ mcpServers: {} });
    expect(JSON.parse(remoteMcpConfig(undefined, { apiPort: 31415, rport: 41234 }))).toEqual({ mcpServers: {} });
  });
});

/** A throwaway home, for what a host's sh does with what Tars sends it. */
function hostHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remote-unit-'));
}

describe('remoteBootstrap', () => {
  const agentId = 'aaaa1111-0000-4000-8000-00000000a002';
  const hostile = "line one\n$(touch pwned) `touch pwned2` ${HOME}\nTARS_FILE_END\n'quoted' \"double\"\n";

  const folder = '/home/agent/work/project-a';

  it('9. refuses an id, a folder or a path that is not one, and puts the environment last', () => {
    expect(() => remoteBootstrap({ agentId: 'a b', folder, files: [], env: '' })).toThrow(/agent id/);
    for (const bad of ['work/project-a', "/home/agent/it's", '/home/$(id)']) {
      expect(() => remoteBootstrap({ agentId, folder: bad, files: [], env: '' }), bad).toThrow(/folder/);
    }
    for (const bad of ['../.ssh/authorized_keys', '/etc/passwd', 'hooks/../../x', 'agents/x/../../y', 'other/x', 'hooks/a b']) {
      expect(() => remoteBootstrap({ agentId, folder, files: [{ path: bad, content: '' }], env: '' }), bad).toThrow(/path/);
    }
    const script = remoteBootstrap({ agentId, folder, files: [{ path: 'bin/tars-remote', content: '#!/bin/sh\n', executable: true }], env: "export CLAUDE_MGR_API_TOKEN='tok'\n" });
    expect(script).toMatch(/^set -e\numask 077\n/);
    expect(script).not.toContain('tok');
    expect(script.indexOf(`agents/${agentId}/env.tars-new`)).toBeGreaterThan(script.indexOf('bin/tars-remote.tars-new'));
  });

  it("9. run in a real sh: every file byte for byte, 0600 or 0700, nothing of a content run, the folder trusted and nothing else of ~/.claude.json", () => {
    const home = hostHome();
    try {
      const dir = path.join(home, '.tars-remote', 'agents', agentId);
      const work = path.join(home, 'work', 'project-a');
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ keep: true, projects: { '/elsewhere': { hasTrustDialogAccepted: false, other: 1 } } }));
      const script = remoteBootstrap({
        agentId,
        folder: work,
        files: [{ path: 'bin/tars-remote', content: '#!/bin/sh\necho wrapper\n', executable: true }, { path: `agents/${agentId}/settings.json`, content: hostile }],
        env: `export CLAUDE_MGR_API_TOKEN='tok'\n${hostile}`,
      });
      const r = spawnSync('/bin/sh', ['-s'], { input: script, cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(claudeJson.keep).toBe(true);
      expect(claudeJson.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: false, other: 1 });
      expect(claudeJson.projects[work]).toEqual({ hasTrustDialogAccepted: true });
      expect(claudeJson.projects[fs.realpathSync(work)]).toEqual({ hasTrustDialogAccepted: true });
      expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(hostile);
      expect(fs.readFileSync(path.join(dir, 'env'), 'utf8')).toBe(`export CLAUDE_MGR_API_TOKEN='tok'\n${hostile}`);
      expect(fs.statSync(path.join(dir, 'env')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(home, '.tars-remote', 'bin', 'tars-remote')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
      expect(fs.readdirSync(dir).sort()).toEqual(['env', 'settings.json']);
      expect(fs.existsSync(path.join(home, 'pwned')) || fs.existsSync(path.join(home, 'pwned2'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('remoteStartCommand', () => {
  const agentId = 'aaaa1111-0000-4000-8000-00000000a002';
  const folder = "/home/agent/work/it's $(touch pwned)";
  const cliCommand = `'claude' --model 'x' 'say "hi" and $(touch pwned3)'`;

  /** A wrapper that writes what it was handed, one word a line, the command line decoded. */
  function stubWrapper(home: string): string {
    const out = path.join(home, 'handed.txt');
    const bin = path.join(home, '.tars-remote', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tars-remote'), `#!/bin/sh\nprintf '%s\\n' "$1" "$2" "$3" > '${out}'\nprintf '%s' "$4" | base64 -d >> '${out}'\n`, { mode: 0o700 });
    return out;
  }

  it('10. refuses an id that is not one; run in a real sh, hands the wrapper the folder and the command line whole', () => {
    expect(() => remoteStartCommand({ agentId: '$(id)', folder, cliCommand })).toThrow(/agent id/);
    const home = hostHome();
    try {
      const out = stubWrapper(home);
      const ran = spawnSync('/bin/sh', ['-c', remoteStartCommand({ agentId, folder, cliCommand })], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
      expect(fs.readFileSync(out, 'utf8')).toBe(`start\n${agentId}\n${folder}\n${cliCommand}`);
      expect(['pwned', 'pwned3'].some((f) => fs.existsSync(path.join(home, f)))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('remoteLaunchLine', () => {
  /** An ssh stand-in: each call's arguments one a line, the first call's stdin, and the exit code FAKE_SSH_EXIT_<n>. */
  function fakeSsh(home: string): { bin: string; log: string } {
    const bin = path.join(home, 'bin');
    const log = path.join(home, 'log');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(log, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ssh'), [
      '#!/bin/sh',
      `n=$(ls '${log}' | grep -c 'args$'); n=$((n+1))`,
      `printf '%s\\n' "$@" > '${log}'/call-$n.args`,
      `[ "$n" = 1 ] && cat > '${log}'/call-1.stdin`,
      'code=$(eval "printf %s \\"\\${FAKE_SSH_EXIT_$n:-0}\\"")',
      '[ "$code" = 0 ] || echo "ssh: refused on call $n" >&2',
      'exit "$code"',
      '',
    ].join('\n'), { mode: 0o755 });
    return { bin, log };
  }
  const terminal = ['ssh', '-tt', '-o', 'BatchMode=yes', '--', 'buildbox', `"$HOME"/.tars-remote/bin/tars-remote 'start' 'x' $(touch pwned)`];
  const prepare = ['ssh', '-T', '--', 'buildbox', 'sh -s'];

  it('10. the host prepared first from the file on stdin, the file gone, then the terminal ssh in its place', () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeSsh(home);
      const prepFile = path.join(home, "prep it's.sh");
      fs.writeFileSync(prepFile, 'the files and the env\n', { mode: 0o600 });
      const line = remoteLaunchLine({ prepare, prepFile, terminal });
      const r = spawnSync('/bin/sh', ['-c', line], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_SSH_EXIT_2: '7' }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(7);
      expect(fs.readFileSync(path.join(log, 'call-1.stdin'), 'utf8')).toBe('the files and the env\n');
      expect(fs.readFileSync(path.join(log, 'call-1.args'), 'utf8')).toBe('-T\n--\nbuildbox\nsh -s\n');
      expect(fs.readFileSync(path.join(log, 'call-2.args'), 'utf8')).toBe(`${terminal.slice(1).join('\n')}\n`);
      expect(fs.existsSync(prepFile)).toBe(false);
      expect(fs.existsSync(path.join(home, 'pwned'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("10. a host that could not be prepared: the file gone all the same, no terminal ssh, ssh's own words and code", () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeSsh(home);
      const prepFile = path.join(home, 'prep.sh');
      fs.writeFileSync(prepFile, 'x\n', { mode: 0o600 });
      const line = remoteLaunchLine({ prepare, prepFile, terminal });
      const r = spawnSync('/bin/sh', ['-c', line], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_SSH_EXIT_1: '255' }, encoding: 'utf8' });
      expect(r.status).toBe(255);
      expect(r.stderr).toMatch(/refused on call 1/);
      expect(fs.existsSync(path.join(log, 'call-2.args'))).toBe(false);
      expect(fs.existsSync(prepFile)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
