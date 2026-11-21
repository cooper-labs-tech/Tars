import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_ONLY_MCP, mcpConfigPathFor, geminiRoleArgs, codexRoleArgs, isTarsBundleEntry } from '../../../electron/services/mcp-roles';
import { ClaudeProvider } from '../../../electron/providers/claude-provider';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import { QwenCodeProvider } from '../../../electron/providers/qwen-code-provider';

/**
 * The MCP servers each agent gets, by its role (2.0.5, the owner's lot 3 of 28/10, item G of
 * ressources-agents-proposition-2810.md): "un exécutant ne reçoit plus Telegram ni X". A worker keeps the
 * orchestrator, memory, kanban, vault and socialdata servers; an orchestrator (or a chat's runner, which has its
 * powers) keeps all seven. Measured on 28/10: each server is a process of its own per session, the orchestrator's
 * 19 MB and every other 9 MB (median RSS over 14 sessions), so a worker gives back two processes and about 24 MB.
 *
 * How it fails, written before the code:
 * 1. Claude Code and the providers that run its binary: a worker's --mcp-config holds telegram or x, or an
 *    orchestrator's lacks one of the seven; or the worker's file drops a server the user added to that file (only
 *    the two are taken out), or goes stale once that file changed; or, with no file at all, one is passed anyway.
 * 2. Claude Code loads its user scope (~/.claude.json) whatever --mcp-config says: a Tars server registered there
 *    reaches every session, the worker's included, so registering one there makes 1 moot. Registration writes
 *    Tars's file only, and takes a Tars server out of the user scope; it never touches the user's own servers
 *    there, and a server still in the user scope does not read as registered.
 * 3. codex: a worker's command does not switch the two off (`-c mcp_servers.<name>.enabled=false`, measured on
 *    0.163), or an orchestrator's does.
 * 4. Qwen Code: a worker's command does not switch the two off (`--disable-mcp-server`, 0.25.2), or an
 *    orchestrator's does.
 * 5. gemini: a worker's command does not limit it to its other servers (`--allowed-mcp-server-names`, every server
 *    of its settings but the two), or limits an orchestrator; or, settings it cannot read, it is limited to none.
 *
 * Added by the Audit's FIX FIRST at 01ad7084, written before their code:
 * 6. (M1) A server of the owner's own in the user scope that shares a name Tars registers (`google-workspace`,
 *    `tasmania`, or one of the seven running something of the owner's) is taken out: only one of the seven whose
 *    command runs that server's Tars bundle (`<...>/mcp-<dir>/dist/bundle.js`, as an install of Tars or Dorothy
 *    left there) is. Anything else in that file stays, and the owner's entry does not keep Tars re-registering.
 * 7. (M1, parity) A Tars bundle under a Windows path (`...\resources\mcp-telegram\dist\bundle.js`) is not
 *    recognised, or a bundle of another server's directory is taken for this one's.
 * 8. (L2) An install from before 2.0.5, whose `~/.claude/mcp.json` already holds the server at the right path while
 *    the user scope still holds the old Tars entry (this Mac on 28/10), reads as registered, so the old entry
 *    never leaves the user scope.
 * 9. (L1) gemini settings holding only telegram and x give a worker an empty allow-list, which takes every
 *    server away.
 *
 * Found by the harness conformance run of codex 0.170.0 (20/11, PR #601), written before the code:
 * 10. codex: a worker's line switches off a server its config.toml does not define. 0.170 then refuses to start
 *     ("Error: invalid transport in `mcp_servers.claude-mgr-telegram`", exit 1, measured): the override makes an
 *     entry with nothing to run. Tars stopped writing telegram in 2.0.5, so on a machine whose config.toml never
 *     held it every codex worker died at launch and its task was typed into the bare shell. Only the two that
 *     config.toml defines are switched off (under the CODEX_HOME Tars hands codex); none when it defines neither,
 *     when it is missing, or when it is not TOML (codex refuses that file anyway, and Tars says nothing more).
 * 11. A test of this file writes a CLI's config folder under the real home. On 20/11 a run without the repository's
 *     setup files (a bench with a vitest config of its own) wrote and then deleted the owner's real
 *     ~/.codex/config.toml through tests 3 and 10. Each test that writes codex's folder now sets HOME and CODEX_HOME
 *     to a folder of its own for its whole body, restores them after, and fails before any write when codex's folder
 *     is the real home's (os.userInfo, which HOME does not move) or anywhere outside its own folder.
 * 12. (The Audit's L1 on #608) A config.toml smol-toml cannot parse switches nothing off, while codex, whose parser
 *     takes more, may still read it and start an orchestrator-only server (X) in a worker: against the owner's rule of
 *     28/10, failing open. When the file does not parse, the two are looked for as text: a table header
 *     `[mcp_servers.<name>]` (quoted or not, spaces allowed) or a dotted key `mcp_servers.<name>.` at a line's start,
 *     and what is found is switched off. Never a name in a comment, in a string, or a longer name that starts with it.
 * 13. (The Audit's L3 on #608) That text reading misses a server the user defined another way TOML allows, and the
 *     worker gets X (failing open): (10b) under an `[mcp_servers]` header, as a dotted key `<name>.command = ...` or
 *     an inline table `<name> = { ... }`, or under a header of its own subtable `[mcp_servers.<name>.env]`; (10c) in
 *     a top-level inline table, `mcp_servers = { <name> = { ... } }` (on one line or, as TOML 1.1 allows, on several),
 *     or `mcp_servers.<name> = { ... }`; (10d) under a single-quoted key, `'<name>'`. Or it switches off a server codex
 *     does not define, and the worker does not start ("invalid transport", failing closed): (10e) the name on a line
 *     of a multi-line string (`"""` or `'''`), a key of another table that is not a server (`[mcp_servers.other]`
 *     then `<name> = ...`, or `mcp_servers.<name>...` under another table's header), or a value inside an inline
 *     table rather than a key.
 */

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-mcp-roles-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const SEVEN = ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-telegram', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x'];
const flag = { getMcpConfigStrategy: () => 'flag' as const };
const configFile = { getMcpConfigStrategy: () => 'config-file' as const };
function writeMcpJson(servers: string[]) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const mcpServers = Object.fromEntries(servers.map(name => [name, { command: 'node', args: [`/srv/${name}/bundle.js`] }]));
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers }));
}
const serversIn = (file: string) => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).sort();

