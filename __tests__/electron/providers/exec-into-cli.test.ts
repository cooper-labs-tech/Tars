import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';
import { skipOnWindows } from '../../setup/platform-limits';

/**
 * Every provider's command can be exec'd: the CLI takes the shell's place.
 *
 * spawnAgentSession runs `cd <dir> && exec <command>` in the agent's terminal,
 * so that the CLI, not the shell, leads the terminal and is what node-pty
 * names (core/agent-pty.ts, cliRunningIn). That holds only while each provider
 * builds one simple command, its quoted binary and the binary's arguments. A
 * leading assignment would have exec look for a program named `VAR=x`; a `;`,
 * `&&` or `|` would put the exec on the first part only and leave a shell
 * running the rest.
 *
 * So each provider's real command, with every option Tars can set, is run
 * here through bash in that shape, against a binary that says who its parent
 * is. With the exec it is this process: no shell was left in between.
 */

let tmpDir: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

let fakeCli: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tars-exec-cli-'));
  fakeCli = path.join(tmpDir, 'fake cli');
  fs.writeFileSync(fakeCli, '#!/bin/bash\necho "PPID=$PPID"\n', { mode: 0o755 });
  // A user's own Cline provider, which a Cline launch copies into the agent's folder (providers/cline-provider.ts).
  fs.mkdirSync(path.join(tmpDir, 'cline-data', 'settings'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'cline-data', 'settings', 'providers.json'), '{"version":1,"providers":{}}');
  process.env.CLINE_DATA_DIR = path.join(tmpDir, 'cline-data');
});

afterAll(() => {
  delete process.env.CLINE_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function commandOf(providerId: string): Promise<string> {
  const { getProvider } = await import('../../../electron/providers');
  return getProvider(providerId as never).buildInteractiveCommand({
    binaryPath: fakeCli,
    // Cline runs on a folder of the agent's own.
    agentId: 'exec-into-cli-agent',
    prompt: "Rebase onto main, and say what fell; don't stop at the first failure",
    model: 'some-model',
    verbose: true,
    permissionMode: 'bypass',
    effort: 'high',
    secondaryProjectPath: tmpDir,
    obsidianVaultPaths: [tmpDir],
    mcpConfigPath: path.join(tmpDir, 'mcp.json'),
    systemPromptFile: path.join(tmpDir, 'instructions.md'),
    skills: ['one', 'two'],
    isSuperAgent: true,
    chrome: true,
    orchestratorMode: true,
  });
}

const parentOf = (shellCommand: string) => execFileSync('/bin/bash', ['-c', shellCommand], {
  encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: tmpDir },
}).trim();

/**
 * Windows starts no shell to exec from (decision D2): the command is read back
 * into words and the CLI started as the terminal's own process, so the CLI
 * leads it by construction. That launch is held by launch.test.ts and
 * launch-call-sites.test.ts, and every provider's command reaching its binary
 * that way by effort-flag.test.ts and prompt-operand.test.ts.
 */
const noShellToExecFrom = () => skipOnWindows('Windows starts the CLI with no shell to exec from (decision D2); '
  + 'the direct launch is held by launch.test.ts and launch-call-sites.test.ts, and these run on macOS, Linux and CI');

describe.skipIf(noShellToExecFrom())('the command spawnAgentSession execs', () => {
  it('replaces the shell for every provider', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    const kept: string[] = [];

    for (const provider of getAllProviders()) {
      const command = await commandOf(provider.id);
      const answer = parentOf(`cd '${tmpDir}' && exec ${command}`);
      if (answer !== `PPID=${process.pid}`) kept.push(`${provider.id}: ${answer} for ${command}`);
    }

    expect(kept, 'a shell stayed between Tars and the CLI').toEqual([]);
    expect(getAllProviders().length).toBeGreaterThan(10);
    // One real bash per provider: slow on a machine busy with other suites.
  }, 60_000);

  it('leaves the shell in between without the exec, which is what the check above would see', async () => {
    // macOS's /bin/bash (3.2), which Tars runs agents under, stays between
    // Tars and a command given without exec. A newer bash, as on a Linux CI
    // runner, execs the last command of a -c list by itself, so there it takes
    // a command after it to leave the shell in between.
    const keepShell = process.platform === 'darwin' ? '' : '; :';
    const answer = parentOf(`cd '${tmpDir}' && ${await commandOf('claude')}${keepShell}`);

    expect(answer).toMatch(/^PPID=\d+$/);
    expect(answer).not.toBe(`PPID=${process.pid}`);
  }, 60_000);
});
