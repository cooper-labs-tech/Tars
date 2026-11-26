import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { writeFileSync as namedWriteFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withTestHome } from './test-home';

/**
 * The witness for __tests__/setup/home-isolation.ts.
 *
 * What leaked was ensureProjectTrusted writing a project into the real
 * ~/.claude.json on every run of managed-cli-env.test.ts, 171 entries by
 * 2026-09-16. These hold the fix to that path: the write lands in the throwaway
 * HOME, and pointed at a protected home it is refused before it happens, even
 * though that function swallows the error.
 *
 * The refusals are exercised on a directory protected for the test, never on
 * the real home: a guard that failed here would otherwise write into it.
 */

// As stop-failure.test.ts: agent-manager is real, what reaches outside is stubbed.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('uuid', () => ({ v4: vi.fn(() => 'pty-1') }));
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../../electron/core/pty-manager', () => ({ ptyProcesses: new Map(), writeProgrammaticInput: vi.fn() }));
vi.mock('../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { ensureProjectTrusted } from '../../electron/core/agent-manager';

type HomeGuard = {
  originalHome: string | undefined;
  originalProfile: Record<string, string | undefined>;
  accountHome: string;
  throwawayHome: string;
  protectedRoots: string[];
  allowedRoots: string[];
  violations: { op: string; path: string }[];
  protect(root: string): void;
  unprotect(root: string): void;
};

const guard = (globalThis as Record<symbol, unknown>)[Symbol.for('tars.test.homeGuard')] as HomeGuard;

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-project-'));
}

/**
 * A scratch directory inside the repository as the guard resolves it: links
 * followed, the way canonical() in home-isolation.ts follows them.
 *
 * Under coverage/, which git ignores and which belongs to the checkout itself.
 * It was node_modules, and a worktree often links node_modules to the checkout
 * above it: resolved, the write landed in that other checkout, under the
 * account home and outside this repository, and the guard refused it, rightly.
 * Measured on 2026-09-17: two failures on main in such a worktree, the second
 * only the first one's refusal left on record. The folder is made for the test
 * when it is missing, and taken away with it once it is empty again.
 */
