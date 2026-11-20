import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/sandbox.sh starts the test build beside the real Tars (the plan's
 * point 13, 19/10: a test copy must never pass for the maintainer's Tars; on
 * 18/10 two Uncaught Exception boxes from the QA's copy looked like his Tars
 * looping). `npm run electron:pack` builds it as "Tars Sandbox"
 * (e2e/sandbox-build.packed.spec.ts reads and launches that build).
 *
 * How it fails, written before the code:
 *  S1. With no app named, it looks for release/mac-arm64/Tars.app, the release's
 *      name, which `electron:pack` no longer builds: it starts a release copy
 *      left there, or says to build an app it then does not find.
 *  S2. It touches the sandbox's HOME before it found an app to start.
 */

const script = path.resolve('scripts', 'sandbox.sh');

describe('scripts/sandbox.sh', () => {
  it.skipIf(process.platform === 'win32')('S1 S2. with no app named, looks for release/mac-arm64/Tars Sandbox.app, and touches nothing when it is not there', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-sh-'));
    // A copy of the script in a checkout with no build: the path it looks for is its own folder's.
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sandbox-checkout-'));
    fs.mkdirSync(path.join(checkout, 'scripts'));
    fs.copyFileSync(script, path.join(checkout, 'scripts', 'sandbox.sh'));
    const run = spawnSync('bash', [path.join(checkout, 'scripts', 'sandbox.sh')], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(path.join('release', 'mac-arm64', 'Tars Sandbox.app'));
    expect(run.stdout).not.toMatch(/mac-arm64\/Tars\.app/);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
