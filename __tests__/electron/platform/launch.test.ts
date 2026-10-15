import { describe, it, expect } from 'vitest';

import { toLaunch, LaunchError, type DirectLaunch, type PosixLaunch } from '../../../electron/platform/launch';
import { PosixWordsError } from '../../../electron/platform/posix-words';
import type { FsProbe } from '../../../electron/platform/fs-probe';

/**
 * A provider's command, as the thing a PTY is spawned with.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. darwin/linux: the shape differs by one byte from what the call sites
 *    build today: agent-routes.ts:246 `cd '<dir>' && exec <cmd>` under
 *    `/bin/bash -l -c`, ipc-handlers.ts:844 and bot-core.ts:233 typing
 *    `cd '<dir>' && <cmd>`; a quote in the directory not escaped the same way.
 * 2. darwin/linux: the command is parsed, altered or refused (today any
 *    string passes), the env copied or changed, or the disk touched.
 * 3. win32: a shell, a `cd` or an `exec` remains anywhere: the CLI must be
 *    the process, started in cwd.
 * 4. win32: the binary is resolved against the parent's PATH instead of the
 *    env the child gets (the one with the user's CLI dirs).
 * 5. win32: an npm shim's node + script is not put in front of the CLI's
 *    own arguments.
 * 6. win32: the command line does not parse back to exactly the argv
 *    (prompt with newlines, ', ", %PATH%, &, backslashes).
 * 7. win32: the env still carries both Path and PATH (node-pty keeps both,
 *    Windows reads the first), or loses the value that was set last.
 * 8. win32: a command outside the grammar, a binary that cannot be
 *    resolved, or a line over the limit produces a launch instead of a
 *    typed LaunchError carrying its cause.
 * 9. win32: runsCommand is not true, so cliRunningIn cannot tell a CLI
 *    from a bare shell.
 */

