import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { skipOnWindows } from '../../setup/platform-limits';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
/** A folder this test says another user owns, as lstat would report it. */
const foreign = vi.hoisted(() => ({ path: '' }));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  const lstatSync = ((p: import('fs').PathLike, o?: unknown) => {
    const st = real.lstatSync(p, o as never) as import('fs').Stats;
    if (!foreign.path || String(p) !== foreign.path) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: (process.getuid?.() ?? 0) + 1 });
  }) as typeof real.lstatSync;
  return { ...real, lstatSync, default: { ...real, lstatSync } };
});
vi.setConfig({ testTimeout: 20_000 });
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));

import { writeProgrammaticInput } from '../../../electron/core/pty-manager';
import type { IPty } from 'node-pty';

/**
 * A task reaches the CLI as it was written, even with a tab in it (the Audit's
 * table on a3d7c125, item C).
 *
 * A launch from the window or from a chat types `cd '<dir>' && <cli> ... '<task>'`
 * into the agent's bash, at its prompt (writeProgrammaticInput, without a
 * paste). Readline reads what is typed as keys: a tab inside the quoted task
 * is the completion key, so the task was cut, or completed with file names,
 * or held on "Display all 40 possibilities? (y or n)", which ate the next
 * letters typed. macOS's /bin/bash is 3.2, whose readline knows no bracketed
 * paste to protect it; a newer bash on Linux completes a typed tab all the same.
 *
 * The bytes Tars writes are fed to a real interactive bash in a real terminal
 * (Python's pty module, on macOS and Linux alike), and the "CLI" is a script
 * that records the arguments it was given.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. A tab in the task: the CLI gets something other than the task, or never
 *    runs.
 * 2. A newline in the task: the same, or the rest runs as a second command.
 * 3. The task goes through a file, and the file is left behind, or readable by
 *    another user, or in a folder others can list.
 * 4. The line typed still carries the task, where a tab is still a key.
 * 5. Quotes, `$`, backticks and `!` in the task are read by the shell once
 *    more on the way.
 * 6. Over-correction: a command with no tab and no newline is no longer typed
 *    as it is, so the terminal stops showing what was launched.
 * 7. (the Audit's gate of #224) The folder is made once and reused whenever it
 *    exists: on a multi-user Linux whose /tmp is cleaned, another user can
 *    make a folder of that name, and swap the file Tars writes in it before
 *    the shell reads it (reproduced). Before each reuse, the folder must be a
 *    directory and not a link, owned by this user, and closed to others;
 *    otherwise a new one is made, and the one found is left untouched.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-task-bash-'));
const record = path.join(tmp, 'argv.json');
const cli = path.join(tmp, 'fake-cli');
const driver = path.join(tmp, 'drive.py');

beforeAll(() => {
  fs.writeFileSync(cli, `#!/bin/sh\nexec python3 -c 'import json,sys; json.dump(sys.argv[2:], open(sys.argv[1],"w"))' ${JSON.stringify(record)} "$@"\n`, { mode: 0o755 });
  // Runs an interactive bash in a terminal, types what it is given, waits for
  // the recorded arguments (or gives up), and exits.
  fs.writeFileSync(driver, [
    'import os, pty, sys, time',
    'typed = open(sys.argv[1], "rb").read()',
    'record = sys.argv[2]',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.execve("/bin/bash", ["bash", "--norc", "--noprofile", "-i"], {"PATH": "/usr/bin:/bin", "HOME": sys.argv[3], "TERM": "xterm", "PS1": "$ "})',
    'time.sleep(0.5)',
    'os.write(fd, typed)',
    'deadline = time.time() + 5',
    'while time.time() < deadline and not os.path.exists(record):',
    '    try:',
    '        os.read(fd, 65536)',
    '    except OSError:',
    '        break',
    '    time.sleep(0.05)',
    'time.sleep(0.2)',
    'os.kill(pid, 9)',
  ].join('\n'));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** What Tars writes into the terminal for this command, through the real writer. */
function typedFor(command: string): string {
  const writes: string[] = [];
  const pty = { write: (data: string) => { writes.push(data); } } as unknown as IPty;
  writeProgrammaticInput(pty, command);
  return writes.join('');
}

