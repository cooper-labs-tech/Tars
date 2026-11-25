import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { argvReached, writeArgvPrinter } from './argv-reached';

/**
 * Every effort level Tars stores reaches the claude binary, medium included,
 * from each of the fourteen providers that run it.
 *
 * Each of them carried its own copy of `params.effort !== 'medium'`, so medium
 * was the one level never passed. Without the flag Claude Code starts at the
 * effort it last saved for that model, from any terminal on the machine: on
 * 2.1.280 `/effort high` writes `modelSettings.<model>.effortLevel` into
 * ~/.claude/settings.json and a launch of that model without the flag comes up
 * at high. With it, every level comes up as passed (measured from the session
 * header, "Opus 5.5 with <level> effort", for low, medium, high, xhigh, max).
 *
 * Read the way the CLI reads it: the command runs through a real shell into a
 * binary that prints its argv (on Windows, which starts the CLI with no shell,
 * through Tars's own launch: argv-reached.ts).
 */

let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_BINARY_PROVIDERS = [
  'claude', 'custom-openai', 'deepseek', 'mimo', 'minimax', 'moonshot', 'nous-portal',
  'nvidia', 'ollama', 'ollama-cloud', 'openrouter', 'qwen', 'venice', 'zhipu',
];

function argvOf(command: string): string[] {
  return argvReached(command, tmpDir);
}

/** The values given to one option, as `--flag value` or `--flag=value`. */
function valuesOf(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break;
    if (argv[i] === flag) out.push(argv[i + 1]);
    else if (argv[i].startsWith(`${flag}=`)) out.push(argv[i].slice(flag.length + 1));
  }
  return out;
}

async function provider(id: string) {
  const { getAllProviders } = await import('../../../electron/providers');
  const found = getAllProviders().find(p => p.id === id);
  expect(found, `${id} is not a provider any more`).toBeDefined();
  expect(found!.binaryName).toBe('claude');
  return found!;
}

function params(effort: string | undefined) {
  const binaryPath = writeArgvPrinter(path.join(tmpDir, 'claude-argv'));
  return { binaryPath, prompt: 'Say hi', model: 'claude-opus-5-5', permissionMode: 'bypass' as const, effort: effort as never };
}

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-flag-'));
  fs.mkdirSync(path.join(tmpDir, '.tars'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the effort the agent is set to reaches the CLI', () => {
  it('covers every provider that runs the claude binary', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    expect(getAllProviders().filter(p => p.binaryName === 'claude').map(p => p.id).sort())
      .toEqual([...CLAUDE_BINARY_PROVIDERS].sort());
  });

  for (const id of CLAUDE_BINARY_PROVIDERS) {
    it.each(LEVELS)(`${id} passes %s`, async (level) => {
      const argv = argvOf((await provider(id)).buildInteractiveCommand(params(level)));
      expect(valuesOf(argv, '--effort')).toEqual([level]);
    });

    it(`${id} passes no effort when the agent has none`, async () => {
      const argv = argvOf((await provider(id)).buildInteractiveCommand(params(undefined)));
      expect(valuesOf(argv, '--effort')).toEqual([]);
    });
  }

  it('refuses a value that is not a level, rather than typing it into a shell', async () => {
    const argv = argvOf((await provider('claude')).buildInteractiveCommand(params('max; touch owned')));
    expect(valuesOf(argv, '--effort')).toEqual([]);
    expect(fs.existsSync(path.join(process.cwd(), 'owned'))).toBe(false);
  });
});
