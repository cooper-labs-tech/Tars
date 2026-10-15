import { describe, it, expect } from 'vitest';

import {
  CliNotRunnableError, cliEnv, cliInvocation, findWindowsCli, nodeServerCommand, stdioServerCommand, windowsCliDirs, windowsCliFile,
  windowsGcloudDirs,
} from '../../../electron/providers/cli-exec';
import { CMD_SHIM_EXE, CMD_SHIM_NODE, GCLOUD_CMD, NODE_DIST_NPX, SH_SHIM, fakeWinFs } from './win-fake-disk';

/**
 * How Tars runs a CLI outside the agent PTY (MCP registration, kanban
 * generate, gws, `claude mcp list`) and finds one on Windows (Settings > CLI
 * paths, Google Workspace). Audit A11, A18, A24, B/C-01..C-05, B/M-01.
 *
 * How it fails, written before the code (2026-09-25):
 * cliInvocation
 * 1. darwin/linux: the name comes back changed, or the disk is read: it must
 *    be the name as given, exactly what execFile got before.
 * 2. win32: an npm node shim is started as the .cmd (EINVAL since
 *    CVE-2024-27980) or as the bare name (ENOENT: libuv tries .com/.exe only),
 *    instead of node.exe with the shim's script in front of the arguments.
 * 3. win32: the arguments are reordered, joined or dropped.
 * 4. win32: a failed resolution is swallowed or turned into a spawn of the
 *    bare name; it must be a typed error that carries the resolver's reason
 *    and detail, for the log.
 * cliEnv
 * 5. darwin/linux: an env is added where there was none (child_process then
 *    reads process.env, as before).
 * 6. win32: the lookup misses %APPDATA%\npm and %USERPROFILE%\.local\bin when
 *    the process PATH lacks them (Electron started from a shortcut), unlike
 *    the agent PTY, which gets them through buildFullPath.
 * 7. win32: the env keeps both `Path` and `PATH`, so the child reads another
 *    PATH than the one the CLI was resolved against.
 * stdioServerCommand (the command a CLI writes into its MCP config)
 * 8. darwin/linux: command or args altered.
 * 9. win32: `npx` (a .cmd) written as the command: the CLI that starts the
 *    server later gets EINVAL or ENOENT. It must be node.exe + npx-cli.js.
 * 10. win32: `node`, a real .exe on the PATH, rewritten to the absolute path
 *    of today's node, which the next node upgrade removes.
 * 11. win32: a command that cannot be resolved is dropped or thrown; it must
 *    be kept as given, the reason handed back for the log.
 * windowsCliFile / findWindowsCli (detection on win32)
 * 12. The extensionless sh shim npm writes beside claude.cmd is returned.
 * 13. PATHEXT order ignored: claude.cmd returned when claude.exe sits in the
 *    same directory (.EXE comes before .CMD).
 * 14. A directory with spaces or parentheses is mangled.
 * 15. A batch file that is not an npm shim (gcloud.cmd) is refused where
 *    only its presence matters, or accepted where Tars itself must start it.
 * 16. A relative or drive-relative directory (`bin`, `C:dir`, the macOS
 *    `/opt/homebrew/bin` read on Windows) reaches the disk: a planting hole.
 * 17. Directory order not honoured: the first directory holding the CLI wins,
 *    then the PATH, in its order.
 * 18. A failure other than "not there" (a shim that cannot be read through, a
 *    missing target) is swallowed; it must come back in `rejected`.
 * windowsCliDirs / windowsGcloudDirs
 * 19. A Windows install location is missing: %USERPROFILE%\.local\bin,
 *    %APPDATA%\npm, %LOCALAPPDATA%\Programs, ~\scoop\shims,
 *    %LOCALAPPDATA%\Microsoft\WinGet\Links; gcloud's Cloud SDK bin under
 *    %LOCALAPPDATA% and Program Files.
 * 20. An unset variable becomes a relative directory (`undefined\npm`).
 * Found while writing the handler's tests, written before the fix:
 * 21. An npm node shim (codex.cmd) is refused because node is not on this
 *    PATH: node is found when the CLI starts, on the agent's PATH, which
 *    carries the node configured in Settings.
 * Added at win-reviewer's gate (2026-09-25), written before the fix:
 * 22. stdioServerCommand writes the absolute path of today's node.exe for an
 *    npm node shim (npx, gws.cmd) when that node is simply the one the PATH
 *    finds: under nvm or fnm the entry dies at the next Node switch, and
 *    isMcpServerRegistered, which compares the script, never rewrites it.
 *    It must be bare `node` then, and the full path only for a node.exe that
 *    sits beside the shim and is not the PATH's.
 * nodeServerCommand (one of Tars's own servers: node for .js, npx tsx for .ts)
 * 23. The .ts form writes `npx` (a .cmd no CLI can start) on win32, or the
 *    .js form anything but `node <path>`; darwin/linux differ from before.
 * 24. An unresolved npx is dropped silently: it must be kept as given and
 *    logged with the reason.
 */

