import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CMD_SHIM_NODE, SH_SHIM } from './win-fake-disk';

/**
 * MCP registration through the CLIs themselves, against a fake CLI installed
 * the way npm installs one: on win32 an npm `<cli>.cmd` shim (with the
 * extensionless sh shim beside it, as npm writes it), on darwin/linux an
 * executable script. The fake records the argv it receives. Nothing is
 * mocked between the provider and the process: this is the real execFile.
 * (Audit A18, B/M-01.)
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: the npm shim is never reached. execFileSync('claude') looks for
 *    claude.com / claude.exe only, gets ENOENT, and the JSON/TOML fallback
 *    runs silently: the fake records nothing.
 * 2. The argv the CLI receives differs from `<cli> mcp add ...`: a server
 *    name with spaces, `&`, `%PATH%` or a quote, or a path with spaces and
 *    parentheses, split, quoted or expanded on the way.
 * 3. Only claude is fixed: codex, gemini and grok still fail (ETHOS 4).
 * 4. The add path is fixed and the remove path beside it is not (ETHOS 8).
 * 5. The orchestrator's own `claude mcp remove/add` (Settings > orchestrator
 *    setup) and `claude mcp list` (its status) still start the bare name.
 * 6. With no CLI to be found, the failure is swallowed: it must be logged
 *    with its reason, and the fallback file still written.
 *
 * The argv each CLI gets is today's, on every platform: only how the CLI is
 * found and started changes on win32.
 *
 * Since 2.0.5 (services/mcp-roles.ts) claude registers into ~/.claude/mcp.json
 * itself, which an agent gets through --mcp-config by its role, and the CLI it
 * runs is `claude mcp remove -s user <name>`, only for Tars's own entry still in
 * Claude Code's user scope (one of the seven, running its Tars bundle), which every
 * session loads: the claude cases seed one there, under Tars's telegram name, as an
 * old build left it (the Audit's M1 on #525: no other entry is ever taken out).
 */

let root: string;
let home: string;
let binDir: string;
let logFile: string;
let savedPath: string | undefined;
let savedLog: string | undefined;
let savedProfile: Record<string, string | undefined>;
/** win32: where buildFullPath adds the CLIs' install folders, moved into the test's home so the machine's own claude is never found. */
const PROFILE_VARS = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => home };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => root },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));

const CLIS = ['claude', 'codex', 'gemini', 'grok'] as const;
type Cli = typeof CLIS[number];

/** A fake CLI the way npm lays it out, recording each argv it is started with. */
function installFakeCli(cli: Cli) {
  const script = path.join(binDir, 'node_modules', `fake-${cli}`, 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    `fs.appendFileSync(process.env.TARS_FAKE_CLI_LOG, JSON.stringify({ cli: ${JSON.stringify(cli)}, argv: process.argv.slice(2) }) + '\\n');`,
    "if (process.argv.slice(2).join(' ') === 'mcp list') process.stdout.write('claude-mgr-orchestrator: node bundle.js - Connected\\n');",
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, `${cli}.cmd`), CMD_SHIM_NODE(`node_modules\\fake-${cli}\\cli.js`));
    fs.writeFileSync(path.join(binDir, cli), SH_SHIM);
  } else {
    fs.writeFileSync(path.join(binDir, cli), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
}

function recorded(): Array<{ cli: Cli; argv: string[] }> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function provider(cli: Cli) {
  const mod = await import('../../../electron/providers');
  return mod.getProvider(cli);
}

const NAME = "tars srv & %PATH% 'q'";
let SERVER: string;

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-cli-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  binDir = path.join(root, 'npm (x86) dir');
  fs.mkdirSync(binDir, { recursive: true });
  logFile = path.join(root, 'argv.jsonl');
  SERVER = path.join(root, 'Program Files (x86)', 'mcp srv', 'bundle.js');
  savedPath = process.env.PATH;
  savedLog = process.env.TARS_FAKE_CLI_LOG;
  process.env.PATH = [binDir, path.dirname(process.execPath)].join(path.delimiter);
  process.env.TARS_FAKE_CLI_LOG = logFile;
  savedProfile = Object.fromEntries(PROFILE_VARS.map((name) => [name, process.env[name]]));
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedLog === undefined) delete process.env.TARS_FAKE_CLI_LOG;
  else process.env.TARS_FAKE_CLI_LOG = savedLog;
  for (const name of PROFILE_VARS) {
    if (savedProfile[name] === undefined) delete process.env[name];
    else process.env[name] = savedProfile[name];
  }
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const ADD_ARGV: Record<Cli, string[]> = {
  claude: ['mcp', 'remove', '-s', 'user', 'claude-mgr-telegram'],
  codex: ['mcp', 'add', NAME, '--', 'node', '<server>'],
  gemini: ['mcp', 'add', '-s', 'user', NAME, 'node', '<server>'],
  grok: ['mcp', 'add', NAME, 'node', '--', '<server>'],
};
const REMOVE_ARGV: Record<Cli, string[]> = {
  claude: ['mcp', 'remove', '-s', 'user', NAME],
  codex: ['mcp', 'remove', NAME],
  gemini: ['mcp', 'remove', '-s', 'user', NAME],
  grok: ['mcp', 'remove', NAME],
};
const FALLBACK_FILE: Record<Cli, string[]> = {
  claude: ['.claude', 'mcp.json'],
  codex: ['.codex', 'config.toml'],
  gemini: ['.gemini', 'settings.json'],
  grok: ['.grok', 'config.toml'],
};

