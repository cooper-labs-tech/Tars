#!/usr/bin/env node
/**
 * `npm run release`: the only way a Tars release is published.
 *
 * On 16/09 the procedure existed and was got around three ways: 1.7.0 and 1.7.1
 * were built in a worktree, so the release/ JeanBrasse opens stayed on 1.6.19; the
 * purge assumed every old version was published and 1.6.19 was not; and the
 * publication itself was done by hand, with a copy instead of a move and one
 * version's latest-mac.yml written over another's. A note in memory did not
 * stop it. This script does the whole sequence and stops at the first thing
 * that is not as it should be:
 *
 *   1. refuse unless HEAD is origin/main after a fetch, the tracked tree is
 *      clean, the electron installed is the one package.json and the lockfile
 *      ask for (package and binary), v<version> exists on GitHub neither as a release nor as a tag,
 *      the top entry of src/data/changelog.ts is that version, and no newer
 *      version is already published;
 *   2. npm run electron:build, without CI, GH_TOKEN or GITHUB_TOKEN, so
 *      electron-builder never publishes anything by itself, and only once
 *      nothing it would write over is a build GitHub does not prove published:
 *      neither in release/ here, nor, from a worktree, in the folder step 7
 *      moves the build into;
 *   3. check the artifacts: latest-mac.yml names this version, the size and
 *      sha512 it gives the dmg and the zip are the files', and the built app
 *      says this version;
 *   4. write the notes from that changelog entry;
 *   5. gh release create, on the exact commit built;
 *   6. read back what GitHub serves: the tag on that commit, the digest of every
 *      asset, latest-mac.yml byte for byte, and /releases/latest;
 *   7. from a worktree, move (never copy) the build into the main checkout's
 *      release/, overwriting nothing that differs;
 *   8. prune that folder, which deletes only what GitHub proves published;
 *   9. print where the dmg is and where the release is.
 *
 * `--dry-run` does 1, the checks of 2, 3 when release/ holds a build of this
 * version, and 4, and says what the rest would do: nothing is built, published,
 * moved or deleted.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  canonicalReleaseDir, compareVersions, prune, publicationOf, publishRepo, run, sha256Of, versionOf,
} from './prune-releases.mjs';

/** A reason to stop. Everything else thrown is a bug and is left to crash. */
export class Refusal extends Error {}

/** The line every set of notes ends on, as on v1.7.1. */
export const NOTES_FOOTER = 'Le `.dmg` et le `.zip` ne sont pas signes: macOS affichera un avertissement '
  + 'Gatekeeper a la premiere ouverture, comme pour les versions precedentes.';

const firstLine = text => text.trim().split('\n')[0] ?? '';

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

/**
 * The changelog as the app compiles it: transpiled by the repository's own
 * TypeScript and evaluated, rather than read with a pattern that would have its
 * own idea of what an escaped quote is.
 */
