import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * A stand-in for gh, first on the PATH, so the release scripts can be driven
 * without the network and without ever reaching the real repository.
 *
 * It answers the calls the scripts make the way gh 2.88 does, measured on
 * 16/09: a missing release is `release not found` with exit 1, an outage is
 * `error connecting to ...` with the same exit 1, and a missing tag through
 * `gh api` is `gh: Not Found (HTTP 404)`. Anything else is refused with exit 99
 * and written to the log like every call, and so are `release create` and
 * `release upload` unless the test has called `allowPublishing()`: a test
 * publishes because it says so by name, never because of a state it copied
 * from another test. An upload over an asset already there is refused as gh
 * refuses it without --clobber, before anything is sent.
 */

/** `state` is `uploaded` unless given: GitHub lists an asset whose upload has not finished as `open`. */
export type FakeAsset = { name: string; size: number; digest: string | null; state?: string };
export type FakeRelease = {
  assets: FakeAsset[];
  /** The commit its tag points at. `release create` records its `--target`. */
  target?: string;
  title?: string;
  notes?: string;
};
export type FakeGhState = {
  /** Every call fails as gh does with no network. */
  offline?: boolean;
  /** Per tag, a failure that is neither "not found" nor an outage. */
  failFor?: Record<string, string>;
  releases?: Record<string, FakeRelease>;
  /** Tags that exist with no release. */
  tags?: string[];
  latest?: string;
  /**
   * What GitHub serves instead of what it was sent: the commit every tag points
   * at, the digest of an asset by name, the bytes of a downloaded
   * latest-mac.yml or latest.yml, the tag of /releases/latest.
   */
  serve?: { target?: string; digests?: Record<string, string>; manifest?: string; latest?: string };
  /**
   * What `serve` becomes once the first `release upload` has gone through: a
   * GitHub that changes under a release between its upload and its read-back.
   */
  serveAfterUpload?: { target?: string; digests?: Record<string, string>; manifest?: string; latest?: string };
  /** Every tag is an annotated tag object, which `git/tags/<sha>` resolves to its commit. */
  annotatedTags?: boolean;
};

