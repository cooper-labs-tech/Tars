import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasPosixModes, skipOnWindows } from '../setup/platform-limits';
import { cannotSymlink } from '../setup/symlink-privilege';

/**
 * Tars's own MCP servers run on the Node inside the app, not on whatever
 * `node` an agent's shell finds first.
 *
 * Every registration named the program `node`, so the CLI that starts a server
 * looked it up on its PATH. An agent's terminal is `/bin/bash -l`, and on macOS
 * /etc/profile runs path_helper, which puts /etc/paths (/usr/local/bin first)
 * before the PATH Tars hands it. Measured on 2026-09-24: the live Tars's
 * mcp-orchestrator processes ran /usr/local/bin/node, Node 18.16, end of life,
 * though the settings name a Node 22 and nvm has 22 and 24; and
 * `env -i PATH=<nvm 22>:/usr/bin:/bin bash -l -c 'command -v node'` answers
 * /usr/local/bin/node. A machine with no Node at all, which claude's native
 * installer does not need, got no Tars tools in any agent.
 *
 * The program is now a launcher Tars writes at ~/.dorothy/bin/tars-mcp-node at
 * every start: it runs the app's own binary with ELECTRON_RUN_AS_NODE=1.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. The command registered is looked up on a PATH (`node`), so the shell's
 *    first node runs the servers, whatever its version.
 * 2. The launcher depends on PATH itself, or does not pass the arguments on.
 * 3. An app path with a space, a quote or `$(...)` breaks the launcher or is
 *    run by the shell.
 * 4. The launcher is writable by other accounts.
 * 5. The launcher still names the old binary after the app moved; or it is
 *    rewritten at every call although nothing changed.
 * 6. On Windows, where a shell script cannot be the command, nothing runs.
 * 7. A launcher that cannot be written makes the setup throw, and no server is
 *    registered at all.
 * 8. The servers registered by an older Tars with `node` are left as they are,
 *    since the registration check only compares the server's path.
 * 9. Over-correction: once moved over, every server is registered again at
 *    every start (for Claude that is a `claude mcp add` per server).
 * 10. The servers handed to a delegated ACP run still name `node`.
 * 11. A move-over that failed for one registration, or found no server to
 *     move (a start without the bundles), is recorded as done anyway, and the
 *     servers left on `node` are never moved again. Found in the app on this
 *     branch: a dev start, whose resources hold no bundle, wrote the record.
 *
 * The Audit's gate of #201 (2026-09-24), written before the fix:
 * 12. The launcher follows the last Tars started, packaged or not: a dev run
 *     on the real HOME rewrote it to a worktree's Electron, and once that
 *     Electron was gone every Tars server of every claude session, JeanBrasse's own
 *     included, failed to connect. The same from a copy run from a DMG or
 *     translocated by macOS, which is gone once it quits. Only a packaged Tars
 *     at a lasting place writes it; another leaves it as it is.
 * 13. A launcher whose app is gone runs nothing: it must fall back to `node`.
 * 14. An AppImage writes its /tmp mount point, gone once it quits: the
 *     AppImage file ($APPIMAGE) is the lasting path.
 * 15. A symlinked ~/.dorothy/bin is followed, and the launcher written, or
 *     chmodded, wherever it points.
 * 16. The move-over repeats at every start for every provider while one of
 *     them fails (measured: 35 removals and 42 registrations per launch, the
 *     claude CLI run on the main thread each time); the others must be
 *     recorded as moved, and only the failing one tried again.
 * 17. A start that did not write the launcher moves registrations over to
 *     whatever it would name: an unpackaged run must move nothing.
 *
 * On Windows the launcher is a sh script, which Windows
 * cannot run, so the cases that run it skip there, and the program the
 * servers are registered on is `node` (6), the move-over included.
 * The Orchestrator's brief after #231 (2026-09-28), written before the fix:
 * 18. A packaged Tars started from its disk image (/Volumes/<image>/Tars.app)
 *     or translocated by macOS registers the seven servers with paths inside
 *     that copy, for every CLI (amp, codex, gemini, opencode, pi, claude's
 *     ~/.claude/mcp.json): the registration check compares the server's path,
 *     and this path is new. At unmount they are gone, and every Tars server
 *     of every session fails to connect until the installed Tars starts again.
 * 19. Such a start removes the installed Tars's registrations, or records a
 *     move-over the next start then trusts.
 * 20. Over-correction: a packaged Tars at a lasting place stops registering
 *     (test 8 still holds), or a path merely named like a volume is taken for
 *     one.
 * 21. The Settings button (`orchestrator:setup`) registers the orchestrator
 *     from such a copy all the same.
 */

