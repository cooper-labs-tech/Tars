import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * The run token folders a run left behind, swept when Tars starts (the Audit's L1 on #458, 2.0.4).
 *
 * A delegated run's MCP servers read its token from a 0600 file in a 0700 folder of its own under the temporary folder
 * (acp/run-token-file.ts, written by acp/delegate.ts), removed in the run's `finally`. A run that never reached it,
 * or a Tars that crashed or was killed, left the folder; the token inside is dead (run tokens live in Tars's memory),
 * but nothing removed it.
 *
 * The ways it fails:
 * 1. A folder whose Tars is gone kept, or its token file with it.
 * 2. The folder of a run under way in another Tars on this machine (a sandbox, a second profile, an e2e) removed:
 *    its MCP servers, if they start late, read no token.
 * 3. A folder named after this very pid, which a Tars gone before left (pids come round again), kept.
 * 4. A folder from before folders named their Tars removed while it may still be in use: only once an hour old.
 * 5. Anything else in the temporary folder touched.
 */

import { sweepRunTokenFolders, RUN_TOKEN_FOLDER_PREFIX } from '../../../../electron/services/acp/run-token-file';

let tmp: string;
let live: ChildProcess | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sweep-'));
});
afterEach(() => {
  live?.kill();
  live = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const folder = (name: string, ageMs = 0) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'token'), 'run-token', { mode: 0o600 });
  if (ageMs) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, at, at);
  }
  return dir;
};
/** A pid no process has now: a child that has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

describe('the run token folders at start', () => {
  it("names the Tars that made it", () => {
    expect(RUN_TOKEN_FOLDER_PREFIX).toBe(`tars-run-${process.pid}-`);
  });

  it('1, 3. a folder whose Tars is gone, or named after this pid, goes with its token', () => {
    const gone = folder(`tars-run-${deadPid()}-a1B2c3`);
    const mine = folder(`tars-run-${process.pid}-d4E5f6`);
    expect(sweepRunTokenFolders(tmp)).toBe(2);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(mine)).toBe(false);
  });

  it("2. another Tars's folder is kept while that Tars runs", () => {
    live = spawn('/bin/sleep', ['30']);
    const theirs = folder(`tars-run-${live.pid}-g7H8i9`);
    expect(sweepRunTokenFolders(tmp)).toBe(0);
    expect(fs.existsSync(path.join(theirs, 'token'))).toBe(true);
  });

  it('4. a folder from before, with no pid in its name, goes once an hour old', () => {
    const fresh = folder('tars-run-j1K2l3');
    const old = folder('tars-run-m4N5o6', 2 * 60 * 60_000);
    expect(sweepRunTokenFolders(tmp)).toBe(1);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('5. leaves everything else alone', () => {
    const others = [folder('tars-runner-x1Y2z3', 2 * 60 * 60_000), folder('tars-vitest-whatever', 2 * 60 * 60_000)];
    fs.writeFileSync(path.join(tmp, `tars-run-${deadPid()}-abcdef`), 'a file, not a run folder');
    expect(sweepRunTokenFolders(tmp)).toBe(0);
    for (const dir of others) expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(tmp)).toHaveLength(3);
  });
});
