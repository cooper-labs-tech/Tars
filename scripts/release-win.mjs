#!/usr/bin/env node
/**
 * `npm run release:win`: the Windows half of a release, added to the release
 * `npm run release` has published.
 *
 *   npm run release:win -- --dry-run   the checks, the artifacts of this version if built; nothing else
 *   npm run release:win                build on Windows and add the Windows files to v<version>
 *
 * A version is released once, for both platforms. `npm run release`, on a
 * Mac, publishes v<version> with the dmg, the zip and latest-mac.yml. This,
 * on Windows and from the same commit, builds the Windows app and adds its
 * installer, the installer's blockmap, the zip and latest.yml to that same
 * release. Both read package.json build.publish, the repository GITHUB_REPO
 * names too, so an installed Windows build updates from the releases macOS
 * updates from, and carries the same version.
 *
 * In this order, stopping at the first thing that is not as it should be:
 *   1. HEAD is origin/main after a fetch, the tracked tree is clean, the
 *      electron installed is the one locked; and on GitHub, v<version> is
 *      released, its tag is on HEAD, it is the latest release, and it carries
 *      none of the Windows files yet. A GitHub it cannot ask is a refusal;
 *   2. the build, what `npm run electron:build` does for macOS, for Windows:
 *      the app icon (scripts/make-app-ico.mjs), `npm run build:renderer`, the
 *      main process, the MCP bundles package.json ships (npm install and npm
 *      run build in each), then electron-builder --win --x64 with
 *      build/electron-builder-win.json (package.json build, leaving out of
 *      node_modules what the app never loads), never publishing by itself (no
 *      CI, GH_TOKEN, GITHUB_TOKEN; --publish never);
 *   3. the artifacts: latest.yml names this version and the installer with its
 *      size and sha512, the blockmap and the zip exist, the app says this
 *      version, its app-update.yml feeds from build.publish, what the packaged
 *      app runs from disk is unpacked (node-pty with ConPTY, better-sqlite3,
 *      the Node hooks, every MCP bundle), and nothing it never loads is
 *      shipped (next, @next/swc, sharp, other platforms' prebuilds);
 *   4. GitHub asked again what step 1 asked of it, since the build takes
 *      minutes; then gh release upload v<version>: the installer, its
 *      blockmap and the zip, then latest.yml, so that no installed Tars reads
 *      a latest.yml whose installer is not there yet; never over a file
 *      already there;
 *   5. what GitHub serves is read back: the tag still on the commit built, the
 *      digest of every Windows asset, latest.yml byte for byte, and v<version>
 *      still the latest release.
 *
 * `--dry-run` does 1, and 3 when release/ holds a Windows build of this
 * version, and says what the rest would do: nothing is built or published.
 *
 * Tested in __tests__/scripts/release-win.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';
import { publishRepo, run, sha256Of } from './prune-releases.mjs';
import { checkElectron, parseLatestMac, Refusal } from './release.mjs';

/** The branch a release is built from, on both platforms. */
export const RELEASE_BRANCH = 'main';
const ARCH = 'x64';
/** What the packaged app runs with node from app.asar.unpacked/hooks on Windows. */
const NODE_HOOKS = ['tars-hook.mjs', 'tars-hook-lib.mjs', 'statusline.mjs'];
const firstLine = text => text.trim().split('\n')[0] ?? '';

export function parseArgs(argv) {
  const options = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else throw new Refusal(`unknown argument ${arg}: release:win takes --dry-run and nothing else`);
  }
  return options;
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

/** The files electron-builder names from package.json's patterns. */
export function artifactNames(pkg, version) {
  const expand = (pattern, ext) => pattern.replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, ARCH).replace(/\$\{ext\}/g, ext);
  const setup = expand(pkg.build.nsis.artifactName, 'exe');
  return { setup, blockmap: `${setup}.blockmap`, zip: expand(pkg.build.win.artifactName, 'zip'), yml: 'latest.yml' };
}

/**
 * electron-builder's arguments. npmRebuild off: node-pty and better-sqlite3
 * ship N-API prebuilds for win32-x64 that Electron loads as they are, so
 * nothing is compiled and node_modules is left as npm ci made it.
 */