const HOME = 'C:\\Users\\Sam Lee';
const NPM = `${HOME}\\AppData\\Roaming\\npm`;
const LOCAL_BIN = `${HOME}\\.local\\bin`;
const NODEJS = 'C:\\Program Files (x86)\\nodejs';

const DISK: Record<string, string> = {
  [`${LOCAL_BIN}\\claude.exe`]: 'MZ',
  [`${NPM}\\claude`]: SH_SHIM,
  [`${NPM}\\claude.cmd`]: CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
  [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: 'MZ',
  [`${NPM}\\codex`]: SH_SHIM,
  [`${NPM}\\codex.cmd`]: CMD_SHIM_NODE('node_modules\\@openai\\codex\\bin\\codex.js'),
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NPM}\\broken.cmd`]: CMD_SHIM_NODE('node_modules\\gone\\cli.js'),
  [`${NODEJS}\\node.exe`]: 'MZ',
  [`${NODEJS}\\npx.cmd`]: NODE_DIST_NPX,
  [`${NODEJS}\\npx`]: SH_SHIM,
  [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`]: '',
  [`${NODEJS}\\node_modules\\npm\\bin\\npm-prefix.js`]: '',
  'C:\\both (x86)\\tool.cmd': CMD_SHIM_EXE('real.exe'),
  'C:\\both (x86)\\tool.exe': 'MZ',
  'C:\\both (x86)\\real.exe': 'MZ',
  'C:\\sh-only\\tool': SH_SHIM,
  [`${HOME}\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd`]: GCLOUD_CMD,
  'C:\\cwd-plant\\bin\\claude.exe': 'MZ',
  'C:\\cwd-plant\\claude.exe': 'MZ',
};

