import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pinPlatform } from './win-fake-disk';

/**
 * isMcpServerRegistered, for every provider in the registry: does the MCP
 * entry a provider wrote start the server at this path? (Found at
 * win-reviewer's gate, 2026-09-25; ETHOS 4 and 8: one class, every provider.)
 *
 * How it fails, written before the code (2026-09-25):
 * 1. opencode, pi and amp look for the path inside JSON.stringify(entry),
 *    where every backslash is doubled: a Windows path never matches, and each
 *    bundled server is registered again at every launch.
 * 2. codex and grok write the path into TOML escaped, and look for it as
 *    given: the same, for a Windows path.
 * 3. A bundled server (`node <bundle.js>`, `npx tsx <server.ts>`) stops being
 *    recognised, on macOS as on Windows, or a server at another path is taken
 *    for it.
 */

let tmpDir: string;
let unpin: () => void;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

// No CLI ever runs: every provider writes its own config file (the fallback).
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
}));

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-mcp-registered-'));
  // The CLI's name as given, so the mock above is what answers.
  unpin = pinPlatform('linux');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  unpin();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function everyProvider() {
  const { getAllProviders } = await import('../../../electron/providers');
  return getAllProviders();
}

const CASES: Array<[string, string, string[], string]> = [
  ['a bundled server at a Windows path', 'node', ['C:\\Users\\x\\AppData\\Local\\Programs\\Tars\\resources\\mcp-memory\\dist\\bundle.js'], 'C:\\Users\\x\\AppData\\Local\\Programs\\Tars\\resources\\mcp-memory\\dist\\bundle.js'],
  ['a bundled server at a macOS path', 'node', ['/Applications/Tars.app/Contents/Resources/mcp-memory/dist/bundle.js'], '/Applications/Tars.app/Contents/Resources/mcp-memory/dist/bundle.js'],
  ['a TypeScript server through npx tsx', 'npx', ['tsx', '/work/tasmania/src/index.ts'], '/work/tasmania/src/index.ts'],
];

describe('isMcpServerRegistered knows what each provider wrote', () => {
  it.each(CASES)('%s', async (_label, command, args, serverPath) => {
    const providers = await everyProvider();
    expect(providers.length).toBeGreaterThanOrEqual(19);
    const missed: string[] = [];
    const confused: string[] = [];
    for (const provider of providers) {
      await provider.registerMcpServer('srv', command, args);
      if (!provider.isMcpServerRegistered('srv', serverPath)) missed.push(provider.id);
      if (provider.isMcpServerRegistered('srv', '/elsewhere/other.js')) confused.push(provider.id);
    }
    expect(missed, `not recognised by ${missed.join(', ')}`).toEqual([]);
    expect(confused, `taken for another path by ${confused.join(', ')}`).toEqual([]);
  });
});
