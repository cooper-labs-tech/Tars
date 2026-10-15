import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';

/**
 * The folders Tars hands a CLI (`--add-dir`, Gemini's `--include-directories`)
 * reach it as one argument each, whatever the home folder is called.
 *
 * Every provider wrote `--add-dir '${DATA_DIR}'` without escaping the quote,
 * and the scheduled builders `--add-dir "${DATA_DIR}"`, where `$` and a
 * backtick still expand. DATA_DIR is `~/.dorothy`, so the home folder's own
 * name went into the command line raw. What can go wrong, each checked below:
 *
 * 1. An apostrophe in the home (`/Users/o'neil`) closes the quote early: the
 *    rest of the line is parsed as shell, the quotes no longer pair up, and the
 *    command does not run at all.
 * 2. A home crafted to close the quote can add arguments of its own, such as a
 *    flag that turns off every permission prompt (`x' --dangerously-skip-permissions '`).
 * 3. A space must not split the folder into two arguments.
 * 4. `$` and a backtick must reach the CLI as characters, not be expanded or
 *    run, in the double-quoted scheduled builders as in the interactive one.
 * 5. A provider left out: every provider's command is checked, so one that
 *    still writes the folder raw fails here by name.
 * 6. The escape itself: an empty value, a value made only of quotes, and one
 *    with a line break stay one argument, unchanged.
 * 7. The scheduled builders of those providers write more than the data folder:
 *    the CLI's own path, its MCP config, the log, the project, the home and
 *    the task. Each of them sits under the home here, so each is covered, and
 *    the scheduled script runs whole, from `export HOME` to its last line.
 *
 * The oracle is a real POSIX shell (`sh`, from PATH): the command Tars built
 * runs in it against a stand-in for the CLI (a shell function, or a script
 * under the home for the builders that take a path to the CLI), which prints
 * each argument it was given followed by a NUL. What the CLI would have
 * received is compared with what it should have received: the same command
 * built for a home with a plain name, whose argv is right by construction,
 * with that plain home replaced by the hostile one in every argument.
 */

let root: string;
let home: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => home, default: { ...mod, homedir: () => home } };
});

/** What stands in for the CLI: prints its argv, one argument per NUL. */
const PRINT_ARGV = `tars_argv() { for a in "$@"; do printf '%s\\0' "$a"; done; }\n`;

/**
 * In the throwaway folder: a command whose quotes no longer pair up can turn a
 * `<` or `>` in the task into a redirection, and on the code before this fix
 * it did (`sh: skill-name: No such file or directory`).
 */
function run(script: string): string {
  return execFileSync('sh', ['-c', PRINT_ARGV + script], { encoding: 'utf-8', cwd: root });
}

/** What the shell said when it would not run a command. */
function refusal(err: unknown): string {
  const { stderr, message } = err as { stderr?: string; message: string };
  return (stderr?.trim() || message).split('\n')[0];
}

function argvOf(command: string): string[] {
  const out = run(command);
  return out.split('\0').slice(0, -1);
}

const HOSTILE = [
  "o'neil",
  'two words',
  'costs $HOME',
  'ran `echo pwned`',
  "x' --dangerously-skip-permissions '",
];

/** A home carrying every hostile character at once, and one with none. */
const HOSTILE_HOME_NAME = HOSTILE.join(' ');
const PLAIN_HOME_NAME = 'plainhome';

type Providers = typeof import('../../../electron/providers');

/** The providers module as loaded under `homeDir`: DATA_DIR is read at module load. */
async function providersUnder(homeDir: string): Promise<Providers> {
  home = homeDir;
  vi.resetModules();
  return import('../../../electron/providers');
}

/** Everything under the home an interactive command can name, created so the existsSync checks pass. */
function interactiveParams(homeDir: string) {
  const secondaryProjectPath = path.join(homeDir, 'second project');
  const vault = path.join(homeDir, "JeanBrasse's vault");
  const mcpConfigPath = path.join(homeDir, 'mcp.json');
  const systemPromptFile = path.join(homeDir, 'instructions.md');
  for (const dir of [secondaryProjectPath, vault]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mcpConfigPath, '{}');
  fs.writeFileSync(systemPromptFile, 'be brief');
  return {
    binaryPath: 'tars_argv',
    prompt: "Rebase onto main; don't stop at the first failure",
    model: 'some-model',
    verbose: true,
    permissionMode: 'auto' as const,
    effort: 'high' as const,
    secondaryProjectPath,
    obsidianVaultPaths: [vault],
    mcpConfigPath,
    systemPromptFile,
    skills: ['one', 'two'],
    orchestratorMode: true,
  };
}

/** A CLI under the home that prints its argv, one argument per NUL. */
function cliUnder(homeDir: string): string {
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, 'tars argv');
  fs.writeFileSync(cli, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n', { mode: 0o755 });
  return cli;
}

/** Every path a scheduled command names, under the home. */
function scheduledParams(homeDir: string) {
  return {
    binaryPath: cliUnder(homeDir),
    prompt: "Summarise the night; don't stop at the first failure",
    autonomous: true,
    mcpConfigPath: path.join(homeDir, 'mcp.json'),
    outputFormat: 'stream-json',
    verbose: true,
  };
}

/** Every path a scheduled script names, under the home, and the folders it cds and looks into. */
function scriptParams(homeDir: string) {
  const projectPath = path.join(homeDir, 'the project');
  fs.mkdirSync(projectPath, { recursive: true });
  const binaryPath = cliUnder(homeDir);
  return {
    binaryPath,
    binaryDir: path.dirname(binaryPath),
    projectPath,
    prompt: "Summarise the night; don't stop at the first failure",
    autonomous: true,
    mcpConfigPath: path.join(homeDir, 'mcp.json'),
    logPath: path.join(homeDir, 'task log.txt'),
    homeDir,
  };
}

