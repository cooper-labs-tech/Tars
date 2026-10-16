#!/usr/bin/env node
/**
 * `npm run release:linux`: the Linux half of a release, added to the release
 * `npm run release` has published (the maintainer's parity rule of 2026-10-16:
 * a published Linux build).
 *
 *   npm run release:linux -- --dry-run      the checks; nothing is built or published
 *   npm run release:linux                   build on GitHub's Linux runners, add the Linux files to v<version>
 *   node scripts/release-linux.mjs --build  on those runners only (.github/workflows/release-linux.yml)
 *
 * A version is released once, for every platform. `npm run release`, on a
 * Mac, publishes v<version>; `npm run release:win`, on Windows, adds the
 * Windows files; this adds the two AppImages (x64 and arm64) and their feeds,
 * latest-linux.yml and latest-linux-arm64.yml (what electron-updater reads on
 * each), from the same commit. An AppImage is built where its native modules
 * (node-pty, better-sqlite3) can be: on Linux machines of its architecture, the
 * runners of .github/workflows/release-linux.yml (ubuntu-latest and
 * ubuntu-24.04-arm), which hold a read-only token and publish nothing. Their
 * artifacts are downloaded and uploaded from here, with the maintainer's own gh.
 *
 * From a checkout, in this order, stopping at the first thing that is not as
 * it should be:
 *   1. HEAD is origin/main after a fetch, the tracked tree is clean; on
 *      GitHub, v<version> is released, its tag is on HEAD, it is the latest
 *      release, and it carries no Linux file yet;
 *   2. the workflow is dispatched on main; the run it started is found by its
 *      head commit, HEAD, and waited for; it must succeed, which means each
 *      runner's --build checked its unpacked app (below);
 *   3. its two artifacts are downloaded: each feed names this version and its
 *      AppImage with its size and sha512, and the AppImage is exactly that;
 *   4. GitHub asked again what step 1 asked, since the build takes minutes;
 *      then gh release upload: both AppImages, then both feeds, so that no
 *      installed Tars reads a feed whose file is not there yet; never over a
 *      file already there;
 *   5. what GitHub serves is read back: the tag still on HEAD, the digest of
 *      every file, each feed byte for byte, v<version> still the latest.
 *
 * On a runner (--build): Linux only, for the runner's own architecture; the
 * build steps of release:win for Linux (the renderer, the main process, the
 * MCP bundles, electron-builder --linux AppImage --<arch>, never publishing by
 * itself), then the artifacts: the feed against the AppImage, and the unpacked
 * app: its version, its feed (build.publish), the Linux binaries of node-pty
 * and better-sqlite3, the hooks and every MCP bundle, and nothing it never
 * loads.
 *
 * Tested in __tests__/scripts/release-linux.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';
import { publishRepo, run, sha256Of } from './prune-releases.mjs';
import { parseLatestMac, Refusal } from './release.mjs';
import { buildEnv, listAsar, readAsarFile, runSteps } from './release-win.mjs';

export const RELEASE_BRANCH = 'main';
export const WORKFLOW = 'release-linux.yml';
/** The architectures a release carries, each built on a runner of its own. */
export const ARCHES = ['x64', 'arm64'];
/**
 * How electron-builder writes each architecture in an AppImage's name: x64 as
 * x86_64 (builder-util's getArtifactArchName). One file, read by this script
 * and by the update feed (electron/platform/update-feed.ts), so the name the
 * release checks and uploads is the one an install looks for.
 */
const APPIMAGE_ARCH = JSON.parse(readFileSync(new URL('../electron/platform/linux-artifact-arch.json', import.meta.url), 'utf8'));
/** How long the build may take on the runners before this stops waiting. */
const RUN_DEADLINE_MS = 60 * 60_000;
const firstLine = text => text.trim().split('\n')[0] ?? '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseArgs(argv) {
  const options = { dryRun: false, build: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--build') options.build = true;
    else throw new Refusal(`unknown argument ${arg}: release:linux takes --dry-run, or --build on a runner, and nothing else`);
  }
  if (options.dryRun && options.build) throw new Refusal('--dry-run and --build do not go together');
  return options;
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

