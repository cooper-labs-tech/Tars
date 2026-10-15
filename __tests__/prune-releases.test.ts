import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fakeGh, publishedAssets, sha256, type FakeGh, type FakeGhState } from './scripts/fake-gh';
import { canonicalReleaseDir, main } from '../scripts/prune-releases.mjs';

/**
 * Keeping the last two builds and deleting the rest, and only what GitHub
 * proves published. Two, not three: JeanBrasse's rule of 2026-10-01, the 1.9.2
 * release left three in release/.
 *
 * electron-builder never cleans up, so release/ reached 6.3GB across thirteen
 * versions. The part that has to be right first is the ordering: a string sort
 * puts 1.6.9 above 1.6.10 and would delete the newest build in the directory.
 * Then what may be deleted at all: on 16/09 the purge ran in a worktree's
 * release/ instead of the one JeanBrasse opens, and it would have deleted the last
 * copy of 1.6.19, which had never been published.
 *
 * gh is a fake on the PATH throughout. No test reaches GitHub or the real
 * release/.
 */

const script = path.resolve('scripts/prune-releases.mjs');
const SUFFIXES = ['-arm64.dmg', '-arm64.dmg.blockmap', '-arm64-mac.zip', '-arm64-mac.zip.blockmap'];
const PACKAGE = JSON.stringify({ name: 'tars', version: '0.0.0', build: { publish: { provider: 'github', owner: 'acme', repo: 'tars' } } });

let gh: FakeGh;

beforeEach(() => {
  gh = fakeGh();
  gh.install();
});

afterEach(() => {
  gh.uninstall();
});

/** A checkout-shaped folder: package.json and a release/ with these versions, each file holding `x`. */
function checkoutWith(versions: string[], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-'))): { dir: string; release: string } {
  const release = path.join(dir, 'release');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), PACKAGE);
  for (const v of versions) {
    for (const suffix of SUFFIXES) fs.writeFileSync(path.join(release, `Tars-${v}${suffix}`), 'x');
  }
  return { dir, release };
}

/** Every version GitHub lists, published with exactly the local files. */
function allPublished(versions: string[]): FakeGhState {
  return { releases: Object.fromEntries(versions.map(v => [`v${v}`, { assets: publishedAssets(v) }])) };
}

const versionsIn = (release: string) => [...new Set(fs.readdirSync(release)
  .map(n => /^Tars-(\d+\.\d+\.\d+)-/.exec(n)?.[1])
  .filter((v): v is string => !!v))].sort();

function run(versions: string[]): string[] {
  const { dir, release } = checkoutWith(versions);
  // Things that are not versioned artifacts and must survive.
  fs.writeFileSync(path.join(release, 'latest-mac.yml'), 'version: x');
  fs.writeFileSync(path.join(release, 'builder-debug.yml'), 'x');
  fs.mkdirSync(path.join(release, 'mac-arm64'));
  gh.setState(allPublished(versions));

  execFileSync(process.execPath, [script, '--release-dir', 'release'], { cwd: dir, stdio: 'pipe' });

  const left = versionsIn(release);
  const survivors = fs.readdirSync(release);
  fs.rmSync(dir, { recursive: true, force: true });
  expect(survivors).toContain('latest-mac.yml');
  expect(survivors).toContain('builder-debug.yml');
  expect(survivors).toContain('mac-arm64');
  return left;
}