export function changelogTop(root) {
  const ts = createRequire(import.meta.url)('typescript');
  const source = readFileSync(join(root, 'src', 'data', 'changelog.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const compiled = { exports: {} };
  vm.runInNewContext(outputText, { module: compiled, exports: compiled.exports }, { filename: 'changelog.ts' });
  const top = compiled.exports.CHANGELOG?.[0];
  if (typeof top?.version !== 'string' || !Array.isArray(top.updates) || top.updates.length === 0) {
    throw new Refusal('src/data/changelog.ts has no top entry with a version and its updates');
  }
  return top;
}

/**
 * Whether `version` (x.y.z) is in `range`, for the forms package.json uses:
 * an exact version, `^x.y.z` and `~x.y.z`. Anything else is refused rather
 * than guessed at.
 */
export function satisfies(version, range) {
  const parse = v => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const got = parse(version);
  const [, op = '', base] = /^([\^~]?)(.*)$/.exec(range.trim());
  const want = parse(base);
  if (!got || !want) throw new Refusal(`cannot read electron's version range "${range}" in package.json, or the version ${version}`);
  if (compareVersions(version, base) > 0) return false;
  if (op === '') return compareVersions(version, base) === 0;
  if (op === '~') return got[0] === want[0] && got[1] === want[1];
  // ^: the leftmost non-zero part stays.
  if (want[0] > 0) return got[0] === want[0];
  if (want[1] > 0) return got[0] === 0 && got[1] === want[1];
  return got[0] === 0 && got[1] === 0 && got[2] === want[2];
}

/**
 * The Electron the build will package is the one package.json and the lockfile
 * ask for. electron-builder packages whatever node_modules holds, found the way
 * Node finds it from the checkout, which from a worktree is the main
 * checkout's. Measured by the Audit on 24/09: that node_modules held Electron
 * 43.4.1 while package.json asked ^44.4.4, and nothing looked, so a release
 * from there would have shipped 43. The binary is checked too: since Electron
 * 44 no postinstall downloads it, and `npx install-electron` is a step of its own.
 */
export function checkElectron(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const range = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
  if (!range) throw new Refusal('package.json names no electron');
  let locked;
  try {
    locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages?.['node_modules/electron']?.version;
  } catch {
    throw new Refusal('package-lock.json cannot be read: run npm ci');
  }
  if (!locked) throw new Refusal('package-lock.json locks no electron: run npm install');

  let manifest;
  try {
    manifest = createRequire(join(root, 'package.json')).resolve('electron/package.json');
  } catch {
    throw new Refusal('electron is not installed where this checkout finds it: run npm ci, then npx install-electron');
  }
  const installed = JSON.parse(readFileSync(manifest, 'utf8')).version;
  const where = dirname(manifest);
  if (!satisfies(installed, range)) {
    throw new Refusal(`electron ${installed} is installed (${where}), and package.json asks ${range}: run npm ci, then npx install-electron`);
  }
  if (installed !== locked) {
    throw new Refusal(`package-lock.json locks electron ${locked}, and ${installed} is installed (${where}): run npm ci, then npx install-electron`);
  }
  let binary;
  try {
    binary = readFileSync(join(where, 'dist', 'version'), 'utf8').trim();
  } catch {
    throw new Refusal(`no electron binary is installed in ${join(where, 'dist')}: run npx install-electron`);
  }
  if (binary !== installed) {
    throw new Refusal(`the electron binary is ${binary} and its package ${installed} (${where}): run npx install-electron`);
  }
  return installed;
}

/** Step 1. Throws the first Refusal met, in the order a person would check. */
export async function checkPreconditions({ root, repo, version }) {
  const fetched = await run('git', ['fetch', 'origin'], { cwd: root });
  if (fetched.code !== 0) throw new Refusal(`git fetch origin failed: ${firstLine(fetched.stderr)}`);
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const main = (await git(root, ['rev-parse', 'origin/main'])).trim();
  if (head !== main) {
    throw new Refusal(`HEAD ${head.slice(0, 7)} is not origin/main ${main.slice(0, 7)}: a release is built from what main holds, nothing else`);
  }

  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty) throw new Refusal(`tracked files differ from HEAD, so the build would not be the commit:\n${dirty}`);

  const electron = checkElectron(root);

  const release = await run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'tagName']);
  if (release.missing) throw new Refusal('gh is not installed');
  if (release.code === 0) throw new Refusal(`v${version} is already published on ${repo}: bump the version`);
  if (!/release not found/i.test(release.stderr)) {
    throw new Refusal(`could not check whether v${version} is published on ${repo}: ${firstLine(release.stderr)}`);
  }
  // A tag with no release would be reused as it is, wherever it points, and the
  // release would not be the commit built.
  const tag = await run('gh', ['api', `repos/${repo}/git/ref/tags/v${version}`]);
  if (tag.code === 0) throw new Refusal(`the tag v${version} already exists on ${repo}, without a release`);
  if (!/HTTP 404/.test(tag.stderr)) {
    throw new Refusal(`could not check whether the tag v${version} exists on ${repo}: ${firstLine(tag.stderr)}`);
  }

  const top = changelogTop(root);
  if (top.version !== version) {
    throw new Refusal(`the top entry of src/data/changelog.ts is ${top.version}, and package.json says ${version}`);
  }

  const listed = await ghJson(['release', 'list', '--repo', repo, '--limit', '1000', '--json', 'tagName']);
  const newer = listed
    .map(r => /^v(\d+\.\d+\.\d+)$/.exec(String(r?.tagName))?.[1])
    .filter(v => v && compareVersions(v, version) < 0)
    .sort(compareVersions);
  if (newer.length) throw new Refusal(`a newer version is already published on ${repo}: v${newer[0]}`);

  return { head, top, electron };
}

