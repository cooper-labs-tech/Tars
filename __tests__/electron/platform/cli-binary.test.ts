import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveCliBinary } from '../../../electron/platform/cli-binary';
import { realFs, type FsProbe } from '../../../electron/platform/fs-probe';

/**
 * Which file to start for a CLI name on win32, and with what in front of the
 * arguments.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. A bare name is looked up without PATHEXT, so `npx` (only npx.cmd
 *    exists) is not found, or only `.exe` is tried (libuv's rule).
 * 2. The extensionless sh shim npm writes beside every .cmd is returned: it
 *    is a POSIX script Windows cannot start. It must never come back on win32,
 *    as a PATH hit or as a configured cliPath.
 * 3. A .cmd is returned as the file to spawn: node refuses it since
 *    CVE-2024-27980 (EINVAL), and going through cmd.exe caps the line at 8191
 *    characters, splits on newlines and expands % ^ &.
 * 4. An npm node shim is not read through: the result must be node.exe plus
 *    the shim's own script, with node.exe the shim's sibling when present,
 *    else `node` found on the PATH (the shim's own rule).
 * 5. An npm shim that points at a native .exe (claude's current package) is
 *    turned into `node <exe>` instead of the exe itself.
 * 6. The PATHEXT order is not honoured (x.exe before x.cmd in the same
 *    directory under the default order), or PATHEXT is read case-sensitively.
 * 7. Names, directories and PATH keys are compared case-sensitively.
 * 8. A path with spaces or parentheses (C:\Program Files (x86)\...) is
 *    altered, split or trimmed; a quoted PATH entry is not unquoted.
 * 9. A relative PATH entry (`.`, `bin`) is searched: that is the current
 *    directory, a planting hole.
 * 10. A shim it does not understand (arbitrary batch, a cmd-shim running
 *    bash or python, extra arguments) is guessed at instead of a typed
 *    failure naming the reason.
 * 11. A shim whose target is missing, or a node shim with no node anywhere,
 *    reports success.
 * 12. An empty name, a name with a quote inside, or a relative path is
 *    accepted.
 * 13. darwin/linux: anything but the name as given, or a disk access.
 * 14. The real shim formats on this machine (npm's cmd-shim with a node
 *    target, with a native exe target, and Node's own npx.cmd) are not
 *    recognised.
 *
 * Added at review (2026-09-25), written before the fixes:
 * 15. The disk is asked about a relative path at all: Windows resolves it
 *    against the current directory, so a relative PATH entry (`.`, `bin`,
 *    `\dir`) finds a planted claude.exe. The fake disk below resolves
 *    relative paths against a fake cwd that holds one, and records the probe.
 * 16. A shim folder whose name holds `$&`, `$'` or `` $` `` resolves elsewhere:
 *    %dp0% replaced through a replacement string reads them as patterns.
 * 17. A shim whose variables reference themselves or each other blows up:
 *    60 lines of `SET "_prog=%_prog%"` gave 60^4 values (seconds of blocking,
 *    and a failure message joining them all). It must answer in under 50 ms
 *    with a bounded message; an oversized shim file is refused unread past a cap.
 * 18. A `:` beyond the drive letter reaches the disk: `claude:evil` (or a
 *    shim script `x:evil.js`) names an NTFS alternate data stream.
 */

// The three formats as npm 10 / Node 22 write them, copied from this machine
// (%APPDATA%\npm\codex.cmd, %APPDATA%\npm\claude.cmd, nvm\v22.23.3\npx.cmd).
const CMD_SHIM_NODE = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');
const CMD_SHIM_EXE = (exe: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  `"%dp0%\\${exe}"   %*`, '',
].join('\r\n');
const NODE_DIST_NPX = [
  ':: Created by npm, please don\'t edit manually.', '@ECHO OFF', '', 'SETLOCAL', '',
  'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')', '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ')', '',
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*', '',
].join('\r\n');
// cmd-shim before v5 (npm 6): the command sits inside IF / ELSE.
const OLD_CMD_SHIM = [
  '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\..\\lib\\old\\cli.js" %*', ') ELSE (',
  '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\..\\lib\\old\\cli.js" %*', ')',
].join('\r\n');
const SH_SHIM = '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec node "$basedir/node_modules/x/cli.js" "$@"\n';

