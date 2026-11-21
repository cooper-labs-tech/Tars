import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CMD_SHIM_NODE } from '../services/cli-updater-windows-fakes';

/**
 * A version probe that has answered is not ended by its id on Windows.
 *
 * Upstream 1.9.3 ends a probe's group once it has answered (version-probe.ts,
 * its test 7), and the merge into the fork made that `taskkill /T` on win32.
 * But Node lets go of a process's handle once it has read its exit, and
 * Windows then hands the id out again, freed ids first: Settings probes a
 * dozen CLIs at once, so the id of one that answered can be another probe's,
 * or any process's, by the time its taskkill runs, and /T ends that one's
 * tree. acp/client.ts holds the same line (acp-exited-root.test.ts).
 *
 * How it fails, written before the code (2026-10-07):
 * 1. A probe that answered runs taskkill on its id.
 * 2. (the control) A probe cut by its timeout, still running, is no longer
 *    ended by taskkill on its id, and 1 proves nothing.
 */

/** Every taskkill the product ran, by its argv. */
const taskkills: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      if (/[\\/]taskkill\.exe$/i.test(file)) taskkills.push(rest[0] as string[]);
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
  };
});

import { probeVersion } from '../../../electron/core/version-probe';

/** A CLI as npm installs one on Windows: a node script behind its .cmd shim, which the probe reads through. */
function standIn(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-probe-win-'));
  fs.writeFileSync(path.join(dir, 'stand-in.js'), script);
  const bin = path.join(dir, 'stand-in.cmd');
  fs.writeFileSync(bin, CMD_SHIM_NODE('stand-in.js'));
  return bin;
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform !== 'win32')('a version probe, on Windows', { timeout: 30_000 }, () => {
  it('1. that answered is not ended by its id', async () => {
    const bin = standIn("console.log('amp 1.2.3');");
    taskkills.length = 0;

    await expect(probeVersion(bin, process.env)).resolves.toMatchObject({ stdout: 'amp 1.2.3\n' });
    await settle(500);

    expect(taskkills).toEqual([]);
  });

  it('2. (control) cut by its timeout, is ended by taskkill on its id, the tree with it', async () => {
    const bin = standIn("setTimeout(() => console.log('late'), 20000);");
    taskkills.length = 0;

    await expect(probeVersion(bin, process.env, 1000)).rejects.toThrow(/did not answer/);

    expect(taskkills).toHaveLength(1);
    expect(taskkills[0]).toEqual(['/PID', expect.stringMatching(/^\d+$/), '/T', '/F']);
  });
});
