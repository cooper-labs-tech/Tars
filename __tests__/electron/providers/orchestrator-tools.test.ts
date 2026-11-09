import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { orchestratorToolFlags } from '../../../electron/providers/cli-provider';

/**
 * What an orchestrator is not allowed to do.
 *
 * Orchestrator mode exists so an agent delegates instead of doing the work
 * itself. The restriction lived in claude-provider.ts alone, next to thirteen
 * providers that run the same `claude` binary and applied none of it: an
 * orchestrator on DeepSeek, Venice or Ollama Cloud could edit files directly.
 *
 * `Task` is on the list because it spawns an ephemeral subagent, which looks
 * like delegating and is not: the work stays inside the orchestrator's own
 * session, never reaches the specialist agent, and cannot be seen or stopped
 * from Tars. An orchestrator asked for a security audit did exactly that.
 *
 * And the work itself (2.0.7, the owner's rule of 10/11: an orchestrator does no development, research,
 * investigation, QA or audit). Ways it fails:
 * - asked why something is broken, a fresh orchestrator read the code itself and delegated nothing (measured with
 *   claude 2.1.321 on main 58f2863b4, reports/orchestrator-role-runs): searching code (Grep, Glob) and the web
 *   (WebFetch, WebSearch) are the tools of that work, and stayed open;
 * - taking Read or Bash away would cut what is its own: reading its agents' reports, gh and git to merge.
 *
 * The last test is the one that matters over time: it reads the provider
 * directory, so a fourteenth provider added without the restriction fails
 * here rather than shipping.
 */

describe('the restriction itself', () => {
  it('is empty for an ordinary agent', () => {
    expect(orchestratorToolFlags(false)).toBe('');
    expect(orchestratorToolFlags(undefined)).toBe('');
  });

  it('blocks every file-mutating tool', () => {
    const flags = orchestratorToolFlags(true);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(flags).toContain(`"${tool}"`);
    }
  });

  it('names no tool claude does not have: every orchestrator start warned about MultiEdit', () => {
    // claude 2.1.268, 2.1.273 and 2.1.280: `Permission deny rule "MultiEdit"
    // matches no known tool - check for typos.` on stderr, at every start.
    expect(orchestratorToolFlags(true)).toBe(' --disallowed-tools "Edit" "Write" "NotebookEdit" "Task" "Grep" "Glob" "WebFetch" "WebSearch"');
    expect(orchestratorToolFlags(true)).not.toContain('MultiEdit');
  });

  it('blocks the built-in subagent tool', () => {
    expect(orchestratorToolFlags(true)).toContain('"Task"');
  });

  it('blocks searching the code and the web, the tools of an investigation or a research', () => {
    const flags = orchestratorToolFlags(true);
    for (const tool of ['Grep', 'Glob', 'WebFetch', 'WebSearch']) expect(flags).toContain(`"${tool}"`);
  });

  it('leaves Read and Bash alone: its agents\' reports, and gh and git to merge', () => {
    expect(orchestratorToolFlags(true)).not.toContain('"Bash"');
    expect(orchestratorToolFlags(true)).not.toContain('"Read"');
  });
});

describe('every provider that runs the claude binary applies it', () => {
  const dir = 'electron/providers';
  const repointed = fs.readdirSync(dir)
    .filter(f => f.endsWith('-provider.ts'))
    .filter(f => {
      const s = fs.readFileSync(path.join(dir, f), 'utf-8');
      return s.includes("binaryName = 'claude'") && s.includes('buildInteractiveCommand');
    });

  async function claudeBinaryProviders() {
    const { getAllProviders } = await import('../../../electron/providers');
    return getAllProviders().filter(p => p.binaryName === 'claude');
  }

  it('finds all of them', async () => {
    // Claude plus the ones that re-point the same binary at another vendor,
    // counted from the registry and from the directory, which must agree: a
    // provider file the registry forgot is one no launch reaches.
    const registered = await claudeBinaryProviders();
    expect(registered.length).toBeGreaterThanOrEqual(14);
    expect(registered.length).toBe(repointed.length);
  });

  // What the provider builds, rather than the line of source that builds it:
  // the test this replaces read each file for the text
  // `orchestratorToolFlags(params.orchestratorMode)`, and passed for a
  // provider that called it and then dropped the result.
  it('puts the block on the command line of an orchestrator, and only there', async () => {
    for (const provider of await claudeBinaryProviders()) {
      const params = { binaryPath: 'claude', prompt: 'Delegate the audit' };
      const orchestrator = provider.buildInteractiveCommand({ ...params, orchestratorMode: true });
      const worker = provider.buildInteractiveCommand({ ...params, orchestratorMode: false });

      expect(orchestrator, `${provider.id} launches an orchestrator with its editing tools`)
        .toContain(orchestratorToolFlags(true).trim());
      expect(worker, `${provider.id} takes a worker's editing tools away`).not.toContain('--disallowed-tools');
    }
  });

  it('nobody keeps a private copy of the list', () => {
    // Two copies drift. That is how thirteen providers ended up with none.
    for (const file of repointed) {
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(src.includes('--disallowed-tools'), `${file} spells the list out itself`).toBe(false);
    }
  });
});