export function builderArgs(configFile) {
  return ['--config', configFile, '--win', '--x64', '--publish', 'never', '-c.npmRebuild=false'];
}

/**
 * What a Windows build leaves out of node_modules, as electron-builder file
 * patterns: what NEVER_LOADED refuses. The `/**` matters: electron-builder 26
 * filters the files of a module, not its folder, so `!node_modules/@next/swc*`
 * (package.json build.files) leaves every file of @next/swc-* in.
 */
export const WINDOWS_EXCLUDED_FILES = [
  '!node_modules/next/**',
  '!node_modules/@next/**',
  '!node_modules/sharp/**',
  '!node_modules/@img/**',
  '!node_modules/better-sqlite3/deps/**',
  '!node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*',
  '!node_modules/node-pty/prebuilds/darwin-*/**',
];

/** Where the Windows config is written, beside the icon in the ignored build/. */
export const WINDOWS_CONFIG_FILE = join('build', 'electron-builder-win.json');

/**
 * package.json build, as it is, with WINDOWS_EXCLUDED_FILES added to its
 * files. Not build.win.files: electron-builder turns a platform's own files
 * into a matcher of its own, and one holding only exclusions matches
 * everything (measured: .next/cache, design/ and slide-deck/ were packed).
 * Added to build.files here, they join the same matcher. macOS never reads
 * this file: its build and package.json are untouched.
 */
export function windowsBuilderConfig(pkg) {
  return { ...pkg.build, files: [...(pkg.build.files ?? []), ...WINDOWS_EXCLUDED_FILES] };
}

/** The MCP folders package.json ships, from build.extraResources. */
function mcpDirs(pkg) {
  return (pkg.build?.extraResources ?? []).map(e => e.from).filter(from => /^mcp-/.test(from));
}

/**
 * What `npm run electron:build` does for macOS, for Windows: each step a
 * command and its argv, never a shell string. An npm that cannot be found to
 * run without a shell is a refusal that says where it was looked for.
 */
export function buildSteps(root, { npmCommand: findNpm = npmCommand } = {}) {
  const pkg = readPackage(root);
  const resolve = id => {
    try {
      return createRequire(join(root, 'package.json')).resolve(id);
    } catch {
      return join(root, 'node_modules', ...id.split('/'));
    }
  };
  const npm = (args, cwd, label) => {
    try {
      return { label, cwd, ...findNpm('npm', args) };
    } catch (err) {
      throw new Refusal(err.message);
    }
  };
  return [
    { label: 'app icon: node scripts/make-app-ico.mjs', cwd: root, command: process.execPath, args: [join(root, 'scripts', 'make-app-ico.mjs')] },
    npm(['run', 'build:renderer'], root, 'npm run build:renderer'),
    { label: 'tsc -p electron/tsconfig.json', cwd: root, command: process.execPath, args: [resolve('typescript/bin/tsc'), '-p', join('electron', 'tsconfig.json')] },
    ...mcpDirs(pkg).flatMap(mcp => [
      npm(['install'], join(root, mcp), `${mcp}: npm install`),
      npm(['run', 'build'], join(root, mcp), `${mcp}: npm run build`),
    ]),
    { label: `electron-builder ${builderArgs(WINDOWS_CONFIG_FILE).join(' ')}`, cwd: root, command: process.execPath, args: [resolve('electron-builder/cli.js'), ...builderArgs(join(root, WINDOWS_CONFIG_FILE))] },
  ];
}

/** The environment of the build: electron-builder publishes by itself when it finds CI or a token. */
export function buildEnv(env) {
  const out = { ...env };
  for (const key of ['CI', 'GH_TOKEN', 'GITHUB_TOKEN']) delete out[key];
  return out;
}

/** Runs the steps in order, and stops at the first that fails. */
export async function runSteps(steps, { env, log = console.log }) {
  for (const step of steps) {
    log(`   ${step.label}`);
    const r = spawnSync(step.command, step.args, { cwd: step.cwd, env, stdio: 'inherit' });
    if (r.error) throw new Refusal(`${step.label} could not start: ${r.error.message}`);
    if (r.status !== 0) throw new Refusal(`${step.label} failed (exit ${r.status ?? r.signal})`);
  }
}