/**
 * The files electron-builder names from package.json build.linux, for one
 * architecture: its AppImage, and the feed electron-updater reads there
 * (latest-linux.yml on x64, latest-linux-arm64.yml on arm64).
 */
export function artifactNames(pkg, version, arch) {
  if (!ARCHES.includes(arch)) throw new Refusal(`no Linux build for ${arch}: release:linux builds ${ARCHES.join(' and ')}`);
  const pattern = pkg.build?.linux?.artifactName;
  if (!pattern) throw new Refusal('package.json build.linux.artifactName is not set: the AppImage would be named by electron-builder\'s default');
  const appImage = pattern.replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, APPIMAGE_ARCH[arch]).replace(/\$\{ext\}/g, 'AppImage');
  return { appImage, yml: arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml` };
}

/** Every Linux file of a release, both architectures. */
export function allNames(pkg, version) {
  return ARCHES.flatMap(arch => Object.values(artifactNames(pkg, version, arch)));
}

export function builderArgs(arch) {
  return ['--linux', 'AppImage', `--${arch}`, '--publish', 'never'];
}

function mcpDirs(pkg) {
  return (pkg.build?.extraResources ?? []).map(e => e.from).filter(from => /^mcp-/.test(from));
}

/** The build, as release:win's: each step a command and its argv, never a shell string. */
export function buildSteps(root, arch, { npmCommand: findNpm = npmCommand } = {}) {
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
    npm(['run', 'build:renderer'], root, 'npm run build:renderer'),
    { label: 'tsc -p electron/tsconfig.json', cwd: root, command: process.execPath, args: [resolve('typescript/bin/tsc'), '-p', join('electron', 'tsconfig.json')] },
    ...mcpDirs(pkg).flatMap(mcp => [
      npm(['install'], join(root, mcp), `${mcp}: npm install`),
      npm(['run', 'build'], join(root, mcp), `${mcp}: npm run build`),
    ]),
    { label: `electron-builder ${builderArgs(arch).join(' ')}`, cwd: root, command: process.execPath, args: [resolve('electron-builder/cli.js'), ...builderArgs(arch)] },
  ];
}

/**
 * What the packaged app never loads, as release:win's list, for Linux: the
 * renderer is the static export, so next and its compiler are build tools; of
 * the native modules only the Linux binaries load.
 */
export const NEVER_LOADED = [
  /^node_modules\/next\//,
  /^node_modules\/@next\/swc/,
  /^node_modules\/better-sqlite3\/deps\//,
  /^node_modules\/better-sqlite3\/prebuilds\/(?!linux-)/,
  /^node_modules\/node-pty\/prebuilds\/(darwin|win32)-/,
];

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath ?? e.path, e.name));
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

/** One architecture's feed against the AppImage beside it. Returns the two files. */
export function verifyPublished(dir, version, pkg, arch) {
  const names = artifactNames(pkg, version, arch);
  const yml = join(dir, names.yml);
  if (!existsSync(yml)) throw new Refusal(`${yml} does not exist`);
  const manifest = parseLatestMac(readFileSync(yml, 'utf8'));
  if (manifest.version !== version) throw new Refusal(`${names.yml} is for ${manifest.version}, not ${version}`);
  const entry = manifest.files.length === 1 ? manifest.files[0] : undefined;
  if (entry?.url !== names.appImage) throw new Refusal(`${names.yml} does not name exactly ${names.appImage}`);
  const appImage = join(dir, names.appImage);
  if (!existsSync(appImage)) throw new Refusal(`${appImage} is named in ${names.yml} and does not exist`);
  const { size } = statSync(appImage);
  if (Number(entry.size) !== size) throw new Refusal(`${names.yml} gives ${names.appImage} ${entry.size} bytes, the file has ${size}`);
  if (entry.sha512 !== sha512Base64(appImage)) throw new Refusal(`the sha512 in ${names.yml} is not that of ${names.appImage}`);
  if (manifest.path !== names.appImage || manifest.sha512 !== entry.sha512) {
    throw new Refusal(`the top-level path and sha512 of ${names.yml} are not those of the AppImage`);
  }
  return { appImage, yml };
}

/** On a runner: the published pair, and the unpacked app electron-builder made the AppImage from. */
export function verifyLinuxBuild(releaseDir, version, { repo, pkg, arch }) {
  const files = verifyPublished(releaseDir, version, pkg, arch);
  // electron-builder names the unpacked app after the architecture when it is not x64.
  const resources = join(releaseDir, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`, 'resources');
  const feed = existsSync(join(resources, 'app-update.yml'))
    ? Object.fromEntries(readFileSync(join(resources, 'app-update.yml'), 'utf8').split('\n')
      .map(line => /^(\w+):\s*(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]))
    : {};
  if (feed.provider !== 'github' || `${feed.owner}/${feed.repo}` !== repo) {
    throw new Refusal(`resources/app-update.yml feeds ${feed.provider ?? 'nothing'} ${feed.owner}/${feed.repo}, not github ${repo}`);
  }
  const asar = join(resources, 'app.asar');
  const shown = JSON.parse(readAsarFile(asar, 'package.json').toString('utf8')).version;
  if (shown !== version) throw new Refusal(`the built app says ${shown}, not ${version}`);
  const unpacked = join(resources, 'app.asar.unpacked');
  const shipped = [...listAsar(asar), ...filesUnder(unpacked).map(f => relative(unpacked, f).split(sep).join('/'))];
  for (const pattern of NEVER_LOADED) {
    const hit = shipped.find(f => pattern.test(f));
    if (hit) throw new Refusal(`the app ships ${hit}, which it never loads on Linux`);
  }
  const pty = filesUnder(join(unpacked, 'node_modules', 'node-pty'));
  if (!pty.some(f => basename(f) === 'pty.node')) throw new Refusal('node-pty in app.asar.unpacked has no pty.node: no terminal can start');
  if (pty.some(f => basename(f) === 'conpty.node')) throw new Refusal('node-pty in app.asar.unpacked carries the Windows conpty.node: not a Linux build');
  const sqlite = filesUnder(join(unpacked, 'node_modules', 'better-sqlite3'));
  if (!sqlite.some(f => basename(f) === 'better_sqlite3.node')) throw new Refusal('better-sqlite3 in app.asar.unpacked has no better_sqlite3.node');
  if (!existsSync(join(unpacked, 'hooks'))) throw new Refusal('hooks/ is not in app.asar.unpacked: the agents\' hooks cannot run');
  for (const e of pkg.build.extraResources ?? []) {
    if (!(e.filter ?? []).includes('dist/bundle.js')) continue;
    if (!existsSync(join(resources, e.to, 'dist', 'bundle.js'))) throw new Refusal(`resources/${e.to}/dist/bundle.js is missing: that MCP server cannot start`);
  }
  return files;
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

