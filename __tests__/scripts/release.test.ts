import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fakeGh, publishedAssets, sha256, type FakeGh, type FakeGhState, type FakeRelease } from './fake-gh';
import { main, moveToCanonical, Refusal, verifyArtifacts } from '../../scripts/release.mjs';
import { skipOnWindows } from '../setup/platform-limits';

/**
 * `npm run release`, the only way a release is published, and every way it
 * refuses to start.
 *
 * Each case builds a real git checkout with a local origin, so HEAD, the fetch
 * and the tree are git's own answers, and puts a fake gh first on the PATH.
 * The first case passes every check: the others break exactly one thing each,
 * so a refusal is that check and not the setup. No test runs electron-builder
 * or reaches the real release/ or GitHub: a build is a script of the harness
 * that lays out files, and a release is made in the fake gh only by a test that
 * calls allowPublishing().
 */

const VERSION = '2.0.1';
const REPO = 'acme/tars';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

/** What GitHub holds before this release: the version before it, as latest. */
const BEFORE: FakeGhState = { releases: { 'v2.0.0': { assets: publishedAssets('2.0.0') } }, latest: 'v2.0.0' };

let gh: FakeGh;
let removePlutil: () => void;

/**
 * plutil, where the machine has none. release.mjs reads the built app's version
 * with it, and a release is only ever cut on a Mac, where the real one answers
 * and this is not installed. A Linux CI runner has none: this answers the one
 * query release.mjs makes, `plutil -extract <key> raw -o - <file>`, the way
 * plutil does, with the value and 0, or nothing and 1.
 */
const PLUTIL = String.raw`#!/usr/bin/env node
const [flag, key, format, o, out, file] = process.argv.slice(2);
if (flag !== '-extract' || format !== 'raw' || o !== '-o' || out !== '-' || !file) process.exit(2);
let xml = '';
try { xml = require('fs').readFileSync(file, 'utf8'); } catch { process.exit(1); }
const found = xml.match(new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>'));
if (!found) process.exit(1);
process.stdout.write(found[1] + '\n');
`;

/**
 * The cases whose run reaches that read, which no stand-in can answer on
 * Windows: execFile('plutil') there starts plutil.com or plutil.exe and nothing
 * else, and node itself under that name, as the fake gh is, takes plutil's
 * `-extract` for one of its own options and exits before any script runs. A
 * release is cut on a Mac (electron-builder --mac); these run on macOS, Linux
 * and CI.
 */
const noPlutil = () => skipOnWindows('release.mjs reads the built app\'s version with plutil, which Windows lacks and '
  + 'no stand-in can answer there (execFile finds only plutil.com or plutil.exe, and node under that name takes '
  + '-extract for its own option); a release is cut on a Mac, and these run on macOS, Linux and CI');

