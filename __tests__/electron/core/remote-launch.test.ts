import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  parseRemoteHost, parseAgentRemote, sshArgv, remoteCommand, remoteEnvFile, remotePort, REMOTE_ENV_KEYS,
  remoteHookSettings, remoteMcpConfig, remoteBootstrap, remoteStartCommand, remoteLaunchLine, PORT_MARK,
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
 *
 * The Audit's gate of #600 (FIX FIRST at dfccd9fc3), written before the fixes:
 * 12. (L2, I-a, I-d) The owner's ssh config decides for Tars's ssh: a ControlMaster/ControlPersist keeps the tunnel to
 *    this Mac's API open past the agent's terminal; StrictHostKeyChecking accept-new or no trusts any key on a first
 *    connection; a RemoteCommand makes every launch fail. Tars's lines must say ControlMaster=no, ControlPath=none,
 *    StrictHostKeyChecking=yes and RemoteCommand=none.
 * 13. (L3) A folder or a work root a host's shell would read as more than a path: a space, ; | & < > ( ) { } [ ] * ? !
 *    # ~ or a newline. A tmux older than 3.0 runs new-session's arguments through sh -c, so the wrapper takes none
 *    (and refuses such a tmux, its environment file removed).
 * 14. (L4) The tunnel's port is fixed per agent: one taken on the host (another service, another user, an agent whose
 *    port collides) blocks every launch there. The host must choose a free one among the agent's candidates, say it,
 *    and the terminal must open the tunnel there; none free fails with why, the token's file removed all the same.
 * 15. The environment file names a tunnel's address of its own: the port is the host's choice, so the wrapper sets
 *    CLAUDE_MGR_API_URL from it, and the MCP file names it the same way, never this Mac's port.
 * 16. (the gate's must-fix) The hooks on a host prove the port before sending their token by a route the tunnel no
 *    longer serves without one: the wrapper tells them the port is the tunnel's (TARS_API_TUNNEL=1).
 */

const host = { id: 'build-1', name: 'Build host', sshTarget: 'buildbox', workRoot: '/home/agent/work' };

describe('parseRemoteHost', () => {
  it('1. takes a clean entry, and nothing that ssh or a shell would read as more', () => {
    expect(parseRemoteHost(host)).toEqual({ ok: true, host });
    expect(parseRemoteHost({ ...host, sshTarget: 'agent@192.0.2.10' })).toMatchObject({ ok: true });
    for (const sshTarget of ['', '-oProxyCommand=touch /tmp/x', 'a b', "a'b", 'a;b', 'a\nb', 'a$(id)', 'a`id`', 'a|b']) {
      expect(parseRemoteHost({ ...host, sshTarget }), JSON.stringify(sshTarget)).toMatchObject({ ok: false, code: 'invalid_target' });
    }
    for (const workRoot of ['work', '/home/../etc', "/home/a'b", '/home/a\nb', '', '~/work', '/home/a b', '/home/a;id', '/home/a|b', '/home/a&b', '/home/a>b', '/home/a(b)', '/home/a{b}', '/home/a[b]', '/home/a*', '/home/a?', '/home/a!', '/home/a#b', '/home/~a']) {
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

  it("12. none of the owner's multiplexing, a known host key required, and no RemoteCommand of the config, on every line", () => {
    for (const line of [argv, sshArgv(host, { apiPort: 31415, tty: false, command: 'sh -s' })]) {
      const opts = line.filter((_, i) => line[i - 1] === '-o');
      expect(opts).toEqual(expect.arrayContaining(['ControlMaster=no', 'ControlPath=none', 'StrictHostKeyChecking=yes', 'RemoteCommand=none']));
      expect(line.indexOf('ControlMaster=no')).toBeLessThan(line.indexOf('--'));
    }
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
  const text = remoteEnvFile(local);

  it('5, 15. only what the CLI needs, quoted to be sourced, and no API address: the wrapper sets the tunnel\'s', () => {
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'TARS_SLOT', 'TARS_SLOT_SCRIPT', 'TARS_NODE', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK', 'NOT-A-NAME', 'CLAUDE_MGR_API_URL']) {
      expect(text, k).not.toMatch(new RegExp(`^export ${k.replace('-', '\\-')}=`, 'm'));
    }
    expect(text).not.toContain('31415');
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
    // 13. Nothing a host's shell reads as more than a path, as a tmux before 3.0 would hand it to sh -c.
    for (const sign of [' ', ';', '|', '&', '<', '>', '(', ')', '{', '}', '[', ']', '*', '?', '!', '#', '~', '\n']) {
      const folder = `/home/agent/work/a${sign}id`;
      expect(parseAgentRemote({ hostId: 'build-1', folder }, hosts, project), JSON.stringify(folder)).toMatchObject({ ok: false, code: 'invalid_folder' });
    }
    expect(parseAgentRemote({ hostId: 'build-1', folder: '/home/agent/work/my-app_2.0+x@y' }, hosts, project)).toMatchObject({ ok: true });
    // A project's name that is no such path gives the plain default.
    expect(parseAgentRemote({ hostId: 'build-1' }, hosts, '/Users/me/projects/my app;x')).toEqual({ ok: true, remote: { hostId: 'build-1', folder: '/home/agent/work/project' } });
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

  it("8, 15. only Tars's own servers on this Tars's API, through the tunnel's port as the host chose it, the token by name", () => {
    const remote = JSON.parse(remoteMcpConfig(local, { apiPort: 31415 }));
    expect(Object.keys(remote.mcpServers).sort()).toEqual(['claude-mgr-orchestrator', 'tars-memory']);
    expect(remote.mcpServers['tars-memory']).toEqual({ type: 'http', url: `http://127.0.0.1:${PORT_MARK}/api/mcp/tars-memory`, headers: { Authorization: 'Bearer ${CLAUDE_MGR_API_TOKEN}' } });
    const text = JSON.stringify(remote);
    expect(text).not.toMatch(/31415|31499|literal-secret|\/Applications\//);
    expect(JSON.parse(remoteMcpConfig('not json', { apiPort: 31415 }))).toEqual({ mcpServers: {} });
    expect(JSON.parse(remoteMcpConfig(undefined, { apiPort: 31415 }))).toEqual({ mcpServers: {} });
  });
});

/** A throwaway home, for what a host's sh does with what Tars sends it. */
function hostHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-remote-unit-'));
}

/** A port nothing listens on: taken, then given back. */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A port something listens on, as another service of the host, until `close`. */
async function takenPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const s = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => s.close(() => r())) };
}

describe('remoteBootstrap: the tunnel\'s port', () => {
  const agentId = 'aaaa1111-0000-4000-8000-00000000a003';

  it('14. the first of the candidates nothing listens on, said on its own line; none free fails with why, no environment left', async () => {
    const home = hostHome();
    const busy = await takenPort();
    const busy2 = await takenPort();
    try {
      const work = path.join(home, 'work');
      fs.mkdirSync(work, { recursive: true });
      const free = await freePort();
      const env = { HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' };
      const run = (ports: number[]) => spawnSync('/bin/sh', ['-s'], {
        input: remoteBootstrap({ agentId, folder: work, files: [], env: "export CLAUDE_MGR_API_TOKEN='tok'\n", ports }), cwd: home, env, encoding: 'utf8',
      });
      const chose = run([busy.port, free]);
      expect(chose.status, chose.stderr).toBe(0);
      expect(chose.stdout.trim()).toBe(`TARS_PORT=${free}`);
      const envFile = path.join(home, '.tars-remote', 'agents', agentId, 'env');
      fs.rmSync(envFile, { force: true });
      const none = run([busy.port, busy2.port]);
      expect(none.status).not.toBe(0);
      expect(none.stdout).not.toMatch(/TARS_PORT=/);
      expect(none.stderr).toMatch(new RegExp(`no free port.*${busy.port}`));
      expect(fs.existsSync(envFile)).toBe(false);
    } finally {
      await busy.close();
      await busy2.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('remoteBootstrap', () => {
  const agentId = 'aaaa1111-0000-4000-8000-00000000a002';
  const hostile = "line one\n$(touch pwned) `touch pwned2` ${HOME}\nTARS_FILE_END\n'quoted' \"double\"\n";

  const folder = '/home/agent/work/project-a';

  const ports = [41001];

  it('9. refuses an id, a folder, a path or a port that is not one, and puts the environment last', () => {
    expect(() => remoteBootstrap({ agentId: 'a b', folder, files: [], env: '', ports })).toThrow(/agent id/);
    for (const bad of ['work/project-a', "/home/agent/it's", '/home/$(id)', '/home/a;b', '/home/a b']) {
      expect(() => remoteBootstrap({ agentId, folder: bad, files: [], env: '', ports }), bad).toThrow(/folder/);
    }
    for (const bad of ['../.ssh/authorized_keys', '/etc/passwd', 'hooks/../../x', 'agents/x/../../y', 'other/x', 'hooks/a b']) {
      expect(() => remoteBootstrap({ agentId, folder, files: [{ path: bad, content: '' }], env: '', ports }), bad).toThrow(/path/);
    }
    for (const bad of [[], [80], [70000], [41001.5]]) {
      expect(() => remoteBootstrap({ agentId, folder, files: [], env: '', ports: bad }), JSON.stringify(bad)).toThrow(/port/);
    }
    const script = remoteBootstrap({ agentId, folder, files: [{ path: 'bin/tars-remote', content: '#!/bin/sh\n', executable: true }], env: "export CLAUDE_MGR_API_TOKEN='tok'\n", ports });
    expect(script).toMatch(/^set -e\numask 077\n/);
    expect(script).not.toContain('tok');
    expect(script.indexOf(`agents/${agentId}/env.tars-new`)).toBeGreaterThan(script.indexOf('bin/tars-remote.tars-new'));
  });

  it("9. run in a real sh: every file byte for byte, 0600 or 0700, nothing of a content run, the folder trusted and nothing else of ~/.claude.json", async () => {
    const home = hostHome();
    try {
      const dir = path.join(home, '.tars-remote', 'agents', agentId);
      const work = path.join(home, 'work', 'project-a');
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ keep: true, projects: { '/elsewhere': { hasTrustDialogAccepted: false, other: 1 } } }));
      const free = await freePort();
      const script = remoteBootstrap({
        agentId,
        folder: work,
        files: [{ path: 'bin/tars-remote', content: '#!/bin/sh\necho wrapper\n', executable: true }, { path: `agents/${agentId}/settings.json`, content: hostile }],
        env: `export CLAUDE_MGR_API_TOKEN='tok'\n${hostile}`,
        ports: [free],
      });
      const r = spawnSync('/bin/sh', ['-s'], { input: script, cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(`TARS_PORT=${free}`);
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
    fs.writeFileSync(path.join(bin, 'tars-remote'), `#!/bin/sh\nprintf '%s\\n' "$1" "$2" "$3" > '${out}'\nprintf '%s' "$4" | base64 -d >> '${out}'\nprintf '\\n%s' "$5" >> '${out}'\n`, { mode: 0o700 });
    return out;
  }

  it('10, 14. refuses an id that is not one; run in a real sh, hands the wrapper the folder, the command line whole, and the port the host chose', () => {
    expect(() => remoteStartCommand({ agentId: '$(id)', folder, cliCommand })).toThrow(/agent id/);
    const home = hostHome();
    try {
      const out = stubWrapper(home);
      const ran = spawnSync('/bin/sh', ['-c', remoteStartCommand({ agentId, folder, cliCommand })], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      expect(ran.status, ran.stderr).toBe(0);
      expect(fs.readFileSync(out, 'utf8')).toBe(`start\n${agentId}\n${folder}\n${cliCommand}\n${PORT_MARK}`);
      expect(['pwned', 'pwned3'].some((f) => fs.existsSync(path.join(home, f)))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('remoteLaunchLine', () => {
  /**
   * An ssh stand-in: each call's arguments one a line, the first call's stdin, what call n prints (FAKE_SSH_OUT_<n>)
   * and its exit code (FAKE_SSH_EXIT_<n>).
   */
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
      'said=$(eval "printf %s \\"\\${FAKE_SSH_OUT_$n:-}\\"")',
      '[ -n "$said" ] && printf \'%s\\n\' "$said"',
      'code=$(eval "printf %s \\"\\${FAKE_SSH_EXIT_$n:-0}\\"")',
      '[ "$code" = 0 ] || echo "ssh: refused on call $n" >&2',
      'exit "$code"',
      '',
    ].join('\n'), { mode: 0o755 });
    return { bin, log };
  }
  const terminal = ['ssh', '-tt', '-o', 'BatchMode=yes', '-R', `127.0.0.1:${PORT_MARK}:127.0.0.1:31415`, '--', 'buildbox', `"$HOME"/.tars-remote/bin/tars-remote 'start' 'x' $(touch pwned) '${PORT_MARK}'`];
  const prepare = ['ssh', '-T', '--', 'buildbox', 'sh -s'];

  it('10, 14. the host prepared first from the file on stdin, the file gone, then the terminal ssh in its place, on the port the host chose', () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeSsh(home);
      const prepFile = path.join(home, "prep it's.sh");
      fs.writeFileSync(prepFile, 'the files and the env\n', { mode: 0o600 });
      const line = remoteLaunchLine({ prepare, prepFile, terminal });
      // A login that prints a line of its own before the port: the port is the line that says it.
      const said = 'Welcome to the host\nTARS_PORT=41777';
      const r = spawnSync('/bin/sh', ['-c', line], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_SSH_OUT_1: said, FAKE_SSH_EXIT_2: '7' }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(7);
      expect(fs.readFileSync(path.join(log, 'call-1.stdin'), 'utf8')).toBe('the files and the env\n');
      expect(fs.readFileSync(path.join(log, 'call-1.args'), 'utf8')).toBe('-T\n--\nbuildbox\nsh -s\n');
      expect(fs.readFileSync(path.join(log, 'call-2.args'), 'utf8')).toBe(`${terminal.slice(1).map((w) => w.split(PORT_MARK).join('41777')).join('\n')}\n`);
      expect(fs.existsSync(prepFile)).toBe(false);
      expect(fs.existsSync(path.join(home, 'pwned'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('14. a host that named no port: no terminal ssh, the file gone, and why', () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeSsh(home);
      const prepFile = path.join(home, 'prep.sh');
      fs.writeFileSync(prepFile, 'x\n', { mode: 0o600 });
      const line = remoteLaunchLine({ prepare, prepFile, terminal });
      const r = spawnSync('/bin/sh', ['-c', line], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_SSH_OUT_1: 'TARS_PORT=41a' }, encoding: 'utf8' });
      expect(r.status).toBe(6);
      expect(r.stderr).toMatch(/no port for the tunnel/);
      expect(fs.existsSync(path.join(log, 'call-2.args'))).toBe(false);
      expect(fs.existsSync(prepFile)).toBe(false);
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

describe('tars-remote.sh, the wrapper on the host', () => {
  const WRAPPER = path.join(__dirname, '../../../electron/resources/tars-remote.sh');
  const agentId = 'aaaa1111-0000-4000-8000-00000000a004';

  /** A tmux stand-in: `-V` answers `version`, anything else is logged, one argument a line, then `--`. */
  function fakeTmux(home: string, version: string): { bin: string; log: string } {
    const bin = path.join(home, 'bin');
    const log = path.join(home, 'tmux.args');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tmux'), [
      '#!/bin/sh',
      `[ "$1" = -V ] && { echo 'tmux ${version}'; exit 0; }`,
      `printf '%s\\n' "$@" >> '${log}'`,
      `echo -- >> '${log}'`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    return { bin, log };
  }

  /** An agent's folder on the host, its environment file and its MCP file as the bootstrap leaves them. */
  function prepared(home: string): { dir: string; work: string } {
    const dir = path.join(home, '.tars-remote', 'agents', agentId);
    const work = path.join(home, 'work', 'project-a');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(dir, 'env'), "export CLAUDE_MGR_API_TOKEN='tok-x'\nexport CLAUDE_MGR_API_URL='http://127.0.0.1:31415'\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'mcp.tmpl'), JSON.stringify({ mcpServers: { o: { type: 'http', url: `http://127.0.0.1:${PORT_MARK}/api/mcp/o` } } }), { mode: 0o600 });
    return { dir, work };
  }
  const b64 = (line: string) => Buffer.from(line, 'utf8').toString('base64');

  it('13. refuses a tmux older than 3.0, which hands its arguments to sh -c, and leaves no environment', () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeTmux(home, '2.8');
      const { dir, work } = prepared(home);
      const r = spawnSync('bash', [WRAPPER, 'start', agentId, work, b64('true'), '41777'], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/tmux 3\.0 or newer/);
      expect(r.stderr).toMatch(/2\.8/);
      expect(fs.existsSync(path.join(dir, 'env'))).toBe(false);
      expect(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').not.toMatch(/new-session/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('13, 14. with tmux 3.0 or newer: the old session ended, the new one started with each argument its own, the port handed on', () => {
    const home = hostHome();
    try {
      const { bin, log } = fakeTmux(home, '3.5a');
      const { work } = prepared(home);
      const r = spawnSync('bash', [WRAPPER, 'start', agentId, work, b64('true'), '41777'], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const calls = fs.readFileSync(log, 'utf8').split('--\n').filter(Boolean);
      expect(calls[0]).toBe(`kill-session\n-t\ntars-${agentId}\n`);
      expect(calls[1]).toBe([
        'new-session', '-s', `tars-${agentId}`, '-c', work, `${home}/.tars-remote/bin/tars-remote`, 'session', agentId, work, b64('true'), '41777', ';', 'set-option', 'status', 'off', '',
      ].join('\n'));
      for (const port of ['', '80', '4177a', '700000']) {
        const bad = spawnSync('bash', [WRAPPER, 'start', agentId, work, b64('true'), port], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
        expect(bad.status, JSON.stringify(port)).not.toBe(0);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("15, 16. its session: the environment Tars sent, the tunnel's address from the port, the hooks told it is the tunnel, the MCP file rendered, nothing left", () => {
    const home = hostHome();
    try {
      const { dir, work } = prepared(home);
      const r = spawnSync('bash', [WRAPPER, 'session', agentId, work, b64('env'), '41777'], { cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const env = r.stdout.split('\n');
      expect(env).toContain('CLAUDE_MGR_API_URL=http://127.0.0.1:41777');
      expect(env).toContain('TARS_API_TUNNEL=1');
      expect(env).toContain('CLAUDE_MGR_API_TOKEN=tok-x');
      expect(env).toContain(`TARS_REMOTE_AGENT_DIR=${dir}`);
      expect(fs.existsSync(path.join(dir, 'env'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers.o.url).toBe('http://127.0.0.1:41777/api/mcp/o');
      expect(fs.statSync(path.join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