const home = () => os.homedir();

const appState = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0', on: vi.fn(),
    get isPackaged() { return appState.isPackaged; },
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));

/** A provider that keeps its registrations in memory, the way the real ones keep them on disk. */
const registry = new Map<string, { command: string; args: string[] }>();
const calls: string[] = [];
const fakeProvider = {
  id: 'fake',
  isMcpServerRegistered: (name: string, serverPath: string) => registry.get(name)?.args.at(-1) === serverPath,
  registerMcpServer: async (name: string, command: string, args: string[]) => { calls.push(`add ${name}`); registry.set(name, { command, args }); },
  removeMcpServer: async (name: string) => { calls.push(`remove ${name}`); registry.delete(name); },
  getSkillDirectories: () => [] as string[],
  getPtyEnvVars: () => ({}),
};
/** A second provider, whose registrations can be made to fail, like a config file chmodded 000. */
const otherRegistry = new Map<string, { command: string; args: string[] }>();
const otherState = { failing: false };
const otherProvider = {
  id: 'other',
  isMcpServerRegistered: (name: string, serverPath: string) => otherRegistry.get(name)?.args.at(-1) === serverPath,
  registerMcpServer: async (name: string, command: string, args: string[]) => {
    calls.push(`other add ${name}`);
    if (otherState.failing) throw new Error('EACCES: permission denied, open config.toml');
    otherRegistry.set(name, { command, args });
  },
  removeMcpServer: async (name: string) => {
    calls.push(`other remove ${name}`);
    if (otherState.failing) throw new Error('EACCES: permission denied, open config.toml');
    otherRegistry.delete(name);
  },
  getSkillDirectories: () => [] as string[],
  getPtyEnvVars: () => ({}),
};
const providerList = { value: 'one' as 'one' | 'two' };
vi.mock('../../electron/providers', () => ({
  getAllProviders: () => (providerList.value === 'two' ? [fakeProvider, otherProvider] : [fakeProvider]),
  getProvider: () => fakeProvider,
}));

let acpLaunch: { command: string; args: string[] };
vi.mock('../../electron/services/acp/registry', () => ({ acpLaunchFor: () => acpLaunch, loadAcpRegistry: async () => undefined }));
vi.mock('../../electron/services/usage-ledger', () => ({ recordUsage: vi.fn() }));

import * as mcpNode from '../../electron/utils/mcp-node';
import { mcpNodeCommand } from '../../electron/utils/mcp-node';
import { delegateOverAcp } from '../../electron/services/acp/delegate';
import { setupMcpOrchestrator, setupOrchestratorSetupHandler } from '../../electron/services/mcp-orchestrator';
import { ipcMain } from 'electron';

const launcher = () => path.join(home(), '.dorothy', 'bin', 'tars-mcp-node');
/** What the servers are registered on from this host: the launcher, or `node` on Windows (6). */
const program = () => (process.platform === 'win32' ? 'node' : launcher());
/** Windows runs no sh script: the launcher itself cannot be run there. */
const LAUNCHER_NOT_RUNNABLE = 'the launcher is a #!/bin/sh script, which Windows cannot run; the servers run on `node` there (case 6)';