/** latest-mac.yml as electron-updater reads it. Anything else in it is refused, not skipped. */
export function parseLatestMac(text) {
  const unquote = v => (/^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : /^".*"$/.test(v) ? JSON.parse(v) : v);
  const manifest = { files: [] };
  let inFiles = false;
  let entry = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let m;
    if ((m = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line))) {
      inFiles = m[1] === 'files' && m[2] === '';
      entry = null;
      if (!inFiles) manifest[m[1]] = unquote(m[2]);
    } else if (inFiles && (m = /^ {2}- ([A-Za-z0-9]+):\s*(.*)$/.exec(line))) {
      entry = { [m[1]]: unquote(m[2]) };
      manifest.files.push(entry);
    } else if (inFiles && entry && (m = /^ {4}([A-Za-z0-9]+):\s*(.*)$/.exec(line))) {
      entry[m[1]] = unquote(m[2]);
    } else {
      throw new Refusal(`latest-mac.yml has a line this check does not understand: ${line}`);
    }
  }
  return manifest;
}

function sha512Base64(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('error', fail)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => done(hash.digest('base64')));
  });
}

/**
 * Step 3. The files the manifest describes, checked against it: a wrong sha512
 * makes every installed Tars reject the download.
 */
export async function verifyArtifacts(releaseDir, version) {
  const yml = join(releaseDir, 'latest-mac.yml');
  if (!existsSync(yml)) throw new Refusal(`${yml} does not exist`);
  const manifest = parseLatestMac(readFileSync(yml, 'utf8'));
  if (manifest.version !== version) throw new Refusal(`latest-mac.yml is for ${manifest.version}, not ${version}`);

  const found = {};
  for (const kind of ['dmg', 'zip']) {
    const entries = manifest.files.filter(f => String(f.url).endsWith(`.${kind}`));
    if (entries.length !== 1 || versionOf(String(entries[0].url)) !== version) {
      throw new Refusal(`latest-mac.yml does not name exactly one ${kind} of ${version}`);
    }
    const file = join(releaseDir, entries[0].url);
    if (!existsSync(file)) throw new Refusal(`${file} is named in latest-mac.yml and does not exist`);
    const { size } = statSync(file);
    if (Number(entries[0].size) !== size) throw new Refusal(`latest-mac.yml gives ${entries[0].url} ${entries[0].size} bytes, the file has ${size}`);
    if (entries[0].sha512 !== await sha512Base64(file)) throw new Refusal(`the sha512 in latest-mac.yml is not that of ${entries[0].url}`);
    found[kind] = { file, sha512: entries[0].sha512 };
  }
  if (manifest.path !== basename(found.zip.file) || manifest.sha512 !== found.zip.sha512) {
    throw new Refusal('the top-level path and sha512 of latest-mac.yml are not those of the zip');
  }

  const plist = join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist');
  const shown = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (shown.code !== 0) throw new Refusal(`could not read the version of the built app in ${plist}`);
  if (shown.stdout.trim() !== version) throw new Refusal(`the built app says ${shown.stdout.trim()}, not ${version}`);

  return { dmg: found.dmg.file, zip: found.zip.file, yml };
}