/**
 * What the packaged app never loads, and a Windows build leaves out
 * (WINDOWS_EXCLUDED_FILES, in the generated build/electron-builder-win.json):
 * the renderer is the static export in out/, so next and its SWC compiler
 * (about 280 MB) and sharp (next's optional image optimizer) are build tools;
 * of the native modules only the win32 prebuilds load, and better-sqlite3's
 * deps/ is sqlite's C source. electron/dist, the hooks and the MCP bundles
 * require none of them. A path under node_modules/ matching one of these fails
 * the release.
 */
export const NEVER_LOADED = [
  /^node_modules\/next\//,
  /^node_modules\/@next\//,
  /^node_modules\/sharp\//,
  /^node_modules\/@img\//,
  /^node_modules\/better-sqlite3\/deps\//,
  /^node_modules\/better-sqlite3\/prebuilds\/(?!win32-)/,
  /^node_modules\/node-pty\/prebuilds\/darwin-/,
];

function asarHeader(fd, asar) {
  const read = (length, position) => {
    const buf = Buffer.alloc(length);
    if (readSync(fd, buf, 0, length, position) !== length) throw new Refusal(`${asar} is shorter than its header says`);
    return buf;
  };
  const sizes = read(16, 0);
  return { read, headerSize: sizes.readUInt32LE(4), header: JSON.parse(read(sizes.readUInt32LE(12), 16).toString('utf8')) };
}

/** One file out of an asar archive, read from its header without the rest. */
export function readAsarFile(asar, name) {
  const fd = openSync(asar, 'r');
  try {
    const { read, headerSize, header } = asarHeader(fd, asar);
    let node = header;
    for (const part of name.split('/')) node = node?.files?.[part];
    if (!node || node.offset === undefined) throw new Refusal(`${asar} holds no ${name}`);
    return read(node.size, 8 + headerSize + Number(node.offset));
  } finally {
    closeSync(fd);
  }
}

/** Every file an asar archive lists, as `a/b/c` paths (the unpacked ones included). */
export function listAsar(asar) {
  const fd = openSync(asar, 'r');
  try {
    const found = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (child.files) walk(child, `${prefix}${name}/`);
        else found.push(`${prefix}${name}`);
      }
    };
    walk(asarHeader(fd, asar).header, '');
    return found;
  } finally {
    closeSync(fd);
  }
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath ?? e.path, e.name));
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** The version the Windows build in this folder is of, from its latest.yml, or undefined. */
function builtVersion(releaseDir) {
  const yml = join(releaseDir, 'latest.yml');
  return existsSync(yml) ? parseLatestMac(readFileSync(yml, 'utf8')).version : undefined;
}

