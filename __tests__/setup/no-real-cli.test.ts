import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { realBinary, programOfLine, narrowRootsForTest, takeViolations } from './no-real-cli';

/**
 * No unit test reaches a real claude or tailscale (__tests__/setup/no-real-cli.ts, the Audit's I-3 on #616): a
 * setup file stands between the suite and child_process, and a test that starts either binary from anywhere but its
 * own temporary folders fails, the binary not started. secrets-shown-by-main.test.ts ran the owner's real `tailscale
 * status --json` through hermes:getConnectionInfo, and a call moved from execFile to spawn (#616) made
 * shared-files-atomic.test.ts start the real `claude mcp add`.
 *
 * How it fails, written before the guard:
 * G1. A test that starts the real claude, by its path or by its bare name on the PATH, is not stopped, and passes.
 * G2. The same for tailscale, its app bundle's `Tailscale` included.
 * G3. Over-correction: a stand-in named claude in the test's own temporary folder is refused, and the suites that
 *     plant one (mcp-registration-cli, cli-updater) break.
 * G4. A line for a shell (`exec('claude mcp list')`) goes around it.
 * G5. The product's own probe (core/cli-probe.ts, a spawn) goes around a guard on execFile alone, as the suite's
 *     mocks did (a guard on execFile alone turns this case red: measured).
 * G6. A claude that is not installed at all (nothing on the PATH by that name) reads as a real one.
 */

const files = (...present: string[]) => (p: string) => present.includes(p);

describe('which binary is a real one', () => {
  it('G1, G2. claude and tailscale outside the test\'s folders, by path or by name on the PATH', () => {
    const roots = ['/tmp/run'];
    expect(realBinary('/home/me/.local/bin/claude', undefined, roots, files('/home/me/.local/bin/claude'), 'linux')).toBe('/home/me/.local/bin/claude');
    expect(realBinary('claude', '/usr/bin:/home/me/.local/bin', roots, files('/home/me/.local/bin/claude'), 'linux')).toBe('/home/me/.local/bin/claude');
    expect(realBinary('tailscale', '/usr/local/bin', roots, files('/usr/local/bin/tailscale'), 'darwin')).toBe('/usr/local/bin/tailscale');
    const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(realBinary(app, undefined, roots, files(app), 'darwin')).toBe(app);
    expect(realBinary('claude', 'C:\\Users\\me\\AppData\\Roaming\\npm', roots, files('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'), 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('G3. a stand-in in the test\'s own folders, and any other binary, are not', () => {
    const roots = ['/tmp/run'];
    expect(realBinary('/tmp/run/stub/claude', undefined, roots, files('/tmp/run/stub/claude'), 'linux')).toBeNull();
    expect(realBinary('claude', '/tmp/run/bin:/home/me/.local/bin', roots, files('/tmp/run/bin/claude', '/home/me/.local/bin/claude'), 'linux')).toBeNull();
    expect(realBinary('/usr/bin/git', undefined, roots, files('/usr/bin/git'), 'linux')).toBeNull();
    expect(realBinary('/home/me/.local/bin/claude-stand-in', undefined, roots, files('/home/me/.local/bin/claude-stand-in'), 'linux')).toBeNull();
  });

  it('G4. the program of a line for a shell, quoted or not', () => {
    expect(programOfLine('claude mcp list')).toBe('claude');
    expect(programOfLine('"/a b/claude" --version 2>/dev/null')).toBe('/a b/claude');
    expect(programOfLine("  '/x/tailscale' status --json")).toBe('/x/tailscale');
  });

  it('G6. a claude installed nowhere on the PATH is not a real one', () => {
    expect(realBinary('claude', '/usr/bin:/bin', ['/tmp/run'], files(), 'linux')).toBeNull();
  });
});

describe('in the suite', () => {
  afterEach(() => { narrowRootsForTest(null); });

  it('G5. a real one is refused, not started, through child_process and through the product\'s probe', async () => {
    // A "real" claude: a stand-in, with the test's own folders taken off the allowed list for this case only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-no-real-cli-'));
    const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    const ran = path.join(dir, 'ran');
    fs.writeFileSync(bin, process.platform === 'win32' ? `@echo off\r\necho x> "${ran}"\r\n` : `#!/bin/sh\n: > '${ran}'\n`, { mode: 0o755 });
    try {
      narrowRootsForTest([]);
      expect(() => execFile(bin, ['--version'], () => {})).toThrow(/real claude/);
      const { probeCli } = await import('../../electron/core/cli-probe');
      await expect(probeCli(bin, ['--version'], { timeoutMs: 5_000 })).rejects.toThrow(/real claude/);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(fs.existsSync(ran), 'the binary ran').toBe(false);
      expect(takeViolations().map(v => v.binary)).toEqual([fs.realpathSync(bin), fs.realpathSync(bin)]);
    } finally {
      narrowRootsForTest(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