function standInPlutil(): () => void {
  const installed = (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && fs.existsSync(path.join(dir, 'plutil')));
  if (installed) return () => {};
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-plutil-'));
  fs.writeFileSync(path.join(bin, 'plutil'), PLUTIL, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ''}`;
  return () => {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  };
}

beforeEach(() => {
  gh = fakeGh(BEFORE);
  gh.install();
  removePlutil = standInPlutil();
});

afterEach(() => {
  removePlutil();
  gh.uninstall();
});

function changelog(top: string): string {
  return 'export interface Release { id: number; version: string; date: string; updates: string[] }\n\n'
    + 'export const CHANGELOG: Release[] = [\n'
    + `  { id: 2, version: '${top}', date: '2026-09-16', updates: ['An agent\\'s change, said the way the app says it'] },\n`
    + "  { id: 1, version: '2.0.0', date: '2026-09-01', updates: ['The one before'] },\n"
    + '];\n';
}

/** A main checkout of `main`, pushed to a local origin, clean. */
function checkout({ changelogTop = VERSION } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'checkout');
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tars',
    version: VERSION,
    // What a build would leave behind, if a dry run ever started one.
    scripts: { 'electron:build': "node -e \"require('fs').writeFileSync('BUILD_RAN', '')\"" },
    build: { publish: { provider: 'github', owner: 'acme', repo: 'tars' } },
    devDependencies: { electron: '^44.4.4' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lockfile('44.4.4'));
  // Above the checkout, where Node's resolution finds it from the checkout and
  // from a worktree beside it, as a worktree of the real repo finds the main
  // checkout's node_modules.
  installElectron(root, '44.4.4');
  fs.writeFileSync(path.join(dir, 'src', 'data', 'changelog.ts'), changelog(changelogTop));
  fs.writeFileSync(path.join(dir, 'README.md'), 'tars\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'release/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { root, dir };
}

/** package-lock.json as npm writes it, with the electron it locked. */
function lockfile(electron: string): string {
  return JSON.stringify({
    name: 'tars', version: VERSION, lockfileVersion: 3,
    packages: { '': { name: 'tars', version: VERSION }, 'node_modules/electron': { version: electron, dev: true } },
  }, null, 2);
}

/** node_modules/electron as npm and its install script leave it: the package, and the binary's own version file. */
function installElectron(root: string, version: string, { binary = version }: { binary?: string | null } = {}) {
  const electron = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(path.join(electron, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version }));
  if (binary === null) fs.rmSync(path.join(electron, 'dist', 'version'), { force: true });
  else fs.writeFileSync(path.join(electron, 'dist', 'version'), binary);
}

const base64Sha512 = (content: Buffer | string) => createHash('sha512').update(content).digest('base64');

/** A build of `version` in `releaseDir`, as electron-builder lays it out. */
function artifacts(releaseDir: string, version: string, { wrongSha = false } = {}) {
  fs.mkdirSync(path.join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents'), { recursive: true });
  const dmg = `Tars-${version}-arm64.dmg`;
  const zip = `Tars-${version}-arm64-mac.zip`;
  const dmgBytes = `dmg of ${version}`;
  const zipBytes = `zip of ${version}`;
  fs.writeFileSync(path.join(releaseDir, dmg), dmgBytes);
  fs.writeFileSync(path.join(releaseDir, zip), zipBytes);
  fs.writeFileSync(path.join(releaseDir, `${dmg}.blockmap`), 'b');
  fs.writeFileSync(path.join(releaseDir, `${zip}.blockmap`), 'b');
  fs.writeFileSync(path.join(releaseDir, 'builder-debug.yml'), `debug of ${version}`);
  const zipSha = wrongSha ? base64Sha512('something else') : base64Sha512(zipBytes);
  fs.writeFileSync(path.join(releaseDir, 'latest-mac.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${zip}`,
    `    sha512: ${zipSha}`,
    `    size: ${Buffer.byteLength(zipBytes)}`,
    `  - url: ${dmg}`,
    `    sha512: ${base64Sha512(dmgBytes)}`,
    `    size: ${Buffer.byteLength(dmgBytes)}`,
    `path: ${zip}`,
    `sha512: ${zipSha}`,
    "releaseDate: '2026-09-16T16:23:58.466Z'",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`);
  return { dmg, zip, dmgBytes, zipBytes };
}

/** GitHub's release of `version` made from exactly its dmg, zip and latest-mac.yml in `releaseDir`. */
function releasedFrom(releaseDir: string, version: string): FakeRelease {
  return {
    assets: [`Tars-${version}-arm64.dmg`, `Tars-${version}-arm64-mac.zip`, 'latest-mac.yml'].map(name => {
      const bytes = fs.readFileSync(path.join(releaseDir, name));
      return { name, size: bytes.length, digest: sha256(bytes) };
    }),
  };
}

/**
 * Commits and pushes an `electron:build` that lays a consistent build of
 * VERSION out in release/, as electron-builder does, and writes BUILD_ENV: which
 * of the variables that let electron-builder publish on its own it was given.
 */
function buildable(dir: string) {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-staged-'));
  artifacts(staged, VERSION);
  fs.writeFileSync(path.join(dir, 'build.js'), [
    "const fs = require('fs');",
    `fs.cpSync(${JSON.stringify(staged)}, 'release', { recursive: true });`,
    "fs.writeFileSync('BUILD_ENV', JSON.stringify(['CI', 'GH_TOKEN', 'GITHUB_TOKEN'].filter(key => key in process.env)));",
    '',
  ].join('\n'));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.scripts['electron:build'] = 'node build.js';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'a build that lays out its artifacts');
  git(dir, 'push', '-q', 'origin', 'main');
}

async function release(cwd: string, ...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, { cwd, log: (line: string) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

/** Every path under these roots with its size, the .git internals aside: a fetch writes there. */
function inventory(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(`${full} ${fs.statSync(full).size}`);
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

/** The calls that would have written to GitHub. */
const writesToGitHub = () => gh.calls().filter(args => !['view', 'list', 'download'].includes(args[1]) && args[0] !== 'api');

describe('npm run release, before anything is built', { timeout: 30_000 }, () => {
  it('passes every check on a clean checkout of main, so each refusal below is the check it names', async () => {
    const { dir } = checkout();

    const { code, out } = await release(dir, '--dry-run');

    expect(out).toContain('1. checks passed');
    expect(code).toBe(0);
  });

  it('refuses a HEAD that is not origin/main', async () => {
    const { dir } = checkout();
    fs.writeFileSync(path.join(dir, 'README.md'), 'a commit nobody pushed\n');
    git(dir, 'commit', '-q', '-am', 'local only');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('is not origin/main');
  });

  it('refuses a tracked file that differs from HEAD', async () => {
    const { dir } = checkout();
    fs.writeFileSync(path.join(dir, 'README.md'), 'edited, not committed\n');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('tracked files differ from HEAD');
  });

  // The Audit's release check (24/09): the main checkout's node_modules held
  // Electron 43.4.1 while package.json asked ^44.4.4, and nothing looked, so a
  // release from there would have shipped 43.
  it('refuses an installed electron that package.json does not accept', async () => {
    const { root, dir } = checkout();
    installElectron(root, '43.4.1');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('electron 43.4.1 is installed');
    expect(out).toContain('^44.4.4');
  });

  it('refuses an installed electron that is not the one package-lock.json locked', async () => {
    const { root, dir } = checkout();
    installElectron(root, '44.5.0');

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('package-lock.json locks electron 44.4.4');
  });

  it('refuses an electron binary that is not its package, as after an install that never ran', async () => {
    const { root, dir } = checkout();
    installElectron(root, '44.4.4', { binary: '43.4.1' });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('the electron binary is 43.4.1');
  });

  it('refuses when no electron binary is installed at all', async () => {
    const { root, dir } = checkout();
    installElectron(root, '44.4.4', { binary: null });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain('npx install-electron');
  });

  it('refuses a version already published', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, releases: { ...BEFORE.releases, [`v${VERSION}`]: { assets: publishedAssets(VERSION) } } });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`v${VERSION} is already published on ${REPO}`);
  });

  it('refuses a tag that already exists without a release', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, tags: [`v${VERSION}`] });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the tag v${VERSION} already exists on ${REPO}`);
  });

  it('refuses a changelog whose top entry is another version', async () => {
    const { dir } = checkout({ changelogTop: '2.0.2' });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the top entry of src/data/changelog.ts is 2.0.2, and package.json says ${VERSION}`);
  });

  it('refuses when a newer version is already published', async () => {
    const { dir } = checkout();
    gh.setState({ ...BEFORE, releases: { ...BEFORE.releases, 'v2.1.0': { assets: publishedAssets('2.1.0') } } });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`a newer version is already published on ${REPO}: v2.1.0`);
  });

  it('refuses rather than guesses when GitHub cannot be asked', async () => {
    // The first question to fail is whether the release exists. Read as "not
    // found", the next check would refuse anyway, on the tag: the message is
    // what says which check held.
    const { dir } = checkout();
    gh.setState({ ...BEFORE, offline: true });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`could not check whether v${VERSION} is published on ${REPO}`);
  });
});

// Each case runs the release script for real: 1.6 to 3.9 s a case alone
// (2026-10-05, load average 47 to 56), and "refuses, like the real run" was cut
// at vitest's 5 s in two full suites that night. 30 s, as the describes below
// that run it already have.
describe('npm run release --dry-run', { timeout: 30_000 }, () => {
  it.skipIf(noPlutil())('builds, publishes, moves and deletes nothing, from a worktree with a build ready', async () => {
    const { root, dir } = checkout();
    // The folder that is kept holds five older published versions: a real run
    // would prune two of them.
    const kept = path.join(dir, 'release');
    fs.mkdirSync(kept);
    const older = ['1.9.6', '1.9.7', '1.9.8', '1.9.9', '2.0.0'];
    for (const v of older) {
      for (const suffix of ['-arm64.dmg', '-arm64-mac.zip']) fs.writeFileSync(path.join(kept, `Tars-${v}${suffix}`), 'x');
    }
    gh.setState({ ...BEFORE, releases: Object.fromEntries(older.map(v => [`v${v}`, { assets: publishedAssets(v) }])) });
    const worktree = path.join(root, 'worktree');
    git(dir, 'worktree', 'add', '-q', '--detach', worktree, 'origin/main');
    artifacts(path.join(worktree, 'release'), VERSION);
    const before = inventory(dir, worktree);

    const { code, out } = await release(worktree, '--dry-run');

    expect(out).toContain('1. checks passed');
    expect(out).toContain('3. artifacts checked');
    expect(out).toContain("- An agent's change, said the way the app says it");
    expect(code).toBe(0);
    expect(inventory(dir, worktree)).toEqual(before);
    expect(fs.existsSync(path.join(worktree, 'BUILD_RAN'))).toBe(false);
    expect(writesToGitHub(), 'the dry run called gh for more than reading').toEqual([]);
  });

  // Found by the QA on #99 (S1): the command OPERATIONS.md has JeanBrasse run first
  // stopped on "latest-mac.yml is for 2.0.0, not 2.0.1", because release/ of the
  // main checkout keeps the last release's manifest by design. Their scenario,
  // with one change: 2.0.0 is published from these very files and this
  // manifest, as 1.7.1 is from JeanBrasse's release/. In the harness's default, GitHub
  // has 2.0.0 with other bytes: the real run now refuses to build over that, so
  // the dry run must refuse too, and the next test is that case as they wrote it.
  it('passes in the main checkout with the previous release still in release/, as OPERATIONS.md has it run', async () => {
    const { dir } = checkout();
    const kept = path.join(dir, 'release');
    artifacts(kept, '2.0.0');
    gh.setState({ releases: { 'v2.0.0': releasedFrom(kept, '2.0.0') }, latest: 'v2.0.0' });
    const before = inventory(dir);

    const { code, out } = await release(dir, '--dry-run');

    expect(out).toContain(`3. ${fs.realpathSync(kept)} holds the build of 2.0.0: would check the artifacts of ${VERSION} once built`);
    expect(code).toBe(0);
    expect(inventory(dir)).toEqual(before);
    expect(writesToGitHub()).toEqual([]);
  });

  it('refuses, like the real run, when the build release/ holds is not proven published', async () => {
    // The dry run is the command that says whether the release can start: one
    // that passed here would send the real run into the refusal below.
    const { dir } = checkout();
    const kept = path.join(dir, 'release');
    artifacts(kept, '2.0.0');
    const before = inventory(dir);

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`${fs.realpathSync(kept)} holds 2.0.0, which is not proven published (the published Tars-2.0.0-arm64.dmg is not the local file (size differs))`);
    expect(inventory(dir)).toEqual(before);
  });

  it('stops on artifacts that do not match their manifest', async () => {
    const { dir } = checkout();
    artifacts(path.join(dir, 'release'), VERSION, { wrongSha: true });

    const { code, out } = await release(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the sha512 in latest-mac.yml is not that of Tars-${VERSION}-arm64-mac.zip`);
  });
});

