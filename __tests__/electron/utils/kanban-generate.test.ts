import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CMD_SHIM_NODE, SH_SHIM, pinPlatform } from '../providers/win-fake-disk';

/**
 * Kanban "generate task": a one-shot `claude -p` that turns a request into a
 * task (audit A11, A24).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: the command line goes to cmd.exe (`exec`), where `'claude'` is
 *    no command and the prompt splits at its first newline, `&` chains a
 *    second command and %VAR% expands. The request and the project names are
 *    user text.
 * 2. The prompt does not reach the CLI as one argument, byte for byte: quotes,
 *    newlines, `$(...)`, backticks, `%PATH%`, `&`, `^`, `!` altered.
 * 3. darwin/linux: the line /bin/sh is handed is not the provider's command
 *    line as before, or the env is not `{ ...process.env, PATH: buildFullPath() }`.
 * 4. win32: claude.cmd (npm) is not found, or started through cmd.exe.
 * 5. A CLI that cannot be started is not said: the log must carry the
 *    resolver's reason, and the request still becomes a task (the fallback).
 * Since 27/11 the call is started by probeCli (core/cli-probe.ts), so that its
 * give-up and the quit end it with what it started (cli-probe-gaps.test.ts),
 * and with no shell on any system (the Audit's L2 on #661): the provider's
 * line read back into argv by posixWords, as on win32 already, in a group of
 * its own. Measured by the Audit: posixWords hands claude the same four
 * arguments as /bin/sh for quotes, $(...), backticks, &, |, ;, a line break,
 * a backslash, a `--model` in the request, and $HOME, " and ' in a project's
 * path, and no side effect runs.
 * 6. The shell comes back: the line goes through /bin/sh or exec, or a
 *    command in the request runs.
 */

let root: string;
let binDir: string;
let logFile: string;
let fakePath: string;
let savedLog: string | undefined;
let unpin: (() => void) | undefined;
const execCalls: string[] = [];
const execFileOptions: Array<Record<string, unknown>> = [];
const spawned: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
let captureExecFile: ((file: string, args: string[], opts: { env: Record<string, string> }) => string) | null = null;
let captureExec: ((cmd: string, opts: { env: Record<string, string> }) => string) | null = null;

vi.mock('../../../electron/utils/path-builder', () => ({ buildFullPath: () => fakePath }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ file, args, options });
      return actual.spawn(file, args, options);
    },
    exec: (...args: Parameters<typeof actual.exec>) => {
      execCalls.push(String(args[0]));
      if (captureExec) {
        const stdout = captureExec(String(args[0]), args[1] as unknown as { env: Record<string, string> });
        const cb = args[2] as unknown as (e: Error | null, out: string, err: string) => void;
        setImmediate(() => cb(null, stdout, ''));
        return undefined as never;
      }
      return actual.exec(...args);
    },
    execFile: (file: string, args: string[], opts: { env: Record<string, string> }, cb: (e: Error | null, out: string, err: string) => void) => {
      execFileOptions.push(opts);
      if (captureExecFile) {
        const stdout = captureExecFile(file, args, opts);
        setImmediate(() => cb(null, stdout, ''));
        return undefined as never;
      }
      return actual.execFile(file, args, opts, cb);
    },
  };
});

const TASK_JSON = JSON.stringify({ title: 'from the fake', description: 'd', projectPath: 'p', priority: 'high', labels: ['bug'], requiredSkills: [] });