const SCRIPT = `
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const home = path.dirname(process.env.FAKE_GH_STATE);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const serve = state.serve || {};
const fail = (text, code) => { process.stderr.write(text + '\\n'); process.exit(code); };
const outage = () => fail('error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com', 1);
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const [cmd, sub] = args;
if (cmd === 'release' && sub === 'view') {
  const tag = args[2];
  if (state.offline) outage();
  if (state.failFor && state.failFor[tag]) fail(state.failFor[tag], 1);
  const release = state.releases && state.releases[tag];
  if (!release) fail('release not found', 1);
  const served = a => (serve.digests && serve.digests[a.name] ? { digest: serve.digests[a.name] } : {});
  process.stdout.write(JSON.stringify({ tagName: tag, assets: release.assets.map(a => Object.assign({ state: 'uploaded' }, a, served(a))) }));
  process.exit(0);
}
if (cmd === 'release' && sub === 'list') {
  if (state.offline) outage();
  process.stdout.write(JSON.stringify(Object.keys(state.releases || {}).map(tagName => ({ tagName }))));
  process.exit(0);
}
if (cmd === 'release' && sub === 'create') {
  if (!fs.existsSync(path.join(home, 'publishing-allowed'))) fail('fake gh: this test did not allow publishing: ' + args.join(' '), 99);
  if (state.offline) outage();
  const tag = args[2];
  state.releases = state.releases || {};
  if (state.releases[tag]) fail('a release with the same tag name already exists: ' + tag, 1);
  const files = [];
  for (let i = 3; i < args.length && !args[i].startsWith('--'); i++) files.push(args[i]);
  const uploads = path.join(home, 'uploads', tag);
  fs.mkdirSync(uploads, { recursive: true });
  const assets = files.map(file => {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(uploads, path.basename(file)), bytes);
    return { name: path.basename(file), size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'), state: 'uploaded' };
  });
  state.releases[tag] = { assets, target: option('--target'), title: option('--title'), notes: fs.readFileSync(option('--notes-file'), 'utf8') };
  if (args.includes('--latest')) state.latest = tag;
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  process.stdout.write('https://github.com/' + option('--repo') + '/releases/tag/' + tag + '\\n');
  process.exit(0);
}
if (cmd === 'release' && sub === 'upload') {
  if (!fs.existsSync(path.join(home, 'publishing-allowed'))) fail('fake gh: this test did not allow publishing: ' + args.join(' '), 99);
  if (state.offline) outage();
  const tag = args[2];
  const release = state.releases && state.releases[tag];
  if (!release) fail('release not found', 1);
  const files = [];
  for (let i = 3; i < args.length && !args[i].startsWith('--'); i++) files.push(args[i]);
  const dupes = files.map(file => path.basename(file)).filter(name => release.assets.some(a => a.name === name));
  if (dupes.length && !args.includes('--clobber')) fail('asset under the same name already exists: [' + dupes.join(' ') + ']', 1);
  const uploads = path.join(home, 'uploads', tag);
  fs.mkdirSync(uploads, { recursive: true });
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(uploads, path.basename(file)), bytes);
    release.assets = release.assets.filter(a => a.name !== path.basename(file));
    release.assets.push({ name: path.basename(file), size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'), state: 'uploaded' });
  }
  if (state.serveAfterUpload) {
    state.serve = state.serveAfterUpload;
    delete state.serveAfterUpload;
  }
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
  process.exit(0);
}
if (cmd === 'release' && sub === 'download') {
  const tag = args[2];
  if (state.offline) outage();
  if (!(state.releases && state.releases[tag])) fail('release not found', 1);
  const name = option('--pattern');
  const uploaded = path.join(home, 'uploads', tag, name);
  if (!fs.existsSync(uploaded)) fail('no assets match the file pattern', 1);
  const bytes = (name === 'latest-mac.yml' || name === 'latest.yml') && typeof serve.manifest === 'string' ? serve.manifest : fs.readFileSync(uploaded);
  fs.writeFileSync(path.join(option('--dir'), name), bytes);
  process.exit(0);
}
if (cmd === 'api') {
  if (state.offline) outage();
  const ref = /^repos\\/[^/]+\\/[^/]+\\/git\\/ref\\/tags\\/(.+)$/.exec(args[1] || '');
  if (ref) {
    const release = state.releases && state.releases[ref[1]];
    if ((state.tags || []).includes(ref[1]) || release) {
      const commit = serve.target || (release && release.target) || '0'.repeat(40);
      const object = state.annotatedTags ? { type: 'tag', sha: 'tag-object-of-' + commit } : { type: 'commit', sha: commit };
      process.stdout.write(JSON.stringify({ object }));
      process.exit(0);
    }
    fail('gh: Not Found (HTTP 404)', 1);
  }
  const tagObject = /^repos\\/[^/]+\\/[^/]+\\/git\\/tags\\/tag-object-of-(.+)$/.exec(args[1] || '');
  if (tagObject && state.annotatedTags) {
    process.stdout.write(JSON.stringify({ object: { type: 'commit', sha: tagObject[1] } }));
    process.exit(0);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/releases\\/latest$/.test(args[1] || '')) {
    process.stdout.write(JSON.stringify({ tag_name: serve.latest || state.latest }));
    process.exit(0);
  }
}
fail('fake gh: not a call these scripts may make here: ' + args.join(' '), 99);
`;

/**
 * Windows: execFile('gh') runs gh.com or gh.exe, never a file named `gh`, so a
 * script with a shebang is invisible there and the real gh.exe answered in the
 * fake's place. The fake is node itself under the name gh.exe (a hard link, so
 * no copy), and NODE_OPTIONS preloads the script below into it. Node takes gh's
 * first argument for a script path and resolves it against the cwd before the
 * preload runs; the preload gives it back as gh received it. Every other node
 * the tests start loads the preload too and returns at once.
 */
const WINDOWS_PRELOAD = `
const { basename, relative } = require('path');
if (basename(process.execPath).toLowerCase() === 'gh.exe') {
  const first = process.argv[1];
  const asGiven = first === undefined ? [] : [first.startsWith('-') ? first : relative(process.cwd(), first)];
  process.argv = [process.execPath, __filename, ...asGiven, ...process.argv.slice(2)];
  (function () {
${SCRIPT}
  })();
}
`;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The gh that execFile('gh') would run from this process with this PATH, or
 * undefined for none. libuv's search on Windows: the cwd, then each PATH entry,
 * trying gh.com and then gh.exe. execvp's elsewhere: the first executable `gh`
 * on the PATH.
 */