/** A program that prints what it was run with, standing in for the app binary. */
function fakeApp(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app');
  fs.writeFileSync(file, `#!${process.execPath}\nconsole.log(JSON.stringify({ runAsNode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }));\n`, { mode: 0o755 });
  return file;
}
const run = (command: string, args: string[]) =>
  JSON.parse(execFileSync(command, args, { env: { PATH: '/nonexistent' } }).toString());

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-node-'));
// Retried, and without blocking: on Windows the delegated run's agent, whose
// working folder this is, holds it until the taskkill its stop() started has
// run, which a synchronous retry would keep from running.
afterAll(() => fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

// 30 s, not vitest's 5: these cases run the launcher through a real shell, and under a
// gate's load (load average 100 to 180 on 2026-10-01) case 13 took 6.8 s and case 3
// 5.2 s, both synchronous, so those are their real run times, and both failed the gate
// on nothing (27 full-suite reports of 28/09 to 01/10). Quiet, the slowest is 3.9 s.
describe('the program Tars runs its MCP servers on', { timeout: 30_000 }, () => {
  it.skipIf(skipOnWindows(LAUNCHER_NOT_RUNNABLE))('1, 2. is an absolute launcher that runs the app binary as Node, with no PATH at all', () => {
    const app = fakeApp(path.join(scratch, 'one'));

    const command = mcpNodeCommand(app, 'darwin', true);

    expect(command).toBe(launcher());
    expect(path.isAbsolute(command)).toBe(true);
    expect(run(command, ['/some/bundle.js', '--flag'])).toEqual({ runAsNode: '1', args: ['/some/bundle.js', '--flag'] });
  });

  it.skipIf(skipOnWindows(LAUNCHER_NOT_RUNNABLE))('3. survives an app path with a space, a quote and $(...), and runs none of it', () => {
    const app = fakeApp(path.join(scratch, "My Apps", "it's $(touch pwned)"));

    const command = mcpNodeCommand(app, 'linux', true);

    expect(run(command, ['x'])).toEqual({ runAsNode: '1', args: ['x'] });
    expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('4. is readable, writable and runnable by its owner alone', () => {
    mcpNodeCommand(fakeApp(path.join(scratch, 'four')), 'darwin', true);
    if (hasPosixModes()) expect(fs.statSync(launcher()).mode & 0o777).toBe(0o700);
  });

  it('5. follows the app when it moves, and is not rewritten when it did not', () => {
    const before = fakeApp(path.join(scratch, 'before'));
    const after = fakeApp(path.join(scratch, 'after'));
    mcpNodeCommand(before, 'darwin', true);
    const first = fs.statSync(launcher());

    mcpNodeCommand(before, 'darwin', true);
    expect(fs.statSync(launcher()).mtimeMs, 'rewritten with nothing changed').toBe(first.mtimeMs);
    expect(fs.statSync(launcher()).ino).toBe(first.ino);

    mcpNodeCommand(after, 'darwin', true);
    expect(fs.readFileSync(launcher(), 'utf-8')).toContain(after);
    expect(fs.readFileSync(launcher(), 'utf-8')).not.toContain(before);
  });

  it('6. stays `node` on Windows', () => {
    expect(mcpNodeCommand('C:\\Tars\\Tars.exe', 'win32')).toBe('node');
  });

  it('7. falls back to `node` when the launcher cannot be written', () => {
    const bin = path.dirname(launcher());
    fs.rmSync(bin, { recursive: true, force: true });
    fs.writeFileSync(bin, 'a file where the directory should be');
    try {
      expect(mcpNodeCommand(fakeApp(path.join(scratch, 'seven')), 'darwin', true)).toBe('node');
    } finally {
      fs.rmSync(bin, { force: true });
    }
  });
});

describe('registering the servers', () => {
  const resources = path.join(scratch, 'resources');
  const bundles = ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban'].map(dir => {
    const file = path.join(resources, dir, 'dist', 'bundle.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  });

  beforeEach(() => {
    appState.isPackaged = true;
    (process as unknown as { resourcesPath: string }).resourcesPath = resources;
    registry.clear();
    calls.length = 0;
    fs.rmSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'), { force: true });
  });

  it('8. moves the servers an older Tars registered with `node` over to the launcher, once', async () => {
    for (const [i, name] of ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban'].entries()) {
      registry.set(name, { command: 'node', args: [bundles[i]] });
    }

    await setupMcpOrchestrator({} as never);

    for (const name of ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-kanban']) {
      expect(registry.get(name)?.command, name).toBe(program());
    }
    expect(calls).toContain('remove claude-mgr-orchestrator');
  });

  it('11. is tried again at the next start when one registration failed, or when there was nothing to move', async () => {
    registry.set('claude-mgr-orchestrator', { command: 'node', args: [bundles[0]] });
    const register = fakeProvider.registerMcpServer;
    fakeProvider.registerMcpServer = async (name, command, args) => {
      if (name === 'claude-mgr-orchestrator') throw new Error('claude is busy');
      return register(name, command, args);
    };
    try {
      await setupMcpOrchestrator({} as never);
    } finally {
      fakeProvider.registerMcpServer = register;
    }

    await setupMcpOrchestrator({} as never);
    expect(registry.get('claude-mgr-orchestrator')?.command).toBe(program());

    // A start that finds no bundle records nothing either.
    fs.rmSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'), { force: true });
    (process as unknown as { resourcesPath: string }).resourcesPath = path.join(scratch, 'no-resources');
    await setupMcpOrchestrator({} as never);
    expect(fs.existsSync(path.join(home(), '.dorothy', 'mcp-servers-runtime.json'))).toBe(false);
  });

  it('9. registers nothing again at the next start', async () => {
    await setupMcpOrchestrator({} as never);
    expect(registry.get('claude-mgr-orchestrator')?.command).toBe(program());
    calls.length = 0;

    await setupMcpOrchestrator({} as never);

    expect(calls).toEqual([]);
  });
});

describe('the gate of #201', { timeout: 30_000 }, () => {
  const resources = path.join(scratch, 'resources');
  const runtimeFile = () => path.join(home(), '.dorothy', 'mcp-servers-runtime.json');
  beforeEach(() => {
    (process as unknown as { resourcesPath: string }).resourcesPath = resources;
    for (const dir of ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban']) {
      fs.mkdirSync(path.join(resources, dir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(resources, dir, 'dist', 'bundle.js'), '');
    }
    registry.clear(); otherRegistry.clear(); calls.length = 0;
    otherState.failing = false; providerList.value = 'one'; appState.isPackaged = true;
    fs.rmSync(runtimeFile(), { force: true });
    fs.rmSync(path.join(home(), '.dorothy', 'bin'), { recursive: true, force: true });
  });

  it('12. leaves the launcher as the packaged Tars wrote it when another start is not a packaged one at a lasting place', () => {
    const installed = fakeApp(path.join(scratch, 'Applications', 'Tars.app'));
    mcpNodeCommand(installed, 'darwin', true);
    const written = fs.readFileSync(launcher(), 'utf-8');

    appState.isPackaged = false;
    expect(mcpNodeCommand(fakeApp(path.join(scratch, 'worktree', 'Electron')), 'darwin')).toBe(launcher());
    appState.isPackaged = true;
    for (const transient of ['/Volumes/Tars 1.9.0/Tars.app/Contents/MacOS/Tars', '/private/var/folders/xy/T/AppTranslocation/1A2B/d/Tars.app/Contents/MacOS/Tars']) {
      expect(mcpNodeCommand(transient, 'darwin'), transient).toBe(launcher());
    }

    expect(fs.readFileSync(launcher(), 'utf-8')).toBe(written);
  });

  it('12. names `node` when there is no launcher and this start may not write one', () => {
    appState.isPackaged = false;
    expect(mcpNodeCommand(fakeApp(path.join(scratch, 'dev', 'Electron')), 'darwin')).toBe('node');
    expect(fs.existsSync(launcher())).toBe(false);
  });

  it.skipIf(skipOnWindows(LAUNCHER_NOT_RUNNABLE))('13. falls back to the node on the PATH once the app it names is gone', () => {
    const app = fakeApp(path.join(scratch, 'gone'));
    mcpNodeCommand(app, 'darwin', true);
    fs.rmSync(app);
    const bin = path.join(scratch, 'fake-node-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "the PATH's node: $*"\n`, { mode: 0o755 });

    const out = execFileSync(launcher(), ['/some/bundle.js'], { env: { PATH: `${bin}:/usr/bin:/bin` } }).toString();

    expect(out.trim()).toBe("the PATH's node: /some/bundle.js");
  });

  it('14. names the AppImage file, not its mount point, on Linux', () => {
    const appImage = fakeApp(path.join(scratch, 'Apps', 'Tars.AppImage'));
    const before = process.env.APPIMAGE;
    process.env.APPIMAGE = appImage;
    try {
      mcpNodeCommand(undefined, 'linux', true);
    } finally {
      if (before === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = before;
    }
    expect(fs.readFileSync(launcher(), 'utf-8')).toContain(appImage);
  });

  it.skipIf(cannotSymlink())('15. writes nothing through a symlinked ~/.dorothy/bin', () => {
    const elsewhere = path.join(scratch, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home(), '.dorothy', 'bin'));

    expect(mcpNodeCommand(fakeApp(path.join(scratch, 'fifteen')), 'darwin', true)).toBe('node');
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('16. tries again only the provider that failed, and records the others as moved', async () => {
    providerList.value = 'two';
    // Both providers carry what an older Tars registered, on `node`; the
    // second one's config cannot be written (chmod 000), so it keeps that.
    for (const dir of ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban']) {
      const name = { 'mcp-orchestrator': 'claude-mgr-orchestrator', 'mcp-memory': 'tars-memory', 'mcp-kanban': 'claude-mgr-kanban' }[dir]!;
      const entry = { command: 'node', args: [path.join(resources, dir, 'dist', 'bundle.js')] };
      registry.set(name, { ...entry }); otherRegistry.set(name, { ...entry });
    }
    otherState.failing = true;
    await setupMcpOrchestrator({} as never);
    expect(registry.get('claude-mgr-orchestrator')?.command).toBe(program());

    calls.length = 0;
    await setupMcpOrchestrator({} as never);
    expect(calls.filter(c => !c.startsWith('other')), 'the provider that worked was moved again').toEqual([]);
    expect(calls.some(c => c.startsWith('other')), 'the provider that failed was not tried again').toBe(true);

    otherState.failing = false;
    await setupMcpOrchestrator({} as never);
    expect(otherRegistry.get('claude-mgr-orchestrator')?.command).toBe(program());
    calls.length = 0;
    await setupMcpOrchestrator({} as never);
    expect(calls).toEqual([]);
  });

  it('17. moves nothing over from a start that is not packaged', async () => {
    registry.set('claude-mgr-orchestrator', { command: '/somewhere/else/node', args: [path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js')] });
    appState.isPackaged = false;

    await setupMcpOrchestrator({} as never);

    expect(registry.get('claude-mgr-orchestrator')?.command).toBe('/somewhere/else/node');
    expect(calls.filter(c => c.startsWith('remove'))).toEqual([]);
  });
});

describe('a start from a copy that will be gone', () => {
  // A disk image (/Volumes) or an AppTranslocation copy is how macOS runs an
  // app from where it will not last; Windows has neither, so 18 to 21 are
  // macOS paths and the copy cases skip there (20, the lasting copy, runs).
  const macOnly = it.skipIf(process.platform === 'win32');
  const installed = path.join(scratch, 'Applications', 'Tars.app', 'Contents', 'Resources');
  const translocated = path.join(scratch, 'private', 'var', 'folders', 'xy', 'T', 'AppTranslocation', '0A1B2C', 'd', 'Tars.app', 'Contents', 'Resources');
  const names = { 'mcp-orchestrator': 'claude-mgr-orchestrator', 'mcp-memory': 'tars-memory', 'mcp-kanban': 'claude-mgr-kanban' } as const;
  const runtimeFile = () => path.join(home(), '.dorothy', 'mcp-servers-runtime.json');
  beforeEach(() => {
    for (const resources of [installed, translocated]) {
      for (const dir of Object.keys(names)) {
        fs.mkdirSync(path.join(resources, dir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(resources, dir, 'dist', 'bundle.js'), '');
      }
    }
    registry.clear(); calls.length = 0; providerList.value = 'one'; appState.isPackaged = true;
    fs.rmSync(runtimeFile(), { force: true });
    fs.rmSync(path.join(home(), '.claude', 'mcp.json'), { force: true });
  });

  macOnly('18, 19. registers nothing from a translocated copy, and leaves the installed Tars\'s registrations and record alone', async () => {
    (process as unknown as { resourcesPath: string }).resourcesPath = installed;
    await setupMcpOrchestrator({} as never);
    const before = JSON.stringify([...registry]);
    const record = fs.readFileSync(runtimeFile(), 'utf-8');
    calls.length = 0;

    (process as unknown as { resourcesPath: string }).resourcesPath = translocated;
    fs.rmSync(runtimeFile(), { force: true });
    fs.writeFileSync(runtimeFile(), record);
    await setupMcpOrchestrator({} as never);

    expect(calls).toEqual([]);
    expect(JSON.stringify([...registry])).toBe(before);
    expect(JSON.stringify([...registry])).not.toContain('AppTranslocation');
    expect(fs.readFileSync(runtimeFile(), 'utf-8')).toBe(record);
  });

  it('18, 20. takes a disk image or a translocated copy for one, and nothing else', () => {
    const transient = (mcpNode as unknown as { isTransientAppPath?: (p: string) => boolean }).isTransientAppPath;
    expect(typeof transient).toBe('function');
    expect(transient!('/Volumes/Tars 1.9.1/Tars.app/Contents/Resources')).toBe(true);
    expect(transient!('/private/var/folders/xy/abc/T/AppTranslocation/0A1B/d/Tars.app/Contents/Resources')).toBe(true);
    expect(transient!('/Applications/Tars.app/Contents/Resources')).toBe(false);
    expect(transient!('/Users/x/Volumes/Tars.app/Contents/Resources')).toBe(false);
    expect(transient!('/opt/Tars/resources')).toBe(false);
  });

  macOnly('21. refuses the Settings button\'s setup from such a copy, and writes no config', async () => {
    (process as unknown as { resourcesPath: string }).resourcesPath = translocated;
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    setupOrchestratorSetupHandler();
    const [, handler] = handle.mock.calls.find(([channel]) => channel === 'orchestrator:setup')!;
    // No claude on the PATH: without the guard, the setup falls back to writing ~/.claude/mcp.json.
    vi.stubEnv('PATH', path.join(scratch, 'no-bin'));
    try {
      const result = await (handler as () => Promise<{ success: boolean; error?: string }>)();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Applications/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(path.join(home(), '.claude', 'mcp.json'))).toBe(false);
  });
});

describe('a delegated run', () => {
  it('10. hands its CLI servers that run on the launcher', async () => {
    const resources = path.join(scratch, 'resources');
    (process as unknown as { resourcesPath: string }).resourcesPath = resources;
    const report = path.join(scratch, 'acp-servers.json');
    const agentScript = path.join(scratch, 'acp-agent.mjs');
    fs.writeFileSync(agentScript, `
import { writeFileSync } from 'node:fs';
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') {
    writeFileSync(${JSON.stringify(report)}, JSON.stringify(msg.params.mcpServers.map(s => ({ name: s.name, command: s.command }))));
    return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  }
  if (msg.method === 'session/prompt') return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
}
`);
    acpLaunch = { command: process.execPath, args: [agentScript] };
    mcpNodeCommand(fakeApp(path.join(scratch, 'acp-app')), 'darwin', true);

    await delegateOverAcp({
      agent: { id: 'a1', name: 'A', status: 'idle', projectPath: scratch, provider: 'claude', skills: [], output: [], lastActivity: new Date().toISOString() } as never,
      task: 'x', appSettings: {} as never, timeoutMs: 20_000,
    });

    const servers = JSON.parse(fs.readFileSync(report, 'utf-8')) as { name: string; command: string }[];
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) expect(server.command, server.name).toBe(program());
  });
});
