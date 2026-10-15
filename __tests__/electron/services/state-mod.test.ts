/**
 * The state mod (mods/tars-state/, electron/services/state-mod.ts): Claude
 * Code reports an agent's state to Tars from inside the CLI, in place of the
 * four shell hooks' status posts and of #283's caffeinate rule (JeanBrasse's go of
 * 2026-10-05, ETUDE-MODS-CLAUDE-CODE.md step 1).
 *
 * Measured on claude 2.1.289 (mods-study/, 2026-10-04 and 05): a module loaded
 * through CLAUDE_CODE_PLUGIN_DIRS sees `classic.SessionStart`,
 * `classic.UserPromptSubmit` and `classic.Stop` with the shell hooks' own
 * inputs, and the shell hooks still run when it calls `next`.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. The mod is loaded into a claude that predates the measured API, or into
 *    a CLI that is not claude, or a version Tars cannot read is taken as new
 *    enough: the API is early access, and an old engine could refuse the
 *    plugin or read it otherwise.
 * 2. A CLAUDE_CODE_PLUGIN_DIRS the user set is replaced rather than extended.
 * 3. The folder does not exist (a build without it) and is handed anyway.
 * 4. A session is taken for a mod session when its registration came from
 *    the shell hook, or after another session took the agent: the shell
 *    hooks would then be ignored with nothing to replace them.
 * 5. A heartbeat is kept for a session that is not the mod's, or read for
 *    another agent.
 * 6. A launch reads the version of another claude than the one it runs: the
 *    one Settings names comes first, then the launch's PATH, and a link is
 *    followed to the native installer's versions/<x.y.z>.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MOD_MIN_CLAUDE, stateModEnv, launchedClaudeVersion, versionAtLeast, noteModSession, modRunsSession, noteModBeat, modBeatFor, resetStateMod,
} from '../../../electron/services/state-mod';
import { cannotPlantPosixInstall } from '../../setup/posix-install-layout';

let dir: string;
beforeEach(() => {
  resetStateMod();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-state-mod-'));
});

describe('which launches get the mod', () => {
  it('1. compares versions as numbers, not strings', () => {
    expect(versionAtLeast('2.1.289', MOD_MIN_CLAUDE)).toBe(true);
    expect(versionAtLeast('2.1.300', '2.1.289')).toBe(true);
    expect(versionAtLeast('2.10.0', '2.9.999')).toBe(true);
    expect(versionAtLeast('2.1.288', '2.1.289')).toBe(false);
    expect(versionAtLeast('1.9.999', '2.1.289')).toBe(false);
    expect(versionAtLeast('2.1.289-beta', '2.1.289')).toBe(false);
    expect(versionAtLeast('', '2.1.289')).toBe(false);
  });

  it('1. a claude at the measured version or newer gets the folder and the switch', () => {
    expect(stateModEnv({ binaryName: 'claude', version: '2.1.289', dir, base: {} })).toEqual({
      CLAUDE_CODE_PLUGIN_DIRS: dir,
      CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    });
  });

  it('1. an older claude, a version nobody could read, or another CLI gets nothing', () => {
    expect(stateModEnv({ binaryName: 'claude', version: '2.1.288', dir, base: {} })).toEqual({});
    expect(stateModEnv({ binaryName: 'claude', version: null, dir, base: {} })).toEqual({});
    expect(stateModEnv({ binaryName: 'codex', version: '2.1.289', dir, base: {} })).toEqual({});
  });

  it('2. extends the folders the user named, after theirs', () => {
    const env = stateModEnv({ binaryName: 'claude', version: '2.1.300', dir, base: { CLAUDE_CODE_PLUGIN_DIRS: '/Users/x/mods' } });
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`/Users/x/mods${path.delimiter}${dir}`);
  });

  it('3. hands nothing when the folder is not there', () => {
    expect(stateModEnv({ binaryName: 'claude', version: '2.1.300', dir: path.join(dir, 'gone'), base: {} })).toEqual({});
  });
});

describe('which sessions run the mod', () => {
  const S1 = '11111111-1111-4111-8111-111111111111';
  const S2 = '22222222-2222-4222-8222-222222222222';

  it('4. only the session the mod registered, for its own agent', () => {
    noteModSession('a1', S1, 1000);
    expect(modRunsSession('a1', S1)).toBe(true);
    expect(modRunsSession('a1', S2)).toBe(false);
    expect(modRunsSession('a2', S1)).toBe(false);
    expect(modRunsSession('a1', undefined)).toBe(false);
  });

  it('4. a new session of the same agent replaces the old one', () => {
    noteModSession('a1', S1, 1000);
    noteModSession('a1', S2, 2000);
    expect(modRunsSession('a1', S1)).toBe(false);
    expect(modRunsSession('a1', S2)).toBe(true);
  });

  it('5. a heartbeat is kept for the mod session only, and read for its agent only', () => {
    noteModSession('a1', S1, 1000);
    expect(noteModBeat('a1', S2, 'Bash', 5000)).toBe(false);
    expect(noteModBeat('a2', S1, 'Bash', 5000)).toBe(false);
    expect(modBeatFor('a1')).toEqual({ sessionId: S1, at: 1000, tool: null });
    expect(noteModBeat('a1', S1, 'mcp__claude-mgr-orchestrator__wait_for_agent', 6000)).toBe(true);
    expect(modBeatFor('a1')).toEqual({ sessionId: S1, at: 6000, tool: 'mcp__claude-mgr-orchestrator__wait_for_agent' });
    expect(modBeatFor('a2')).toBeUndefined();
  });
});

describe('the claude a launch runs (6)', () => {
  /**
   * A native install as the installer lays it out on macOS and Linux: ~/.local/share/claude/versions/<v>, linked from
   * bin/claude. Windows has no such link (posix-install-layout.ts): claude.exe is a copy there, read by
   * cli-updater-windows.ts and held by cli-updater-windows.test.ts.
   */
  function nativeInstall(version: string, name = 'claude'): string {
    const versions = path.join(dir, `share-${version}`, 'claude', 'versions');
    fs.mkdirSync(versions, { recursive: true });
    fs.writeFileSync(path.join(versions, version), '#!/bin/sh\n', { mode: 0o755 });
    const bin = path.join(dir, `bin-${version}`);
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(path.join(versions, version), path.join(bin, name));
    return bin;
  }

  it.skipIf(cannotPlantPosixInstall())('reads the version of the claude on the launch\'s PATH', () => {
    const bin = nativeInstall('2.1.300');
    expect(launchedClaudeVersion({ settingsPath: undefined, envPath: `/nowhere${path.delimiter}${bin}` })).toBe('2.1.300');
  });

  it.skipIf(cannotPlantPosixInstall())('reads the one Settings names before the one on PATH', () => {
    const old = nativeInstall('2.1.200');
    const named = path.join(nativeInstall('2.1.301'), 'claude');
    expect(launchedClaudeVersion({ settingsPath: named, envPath: old })).toBe('2.1.301');
  });

  it('is null when no claude is found, or when it is not an install whose version can be read', () => {
    expect(launchedClaudeVersion({ settingsPath: undefined, envPath: '/nowhere' })).toBeNull();
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(launchedClaudeVersion({ settingsPath: undefined, envPath: plain })).toBeNull();
  });
});