const HOME = 'C:\\Users\\Sam Lee';
const NPM = `${HOME}\\AppData\\Roaming\\npm`;
const LOCAL = `${HOME}\\.local\\bin`;
const NODEJS = 'C:\\Program Files (x86)\\nodejs';

/** A Windows disk in memory: case-insensitive, backslash paths, contents readable. */
const FAKE_CWD = 'C:\\cwd-plant';
const isDriveOrUnc = (p: string) => /^([a-z]:\\|\\\\)/i.test(p);

/**
 * A Windows disk in memory: case-insensitive, backslash paths, contents
 * readable. A relative path resolves against FAKE_CWD, as Windows would
 * against the current directory, and is recorded.
 */
function fakeWinFs(files: Record<string, string>): FsProbe & { reads: string[]; relativeProbes: string[] } {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const reads: string[] = [];
  const relativeProbes: string[] = [];
  const onDisk = (p: string) => {
    if (isDriveOrUnc(p)) return p;
    relativeProbes.push(p);
    return path.win32.resolve(FAKE_CWD, p);
  };
  return {
    reads,
    relativeProbes,
    isFile: (p) => map.has(onDisk(p).toLowerCase()),
    readFile: (p) => {
      reads.push(p);
      const v = map.get(onDisk(p).toLowerCase());
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
  };
}

const DISK: Record<string, string> = {
  [`${LOCAL}\\claude.exe`]: 'MZ',
  [`${NPM}\\claude`]: SH_SHIM,
  [`${NPM}\\claude.cmd`]: CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
  [`${NPM}\\claude.ps1`]: '# ps shim',
  [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`]: 'MZ',
  [`${NPM}\\codex`]: SH_SHIM,
  [`${NPM}\\codex.cmd`]: CMD_SHIM_NODE('node_modules\\@openai\\codex\\bin\\codex.js'),
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NODEJS}\\node.exe`]: 'MZ',
  [`${NODEJS}\\npx.cmd`]: NODE_DIST_NPX,
  [`${NODEJS}\\npx`]: SH_SHIM,
  [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`]: '',
  [`${NODEJS}\\node_modules\\npm\\bin\\npm-prefix.js`]: '',
  'C:\\both\\tool.exe': 'MZ',
  'C:\\both\\tool.cmd': CMD_SHIM_EXE('real.exe'),
  'C:\\both\\real.exe': 'MZ',
  'C:\\sh-only\\tool': SH_SHIM,
  'C:\\old\\bin\\oldtool.cmd': OLD_CMD_SHIM,
  'C:\\old\\lib\\old\\cli.js': '',
  'C:\\weird\\py.cmd': '@echo off\r\npython "%~dp0\\x.py" %*\r\n',
  'C:\\weird\\bashy.cmd': CMD_SHIM_NODE('x.sh').replace(/_prog=%dp0%\\node\.exe/, '_prog=%dp0%\\bash.exe').replace('"_prog=node"', '"_prog=bash"'),
  'C:\\weird\\x.sh': '',
  'C:\\weird\\extra.cmd': '@"%~dp0\\node.exe" --inspect "%~dp0\\x.js" %*\r\n',
  'C:\\weird\\x.js': '',
  'C:\\weird\\gone.cmd': CMD_SHIM_NODE('node_modules\\gone\\cli.js'),
  'C:\\weird\\tool.ps1': '',
  'C:\\sibling\\node.exe': 'MZ',
  'C:\\sibling\\sib.cmd': CMD_SHIM_NODE('node_modules\\sib\\cli.js'),
  'C:\\sibling\\node_modules\\sib\\cli.js': '',
  'C:\\cwd-plant\\claude.exe': 'MZ',
};

const env = (pathValue: string, extra: Record<string, string> = {}) => ({ Path: pathValue, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC', ...extra });

describe('win32: bare names on the PATH', () => {
  const disk = fakeWinFs(DISK);

  it('native claude.exe in .local\\bin, first on the PATH', () => {
    expect(resolveCliBinary('claude', env(`${LOCAL};${NPM};${NODEJS}`), 'win32', disk))
      .toEqual({ ok: true, file: `${LOCAL}\\claude.exe`, prefixArgs: [], via: 'exe' });
  });

  it('2, 5. npm dir first: claude.cmd read through to the native exe, the sh shim beside it never returned', () => {
    expect(resolveCliBinary('claude', env(`${NPM};${LOCAL}`), 'win32', disk)).toEqual({
      ok: true, file: `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, prefixArgs: [], via: 'npm-shim-exe',
    });
  });

  it('1, 3, 4, 8. codex.cmd becomes node.exe (found on the PATH, parentheses intact) plus codex.js', () => {
    expect(resolveCliBinary('codex', env(`${NPM};${NODEJS}`), 'win32', disk)).toEqual({
      ok: true, file: `${NODEJS}\\node.exe`, prefixArgs: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`], via: 'npm-shim-node',
    });
  });

  it('4. the shim\'s sibling node.exe wins over the one on the PATH', () => {
    expect(resolveCliBinary('sib', env(`C:\\sibling;${NODEJS}`), 'win32', disk)).toEqual({
      ok: true, file: 'C:\\sibling\\node.exe', prefixArgs: ['C:\\sibling\\node_modules\\sib\\cli.js'], via: 'npm-shim-node',
    });
  });

  it('14. Node\'s own npx.cmd: node.exe beside it and its bundled npx-cli.js', () => {
    expect(resolveCliBinary('npx', env(NODEJS), 'win32', disk)).toEqual({
      ok: true, file: `${NODEJS}\\node.exe`, prefixArgs: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`], via: 'npm-shim-node',
    });
  });

  it('14. cmd-shim before v5, command inside IF / ELSE, with a .. in the script path', () => {
    expect(resolveCliBinary('oldtool', env(`C:\\old\\bin;${NODEJS}`), 'win32', disk)).toEqual({
      ok: true, file: `${NODEJS}\\node.exe`, prefixArgs: ['C:\\old\\lib\\old\\cli.js'], via: 'npm-shim-node',
    });
  });

  it('6. PATHEXT order: .exe before .cmd by default, .cmd first when PATHEXT says so, read case-insensitively', () => {
    expect(resolveCliBinary('tool', env('C:\\both'), 'win32', disk)).toMatchObject({ ok: true, file: 'C:\\both\\tool.exe' });
    expect(resolveCliBinary('tool', env('C:\\both', { PATHEXT: '.cmd;.exe' }), 'win32', disk))
      .toMatchObject({ ok: true, file: 'C:\\both\\real.exe', via: 'npm-shim-exe' });
  });

  it('6. PATHEXT unset: .COM;.EXE;.BAT;.CMD', () => {
    expect(resolveCliBinary('npx', { Path: NODEJS }, 'win32', disk)).toMatchObject({ ok: true, via: 'npm-shim-node' });
  });

  it('7. names and PATH keys compared case-insensitively', () => {
    expect(resolveCliBinary('CLAUDE', { PATH: LOCAL.toUpperCase() }, 'win32', disk)).toMatchObject({ ok: true, via: 'exe' });
  });

  it('8. a quoted PATH entry is searched unquoted', () => {
    expect(resolveCliBinary('npx', env(`"${NODEJS}"`), 'win32', disk)).toMatchObject({ ok: true, file: `${NODEJS}\\node.exe` });
  });

  it('9, 15. relative PATH entries are not searched: the claude.exe planted in the cwd is never found or probed', () => {
    const probing = fakeWinFs(DISK);
    for (const entry of ['.', 'bin\\..', '\\cwd-plant', 'C:cwd-plant', '.\\']) {
      expect([entry, resolveCliBinary('claude', env(entry), 'win32', probing)]).toMatchObject([entry, { ok: false, reason: 'not-found' }]);
    }
    expect(probing.relativeProbes).toEqual([]);
  });

  it('2. only the sh shim anywhere: a typed failure naming it, never the file', () => {
    expect(resolveCliBinary('tool', env('C:\\sh-only'), 'win32', disk))
      .toMatchObject({ ok: false, reason: 'unsupported-extension', path: 'C:\\sh-only\\tool' });
  });

  it('not found anywhere', () => {
    expect(resolveCliBinary('nope', env(`${NPM};${NODEJS}`), 'win32', disk)).toMatchObject({ ok: false, reason: 'not-found', name: 'nope' });
  });
});