/** The real home's codex folder, from the password database: HOME does not move it. */
const REAL_CODEX_HOME = path.join(os.userInfo().homedir, '.codex');

/** Throws when `configDir` is the real home's codex folder or under it, or anywhere outside `dir`. Writes nothing. */
function assertTestCodexHome(configDir: string, dir: string): void {
  const real = path.resolve(REAL_CODEX_HOME);
  const at = path.resolve(configDir);
  if (at === real || at.startsWith(real + path.sep)) throw new Error(`codex home ${at} is the real home's: refused`);
  if (path.relative(dir, at).startsWith('..') || path.isAbsolute(path.relative(dir, at))) throw new Error(`codex home ${at} is outside ${dir}: refused`);
}

/**
 * Runs `body` with a CodexProvider on a codex folder of this test's own, HOME and CODEX_HOME both set to `dir` for the
 * whole body and restored after, not left to the suite's home isolation (11). The provider takes its folder when it is
 * built; the guard runs before the body can write anything.
 */
function withCodexHome<T>(dir: string, body: (codex: CodexProvider) => T): T {
  const was = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = dir;
  process.env.CODEX_HOME = path.join(dir, '.codex');
  try {
    const codex = new CodexProvider();
    assertTestCodexHome(codex.configDir, dir);
    return body(codex);
  } finally {
    for (const [name, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

describe('the claude family: a file per role', () => {
  it('1. an orchestrator gets all seven, a worker all but telegram and x, and a server the user added', () => {
    expect([...ORCHESTRATOR_ONLY_MCP].sort()).toEqual(['claude-mgr-telegram', 'dorothy-x']);
    writeMcpJson([...SEVEN, 'my-own-server']);
    const lead = mcpConfigPathFor(flag, true, home)!;
    const worker = mcpConfigPathFor(flag, false, home)!;
    expect(serversIn(lead)).toEqual([...SEVEN, 'my-own-server'].sort());
    expect(serversIn(worker)).toEqual([...SEVEN.filter(n => n !== 'claude-mgr-telegram' && n !== 'dorothy-x'), 'my-own-server'].sort());
    expect(worker).not.toBe(lead);
  });

  it('1. the worker\'s file follows the orchestrator\'s, and nothing is passed without one or to a config-file CLI', () => {
    writeMcpJson(SEVEN);
    const worker = mcpConfigPathFor(flag, false, home)!;
    writeMcpJson([...SEVEN, 'added-later']);
    expect(serversIn(mcpConfigPathFor(flag, false, home)!)).toContain('added-later');
    expect(mcpConfigPathFor(flag, false, home)).toBe(worker);
    expect(mcpConfigPathFor(configFile, false, home)).toBeUndefined();
    fs.rmSync(path.join(home, '.claude', 'mcp.json'));
    expect(mcpConfigPathFor(flag, false, home)).toBeUndefined();
    expect(mcpConfigPathFor(flag, true, home)).toBeUndefined();
  });
});

const posix = describe.skipIf(process.platform === 'win32');
/** Where an old build left Tars's telegram server in the user scope (this Mac, 28/10, home shortened). */
const OLD_TELEGRAM = '/Users/me/Dorothy-fix/release/mac-arm64/Dorothy.app/Contents/Resources/mcp-telegram/dist/bundle.js';
const NEW_TELEGRAM = '/Applications/Tars.app/Contents/Resources/mcp-telegram/dist/bundle.js';

posix('the claude family: no Tars server in the user scope', () => {
  let savedPath: string | undefined;
  let savedHome: string | undefined;
  beforeEach(() => {
    // A stand-in claude that does what `claude mcp remove -s user <name>` does to ~/.claude.json.
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), p = require('path').join(process.env.HOME, '.claude.json'); const a = process.argv.slice(2);
fs.appendFileSync(require('path').join(__dirname, 'calls'), a.join(' ') + '\\n');
if (a[0] === 'mcp' && a[1] === 'remove' && a[2] === '-s' && a[3] === 'user') { const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!c.mcpServers || !c.mcpServers[a[4]]) { process.stderr.write('No user-scoped MCP server found'); process.exit(1); }
  delete c.mcpServers[a[4]]; fs.writeFileSync(p, JSON.stringify(c)); process.exit(0); }
process.stderr.write('not in this stand-in: ' + a.join(' ')); process.exit(2);
`, { mode: 0o755 });
    savedPath = process.env.PATH;
    savedHome = process.env.HOME;
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.HOME = home;
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: {
        'claude-mgr-telegram': { command: 'node', args: [OLD_TELEGRAM] },
        pencil: { command: 'pencil-mcp', args: [] },
      },
      projects: { '/p': { hasTrustDialogAccepted: true } },
    }));
  });
  afterEach(() => { process.env.PATH = savedPath; process.env.HOME = savedHome; });

  it('2. registers into Tars\'s file, takes the server out of the user scope, and leaves the user\'s own there', async () => {
    const provider = new ClaudeProvider();
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', NEW_TELEGRAM)).toBe(false);
    await provider.registerMcpServer('claude-mgr-telegram', 'node', [NEW_TELEGRAM]);
    const userScope = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(userScope.mcpServers)).toEqual(['pencil']);
    expect(userScope.projects['/p'].hasTrustDialogAccepted).toBe(true);
    expect(serversIn(path.join(home, '.claude', 'mcp.json'))).toEqual(['claude-mgr-telegram']);
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', NEW_TELEGRAM)).toBe(true);
  });

  it('6. leaves in the user scope a server of the owner\'s that shares a name Tars registers, and every other key', async () => {
    const owners = {
      'google-workspace': { command: 'npx', args: ['-y', '@someone/google-workspace-mcp'] },
      tasmania: { command: 'node', args: ['/Users/me/tasmania/server.js'] },
      'claude-mgr-kanban': { command: 'node', args: ['/Users/me/my-kanban/server.js'] },
      // A Tars bundle, but another server's: not this name's.
      'claude-mgr-vault': { command: 'node', args: ['/Applications/Tars.app/Contents/Resources/mcp-x/dist/bundle.js'] },
    };
    const before = { mcpServers: { ...owners, pencil: { command: 'pencil-mcp', args: [] } }, projects: { '/p': { hasTrustDialogAccepted: true } }, theme: 'dark' };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(before));
    const provider = new ClaudeProvider();
    const calls = path.join(home, 'bin', 'calls');
    for (const [name, entry] of Object.entries(owners)) {
      await provider.registerMcpServer(name, 'node', [`/Applications/Tars.app/Contents/Resources/${name}/dist/bundle.js`]);
      expect(entry).toBeDefined();
    }
    // The file is as the owner left it, to the byte: no remove ran.
    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual(before);
    expect(fs.existsSync(calls)).toBe(false);
    // And Tars's own copy, at its path, reads as registered: the owner's entry does not keep it registering again.
    const tasmaniaPath = '/Applications/Tars.app/Contents/Resources/tasmania/dist/bundle.js';
    expect(provider.isMcpServerRegistered('tasmania', tasmaniaPath)).toBe(true);
    expect(provider.isMcpServerRegistered('google-workspace', '/Applications/Tars.app/Contents/Resources/google-workspace/dist/bundle.js')).toBe(true);
  });

  it('8. an install from before 2.0.5: the server already in Tars\'s file at its path, and still in the user scope', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { 'claude-mgr-telegram': { command: 'node', args: [NEW_TELEGRAM] } } }));
    const provider = new ClaudeProvider();
    // Not registered while the user scope still holds Tars's old entry: that is what moves it.
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', NEW_TELEGRAM)).toBe(false);
    await provider.registerMcpServer('claude-mgr-telegram', 'node', [NEW_TELEGRAM]);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers)).toEqual(['pencil']);
    expect(provider.isMcpServerRegistered('claude-mgr-telegram', NEW_TELEGRAM)).toBe(true);
  });
});

describe('the CLIs that read their own config: a switch per run', () => {
  it('3. codex: a worker runs with the two switched off, an orchestrator with all', () => withCodexHome(home, (codex) => {
    fs.mkdirSync(codex.configDir, { recursive: true });
    fs.writeFileSync(path.join(codex.configDir, 'config.toml'), SEVEN.map(n => `[mcp_servers.${n}]\ncommand = "node"\n`).join('\n'));
    const worker = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, appSettings: {} as never });
    const lead = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: true, appSettings: {} as never });
    for (const name of ORCHESTRATOR_ONLY_MCP) {
      expect(worker).toContain(`-c 'mcp_servers.${name}.enabled=false'`);
      expect(lead).not.toContain(`mcp_servers.${name}.enabled`);
    }
  }));

  it('10. codex: only a server its config.toml defines is switched off; none when it defines neither, is missing or is not TOML', () => {
    const toml = path.join(home, 'config.toml');
    const off = (args: string[]) => args.filter((_, i) => i % 2 === 1);
    fs.writeFileSync(toml, '[mcp_servers.dorothy-x]\ncommand = "node"\nargs = ["/r/mcp-x/dist/bundle.js"]\n\n[mcp_servers.mine]\ncommand = "mine"\n');
    expect(off(codexRoleArgs(false, toml))).toEqual(['mcp_servers.dorothy-x.enabled=false']);
    expect(codexRoleArgs(true, toml)).toEqual([]);
    // Defined inline, as a dotted key: a table all the same to codex.
    fs.writeFileSync(toml, 'mcp_servers = { claude-mgr-telegram = { command = "node" } }\n');
    expect(off(codexRoleArgs(false, toml))).toEqual(['mcp_servers.claude-mgr-telegram.enabled=false']);
    fs.writeFileSync(toml, 'model = "gpt"\n[mcp_servers.mine]\ncommand = "mine"\n');
    expect(codexRoleArgs(false, toml)).toEqual([]);
    expect(codexRoleArgs(false, path.join(home, 'missing.toml'))).toEqual([]);
    fs.writeFileSync(toml, '[mcp_servers.dorothy-x\ncommand = ');
    expect(codexRoleArgs(false, toml)).toEqual([]);
  });

  it("12. codex: a config.toml smol-toml cannot parse still switches off what its text defines, and nothing else", () => {
    const toml = path.join(home, 'config.toml');
    const off = (args: string[]) => args.filter((_, i) => i % 2 === 1).sort();
    const broken = 'this line is not toml = =\n';
    const cases: Array<[string, string[]]> = [
      [`[mcp_servers.dorothy-x]\ncommand = "node"\n\n${broken}`, ['mcp_servers.dorothy-x.enabled=false']],
      [`[mcp_servers."claude-mgr-telegram"]\ncommand = "x"\n${broken}`, ['mcp_servers.claude-mgr-telegram.enabled=false']],
      [`[ mcp_servers . dorothy-x ]\ncommand = "node"\n${broken}`, ['mcp_servers.dorothy-x.enabled=false']],
      [`mcp_servers.dorothy-x.command = "node"\n${broken}`, ['mcp_servers.dorothy-x.enabled=false']],
      [`[mcp_servers.dorothy-x]\n[mcp_servers.claude-mgr-telegram]\n${broken}`, ['mcp_servers.claude-mgr-telegram.enabled=false', 'mcp_servers.dorothy-x.enabled=false']],
      [`# [mcp_servers.dorothy-x]\nnote = "[mcp_servers.dorothy-x]"\n[mcp_servers.dorothy-xyz]\n${broken}`, []],
      ['[mcp_servers.dorothy-x\ncommand = ', []],
    ];
    for (const [text, expected] of cases) {
      fs.writeFileSync(toml, text);
      expect(off(codexRoleArgs(false, toml)), text).toEqual(expected);
      expect(codexRoleArgs(true, toml), text).toEqual([]);
    }
  });

  it("13. codex: a config.toml smol-toml cannot parse: every form TOML allows for a server is read, and only those (the Audit's L3, 10b to 10e)", () => {
    const toml = path.join(home, 'config.toml');
    const off = (args: string[]) => args.filter((_, i) => i % 2 === 1).sort();
    const broken = 'this line is not toml = =\n';
    const X = ['mcp_servers.dorothy-x.enabled=false'];
    const BOTH = ['mcp_servers.claude-mgr-telegram.enabled=false', 'mcp_servers.dorothy-x.enabled=false'];
    const cases: Array<[string, string, string[]]> = [
      // 10b: under an [mcp_servers] header.
      ['10b dotted key', `[mcp_servers]\ndorothy-x.command = "node"\n${broken}`, X],
      ['10b inline table', `[mcp_servers] # the servers\n  claude-mgr-telegram = { command = "node", args = ["a"] }\n  "dorothy-x" = { command = "node" }\n${broken}`, BOTH],
      ['10b a subtable header', `[mcp_servers.dorothy-x.env]\nKEY = "v"\n${broken}`, X],
      // 10c: a top-level inline table.
      ['10c one line', `model = "m"\nmcp_servers = { dorothy-x = { command = "node" }, claude-mgr-telegram.command = "x" }\n${broken}`, BOTH],
      ['10c several lines', `mcp_servers = {\n  other = { args = ["{", "}"] },\n  'dorothy-x' = { command = "node" },\n}\n${broken}`, X],
      ['10c dotted at the top', `mcp_servers.dorothy-x = { command = "node" }\n${broken}`, X],
      // 10d: a single-quoted key.
      ['10d header', `[mcp_servers.'dorothy-x']\ncommand = "node"\n${broken}`, X],
      ['10d dotted', `mcp_servers.'claude-mgr-telegram'.command = "x"\n${broken}`, ['mcp_servers.claude-mgr-telegram.enabled=false']],
      // 10e: what is not a server codex defines.
      ['10e multi-line basic string', `note = """\n[mcp_servers.dorothy-x]\nmcp_servers.dorothy-x.command = "x"\n"""\n${broken}`, []],
      ['10e multi-line literal string', `note = '''\n[mcp_servers.dorothy-x]\n'''\n${broken}`, []],
      ['10e a key of another server', `[mcp_servers.other]\ndorothy-x = "y"\n${broken}`, []],
      ['10e under another table', `[profiles.p]\nmcp_servers.dorothy-x.command = "x"\n${broken}`, []],
      ['10e a value, not a key', `mcp_servers = { other = { args = ["a", "dorothy-x"], env = { A = "1", claude-mgr-telegram = "1" } } }\n${broken}`, []],
      ['10e a longer name', `[mcp_servers]\ndorothy-xyz = { command = "node" }\n${broken}`, []],
      ['10e a comment', `[mcp_servers]\n# dorothy-x = { command = "node" }\nmcp = 1 # [mcp_servers.dorothy-x]\n${broken}`, []],
    ];
    for (const [label, text, expected] of cases) {
      fs.writeFileSync(toml, text);
      expect.soft(off(codexRoleArgs(false, toml)), label).toEqual(expected);
      expect.soft(codexRoleArgs(true, toml), label).toEqual([]);
    }
  });

  it('10. codex: the line Tars builds reads the config.toml of the home it hands codex', () => withCodexHome(home, (codex) => {
    fs.mkdirSync(codex.configDir, { recursive: true });
    fs.writeFileSync(path.join(codex.configDir, 'config.toml'), '[mcp_servers.dorothy-x]\ncommand = "node"\n');
    const worker = codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, appSettings: {} as never });
    expect(worker).toContain(`-c 'mcp_servers.dorothy-x.enabled=false'`);
    expect(worker).not.toContain('claude-mgr-telegram');
    fs.rmSync(path.join(codex.configDir, 'config.toml'));
    expect(codex.buildInteractiveCommand({ binaryPath: '/bin/codex', prompt: 'go', orchestratorMode: false, appSettings: {} as never })).not.toContain('.enabled=false');
  }));

  it("11. a codex test's folder: the real home's codex folder is refused, and so is any folder outside the test's own", () => {
    expect(() => assertTestCodexHome(REAL_CODEX_HOME, home)).toThrow(/real home/);
    expect(() => assertTestCodexHome(path.join(REAL_CODEX_HOME, 'sub'), home)).toThrow(/real home/);
    expect(() => assertTestCodexHome(path.join(os.tmpdir(), 'elsewhere', '.codex'), home)).toThrow(/outside/);
    expect(() => assertTestCodexHome(path.join(home, '.codex'), home)).not.toThrow();
    // HOME and CODEX_HOME are the test's own during its body, and are given back after it.
    const was = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    withCodexHome(home, (codex) => {
      expect(process.env.HOME).toBe(home);
      expect(codex.configDir).toBe(path.join(home, '.codex'));
    });
    expect({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }).toEqual(was);
  });

  it('4. Qwen Code: a worker runs with the two disabled, an orchestrator with all', () => {
    const qwen = new QwenCodeProvider();
    const worker = qwen.buildInteractiveCommand({ binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: false });
    const lead = qwen.buildInteractiveCommand({ binaryPath: '/bin/qwen', prompt: 'go', orchestratorMode: true });
    for (const name of ORCHESTRATOR_ONLY_MCP) {
      expect(worker).toContain(`--disable-mcp-server '${name}'`);
      expect(lead).not.toContain(`--disable-mcp-server '${name}'`);
    }
  });

  it('5. gemini: a worker is limited to every server of its settings but the two; nothing when they cannot be read', () => {
    const settings = path.join(home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: Object.fromEntries([...SEVEN, 'mine'].map(n => [n, {}])) }));
    const args = geminiRoleArgs(false, settings);
    expect(args[0]).toBe('--allowed-mcp-server-names');
    expect(args.slice(1).sort()).toEqual([...SEVEN.filter(n => !(ORCHESTRATOR_ONLY_MCP as readonly string[]).includes(n)), 'mine'].sort());
    expect(geminiRoleArgs(true, settings)).toEqual([]);
    expect(geminiRoleArgs(false, path.join(home, 'missing.json'))).toEqual([]);
    fs.writeFileSync(settings, '{ not json');
    expect(geminiRoleArgs(false, settings)).toEqual([]);
  });

  it('9. gemini: settings holding only telegram and x give a worker no allow-list, never an empty one', () => {
    const settings = path.join(home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { 'claude-mgr-telegram': {}, 'dorothy-x': {} } }));
    expect(geminiRoleArgs(false, settings)).toEqual([]);
  });
});

