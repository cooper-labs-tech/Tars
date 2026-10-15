import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';
import { argvReached, writeArgvPrinter } from './argv-reached';

/**
 * The task has to reach the CLI as the CLI's own argument.
 *
 * `--add-dir` is variadic in Claude Code (`--add-dir <directories...>`), and
 * Tars writes it immediately before the positional prompt. The parser adds
 * every following argument to the directory list, so the task became a second
 * directory, the CLI started with no prompt, registered its session in about a
 * second, and Tars called it running. Measured by the Backend on six builds,
 * 2.1.241 through 2.1.268: never a regression, it has never worked. Across the
 * 119 transcripts still on disk, not one first turn carries the header
 * spawnAgentSession puts in every positional prompt.
 *
 * The test that should have caught it asserted `--mcp-config` was present and
 * never that the prompt was an operand, so it stayed green for three weeks
 * while every dispatch was lost. This file asserts the whole chain instead:
 * build the real command, run it through a real shell against a binary that
 * prints its argv, and read that argv the way the CLI reads it.
 *
 * The parser below is written here rather than taken from `commander` on
 * purpose, and that is a compromise worth knowing about: the only commander in
 * this repo is 5.1.0, pulled in by electron-builder, and it has no variadic
 * options at all. Measured: it hands `--add-dir DIR 'task'` back as
 * `addDir: "DIR"` with `task` still an operand, which is the opposite of what
 * the real binary does, so a mirror built on it would have passed while every
 * dispatch was lost. The rules encoded here are the ones the Backend measured
 * on the real builds, and two things keep them honest: the negative control at
 * the bottom of this file, which fails if this parser stops losing the prompt
 * the way the CLI does, and the opt-in test against the real binary
 * (TARS_REAL_CLAUDE=1) that checks the same command lines end to end.
 */

let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

/** A task as someone really writes one: it opens with a dash, quotes, and breaks a line. */
const HOSTILE = "-n don't stop at the first failure\nrun 'npm test' and say what fell";
/** A plain one, for the cases about swallowing: a dash-leading task is refused as an option instead. */
const PLAIN = 'Rebase onto main and say what fell';

/**
 * The options Tars can put on a claude command line, split the way the CLI
 * declares them. Variadic ones keep taking values until an option or `--`,
 * which is the whole of this bug.
 */
const VARIADIC = new Set(['--add-dir', '--mcp-config', '--disallowed-tools', '--allowed-tools', '--betas', '--file']);
const TAKES_VALUE = new Set(['--model', '--permission-mode', '--effort', '--append-system-prompt-file', '--resume', '--output-format']);
const BOOLEAN = new Set(['--verbose', '--dangerously-skip-permissions', '--chrome', '--strict-mcp-config', '-p', '--print']);

interface Parsed {
  /** What the CLI would treat as the prompt. */
  operands: string[];
  /** Values collected per option. */
  values: Record<string, string[]>;
  /** Anything dash-leading the CLI does not know, which it refuses rather than runs. */
  unknown: string[];
}

function parseLikeClaude(argv: string[]): Parsed {
  const operands: string[] = [];
  const values: Record<string, string[]> = {};
  const unknown: string[] = [];
  const keep = (flag: string, value: string) => { (values[flag] ??= []).push(value); };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('-')) { operands.push(token); continue; }

    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);

    if (VARIADIC.has(flag)) {
      if (inline !== undefined) { keep(flag, inline); continue; }
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) keep(flag, argv[++i]);
      continue;
    }
    if (TAKES_VALUE.has(flag)) {
      if (inline !== undefined) { keep(flag, inline); continue; }
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) keep(flag, argv[++i]);
      continue;
    }
    if (BOOLEAN.has(flag)) continue;
    unknown.push(flag);
  }

  return { operands, values, unknown };
}

/** A binary that does nothing but say what it was given. */
function fakeBinary(): string {
  return writeArgvPrinter(path.join(tmpDir, 'claude-argv'));
}

/**
 * The command line as a shell really splits it, not as a regex guesses it. On
 * Windows, which starts the CLI with no shell, as Tars's own launch splits it
 * and the binary reads it back (argv-reached.ts).
 */
function argvOf(command: string): string[] {
  return argvReached(command, tmpDir);
}

async function claudeBinaryProviders() {
  const { getAllProviders } = await import('../../../electron/providers');
  return getAllProviders().filter(p => p.binaryName === 'claude');
}