describe('win32: a configured path (cliPaths)', () => {
  const disk = fakeWinFs(DISK);

  it('2. the extensionless path npm users paste resolves to the .cmd beside it, then through it', () => {
    expect(resolveCliBinary(`${NPM}\\codex`, env(NODEJS), 'win32', disk)).toMatchObject({
      ok: true, file: `${NODEJS}\\node.exe`, prefixArgs: [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`],
    });
  });

  it('an explicit .exe, spaces and parentheses intact; surrounding quotes removed', () => {
    expect(resolveCliBinary(`${NODEJS}\\node.exe`, env(''), 'win32', disk)).toEqual({ ok: true, file: `${NODEJS}\\node.exe`, prefixArgs: [], via: 'exe' });
    expect(resolveCliBinary(`"${NODEJS}\\node.exe"`, env(''), 'win32', disk)).toMatchObject({ ok: true, file: `${NODEJS}\\node.exe` });
  });

  it('an explicit .cmd is read through', () => {
    expect(resolveCliBinary(`${NPM}\\claude.cmd`, env(''), 'win32', disk)).toMatchObject({ ok: true, via: 'npm-shim-exe' });
  });

  it('2. an explicit path to the sh shim alone is refused', () => {
    expect(resolveCliBinary('C:\\sh-only\\tool', env(''), 'win32', disk))
      .toMatchObject({ ok: false, reason: 'unsupported-extension', path: 'C:\\sh-only\\tool' });
  });

  it('an explicit .ps1 is refused, not run', () => {
    expect(resolveCliBinary('C:\\weird\\tool.ps1', env(''), 'win32', disk)).toMatchObject({ ok: false, reason: 'unsupported-extension' });
  });

  it('a missing explicit path is not-found', () => {
    expect(resolveCliBinary('C:\\nowhere\\claude.exe', env(''), 'win32', disk)).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('win32: typed failures, never a guess', () => {
  const disk = fakeWinFs(DISK);

  it.each([
    ['py.cmd', 'C:\\weird\\py.cmd', 'unrecognised-shim'],
    ['a cmd-shim running bash', 'C:\\weird\\bashy.cmd', 'unrecognised-shim'],
    ['extra arguments before the script', 'C:\\weird\\extra.cmd', 'unrecognised-shim'],
    ['a shim whose script is gone', 'C:\\weird\\gone.cmd', 'shim-target-missing'],
  ])('10, 11. %s', (_label, file, reason) => {
    const out = resolveCliBinary(file, env(NODEJS), 'win32', disk);
    expect(out).toMatchObject({ ok: false, reason, path: file });
    expect((out as { detail: string }).detail.length).toBeGreaterThan(10);
  });

  it('11. a node shim with no node.exe beside it and none on the PATH', () => {
    expect(resolveCliBinary('codex', env(NPM), 'win32', disk)).toMatchObject({ ok: false, reason: 'node-not-found' });
  });

  it.each(['', '   ', 'cl"aude', '.\\bin\\claude', 'bin/claude', 'a|b', 'a\0b'])('12. refuses the name %j', (name) => {
    expect(resolveCliBinary(name, env(NODEJS), 'win32', disk)).toMatchObject({ ok: false, reason: 'invalid-name' });
  });

  it.each(['claude:evil', 'claude.exe:evil', 'C:\\ads\\claude:evil', 'C:\\ads\\claude.exe:evil', 'C:\\ads:x\\claude.exe', 'C:', 'c:claude'])(
    '18. refuses a colon other than the drive letter\'s in %j, before any disk access',
    (name) => {
      const probing = fakeWinFs({ ...DISK, 'C:\\ads\\claude:evil.exe': 'MZ', 'C:\\ads\\claude.exe:evil': 'MZ', 'C:\\ads:x\\claude.exe': 'MZ' });
      let touched = 0;
      const counting: FsProbe = { isFile: (p) => { touched++; return probing.isFile(p); }, readFile: probing.readFile };
      expect(resolveCliBinary(name, env(`C:\\ads;${NODEJS}`), 'win32', counting)).toMatchObject({ ok: false, reason: 'invalid-name' });
      expect(touched).toBe(0);
    },
  );

  it('18. a drive colon and a UNC path are still fine', () => {
    expect(resolveCliBinary('C:\\both\\tool.exe', env(''), 'win32', disk)).toMatchObject({ ok: true });
    expect(resolveCliBinary('\\\\server\\share\\tool.exe', env(''), 'win32', fakeWinFs({ '\\\\server\\share\\tool.exe': 'MZ' })))
      .toMatchObject({ ok: true, file: '\\\\server\\share\\tool.exe' });
  });

  it('18. a PATH entry holding a stream colon is not searched', () => {
    const probing = fakeWinFs({ 'C:\\ads:x\\claude.exe': 'MZ' });
    expect(resolveCliBinary('claude', env('C:\\ads:x'), 'win32', probing)).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('18. a shim whose script names a stream is not read through', () => {
    const probing = fakeWinFs({
      'C:\\ads\\evil.cmd': CMD_SHIM_NODE('x:evil.js'),
      'C:\\ads\\x:evil.js': '',
      'C:\\ads\\node.exe': 'MZ',
    });
    expect(resolveCliBinary('C:\\ads\\evil.cmd', env(''), 'win32', probing)).toMatchObject({ ok: false, reason: 'unrecognised-shim' });
  });
});

describe('win32: shim folders with $ patterns in their name (16)', () => {
  it.each(['C:\\x$&y\\npm', "C:\\x$'y\\npm", 'C:\\x$`y\\npm', 'C:\\x$$y\\npm', 'C:\\x$1y\\npm'])('%s', (dir) => {
    const disk = fakeWinFs({
      [`${dir}\\q.cmd`]: CMD_SHIM_NODE('node_modules\\q\\cli.js'),
      [`${dir}\\node_modules\\q\\cli.js`]: '',
      [`${dir}\\node.exe`]: 'MZ',
      [`${dir}\\e.cmd`]: CMD_SHIM_EXE('node_modules\\e\\e.exe'),
      [`${dir}\\node_modules\\e\\e.exe`]: 'MZ',
    });
    expect(resolveCliBinary('q', env(dir), 'win32', disk)).toEqual({
      ok: true, file: `${dir}\\node.exe`, prefixArgs: [`${dir}\\node_modules\\q\\cli.js`], via: 'npm-shim-node',
    });
    expect(resolveCliBinary('e', env(dir), 'win32', disk)).toEqual({
      ok: true, file: `${dir}\\node_modules\\e\\e.exe`, prefixArgs: [], via: 'npm-shim-exe',
    });
  });
});

describe('win32: hostile shims are bounded (17)', () => {
  const invocation = 'endLocal & "%_prog%"  "%dp0%\\x.js" %*';
  const time = (fn: () => unknown) => { const t = performance.now(); const out = fn(); return { out, ms: performance.now() - t }; };
  const shimDisk = (text: string) => fakeWinFs({ 'C:\\h\\h.cmd': text, 'C:\\h\\x.js': '', 'C:\\h\\node.exe': 'MZ' });

  it.each([
    ['60 self-references', [...Array(60)].map(() => 'SET "_prog=%_prog%"').join('\r\n')],
    ['60 mutual references', [...Array(60)].map((_, i) => `SET "_prog=%v${i % 3}%"\r\nSET "v${i % 3}=%_prog%"`).join('\r\n')],
    ['400 distinct values', [...Array(400)].map((_, i) => `SET "_prog=C:\\n${i}\\node.exe"`).join('\r\n')],
    ['4 variables of 20 values chained', [...Array(20)].flatMap((_, i) => [
      `SET "_prog=%a%"`, `SET "a=%b${i}%"`, `SET "b${i}=%c%"`, `SET "c=C:\\n${i}\\node.exe"`,
    ]).join('\r\n')],
  ])('%s: answers in under 50 ms with a bounded message', (_label, sets) => {
    const disk = shimDisk(`@ECHO off\r\n${sets}\r\n${invocation}\r\n`);
    resolveCliBinary('C:\\h\\h.cmd', env(''), 'win32', disk); // warm the regexes
    const { out, ms } = time(() => resolveCliBinary('C:\\h\\h.cmd', env(''), 'win32', disk));
    expect(ms).toBeLessThan(50);
    if (!(out as { ok: boolean }).ok) expect((out as { detail: string }).detail.length).toBeLessThanOrEqual(600);
  });

  it('an oversized shim is refused without being parsed', () => {
    const big = `@ECHO off\r\n${'REM padding\r\n'.repeat(20_000)}"%dp0%\\x.exe" %*\r\n`;
    const disk = fakeWinFs({ 'C:\\h\\big.cmd': big, 'C:\\h\\x.exe': 'MZ' });
    const { out, ms } = time(() => resolveCliBinary('C:\\h\\big.cmd', env(''), 'win32', disk));
    expect(out).toMatchObject({ ok: false, reason: 'unrecognised-shim' });
    expect(ms).toBeLessThan(50);
    expect((out as { detail: string }).detail.length).toBeLessThanOrEqual(600);
  });

  it('a failure message stays bounded whatever the name', () => {
    const out = resolveCliBinary(`C:\\${'d'.repeat(5000)}\\claude.exe`, env(''), 'win32', fakeWinFs({}));
    expect(out).toMatchObject({ ok: false, reason: 'not-found' });
    expect((out as { detail: string }).detail.length).toBeLessThanOrEqual(600);
  });
});

describe('darwin/linux: the name as given', () => {
  const noFs: FsProbe = {
    isFile: () => { throw new Error('touched the disk'); },
    readFile: () => { throw new Error('touched the disk'); },
  };
  it.each(['darwin', 'linux'] as const)('13. %s', (platform) => {
    for (const name of ['claude', '/opt/homebrew/bin/claude', "/Users/o'neil/bin/codex", 'npx']) {
      expect(resolveCliBinary(name, { PATH: '/usr/bin' }, platform, noFs)).toEqual({ ok: true, file: name, prefixArgs: [], via: 'as-given' });
    }
  });
});

describe('win32 on a real disk', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  it.runIf(process.platform === 'win32')('8, 14. a Program Files (x86)-like folder with claude, claude.cmd and claude.exe', () => {
    // Inside the throwaway HOME that home-isolation.ts sets: on win32 os.tmpdir() is under the
    // account home, which its guard refuses, and os.homedir() reads USERPROFILE, which it does not move.
    const root = fs.mkdtempSync(path.join(process.env.HOME!, 'tars cli (x86) '));
    dirs.push(root);
    const npm = path.join(root, 'npm dir');
    fs.mkdirSync(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(npm, 'claude'), SH_SHIM);
    fs.writeFileSync(path.join(npm, 'claude.cmd'), CMD_SHIM_EXE('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
    fs.writeFileSync(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'MZ');
    fs.writeFileSync(path.join(npm, 'codex.cmd'), CMD_SHIM_NODE('node_modules\\codex\\codex.js'));
    fs.mkdirSync(path.join(npm, 'node_modules', 'codex'));
    fs.writeFileSync(path.join(npm, 'node_modules', 'codex', 'codex.js'), '');

    expect(resolveCliBinary('claude', env(npm), 'win32', realFs)).toEqual({
      ok: true, file: path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), prefixArgs: [], via: 'npm-shim-exe',
    });
    // node.exe from the PATH: the one running this test.
    expect(resolveCliBinary('codex', env(`${npm};${path.dirname(process.execPath)}`), 'win32', realFs)).toEqual({
      ok: true, file: process.execPath, prefixArgs: [path.join(npm, 'node_modules', 'codex', 'codex.js')], via: 'npm-shim-node',
    });
  });
});