/** The name registered: claude moves only one of Tars's seven out of its user scope, so its cases use one. */
const nameFor = (cli: Cli) => (cli === 'claude' ? 'claude-mgr-telegram' : NAME);

/** claude: Tars's own entry still in Claude Code's user scope, as an old build left it, which registering takes out (2.0.5). */
const seedUserScope = (cli: Cli) => {
  const old = path.join(root, 'Old Tars (x86)', 'resources', 'mcp-telegram', 'dist', 'bundle.js');
  if (cli === 'claude') fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { [nameFor(cli)]: { command: 'node', args: [old] } } }));
};

describe.each(CLIS)('%s mcp add / remove through the installed CLI', (cli) => {
  it('add reaches the CLI with the argv intact, and writes no fallback', async () => {
    installFakeCli(cli);
    seedUserScope(cli);
    await (await provider(cli)).registerMcpServer(nameFor(cli), 'node', [SERVER]);

    expect(recorded()).toEqual([{ cli, argv: ADD_ARGV[cli].map((a) => (a === '<server>' ? SERVER : a)) }]);
    // claude's file is no fallback since 2.0.5: it is where the server goes.
    if (cli === 'claude') expect(fs.readFileSync(path.join(home, ...FALLBACK_FILE[cli]), 'utf-8')).toContain('claude-mgr-telegram');
    else expect(fs.existsSync(path.join(home, ...FALLBACK_FILE[cli]))).toBe(false);
  });

  it('remove reaches the CLI with the argv intact', async () => {
    installFakeCli(cli);
    await (await provider(cli)).removeMcpServer(NAME);

    expect(recorded()).toEqual([{ cli, argv: REMOVE_ARGV[cli] }]);
  });

  it('with no CLI anywhere, says why in the log and still writes the fallback', async () => {
    // The fake bin alone: node's own folder can hold the machine's real CLIs.
    process.env.PATH = binDir;
    seedUserScope(cli);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (await provider(cli)).registerMcpServer(nameFor(cli), 'node', [SERVER]);

    const said = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(said).toContain(cli);
    expect(said).toMatch(process.platform === 'win32' ? /not-found/ : /ENOENT/);
    expect(fs.readFileSync(path.join(home, ...FALLBACK_FILE[cli]), 'utf-8')).toContain(cli === 'claude' ? 'claude-mgr-telegram' : 'tars srv');
  });
});

describe("the orchestrator's own claude calls (Settings > orchestrator)", () => {
  async function registerOrchestrator() {
    const bundle = path.join(root, 'resources (x86)', 'mcp-orchestrator', 'dist', 'bundle.js');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, '');
    Object.defineProperty(process, 'resourcesPath', { value: path.join(root, 'resources (x86)'), configurable: true, writable: true });
    const mod = await import('../../../electron/services/mcp-orchestrator');
    mod.registerMcpOrchestratorHandlers();
    return bundle;
  }

  it('setup removes then adds through the installed claude, argv intact', async () => {
    installFakeCli('claude');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const bundle = await registerOrchestrator();

    const result = await handlers.get('orchestrator:setup')!({});

    expect(result).toEqual({ success: true, method: 'claude-mcp-add-global' });
    expect(recorded().map((r) => r.argv)).toEqual([
      ['mcp', 'remove', '-s', 'user', 'claude-mgr-orchestrator'],
      ['mcp', 'remove', 'claude-mgr-orchestrator'],
      ['mcp', 'add', '-s', 'user', 'claude-mgr-orchestrator', 'node', bundle],
    ]);
  });

  it('status asks `claude mcp list` when mcp.json does not name it', async () => {
    installFakeCli('claude');
    await registerOrchestrator();

    const status = await handlers.get('orchestrator:getStatus')!({}) as { configured: boolean; mcpListConfigured: boolean };

    expect(recorded().map((r) => r.argv)).toEqual([['mcp', 'list']]);
    expect(status.mcpListConfigured).toBe(true);
    expect(status.configured).toBe(true);
  });

  it('status with no claude anywhere says why in the log', async () => {
    process.env.PATH = binDir;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registerOrchestrator();

    const status = await handlers.get('orchestrator:getStatus')!({}) as { configured: boolean };

    expect(status.configured).toBe(false);
    const said = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(said).toMatch(process.platform === 'win32' ? /claude.*not-found/ : /claude.*ENOENT/);
  });
});
