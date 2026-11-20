import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The hooks of 1.7.9 and before logged to /tmp/dorothy-hooks.log and
 * /tmp/dorothy-hooks-debug.log, readable by every user of the machine. #135
 * moved the logs to ~/.tars/logs at 0600 and left the old files behind:
 * about 4 MB of session ids and prompt openings (the Audit, gate of #135).
 * Tars removes them once, at startup.
 *
 * How this fails, written before the code:
 * 1. The old files stay after the update.
 * 2. A link planted at one of those paths is followed, and whatever it points
 *    to is deleted with the user's rights.
 * 3. A directory, or a file another user owns, at one of those paths is
 *    removed or throws.
 * 4. A sandbox or a test run of Tars, HOME a scratch folder, deletes the logs
 *    a Tars still on 1.7.9 is writing beside it.
 * 5. Startup fails when the files are not there, which is every startup after
 *    the first.
 */

const fake = vi.hoisted(() => ({ userHome: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const userInfo = () => ({ ...actual.userInfo(), homedir: fake.userHome || actual.userInfo().homedir });
  return { ...actual, userInfo, default: { ...actual, userInfo } };
});
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

import * as os from 'node:os';
import { removeLegacyHookLogs } from '../../../electron/services/hooks-manager';
import { cannotSymlink } from '../../setup/symlink-privilege';
import { skipOnWindows } from '../../setup/platform-limits';

let dir: string;
let files: string[];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-legacy-logs-')));
  files = [path.join(dir, 'dorothy-hooks.log'), path.join(dir, 'dorothy-hooks-debug.log')];
  // The test's HOME is this user's own, as for the installed app.
  fake.userHome = os.homedir();
});

afterEach(() => {
  fake.userHome = '';
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Windows never had those logs, and the product removes nothing there on
 * purpose: no Tars ran the .sh hooks on Windows before they moved, and
 * without process.getuid no file passes the owner check, as
 * hooks-manager.ts says.
 */
const noLegacyLogs = () => skipOnWindows('no Tars ever wrote those /tmp logs on Windows, and removeLegacyHookLogs '
  + 'removes nothing there by design (hooks-manager.ts); the removal runs on macOS, Linux and CI');

describe('the logs the old hooks left in /tmp', () => {
  it.skipIf(noLegacyLogs())('are removed, both of them', () => {
    for (const file of files) fs.writeFileSync(file, 'SESSION_START hook. AGENT_ID=a SESSION_ID=s\n');

    expect(removeLegacyHookLogs(files)).toEqual(files);
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
  });

  it.skipIf(cannotSymlink())('never follow a link planted there, nor remove the link', () => {
    const target = path.join(dir, 'somebody-else-s-file');
    fs.writeFileSync(target, 'keep me');
    fs.symlinkSync(target, files[0]);

    expect(removeLegacyHookLogs(files)).toEqual([]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me');
    expect(fs.lstatSync(files[0]).isSymbolicLink()).toBe(true);
  });

  it('leave a directory at that path alone', () => {
    fs.mkdirSync(files[0]);

    expect(removeLegacyHookLogs(files)).toEqual([]);
    expect(fs.statSync(files[0]).isDirectory()).toBe(true);
  });

  it('are left alone by a Tars whose HOME is not the user\'s own, a sandbox or a test run', () => {
    for (const file of files) fs.writeFileSync(file, 'the live Tars is writing here\n');
    fake.userHome = path.join(dir, 'the-real-home');

    expect(removeLegacyHookLogs(files)).toEqual([]);
    for (const file of files) expect(fs.existsSync(file)).toBe(true);
  });

  it('cost nothing and throw nothing once they are gone', () => {
    expect(removeLegacyHookLogs(files)).toEqual([]);
  });
});