describe('npm run release, before it builds', { timeout: 30_000 }, () => {
  // Found by the QA on #99 (S2), and their scenario: in the main checkout the
  // build wrote the manifest, the debug log and the app over those of the
  // build release/ held, before anything checked them, which is how the
  // manifest of 1.6.19 was lost. Only a move from a worktree was guarded.
  it('does not build over an older build that was never published, in the main checkout', async () => {
    const { dir } = checkout();
    fs.writeFileSync(path.join(dir, 'build.js'), "const fs = require('fs'); fs.mkdirSync('release', { recursive: true }); fs.writeFileSync('release/latest-mac.yml', 'version: 2.0.1\\n'); fs.writeFileSync('release/builder-debug.yml', 'debug of 2.0.1');\n");
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.scripts['electron:build'] = 'node build.js';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'a build that writes the manifest, as electron-builder does');
    git(dir, 'push', '-q', 'origin', 'main');
    artifacts(path.join(dir, 'release'), '2.0.0');
    gh.setState({ releases: {}, latest: 'v1.9.9' });
    const before = fs.readFileSync(path.join(dir, 'release', 'latest-mac.yml'), 'utf8');
    const everything = inventory(dir);

    const { code, out } = await release(dir);
    const after = fs.readFileSync(path.join(dir, 'release', 'latest-mac.yml'), 'utf8');

    expect(after).toBe(before);
    expect(code).toBe(1);
    expect(out).toContain(`holds 2.0.0, which is not proven published (there is no release v2.0.0 on ${REPO})`);
    expect(inventory(dir)).toEqual(everything);
    expect(writesToGitHub()).toEqual([]);
  });

  it.each([
    ['a newer version', (dir: string) => artifacts(dir, '2.1.0'), 'holds 2.1.0, newer than 2.0.1'],
    ['a build whose version cannot be read', (dir: string) => {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'builder-debug.yml'), 'x');
    }, 'holds a build whose version cannot be read'],
  ])('refuses a release/ that holds %s', async (_, lay, refusal) => {
    const { dir } = checkout();
    lay(path.join(dir, 'release'));

    const { code, out } = await release(dir, '--dry-run');

    expect(out).toContain(refusal);
    expect(code).toBe(1);
  });

  // Each case runs git, npm and a dozen gh processes: seconds on a busy machine, not milliseconds.
  describe('from a worktree', { timeout: 30_000 }, () => {
    /** A checkout whose build lays out VERSION, and a worktree of origin/main beside it for the release to run in. */
    function worktreeOf() {
      const { root, dir } = checkout();
      buildable(dir);
      const worktree = path.join(root, 'worktree');
      git(dir, 'worktree', 'add', '-q', '--detach', worktree, 'origin/main');
      return { kept: path.join(dir, 'release'), worktree };
    }

    it('does not start a release whose build the kept folder would refuse once it is public, and the dry run says so', async () => {
      // Step 7 refuses this move, and it used to refuse it after gh release
      // create: the release public, its build left in the worktree.
      const { kept, worktree } = worktreeOf();
      artifacts(kept, '2.0.0');
      gh.setState({ releases: {}, latest: 'v1.9.9' });
      gh.allowPublishing();
      const before = inventory(kept);

      for (const argv of [['--dry-run'], []]) {
        const { code, out } = await release(worktree, ...argv);

        expect(out).toContain(`${fs.realpathSync(kept)} holds 2.0.0, which is not proven published`);
        expect(code).toBe(1);
      }
      expect(fs.existsSync(path.join(worktree, 'BUILD_ENV')), 'it built').toBe(false);
      expect(writesToGitHub()).toEqual([]);
      expect(inventory(kept)).toEqual(before);
    });

    it.each([
      ['a file of it', (kept: string) => fs.writeFileSync(path.join(kept, `Tars-${VERSION}-arm64.dmg`), 'an earlier build')],
      ['its manifest', (kept: string) => fs.writeFileSync(path.join(kept, 'latest-mac.yml'), `version: ${VERSION}\n`)],
    ])('does not start a release when the kept folder already holds %s', async (_, lay) => {
      const { kept, worktree } = worktreeOf();
      fs.mkdirSync(kept);
      lay(kept);
      gh.allowPublishing();

      const { code, out } = await release(worktree);

      expect(out).toContain(`${fs.realpathSync(kept)} already holds a build of ${VERSION}`);
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(worktree, 'BUILD_ENV')), 'it built').toBe(false);
      expect(writesToGitHub()).toEqual([]);
    });
  });
});

