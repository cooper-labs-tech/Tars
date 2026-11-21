import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { versionNumber } from '../../src/lib/cli-version';

/**
 * The version Settings prints for a CLI, out of whatever its `--version` answers (the QA's Low on #460: the list
 * read "codex codex-cli 0.163.0"). Settings prints the command, then this: `codex 0.163.0`.
 *
 * Written before src/lib/cli-version.ts. The ways it can fail:
 * 1. A version that names its CLI first (`codex-cli 0.163.0`) is printed whole after the command.
 * 2. A note after the version is read as part of it: `2.1.258 (Claude Code)`, and Amp's `(released ..., 1h ago)`,
 *    which made a column headed version read `1h ago`, then `2h ago`.
 * 3. An answer of several lines (a banner, then the version) is read whole, or the banner taken for the version.
 * 4. An answer with no version in it (`command not found`, an error, nothing) is read as one, and the CLI as ready.
 * 5. A name holding a digit or a dash before the number (`python3 3.12.1`, `gemini-cli v0.9.0`) is cut in the wrong
 *    place.
 * 6. A version written with its v (`v0.9.0`) loses the v or its number.
 * 7. A note in the middle of the line is cut: only a note at the very end is dropped, and only if a version is left.
 */

describe('the number alone (1, 5, 6)', () => {
  it('drops the name a CLI gives itself first', () => {
    expect(versionNumber('codex-cli 0.163.0')).toBe('0.163.0');
    expect(versionNumber('python3 3.12.1')).toBe('3.12.1');
    expect(versionNumber('gemini-cli v0.9.0')).toBe('v0.9.0');
  });
  it('keeps a plain number as it is, v included', () => {
    expect(versionNumber('0.5.0')).toBe('0.5.0');
    expect(versionNumber('v0.9.0')).toBe('v0.9.0');
  });
});

describe('no note at the end (2, 7)', () => {
  it("drops Claude Code's and Amp's notes", () => {
    expect(versionNumber('2.1.258 (Claude Code)')).toBe('2.1.258');
    expect(versionNumber('0.0.1788811227-gce258b (released 2026-09-07T20:00:27.000Z, 1h ago)')).toBe('0.0.1788811227-gce258b');
  });
  it('leaves a note in the middle of the line alone', () => {
    expect(versionNumber('opencode 1.2.3 (build 5) beta')).toBe('1.2.3 (build 5) beta');
  });
});

describe('the line that holds it (3, 4)', () => {
  it('reads the first line that holds a version, past a banner', () => {
    expect(versionNumber('Gemini CLI\n0.9.0\n')).toBe('0.9.0');
    expect(versionNumber('  qwen 0.0.14  \n(c) Qwen 1.0 licence')).toBe('0.0.14');
  });
  it('reads no version where there is none', () => {
    expect(versionNumber('zsh: command not found: codex')).toBeNull();
    expect(versionNumber('')).toBeNull();
    expect(versionNumber(undefined)).toBeNull();
  });
});
