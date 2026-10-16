import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { STATUSLINE_SCRIPT } from '../../../electron/utils/statusline';
import { shHooksNotShipped } from '../../setup/platform-limits';

/**
 * The status line's git cache, on a GNU system (Linux).
 *
 * The script reads the cache's age with `stat -f%m`, BSD's form. GNU stat
 * refuses it, the age read as "now minus 0", and the 5 s cache was never
 * reused: `git rev-parse` ran on every render of every Claude session on
 * Linux. The lock above it already falls back to GNU's `stat -c%Y`.
 *
 * How it fails, written before the code (2026-09-24):
 * 1. On GNU stat, two renders within the TTL run git twice.
 * 2. On BSD stat (macOS), the cache stops being reused.
 *
 * These run the installed script through bash, with a stand-in `stat` that
 * answers as the named flavour does, and a `git` that counts its calls.
 */

let script: string;
const dirs: string[] = [];

beforeAll(() => {
  if (shHooksNotShipped()) return;
  const jq = spawnSync('jq', ['--version'], { encoding: 'utf-8' });
  if (jq.status !== 0) throw new Error('jq is not on PATH: the status line needs it');
  // The bash status line, the reference hooks/statusline.mjs follows: Tars runs that one everywhere since 2.0.4.
  script = path.join(os.homedir(), '.dorothy', 'statusline.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, STATUSLINE_SCRIPT, { mode: 0o755 });
});

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function bench(flavour: 'gnu' | 'bsd') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tars-stat-${flavour}-`));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.dorothy'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(home, 'git-calls');
  // A `stat` that knows only its own flavour's way of printing a file's mtime.
  const accepted = flavour === 'gnu' ? '-c%Y' : '-f%m';
  fs.writeFileSync(path.join(bin, 'stat'), [
    `#!${process.execPath}`,
    `const [flag, file] = process.argv.slice(2);`,
    `if (flag !== ${JSON.stringify(accepted)}) { process.stderr.write('stat: invalid option\\n'); process.exit(1); }`,
    `process.stdout.write(String(Math.floor(require('fs').statSync(file).mtimeMs / 1000)) + '\\n');`,
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> ${JSON.stringify(calls)}\necho main\n`, { mode: 0o755 });
  const render = () => spawnSync('bash', [script], {
    input: JSON.stringify({ session_id: 's1', model: { display_name: 'Opus 5' }, context_window: {}, cost: {} }),
    cwd: home, encoding: 'utf-8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
  });
  const gitCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').trim().split('\n').length : 0);
  return { render, gitCalls };
}

// Each render runs bash, which runs the stand-in `stat`, a node process, and a
// case renders several times: 1.2 to 3.9 s a case alone (2026-10-05, load
// average 28 to 87), and both cases were cut at vitest's 5 s in the full suite
// at 47 to 137, at the gates of batches 1 and 2 that day. 30 s, as #295 gave
// the cases of its kind.
describe.skipIf(shHooksNotShipped())('the git cache of the status line', { timeout: 30_000 }, () => {
  it('1. is reused within its TTL on GNU stat', () => {
    const b = bench('gnu');
    b.render();
    b.render();
    expect(b.gitCalls()).toBe(1);
  });

  it('2. is still reused on BSD stat', () => {
    const b = bench('bsd');
    b.render();
    b.render();
    expect(b.gitCalls()).toBe(1);
  });
});