/** Step 3. Returns the files the release gets, in the order they are uploaded. */
export async function verifyWindowsArtifacts(releaseDir, version, { repo, pkg }) {
  const names = artifactNames(pkg, version);
  const yml = join(releaseDir, names.yml);
  if (!existsSync(yml)) throw new Refusal(`${yml} does not exist`);
  const manifest = parseLatestMac(readFileSync(yml, 'utf8'));
  if (manifest.version !== version) throw new Refusal(`latest.yml is for ${manifest.version}, not ${version}`);
  const entry = manifest.files.length === 1 ? manifest.files[0] : undefined;
  if (entry?.url !== names.setup) throw new Refusal(`latest.yml does not name exactly ${names.setup}`);
  const setup = join(releaseDir, names.setup);
  if (!existsSync(setup)) throw new Refusal(`${setup} is named in latest.yml and does not exist`);
  const { size } = statSync(setup);
  if (Number(entry.size) !== size) throw new Refusal(`latest.yml gives ${names.setup} ${entry.size} bytes, the file has ${size}`);
  if (entry.sha512 !== sha512Base64(setup)) throw new Refusal(`the sha512 in latest.yml is not that of ${names.setup}`);
  if (manifest.path !== names.setup || manifest.sha512 !== entry.sha512) {
    throw new Refusal('the top-level path and sha512 of latest.yml are not those of the installer');
  }
  const blockmap = join(releaseDir, names.blockmap);
  if (!existsSync(blockmap)) throw new Refusal(`${names.blockmap} does not exist: the update would be downloaded whole every time`);
  const zip = join(releaseDir, names.zip);
  if (!existsSync(zip)) throw new Refusal(`${zip} does not exist`);

  const app = join(releaseDir, 'win-unpacked');
  const resources = join(app, 'resources');
  const exe = join(app, `${pkg.build.productName}.exe`);
  if (!existsSync(exe)) throw new Refusal(`${exe} does not exist`);

  const feed = existsSync(join(resources, 'app-update.yml'))
    ? Object.fromEntries(readFileSync(join(resources, 'app-update.yml'), 'utf8').split('\n')
      .map(line => /^(\w+):\s*(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]))
    : {};
  if (feed.provider !== 'github' || `${feed.owner}/${feed.repo}` !== repo) {
    throw new Refusal(`resources/app-update.yml feeds ${feed.provider ?? 'nothing'} ${feed.owner}/${feed.repo}, not github ${repo}`);
  }

  const shown = JSON.parse(readAsarFile(join(resources, 'app.asar'), 'package.json').toString('utf8')).version;
  if (shown !== version) throw new Refusal(`the built app says ${shown}, not ${version}`);

  const unpacked = join(resources, 'app.asar.unpacked');
  const shipped = [
    ...listAsar(join(resources, 'app.asar')),
    ...filesUnder(unpacked).map(f => relative(unpacked, f).split(sep).join('/')),
  ];
  for (const pattern of NEVER_LOADED) {
    const hit = shipped.find(f => pattern.test(f));
    if (hit) throw new Refusal(`the app ships ${hit}, which it never loads: WINDOWS_EXCLUDED_FILES (build/electron-builder-win.json) should leave it out`);
  }
  const pty = filesUnder(join(unpacked, 'node_modules', 'node-pty'));
  const withConpty = pty.filter(f => basename(f) === 'conpty.node').map(dirname)
    .some(dir => ['conpty.dll', 'OpenConsole.exe'].every(n => pty.includes(join(dir, 'conpty', n))));
  if (!withConpty) throw new Refusal('node-pty in app.asar.unpacked has no conpty.node beside conpty\\conpty.dll and conpty\\OpenConsole.exe');
  const sqlite = filesUnder(join(unpacked, 'node_modules', 'better-sqlite3'));
  if (!sqlite.some(f => [`win32-${ARCH}.node`, 'better_sqlite3.node'].includes(basename(f)))) {
    throw new Refusal('better-sqlite3 in app.asar.unpacked has no Windows binary');
  }
  for (const hook of NODE_HOOKS) {
    if (!existsSync(join(unpacked, 'hooks', hook))) throw new Refusal(`hooks/${hook} is not in app.asar.unpacked: the Node hooks cannot run`);
  }
  for (const e of pkg.build.extraResources ?? []) {
    if (!(e.filter ?? []).includes('dist/bundle.js')) continue;
    if (!existsSync(join(resources, e.to, 'dist', 'bundle.js'))) throw new Refusal(`resources/${e.to}/dist/bundle.js is missing: that MCP server cannot start`);
  }
  return { setup, blockmap, zip, yml };
}

async function git(root, args) {
  const r = await run('git', args, { cwd: root });
  if (r.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${firstLine(r.stderr)}`);
  return r.stdout;
}

async function ghJson(args) {
  const r = await run('gh', args);
  if (r.missing) throw new Refusal('gh is not installed');
  if (r.code !== 0) throw new Refusal(`gh ${args.slice(0, 2).join(' ')} failed: ${firstLine(r.stderr)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`gh ${args.slice(0, 2).join(' ')} did not answer with JSON`);
  }
}

