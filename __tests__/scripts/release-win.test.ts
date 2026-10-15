import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fakeGh, publishedAssets, sha256, type FakeGh, type FakeGhState } from './fake-gh';
import {
  artifactNames, buildEnv, builderArgs, buildSteps, main, NEVER_LOADED, parseArgs, readAsarFile,
  verifyWindowsArtifacts, windowsBuilderConfig,
} from '../../scripts/release-win.mjs';
import { publishRepo } from '../../scripts/prune-releases.mjs';
import { Refusal } from '../../scripts/release.mjs';

/**
 * `npm run release:win`: the Windows build of a version `npm run release` has
 * released, added to that same release, which every installed Tars reads.
 *
 * How it can fail, each case below:
 *  - the arguments: anything but --dry-run taken, such as a --publish or a
 *    build number that would release a version of its own;
 *  - the version: anything but package.json's, so the app, the installer's
 *    name and latest.yml say another version than macOS's;
 *  - the build: a step missing or out of order (the renderer, main, the seven
 *    MCP bundles, electron-builder last), an MCP bundle not built, the build
 *    left able to publish by itself (CI, GH_TOKEN, GITHUB_TOKEN), or --mac;
 *  - the artifacts: a latest.yml for another version, or whose size or sha512
 *    is not the installer's, no blockmap, a feed that is not build.publish, a
 *    node-pty without its ConPTY binaries, a hook or an MCP bundle missing, an
 *    app that says another version, an app that ships what it never loads
 *    (next, the @next/swc compiler, sharp, another platform's native prebuilds,
 *    sqlite's sources), packed in the asar or beside it;
 *  - the release: anything written to GitHub in a dry run; a build from a
 *    commit that is not origin/main, or from a tree that differs from it; the
 *    Windows files added to a version that is not released, to a release whose
 *    tag is on another commit than the one built, to one that is no longer the
 *    latest, over Windows files already there, or as a release of their own;
 *    latest.yml uploaded before the installer it names; a GitHub it cannot ask
 *    taken for a pass; what GitHub serves not read back (the installer's
 *    digest, the tag, the latest release), or an annotated tag not followed to
 *    its commit;
 *  - GitHub changing during the minutes of the build (a newer release, a
 *    Windows file, the tag moved) and the upload going ahead regardless;
 *  - npm not found to run the build reported as a crash rather than a refusal.
 * No test runs electron-builder or reaches GitHub: the build is a function that
 * lays files out, and gh is the fake.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = '1.9.6';
const REPO = 'acme/tars';
const PKG = { ...REAL_PKG, version: VERSION, build: { ...REAL_PKG.build, publish: { provider: 'github', owner: 'acme', repo: 'tars' } } };
/** The MCP bundles among package.json's extra resources: the state mod beside them (mods/tars-state) has no build. */
const MCPS = REAL_PKG.build.extraResources.map((e: { from: string }) => e.from).filter((from: string) => from.startsWith('mcp-'));
const WINDOWS_FILES = [`Tars-Setup-${VERSION}.exe`, `Tars-Setup-${VERSION}.exe.blockmap`, `Tars-Windows-${VERSION}-x64.zip`, 'latest.yml'];

describe('what it is asked', () => {
  it('reads --dry-run, and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    for (const argv of [['--publish'], ['--n', '3'], ['--dry']]) expect(() => parseArgs(argv)).toThrow(Refusal);
  });

  it('hands electron-builder the Windows config, for Windows, never publishing by itself, and no version of its own', () => {
    const args = builderArgs('C:\\repo\\build\\electron-builder-win.json');
    expect(args).toContain('--win');
    expect(args).not.toContain('--mac');
    expect(args.join(' ')).toContain('--publish never');
    expect(args.join(' ')).toContain('--config C:\\repo\\build\\electron-builder-win.json');
    expect(args.some((a: string) => a.includes('version'))).toBe(false);
  });

  it('feeds from build.publish, the repository macOS releases to: package.json has no Windows feed of its own', () => {
    expect(REAL_PKG.build.win.publish).toBeUndefined();
    expect(publishRepo(ROOT)).toBe(`${REAL_PKG.build.publish.owner}/${REAL_PKG.build.publish.repo}`);
  });

  it('names the installer and the zip from package.json, with its version and nothing added', () => {
    expect(artifactNames(REAL_PKG, VERSION)).toEqual({
      setup: `Tars-Setup-${VERSION}.exe`,
      blockmap: `Tars-Setup-${VERSION}.exe.blockmap`,
      zip: `Tars-Windows-${VERSION}-x64.zip`,
      yml: 'latest.yml',
    });
  });
});