/**
 * Runs a whole scheduled script and reads back what its CLI was given: the
 * script writes the CLI's output into its log, between its two banner lines.
 */
function argvOfScript(script: string, logPath: string): string[] {
  fs.rmSync(logPath, { force: true });
  run(script);
  const log = fs.readFileSync(logPath, 'utf-8');
  const started = log.indexOf('\n') + 1;
  const completed = log.lastIndexOf('=== Task completed');
  return log.slice(started, completed).split('\0').slice(0, -1);
}

let plainHome: string;
let hostileHome: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tars-add-dir-'));
  plainHome = path.join(root, PLAIN_HOME_NAME);
  hostileHome = path.join(root, HOSTILE_HOME_NAME);
  fs.mkdirSync(plainHome, { recursive: true });
  fs.mkdirSync(hostileHome, { recursive: true });
  // constants.ts reads the home at module load, the escape's module included.
  home = plainHome;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const intended = (plainArgv: string[]) => plainArgv.map(arg => arg.split(plainHome).join(hostileHome));

describe('the shared single-quote escape', () => {
  it.each([
    ...HOSTILE,
    '',
    "'",
    "''''",
    'line one\nline two',
    HOSTILE_HOME_NAME,
  ])('keeps %j one argument, unchanged', async (value) => {
    const { shellQuote } = await import('../../../electron/providers/cli-provider');
    expect(argvOf(`tars_argv ${shellQuote(value)}`)).toEqual([value]);
  });
});

describe('a home folder whose name the shell would read', () => {
  it('reaches every provider\'s interactive CLI as the folder it is', async () => {
    const plain = await providersUnder(plainHome);
    const plainArgv = new Map(plain.getAllProviders().map(p => [p.id, argvOf(p.buildInteractiveCommand(interactiveParams(plainHome)))]));
    const plainDataDir = path.join(plainHome, '.dorothy');

    const hostile = await providersUnder(hostileHome);
    const wrong: string[] = [];
    for (const provider of hostile.getAllProviders()) {
      let got: string[] | string;
      try {
        got = argvOf(provider.buildInteractiveCommand(interactiveParams(hostileHome)));
      } catch (err) {
        got = `the shell refused it: ${refusal(err)}`;
      }
      const want = intended(plainArgv.get(provider.id)!);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${provider.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }

    expect(wrong, 'these providers do not hand the CLI the folders Tars meant').toEqual([]);
    // Not vacuous: the data directory is on the command line of the fifteen
    // providers that add it, right after their own flag.
    const withDataDir = [...plainArgv.entries()].filter(([, argv]) => argv.includes(plainDataDir));
    expect(withDataDir.length).toBeGreaterThanOrEqual(15);
    for (const [id, argv] of withDataDir) {
      expect(argv[argv.indexOf(plainDataDir) - 1], id).toBe(plain.getProvider(id as never).getAddDirFlag());
    }
  }, 120_000);

  it('reaches every provider\'s scheduled command as the folder it is', async () => {
    const plain = await providersUnder(plainHome);
    const plainDataDir = path.join(plainHome, '.dorothy');
    // The providers that hand their scheduled CLI the data folder, the ones this covers.
    const plainArgv = new Map(plain.getAllProviders()
      .map(p => [p.id, argvOf(p.buildScheduledCommand(scheduledParams(plainHome)))] as const)
      .filter(([, argv]) => argv.includes(plainDataDir)));

    const hostile = await providersUnder(hostileHome);
    const wrong: string[] = [];
    for (const provider of hostile.getAllProviders()) {
      if (!plainArgv.has(provider.id)) continue;
      let got: string[] | string;
      try {
        got = argvOf(provider.buildScheduledCommand(scheduledParams(hostileHome)));
      } catch (err) {
        got = `the shell refused it: ${refusal(err)}`;
      }
      const want = intended(plainArgv.get(provider.id)!);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${provider.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }

    expect(wrong, 'these providers do not hand the scheduled CLI the folders Tars meant').toEqual([]);
    expect(plainArgv.size).toBeGreaterThanOrEqual(15);
  }, 120_000);

  it('reaches every provider\'s scheduled script as the folder it is', async () => {
    const plain = await providersUnder(plainHome);
    const plainDataDir = path.join(plainHome, '.dorothy');
    const plainArgv = new Map<string, string[]>();
    const wrong: string[] = [];
    for (const provider of plain.getAllProviders()) {
      const params = scriptParams(plainHome);
      const script = provider.buildScheduledScript(params);
      // The providers whose scheduled script hands the CLI the data folder, the ones this covers.
      if (!script.includes(plainDataDir)) continue;
      try {
        plainArgv.set(provider.id, argvOfScript(script, params.logPath));
      } catch (err) {
        // A plain home, and a task with an apostrophe as tasks have.
        wrong.push(`${provider.id}: the shell refused it even for a plain home: ${refusal(err)}`);
      }
    }

    const hostile = await providersUnder(hostileHome);
    for (const provider of hostile.getAllProviders()) {
      if (!plainArgv.has(provider.id)) continue;
      const params = scriptParams(hostileHome);
      let got: string[] | string;
      try {
        got = argvOfScript(provider.buildScheduledScript(params), params.logPath);
      } catch (err) {
        got = `the shell refused it: ${refusal(err)}`;
      }
      const want = intended(plainArgv.get(provider.id)!);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${provider.id}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }

    expect(wrong, 'these providers do not hand the scheduled script\'s CLI the folders Tars meant').toEqual([]);
    expect(plainArgv.size).toBeGreaterThanOrEqual(15);
  }, 120_000);
});