/** The commit a tag points at, through an annotated tag object if it is one. */
async function tagTarget(repo, tag) {
  const ref = await ghJson(['api', `repos/${repo}/git/ref/tags/${tag}`]);
  let target = ref.object?.sha;
  if (ref.object?.type === 'tag') target = (await ghJson(['api', `repos/${repo}/git/tags/${target}`])).object?.sha;
  return target;
}

/** Step 1, the checkout. */
async function checkCheckout(root) {
  const fetched = await run('git', ['fetch', 'origin'], { cwd: root });
  if (fetched.code !== 0) throw new Refusal(`git fetch origin failed: ${firstLine(fetched.stderr)}`);
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(root, ['rev-parse', `origin/${RELEASE_BRANCH}`])).trim();
  if (head !== branch) {
    throw new Refusal(`HEAD ${head.slice(0, 7)} is not origin/${RELEASE_BRANCH} ${branch.slice(0, 7)}: a release is built from what ${RELEASE_BRANCH} holds, nothing else`);
  }
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty) throw new Refusal(`tracked files differ from HEAD, so the build would not be the commit:\n${dirty}`);
  return { head, electron: checkElectron(root) };
}

/**
 * Step 1, GitHub: the release `npm run release` made of this version, on this
 * commit, still the latest, and without the Windows files.
 */
async function checkRelease({ repo, version, head, names }) {
  const tag = `v${version}`;
  const viewed = await run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets']);
  if (viewed.missing) throw new Refusal('gh is not installed');
  if (viewed.code !== 0) {
    if (/release not found/i.test(viewed.stderr)) {
      throw new Refusal(`${tag} is not released on ${repo}: npm run release publishes it first, from a Mac, and the Windows files are added to it`);
    }
    throw new Refusal(`could not read ${tag} on ${repo}: ${firstLine(viewed.stderr)}`);
  }
  let assets;
  try {
    assets = JSON.parse(viewed.stdout).assets;
  } catch {
    throw new Refusal('gh release view did not answer with JSON');
  }
  if (!Array.isArray(assets)) throw new Refusal(`gh listed no assets for ${tag}`);

  const target = await tagTarget(repo, tag);
  if (target !== head) throw new Refusal(`${tag} points at ${target}, not at HEAD ${head}: the Windows build must be the commit macOS was built from`);

  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== tag) {
    throw new Refusal(`the latest release on ${repo} is ${latest.tag_name}, not ${tag}: Windows reads the latest release, so build that one`);
  }

  const there = Object.values(names).filter(name => assets.some(a => a?.name === name));
  if (there.length) {
    throw new Refusal(`${tag} on ${repo} already carries ${there.join(', ')}: its Windows build is released, or an earlier attempt stopped half way (gh release delete-asset removes what it left)`);
  }
}