describe('the Windows build config', () => {
  // electron-builder's own matcher, the one it filters the app's files with.
  const { Minimatch } = createRequire(require.resolve('app-builder-lib'))('minimatch') as {
    Minimatch: new (pattern: string, options: object) => { match(path: string): boolean };
  };
  const excluded = (file: string, patterns: string[]) => patterns.filter(p => p.startsWith('!'))
    .some(p => new Minimatch(p.slice(1), { dot: true }).match(file));

  it('is package.json build as it is, files included, with only what the app never loads left out', () => {
    const before = JSON.stringify(REAL_PKG);
    const config = windowsBuilderConfig(REAL_PKG);
    expect(JSON.stringify(REAL_PKG)).toBe(before);
    const { files, ...rest } = config;
    const { files: ownFiles, ...ownRest } = REAL_PKG.build;
    expect(rest).toEqual(ownRest);
    expect(files.slice(0, ownFiles.length)).toEqual(ownFiles);
    expect(files.slice(ownFiles.length).every((p: string) => p.startsWith('!'))).toBe(true);
    // The extra resources with it: the state mod Claude Code loads ships beside the MCP bundles.
    expect(config.extraResources.map((e: { from: string }) => e.from)).toContain('mods/tars-state');
  });

  it('leaves out every path the artifact check refuses, and none the app loads', () => {
    const { files } = windowsBuilderConfig(REAL_PKG);
    for (const never of [
      'node_modules/next/dist/server/next.js', 'node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node',
      'node_modules/@next/env/dist/index.js', 'node_modules/sharp/lib/index.js', 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
      'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c', 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
      'node_modules/better-sqlite3/prebuilds/linux-x64.node', 'node_modules/better-sqlite3/prebuilds/linuxmusl-arm64.node',
      'node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
    ]) {
      expect(NEVER_LOADED.some(p => p.test(never)), `${never} is not what the artifact check refuses`).toBe(true);
      expect(excluded(never, files), `${never} is packed`).toBe(true);
    }
    for (const kept of [
      'node_modules/better-sqlite3/prebuilds/win32-x64.node', 'node_modules/better-sqlite3/lib/index.js',
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', 'node_modules/node-pty/lib/index.js',
      'node_modules/xterm-headless/package.json', 'node_modules/electron-updater/out/main.js', 'node_modules/nextjs-like/index.js',
    ]) {
      expect(excluded(kept, files), `${kept} is left out`).toBe(false);
      expect(NEVER_LOADED.some(p => p.test(kept)), `${kept} would be refused`).toBe(false);
    }
  });
});

