import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openTerminal, LINUX_TERMINALS, type OpenTerminalDeps } from '../../../electron/utils/open-terminal';

/**
 * shell:open-terminal on Linux (JeanBrasse, 2026-09-24: "l'app doit rester
 * compatible linux"). It ran osascript whatever the platform, which on Linux is
 * "spawn osascript ENOENT": the button did nothing and said so in words nobody
 * could act on.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. Linux runs osascript, or nothing.
 * 2. The terminal opens somewhere else than the directory asked for.
 * 3. The directory reaches a shell: a name with a quote, `$(...)` or a
 *    backtick runs as a command. It must only ever be an argv entry or a cwd.
 * 4. The first terminal tried is missing (a desktop without Debian's
 *    x-terminal-emulator) and the others are never tried.
 * 5. None is installed, and the answer does not say what was looked for.
 * 6. A path that is not a directory, or does not exist, is handed to a
 *    terminal anyway.
 * 7. macOS stops doing what it did: Terminal.app through osascript, the
 *    directory escaped for the shell, then for AppleScript.
 * 8. Another platform throws, or runs something, instead of saying no.
 *
 * Windows (audit B L-01, 2026-09-25), written before its branch:
 * 9. win32 says no, as it did.
 * 10. Windows Terminal is installed (wt.exe, an app execution alias Node's
 *     stat cannot open) and something else starts, or it starts elsewhere than
 *     the directory: it takes `-d <dir>` and the directory as its cwd.
 * 11. The directory reaches a parser: wt splits its command line at `;`, so a
 *     folder named `x;calc` would run calc in a second tab. A directory holding
 *     `;` never goes to wt; nothing else it holds (`'`, `$()`, backtick, `&`,
 *     `%VAR%`) is ever more than one argv entry or a cwd, and no shell and no
 *     cmd.exe is started to open the window.
 * 12. No wt.exe, or it will not start: no window. The fallback is the user's
 *     shell (resolveShell: pwsh, else Windows PowerShell, else cmd) in a new
 *     console window, which a detached console program does not get: it is
 *     started by System32's conhost.exe, the directory its cwd and nothing else.
 * 13. Nothing starts, and the answer does not say what was tried.
 * 14. The console fallback starts Windows PowerShell 5.1 with the PSModulePath
 *     of a Tars started from PowerShell 7: it finds pwsh 7's modules first and
 *     loses core cmdlets (platform/child-env.ts). pwsh keeps it, and so does
 *     wt.exe, which is started as it was.
 */

type Spawned = { file: string; args: string[]; options: Record<string, unknown> };