// Each case runs git, npm and a dozen gh processes: seconds on a busy machine, not milliseconds.
describe('npm run release, publishing', { timeout: 30_000 }, () => {
  it.skipIf(noPlutil())('publishes the build it checked, built without CI, GH_TOKEN or GITHUB_TOKEN', async () => {
    // With any of the three, electron-builder publishes by itself, before step
    // 3 has checked anything. Placeholders only: nothing here reaches GitHub.
    const { dir } = checkout();
    buildable(dir);
    gh.allowPublishing();
    const names = ['CI', 'GH_TOKEN', 'GITHUB_TOKEN'];
    const saved = names.map(name => [name, process.env[name]] as const);
    for (const name of names) process.env[name] = 'set-by-the-test';
    let result: { code: number; out: string };
    try {
      result = await release(dir);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    const kept = path.join(dir, 'release');
    expect(result.out).toContain('6. GitHub serves exactly what was built');
    expect(result.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'BUILD_ENV'), 'utf8')), 'the build was given what lets it publish').toEqual([]);
    const published = gh.state().releases?.[`v${VERSION}`];
    expect(published?.assets).toEqual(releasedFrom(kept, VERSION).assets.map(asset => ({ ...asset, state: 'uploaded' })));
    expect(published?.target).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(published?.notes).toContain("- An agent's change, said the way the app says it");
    expect(result.out).toContain(`9. ${path.join(fs.realpathSync(kept), `Tars-${VERSION}-arm64.dmg`)}`);
  });

  it.skipIf(noPlutil())('builds over an earlier attempt at this same version, never published, and publishes the new build', async () => {
    // A release that stopped after its build leaves that build in release/, and
    // the retry replaces it rather than refusing: nothing of it can be public,
    // since step 1 stops on a release or a tag of this version on GitHub.
    const { dir } = checkout();
    buildable(dir);
    const kept = path.join(dir, 'release');
    artifacts(kept, VERSION, { wrongSha: true });
    gh.allowPublishing();

    const { code, out } = await release(dir);

    expect(out).toContain(`2. npm run electron:build, without CI, GH_TOKEN or GITHUB_TOKEN, over an earlier build of ${VERSION}, which was never published`);
    expect(code).toBe(0);
    expect(gh.state().releases?.[`v${VERSION}`]?.assets).toEqual(releasedFrom(kept, VERSION).assets.map(asset => ({ ...asset, state: 'uploaded' })));
  });

  it('cannot publish into the fake gh unless the test allows it', () => {
    // What every other test here relies on: none of them calls allowPublishing().
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-gate-'));
    const manifest = path.join(dir, 'latest-mac.yml');
    const notes = path.join(dir, 'notes.md');
    fs.writeFileSync(manifest, `version: ${VERSION}\n`);
    fs.writeFileSync(notes, 'notes');
    const create = () => execFileSync('gh', ['release', 'create', `v${VERSION}`, manifest, '--repo', REPO, '--notes-file', notes], { stdio: 'pipe' });

    let status: number | null = null;
    try {
      create();
    } catch (err) {
      status = (err as { status: number | null }).status;
    }
    expect(status).toBe(99);
    expect(gh.state().releases?.[`v${VERSION}`]).toBeUndefined();

    gh.allowPublishing();
    create();
    expect(gh.state().releases?.[`v${VERSION}`]?.assets.map(asset => asset.name)).toEqual(['latest-mac.yml']);
  });

  it.skipIf(noPlutil()).each([
    ['its tag on another commit', { target: 'f'.repeat(40) }, `v${VERSION} points at ${'f'.repeat(40)}, not at the commit built`],
    ['the dmg with other bytes', { digests: { [`Tars-${VERSION}-arm64.dmg`]: sha256('other bytes') } }, `GitHub serves Tars-${VERSION}-arm64.dmg with ${sha256('other bytes')}`],
    ['another latest-mac.yml', { manifest: `version: ${VERSION}\n` }, 'the latest-mac.yml GitHub serves is not the one checked'],
    ['another release as the latest', { latest: 'v2.0.0' }, `/releases/latest is v2.0.0, not v${VERSION}`],
  ])('stops, once published, on GitHub serving %s, and goes no further', async (_, serve, refusal) => {
    const { dir } = checkout();
    buildable(dir);
    gh.setState({ ...BEFORE, serve });
    gh.allowPublishing();

    const { code, out } = await release(dir);

    expect(out).toContain(`5. published v${VERSION}`);
    expect(out).toContain(refusal);
    expect(code).toBe(1);
    expect(out).not.toMatch(/^[6-9]\. /m);
  });
});