/** Step 4. The v1.7.1 notes are the model; a long dash is refused, not replaced. */
export function composeNotes(top) {
  const notes = `## Ce qui change\n\n${top.updates.map(u => `- ${u}`).join('\n')}\n\n---\n\n${NOTES_FOOTER}\n`;
  if (/[–—]/.test(notes)) throw new Refusal(`the ${top.version} changelog entry has a long dash: rewrite the sentence`);
  return notes;
}

function sameBytes(a, b) {
  return readFileSync(a).equals(readFileSync(b));
}

async function appVersion(releaseDir) {
  const plist = join(releaseDir, 'mac-arm64', 'Tars.app', 'Contents', 'Info.plist');
  if (!existsSync(plist)) return undefined;
  const shown = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  return shown.code === 0 ? shown.stdout.trim() : undefined;
}

/** What every build writes whatever its version, so they belong to the last build put in a folder. */
const SHARED = ['latest-mac.yml', 'builder-debug.yml', 'mac-arm64'];

/**
 * The build `dir` holds, and whether a build of `version` may take its place.
 *
 * Two things write over that build: electron-builder, in the folder it builds
 * into, and step 7, in the kept folder. Another version's build is given up
 * only when it is older and GitHub proves it published with that very
 * manifest, since writing over the manifest of an unpublished version is how
 * 1.6.19's was lost. A build of `version` itself is returned for the caller to
 * judge.
 */
export async function buildHeldIn({ dir, version, repo }) {
  const shared = SHARED.filter(n => existsSync(join(dir, n)));
  if (shared.length === 0) return { version: undefined, shared };
  const yml = join(dir, 'latest-mac.yml');
  const there = existsSync(yml) ? parseLatestMac(readFileSync(yml, 'utf8')).version : await appVersion(dir);
  if (!there) throw new Refusal(`${dir} holds a build whose version cannot be read: not overwritten`);
  if (there === version) return { version: there, shared };
  if (compareVersions(there, version) < 0) throw new Refusal(`${dir} holds ${there}, newer than ${version}: not overwritten`);

  const proof = await publicationOf(there, repo, readdirSync(dir).filter(n => versionOf(n) === there).map(n => join(dir, n)));
  if (proof.status !== 'published') throw new Refusal(`${dir} holds ${there}, which is not proven published (${proof.reason}): its manifest is not overwritten`);
  if (existsSync(yml)) {
    const served = await ghJson(['release', 'view', `v${there}`, '--repo', repo, '--json', 'assets']);
    const asset = served.assets?.find(a => a.name === 'latest-mac.yml');
    if (!asset?.digest || asset.digest !== `sha256:${await sha256Of(yml)}`) {
      throw new Refusal(`the latest-mac.yml of ${there} in ${dir} is not the one published: not overwritten`);
    }
  }
  return { version: there, shared };
}

/**
 * Step 7. Everything is checked before anything moves, and nothing is copied.
 *
 * The files of this version must not already be there with other bytes, and
 * the build the kept folder holds is replaced only as `buildHeldIn` allows.
 */
export async function moveToCanonical({ fromDir, toDir, version, repo }) {
  if (realpathSync(fromDir) === (existsSync(toDir) ? realpathSync(toDir) : toDir)) return { moved: [], replaced: [] };
  mkdirSync(toDir, { recursive: true });

  const own = readdirSync(fromDir).filter(n => versionOf(n) === version);
  const shared = SHARED.filter(n => existsSync(join(fromDir, n)));

  const drop = [];
  for (const name of own) {
    const to = join(toDir, name);
    if (!existsSync(to)) continue;
    if (!sameBytes(join(fromDir, name), to)) throw new Refusal(`${to} already exists with other bytes than this build: not overwritten`);
    drop.push(name);
  }

  const replace = [];
  const held = await buildHeldIn({ dir: toDir, version, repo });
  if (held.version === version) {
    const existingYml = join(toDir, 'latest-mac.yml');
    if (!existsSync(existingYml) || !sameBytes(join(fromDir, 'latest-mac.yml'), existingYml)) {
      throw new Refusal(`${toDir} already holds another build of ${version}: not overwritten`);
    }
    drop.push(...shared);
  } else {
    replace.push(...shared.filter(n => held.shared.includes(n)));
  }

  const moved = [];
  for (const name of [...own, ...shared]) {
    const from = join(fromDir, name);
    const to = join(toDir, name);
    if (drop.includes(name)) {
      rmSync(from, { recursive: true, force: true });
      continue;
    }
    if (replace.includes(name)) rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
    } catch (err) {
      throw new Refusal(`could not move ${from} to ${to} (${err.code}), and a release is moved, never copied`);
    }
    moved.push(name);
  }
  return { moved, replaced: replace };
}

