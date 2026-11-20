import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { classifyInstall, updateCli, type CliUpdateContext } from '../../../electron/services/cli-updater';

/**
 * Qwen Code updated once for the fleet (2.0.4). Its own installer (measured
 * on 0.25.2, 18/10) puts it in ~/.local/lib/qwen-code: manifest.json named
 * @qwen-code/qwen-code with its version, bin/qwen, its own node in node/bin,
 * and a launcher ~/.local/bin/qwen, a shell script that execs bin/qwen. `qwen
 * update` updates that install in place ("Qwen Code 0.25.2 is up to date!",
 * exit 0, measured on a clone of it in a throwaway HOME). Each agent's
 * session has qwen's own updater turned off (general.enableAutoUpdate false,
 * services/qwen-code.ts).
 *
 * Every way it can fail, written before the code:
 *  U1. The standalone install is not recognised (the launcher is a script, not
 *      a link), so qwen is never updated, or is updated as something else.
 *  U2. The update's verdict is its words, not the version the manifest holds
 *      after it: a run that changed nothing reads updated, or one that did
 *      reads failed.
 *  U3. It updates under a session still running qwen's node, or while the
 *      user turned qwen's updates off in ~/.qwen/settings.json.
 *  U4. (The Audit's L2 on #461, written before its code.) Installed with npm
 *      (@qwen-code/qwen-code), it is updated, npm run, while the user turned
 *      qwen's updates off.
 */

vi.setConfig({ testTimeout: 30_000 });

let home: string;
let ctx: CliUpdateContext;

/** A standalone install as qwen's installer lays it out, its bin/qwen a fake that "updates" to FAKE_NEXT. */
function plantStandalone(version = '0.25.2') {
  const root = path.join(home, '.local', 'lib', 'qwen-code');
  for (const d of ['bin', path.join('node', 'bin'), 'lib']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name: '@qwen-code/qwen-code', version, target: 'darwin-arm64', runtime: 'node' }));
  fs.copyFileSync(process.execPath, path.join(root, 'node', 'bin', 'node'));
  fs.chmodSync(path.join(root, 'node', 'bin', 'node'), 0o755);
  fs.writeFileSync(path.join(root, 'bin', 'qwen'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const m = path.join(${JSON.stringify(root)}, 'manifest.json');
const j = JSON.parse(fs.readFileSync(m, 'utf8'));
if (process.argv[2] === 'update') {
  if (process.env.FAKE_NEXT) { j.version = process.env.FAKE_NEXT; fs.writeFileSync(m, JSON.stringify(j)); console.log('Updated to ' + j.version); }
  else console.log('Qwen Code ' + j.version + ' is up to date!');
}
`, { mode: 0o755 });
  const launcher = path.join(home, '.local', 'bin', 'qwen');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `#!/usr/bin/env sh\nexec '${path.join(root, 'bin', 'qwen')}' "$@"\n`, { mode: 0o755 });
  return { root, launcher };
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-update-')));
  ctx = { home, env: { ...process.env, HOME: home, PATH: `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH ?? ''}` }, logFile: path.join(home, 'u.log'), tmpDir: home };
  delete ctx.env.FAKE_NEXT;
});

describe.skipIf(process.platform === 'win32')('qwen code, updated once for the fleet', () => {
  it('U1. its standalone install is recognised through its launcher script', () => {
    const { root, launcher } = plantStandalone();
    expect(classifyInstall(launcher)).toMatchObject({ kind: 'qwen-standalone', root, version: '0.25.2', binary: path.join(root, 'node', 'bin', 'node') });
  });

  it('U2. the verdict is the manifest\'s version after the update', async () => {
    const { launcher } = plantStandalone();
    expect(await updateCli('qwen', launcher, ctx)).toMatchObject({ cli: 'qwen', outcome: 'unchanged', from: '0.25.2' });
    ctx.env.FAKE_NEXT = '0.25.3';
    expect(await updateCli('qwen', launcher, ctx)).toMatchObject({ cli: 'qwen', outcome: 'updated', from: '0.25.2', to: '0.25.3' });
  });

  it('U3. never under a running session, nor with the user\'s updates off', async () => {
    const { root, launcher } = plantStandalone();
    ctx.env.FAKE_NEXT = '0.25.3';
    const running = spawn(path.join(root, 'node', 'bin', 'node'), ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(await updateCli('qwen', launcher, ctx)).toMatchObject({ outcome: 'deferred' });
    } finally {
      running.kill();
    }
    fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
    fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({ general: { enableAutoUpdate: false } }));
    expect(await updateCli('qwen', launcher, ctx)).toMatchObject({ outcome: 'skipped' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version).toBe('0.25.2');
  });
});

describe.skipIf(process.platform === 'win32')('qwen code installed with npm', () => {
  it('U4. is left as it is while the user turned qwen\'s updates off: npm never runs', async () => {
    const prefix = path.join(home, 'npm');
    const pkg = path.join(prefix, 'lib', 'node_modules', '@qwen-code', 'qwen-code');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.25.1' }));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const launcher = path.join(prefix, 'bin', 'qwen');
    fs.symlinkSync(path.join(pkg, 'dist', 'cli.js'), launcher);
    // An npm that records being run, first on the PATH: nothing reaches the registry.
    const fakeBin = path.join(home, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const ran = path.join(home, 'npm-ran');
    fs.writeFileSync(path.join(fakeBin, 'npm'), `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`, { mode: 0o755 });
    ctx.env.PATH = `${fakeBin}${path.delimiter}${ctx.env.PATH}`;
    fs.mkdirSync(path.join(home, '.qwen'), { recursive: true });
    fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({ general: { enableAutoUpdate: false } }));

    expect(classifyInstall(launcher)).toMatchObject({ kind: 'npm', pkg: '@qwen-code/qwen-code' });
    expect(await updateCli('qwen', launcher, ctx)).toMatchObject({ cli: 'qwen', outcome: 'skipped', detail: expect.stringContaining('enableAutoUpdate') });
    expect(fs.existsSync(ran), 'npm ran').toBe(false);
  });
});
