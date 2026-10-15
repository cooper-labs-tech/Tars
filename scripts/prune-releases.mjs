#!/usr/bin/env node
/**
 * Keep the current build and the one before it in the main checkout's release/,
 * and delete an older version only once GitHub proves it is published.
 *
 * `electron-builder` never cleans up after itself, so every build left another
 * 430MB in release/ and the directory reached 6.3GB across thirteen versions.
 * Two are kept rather than one so a bad release can be compared against, or
 * handed to someone, without a rebuild; two and not three, JeanBrasse's rule of
 * 2026-10-01.
 *
 * Two rules the 1.7.1 release got around, and that this file now enforces
 * instead of assuming:
 *
 * - **The folder is the main checkout's release/**, the one JeanBrasse opens, found
 *   through git from wherever this runs, a worktree included. It used to be
 *   release/ of the current directory: 1.7.0 and 1.7.1 were built in a
 *   worktree, the purge there saw two versions and did nothing, and the real
 *   folder stayed on 1.6.19 with 1.6.17 and 1.6.18 still in it. The current
 *   directory is never the default; tests name their folder explicitly.
 * - **A version is deleted only with proof it is published**: a release
 *   `v<version>` on the repository of `build.publish` carrying its dmg and its
 *   zip, the same size and, where GitHub gives a digest, the same bytes as the
 *   local files. This comment used to say every version was published, and
 *   nothing checked it: 1.6.19 was not, and the next purge would have deleted
 *   its last copy. When the proof cannot be had at all (gh missing, logged out,
 *   offline, an API error), nothing is deleted, the build still succeeds, and
 *   every version kept for that reason is named.
 *
 * Only the versioned artifacts are touched. `latest-mac.yml` is the updater's
 * manifest for the current version, `mac-arm64/` is the unpacked app, and
 * neither accumulates.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = 2;

/** `Tars-1.6.11-arm64.dmg` → `1.6.11`, and null for anything else. */
export function versionOf(name) {
  const m = name.match(/^Tars-(\d+\.\d+\.\d+)-/);
  return m ? m[1] : null;
}

/** Newest first. Numeric per part, so 1.6.10 sorts above 1.6.9. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function humanSize(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)}GB`
    : `${Math.round(bytes / 1024 ** 2)}MB`;
}

/**
 * A command with an argv array and no shell, as the repository requires.
 * Never rejects: the caller decides what a failure means.
 */
export function run(command, args, options = {}) {
  return new Promise(done => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      done({
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        missing: error?.code === 'ENOENT',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    });
  });
}

const firstLine = text => text.trim().split('\n')[0] ?? '';

/**
 * release/ of the main checkout, from the main checkout or any of its
 * worktrees: the parent of git's common directory. `--show-toplevel` would
 * answer the worktree, which is exactly the mistake this replaces.
 */
export async function canonicalReleaseDir(cwd = process.cwd()) {
  const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.missing) return { error: 'git is not installed' };
  if (r.code !== 0) return { error: `${cwd} is not inside a git checkout` };
  const commonDir = r.stdout.trim();
  if (basename(commonDir) !== '.git') {
    return { error: `git's directory ${commonDir} is not a checkout's .git, so there is no release/ beside it to trust` };
  }
  return { dir: join(dirname(commonDir), 'release') };
}

/** `owner/repo` of `build.publish` in the checkout that owns this release/. */
export function publishRepo(checkoutDir) {
  const pkg = JSON.parse(readFileSync(join(checkoutDir, 'package.json'), 'utf8'));
  const publish = [pkg.build?.publish].flat().find(p => p?.provider === 'github');
  if (!publish?.owner || !publish?.repo) {
    throw new Error(`no GitHub owner and repo in build.publish of ${join(checkoutDir, 'package.json')}`);
  }
  return `${publish.owner}/${publish.repo}`;
}

export function sha256Of(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', fail)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')));
  });
}

/**
 * Whether GitHub proves this version published, with a dmg and a zip that are
 * the local files.
 *
 * `unpublished` and `unknown` are kept apart on purpose. gh answers a missing
 * release and a network failure with the same exit code, so only the message
 * tells them apart, and reading an outage as "not published" would be a
 * harmless mistake while reading it as "published" would not be.
 */