function inRepository(body: (scratch: string) => void): void {
  const repository = fs.realpathSync.native(process.cwd());
  const ignored = path.join(repository, 'coverage');
  const made = !fs.existsSync(ignored);
  if (made) fs.mkdirSync(ignored);
  try {
    expect(
      fs.realpathSync.native(ignored).startsWith(repository + path.sep),
      `${ignored} resolves outside the repository, so a write there says nothing about writing into it`,
    ).toBe(true);
    const scratch = fs.mkdtempSync(path.join(ignored, '.tars-home-isolation-'));
    try {
      body(scratch);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    // Not empty means something else wrote there in the meantime, which is
    // not this test's to delete.
    if (made && fs.readdirSync(ignored).length === 0) fs.rmdirSync(ignored);
  }
}

describe('the suite runs in a HOME of its own', () => {
  it('points HOME at a fresh directory under the temp dir, not the one the run started with', () => {
    expect(guard, 'home-isolation.ts is not among the setup files').toBeDefined();
    expect(os.homedir()).toBe(guard.throwawayHome);
    expect(process.env.HOME).toBe(guard.throwawayHome);
    expect(guard.originalHome, 'the run started without a HOME, so there is nothing to protect').toBeTruthy();
    expect(os.homedir()).not.toBe(guard.originalHome);
    expect(fs.realpathSync.native(os.homedir()).startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep)).toBe(true);
  });

  it('protects the home the run started in, and the account home', () => {
    expect(guard.protectedRoots).toContain(fs.realpathSync.native(guard.originalHome as string));
    if (guard.accountHome) expect(guard.protectedRoots).toContain(fs.realpathSync.native(guard.accountHome));
    // And lets nothing under them through but the repository, the throwaway
    // HOME and the temporary folder: the run's, which holds this file's
    // (tmpdir-isolation.ts), on every system, since it lies inside the
    // account's home on Windows (AppData\Local\Temp) and in a terminal Tars
    // runs (~/.tars/tmp/<agent>/t). The tests here never write into the real
    // home, so a guard that let that home through would pass all of them: this
    // is what fails instead.
    expect(guard.allowedRoots).toEqual([
      fs.realpathSync.native(process.cwd()),
      fs.realpathSync.native(guard.throwawayHome),
      fs.realpathSync.native(path.dirname(os.tmpdir())),
    ]);
  });

  it.runIf(process.platform === 'win32')('on Windows, points USERPROFILE, APPDATA and LOCALAPPDATA at it too', () => {
    // os.homedir() reads USERPROFILE on Windows, not HOME: redirecting HOME
    // alone left DATA_DIR on the real %USERPROFILE%\.tars.
    const home = guard.throwawayHome;
    expect(os.homedir()).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
    expect(process.env.APPDATA).toBe(path.join(home, 'AppData', 'Roaming'));
    expect(process.env.LOCALAPPDATA).toBe(path.join(home, 'AppData', 'Local'));
    expect(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`).toBe(home);
    expect(fs.statSync(process.env.APPDATA as string).isDirectory()).toBe(true);
    expect(fs.statSync(process.env.LOCALAPPDATA as string).isDirectory()).toBe(true);
    // And the folders the run started with stay protected, whatever they were.
    for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const was = guard.originalProfile[key];
      if (was) expect(guard.protectedRoots, key).toContain(fs.realpathSync.native(was));
    }
  });

  it('lets a test write into the temp dir, even where it lies under the account home', () => {
    try {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-temp-'));
      fs.writeFileSync(path.join(scratch, 'ok'), 'ok');
      fs.rmSync(scratch, { recursive: true, force: true });
    } finally {
      expect(guard.violations.splice(0)).toEqual([]);
    }
  });

  // The account's home, or, for a uid with no passwd entry (a container), the
  // home the run started in: both are protected, and one of them is the real one.
  const realHome = guard.accountHome || guard.originalHome;

  it.skipIf(!realHome)('still refuses a write into the real ~/.tars, and the real app data folder', () => {
    // Into a folder that does not exist, so that a guard that let it through
    // fails with ENOENT and writes nothing: the witness cannot become the leak.
    const probe = `tars-guard-probe-${process.pid}-${Date.now()}`;
    const targets = [path.join(realHome as string, '.tars', probe, 'agents.json')];
    if (process.platform === 'win32') {
      // Electron's userData is %APPDATA%\tars: the real one, and the one the run started with.
      targets.push(path.join(realHome as string, 'AppData', 'Roaming', 'tars', probe, 'config.json'));
      const appData = guard.originalProfile.APPDATA;
      if (appData) targets.push(path.join(appData, 'tars', probe, 'config.json'));
    }
    let refused: string[] = [];
    try {
      for (const target of targets) {
        let thrown: unknown;
        try {
          fs.writeFileSync(target, 'x');
        } catch (error) {
          thrown = error;
        }
        expect((thrown as NodeJS.ErrnoException | undefined)?.code, target).toBe('E_TARS_HOME_GUARD');
      }
    } finally {
      refused = guard.violations.splice(0).map(v => v.path);
    }
    expect(refused).toHaveLength(targets.length);
  });

  it('sends the trust write that leaked into ~/.claude.json to the throwaway HOME', () => {
    const trusted = project();
    ensureProjectTrusted(trusted);

    const written = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
    expect(written.projects[trusted]).toMatchObject({ hasTrustDialogAccepted: true });
    expect(guard.violations).toEqual([]);
  });

  it('still lets a test write into the repository, which sits under the same home', () => {
    try {
      inRepository(scratch => fs.writeFileSync(path.join(scratch, 'ok'), 'ok'));
    } finally {
      // Taken here, pass or fail: a refusal left on record would fail the next
      // test that reads the record, and one cause would read as two.
      expect(guard.violations.splice(0)).toEqual([]);
    }
  });
});

describe('a write into a protected home', () => {
  let protectedHome: string;
  let outside: string;

  beforeEach(() => {
    protectedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-protected-'));
    fs.writeFileSync(path.join(protectedHome, 'existing'), 'kept');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-isolation-outside-'));
    fs.writeFileSync(path.join(outside, 'source'), 'source');
    guard.protect(protectedHome);
  });

  afterEach(() => {
    guard.unprotect(protectedHome);
    fs.rmSync(protectedHome, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('is refused on the product path that leaked, and recorded although the product swallows it', () => {
    withTestHome(protectedHome, () => ensureProjectTrusted(project()));

    expect(fs.existsSync(path.join(protectedHome, '.claude.json'))).toBe(false);
    // Consumed here, because the setup file fails the whole file on any record
    // left at its end: that is what catches a swallowed refusal.
    // The file is written beside itself first and renamed over (shared-file.ts),
    // so the refused write is that temp file's.
    expect(guard.violations.splice(0).map(v => [v.op, v.path])).toEqual([
      ['fs.writeFileSync', path.join(fs.realpathSync.native(protectedHome), `.claude.json.tars-${process.pid}.tmp`)],
    ]);
  });

  it('is refused through a link that leaves the repository, the way a worktree links node_modules', () => {
    // What the repository test above used to stumble on, held as a refusal: a
    // path that starts inside the repository and resolves into a protected home
    // is that home, not the repository.
    let refused: Array<[string, string]> = [];
    try {
      inRepository(scratch => {
        const link = path.join(scratch, 'linked');
        // A junction on Windows, which is what a worktree's node_modules link is
        // there and needs no privilege; the type is ignored everywhere else.
        fs.symlinkSync(protectedHome, link, 'junction');
        let thrown: unknown;
        try {
          fs.writeFileSync(path.join(link, 'through-the-link'), 'x');
        } catch (error) {
          thrown = error;
        } finally {
          // Taking the link away resolves through it too, and the guard refuses
          // that as a write into the home it points at. So the home stops being
          // protected before the scratch folder goes; afterEach finds it done.
          guard.unprotect(protectedHome);
        }
        expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('E_TARS_HOME_GUARD');
      });
    } finally {
      refused = guard.violations.splice(0).map(v => [v.op, v.path]);
    }
    expect(refused).toEqual([
      ['fs.writeFileSync', path.join(fs.realpathSync.native(protectedHome), 'through-the-link')],
    ]);
    expect(fs.readdirSync(protectedHome)).toEqual(['existing']);
  });

  it.runIf(process.platform === 'win32')('is refused through a pipe prefix that climbs back out of the pipe namespace', () => {
    // The guard lets genuine named pipes through (node-pty's ConPTY input), and
    // Windows collapses `..` in them: each of these opens an ordinary file in
    // the protected home.
    const escapes = ['\\\\.\\pipe\\..\\', '//./pipe/../', '\\\\?\\pipe\\..\\'];
    let refused: string[] = [];
    try {
      escapes.forEach((prefix, i) => {
        let thrown: unknown;
        try {
          fs.writeFileSync(`${prefix}${path.join(protectedHome, `escape-${i}`)}`, 'x');
        } catch (error) {
          thrown = error;
        }
        expect((thrown as NodeJS.ErrnoException | undefined)?.code, prefix).toBe('E_TARS_HOME_GUARD');
      });
    } finally {
      refused = guard.violations.splice(0).map(v => v.path);
    }
    expect(refused).toHaveLength(escapes.length);
    expect(fs.readdirSync(protectedHome)).toEqual(['existing']);
  });

  it('is refused through every way node:fs writes, while reading stays allowed', async () => {
    const at = (name: string) => path.join(protectedHome, name);
    const source = path.join(outside, 'source');
    const refusedSync: Array<[string, () => unknown]> = [
      ['writeFileSync', () => fs.writeFileSync(at('a'), 'x')],
      ['named import', () => namedWriteFileSync(at('b'), 'x')],
      ['appendFileSync', () => fs.appendFileSync(at('existing'), 'x')],
      ['mkdirSync', () => fs.mkdirSync(at('c'))],
      ['mkdtempSync', () => fs.mkdtempSync(at('d-'))],
      ['renameSync into', () => fs.renameSync(source, at('e'))],
      ['renameSync out of', () => fs.renameSync(at('existing'), path.join(outside, 'moved'))],
      ['copyFileSync', () => fs.copyFileSync(source, at('f'))],
      ['cpSync', () => fs.cpSync(source, at('g'))],
      ['rmSync', () => fs.rmSync(at('existing'))],
      ['unlinkSync', () => fs.unlinkSync(at('existing'))],
      ['symlinkSync', () => fs.symlinkSync(source, at('h'))],
      ['truncateSync', () => fs.truncateSync(at('existing'))],
      ['chmodSync', () => fs.chmodSync(at('existing'), 0o600)],
      ['openSync for writing', () => fs.openSync(at('i'), 'w')],
      ['createWriteStream', () => fs.createWriteStream(at('j'))],
    ];
    for (const [how, write] of refusedSync) {
      let thrown: unknown;
      try {
        write();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as NodeJS.ErrnoException | undefined)?.code, how).toBe('E_TARS_HOME_GUARD');
    }
    await expect(fs.promises.writeFile(at('k'), 'x')).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    await expect(fs.promises.mkdir(at('l'))).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    await expect(fs.promises.open(at('m'), 'a')).rejects.toMatchObject({ code: 'E_TARS_HOME_GUARD' });
    const callbackError = await new Promise<NodeJS.ErrnoException | null>(resolve => fs.writeFile(at('n'), 'x', resolve));
    expect(callbackError).toMatchObject({ code: 'E_TARS_HOME_GUARD' });

    // Reading the real home is not what leaked, and stays possible.
    expect(fs.readFileSync(at('existing'), 'utf-8')).toBe('kept');
    fs.closeSync(fs.openSync(at('existing'), 'r'));

    const refusals = refusedSync.length + 4;
    expect(guard.violations.splice(0)).toHaveLength(refusals);
    expect(fs.readdirSync(protectedHome)).toEqual(['existing']);
    expect(fs.readFileSync(at('existing'), 'utf-8')).toBe('kept');
    expect(fs.existsSync(source)).toBe(true);
  });
});