describe('the build it runs', () => {
  it('icon, renderer, main, each MCP bundle, then electron-builder last', () => {
    const steps = buildSteps(ROOT);
    const labels = steps.map(s => s.label);
    expect(labels[0]).toMatch(/icon/);
    expect(labels[1]).toMatch(/build:renderer/);
    expect(labels[2]).toMatch(/tsc/);
    expect(labels.at(-1)).toMatch(/electron-builder/);
    // The seven MCP bundles package.json ships, each installed then built in its own folder.
    expect(MCPS).toHaveLength(7);
    for (const mcp of MCPS) {
      const own = steps.filter(s => s.cwd === path.join(ROOT, mcp));
      expect(own.map(s => s.label)).toEqual([`${mcp}: npm install`, `${mcp}: npm run build`]);
    }
    expect(steps.at(-1)!.args).toEqual(expect.arrayContaining(builderArgs(path.join(ROOT, 'build', 'electron-builder-win.json'))));
    // No step is a shell string: every one is a command and its argv.
    for (const s of steps) expect(Array.isArray(s.args)).toBe(true);
  });

  it('runs without CI, GH_TOKEN or GITHUB_TOKEN, and keeps the rest', () => {
    const env = buildEnv({ CI: '1', GH_TOKEN: 't', GITHUB_TOKEN: 't', PATH: 'p', USERPROFILE: 'u' });
    expect(env).toEqual({ PATH: 'p', USERPROFILE: 'u' });
  });
});

// ── A Windows build laid out as electron-builder does ─────────────────────

const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('base64');

/** An asar with these files, in the format @electron/asar writes. */
function writeAsar(file: string, files: Record<string, string>) {
  type Node = { files?: Record<string, Node>; size?: number; offset?: string };
  const header: Node = { files: {} };
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const parts = name.split('/');
    let dir = header;
    for (const part of parts.slice(0, -1)) dir = (dir.files![part] ??= { files: {} });
    dir.files![parts.at(-1)!] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(pickle.length, 4);
  fs.writeFileSync(file, Buffer.concat([size, pickle, ...bodies]));
}

type Breakage = {
  ymlVersion?: string; wrongSha?: boolean; noBlockmap?: boolean; feedOwner?: string; noConpty?: boolean;
  noHook?: boolean; noMcp?: string; appVersion?: string;
  /** A file the app never loads, packed in the asar or unpacked beside it. */
  packed?: string; unpacked?: string;
};