function fakeDeps(platform: NodeJS.Platform, installed: string[]): OpenTerminalDeps & { spawned: Spawned[]; executed: Spawned[] } {
  const spawned: Spawned[] = [];
  const executed: Spawned[] = [];
  return {
    platform,
    spawned,
    executed,
    launch: async (file, args, options) => {
      spawned.push({ file, args, options: options as Record<string, unknown> });
      if (!installed.includes(file)) {
        const err = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    },
    execFile: async (file, args, options) => {
      executed.push({ file, args, options: options as Record<string, unknown> });
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tars term 'q' $(id) \`id\` `));

describe('opening a terminal in a directory', () => {
  it('1, 2, 3. on Linux, starts the first terminal installed, in the directory, with no shell between', async () => {
    const deps = fakeDeps('linux', ['x-terminal-emulator']);

    const r = await openTerminal(dir, deps);

    expect(r).toEqual({ success: true, terminal: 'x-terminal-emulator' });
    expect(deps.spawned).toHaveLength(1);
    const [s] = deps.spawned;
    expect(s.file).toBe('x-terminal-emulator');
    expect(s.options.cwd).toBe(dir);
    expect(s.options.shell).toBeFalsy();
    expect(deps.executed).toEqual([]);
  });

  it('4. tries the next one when the first is missing, and passes the directory as an argument where the terminal takes one', async () => {
    const deps = fakeDeps('linux', ['gnome-terminal']);

    const r = await openTerminal(dir, deps);

    expect(r).toEqual({ success: true, terminal: 'gnome-terminal' });
    expect(deps.spawned.map(s => s.file)).toEqual(['x-terminal-emulator', 'gnome-terminal']);
    const gnome = deps.spawned[1];
    expect(gnome.args).toEqual([`--working-directory=${dir}`]);
    expect(gnome.options.cwd).toBe(dir);
  });

  it('4. reaches konsole and xterm in that order', async () => {
    const konsole = fakeDeps('linux', ['konsole']);
    expect((await openTerminal(dir, konsole)).terminal).toBe('konsole');
    expect(konsole.spawned.at(-1)!.args).toEqual(['--workdir', dir]);

    const xterm = fakeDeps('linux', ['xterm']);
    expect((await openTerminal(dir, xterm)).terminal).toBe('xterm');
    expect(xterm.spawned.map(s => s.file)).toEqual(LINUX_TERMINALS.map(t => t.file));
  });

  it('5. says which terminals it looked for when none is installed', async () => {
    const deps = fakeDeps('linux', []);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(false);
    for (const t of LINUX_TERMINALS) expect(r.error).toContain(t.file);
  });

  it('6. refuses a path that does not exist, or is not a directory, and starts nothing', async () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    for (const target of [path.join(dir, 'missing'), file, '']) {
      const deps = fakeDeps('linux', ['x-terminal-emulator']);
      const r = await openTerminal(target, deps);
      expect(r.success).toBe(false);
      expect(deps.spawned).toEqual([]);
    }
  });

  it('7. on macOS, still asks Terminal.app through osascript, the directory escaped twice', async () => {
    const deps = fakeDeps('darwin', []);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(true);
    expect(deps.spawned).toEqual([]);
    expect(deps.executed).toHaveLength(1);
    const [e] = deps.executed;
    expect(e.file).toBe('osascript');
    expect(e.args[0]).toBe('-e');
    const shellQuoted = `'${dir.replace(/'/g, "'\\''")}'`;
    expect(e.args[1]).toBe(`tell application "Terminal" to do script "${`cd ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  });

  it('8. says no on a platform it does not know, and runs nothing', async () => {
    const deps = fakeDeps('aix', ['x-terminal-emulator']);

    const r = await openTerminal(dir, deps);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/aix/);
    expect(deps.spawned).toEqual([]);
    expect(deps.executed).toEqual([]);
  });
});

const SYS = 'C:\\Windows\\System32';
const CONHOST = `${SYS}\\conhost.exe`;
const WT = 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
const POWERSHELL = `${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WIN_PATH = 'C:\\Users\\n\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32';

/** A Windows machine where `onDisk` exist and `installed` start. */
function winDeps(installed: string[], onDisk: string[] = [WT, POWERSHELL, CONHOST], winPath = WIN_PATH) {
  return Object.assign(fakeDeps('win32', installed), {
    env: { SystemRoot: 'C:\\Windows', Path: winPath },
    fs: { isFile: (p: string) => onDisk.includes(p), readFile: () => '' },
  });
}

const winDir = fs.mkdtempSync(path.join(os.tmpdir(), "tars term 'q' $(id) `id` & %PATH% "));
const semiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars term;calc '));
// Every run made these three and left them in the temp directory.
afterAll(() => { for (const d of [dir, winDir, semiDir]) fs.rmSync(d, { recursive: true, force: true }); });

describe('opening a terminal on Windows', () => {
  it('10. starts Windows Terminal from the PATH, in the directory, the directory one argument', async () => {
    const deps = winDeps([WT]);
    const r = await openTerminal(winDir, deps);
    expect(r).toEqual({ success: true, terminal: 'Windows Terminal' });
    expect(deps.spawned).toEqual([{ file: WT, args: ['-d', path.win32.resolve(winDir)], options: { cwd: winDir, detached: true, stdio: 'ignore' } }]);
    expect(deps.executed).toEqual([]);
  });

  it('11. never hands wt a directory holding ";", and starts no shell or cmd.exe to open anything', async () => {
    const deps = winDeps([WT, CONHOST]);
    const r = await openTerminal(semiDir, deps);
    expect(r).toEqual({ success: true, terminal: 'powershell.exe' });
    expect(deps.spawned).toEqual([{ file: CONHOST, args: [POWERSHELL, '-NoLogo'], options: { cwd: semiDir, detached: true, stdio: 'ignore', env: deps.env } }]);
    for (const d of [...deps.spawned, ...deps.executed]) {
      expect(d.file).not.toMatch(/cmd\.exe$/i);
      expect(d.args.join('\n')).not.toContain('calc');
    }
  });

  it('12. no wt.exe: the user\'s shell in a new console at the directory, pwsh first when it is there', async () => {
    const plain = winDeps([CONHOST], [POWERSHELL, CONHOST]);
    expect(await openTerminal(winDir, plain)).toEqual({ success: true, terminal: 'powershell.exe' });
    expect(plain.spawned).toEqual([{ file: CONHOST, args: [POWERSHELL, '-NoLogo'], options: { cwd: winDir, detached: true, stdio: 'ignore', env: plain.env } }]);

    const seven = winDeps([CONHOST], [PWSH, POWERSHELL, CONHOST], `C:\\Program Files\\PowerShell\\7;${WIN_PATH}`);
    expect(await openTerminal(winDir, seven)).toEqual({ success: true, terminal: 'pwsh.exe' });
    expect(seven.spawned[0].args).toEqual([PWSH, '-NoLogo']);
  });

  it('12. wt.exe is there but will not start: the console instead', async () => {
    const deps = winDeps([CONHOST]);
    const r = await openTerminal(winDir, deps);
    expect(r).toEqual({ success: true, terminal: 'powershell.exe' });
    expect(deps.spawned.map(s => s.file)).toEqual([WT, CONHOST]);
  });

  it('13. nothing starts: says what it tried', async () => {
    const deps = winDeps([]);
    const r = await openTerminal(winDir, deps);
    expect(r.success).toBe(false);
    expect(r.error).toContain('wt.exe');
    expect(r.error).toContain('conhost.exe');
  });

  it('14. the console gives Windows PowerShell no PSModulePath, and pwsh and wt the parent\'s', async () => {
    const modules = 'C:\\Users\\n\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules';
    const plain = winDeps([CONHOST], [POWERSHELL, CONHOST]);
    plain.env = { ...plain.env, PSModulePath: modules } as typeof plain.env;
    await openTerminal(winDir, plain);
    expect(plain.spawned[0].options.env).toEqual({ SystemRoot: 'C:\\Windows', Path: WIN_PATH });

    const seven = winDeps([CONHOST], [PWSH, POWERSHELL, CONHOST], `C:\\Program Files\\PowerShell\\7;${WIN_PATH}`);
    seven.env = { ...seven.env, PSModulePath: modules } as typeof seven.env;
    await openTerminal(winDir, seven);
    expect(seven.spawned[0].args[0]).toBe(PWSH);
    expect(seven.spawned[0].options.env).toBe(seven.env);

    const wt = winDeps([WT]);
    wt.env = { ...wt.env, PSModulePath: modules } as typeof wt.env;
    await openTerminal(winDir, wt);
    expect(wt.spawned[0].options).toEqual({ cwd: winDir, detached: true, stdio: 'ignore' });
  });

  it('6. refuses a directory that does not exist, and starts nothing', async () => {
    const deps = winDeps([WT]);
    expect((await openTerminal(path.join(winDir, 'missing'), deps)).success).toBe(false);
    expect(deps.spawned).toEqual([]);
  });
});

describe('QA #177: the real launcher, with a stand-in terminal that records what it was given', () => {
  // Written by the QA at the gate of #177. The tests above hand openTerminal a
  // fake launcher, so the `shell: false` of the real one was never exercised:
  // `options.shell` is never set by openTerminal, and a real launcher that ran a
  // shell left them green. This goes through nodeLaunch, with a PATH that holds
  // only a stand-in gnome-terminal, so no real terminal can start, here or on
  // the CI. A shell anywhere on the way would run the `$(...)` and the backtick
  // in the directory's name, and leave a PWNED file.
  // CreateProcess reads no `#!`, so Windows cannot start this stand-in; the win32 launch is proven by
  // the argv tests above and by the manual check reported with the Windows paths lot.
  it.skipIf(process.platform === 'win32')('starts the program itself, in the directory, the directory one argument, and runs nothing it names', async () => {
    const { nodeLaunch, nodeExecFile } = await import('../../../electron/utils/open-terminal');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'qa177-bin-'));
    const log = path.join(bin, 'argv.json');
    fs.writeFileSync(path.join(bin, 'gnome-terminal'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
      { mode: 0o755 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "qa177 'q' $(touch PWNED) `touch PWNED` "));
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      const r = await openTerminal(target, { platform: 'linux', launch: nodeLaunch, execFile: nodeExecFile });
      expect(r).toEqual({ success: true, terminal: 'gnome-terminal' });
      for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise(res => setTimeout(res, 50));
      const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
      expect(seen.argv).toEqual([`--working-directory=${target}`]);
      expect(seen.cwd).toBe(fs.realpathSync(target));
      for (const where of [target, bin, process.cwd(), os.tmpdir()]) {
        expect(fs.existsSync(path.join(where, 'PWNED')), `PWNED in ${where}`).toBe(false);
      }
    } finally {
      process.env.PATH = saved;
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});