// Today's call sites, copied as they stand at c349d7c1, as the reference.
const todayApi = (dir: string, cmd: string) => {
  const workingDir = dir.replace(/'/g, "'\\''"); // agent-routes.ts:206
  return { shell: '/bin/bash', args: ['-l', '-c', `cd '${workingDir}' && exec ${cmd}`] }; // :246, :248, :310
};
const todayTyped = (dir: string, cmd: string) => {
  const workingPath = dir.replace(/'/g, "'\\''"); // ipc-handlers.ts:843, bot-core.ts:241-243
  return `cd '${workingPath}' && ${cmd}`; // ipc-handlers.ts:844, bot-core.ts:233
};

const noFs: FsProbe = {
  isFile: () => { throw new Error('touched the disk'); },
  readFile: () => { throw new Error('touched the disk'); },
};

describe('darwin/linux: today\'s shape, to the byte', () => {
  const dirs = ['/Users/me/proj', "/Users/o'neil/my proj", '/tmp/a b/(x86)', "/''/"];
  const cmds = [
    "'/opt/homebrew/bin/claude' --model 'opus' -- 'hi'",
    "'claude' -p --dangerously-skip-permissions -- 'it'\\''s\nmulti'",
    // Outside the Windows grammar: passed through untouched here, as today.
    "'claude' ; echo odd && $(x)",
  ];
  it.each(['darwin', 'linux'] as const)('1, 2. on %s', (platform) => {
    for (const dir of dirs) {
      for (const cmd of cmds) {
        const env = { PATH: '/usr/bin', HOME: '/Users/me' };
        const launch = toLaunch(cmd, dir, env, platform, { fs: noFs }) as PosixLaunch;
        expect(launch.platform).toBe('posix');
        expect({ shell: launch.shell, args: launch.args }).toEqual(todayApi(dir, cmd));
        expect(launch.typedLine).toBe(todayTyped(dir, cmd));
        expect(launch.cwd).toBe(dir);
        expect(launch.env).toBe(env);
      }
    }
  });
});

const NPM = 'C:\\Users\\Sam Lee\\AppData\\Roaming\\npm';
const NODEJS = 'C:\\Program Files (x86)\\nodejs';
const CODEX_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

function fakeWinFs(files: Record<string, string>): FsProbe {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p) => map.has(p.toLowerCase()),
    readFile: (p) => {
      const v = map.get(p.toLowerCase());
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
  };
}
const disk = fakeWinFs({
  [`${NPM}\\codex.cmd`]: CODEX_SHIM,
  [`${NPM}\\codex`]: '#!/bin/sh\n',
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NODEJS}\\node.exe`]: 'MZ',
  'C:\\Users\\Sam Lee\\.local\\bin\\claude.exe': 'MZ',
});

const PROMPT = "line one, it's \"quoted\"\nline two: %PATH% & echo pwned\r\n'; Remove-Item x\\\n";
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

describe('win32: the CLI itself, no shell', () => {
  const cwd = 'C:\\Users\\Sam Lee\\proj (x86)\\it\'s';

  it('3, 5, 6, 9. an npm node shim: node.exe, the script, then the CLI\'s arguments', () => {
    const env = { Path: `${NPM};${NODEJS}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', OTHER: '1' };
    const launch = toLaunch(`'codex' --model 'gpt-5' --full-auto ${q(PROMPT)}`, cwd, env, 'win32', { fs: disk }) as DirectLaunch;

    expect(launch.platform).toBe('win32');
    expect(launch.file).toBe(`${NODEJS}\\node.exe`);
    expect(launch.argv).toEqual([`${NODEJS}\\node.exe`, `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`, '--model', 'gpt-5', '--full-auto', PROMPT]);
    expect(launch.commandLine).toBe(
      `"${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js" --model gpt-5 --full-auto "line one, it's \\"quoted\\"\nline two: %PATH% & echo pwned\r\n'; Remove-Item x\\\n"`,
    );
    expect(launch.cwd).toBe(cwd);
    expect(launch.runsCommand).toBe(true);
    expect(JSON.stringify(launch)).not.toMatch(/\bcd\b|\bexec\b|bash|powershell|cmd\.exe/i);
  });

  it('4. resolves against the env the child gets, not the parent\'s', () => {
    const before = process.env.PATH;
    process.env.PATH = NODEJS;
    try {
      const launch = toLaunch("'claude' --verbose", cwd, { PATH: 'C:\\Users\\Sam Lee\\.local\\bin' }, 'win32', { fs: disk }) as DirectLaunch;
      expect(launch.file).toBe('C:\\Users\\Sam Lee\\.local\\bin\\claude.exe');
      expect(launch.commandLine).toBe('--verbose');
    } finally {
      process.env.PATH = before;
    }
  });

  it('7. one PATH key in the env, holding the value set last', () => {
    const env = { Path: 'C:\\stale', PATH: `C:\\Users\\Sam Lee\\.local\\bin`, KEEP: 'x', UNSET: undefined };
    const launch = toLaunch("'claude'", cwd, env, 'win32', { fs: disk }) as DirectLaunch;
    expect(Object.keys(launch.env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(launch.env.Path).toBe('C:\\Users\\Sam Lee\\.local\\bin');
    expect(launch.env.KEEP).toBe('x');
    expect(launch.commandLine).toBe('');
    expect(env.Path).toBe('C:\\stale');
  });

  it('8. a command outside the grammar: LaunchError, cause the tokenizer\'s', () => {
    try { toLaunch("'claude' && calc", cwd, { Path: NODEJS }, 'win32', { fs: disk }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as LaunchError).code).toBe('command-grammar');
      expect((e as LaunchError).cause).toBeInstanceOf(PosixWordsError);
    }
  });

  it('8. a binary that does not resolve: LaunchError with the resolver\'s reason', () => {
    try { toLaunch("'gemini' -m 'x'", cwd, { Path: `${NPM};${NODEJS}` }, 'win32', { fs: disk }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as LaunchError).code).toBe('binary');
      expect((e as LaunchError).binary).toMatchObject({ ok: false, reason: 'not-found', name: 'gemini' });
    }
  });

  it('8. a line over the limit: LaunchError, not a truncated launch', () => {
    const huge = 'x'.repeat(40_000);
    try { toLaunch(`'claude' -- ${q(huge)}`, cwd, { Path: 'C:\\Users\\Sam Lee\\.local\\bin' }, 'win32', { fs: disk }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(LaunchError);
      expect((e as LaunchError).code).toBe('command-line');
    }
  });
});