describe('pruning old builds', () => {
  it('keeps the two newest', () => {
    const kept = run(['1.6.5', '1.6.6', '1.6.7', '1.6.8']);
    expect(kept.sort()).toEqual(['1.6.7', '1.6.8']);
  });

  it('sorts numerically, so 1.6.10 outranks 1.6.9', () => {
    // A string sort would delete the newest build in the directory.
    const kept = run(['1.6.8', '1.6.9', '1.6.10', '1.6.11']);
    expect(kept.sort()).toEqual(['1.6.10', '1.6.11']);
  });

  it('crosses a minor version correctly', () => {
    const kept = run(['1.5.9', '1.6.0', '1.6.1', '1.7.0']);
    expect(kept.sort()).toEqual(['1.6.1', '1.7.0']);
  });

  it('leaves two or fewer alone', () => {
    expect(run(['1.6.10', '1.6.11']).sort()).toEqual(['1.6.10', '1.6.11']);
  });

  it('deletes every file of a pruned version, not just the dmg', () => {
    const versions = ['1.6.1', '1.6.2', '1.6.3', '1.6.4'];
    const { dir, release } = checkoutWith(versions);
    gh.setState(allPublished(versions));
    execFileSync(process.execPath, [script, '--release-dir', 'release'], { cwd: dir, stdio: 'pipe' });
    const left = fs.readdirSync(release);
    expect(left.filter(n => n.includes('1.6.1-'))).toEqual([]);
    expect(left.filter(n => n.includes('1.6.4-'))).toHaveLength(4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not fail when there is nothing built', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-'));
    fs.writeFileSync(path.join(dir, 'package.json'), PACKAGE);
    expect(() => execFileSync(process.execPath, [script, '--release-dir', 'release'], { cwd: dir, stdio: 'pipe' })).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The gh these scripts run is the fake, and never the one on the machine.
 *
 * Measured on Windows on 2026-09-25: execFile('gh') looks for gh.com and gh.exe
 * only, so the fake, a file named `gh`, was never found and the real gh.exe ran
 * in its place, 38 tests, with the user's GitHub session when APPDATA was not
 * isolated. The fake records the argv of every call it answers, which is the
 * proof it was the one reached; and a fake the PATH would not find is refused
 * before any script can run the gh behind it.
 */
describe('the gh the scripts run', () => {
  it('is the fake, for the script run as its own process', () => {
    const versions = ['1.6.1', '1.6.2', '1.6.3', '1.6.4'];
    const { dir } = checkoutWith(versions);
    gh.setState(allPublished(versions));

    execFileSync(process.execPath, [script, '--release-dir', 'release'], { cwd: dir, stdio: 'pipe' });
    fs.rmSync(dir, { recursive: true, force: true });

    // Asked of the two older than the two it keeps (1.9.3), newest first.
    expect(gh.calls()).toEqual([
      ['release', 'view', 'v1.6.2', '--repo', 'acme/tars', '--json', 'assets'],
      ['release', 'view', 'v1.6.1', '--repo', 'acme/tars', '--json', 'assets'],
    ]);
  });

  it('is the fake, for the script run inside this process', async () => {
    const versions = ['1.6.1', '1.6.2', '1.6.3', '1.6.4'];
    const { release } = checkoutWith(versions);
    gh.setState(allPublished(versions));

    await main(['--release-dir', release], { cwd: path.dirname(release), log: () => {} });

    // Asked of the two older than the two it keeps (1.9.3), newest first.
    expect(gh.calls()).toEqual([
      ['release', 'view', 'v1.6.2', '--repo', 'acme/tars', '--json', 'assets'],
      ['release', 'view', 'v1.6.1', '--repo', 'acme/tars', '--json', 'assets'],
    ]);
  });

  it('is refused at install when the fake is missing, rather than left to the gh on the PATH', () => {
    // The PATH as the run found it: the real gh, on a machine that has one.
    gh.uninstall();
    const missing = fakeGh();
    fs.rmSync(missing.bin, { recursive: true, force: true });
    const before = process.env.PATH;

    expect(() => missing.install()).toThrow(/is not the fake/);
    expect(process.env.PATH).toBe(before);
    missing.uninstall();
  });

  it('leaves no folder behind in the temp dir once uninstalled', () => {
    const other = fakeGh();
    const folder = path.dirname(other.bin);
    other.install();
    other.uninstall();

    expect(fs.existsSync(folder), folder).toBe(false);
  });
});

describe('what the purge may delete', () => {
  const FIVE = ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4'];
  const NEWEST = ['1.0.3', '1.0.4'];

  async function prune(release: string, cwd = path.dirname(release)): Promise<string[]> {
    const lines: string[] = [];
    await main(['--release-dir', release], { cwd, log: (line: string) => lines.push(line) });
    return lines;
  }

  it('never deletes a version that is not published, and names it', async () => {
    const { release } = checkoutWith(FIVE);
    gh.setState({ releases: { 'v1.0.0': { assets: publishedAssets('1.0.0') } } });

    const lines = await prune(release);

    expect(versionsIn(release)).toEqual(['1.0.1', '1.0.2', ...NEWEST]);
    expect(lines.join('\n')).toContain('kept 1.0.1, not published: there is no release v1.0.1 on acme/tars');
  });

  it('deletes a published version beyond the two newest', async () => {
    const { release } = checkoutWith(FIVE);
    gh.setState(allPublished(FIVE));

    await prune(release);

    expect(versionsIn(release)).toEqual(NEWEST);
  });

  it('keeps a version published without its zip', async () => {
    const { release } = checkoutWith(['1.0.1', ...NEWEST]);
    gh.setState({ releases: { 'v1.0.1': { assets: publishedAssets('1.0.1').filter(a => !a.name.endsWith('.zip')) } } });

    const lines = await prune(release);

    expect(versionsIn(release)).toEqual(['1.0.1', ...NEWEST]);
    expect(lines.join('\n')).toContain('has no zip');
  });

  it('keeps a version whose zip is still being uploaded', async () => {
    // Name, size and digest can all be right on an upload GitHub has not
    // finished: only its state says the file cannot be downloaded yet.
    const { release } = checkoutWith(['1.0.1', ...NEWEST]);
    gh.setState({ releases: { 'v1.0.1': { assets: publishedAssets('1.0.1').map(a => (a.name.endsWith('.zip') ? { ...a, state: 'open' } : a)) } } });

    const lines = await prune(release);

    expect(versionsIn(release)).toEqual(['1.0.1', ...NEWEST]);
    expect(lines.join('\n')).toContain('has no zip');
  });

  it('keeps a version whose published files are not the local ones, by size or by content', async () => {
    const { release } = checkoutWith(FIVE);
    gh.setState({
      releases: {
        // Same name, another size, and GitHub gives no digest.
        'v1.0.0': { assets: publishedAssets('1.0.0').map(a => ({ ...a, size: 2, digest: null })) },
        // Same name and size, other bytes.
        'v1.0.1': { assets: publishedAssets('1.0.1').map(a => ({ ...a, digest: sha256('y') })) },
      },
    });

    const lines = (await prune(release)).join('\n');

    expect(versionsIn(release)).toEqual(FIVE);
    expect(lines).toContain('(size differs)');
    expect(lines).toContain('(sha256 differs)');
  });

  it('deletes nothing when GitHub cannot be asked, and names every version kept for that', async () => {
    const { release } = checkoutWith(FIVE);
    gh.setState({ ...allPublished(FIVE), offline: true });

    const lines = (await prune(release)).join('\n');

    expect(versionsIn(release)).toEqual(FIVE);
    expect(lines).toContain('kept 1.0.0, its publication could not be checked: error connecting to api.github.com');
    expect(lines).toContain('kept 1.0.1, its publication could not be checked: error connecting to api.github.com');
  });

  it('deletes nothing when one version cannot be checked, even though another is proven published', async () => {
    // Read as "not published", the failure would keep only its own version, and
    // the proven one would go. An outage must not read as an answer.
    const { release } = checkoutWith(FIVE);
    gh.setState({ ...allPublished(FIVE), failFor: { 'v1.0.1': 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' } });

    const lines = (await prune(release)).join('\n');

    expect(versionsIn(release)).toEqual(FIVE);
    expect(lines).toContain('kept 1.0.1, its publication could not be checked: HTTP 502');
    expect(lines).toContain('kept 1.0.0, nothing is deleted while another version cannot be checked');
  });

  it('deletes nothing when gh is not installed', async () => {
    const { release } = checkoutWith(FIVE);
    gh.setState(allPublished(FIVE));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-no-gh-'));
    const savedPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      const lines = (await prune(release)).join('\n');
      expect(lines).toContain('gh is not installed');
    } finally {
      process.env.PATH = savedPath;
    }

    expect(versionsIn(release)).toEqual(FIVE);
  });

  describe('where it looks', () => {
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });

    /** A main checkout with a committed package.json, and a worktree of it. */
    function checkoutAndWorktree() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-prune-git-'));
      const mainDir = path.join(root, 'main');
      fs.mkdirSync(mainDir);
      git(mainDir, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(mainDir, 'package.json'), PACKAGE);
      fs.writeFileSync(path.join(mainDir, '.gitignore'), 'release/\n');
      git(mainDir, 'add', '.');
      git(mainDir, 'commit', '-q', '-m', 'init');
      const worktree = path.join(root, 'worktree');
      git(mainDir, 'worktree', 'add', '-q', worktree, '-b', 'other');
      return { mainDir, worktree };
    }

    it("finds the main checkout's release/ from a worktree, and prunes that one", async () => {
      const { mainDir, worktree } = checkoutAndWorktree();
      checkoutWith(FIVE, mainDir);
      checkoutWith(FIVE, worktree);
      gh.setState(allPublished(FIVE));

      const found = await canonicalReleaseDir(worktree);
      await main([], { cwd: worktree, log: () => {} });

      expect(fs.realpathSync(found.dir!)).toBe(fs.realpathSync(path.join(mainDir, 'release')));
      expect(versionsIn(path.join(mainDir, 'release'))).toEqual(NEWEST);
      // The worktree's own release/ is not the folder that is kept, and is left alone.
      expect(versionsIn(path.join(worktree, 'release'))).toEqual(FIVE);
    });

    it('never falls back to release/ of the current directory', async () => {
      // Outside any checkout, with a release/ here that a fallback would prune.
      const { dir, release } = checkoutWith(FIVE);
      gh.setState(allPublished(FIVE));
      const lines: string[] = [];

      expect(await main([], { cwd: dir, log: (l: string) => lines.push(l) })).toBe(0);

      expect(versionsIn(release)).toEqual(FIVE);
      expect(lines.join('\n')).toContain('nothing pruned');
    });
  });
});