describe('what is a Tars server in the user scope', () => {
  it('7. one of the seven running its own Tars bundle, under any install and on Windows; nothing else', () => {
    const bundle = (root: string, dir: string, sep = '/') => ({ command: 'node', args: [[root, `mcp-${dir}`, 'dist', 'bundle.js'].join(sep)] });
    expect(isTarsBundleEntry('claude-mgr-orchestrator', bundle('/Users/me/Dorothy-fix/release/mac-arm64/Dorothy.app/Contents/Resources', 'orchestrator'))).toBe(true);
    expect(isTarsBundleEntry('tars-memory', bundle('/Applications/Tars.app/Contents/Resources', 'memory'))).toBe(true);
    expect(isTarsBundleEntry('claude-mgr-telegram', bundle('C:\\Users\\me\\AppData\\Local\\Programs\\Tars\\resources', 'telegram', '\\'))).toBe(true);
    expect(isTarsBundleEntry('dorothy-x', bundle('/opt/Tars/resources', 'x'))).toBe(true);
    expect(isTarsBundleEntry('dorothy-socialdata', bundle('/Users/me/tars', 'socialdata'))).toBe(true);
    // Another server's bundle, a name that is not one of the seven, a command of the owner's.
    expect(isTarsBundleEntry('claude-mgr-vault', bundle('/Applications/Tars.app/Contents/Resources', 'x'))).toBe(false);
    expect(isTarsBundleEntry('dorothy-world', bundle('/Applications/Tars.app/Contents/Resources', 'world'))).toBe(false);
    expect(isTarsBundleEntry('google-workspace', bundle('/Applications/Tars.app/Contents/Resources', 'google-workspace'))).toBe(false);
    expect(isTarsBundleEntry('claude-mgr-kanban', { command: 'node', args: ['/Users/me/my-kanban/server.js'] })).toBe(false);
    expect(isTarsBundleEntry('claude-mgr-kanban', { command: 'node', args: ['/x/mcp-kanban/dist/bundle.js.bak'] })).toBe(false);
    expect(isTarsBundleEntry('claude-mgr-kanban', { type: 'http', url: 'https://example.com/mcp' })).toBe(false);
    expect(isTarsBundleEntry('claude-mgr-kanban', undefined)).toBe(false);
  });
});