async function tagTarget(repo, tag) {
  const ref = await ghJson(['api', `repos/${repo}/git/ref/tags/${tag}`]);
  let target = ref.object?.sha;
  if (ref.object?.type === 'tag') target = (await ghJson(['api', `repos/${repo}/git/tags/${target}`])).object?.sha;
  return target;
}

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
  return { head };
}

/** Steps 1 and 4: v<version> released on HEAD, the latest, without the Linux files. */
async function checkRelease({ repo, version, head, names }) {
  const tag = `v${version}`;
  const viewed = await run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets']);
  if (viewed.missing) throw new Refusal('gh is not installed');
  if (viewed.code !== 0) {
    if (/release not found/i.test(viewed.stderr)) {
      throw new Refusal(`${tag} is not released on ${repo}: npm run release publishes it first, from a Mac, and the Linux files are added to it`);
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
  if (target !== head) throw new Refusal(`${tag} points at ${target}, not at HEAD ${head}: the Linux build must be the commit macOS was built from`);
  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== tag) throw new Refusal(`the latest release on ${repo} is ${latest.tag_name}, not ${tag}: Linux reads the latest release, so build that one`);
  const there = names.filter(name => assets.some(a => a?.name === name));
  if (there.length) {
    throw new Refusal(`${tag} on ${repo} already carries ${there.join(', ')}: its Linux build is released, or an earlier attempt stopped half way (gh release delete-asset removes what it left)`);
  }
}

/**
 * Step 2. Dispatches the workflow on main (whose head is HEAD: step 1 checked)
 * and finds the run it started: the newest workflow_dispatch run of it whose
 * head commit is HEAD, created after the dispatch. Waits for it; a run that did
 * not succeed stops the release with its URL.
 */
async function buildOnRunners({ repo, head, log, wait, now }) {
  const asked = now();
  const dispatched = await run('gh', ['workflow', 'run', WORKFLOW, '--repo', repo, '--ref', RELEASE_BRANCH, '-f', `ref=${head}`]);
  if (dispatched.missing) throw new Refusal('gh is not installed');
  if (dispatched.code !== 0) throw new Refusal(`gh workflow run ${WORKFLOW} failed: ${firstLine(dispatched.stderr)}`);
  let found;
  for (let attempt = 0; attempt < 30 && !found; attempt++) {
    if (attempt) await wait(5_000);
    const runs = await ghJson(['run', 'list', '--repo', repo, '--workflow', WORKFLOW, '--event', 'workflow_dispatch', '--limit', '20',
      '--json', 'databaseId,headSha,status,conclusion,createdAt,url']);
    found = (Array.isArray(runs) ? runs : [])
      .filter(r => r.headSha === head && Date.parse(r.createdAt) >= asked - 60_000)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  }
  if (!found) throw new Refusal(`no run of ${WORKFLOW} for ${head.slice(0, 7)} appeared on ${repo} after the dispatch`);
  log(`   run ${found.databaseId}: ${found.url}`);
  let state = found;
  while (state.status !== 'completed') {
    if (now() - asked > RUN_DEADLINE_MS) throw new Refusal(`run ${found.databaseId} did not finish within an hour: ${found.url}`);
    await wait(30_000);
    state = await ghJson(['run', 'view', String(found.databaseId), '--repo', repo, '--json', 'status,conclusion,url']);
  }
  if (state.conclusion !== 'success') throw new Refusal(`run ${found.databaseId} ended ${state.conclusion}: ${state.url ?? found.url}`);
  return found.databaseId;
}

/** Step 3. Each architecture's artifact, into a folder of its own under `dir`. */
async function downloadArtifacts({ repo, runId, head, dir }) {
  const out = {};
  for (const arch of ARCHES) {
    const into = join(dir, arch);
    const got = await run('gh', ['run', 'download', String(runId), '--repo', repo, '--name', `tars-linux-${arch}-${head}`, '--dir', into]);
    if (got.code !== 0) throw new Refusal(`gh run download ${runId} (${arch}) failed: ${firstLine(got.stderr)}`);
    out[arch] = into;
  }
  return out;
}

async function readBack({ repo, version, head, files, feeds, wait }) {
  const tag = `v${version}`;
  const target = await tagTarget(repo, tag);
  if (target !== head) throw new Refusal(`${tag} points at ${target}, not at the commit built ${head}`);
  for (const file of files) {
    const local = `sha256:${await sha256Of(file)}`;
    let digest;
    for (let attempt = 0; attempt < 5 && !digest; attempt++) {
      if (attempt) await wait(2000);
      const { assets } = await ghJson(['release', 'view', tag, '--repo', repo, '--json', 'assets']);
      digest = assets?.find(a => a.name === basename(file))?.digest;
    }
    if (digest !== local) throw new Refusal(`GitHub serves ${basename(file)} with ${digest ?? 'no digest'}, the local file is ${local}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tars-release-linux-served-'));
  try {
    for (const feed of feeds) {
      const got = await run('gh', ['release', 'download', tag, '--repo', repo, '--pattern', basename(feed), '--dir', dir]);
      if (got.code !== 0 || !readFileSync(join(dir, basename(feed))).equals(readFileSync(feed))) {
        throw new Refusal(`the ${basename(feed)} GitHub serves is not the one checked`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== tag) throw new Refusal(`/releases/latest is ${latest.tag_name}, not ${tag}`);
}

export async function main(argv = process.argv.slice(2), {
  cwd = process.cwd(), log = console.log, build = runSteps, npmCommand: findNpm = npmCommand,
  platform = process.platform, arch = process.arch, wait = sleep, now = Date.now,
} = {}) {
  try {
    const { dryRun, build: onRunner } = parseArgs(argv);
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

    if (onRunner) {
      if (platform !== 'linux') throw new Refusal(`--build runs on Linux, where the AppImage's native modules are built; this is ${platform}`);
      const names = artifactNames(pkg, version, arch);
      log(`release:linux --build: the Linux ${arch} build of ${version} for ${repo}, without CI, GH_TOKEN or GITHUB_TOKEN`);
      await build(buildSteps(root, arch, { npmCommand: findNpm }), { root, env: buildEnv(process.env), log });
      verifyLinuxBuild(join(root, 'release'), version, { repo, pkg, arch });
      log(`checked: ${names.appImage} and ${names.yml} agree, the app says ${version}, feeds from ${repo}, and its Linux native modules, hooks and MCP bundles are unpacked`);
      return 0;
    }

    const names = allNames(pkg, version);
    log(`release:linux: the Linux build of v${version}, added to its release on ${repo}, from ${root}${dryRun ? ', dry run' : ''}`);
    const { head } = await checkCheckout(root);
    await checkRelease({ repo, version, head, names });
    log(`1. checks passed: HEAD ${head.slice(0, 7)} is origin/${RELEASE_BRANCH}, tracked tree clean, v${version} released on that commit, the latest release, without the Linux files`);
    if (dryRun) {
      log(`2. would run gh workflow run ${WORKFLOW} --repo ${repo} --ref ${RELEASE_BRANCH} -f ref=${head}, wait for that run, and download ${ARCHES.map(a => `tars-linux-${a}-${head}`).join(' and ')}`);
      log(`3. would check each feed against its AppImage: ${names.join(', ')}`);
      log(`4. would upload the AppImages, then the feeds, to v${version}`);
      log('5. would read back the tag, every digest, the served feeds and /releases/latest');
      return 0;
    }

    log(`2. build on the Linux runners (${WORKFLOW}):`);
    const runId = await buildOnRunners({ repo, head, log, wait, now });
    const dir = mkdtempSync(join(tmpdir(), 'tars-release-linux-'));
    try {
      const dirs = await downloadArtifacts({ repo, runId, head, dir });
      const checked = ARCHES.map(a => verifyPublished(dirs[a], version, pkg, a));
      log(`3. artifacts checked: ${checked.map(c => `${basename(c.appImage)} is what ${basename(c.yml)} says`).join('; ')}`);
      await checkRelease({ repo, version, head, names });
      const order = [...checked.map(c => c.appImage), ...checked.map(c => c.yml)];
      for (const file of order) {
        const uploaded = await run('gh', ['release', 'upload', `v${version}`, file, '--repo', repo]);
        if (uploaded.code !== 0) throw new Refusal(`gh release upload ${basename(file)} failed: ${firstLine(uploaded.stderr)}`);
      }
      log(`4. uploaded ${order.map(f => basename(f)).join(', ')} to v${version}`);
      await readBack({ repo, version, head, files: order, feeds: checked.map(c => c.yml), wait });
      log('5. GitHub serves exactly what was built');
      log(`   https://github.com/${repo}/releases/tag/v${version}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return 0;
  } catch (err) {
    if (err instanceof Refusal) {
      log(`release:linux: stopped. ${err.message}`);
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