function resolveGh(searchPath: string): string | undefined {
  const dirs = searchPath.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    for (const dir of [process.cwd(), ...dirs]) {
      for (const ext of ['.com', '.exe']) {
        const candidate = path.join(dir, `gh${ext}`);
        if (isFile(candidate)) return candidate;
      }
    }
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, 'gh');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch {
      // Not there, or not executable: execvp goes on to the next entry too.
    }
  }
  return undefined;
}

export type FakeGh = {
  /** The folder the fake gh lives in, put first on the PATH by install(). */
  readonly bin: string;
  /**
   * Put the fake first on the PATH for everything this process starts. Throws,
   * and changes nothing, when the gh that PATH would run is not this fake.
   */
  install(): void;
  /** Put the PATH back as it was, and remove the fake's folder: read state() and calls() before. */
  uninstall(): void;
  setState(state: FakeGhState): void;
  /** What the fake GitHub holds now, with what `release create` added to it. */
  state(): FakeGhState;
  /** Let `release create` publish into this fake. Without it, it exits 99. */
  allowPublishing(): void;
  /** Every argv gh was called with, in order. */
  calls(): string[][];
};

export function fakeGh(state: FakeGhState = {}): FakeGh {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-fake-gh-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const onWindows = process.platform === 'win32';
  const gh = path.join(bin, onWindows ? 'gh.exe' : 'gh');
  const preload = path.join(dir, 'gh-preload.cjs');
  if (onWindows) {
    try {
      fs.linkSync(process.execPath, gh);
    } catch {
      // Another volume, or a file system without hard links.
      fs.copyFileSync(process.execPath, gh);
    }
    fs.writeFileSync(preload, WINDOWS_PRELOAD);
  } else {
    fs.writeFileSync(gh, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  }
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(logFile, '');

  const saved: Record<string, string | undefined> = {};
  return {
    bin,
    install() {
      const searchPath = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
      const found = resolveGh(searchPath);
      const same = (a: string, b: string) => (onWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
      if (found === undefined || !same(path.resolve(found), path.resolve(gh))) {
        throw new Error(`fake gh: the gh this PATH runs is ${found ?? 'none'}, which is not the fake ${gh}. `
          + 'Refused before any script could run it.');
      }
      const keys = ['PATH', 'FAKE_GH_STATE', 'FAKE_GH_LOG', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN'];
      if (onWindows) keys.push('NODE_OPTIONS');
      for (const key of keys) saved[key] = process.env[key];
      process.env.PATH = searchPath;
      if (onWindows) {
        // Forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape.
        const option = `--require "${preload.replace(/\\/g, '/')}"`;
        process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ${option}` : option;
      }
      process.env.FAKE_GH_STATE = stateFile;
      process.env.FAKE_GH_LOG = logFile;
      // Should a real gh ever run in its place, it finds no account to act as:
      // with an empty config directory and no token, gh says it is not logged in.
      process.env.GH_CONFIG_DIR = path.join(dir, 'no-gh-config');
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    },
    uninstall() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // The fake's folder with it (on Windows, a hard link or a copy of node):
      // nothing a test made is left in the temp dir. Windows may still hold
      // gh.exe a moment after the last run of it has exited: EBUSY on CI's
      // windows-latest. Linear backoff, 11 s at most.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
    setState(next) {
      fs.writeFileSync(stateFile, JSON.stringify(next));
    },
    state() {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    },
    allowPublishing() {
      fs.writeFileSync(path.join(dir, 'publishing-allowed'), '');
    },
    calls() {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

export const sha256 = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** The assets GitHub would list for a version whose dmg and zip hold `content`. */
export function publishedAssets(version: string, content = 'x', extra: FakeAsset[] = []): FakeAsset[] {
  return [
    { name: `Tars-${version}-arm64.dmg`, size: Buffer.byteLength(content), digest: sha256(content) },
    { name: `Tars-${version}-arm64-mac.zip`, size: Buffer.byteLength(content), digest: sha256(content) },
    ...extra,
  ];
}