export async function publicationOf(version, repo, files) {
  const r = await run('gh', ['release', 'view', `v${version}`, '--repo', repo, '--json', 'assets']);
  if (r.missing) return { status: 'unknown', reason: 'gh is not installed' };
  if (r.code !== 0) {
    if (/release not found/i.test(r.stderr)) return { status: 'unpublished', reason: `there is no release v${version} on ${repo}` };
    return { status: 'unknown', reason: firstLine(r.stderr) || `gh exited with ${r.code}` };
  }

  let assets;
  try {
    assets = JSON.parse(r.stdout).assets;
  } catch {
    return { status: 'unknown', reason: 'gh did not answer with JSON' };
  }
  if (!Array.isArray(assets)) return { status: 'unknown', reason: 'gh listed no assets' };

  for (const kind of ['dmg', 'zip']) {
    const local = files.find(f => f.endsWith(`.${kind}`));
    const remote = assets.find(a => a?.state === 'uploaded'
      && (local ? a.name === basename(local) : versionOf(String(a.name)) === version && String(a.name).endsWith(`.${kind}`)));
    if (!remote) return { status: 'unpublished', reason: `release v${version} on ${repo} has no ${kind}` };
    if (!local) continue;
    if (remote.size !== statSync(local).size) {
      return { status: 'unpublished', reason: `the published ${remote.name} is not the local file (size differs)` };
    }
    const digest = typeof remote.digest === 'string' ? remote.digest.replace(/^sha256:/, '') : '';
    if (digest && digest !== await sha256Of(local)) {
      return { status: 'unpublished', reason: `the published ${remote.name} is not the local file (sha256 differs)` };
    }
  }
  return { status: 'published' };
}

/**
 * Keep the newest `keep` versions; of the older ones, delete what GitHub proves
 * published, and name everything kept with its reason.
 */
export async function prune({ releaseDir, repo, keep = KEEP, log = console.log }) {
  let entries;
  try {
    entries = readdirSync(releaseDir);
  } catch {
    // Nothing built yet. Not an error: this runs as part of every build.
    log(`release: nothing in ${releaseDir}`);
    return { kept: [], pruned: [], held: [] };
  }

  const byVersion = new Map();
  for (const name of entries) {
    const version = versionOf(name);
    if (!version) continue;
    const list = byVersion.get(version);
    if (list) list.push(name);
    else byVersion.set(version, [name]);
  }

  const versions = [...byVersion.keys()].sort(compareVersions);
  const kept = versions.slice(0, keep);
  const older = versions.slice(keep);
  if (older.length === 0) {
    log(`release: ${versions.length} version(s) in ${releaseDir}, nothing to prune`);
    return { kept, pruned: [], held: [] };
  }

  // Every proof before any deletion: one version that cannot be checked means
  // gh cannot be trusted for the others either, and nothing goes.
  const proofs = new Map();
  for (const version of older) {
    proofs.set(version, await publicationOf(version, repo, byVersion.get(version).map(n => join(releaseDir, n))));
  }

  const held = [];
  if (older.some(v => proofs.get(v).status === 'unknown')) {
    for (const version of older) {
      const proof = proofs.get(version);
      const reason = proof.status === 'unknown'
        ? `its publication could not be checked: ${proof.reason}`
        : 'nothing is deleted while another version cannot be checked';
      held.push({ version, reason });
      log(`release: kept ${version}, ${reason}`);
    }
    log(`release: kept ${kept.join(', ')} as the newest; nothing pruned in ${releaseDir}`);
    return { kept, pruned: [], held };
  }

  const pruned = [];
  let freed = 0;
  for (const version of older) {
    const proof = proofs.get(version);
    if (proof.status !== 'published') {
      held.push({ version, reason: proof.reason });
      log(`release: kept ${version}, not published: ${proof.reason}`);
      continue;
    }
    for (const name of byVersion.get(version)) {
      const path = join(releaseDir, name);
      try {
        freed += statSync(path).size;
        rmSync(path, { force: true });
      } catch {
        // Already gone, or unreadable. Neither is worth failing a build over.
      }
    }
    pruned.push(version);
  }

  log(
    `release: kept ${kept.join(', ')} in ${releaseDir}`
    + (pruned.length ? `; pruned ${pruned.join(', ')}, published on ${repo} (${humanSize(freed)} freed)` : '; nothing pruned'),
  );
  return { kept, pruned, held };
}

/** `--release-dir <path>` or `TARS_RELEASE_DIR`, for tests. Never the current directory. */
function releaseDirOverride(argv, env, cwd) {
  const i = argv.indexOf('--release-dir');
  const value = i >= 0 ? argv[i + 1] : env.TARS_RELEASE_DIR;
  return value ? resolve(cwd, value) : undefined;
}

/** Always 0: this runs at the end of every build, and a purge never fails one. */
export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, log = console.log } = {}) {
  let releaseDir = releaseDirOverride(argv, env, cwd);
  if (!releaseDir) {
    const found = await canonicalReleaseDir(cwd);
    if (found.error) {
      log(`release: nothing pruned, ${found.error}`);
      return 0;
    }
    releaseDir = found.dir;
  }

  let repo;
  try {
    repo = publishRepo(dirname(releaseDir));
  } catch (err) {
    log(`release: nothing pruned, the repository to check publications on is unknown: ${err.message}`);
    return 0;
  }

  await prune({ releaseDir, repo, log });
  return 0;
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
