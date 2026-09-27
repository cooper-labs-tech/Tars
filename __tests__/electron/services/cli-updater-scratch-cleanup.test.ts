import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCliUpdatePass, type CliUpdateContext } from '../../../electron/services/cli-updater';

/**
 * An npm update whose scratch folder cannot be removed at the end.
 *
 * An Amp update works in a scratch folder under the system's temp folder, npm's
 * cache included, and removes it in a `finally` once the update has come to its
 * outcome. A removal that throws from that `finally` replaces the outcome: the
 * pass reports "failed" with the removal's error, for an update that went
 * through, for a check that found nothing newer, and in place of the reason a
 * real failure had.
 *
 * Every way this can fail:
 *  1. an update that went through is reported as failed, with the removal's
 *     error as its reason;
 *  2. a check that found nothing newer is reported as failed the same way;
 *  3. an update that really failed carries the removal's error instead of its
 *     own reason, npm's;
 *  4. the folder left behind goes unsaid, or is said more than once: exactly
 *     one [cli-updates] line names it;
 *  5. the removal did not fail at all, and the test proves nothing: the folder
 *     is still there once the update has come back.
 *
 * The removal fails for real, with no fs mock: the fake npm makes the scratch
 * folder read-only (0o555) once npm's cache is in it, so the cache cannot be
 * removed from it (EACCES). Root is not held back by a folder's mode, and on
 * Windows a read-only folder does not keep its children from being deleted, so
 * these skip under both.
 */

const NODE_DIR = path.dirname(process.execPath);
const IS_ROOT = process.getuid?.() === 0;

// Every test starts real processes (the fake npm, lsof).
vi.setConfig({ testTimeout: 30_000 });

/**
 * An npm that answers `view` with FAKE_LATEST, or fails with FAKE_VIEW_ERROR,
 * and rewrites the manifest a global install names, as in cli-updater.test.ts.
 * With FAKE_HOLD set, `view` also makes the scratch folder impossible to
 * remove, and writes its path to FAKE_HOLD.
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'view' && process.env.FAKE_HOLD) {
  const scratch = path.dirname(args[args.indexOf('--cache') + 1]);
  fs.mkdirSync(path.join(scratch, 'npm-cache'));
  fs.writeFileSync(path.join(scratch, 'npm-cache', 'index'), '');
  fs.writeFileSync(process.env.FAKE_HOLD, scratch);
  fs.chmodSync(scratch, 0o555);
}
if (args[0] === 'view' && process.env.FAKE_VIEW_ERROR) { console.error(process.env.FAKE_VIEW_ERROR); process.exit(1); }
if (args[0] === 'view') { console.log(process.env.FAKE_LATEST); process.exit(0); }
if (args[0] === 'install' && args.includes('--global')) {
  const spec = args[args.length - 1];
  const at = spec.lastIndexOf('@');
  const manifest = path.join(args[args.indexOf('--prefix') + 1], 'lib', 'node_modules', spec.slice(0, at), 'package.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.version = spec.slice(at + 1);
  fs.writeFileSync(manifest, JSON.stringify(m));
}
process.exit(0);
`;

let root: string;
let hold: string;
let errors: string[];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-cli-update-cleanup-')));
  hold = path.join(root, 'hold');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const scratch = fs.existsSync(hold) ? fs.readFileSync(hold, 'utf8') : null;
  if (scratch && fs.existsSync(scratch)) {
    fs.chmodSync(scratch, 0o755);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * <prefix>/lib/node_modules/@sourcegraph/amp at 0.0.1, its binary named as
 * the launcher itself, and the fake npm in <prefix>/bin.
 */
function npmAmp(home: string): string {
  const prefix = path.join(home, 'npm-global');
  const pkgDir = path.join(prefix, 'lib', 'node_modules', '@sourcegraph', 'amp');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@sourcegraph/amp', version: '0.0.1' }));
  const binary = path.join(pkgDir, 'bin', 'amp');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(prefix, 'bin'));
  fs.writeFileSync(path.join(prefix, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
  return binary;
}

function ctxFor(home: string, env: Record<string, string>): CliUpdateContext {
  return {
    home,
    logFile: path.join(root, 'cli-updates.log'),
    env: {
      HOME: home,
      PATH: [NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      FAKE_HOLD: hold,
      ...env,
    },
  };
}

async function updateAmp(env: Record<string, string>) {
  const home = path.join(root, 'home');
  const binary = npmAmp(home);
  const [result] = await runCliUpdatePass([{ cli: 'amp', command: binary }], ctxFor(home, env));
  const scratch = fs.readFileSync(hold, 'utf8');
  return { result, scratch };
}

/** The [cli-updates] lines that name this folder. */
function linesNaming(scratch: string): string[] {
  return errors.filter(e => e.startsWith('[cli-updates] ') && e.includes(scratch));
}

function hasLsof(): boolean {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    return true;
  } catch (err) {
    // `lsof -v` prints its version and exits 1 on some systems.
    return (err as { status?: number }).status === 1;
  }
}

// Root removes it all the same, and a read-only folder on Windows still lets its children go.
describe.skipIf(IS_ROOT || process.platform === 'win32')('an npm update whose scratch folder cannot be removed', () => {
  // The update itself asks lsof whether amp is running, as the siblings in cli-updater.test.ts do.
  it.skipIf(!hasLsof())('1, 4, 5. an update that went through is reported as updated, and the folder left behind is named once', async () => {
    const { result, scratch } = await updateAmp({ FAKE_LATEST: '0.0.2' });

    expect(result).toMatchObject({ cli: 'amp', outcome: 'updated', from: '0.0.1', to: '0.0.2' });
    expect(fs.existsSync(scratch)).toBe(true);
    expect(linesNaming(scratch)).toHaveLength(1);
    expect(linesNaming(scratch)[0]).toMatch(/^\[cli-updates\] could not remove .+: \S/);
  });

  it('2, 4, 5. a check that found nothing newer is reported as unchanged', async () => {
    const { result, scratch } = await updateAmp({ FAKE_LATEST: '0.0.1' });

    expect(result).toMatchObject({ cli: 'amp', outcome: 'unchanged', from: '0.0.1' });
    expect(fs.existsSync(scratch)).toBe(true);
    expect(linesNaming(scratch)).toEqual([expect.stringMatching(/^\[cli-updates\] could not remove .+: \S/)]);
  });

  it('3, 4, 5. a real failure keeps its own reason', async () => {
    const { result, scratch } = await updateAmp({ FAKE_VIEW_ERROR: 'npm error code E404' });

    expect(result).toMatchObject({ cli: 'amp', outcome: 'failed', from: '0.0.1', detail: 'npm view @sourcegraph/amp: npm error code E404 (exit 1)' });
    expect(fs.existsSync(scratch)).toBe(true);
    expect(linesNaming(scratch)).toHaveLength(1);
  });
});