/** Step 5. What GitHub serves, against what was built. */
async function readBack({ repo, version, head, files, yml }) {
  const tag = `v${version}`;
  const target = await tagTarget(repo, tag);
  if (target !== head) throw new Refusal(`${tag} points at ${target}, not at the commit built ${head}`);
  for (const file of files) {
    const local = `sha256:${await sha256Of(file)}`;
    let digest;
    for (let attempt = 0; attempt < 5 && !digest; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 2000));
      const { assets } = await ghJson(['release', 'view', tag, '--repo', repo, '--json', 'assets']);
      digest = assets?.find(a => a.name === basename(file))?.digest;
    }
    if (digest !== local) throw new Refusal(`GitHub serves ${basename(file)} with ${digest ?? 'no digest'}, the local file is ${local}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tars-release-win-served-'));
  try {
    const got = await run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'latest.yml', '--dir', dir]);
    if (got.code !== 0 || !readFileSync(join(dir, 'latest.yml')).equals(readFileSync(yml))) {
      throw new Refusal('the latest.yml GitHub serves is not the one checked');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== tag) throw new Refusal(`/releases/latest is ${latest.tag_name}, not ${tag}`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), log = console.log, build = runSteps, npmCommand: findNpm = npmCommand } = {}) {
  try {
    const { dryRun } = parseArgs(argv);
    const toplevel = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (toplevel.code !== 0) throw new Refusal(`${cwd} is not inside a git checkout`);
    const root = toplevel.stdout.trim();
    const pkg = readPackage(root);
    const version = pkg.version;
    let repo;
    try {
      repo = publishRepo(root);
    } catch (err) {
      throw new Refusal(err.message);
    }
    const names = artifactNames(pkg, version);
    log(`release:win: the Windows build of v${version}, added to its release on ${repo}, from ${root}${dryRun ? ', dry run' : ''}`);

    // The checkout first: what package.json says only counts once it is the commit.
    const { head, electron } = await checkCheckout(root);
    await checkRelease({ repo, version, head, names });
    log(`1. checks passed: HEAD ${head.slice(0, 7)} is origin/${RELEASE_BRANCH}, tracked tree clean, electron ${electron} installed as locked, v${version} released on that commit, the latest release, without the Windows files`);

    const releaseDir = join(root, 'release');
    if (dryRun) {
      log('2. would build for Windows, without CI, GH_TOKEN or GITHUB_TOKEN:');
      for (const step of buildSteps(root, { npmCommand: findNpm })) log(`   ${step.label}`);
    } else {
      log('2. build for Windows, without CI, GH_TOKEN or GITHUB_TOKEN:');
      const steps = buildSteps(root, { npmCommand: findNpm });
      mkdirSync(join(root, 'build'), { recursive: true });
      writeFileSync(join(root, WINDOWS_CONFIG_FILE), `${JSON.stringify(windowsBuilderConfig(pkg), null, 2)}\n`);
      await build(steps, { root, env: buildEnv(process.env), log });
    }

    let artifacts;
    const built = builtVersion(releaseDir);
    if (dryRun && built !== version) {
      log(built
        ? `3. ${releaseDir} holds the Windows build of ${built}: would check the artifacts of ${version} once built`
        : `3. no Windows build in ${releaseDir} yet: would check the artifacts once built`);
    } else {
      artifacts = await verifyWindowsArtifacts(releaseDir, version, { repo, pkg });
      log(`3. artifacts checked: ${basename(artifacts.setup)} and latest.yml agree, blockmap and zip present, the app says ${version}, feeds from ${repo}, and its native modules, Node hooks and MCP bundles are unpacked`);
    }

    const fileOf = name => (artifacts ? artifacts[name] : join(releaseDir, names[name]));
    const first = ['release', 'upload', `v${version}`, fileOf('setup'), fileOf('blockmap'), fileOf('zip'), '--repo', repo];
    const last = ['release', 'upload', `v${version}`, fileOf('yml'), '--repo', repo];
    if (dryRun) {
      log(`4. would run gh ${first.join(' ')}, then gh ${last.join(' ')}`);
      log(`5. would check that v${version} still points at ${head.slice(0, 7)}, that each Windows asset's digest is the local file's, that the served latest.yml is this one, and that /releases/latest is still v${version}`);
      return 0;
    }

    // The build took minutes: GitHub is asked again, so that nothing goes up
    // to a release that has since stopped being the latest, moved its tag or
    // been given Windows files.
    await checkRelease({ repo, version, head, names });
    for (const args of [first, last]) {
      const uploaded = await run('gh', args);
      if (uploaded.code !== 0) throw new Refusal(`gh ${args.slice(0, 3).join(' ')} failed: ${firstLine(uploaded.stderr)}`);
    }
    log(`4. uploaded ${[artifacts.setup, artifacts.blockmap, artifacts.zip, artifacts.yml].map(f => basename(f)).join(', ')} to v${version}`);

    await readBack({ repo, version, head, files: [artifacts.setup, artifacts.blockmap, artifacts.zip, artifacts.yml], yml: artifacts.yml });
    log('5. GitHub serves exactly what was built');
    log(`   ${artifacts.setup}`);
    log(`   https://github.com/${repo}/releases/tag/v${version}`);
    return 0;
  } catch (err) {
    if (err instanceof Refusal) {
      log(`release:win: stopped. ${err.message}`);
      return 1;
    }
    throw err;
  }
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(code => process.exit(code));
}