function winBuild(releaseDir: string, version: string, broken: Breakage = {}) {
  const names = artifactNames(PKG, version);
  const setupBytes = `installer of ${version}`;
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, names.setup), setupBytes);
  if (!broken.noBlockmap) fs.writeFileSync(path.join(releaseDir, names.blockmap), 'blockmap');
  fs.writeFileSync(path.join(releaseDir, names.zip), `zip of ${version}`);
  fs.writeFileSync(path.join(releaseDir, 'builder-debug.yml'), 'x');
  const sha = broken.wrongSha ? sha512('other') : sha512(setupBytes);
  fs.writeFileSync(path.join(releaseDir, 'latest.yml'), [
    `version: ${broken.ymlVersion ?? version}`,
    'files:',
    `  - url: ${names.setup}`,
    `    sha512: ${sha}`,
    `    size: ${Buffer.byteLength(setupBytes)}`,
    `path: ${names.setup}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-10-09T10:00:00.000Z'",
    '',
  ].join('\n'));
  const app = path.join(releaseDir, 'win-unpacked');
  const res = path.join(app, 'resources');
  const unpacked = path.join(res, 'app.asar.unpacked');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(app, 'Tars.exe'), 'exe');
  fs.writeFileSync(path.join(res, 'app-update.yml'),
    `owner: ${broken.feedOwner ?? 'acme'}\nrepo: tars\nprovider: github\nupdaterCacheDirName: tars-updater\n`);
  writeAsar(path.join(res, 'app.asar'), {
    'package.json': JSON.stringify({ name: 'tars', version: broken.appVersion ?? version }),
    'node_modules/xterm/package.json': '{}',
    ...(broken.packed ? { [broken.packed]: 'x' } : {}),
  });
  const put = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(unpacked, rel)), { recursive: true });
    fs.writeFileSync(path.join(unpacked, rel), 'x');
  };
  put('node_modules/node-pty/prebuilds/win32-x64/pty.node');
  put('node_modules/node-pty/prebuilds/win32-x64/conpty.node');
  if (!broken.noConpty) {
    put('node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll');
    put('node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe');
  }
  put('node_modules/better-sqlite3/prebuilds/win32-x64.node');
  if (broken.unpacked) put(broken.unpacked);
  for (const hook of ['tars-hook.mjs', 'tars-hook-lib.mjs', 'statusline.mjs']) {
    if (!(broken.noHook && hook === 'tars-hook.mjs')) put(`hooks/${hook}`);
  }
  for (const mcp of MCPS) {
    if (mcp === broken.noMcp) continue;
    fs.mkdirSync(path.join(res, mcp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(res, mcp, 'dist', 'bundle.js'), '//');
  }
}

describe('the artifacts it checks', () => {
  let dir: string;
  const verify = () => verifyWindowsArtifacts(dir, VERSION, { repo: REPO, pkg: PKG });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-win-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a consistent build, so each refusal below is the check it names', async () => {
    winBuild(dir, VERSION);
    const found = await verify();
    expect(path.basename(found.setup)).toBe(`Tars-Setup-${VERSION}.exe`);
    expect(path.basename(found.yml)).toBe('latest.yml');
  });

  it.each<[string, Breakage, RegExp]>([
    ['a latest.yml for another version', { ymlVersion: '1.9.5' }, /latest\.yml is for 1\.9\.5/],
    ['a sha512 that is not the installer', { wrongSha: true }, /sha512/],
    ['no blockmap', { noBlockmap: true }, /blockmap/],
    ['a feed that is not build.publish', { feedOwner: 'someone-else' }, /app-update\.yml/],
    ['node-pty without its ConPTY binaries', { noConpty: true }, /conpty\.dll/],
    ['a hook missing', { noHook: true }, /tars-hook\.mjs/],
    ['an MCP bundle missing', { noMcp: 'mcp-kanban' }, /mcp-kanban/],
    ['an app that says another version', { appVersion: '1.9.5' }, /says 1\.9\.5/],
    ['next packed in the asar', { packed: 'node_modules/next/dist/server/next.js' }, /node_modules\/next\//],
    ['the @next/swc compiler unpacked', { unpacked: 'node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node' }, /node_modules\/@next\//],
    ['sharp\'s libvips unpacked', { unpacked: 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll' }, /node_modules\/@img\//],
    ['sharp itself packed', { packed: 'node_modules/sharp/lib/index.js' }, /node_modules\/sharp\//],
    ['a macOS better-sqlite3 prebuild', { unpacked: 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node' }, /darwin-arm64/],
    ['a Linux better-sqlite3 prebuild', { unpacked: 'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node' }, /linuxmusl-x64/],
    ['sqlite\'s sources', { unpacked: 'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c' }, /better-sqlite3\/deps/],
    ['a macOS node-pty prebuild', { unpacked: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node' }, /darwin-arm64/],
  ])('refuses %s', async (_what, broken, message) => {
    winBuild(dir, VERSION, broken);
    await expect(verify()).rejects.toThrow(message);
  });

  it('reads a file out of an asar', () => {
    const asar = path.join(dir, 'a.asar');
    writeAsar(asar, { 'a.txt': 'first', 'package.json': '{"version":"9"}' });
    expect(readAsarFile(asar, 'package.json').toString()).toBe('{"version":"9"}');
    expect(() => readAsarFile(asar, 'missing.json')).toThrow(/missing\.json/);
  });
});

// ── main(), in a checkout of its own ─────────────────────────────────────

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

/** A checkout of `main` pushed to a local origin, with the real package.json's build config at VERSION, published to REPO. */
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-win-co-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'checkout');
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tars', version: VERSION, build: PKG.build, devDependencies: { electron: '^44.4.4' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'tars', version: VERSION, lockfileVersion: 3,
    packages: { '': { name: 'tars', version: VERSION }, 'node_modules/electron': { version: '44.4.4', dev: true } },
  }));
  const electron = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(path.join(electron, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '44.4.4' }));
  fs.writeFileSync(path.join(electron, 'dist', 'version'), '44.4.4');
  fs.writeFileSync(path.join(dir, 'src', 'data', 'changelog.ts'),
    `export const CHANGELOG = [{ id: 1, version: '${VERSION}', date: '2026-10-09', updates: ['What changed in ${VERSION}'] }];\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'release/\nbuild/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { root, dir, head: git(dir, 'rev-parse', 'HEAD').trim() };
}

/** GitHub after `npm run release` of VERSION on `head`: the macOS files, the latest release. */
function releasedOnMac(head: string, extra: FakeGhState = {}): FakeGhState {
  return {
    releases: { [`v${VERSION}`]: { assets: [...publishedAssets(VERSION), { name: 'latest-mac.yml', size: 1, digest: sha256('m') }], target: head } },
    latest: `v${VERSION}`,
    ...extra,
  };
}

// Real git checkouts and a fake gh per case: well past vitest's 5 s default on a loaded machine.
describe('npm run release:win', { timeout: 60_000 }, () => {
  let gh: FakeGh;
  let roots: string[];
  let built: { version: string; env: Record<string, string | undefined>; config: unknown }[];

  /** What GitHub does while the build runs, which takes minutes for real. */
  let duringBuild: (() => void) | undefined;

  /** The build: records what it was asked, and lays out a consistent build of the checkout's version. */
  const build = async (_steps: { args: string[] }[], { root, env }: { root: string; env: Record<string, string | undefined> }) => {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const config = JSON.parse(fs.readFileSync(path.join(root, 'build', 'electron-builder-win.json'), 'utf8'));
    built.push({ version, env, config });
    winBuild(path.join(root, 'release'), version);
    duringBuild?.();
  };

  async function releaseWin(cwd: string, ...argv: string[]) {
    return releaseWinWith(cwd, argv, {});
  }

  async function releaseWinWith(cwd: string, argv: string[], deps: { npmCommand?: () => never }) {
    const lines: string[] = [];
    const code = await main(argv, { cwd, log: (line: string) => lines.push(line), build, ...deps });
    return { code, out: lines.join('\n') };
  }

  const writes = () => gh.calls().filter(args => !['view', 'list', 'download'].includes(args[1]) && args[0] !== 'api');

  beforeEach(() => {
    gh = fakeGh({});
    gh.install();
    roots = [];
    built = [];
    duringBuild = undefined;
  });
  afterEach(() => {
    gh.uninstall();
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  const co = () => {
    const made = checkout();
    roots.push(made.root);
    return made;
  };

  it('adds the installer, its blockmap and the zip, then latest.yml, to the release macOS made, on the commit built', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));
    gh.allowPublishing();
    const before = fs.readFileSync(path.join(dir, 'package.json'));

    const { code, out } = await releaseWin(dir);

    expect(out).toContain('GitHub serves exactly what was built');
    expect(code).toBe(0);
    // package.json's own version, built without anything that lets electron-builder publish.
    expect(built.map(b => b.version)).toEqual([VERSION]);
    expect(built[0].env).not.toHaveProperty('GH_TOKEN');
    expect(built[0].config).toEqual(windowsBuilderConfig(JSON.parse(before.toString())));
    expect(fs.readFileSync(path.join(dir, 'package.json')).equals(before)).toBe(true);
    // Two uploads to the existing release, latest.yml last; never a release of its own.
    const release = path.join(dir, 'release');
    expect(writes()).toEqual([
      ['release', 'upload', `v${VERSION}`, path.join(release, `Tars-Setup-${VERSION}.exe`), path.join(release, `Tars-Setup-${VERSION}.exe.blockmap`),
        path.join(release, `Tars-Windows-${VERSION}-x64.zip`), '--repo', REPO],
      ['release', 'upload', `v${VERSION}`, path.join(release, 'latest.yml'), '--repo', REPO],
    ]);
    const served = gh.state().releases![`v${VERSION}`];
    expect(served.target).toBe(head);
    expect(served.assets.map(a => a.name)).toEqual([`Tars-${VERSION}-arm64.dmg`, `Tars-${VERSION}-arm64-mac.zip`, 'latest-mac.yml', ...WINDOWS_FILES]);
    expect(served.assets.find(a => a.name === 'latest.yml')!.digest).toBe(sha256(fs.readFileSync(path.join(release, 'latest.yml'))));
  });

  it('dry run: checks the release on GitHub, builds and writes nothing', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));

    const { code, out } = await releaseWin(dir, '--dry-run');

    expect(code).toBe(0);
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'build'))).toBe(false);
    expect(out).toMatch(/would build for Windows/);
    expect(out).toMatch(new RegExp(`would run gh release upload v${VERSION.replace(/\./g, '\\.')} .*Tars-Setup-${VERSION.replace(/\./g, '\\.')}\\.exe`));
    expect(out).toMatch(/no Windows build in .* yet/);
  });

  it('dry run: checks the Windows build of this version release/ holds', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));
    winBuild(path.join(dir, 'release'), VERSION, { appVersion: '1.9.5' });

    const { code, out } = await releaseWin(dir, '--dry-run');

    expect(code).toBe(1);
    expect(out).toContain(`the built app says 1.9.5, not ${VERSION}`);
    expect(writes()).toEqual([]);
  });

  it.each<[string, (head: string) => FakeGhState, RegExp]>([
    ['a version npm run release has not released', () => ({}), /v1\.9\.6 is not released on acme\/tars: npm run release publishes it first/],
    ['a release whose tag is on another commit', () => releasedOnMac('f'.repeat(40)), /v1\.9\.6 points at f{40}, not at HEAD/],
    ['a release that is no longer the latest', head => releasedOnMac(head, { latest: 'v1.9.7' }), /the latest release on acme\/tars is v1\.9\.7, not v1\.9\.6/],
    ['a release that already carries latest.yml', head => {
      const state = releasedOnMac(head);
      state.releases![`v${VERSION}`].assets.push({ name: 'latest.yml', size: 1, digest: sha256('w') });
      return state;
    }, /already carries latest\.yml/],
    ['a release that carries the installer of an attempt that stopped', head => {
      const state = releasedOnMac(head);
      state.releases![`v${VERSION}`].assets.push({ name: `Tars-Setup-${VERSION}.exe`, size: 1, digest: sha256('w') });
      return state;
    }, /already carries Tars-Setup-1\.9\.6\.exe.*delete-asset/],
    ['a GitHub it cannot ask', () => ({ offline: true }), /could not read v1\.9\.6 on acme\/tars: error connecting/],
  ])('refuses %s, before building, in a dry run as in a real one', async (_what, state, message) => {
    for (const argv of [['--dry-run'], []]) {
      const { dir, head } = co();
      gh.setState(state(head));
      gh.allowPublishing();
      const { code, out } = await releaseWin(dir, ...argv);
      expect(code).toBe(1);
      expect(out).toMatch(message);
    }
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('refuses a HEAD that is not origin/main, before asking GitHub or building', async () => {
    const { dir, head } = co();
    fs.writeFileSync(path.join(dir, 'README.md'), 'not pushed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local only');
    gh.setState(releasedOnMac(head));
    gh.allowPublishing();

    const { code, out } = await releaseWin(dir);

    expect(code).toBe(1);
    expect(out).toContain('is not origin/main');
    expect(gh.calls()).toEqual([]);
    expect(built).toEqual([]);
  });

  it('refuses a tracked file that differs from HEAD', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...PKG, version: '1.9.7' }));
    const { code, out } = await releaseWin(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/tracked files differ/);
    expect(built).toEqual([]);
  });

  it('stops when GitHub serves another latest.yml than the one checked', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head, { serve: { manifest: `version: ${VERSION}\n` } }));
    gh.allowPublishing();

    const { code, out } = await releaseWin(dir);

    expect(code).toBe(1);
    expect(out).toContain('the latest.yml GitHub serves is not the one checked');
  });

  it.each<[string, (head: string) => FakeGhState, RegExp]>([
    ['the installer with other bytes', head => releasedOnMac(head, { serve: { digests: { [`Tars-Setup-${VERSION}.exe`]: sha256('other bytes') } } }),
      /GitHub serves Tars-Setup-1\.9\.6\.exe with sha256:[0-9a-f]+, the local file is sha256:/],
    ['its tag on another commit once uploaded', head => releasedOnMac(head, { serveAfterUpload: { target: 'f'.repeat(40) } }),
      /v1\.9\.6 points at f{40}, not at the commit built/],
    ['another release as the latest once uploaded', head => releasedOnMac(head, { serveAfterUpload: { latest: 'v1.9.7' } }),
      /\/releases\/latest is v1\.9\.7, not v1\.9\.6/],
  ])('stops, once uploaded, on GitHub serving %s', async (_what, state, message) => {
    const { dir, head } = co();
    gh.setState(state(head));
    gh.allowPublishing();

    const { code, out } = await releaseWin(dir);

    expect(code).toBe(1);
    expect(out).toMatch(message);
    expect(out).not.toContain('GitHub serves exactly what was built');
    expect(writes().map(args => args.slice(0, 3))).toEqual([['release', 'upload', `v${VERSION}`], ['release', 'upload', `v${VERSION}`]]);
  });

  it.each<[string, (state: FakeGhState) => void, RegExp]>([
    ['a newer release made the latest', state => {
      state.releases!['v1.9.7'] = { assets: [] };
      state.latest = 'v1.9.7';
    }, /the latest release on acme\/tars is v1\.9\.7, not v1\.9\.6/],
    ['a Windows file added to the release', state => {
      state.releases![`v${VERSION}`].assets.push({ name: 'latest.yml', size: 1, digest: sha256('w') });
    }, /already carries latest\.yml/],
    ['its tag moved to another commit', state => {
      state.serve = { target: 'e'.repeat(40) };
    }, /v1\.9\.6 points at e{40}, not at HEAD/],
  ])('checks GitHub again once built, and uploads nothing when meanwhile %s', async (_what, change, message) => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));
    gh.allowPublishing();
    duringBuild = () => {
      const state = gh.state();
      change(state);
      gh.setState(state);
    };

    const { code, out } = await releaseWin(dir);

    expect(code).toBe(1);
    expect(out).toMatch(message);
    expect(built).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it('follows an annotated tag to its commit, before the build and after the upload', async () => {
    const onHead = co();
    gh.setState(releasedOnMac(onHead.head, { annotatedTags: true }));
    gh.allowPublishing();
    const passed = await releaseWin(onHead.dir);
    expect(passed.out).toContain('GitHub serves exactly what was built');
    expect(passed.code).toBe(0);
    expect(gh.calls().filter(args => args[0] === 'api' && /\/git\/tags\//.test(args[1])).length).toBeGreaterThanOrEqual(2);

    const elsewhere = co();
    gh.setState(releasedOnMac('d'.repeat(40), { annotatedTags: true }));
    const refused = await releaseWin(elsewhere.dir);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/v1\.9\.6 points at d{40}, not at HEAD/);
  });

  it('says why it stopped, and builds nothing, when npm cannot be found to run the build', async () => {
    const { dir, head } = co();
    gh.setState(releasedOnMac(head));
    gh.allowPublishing();
    const npmCommand = (): never => {
      throw new Error('cannot find npm-cli.js to run npm without a shell: looked at C:\\nowhere');
    };
    for (const argv of [['--dry-run'], []]) {
      const { code, out } = await releaseWinWith(dir, argv, { npmCommand });
      expect(code).toBe(1);
      expect(out).toContain('release:win: stopped. cannot find npm-cli.js to run npm without a shell');
    }
    expect(built).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
