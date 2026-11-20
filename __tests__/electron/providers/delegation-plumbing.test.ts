import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { PiProvider } from '../../../electron/providers/pi-provider';
import { CodexProvider } from '../../../electron/providers/codex-provider';
import { GeminiProvider } from '../../../electron/providers/gemini-provider';
import { GrokProvider } from '../../../electron/providers/grok-provider';

/**
 * A delegated task reaches a CLI as params.prompt, and the agent's identity
 * reaches the orchestrator MCP as CLAUDE_AGENT_ID. Providers that dropped
 * either one turned delegation into a silent no-op.
 */

const PROMPT = 'Fix the scroll lock in TerminalGrid';

describe('delegated prompt reaches the CLI', () => {
  it.each([
    ['opencode', new OpenCodeProvider()],
    ['pi', new PiProvider()],
    ['codex', new CodexProvider()],
    ['gemini', new GeminiProvider()],
    ['grok', new GrokProvider()],
  ])('%s carries the prompt', (_name, provider) => {
    const command = provider.buildInteractiveCommand({
      binaryPath: '/usr/local/bin/cli',
      prompt: PROMPT,
    });
    expect(command).toContain(PROMPT);
  });
});

describe('agent identity reaches the orchestrator MCP', () => {
  it.each([
    ['opencode', new OpenCodeProvider()],
    ['pi', new PiProvider()],
    ['codex', new CodexProvider()],
    ['gemini', new GeminiProvider()],
    ['grok', new GrokProvider()],
  ])('%s exports CLAUDE_AGENT_ID and CLAUDE_PROJECT_PATH', (_name, provider) => {
    const env = provider.getPtyEnvVars('agent-42', '/Users/you/project', []);
    expect(env.CLAUDE_AGENT_ID).toBe('agent-42');
    expect(env.CLAUDE_PROJECT_PATH).toBe('/Users/you/project');
  });
});

describe('quoting survives an apostrophe in the task', () => {
  it.each([
    ['opencode', new OpenCodeProvider()],
    ['pi', new PiProvider()],
  ])('%s escapes it', (_name, provider) => {
    const command = provider.buildInteractiveCommand({
      binaryPath: '/usr/local/bin/cli',
      prompt: "don't break the quoting",
    });
    expect(command).toContain("don'\\''t break the quoting");
  });
});