describe('checking a build against its manifest', () => {
  /** A consistent build of VERSION, then one thing in it made wrong. */
  function build(edit: (releaseDir: string) => void): string {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-verify-'));
    artifacts(releaseDir, VERSION);
    edit(releaseDir);
    return releaseDir;
  }

  const rewrite = (file: string, from: string, to: string) => {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) throw new Error(`${from} is not in ${file}`);
    fs.writeFileSync(file, text.replace(from, to));
  };

  it.skipIf(noPlutil())('accepts the build as the harness lays it out, so each refusal below is its own check', async () => {
    await expect(verifyArtifacts(build(() => {}), VERSION)).resolves.toMatchObject({ yml: expect.stringMatching(/latest-mac\.yml$/) });
  });

  it('stops on a manifest written for another version', async () => {
    // The updater compares this field to the running app: a manifest that
    // says 2.0.0 offers every installed 2.0.0 nothing to update to.
    const releaseDir = build(dir => rewrite(path.join(dir, 'latest-mac.yml'), `version: ${VERSION}`, 'version: 2.0.0'));

    await expect(verifyArtifacts(releaseDir, VERSION)).rejects.toThrow(`latest-mac.yml is for 2.0.0, not ${VERSION}`);
  });

  it('stops on a size in the manifest that is not the file', async () => {
    // The dmg and the zip of the harness have the same length, so the entry is
    // found by its url rather than by the size it carries.
    const dmgBytes = Buffer.byteLength(`dmg of ${VERSION}`);
    const releaseDir = build(dir => {
      const yml = path.join(dir, 'latest-mac.yml');
      const entry = new RegExp(`(  - url: Tars-${VERSION.replace(/\./g, '\\.')}-arm64\\.dmg\\n    sha512: [^\\n]+\\n    size: )${dmgBytes}\\n`);
      const text = fs.readFileSync(yml, 'utf8');
      if (!entry.test(text)) throw new Error(`no dmg entry of ${dmgBytes} bytes in ${yml}`);
      fs.writeFileSync(yml, text.replace(entry, `$1${dmgBytes + 1}\n`));
    });

    await expect(verifyArtifacts(releaseDir, VERSION)).rejects.toThrow(`latest-mac.yml gives Tars-${VERSION}-arm64.dmg ${dmgBytes + 1} bytes, the file has ${dmgBytes}`);
  });

  it.skipIf(noPlutil())('stops on a built app that says another version', async () => {
    const releaseDir = build(dir => rewrite(path.join(dir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist'), `<string>${VERSION}</string>`, '<string>2.0.0</string>'));

    await expect(verifyArtifacts(releaseDir, VERSION)).rejects.toThrow(`the built app says 2.0.0, not ${VERSION}`);
  });
});

// Three cases run git and the move for real: 1.1 to 2.8 s a case alone
// (2026-10-05, load average 47 to 56), and "replaces an older published
// build's manifest" was cut at vitest's 5 s in a full suite that night.
describe('moving a build into the release/ that is kept', { timeout: 30_000 }, () => {
  function folders() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-move-'));
    const fromDir = path.join(root, 'worktree-release');
    const toDir = path.join(root, 'kept-release');
    fs.mkdirSync(fromDir);
    fs.mkdirSync(toDir);
    return { fromDir, toDir };
  }

  const listing = (dir: string) => fs.readdirSync(dir).sort();

  it('will not overwrite a file of this version that has other bytes', async () => {
    const { fromDir, toDir } = folders();
    const { dmg } = artifacts(fromDir, VERSION);
    fs.writeFileSync(path.join(toDir, dmg), 'another build of the same version');
    const before = [listing(fromDir), listing(toDir)];

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO })).rejects.toThrow(Refusal);

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(toDir, dmg), 'utf8')).toBe('another build of the same version');
  });

  it('will not take the place of another build of this version whose manifest differs, and deletes nothing', async () => {
    // Step 7 runs after the release is public: dropping the manifest built here
    // because one of the same version is already there would throw away the
    // manifest GitHub now serves. Only a kept manifest with the very same bytes
    // lets it go.
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    artifacts(toDir, VERSION, { wrongSha: true });
    const before = [listing(fromDir), listing(toDir)];
    const manifest = fs.readFileSync(path.join(fromDir, 'latest-mac.yml'), 'utf8');

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO }))
      .rejects.toThrow(`${toDir} already holds another build of ${VERSION}: not overwritten`);

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(fromDir, 'latest-mac.yml'), 'utf8')).toBe(manifest);
  });

  it('will not overwrite the build of an older version GitHub does not prove published', async () => {
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    artifacts(toDir, '2.0.0');
    gh.setState({ latest: 'v1.9.9' });
    const before = [listing(fromDir), listing(toDir)];

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO }))
      .rejects.toThrow('holds 2.0.0, which is not proven published');

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(toDir, 'latest-mac.yml'), 'utf8')).toContain('version: 2.0.0');
  });

  it('will not replace the manifest of a published older version when it is not the manifest GitHub serves', async () => {
    // The version is published with this dmg and this zip, but the
    // latest-mac.yml beside them is another one: the local copy may be the
    // only right one left, which is how 1.6.19's was lost.
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    const old = artifacts(toDir, '2.0.0');
    gh.setState({
      releases: {
        'v2.0.0': {
          assets: [
            { name: old.dmg, size: Buffer.byteLength(old.dmgBytes), digest: sha256(old.dmgBytes) },
            { name: old.zip, size: Buffer.byteLength(old.zipBytes), digest: sha256(old.zipBytes) },
            { name: 'latest-mac.yml', size: 1, digest: sha256('the manifest that was published') },
          ],
        },
      },
    });
    const before = [listing(fromDir), listing(toDir)];

    await expect(moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO }))
      .rejects.toThrow('the latest-mac.yml of 2.0.0 in');

    expect([listing(fromDir), listing(toDir)]).toEqual(before);
    expect(fs.readFileSync(path.join(toDir, 'latest-mac.yml'), 'utf8')).toContain('version: 2.0.0');
  });

  it("replaces an older published build's manifest and app, and moves rather than copies", async () => {
    const { fromDir, toDir } = folders();
    artifacts(fromDir, VERSION);
    const old = artifacts(toDir, '2.0.0');
    gh.setState({
      releases: {
        'v2.0.0': {
          assets: [
            { name: old.dmg, size: Buffer.byteLength(old.dmgBytes), digest: sha256(old.dmgBytes) },
            { name: old.zip, size: Buffer.byteLength(old.zipBytes), digest: sha256(old.zipBytes) },
            { name: 'latest-mac.yml', size: 1, digest: sha256(fs.readFileSync(path.join(toDir, 'latest-mac.yml'))) },
          ],
        },
      },
    });

    const { moved } = await moveToCanonical({ fromDir, toDir, version: VERSION, repo: REPO });

    expect(moved).toContain(`Tars-${VERSION}-arm64.dmg`);
    expect(listing(fromDir)).toEqual([]);
    expect(fs.readFileSync(path.join(toDir, 'latest-mac.yml'), 'utf8')).toContain(`version: ${VERSION}`);
    expect(fs.readFileSync(path.join(toDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist'), 'utf8')).toContain(VERSION);
    // The older version's own files are the purge's business, not the move's.
    expect(listing(toDir)).toContain(old.dmg);
  });
});