/** Step 6. What GitHub serves, against what was built. */
async function readBack({ repo, version, head, dmg, zip, yml }) {
  const ref = await ghJson(['api', `repos/${repo}/git/ref/tags/v${version}`]);
  let target = ref.object?.sha;
  if (ref.object?.type === 'tag') target = (await ghJson(['api', `repos/${repo}/git/tags/${target}`])).object?.sha;
  if (target !== head) throw new Refusal(`v${version} points at ${target}, not at the commit built ${head}`);

  for (const file of [dmg, zip, yml]) {
    const local = `sha256:${await sha256Of(file)}`;
    let digest;
    for (let attempt = 0; attempt < 5 && !digest; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 2000));
      const { assets } = await ghJson(['release', 'view', `v${version}`, '--repo', repo, '--json', 'assets']);
      digest = assets?.find(a => a.name === basename(file))?.digest;
    }
    if (digest !== local) throw new Refusal(`GitHub serves ${basename(file)} with ${digest ?? 'no digest'}, the local file is ${local}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'tars-release-served-'));
  const got = await run('gh', ['release', 'download', `v${version}`, '--repo', repo, '--pattern', 'latest-mac.yml', '--dir', dir]);
  if (got.code !== 0 || !sameBytes(join(dir, 'latest-mac.yml'), yml)) {
    throw new Refusal('the latest-mac.yml GitHub serves is not the one checked');
  }
  rmSync(dir, { recursive: true, force: true });

  const latest = await ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== `v${version}`) throw new Refusal(`/releases/latest is ${latest.tag_name}, not v${version}`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), log = console.log } = {}) {
  const dryRun = argv.includes('--dry-run');
  try {
    const toplevel = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (toplevel.code !== 0) throw new Refusal(`${cwd} is not inside a git checkout`);
    const root = toplevel.stdout.trim();
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const repo = publishRepo(root);
    const canonical = await canonicalReleaseDir(root);
    if (canonical.error) throw new Refusal(canonical.error);
    const releaseDir = join(root, 'release');
    // By real path: the same temporary folder reads /var or /private/var.
    const inMainCheckout = realpathSync(dirname(canonical.dir)) === realpathSync(root);

    log(`release: v${version} of ${repo}, from ${root}${inMainCheckout ? '' : ' (a worktree)'}${dryRun ? ', dry run' : ''}`);

    const { head, top: entry, electron } = await checkPreconditions({ root, repo, version });
    log(`1. checks passed: HEAD ${head.slice(0, 7)} is origin/main, tracked tree clean, electron ${electron} installed as locked, v${version} not on GitHub, changelog top entry ${version}, nothing newer published`);

    // Before anything is built, and in a dry run too, so that it says what the
    // real run would refuse. The build writes over the build release/ holds.
    // From a worktree, step 7 then moves it into the kept folder: whatever would
    // stop that move has to stop the release now, not once it is public.
    const held = await buildHeldIn({ dir: releaseDir, version, repo });
    if (!inMainCheckout) {
      const kept = await buildHeldIn({ dir: canonical.dir, version, repo });
      if (kept.version === version || (existsSync(canonical.dir) && readdirSync(canonical.dir).some(n => versionOf(n) === version))) {
        throw new Refusal(`${canonical.dir} already holds a build of ${version}: the one built here could not be moved there once published`);
      }
    }
    const over = !held.version ? ''
      : held.version === version ? `, over an earlier build of ${version}, which was never published`
        : `, over the build of ${held.version}, published with that manifest`;

    if (dryRun) {
      log(`2. would run npm run electron:build, without CI, GH_TOKEN or GITHUB_TOKEN${over}`);
    } else {
      log(`2. npm run electron:build, without CI, GH_TOKEN or GITHUB_TOKEN${over}`);
      const env = { ...process.env };
      for (const key of ['CI', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
      const build = spawnSync('npm', ['run', 'electron:build'], { cwd: root, env, stdio: 'inherit' });
      if (build.status !== 0) throw new Refusal('npm run electron:build failed');
    }

    let artifacts;
    const manifest = join(releaseDir, 'latest-mac.yml');
    // Between two releases, release/ of the main checkout keeps the last one's
    // manifest: a dry run checks a build of this version, or waits for it.
    const built = existsSync(manifest) ? parseLatestMac(readFileSync(manifest, 'utf8')).version : undefined;
    if (dryRun && built !== version) {
      log(built
        ? `3. ${releaseDir} holds the build of ${built}: would check the artifacts of ${version} once built`
        : `3. no artifacts in ${releaseDir} yet: would check them once built`);
    } else {
      artifacts = await verifyArtifacts(releaseDir, version);
      log(`3. artifacts checked: ${basename(artifacts.dmg)}, ${basename(artifacts.zip)} and latest-mac.yml agree, and the app says ${version}`);
    }

    const notes = composeNotes(entry);
    log(`4. notes:\n${notes}`);

    const dmgName = artifacts ? artifacts.dmg : join(releaseDir, `Tars-${version}-arm64.dmg`);
    const zipName = artifacts ? artifacts.zip : join(releaseDir, `Tars-${version}-arm64-mac.zip`);
    const create = ['release', 'create', `v${version}`, dmgName, zipName, manifest, '--repo', repo, '--target', head,
      '--title', `Tars ${version}`, '--latest', '--notes-file'];

    if (dryRun) {
      log(`5. would run gh ${create.join(' ')} <notes>`);
      log(`6. would check that v${version} points at ${head.slice(0, 7)}, that each asset's digest is the local file's, that the served latest-mac.yml is this one, and that /releases/latest is v${version}`);
      log(inMainCheckout
        ? `7. nothing to move: this is the main checkout, and ${releaseDir} is the folder that is kept`
        : `7. would move this version's dmg, zip, blockmaps, latest-mac.yml, builder-debug.yml and mac-arm64 into ${canonical.dir}`);
      log(`8. would prune ${canonical.dir}, deleting only versions GitHub proves published`);
      log(`9. would print the dmg in ${canonical.dir} and https://github.com/${repo}/releases/tag/v${version}`);
      return 0;
    }

    const notesDir = mkdtempSync(join(tmpdir(), 'tars-release-notes-'));
    const notesFile = join(notesDir, 'notes.md');
    writeFileSync(notesFile, notes);
    const created = await run('gh', [...create, notesFile]);
    rmSync(notesDir, { recursive: true, force: true });
    if (created.code !== 0) throw new Refusal(`gh release create failed: ${firstLine(created.stderr)}`);
    log(`5. published v${version}`);

    await readBack({ repo, version, head, ...artifacts });
    log('6. GitHub serves exactly what was built');

    if (!inMainCheckout) {
      const { moved, replaced } = await moveToCanonical({ fromDir: releaseDir, toDir: canonical.dir, version, repo });
      log(`7. moved ${moved.join(', ') || 'nothing'} into ${canonical.dir}${replaced.length ? `, replacing the older ${replaced.join(', ')}` : ''}`);
    } else {
      log('7. nothing to move: built in the main checkout');
    }

    await prune({ releaseDir: canonical.dir, repo, log: line => log(`8. ${line}`) });

    log(`9. ${join(canonical.dir, basename(artifacts.dmg))}`);
    log(`   https://github.com/${repo}/releases/tag/v${version}`);
    return 0;
  } catch (err) {
    if (err instanceof Refusal) {
      log(`release: stopped. ${err.message}`);
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
