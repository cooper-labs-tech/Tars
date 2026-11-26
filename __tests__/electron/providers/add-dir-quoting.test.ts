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
 * backtick still expand. DATA_DIR is `~/.tars`, so the home folder's own
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
 * each argument it was given followed by a NUL. codex's line starts it through
 * `env CODEX_HOME=<Tars's codex home>` on macOS and Linux (the Audit's L4 on
 * #465), which runs no shell function: there the stand-in is a script on the
 * PATH, which prints the CODEX_HOME it was handed first, a folder under the
 * home too. What the CLI would have
 * received is compared with what it should have received: the same command
 * built for a home with a plain name, whose argv is right by construction,
 * with that plain home replaced by the hostile one in every argument.
 */

let root: string;
let home: string;

// Hermes builds its line only for an agent on an inference endpoint (providers/hermes-provider.ts): one, for it
// alone. Every other provider reads no endpoint here, as before.
vi.mock('../../../electron/services/traces-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  endpointLaunchForAgent: (agentId: string | undefined, harness: string) => (harness === 'hermes' && agentId
    ? { args: [], env: {}, tokenVars: [], profile: { baseUrl: 'http://127.0.0.1:31417/v1', model: 'open-coder-1' } }
    : null),
}));

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
  const env = { ...process.env, PATH: `${standInOnPath()}:${process.env.PATH ?? ''}` };
  delete env.CODEX_HOME;
  return execFileSync('sh', ['-c', PRINT_ARGV + script], { encoding: 'utf-8', cwd: root, env });
}

/** The stand-in as a program on the PATH, for a line that starts it through `env`: the CODEX_HOME it got, then its argv. */
function standInOnPath(): string {
  const bin = path.join(root, 'stand-in-bin');
  if (!fs.existsSync(path.join(bin, 'tars_argv'))) {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'tars_argv'), '#!/bin/sh\n[ -n "${CODEX_HOME+x}" ] && printf \'CODEX_HOME=%s\\0\' "$CODEX_HOME"\nfor a in "$@"; do printf \'%s\\0\' "$a"; done\n', { mode: 0o755 });
  }
  return bin;
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
  // The agent, for the CLIs that start in a home of their own per agent (Hermes).
  const agentId = 'agent-1';
  const secondaryProjectPath = path.join(homeDir, 'second project');
  const vault = path.join(homeDir, "JeanBrasse's vault");
  const mcpConfigPath = path.join(homeDir, 'mcp.json');
  const systemPromptFile = path.join(homeDir, 'instructions.md');
  for (const dir of [secondaryProjectPath, vault]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(mcpConfigPath, '{}');
  fs.writeFileSync(systemPromptFile, 'be brief');
  return {
    agentId,
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
    const plainDataDir = path.join(plainHome, '.tars');

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
});
