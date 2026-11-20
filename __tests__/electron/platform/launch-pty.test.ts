import '../../setup/home-guard';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { toLaunch, type DirectLaunch } from '../../../electron/platform/launch';
import { posixWords } from '../../../electron/platform/posix-words';

/**
 * The launch, for real: a provider's command through toLaunch() and a real
 * node-pty ConPTY on this machine, into a fake CLI installed the way npm
 * installs one (an npm cmd-shim in a folder with spaces and parentheses).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. node-pty cannot start the file (a .cmd, a bare name, /bin/bash).
 * 2. node-pty re-quotes the string and the CLI receives other arguments.
 * 3. The multi-line prompt with ', ", %PATH%, & arrives cut, expanded or
 *    split, or one of its lines runs as a command.
 * 4. The CLI starts in another directory than the agent's.
 * 5. The child's PATH is not the one Tars composed (Path vs PATH).
 *
 * win32 only: on darwin/linux toLaunch returns today's bash shape, which the
 * existing exec-into-cli and pty suites cover.
 */

const onWindows = process.platform === 'win32';
let root: string;
let npmDir: string;
let cwd: string;
let out: string;

beforeAll(() => {
  if (!onWindows) return;
  // Inside the throwaway HOME that home-isolation.ts sets: on win32 os.tmpdir() is under the
  // account home, which its guard refuses, and os.homedir() reads USERPROFILE, which it does not move.
  root = fs.mkdtempSync(path.join(process.env.HOME!, 'tars pty (x86) '));
  npmDir = path.join(root, 'npm dir');
  cwd = path.join(root, "the agent's project (x86)");
  out = path.join(root, 'argv.json');
  fs.mkdirSync(path.join(npmDir, 'node_modules', 'fake-cli'), { recursive: true });
  fs.mkdirSync(cwd);
  // npm's cmd-shim, as npm 10 writes it (see cli-binary.test.ts), and the sh
  // shim beside it that must never be picked.
  fs.writeFileSync(path.join(npmDir, 'fake-cli.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*', '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(npmDir, 'fake-cli'), '#!/bin/sh\nexit 99\n');
  fs.writeFileSync(path.join(npmDir, 'node_modules', 'fake-cli', 'cli.js'), [
    "const fs = require('fs');",
    'fs.writeFileSync(process.env.TARS_FAKE_OUT, JSON.stringify({',
    '  argv: process.argv.slice(2), cwd: process.cwd(),',
    "  path: Object.entries(process.env).filter(([k]) => k.toUpperCase() === 'PATH').map(([, v]) => v),",
    '}));',
  ].join('\n'));
});
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('toLaunch through a real ConPTY', () => {
  it.runIf(onWindows)('1-5. the fake CLI receives the exact argv and cwd', async () => {
    const { getProvider } = await import('../../../electron/providers');
    const prompt = [
      '# Identity',
      "You are Tars's agent; don't stop.",
      'Say "done" when %PATH% & %USERPROFILE% are printed: echo pwned & calc',
      "'; Remove-Item x; '",
      'C:\\trailing\\',
      'é 日本語',
    ].join('\n');
    const command = getProvider('claude').buildInteractiveCommand({
      binaryPath: 'fake-cli', prompt, model: 'opus', permissionMode: 'bypass', effort: 'high',
    });
    const childPath = `${npmDir};${path.dirname(process.execPath)};C:\\Windows\\System32`;
    // As the call sites build it, `{ ...process.env, PATH: fullPath }`, from
    // an Electron started by Explorer, whose env spells the key `Path`.
    const fromExplorer = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    const env = { ...fromExplorer, Path: 'C:\\stale', PATH: childPath, TARS_FAKE_OUT: out } as Record<string, string>;

    const launch = toLaunch(command, cwd, env, 'win32') as DirectLaunch;
    expect(launch.file).toBe(process.execPath);

    // node-pty runs in a plain node process, handed the launch as it is: in
    // this one, home-isolation.ts wraps fs.openSync for writing and resolves
    // the target first, which takes the ConPTY input pipe's only instance, so
    // node-pty's own open of it fails with EBUSY (a limit of the test
    // harness; Electron's main process has no such wrapper).
    const launchFile = path.join(root, 'launch.json');
    fs.writeFileSync(launchFile, JSON.stringify(launch));
    const driver = [
      `const pty = require(${JSON.stringify(createRequire(import.meta.url).resolve('node-pty'))});`,
      `const l = JSON.parse(require('fs').readFileSync(${JSON.stringify(launchFile)}, 'utf8'));`,
      "const t = pty.spawn(l.file, l.commandLine, { name: 'xterm-256color', cols: 120, rows: 40, cwd: l.cwd, env: l.env });",
      "let screen = ''; t.onData((d) => { screen += d; });",
      't.onExit((e) => { process.stdout.write(JSON.stringify({ exitCode: e.exitCode, screen })); process.exit(0); });',
    ].join('\n');
    const run = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
    expect(run.status, run.stderr).toBe(0);
    const { exitCode, screen } = JSON.parse(run.stdout) as { exitCode: number; screen: string };

    expect(exitCode, screen).toBe(0);
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(got.argv).toEqual(posixWords(command).slice(1));
    expect(got.argv.at(-1)).toBe(prompt);
    expect(got.cwd).toBe(cwd);
    expect(got.path).toEqual([childPath]);
  }, 30_000);
});