const winEnv = (pathValue: string, extra: Record<string, string> = {}) => ({
  Path: pathValue, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', USERPROFILE: HOME,
  APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local`, ...extra,
});

describe('cliInvocation', () => {
  it.each(['darwin', 'linux'] as const)('%s: the name as given, the args untouched, no disk access', (platform) => {
    const disk = fakeWinFs(DISK);
    const args = ['mcp', 'add', '-s', 'user', 'x y', '$(id)'];
    expect(cliInvocation('claude', args, { PATH: '/usr/bin' }, platform, disk)).toEqual({ file: 'claude', args });
    expect(cliInvocation('/opt/homebrew/bin/gws', ['auth'], {}, platform, disk)).toEqual({ file: '/opt/homebrew/bin/gws', args: ['auth'] });
    expect(disk.probes).toEqual([]);
  });

  it('win32: an npm node shim starts as node.exe, its script first, the args after it in order', () => {
    const disk = fakeWinFs(DISK);
    const out = cliInvocation('codex', ['mcp', 'add', 'n', '--', 'node', 'C:\\a b (x)\\s.js'], winEnv(`${NPM};${NODEJS}`), 'win32', disk);
    expect(out).toEqual({
      file: `${NODEJS}\\node.exe`,
      args: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'mcp', 'add', 'n', '--', 'node', 'C:\\a b (x)\\s.js'],
    });
  });

  it('win32: an npm shim of a native exe starts that exe, with nothing in front', () => {
    const out = cliInvocation('claude', ['mcp', 'list'], winEnv(`${NPM};${NODEJS}`), 'win32', fakeWinFs(DISK));
    expect(out).toEqual({ file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, args: ['mcp', 'list'] });
  });

  it('win32: a failure is a typed error carrying the reason and the detail', () => {
    const run = () => cliInvocation('grok', ['mcp', 'list'], winEnv(`${NPM};${NODEJS}`), 'win32', fakeWinFs(DISK));
    expect(run).toThrow(CliNotRunnableError);
    try {
      run();
    } catch (err) {
      expect((err as CliNotRunnableError).failure.reason).toBe('not-found');
      expect((err as Error).message).toMatch(/grok/);
      expect((err as Error).message).toMatch(/not-found/);
      expect((err as Error).message).toMatch(/PATHEXT/);
    }
    expect(() => cliInvocation('broken', [], winEnv(NPM), 'win32', fakeWinFs(DISK)))
      .toThrow(/shim-target-missing/);
  });
});

describe('cliEnv', () => {
  it.each(['darwin', 'linux'] as const)('%s: no env, child_process keeps reading process.env', (platform) => {
    expect(cliEnv(platform, { PATH: '/usr/bin' })).toBeUndefined();
  });

  it('win32: one PATH key, the process PATH first, then ~\\.local\\bin and %APPDATA%\\npm', () => {
    const env = cliEnv('win32', { Path: 'C:\\Windows\\System32', PATH: 'C:\\set-last', USERPROFILE: HOME, APPDATA: `${HOME}\\AppData\\Roaming` })!;
    const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
    expect(keys).toHaveLength(1);
    expect(env[keys[0]]!.split(';')).toEqual(['C:\\set-last', LOCAL_BIN, NPM]);
  });
});

describe('stdioServerCommand', () => {
  it.each(['darwin', 'linux'] as const)('%s: command and args as given', (platform) => {
    const disk = fakeWinFs(DISK);
    expect(stdioServerCommand('npx', ['tsx', '/a/s.ts'], { PATH: '/usr/bin' }, platform, disk)).toEqual({ command: 'npx', args: ['tsx', '/a/s.ts'] });
    expect(disk.probes).toEqual([]);
  });

  it('win32: npx becomes node with npx-cli.js in front, bare `node` when node.exe beside it is the PATH\'s', () => {
    const out = stdioServerCommand('npx', ['tsx', 'C:\\srv (1)\\s.ts'], winEnv(NODEJS), 'win32', fakeWinFs(DISK));
    expect(out).toEqual({ command: 'node', args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, 'tsx', 'C:\\srv (1)\\s.ts'] });
  });

  it('win32: an npm shim with no node beside it writes bare `node`, the node the PATH finds', () => {
    const out = stdioServerCommand('codex', ['mcp'], winEnv(`${NPM};${NODEJS}`), 'win32', fakeWinFs(DISK));
    expect(out).toEqual({ command: 'node', args: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'mcp'] });
  });

  it('win32: a node.exe beside the shim that is not the PATH\'s keeps its full path', () => {
    const out = stdioServerCommand('npx', ['tsx', 'C:\\s.ts'], winEnv(`C:\\other-node;${NODEJS}`), 'win32', fakeWinFs({ ...DISK, 'C:\\other-node\\node.exe': 'MZ' }));
    expect(out).toEqual({ command: `${NODEJS}\\node.exe`, args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, 'tsx', 'C:\\s.ts'] });
  });

  it('win32: node, a real exe on the PATH, stays `node`', () => {
    expect(stdioServerCommand('node', ['C:\\b.js'], winEnv(NODEJS), 'win32', fakeWinFs(DISK))).toEqual({ command: 'node', args: ['C:\\b.js'] });
  });

  it('win32: an unresolvable command is kept as given, with the reason', () => {
    const out = stdioServerCommand('npx', ['tsx', 'C:\\s.ts'], winEnv('C:\\empty'), 'win32', fakeWinFs(DISK));
    expect(out.command).toBe('npx');
    expect(out.args).toEqual(['tsx', 'C:\\s.ts']);
    expect(out.unresolved?.reason).toBe('not-found');
  });
});

describe('nodeServerCommand', () => {
  it.each(['darwin', 'linux'] as const)('%s: node <path> for .js, npx tsx <path> for .ts, as before', (platform) => {
    expect(nodeServerCommand('/a/b.js', 's', { PATH: '/usr/bin' }, platform, fakeWinFs(DISK))).toEqual({ command: 'node', args: ['/a/b.js'] });
    expect(nodeServerCommand('/a/b.ts', 's', { PATH: '/usr/bin' }, platform, fakeWinFs(DISK))).toEqual({ command: 'npx', args: ['tsx', '/a/b.ts'] });
  });

  it('win32: the .ts form is node and npx-cli.js, never npx.cmd', () => {
    expect(nodeServerCommand('C:\\t (x)\\s.ts', 'tasmania', winEnv(NODEJS), 'win32', fakeWinFs(DISK)))
      .toEqual({ command: 'node', args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, 'tsx', 'C:\\t (x)\\s.ts'] });
  });

  it('win32: no npx anywhere keeps npx and says why', () => {
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
    try {
      expect(nodeServerCommand('C:\\s.ts', 'tasmania', winEnv('C:\\empty'), 'win32', fakeWinFs(DISK))).toEqual({ command: 'npx', args: ['tsx', 'C:\\s.ts'] });
    } finally {
      console.warn = warn;
    }
    expect(warned.join('\n')).toMatch(/tasmania.*npx.*not-found/);
  });
});

describe('windowsCliFile', () => {
  const disk = fakeWinFs(DISK);
  const env = winEnv(NODEJS);

  it('never the extensionless sh shim: the .cmd beside it, and the sh shim alone is refused', () => {
    expect(windowsCliFile(`${NPM}\\codex`, env, 'startable', disk)).toEqual({ path: `${NPM}\\codex.cmd` });
    const alone = windowsCliFile('C:\\sh-only\\tool', env, 'startable', disk);
    expect('failure' in alone && alone.failure.reason).toBe('unsupported-extension');
  });

  it('PATHEXT order: tool.exe before tool.cmd, in a folder with spaces and parentheses', () => {
    expect(windowsCliFile('C:\\both (x86)\\tool', env, 'startable', disk)).toEqual({ path: 'C:\\both (x86)\\tool.exe' });
  });

  it('an npm node shim is the CLI even with no node on this PATH', () => {
    expect(windowsCliFile(`${NPM}\\codex`, winEnv('C:\\Windows'), 'startable', fakeWinFs(DISK))).toEqual({ path: `${NPM}\\codex.cmd` });
  });

  it('a path given with its extension is that file', () => {
    expect(windowsCliFile(`${NPM}\\claude.cmd`, env, 'startable', disk)).toEqual({ path: `${NPM}\\claude.cmd` });
  });

  it('gcloud.cmd: present when presence is asked, refused when Tars must start it', () => {
    const gcloud = `${HOME}\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud`;
    expect(windowsCliFile(gcloud, env, 'present', disk)).toEqual({ path: `${gcloud}.cmd` });
    const started = windowsCliFile(gcloud, env, 'startable', disk);
    expect('failure' in started && started.failure.reason).toBe('unrecognised-shim');
  });

  it('a relative, drive-relative or rooted path never reaches the disk', () => {
    const planted = fakeWinFs(DISK);
    for (const p of ['bin\\claude', 'C:bin\\claude', '\\opt\\homebrew\\bin\\claude', '/opt/homebrew/bin/claude', 'claude']) {
      const out = windowsCliFile(p, env, 'present', planted);
      expect('failure' in out && out.failure.reason, p).toBe('invalid-name');
    }
    expect(planted.relativeProbes).toEqual([]);
  });
});

describe('findWindowsCli', () => {
  it('the first directory that holds it, then the PATH in its order; relative entries skipped', () => {
    const disk = fakeWinFs(DISK);
    const env = winEnv(`bin;${NPM};${NODEJS}`);
    expect(findWindowsCli('claude', [LOCAL_BIN, NPM], env, 'startable', disk).path).toBe(`${LOCAL_BIN}\\claude.exe`);
    expect(findWindowsCli('claude', [NPM, LOCAL_BIN], env, 'startable', disk).path).toBe(`${NPM}\\claude.cmd`);
    expect(findWindowsCli('claude', ['\\opt\\homebrew\\bin'], env, 'startable', disk).path).toBe(`${NPM}\\claude.cmd`);
    expect(findWindowsCli('npx', [], env, 'startable', disk).path).toBe(`${NODEJS}\\npx.cmd`);
    expect(disk.relativeProbes).toEqual([]);
  });

  it('a quoted PATH entry is searched unquoted', () => {
    const disk = fakeWinFs(DISK);
    expect(findWindowsCli('tool', [], winEnv('"C:\\both (x86)"'), 'startable', disk).path).toBe('C:\\both (x86)\\tool.exe');
  });

  it('reports what it found and could not use, and finds nothing rather than the sh shim', () => {
    const disk = fakeWinFs(DISK);
    const out = findWindowsCli('tool', ['C:\\sh-only'], winEnv(NPM), 'startable', disk);
    expect(out.path).toBeUndefined();
    expect(out.rejected.map((r) => r.reason)).toEqual(['unsupported-extension']);
    const broken = findWindowsCli('broken', [], winEnv(NPM), 'startable', disk);
    expect(broken.path).toBeUndefined();
    expect(broken.rejected.map((r) => r.reason)).toEqual(['shim-target-missing']);
  });
});

describe('windowsCliDirs and windowsGcloudDirs', () => {
  it('the Windows install locations, from the environment', () => {
    expect(windowsCliDirs(winEnv(''))).toEqual(expect.arrayContaining([
      LOCAL_BIN,
      NPM,
      `${HOME}\\AppData\\Local\\Programs`,
      `${HOME}\\scoop\\shims`,
      `${HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links`,
    ]));
    expect(windowsGcloudDirs(winEnv('', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' }))).toEqual([
      `${HOME}\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin`,
      'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin',
      'C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin',
    ]);
  });

  it('an unset variable falls back to the profile, never to a relative folder', () => {
    const dirs = [...windowsCliDirs({ USERPROFILE: HOME }), ...windowsGcloudDirs({ USERPROFILE: HOME })];
    for (const d of dirs) expect(d, d).toMatch(/^[A-Z]:\\/i);
    expect(dirs).toContain(NPM);
  });
});