/** Everything a real dispatch carries, so no option that could close the list is missing by accident. */
function fullParams(prompt: string, withSkills: boolean) {
  const mcpConfigPath = path.join(tmpDir, 'mcp.json');
  const systemPromptFile = path.join(tmpDir, 'system-prompt.md');
  const secondaryProjectPath = path.join(tmpDir, 'second project');
  const vault = path.join(tmpDir, "JeanBrasse's vault");
  return {
    binaryPath: fakeBinary(),
    prompt,
    model: 'test-model-1',
    verbose: true,
    permissionMode: 'bypass' as const,
    effort: 'max' as const,
    secondaryProjectPath,
    obsidianVaultPaths: [vault],
    mcpConfigPath,
    systemPromptFile,
    skills: withSkills ? ['superpowers', 'web-design-guidelines'] : undefined,
    orchestratorMode: true,
    resumeSessionId: '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64',
  };
}

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-operand-'));
  // The builders gate several flags on the path existing, so a missing fixture
  // would silently drop the very options that make the list variadic.
  fs.writeFileSync(path.join(tmpDir, 'mcp.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'system-prompt.md'), '# system');
  fs.mkdirSync(path.join(tmpDir, 'second project'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "JeanBrasse's vault"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.dorothy'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the task reaches the CLI as its own argument', () => {
  it('covers every provider that runs the claude binary', async () => {
    // Fourteen of them, each with its own copy of buildInteractiveCommand.
    // A count here so a provider added without this file noticing shows up.
    const providers = await claudeBinaryProviders();
    expect(providers.length).toBe(14);
  });

  it.each([
    ['claude'], ['custom-openai'], ['deepseek'], ['mimo'], ['minimax'], ['moonshot'], ['nous-portal'],
    ['nvidia'], ['ollama'], ['ollama-cloud'], ['openrouter'], ['qwen'], ['venice'], ['zhipu'],
  ])('%s hands the task over as the prompt, not as one more directory', async (id) => {
    const providers = await claudeBinaryProviders();
    const provider = providers.find(p => p.id === id);
    expect(provider, `${id} is not a claude-binary provider any more`).toBeDefined();

    const params = fullParams(PLAIN, false);
    const argv = argvOf(provider!.buildInteractiveCommand(params));
    const parsed = parseLikeClaude(argv);

    // The requirement, stated the way the CLI states it: the task is the
    // positional argument, whole, and on its own.
    expect(parsed.operands).toEqual([PLAIN]);
    // And it did not end up somewhere that looks harmless and is not.
    for (const dir of parsed.values['--add-dir'] ?? []) expect(dir).not.toContain('say what fell');
    expect(parsed.unknown).toEqual([]);
  });

  it.each([
    ['claude'], ['custom-openai'], ['deepseek'], ['mimo'], ['minimax'], ['moonshot'], ['nous-portal'],
    ['nvidia'], ['ollama'], ['ollama-cloud'], ['openrouter'], ['qwen'], ['venice'], ['zhipu'],
  ])('%s keeps a hostile task intact: a leading dash, quotes and a newline', async (id) => {
    const providers = await claudeBinaryProviders();
    const provider = providers.find(p => p.id === id);

    const params = fullParams(HOSTILE, true);
    const argv = argvOf(provider!.buildInteractiveCommand(params));
    const parsed = parseLikeClaude(argv);

    // Skills are prepended by each provider in its own words, so the task is
    // the tail of the operand rather than the whole of it.
    expect(parsed.operands).toHaveLength(1);
    expect(parsed.operands[0].endsWith(HOSTILE)).toBe(true);
    // The bytes survived the shell: the apostrophes and the newline are still there.
    expect(parsed.operands[0]).toContain("run 'npm test'");
    expect(parsed.operands[0].split('\n')).toHaveLength(2);
    // A dash-leading task must never be read as an option the CLI refuses.
    expect(parsed.unknown).toEqual([]);
  });

  it('gives the orchestrator its forbidden tools without losing the task to that list either', async () => {
    // --disallowed-tools is variadic too, which is how the Slack path loses a
    // task even when --add-dir is not the last option.
    const providers = await claudeBinaryProviders();
    const claude = providers.find(p => p.id === 'claude')!;

    const argv = argvOf(claude.buildInteractiveCommand(fullParams(PLAIN, false)));
    const parsed = parseLikeClaude(argv);

    expect(parsed.values['--disallowed-tools']).toEqual(['Edit', 'Write', 'NotebookEdit', 'Task']);
    expect(parsed.operands).toEqual([PLAIN]);
  });
});

describe('the negative control: the line as it was, without the separator', () => {
  it('loses the task into --add-dir, which is what this whole file is about', async () => {
    // Without this, the parser above would only reflect its author's
    // assumptions: a mirror that never loses a prompt proves nothing about a
    // CLI that does. Stripping the separator puts the line back the way it was
    // before the fix, and the task has to disappear into the directory list.
    const providers = await claudeBinaryProviders();
    const claude = providers.find(p => p.id === 'claude')!;

    const command = claude.buildInteractiveCommand(fullParams(PLAIN, false));
    const withoutSeparator = command.replace(' -- ', ' ');
    const parsed = parseLikeClaude(argvOf(withoutSeparator));

    expect(parsed.operands).toEqual([]);
    expect(parsed.values['--add-dir']).toContain(PLAIN);
  });
});

/**
 * The same command lines against the real binary, when asked for.
 *
 * Skipped by default: it starts a CLI. `TARS_REAL_CLAUDE=1 npm test` runs it,
 * and it is the only check here that cannot be fooled by a mirror, which is
 * why the mirror above exists next to it rather than instead of it.
 */
const realClaude = process.env.TARS_REAL_CLAUDE === '1' ? describe : describe.skip;

realClaude('the real claude binary', () => {
  it('takes the prompt from the repaired line and refuses the line before it', async () => {
    const providers = await claudeBinaryProviders();
    const claude = providers.find(p => p.id === 'claude')!;
    const emptyMcp = path.join(tmpDir, 'empty-mcp.json');
    fs.writeFileSync(emptyMcp, '{"mcpServers":{}}');

    // -p keeps it to one non-interactive answer, and the empty MCP config
    // keeps it off the network for anything but the model call itself.
    const line = (extra: string) =>
      `claude -p --strict-mcp-config --mcp-config '${emptyMcp}' --add-dir '${tmpDir}'${extra} 'Reply with the single word PONG.'`;

    const before = execFileSync('/bin/bash', ['-c', `${line('')} 2>&1 || true`], { encoding: 'utf-8' });
    expect(before).toMatch(/Input must be provided/i);

    const after = execFileSync('/bin/bash', ['-c', `${line(' --')} 2>&1 || true`], { encoding: 'utf-8' });
    expect(after).not.toMatch(/Input must be provided/i);
    expect(claude.buildInteractiveCommand(fullParams(PLAIN, false))).toContain(' -- ');
    // The repaired line reaches the model, so this one takes seconds rather
    // than the default five. Without the timeout the run fails on the clock
    // instead of on the behaviour, which reads like the fix broke.
  }, 180_000);
});