function installFakeClaude() {
  const script = path.join(binDir, 'node_modules', 'fake-claude', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    'fs.appendFileSync(process.env.TARS_FAKE_CLI_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
    `process.stdout.write(${JSON.stringify(TASK_JSON)});`,
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), CMD_SHIM_NODE('node_modules\\fake-claude\\cli.js'));
    fs.writeFileSync(path.join(binDir, 'claude'), SH_SHIM);
  } else {
    fs.writeFileSync(path.join(binDir, 'claude'), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
}

const recorded = (): string[][] => (fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

async function generate(prompt: string, projects: Array<{ path: string; name: string }>) {
  const { generateTaskFromPrompt } = await import('../../../electron/utils/kanban-generate');
  return generateTaskFromPrompt(prompt, projects);
}

/** What a command in the request would make, were it ever run. */
const PWNED = path.join(os.tmpdir(), `tars-kanban-pwned-${process.pid}`);
const HOSTILE = `Fix it's "quoted" bug\nsecond line $(whoami) \`id\` %PATH% & echo pwned ^ !x! 'end`
  + ` | cat ; ls \\ back\\slash --model opus $(touch ${PWNED}) \`touch ${PWNED}\``;
const PROJECTS = [{ path: path.join('a b (x)', '$HOME', 'pro\'j "q"'), name: 'pro"ject\'s & %USERNAME%' }];

beforeEach(() => {
  vi.resetModules();
  execCalls.length = 0;
  execFileOptions.length = 0;
  spawned.length = 0;
  captureExecFile = null;
  captureExec = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-kanban-gen-'));
  binDir = path.join(root, 'npm (x86) dir');
  fs.mkdirSync(binDir, { recursive: true });
  logFile = path.join(root, 'argv.jsonl');
  fakePath = [binDir, path.dirname(process.execPath)].join(path.delimiter);
  savedLog = process.env.TARS_FAKE_CLI_LOG;
  process.env.TARS_FAKE_CLI_LOG = logFile;
});

afterEach(() => {
  unpin?.();
  unpin = undefined;
  if (savedLog === undefined) delete process.env.TARS_FAKE_CLI_LOG;
  else process.env.TARS_FAKE_CLI_LOG = savedLog;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generateTaskFromPrompt', () => {
  it('reaches the installed claude with the prompt as one argument, byte for byte, and no shell on win32', async () => {
    installFakeClaude();
    const task = await generate(HOSTILE, PROJECTS);

    const calls = recorded();
    expect(calls).toHaveLength(1);
    const [argv] = calls;
    expect(argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(argv).toHaveLength(4);
    expect(argv[3]).toContain(`User's request:\n${HOSTILE}\n`);
    expect(argv[3]).toContain(`- "${PROJECTS[0].name}" (${PROJECTS[0].path})`);
    expect(task.title).toBe('from the fake');
    expect(task.priority).toBe('high');
    // darwin/linux: through /bin/sh, as before, which reads the quoted line back to the same argv; started by probeCli,
    // never by exec, so that its group ends with its give-up and the quit.
    expect(execCalls).toHaveLength(0);
    expect(spawned).toHaveLength(1);
    // win32: and with no console window, Tars being a GUI program.
    if (process.platform === 'win32') expect(spawned[0].options).toMatchObject({ windowsHide: true });
  });

  it.skipIf(process.platform === 'win32')('6. darwin/linux: no shell: the provider\'s line read back into argv, the env { ...process.env, PATH }, in a group of its own, and nothing in the request runs', async () => {
    unpin = pinPlatform('darwin');
    installFakeClaude();
    const { getProvider } = await import('../../../electron/providers');
    const built = vi.spyOn(getProvider('claude'), 'buildOneShotCommand');

    const task = await generate(HOSTILE, PROJECTS);

    expect(built).toHaveBeenCalledTimes(1);
    expect(built.mock.calls[0][0]).toMatchObject({ binaryPath: 'claude', model: 'haiku' });
    expect(built.mock.calls[0][0].prompt).toContain(`User's request:\n${HOSTILE}\n`);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).not.toBe('/bin/sh');
    expect(path.basename(spawned[0].file)).toBe('claude');
    expect(spawned[0].args.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(spawned[0].args).toHaveLength(4);
    expect(spawned[0].args[3]).toBe(built.mock.calls[0][0].prompt);
    expect(spawned[0].options).toMatchObject({ env: { ...process.env, PATH: fakePath }, detached: true });
    expect(execCalls).toEqual([]);
    expect(fs.existsSync(PWNED), 'a command in the request ran').toBe(false);
    expect(task.title).toBe('from the fake');
  });

  it('win32: a claude that cannot be found is said, with the reason, and the request still becomes a task', async () => {
    unpin = pinPlatform('win32');
    fakePath = 'C:\\nowhere-tars-test';
    const said: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { said.push(a.map(String).join(' ')); });

    const task = await generate('Ship the thing\nthen tell me', PROJECTS);

    expect(said.join('\n')).toMatch(/claude.*not-found/);
    expect(task.title).toBe('Ship the thing');
    expect(task.description).toBe('Ship the thing\nthen tell me');
    expect(recorded()).toEqual([]);
    expect(execCalls).toEqual([]);
  });
});