/** Launches the fake CLI with this task through a real bash, as a provider builds the command. */
function launch(task: string): { typed: string; argv: string[] | undefined } {
  fs.rmSync(record, { force: true });
  const quoted = `'${task.replace(/'/g, "'\\''")}'`;
  const typed = typedFor(`cd '${tmp}' && '${cli}' --model opus ${quoted}`);
  const input = path.join(tmp, 'typed.bin');
  fs.writeFileSync(input, typed);
  execFileSync('python3', [driver, input, record, tmp], { timeout: 15_000 });
  const argv = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf-8')) as string[] : undefined;
  return { typed, argv };
}

/**
 * Windows types no launch into a shell: the CLI replaces it (launchIntoTerminal,
 * startCliInTerminal), and python's pty and /bin/bash are not there to drive one.
 */
const NO_TYPED_LAUNCH = 'Windows types no launch into a shell, the CLI replaces it (startCliInTerminal); python pty and /bin/bash are absent';

describe.skipIf(skipOnWindows(NO_TYPED_LAUNCH))('a task typed into bash', () => {
  it('1, 4. arrives whole with a tab in it, and the line typed holds no tab', () => {
    const task = 'fix the table:\tname\tage\nthen ship';
    const { typed, argv } = launch(task);
    expect(argv, 'the CLI never ran').toEqual(['--model', 'opus', task]);
    expect(typed).not.toContain('\t');
    expect(typed).not.toContain('fix the table');
  });

  it('2. arrives whole with newlines in it', () => {
    const task = 'line one\nline two\n\nline four';
    expect(launch(task).argv).toEqual(['--model', 'opus', task]);
  });

  it('5. arrives literal with quotes, $, backticks and ! in it', () => {
    const task = "it's \"$HOME\" and `whoami` and !! and $(id)\tdone";
    expect(launch(task).argv).toEqual(['--model', 'opus', task]);
  });

  it('3. leaves no file behind, and wrote it where only its user reads', () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const { typed } = launch('a\ttask');
    const file = typed.match(/'([^']+)'/)?.[1];
    expect(file, typed).toBeDefined();
    expect(fs.existsSync(file!), 'the file is still there').toBe(false);
    const dir = path.dirname(file!);
    expect(fs.statSync(dir).mode & 0o077, 'others can list the folder').toBe(0);
    void before;
  });

  it('6. types a command with no tab and no newline as it is', () => {
    const command = "cd '/tmp' && claude --model opus 'plain task'";
    expect(typedFor(command)).toBe(`${command}\r`);
    expect(launch('a plain task, with "quotes"').argv).toEqual(['--model', 'opus', 'a plain task, with "quotes"']);
  });
});

describe.skipIf(skipOnWindows(NO_TYPED_LAUNCH))('the launch folder, before it is used again', () => {
  const folderOf = (typed: string) => path.dirname(typed.match(/'([^']+)'/)![1]);

  it.each([
    ['replaced by a link to a folder of someone else\'s', (dir: string) => {
      const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.symlinkSync(elsewhere, dir);
      return elsewhere;
    }],
    ['opened to others', (dir: string) => { fs.chmodSync(dir, 0o777); return dir; }],
    ['replaced by a file of this user\'s, closed to others', (dir: string) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.writeFileSync(dir, 'not a folder', { mode: 0o600 });
      return dir;
    }],
  ])('7. is not used when it was %s', (_what, tamper) => {
    const first = folderOf(typedFor("cd '/tmp' && cli 'a\tb'"));
    const watched = tamper(first);
    const look = () => (fs.statSync(watched).isDirectory() ? fs.readdirSync(watched) : fs.readFileSync(watched, 'utf-8'));
    const before = look();

    const second = folderOf(typedFor("cd '/tmp' && cli 'c\td'"));

    expect(second).not.toBe(first);
    expect(look()).toEqual(before);
    expect(fs.lstatSync(second).isDirectory()).toBe(true);
    expect(fs.statSync(second).mode & 0o077).toBe(0);
  });

  it('7. is not used when another user owns it', () => {
    const first = folderOf(typedFor("cd '/tmp' && cli 'a\tb'"));
    foreign.path = first;
    try {
      const second = folderOf(typedFor("cd '/tmp' && cli 'c\td'"));
      expect(second).not.toBe(first);
    } finally {
      foreign.path = '';
    }
  });

  it('7. is used again when it is still ours', () => {
    const first = folderOf(typedFor("cd '/tmp' && cli 'a\tb'"));
    expect(folderOf(typedFor("cd '/tmp' && cli 'c\td'"))).toBe(first);
  });
});
