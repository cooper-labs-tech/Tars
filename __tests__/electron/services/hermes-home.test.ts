import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hermesProfileDir, hermesRootConfig, hermesProfileConfig, hermesEnvText, writeHermesProfile, removeHermesSecrets,
  sweepHermesSecrets, stopHermesGateway, approvalsModeFor, HERMES_SECRET_VARS, type HermesProfileSpec,
} from '../../../electron/services/hermes-home';

/**
 * Tars's own Hermes home (the owner's decision of 26/11: `~/.tars/hermes`, never the user's `~/.hermes`), one profile
 * per agent. Measured on Hermes Agent 0.23.4 (27/11): one gateway runs every session of a home, multiplexing its
 * profiles, and a session's provider key and its MCP servers' `${VAR}` come from the profile's `.env` (its secret scope),
 * never from the terminal that typed the task. So each agent's profile holds a `.env` at 0600 with that terminal's
 * proxy token, the proxy's address and its Tars token, written when the terminal starts and removed when it ends.
 *
 * How it fails, written before the code (27/11):
 * 1. A profile folder lands outside the home: an agent id that is empty, `.`, `..`, or holds a separator.
 * 2. The `.env` holds a variable other than the three (OPENAI_BASE_URL, OPENAI_API_KEY, CLAUDE_MGR_API_TOKEN), so an
 *    endpoint's real key or a user's credential could be written there.
 * 3. The `.env` is readable by others (not 0600 on POSIX), or a temporary copy of it is left beside it.
 * 4. A value with a line break, a quote, a `$` or a space writes a second variable or is expanded by Hermes's reader.
 * 5. The config misses a guard: telemetry asked at the first start, the user's Codex and Claude logins adopted,
 *    update checks on, the root's profiles not multiplexed, or the fetches `updates.check: false` leaves on (measured
 *    27/11: hermes-agent.nousresearch.com, raw.githubusercontent.com and openrouter.ai were still asked for, and
 *    none once `model_catalog.enabled` was false and `plugins.auto_update_check_hours` 0).
 * 6. A token's value is written into a config.yaml, instead of `${CLAUDE_MGR_API_TOKEN}` resolved from the `.env`.
 * 7. The approvals do not follow the permission mode (normal manual, auto and bypass smart).
 * 8. Two agents: one's `.env` or config names the other's token, or writing one changes the other's.
 * 9. The `.env` outlives its terminal (remove) or a crash (the sweep at the next start), or the sweep removes the
 *    `.env` of a terminal that still runs, or anything that is not a profile's `.env`.
 * 10. The gateway stop signals a process that is not this home's gateway: no record, a malformed one, a record of
 *    another home (the user's `~/.hermes`), a pid now held by another program, or this Tars itself.
 * 11. A model, an MCP command or argument with quotes, colons, `#`, backslashes or non-ASCII breaks the YAML.
 * 12. (The Audit's L1 on #654.) The record is believed about its home: a record a crash left, whose pid the user's own
 *    gateway later took, or one an agent wrote into ~/.tars naming the user's gateway, stops the user's gateway, whose
 *    command line is the same. The process itself decides: on macOS and Linux its own HERMES_HOME must be this home
 *    or one of its profiles (an environment that cannot be read stops nothing); on Windows, where it cannot be read,
 *    it must have started when the record was written (within two minutes), which neither a reused pid nor a record
 *    written after the fact does.
 * 13. (The run on the real binary, 27/11.) Hermes resolves its home (`Path.resolve()`), so its gateway's HERMES_HOME and
 *    its record name the real path: a home under a symlinked folder (macOS's /tmp, a home on another disk) is taken
 *    for another, and Tars's own gateway is left running. And the reverse, once paths are resolved: the home itself
 *    made a symlink to another home (an agent can write in ~/.tars), or a profile made one, lets that home's gateway,
 *    the user's own, pass for Tars's.
 */

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  root = path.join(tmp, 'hermes');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PROXY = 'http://127.0.0.1:31417/v1';
const spec = (over: Partial<HermesProfileSpec> = {}): HermesProfileSpec => ({
  baseUrl: PROXY,
  model: 'open-coder-1',
  permissionMode: 'normal',
  mcpServers: { 'claude-mgr-orchestrator': { command: '/Applications/Tars.app/node', args: ['/r/mcp-orchestrator/dist/bundle.js'], env: ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_URL', 'CLAUDE_MGR_API_TOKEN'] } },
  mcpValues: { CLAUDE_AGENT_ID: 'agent-a', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415' },
  ...over,
});
const secretsA = { OPENAI_BASE_URL: PROXY, OPENAI_API_KEY: 'tep_aaaa1111', CLAUDE_MGR_API_TOKEN: 'tok-aaaa2222' };
const secretsB = { OPENAI_BASE_URL: PROXY, OPENAI_API_KEY: 'tep_bbbb1111', CLAUDE_MGR_API_TOKEN: 'tok-bbbb2222' };
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('the profile folder', () => {
  it('1: is a folder of the home named by the agent id, and nothing else is accepted', () => {
    expect(hermesProfileDir(root, 'agent-a')).toBe(path.join(root, 'profiles', 'agent-a'));
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x', 'a b', 'a\nb']) {
      expect(() => hermesProfileDir(root, bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('the .env', () => {
  it('2: holds the three variables and refuses any other', () => {
    const text = hermesEnvText(secretsA);
    expect(text.trim().split('\n').map(l => l.split('=')[0]).sort()).toEqual([...HERMES_SECRET_VARS].sort());
    expect(() => hermesEnvText({ ...secretsA, OPENAI_ORG: 'x' } as never)).toThrow();
    expect(() => hermesEnvText({ ...secretsA, ANTHROPIC_API_KEY: 'sk-ant-x' } as never)).toThrow();
  });

  it('4: refuses a value that could write a second line or be expanded', () => {
    for (const bad of ['a\nB=1', 'a\rB', 'a b', 'a"b', "a'b", 'a$b', 'a`b', 'a\\b', 'a#b', '']) {
      expect(() => hermesEnvText({ ...secretsA, OPENAI_API_KEY: bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it('3: is written at 0600 on POSIX with no temporary file left beside it', () => {
    writeHermesProfile(root, 'agent-a', spec(), secretsA);
    const dir = hermesProfileDir(root, 'agent-a');
    expect(read(dir, '.env')).toBe(hermesEnvText(secretsA));
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).sort()).toEqual(['.env', 'config.yaml']);
  });
});

describe('the configs', () => {
  it('5: the root multiplexes its profiles, asks nothing, adopts no login and checks no update', () => {
    const root = hermesRootConfig();
    expect(root).toMatch(/^gateway:\n {2}multiplex_profiles: true$/m);
    expect(root).toMatch(/^auth:\n {2}adopt_external_logins: false$/m);
    expect(root).toMatch(/^updates:\n {2}check: false$/m);
    expect(root).toMatch(/shared_metrics:\n {4}enabled: false\n {4}send: false\n {4}offer_version: 2/);
    expect(root).toMatch(/^model_catalog:\n {2}enabled: false$/m);
    expect(root).toMatch(/^plugins:\n {2}auto_update_check_hours: 0$/m);
  });

  it('5 and 6: a profile has the same guards, the endpoint, and its servers take the token from the .env', () => {
    const text = hermesProfileConfig(spec());
    expect(text).toMatch(/^auth:\n {2}adopt_external_logins: false$/m);
    expect(text).toMatch(/^updates:\n {2}check: false$/m);
    expect(text).toMatch(/shared_metrics:\n {4}enabled: false/);
    expect(text).toMatch(/^model_catalog:\n {2}enabled: false$/m);
    expect(text).toMatch(/^plugins:\n {2}auto_update_check_hours: 0$/m);
    expect(text).toContain(`model:\n  provider: "custom"\n  base_url: "${PROXY}"\n  default: "open-coder-1"\n`);
    expect(text).toContain('CLAUDE_MGR_API_TOKEN: "${CLAUDE_MGR_API_TOKEN}"');
    expect(text).toContain('CLAUDE_AGENT_ID: "agent-a"');
    // A token handed in the values by mistake is not written either.
    expect(hermesProfileConfig(spec({ mcpValues: { CLAUDE_MGR_API_TOKEN: 'tok-leak', CLAUDE_AGENT_ID: 'agent-a' } }))).not.toContain('tok-leak');
  });

  it('7: the approvals follow the permission mode', () => {
    expect(approvalsModeFor('normal')).toBe('manual');
    expect(approvalsModeFor(undefined)).toBe('manual');
    expect(approvalsModeFor('plan')).toBe('manual');
    expect(approvalsModeFor('auto')).toBe('smart');
    expect(approvalsModeFor('bypass')).toBe('smart');
    expect(hermesProfileConfig(spec({ permissionMode: 'auto' }))).toMatch(/^approvals:\n {2}mode: "smart"$/m);
  });

  it('11: quotes, colons, #, backslashes and non-ASCII are written as YAML double-quoted escapes', () => {
    const text = hermesProfileConfig(spec({
      model: 'org/model:v1',
      mcpServers: { 'tars: x': { command: 'C:\\Program Files\\Tars\\node.exe', args: ['a "b" # c', 'café', '😀'], env: [] } },
    }));
    expect(text).toContain('"tars: x":');
    expect(text).toContain('command: "C:\\\\Program Files\\\\Tars\\\\node.exe"');
    expect(text).toContain('args: ["a \\"b\\" # c", "caf\\u00e9", "\\U0001f600"]');
    expect(text).not.toMatch(/[^\x0a\x20-\x7e]/);
  });
});

describe('two agents', () => {
  it('8: never see each other\'s token, and writing one leaves the other as it was', () => {
    writeHermesProfile(root, 'agent-a', spec(), secretsA);
    const aBefore = { env: read(hermesProfileDir(root, 'agent-a'), '.env'), config: read(hermesProfileDir(root, 'agent-a'), 'config.yaml') };
    writeHermesProfile(root, 'agent-b', spec({ mcpValues: { CLAUDE_AGENT_ID: 'agent-b' } }), secretsB);
    const a = hermesProfileDir(root, 'agent-a');
    const b = hermesProfileDir(root, 'agent-b');
    expect({ env: read(a, '.env'), config: read(a, 'config.yaml') }).toEqual(aBefore);
    const everythingOf = (dir: string) => fs.readdirSync(dir).map(n => read(dir, n)).join('\n');
    for (const v of [secretsB.OPENAI_API_KEY, secretsB.CLAUDE_MGR_API_TOKEN]) expect(everythingOf(a)).not.toContain(v);
    for (const v of [secretsA.OPENAI_API_KEY, secretsA.CLAUDE_MGR_API_TOKEN]) expect(everythingOf(b)).not.toContain(v);
    // No token in the root either: its gateway serves both.
    const rootFiles = fs.readdirSync(root).filter(n => fs.statSync(path.join(root, n)).isFile()).map(n => read(root, n)).join('\n');
    for (const v of [secretsA, secretsB].flatMap(s => [s.OPENAI_API_KEY, s.CLAUDE_MGR_API_TOKEN])) expect(rootFiles).not.toContain(v);
  });
});

describe('when the terminal is gone', () => {
  it('9: remove takes the .env and leaves the profile', () => {
    writeHermesProfile(root, 'agent-a', spec(), secretsA);
    removeHermesSecrets(root, 'agent-a');
    expect(fs.readdirSync(hermesProfileDir(root, 'agent-a'))).toEqual(['config.yaml']);
    expect(() => removeHermesSecrets(root, 'agent-a')).not.toThrow();
  });

  it('9: the sweep removes the .env of every profile whose terminal is gone, and nothing else', () => {
    writeHermesProfile(root, 'agent-a', spec(), secretsA);
    writeHermesProfile(root, 'agent-b', spec(), secretsB);
    const outside = path.join(tmp, 'outside.env');
    fs.writeFileSync(outside, 'keep');
    fs.mkdirSync(path.join(root, 'profiles', 'linked'));
    fs.symlinkSync(outside, path.join(root, 'profiles', 'linked', '.env'));
    fs.writeFileSync(path.join(root, 'profiles', 'agent-b', 'notes.txt'), 'keep');
    const removed = sweepHermesSecrets(root, id => id === 'agent-a');
    expect(removed.sort()).toEqual(['agent-b', 'linked']);
    expect(fs.existsSync(path.join(hermesProfileDir(root, 'agent-a'), '.env'))).toBe(true);
    expect(fs.existsSync(path.join(hermesProfileDir(root, 'agent-b'), '.env'))).toBe(false);
    expect(read(root, 'profiles', 'agent-b', 'notes.txt')).toBe('keep');
    // The link is gone, what it pointed at is not.
    expect(read(outside)).toBe('keep');
    expect(sweepHermesSecrets(path.join(tmp, 'no-such-home'), () => false)).toEqual([]);
  });
});

describe('the gateway it leaves', () => {
  const GATEWAY = '/x/python3 -m hermes_cli.main --profile default gateway run --quiet --idle-exit';
  const record = (o: unknown) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'gateway.pid'), JSON.stringify(o)); };
  const deps = (command: string | null, o: { home?: string | null; platform?: NodeJS.Platform; startedAt?: number | null } = {}) => {
    const stopped: number[] = [];
    return {
      stopped,
      deps: {
        platform: o.platform ?? 'darwin',
        commandOf: async () => command,
        homeOf: async () => (o.home === undefined ? path.join(root, 'profiles', 'agent-a') : o.home),
        startedAt: async () => (o.startedAt === undefined ? null : o.startedAt),
        stop: async (pid: number) => { stopped.push(pid); },
      },
    };
  };
  const recordTime = () => fs.statSync(path.join(root, 'gateway.pid')).mtimeMs;

  it('12: on macOS and Linux, stops it only when its own HERMES_HOME is this home or one of its profiles', async () => {
    for (const [home, outcome] of [
      [path.join(root, 'profiles', 'agent-a'), 'stopped'], [root, 'stopped'],
      [path.join(os.homedir(), '.hermes'), 'not-this-home'], [path.join(root, '..', 'hermes-other'), 'not-this-home'],
      [`${root}-x`, 'not-this-home'], [null, 'not-this-home'],
    ] as const) {
      record({ pid: 4242, hermes_home: root });
      const d = deps(GATEWAY, { home, platform: 'linux' });
      expect(await stopHermesGateway(root, d.deps), String(home)).toBe(outcome);
      expect(d.stopped, String(home)).toEqual(outcome === 'stopped' ? [4242] : []);
    }
  });

  it('12: a record forged, or left by a crash, naming the user\'s own gateway stops nothing', async () => {
    // The user's gateway: the same command line, its home theirs.
    record({ pid: 4242, hermes_home: root });
    const d = deps(GATEWAY, { home: path.join(os.homedir(), '.hermes') });
    expect(await stopHermesGateway(root, d.deps)).toBe('not-this-home');
    expect(d.stopped).toEqual([]);
  });

  it('12: on Windows, stops it only when it started when its record was written', async () => {
    record({ pid: 4242, hermes_home: root });
    const written = recordTime();
    for (const [startedAt, outcome] of [
      [written - 3_000, 'stopped'], [written + 1_000, 'stopped'],
      [written - 6 * 3600_000, 'not-this-home'], [written + 600_000, 'not-this-home'], [null, 'not-this-home'],
    ] as const) {
      const d = deps(GATEWAY, { platform: 'win32', startedAt, home: null });
      expect(await stopHermesGateway(root, d.deps), String(startedAt)).toBe(outcome);
      expect(d.stopped).toEqual(outcome === 'stopped' ? [4242] : []);
    }
  });

  it('10: stops the pid its record names, when it is this home\'s gateway', async () => {
    record({ pid: 4242, hermes_home: root });
    const d = deps(GATEWAY);
    expect(await stopHermesGateway(root, d.deps)).toBe('stopped');
    expect(d.stopped).toEqual([4242]);
  });

  it('10: stops nothing without a record, with a malformed one, or for this process', async () => {
    for (const r of [undefined, 'not json', { pid: 'x', hermes_home: root }, { pid: -1, hermes_home: root }, { pid: 1, hermes_home: root }, { pid: process.pid, hermes_home: root }]) {
      fs.rmSync(path.join(root, 'gateway.pid'), { force: true });
      if (r !== undefined) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'gateway.pid'), typeof r === 'string' ? r : JSON.stringify(r)); }
      const d = deps(GATEWAY);
      expect(await stopHermesGateway(root, d.deps), JSON.stringify(r)).toBe('none');
      expect(d.stopped).toEqual([]);
    }
  });

  it('10: stops nothing for another home\'s record, the user\'s own included', async () => {
    record({ pid: 4242, hermes_home: path.join(os.homedir(), '.hermes') });
    const d = deps(GATEWAY);
    expect(await stopHermesGateway(root, d.deps)).toBe('not-this-home');
    expect(d.stopped).toEqual([]);
  });

  it('13: a home under a symlinked folder is stopped by its resolved path, as Hermes names it', async () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(path.join(real, 'hermes'), { recursive: true });
    fs.symlinkSync(real, path.join(tmp, 'link'));
    const home = path.join(tmp, 'link', 'hermes');
    const resolved = path.join(fs.realpathSync(real), 'hermes');
    for (const [recorded, own] of [[resolved, resolved], [home, resolved], [resolved, path.join(resolved, 'profiles', 'agent-a')]]) {
      fs.writeFileSync(path.join(home, 'gateway.pid'), JSON.stringify({ pid: 4242, hermes_home: recorded }));
      const d = deps(GATEWAY, { home: own, platform: 'darwin' });
      expect(await stopHermesGateway(home, d.deps), `${recorded} ${own}`).toBe('stopped');
      expect(d.stopped).toEqual([4242]);
    }
    const w = deps(GATEWAY, { platform: 'win32', startedAt: fs.statSync(path.join(home, 'gateway.pid')).mtimeMs, home: null });
    expect(await stopHermesGateway(home, w.deps), 'Windows, the record resolved').toBe('stopped');
  });

  it('13: the home or a profile made a symlink to another home stops nothing of that home', async () => {
    const owner = path.join(tmp, 'owner-hermes');
    fs.mkdirSync(owner, { recursive: true });
    const ownerReal = fs.realpathSync(owner);
    // The whole home a symlink to the user's.
    fs.symlinkSync(owner, root);
    for (const recorded of [root, ownerReal]) {
      fs.writeFileSync(path.join(owner, 'gateway.pid'), JSON.stringify({ pid: 4242, hermes_home: recorded }));
      for (const platform of ['darwin', 'linux'] as const) {
        const d = deps(GATEWAY, { home: ownerReal, platform });
        expect(await stopHermesGateway(root, d.deps), `${platform} ${recorded}`).toBe('not-this-home');
        expect(d.stopped).toEqual([]);
      }
    }
    // A profile a symlink to the user's home.
    fs.rmSync(root);
    fs.mkdirSync(path.join(root, 'profiles'), { recursive: true });
    fs.symlinkSync(owner, path.join(root, 'profiles', 'agent-x'));
    record({ pid: 4242, hermes_home: root });
    for (const own of [ownerReal, path.join(root, 'profiles', 'agent-x')]) {
      const d = deps(GATEWAY, { home: own, platform: 'darwin' });
      expect(await stopHermesGateway(root, d.deps), own).toBe('not-this-home');
      expect(d.stopped).toEqual([]);
    }
  });

  it('10: stops nothing when the pid now runs another program, or nothing', async () => {
    record({ pid: 4242, hermes_home: root });
    for (const command of ['/usr/bin/vim notes.txt', '/x/python3 -m hermes_cli.main chat', null]) {
      const d = deps(command);
      expect(await stopHermesGateway(root, d.deps)).toBe(command ? 'not-a-gateway' : 'none');
      expect(d.stopped).toEqual([]);
    }
  });
});
