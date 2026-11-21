import '../setup/home-guard';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { narrowDataDir } from '../../electron/utils/secret-file';
import { cannotSymlink } from '../setup/symlink-privilege';
import { hasPosixModes } from '../setup/platform-limits';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));

/**
 * ~/.tars is readable by its owner alone, and so is every file in it.
 *
 * The directory holds the fleet (agents.json, with every agent's last output),
 * the kanban board, the usage ledger, the vault database, the model catalogue
 * and the token counts. It was created with the default mode, 0755, and its
 * files at 0644, so any other account on the machine could list it and read
 * all of that. Three credential files were narrowed at boot one by one
 * (app-settings.json, hermes-connection.json, api-token); nothing else was.
 *
 * The ways this can fail, each a case below:
 *  1. The directory, made 0755 by an older build, stays open to the other
 *     accounts.
 *  2. A data file at 0644 stays readable by them.
 *  3. A subdirectory at 0755 (vault/, observations/, worlds/) stays open.
 *  4. A link in the directory is followed, and the file it points to, which
 *     may be anything the account owns, has its mode changed.
 *  5. One entry that cannot be changed stops the rest from being narrowed.
 *  6. A missing directory makes the boot throw.
 *  7. Over-correction: the owner loses a bit it needs. statusline.sh is run
 *     by Claude Code and must stay executable by its owner.
 *  8. A new install makes the directory 0755 again: ensureDataDir creates it
 *     with the default mode.
 *  9. The boot never calls it, and the directory stays as it was.
 *
 * The negative witness: before this change narrowDataDir does not exist, and
 * ensureDataDir makes the directory at 0755 under the usual umask, which case
 * 8 checks is the umask in force before trusting its own result.
 */

const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const made: string[] = [];

function dataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-data-modes-'));
  made.push(root);
  const dir = path.join(root, '.tars');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  return dir;
}

function file(dir: string, name: string, mode: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{}');
  fs.chmodSync(p, mode);
  return p;
}

const mode = (p: string) => fs.lstatSync(p).mode & 0o777;

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('narrowDataDir', () => {
  it.skipIf(!hasPosixModes())('1-2. closes the directory and every file in it to the other accounts', () => {
    const dir = dataDir();
    const files = ['agents.json', 'kanban-tasks.json', 'usage-ledger.jsonl', 'vault.db', 'api-token'].map(n => file(dir, n, 0o644));

    narrowDataDir(dir);

    expect(mode(dir)).toBe(0o700);
    for (const f of files) expect(mode(f), path.basename(f)).toBe(0o600);
  });

  it.skipIf(!hasPosixModes())('3. closes its subdirectories', () => {
    const dir = dataDir();
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(vault);
    fs.chmodSync(vault, 0o755);

    narrowDataDir(dir);

    expect(mode(vault)).toBe(0o700);
  });

  it.skipIf(cannotSymlink() || !hasPosixModes())('4. does not follow a link to change the file it points to', () => {
    const dir = dataDir();
    const outside = file(path.dirname(dir), 'project-file.txt', 0o644);
    fs.symlinkSync(outside, path.join(dir, 'link'));

    narrowDataDir(dir);

    expect(mode(outside)).toBe(0o644);
  });

  it.skipIf(!hasPosixModes())('5. narrows the rest when one entry cannot be changed', () => {
    const dir = dataDir();
    const stuck = file(dir, 'a-stuck.json', 0o644);
    const after = file(dir, 'z-after.json', 0o644);
    const original = nodeFs.chmodSync;
    nodeFs.chmodSync = ((p: fs.PathLike, m: fs.Mode) => {
      if (p === stuck) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return original(p, m);
    }) as typeof fs.chmodSync;
    syncBuiltinESMExports();
    try {
      narrowDataDir(dir);
    } finally {
      nodeFs.chmodSync = original;
      syncBuiltinESMExports();
    }

    expect(mode(after)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it('6. is silent when the directory does not exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-data-modes-'));
    made.push(root);
    expect(() => narrowDataDir(path.join(root, 'never-made'))).not.toThrow();
  });

  it.skipIf(!hasPosixModes())('7. keeps what the owner needs: statusline.sh stays executable', () => {
    const dir = dataDir();
    const script = file(dir, 'statusline.sh', 0o755);
    const own = file(dir, 'already-private.json', 0o600);

    narrowDataDir(dir);

    expect(mode(script)).toBe(0o700);
    expect(mode(own)).toBe(0o600);
  });
});

describe('the app', () => {
  it('8. creates ~/.tars readable by its owner only', async () => {
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-data-modes-')), 'ordinary');
    made.push(path.dirname(probe));
    fs.mkdirSync(probe);
    if (hasPosixModes()) expect(mode(probe) & 0o077, 'this umask would hide the defect').not.toBe(0);

    const { DATA_DIR } = await import('../../electron/constants');
    expect(DATA_DIR.startsWith(os.homedir() + path.sep), 'not the throwaway home').toBe(true);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const { ensureDataDir } = await import('../../electron/utils');

    ensureDataDir();

    if (hasPosixModes()) expect(mode(DATA_DIR)).toBe(0o700);
  });

  it('9. narrows ~/.tars when it starts', () => {
    const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
    const ready = main.slice(main.indexOf('app.whenReady()'));
    const body = ready.slice(0, ready.indexOf('\n});') + 4);

    expect(body, 'not called from whenReady').toContain('narrowDataDir(DATA_DIR)');
  });
});
