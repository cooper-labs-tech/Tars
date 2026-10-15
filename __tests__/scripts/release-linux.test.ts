import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fakeGh, publishedAssets, sha256, type FakeGh, type FakeGhState } from './fake-gh';
import {
  ARCHES, artifactNames, builderArgs, buildSteps, main, parseArgs, verifyLinuxBuild, WORKFLOW,
} from '../../scripts/release-linux.mjs';
import { Refusal } from '../../scripts/release.mjs';

/**
 * `npm run release:linux`: the Linux build of a version `npm run release` has
 * released, added to that same release, which every installed Tars reads (the
 * maintainer's parity rule of 2026-10-16: a published Linux build, x64 and
 * arm64). The AppImages are built on GitHub's Linux runners (a workflow with a
 * read-only token), and uploaded from a checkout with the maintainer's gh.
 *
 * How it can fail, each case below:
 *  - the arguments: anything but --dry-run, or --build on a runner, taken; or
 *    the two together;
 *  - the names: an AppImage named by electron-builder's default (no
 *    build.linux.artifactName), the arm64 build's feed named latest-linux.yml
 *    (it would overwrite x64's, and arm64 installs read latest-linux-arm64.yml),
 *    an architecture that is not built taken;
 *  - package.json: no Linux target, an AppImage for one architecture only, or a
 *    Linux feed of its own (build.linux.publish) instead of build.publish;
 *  - the build on a runner: run off Linux (its native modules would be the
 *    Mac's), a step missing or out of order, electron-builder not last, another
 *    platform or architecture built, or the build left able to publish by itself
 *    (CI, GH_TOKEN, GITHUB_TOKEN);
 *  - the build's checks: a feed for another version, whose size or sha512 is not
 *    the AppImage's, a feed that is not build.publish, an app that says another
 *    version, no Linux pty.node, the Windows conpty.node, no better_sqlite3.node,
 *    no hooks, an MCP bundle missing, or what the app never loads shipped (next,
 *    its compiler, another platform's prebuilds), each in the right unpacked app
 *    for its architecture;
 *  - the release: anything dispatched or written in a dry run; a checkout that is
 *    not origin/main, or a tree that differs from it; the Linux files added to a
 *    version not released, to a release whose tag is elsewhere, to one no longer
 *    the latest, or over Linux files already there; a GitHub it cannot ask taken
 *    for a pass;
 *  - the runners: a run of another commit taken for this one, a run that failed
 *    or never appeared taken for a success, an artifact whose feed is not its
 *    AppImage's uploaded anyway;
 *  - the upload: a feed uploaded before both AppImages (an install would read a
 *    feed whose file is not there), GitHub changed while the runners built (a
 *    newer release) and the upload going ahead, what GitHub serves not read back.
 * No test runs electron-builder, a runner or the real GitHub: the build is a
 * function that lays files out, and gh is the fake.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = '2.0.4';
const REPO = 'acme/tars';
const PKG = { ...REAL_PKG, version: VERSION, build: { ...REAL_PKG.build, publish: { provider: 'github', owner: 'acme', repo: 'tars' } } };
const MCPS = REAL_PKG.build.extraResources.map((e: { from: string }) => e.from).filter((from: string) => from.startsWith('mcp-'));
const LINUX_FILES = [`Tars-${VERSION}-x64.AppImage`, `Tars-${VERSION}-arm64.AppImage`, 'latest-linux.yml', 'latest-linux-arm64.yml'];

const sha512 = (content: string | Buffer) => createHash('sha512').update(content).digest('base64');

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
  ymlVersion?: string; wrongSha?: boolean; wrongSize?: boolean; feedOwner?: string; appVersion?: string;
  noPty?: boolean; conpty?: boolean; noSqlite?: boolean; noHooks?: boolean; noMcp?: string;
  packed?: string; unpacked?: string;
};

/** The published pair of one architecture: its AppImage and its feed, in `dir`. */
function publishedPair(dir: string, version: string, arch: string, broken: Breakage = {}) {
  const names = artifactNames(PKG, version, arch);
  const bytes = `AppImage ${arch} of ${version}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, names.appImage), bytes);
  const sha = broken.wrongSha ? sha512('other') : sha512(bytes);
  fs.writeFileSync(path.join(dir, names.yml), [
    `version: ${broken.ymlVersion ?? version}`,
    'files:',
    `  - url: ${names.appImage}`,
    `    sha512: ${sha}`,
    `    size: ${Buffer.byteLength(bytes) + (broken.wrongSize ? 1 : 0)}`,
    `path: ${names.appImage}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-10-16T10:00:00.000Z'",
    '',
  ].join('\n'));
  return names;
}

/** What electron-builder leaves in release/ on a runner of `arch`. */
function linuxBuild(releaseDir: string, version: string, arch: string, broken: Breakage = {}) {
  publishedPair(releaseDir, version, arch, broken);
  const res = path.join(releaseDir, arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`, 'resources');
  const unpacked = path.join(res, 'app.asar.unpacked');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'app-update.yml'), `owner: ${broken.feedOwner ?? 'acme'}\nrepo: tars\nprovider: github\nupdaterCacheDirName: tars-updater\n`);
  writeAsar(path.join(res, 'app.asar'), {
    'package.json': JSON.stringify({ name: 'tars', version: broken.appVersion ?? version }),
    'node_modules/xterm/package.json': '{}',
    ...(broken.packed ? { [broken.packed]: 'x' } : {}),
  });
  const put = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(unpacked, rel)), { recursive: true });
    fs.writeFileSync(path.join(unpacked, rel), 'x');
  };
  if (!broken.noPty) put('node_modules/node-pty/build/Release/pty.node');
  if (broken.conpty) put('node_modules/node-pty/build/Release/conpty.node');
  if (!broken.noSqlite) put('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  if (!broken.noHooks) put('hooks/session-start.sh');
  if (broken.unpacked) put(broken.unpacked);
  for (const e of PKG.build.extraResources) {
    if (!(e.filter ?? []).includes('dist/bundle.js') || e.from === broken.noMcp) continue;
    fs.mkdirSync(path.join(res, e.to, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(res, e.to, 'dist', 'bundle.js'), 'x');
  }
}

describe('what it is asked', () => {
  it('reads --dry-run, or --build on a runner, and refuses anything else, or both', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, build: false });
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, build: false });
    expect(parseArgs(['--build'])).toEqual({ dryRun: false, build: true });
    for (const argv of [['--publish'], ['--arch', 'x64'], ['2.0.5'], ['--dry-run', '--build']]) {
      expect(() => parseArgs(argv), argv.join(' ')).toThrow(Refusal);
    }
  });
});

describe('the names, and package.json', () => {
  it('one AppImage per architecture, and each its own feed: latest-linux.yml on x64, latest-linux-arm64.yml on arm64', () => {
    expect(ARCHES).toEqual(['x64', 'arm64']);
    expect(artifactNames(PKG, VERSION, 'x64')).toEqual({ appImage: `Tars-${VERSION}-x64.AppImage`, yml: 'latest-linux.yml' });
    expect(artifactNames(PKG, VERSION, 'arm64')).toEqual({ appImage: `Tars-${VERSION}-arm64.AppImage`, yml: 'latest-linux-arm64.yml' });
    expect(() => artifactNames(PKG, VERSION, 'ia32')).toThrow(/no Linux build for ia32/);
    const noName = { ...PKG, build: { ...PKG.build, linux: { ...PKG.build.linux, artifactName: undefined } } };
    expect(() => artifactNames(noName, VERSION, 'x64')).toThrow(/build\.linux\.artifactName is not set/);
  });

  it('package.json builds the AppImage for both, and feeds Linux from build.publish, as macOS and Windows', () => {
    const linux = REAL_PKG.build.linux;
    expect(linux).toBeTruthy();
    expect(linux.target).toEqual([{ target: 'AppImage', arch: ['x64', 'arm64'] }]);
    expect(linux.publish).toBeUndefined();
    expect(REAL_PKG.scripts['release:linux']).toBe('node scripts/release-linux.mjs');
  });
});

describe('the build on a runner', () => {
  it.each(ARCHES)('%s: the renderer, the main process, each MCP bundle, then electron-builder for that architecture only, never publishing', (arch) => {
    const steps = buildSteps(ROOT, arch, { npmCommand: (command: string, args: string[]) => ({ command, args }) });
    expect(steps.map(s => s.label)).toEqual([
      'npm run build:renderer',
      'tsc -p electron/tsconfig.json',
      ...MCPS.flatMap((m: string) => [`${m}: npm install`, `${m}: npm run build`]),
      `electron-builder --linux AppImage --${arch} --publish never`,
    ]);
    expect(builderArgs(arch)).toEqual(['--linux', 'AppImage', `--${arch}`, '--publish', 'never']);
    expect(steps.at(-1)!.args).not.toContain('--mac');
    expect(steps.at(-1)!.args).not.toContain('--win');
  });

  it('checks what each architecture built, in its own unpacked app', () => {
    for (const arch of ARCHES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-linux-build-'));
      try {
        linuxBuild(dir, VERSION, arch);
        expect(verifyLinuxBuild(dir, VERSION, { repo: REPO, pkg: PKG, arch })).toEqual({
          appImage: path.join(dir, `Tars-${VERSION}-${arch}.AppImage`), yml: path.join(dir, arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml'),
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it.each<[string, Breakage, RegExp]>([
    ['a feed for another version', { ymlVersion: '2.0.3' }, /latest-linux\.yml is for 2\.0\.3, not 2\.0\.4/],
    ['a feed whose sha512 is not the AppImage\'s', { wrongSha: true }, /the sha512 in latest-linux\.yml is not that of/],
    ['a feed whose size is not the AppImage\'s', { wrongSize: true }, /gives Tars-2\.0\.4-x64\.AppImage \d+ bytes, the file has/],
    ['an app fed from another repository', { feedOwner: 'someone-else' }, /feeds github someone-else\/tars, not github acme\/tars/],
    ['an app that says another version', { appVersion: '2.0.3' }, /the built app says 2\.0\.3, not 2\.0\.4/],
    ['no Linux pty.node', { noPty: true }, /no pty\.node: no terminal can start/],
    ['the Windows conpty.node', { conpty: true }, /carries the Windows conpty\.node/],
    ['no better_sqlite3.node', { noSqlite: true }, /no better_sqlite3\.node/],
    ['no hooks', { noHooks: true }, /hooks\/ is not in app\.asar\.unpacked/],
    ['an MCP bundle missing', { noMcp: 'mcp-vault' }, /mcp-vault\/dist\/bundle\.js is missing|dist\/bundle\.js is missing/],
    ['next packed in the asar', { packed: 'node_modules/next/package.json' }, /ships node_modules\/next\/package\.json, which it never loads on Linux/],
    ['a macOS prebuild of node-pty unpacked', { unpacked: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node' }, /ships node_modules\/node-pty\/prebuilds\/darwin-arm64\/pty\.node/],
  ])('refuses %s', (_what, broken, message) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-linux-build-'));
    try {
      linuxBuild(dir, VERSION, 'x64', broken);
      expect(() => verifyLinuxBuild(dir, VERSION, { repo: REPO, pkg: PKG, arch: 'x64' })).toThrow(message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── main(), in a checkout of its own ─────────────────────────────────────

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', encoding: 'utf8' });

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-release-linux-co-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'checkout');
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tars', version: VERSION, build: PKG.build }, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'release/\nbuild/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { root, dir, head: git(dir, 'rev-parse', 'HEAD').trim() };
}

/** GitHub after `npm run release` and `npm run release:win` of VERSION on `head`. */
function released(head: string, extra: FakeGhState = {}): FakeGhState {
  return {
    releases: { [`v${VERSION}`]: { assets: [...publishedAssets(VERSION), { name: 'latest-mac.yml', size: 1, digest: sha256('m') }, { name: 'latest.yml', size: 1, digest: sha256('w') }], target: head } },
    latest: `v${VERSION}`,
    ...extra,
  };
}

describe('npm run release:linux', { timeout: 60_000 }, () => {
  let gh: FakeGh;
  let roots: string[];

  /** The runners' artifacts: one folder per architecture, as upload-artifact names them. */
  function artifacts(head: string, broken: Partial<Record<string, Breakage>> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-linux-artifacts-'));
    roots.push(dir);
    const out: Record<string, string> = {};
    for (const arch of ARCHES) {
      const into = path.join(dir, arch);
      publishedPair(into, VERSION, arch, broken[arch]);
      out[`tars-linux-${arch}-${head}`] = into;
    }
    return out;
  }

  async function releaseLinux(cwd: string, ...argv: string[]) {
    const lines: string[] = [];
    const code = await main(argv, { cwd, log: (line: string) => lines.push(line), wait: async () => {}, build: async () => { throw new Error('no build here'); } });
    return { code, out: lines.join('\n') };
  }

  const writes = () => gh.calls().filter(args => (args[0] === 'release' && args[1] === 'upload') || (args[0] === 'workflow' && args[1] === 'run'));

  beforeEach(() => {
    gh = fakeGh({});
    gh.install();
    roots = [];
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

  it('dispatches the runners on HEAD, then uploads both AppImages, then both feeds, to the release, and reads them back', async () => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { artifacts: artifacts(head) } });
    gh.allowPublishing();

    const { code, out } = await releaseLinux(dir);

    expect(out).toContain('GitHub serves exactly what was built');
    expect(code).toBe(0);
    const w = writes();
    expect(w[0]).toEqual(['workflow', 'run', WORKFLOW, '--repo', REPO, '--ref', 'main', '-f', `ref=${head}`]);
    expect(w.slice(1).map(a => path.basename(a[3]))).toEqual(LINUX_FILES);
    expect(w.slice(1).every(a => a[2] === `v${VERSION}` && a.at(-1) === REPO)).toBe(true);
    const served = gh.state().releases![`v${VERSION}`];
    expect(served.target).toBe(head);
    expect(served.assets.map(a => a.name).slice(-4)).toEqual(LINUX_FILES);
  });

  it('dry run: checks the release, dispatches nothing and writes nothing', async () => {
    const { dir, head } = co();
    gh.setState(released(head));
    gh.allowPublishing();

    const { code, out } = await releaseLinux(dir, '--dry-run');

    expect(code).toBe(0);
    expect(writes()).toEqual([]);
    expect(out).toMatch(new RegExp(`would run gh workflow run ${WORKFLOW} .*-f ref=${head}`));
    expect(out).toContain('latest-linux-arm64.yml');
  });

  it.each<[string, (head: string) => FakeGhState, RegExp]>([
    ['a version npm run release has not released', () => ({}), /v2\.0\.4 is not released on acme\/tars: npm run release publishes it first/],
    ['a release whose tag is on another commit', () => released('f'.repeat(40)), /v2\.0\.4 points at f{40}, not at HEAD/],
    ['a release that is no longer the latest', head => released(head, { latest: 'v2.0.5' }), /the latest release on acme\/tars is v2\.0\.5, not v2\.0\.4/],
    ['a release that already carries an AppImage', head => {
      const state = released(head);
      state.releases![`v${VERSION}`].assets.push({ name: `Tars-${VERSION}-arm64.AppImage`, size: 1, digest: sha256('a') });
      return state;
    }, /already carries Tars-2\.0\.4-arm64\.AppImage.*delete-asset/],
    ['a GitHub it cannot ask', () => ({ offline: true }), /could not read v2\.0\.4 on acme\/tars: error connecting/],
  ])('refuses %s, before dispatching, in a dry run as in a real one', async (_what, state, message) => {
    for (const argv of [['--dry-run'], []]) {
      const { dir, head } = co();
      gh.setState(state(head));
      gh.allowPublishing();
      const { code, out } = await releaseLinux(dir, ...argv);
      expect(code).toBe(1);
      expect(out).toMatch(message);
    }
    expect(writes()).toEqual([]);
  });

  it('refuses a checkout that is not origin/main', async () => {
    const { dir, head } = co();
    gh.setState(released(head));
    gh.allowPublishing();
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local');
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/is not origin\/main/);
    expect(writes()).toEqual([]);
  });

  it('never takes a run of another commit for this one', async () => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { headSha: 'e'.repeat(40), artifacts: artifacts(head) } });
    gh.allowPublishing();
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/no run of release-linux\.yml for .* appeared/);
    expect(writes().filter(a => a[0] === 'release')).toEqual([]);
  });

  it('stops at a run that failed, with its address, and uploads nothing', async () => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { conclusion: 'failure', artifacts: artifacts(head) } });
    gh.allowPublishing();
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/run \d+ ended failure: https:\/\/github\.com\/acme\/tars\/actions\/runs\/\d+/);
    expect(writes().filter(a => a[0] === 'release')).toEqual([]);
  });

  it.each(ARCHES)('uploads nothing when the %s artifact\'s feed is not its AppImage\'s', async (arch) => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { artifacts: artifacts(head, { [arch]: { wrongSha: true } }) } });
    gh.allowPublishing();
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/the sha512 in latest-linux(-arm64)?\.yml is not that of/);
    expect(writes().filter(a => a[0] === 'release')).toEqual([]);
  });

  it('asks GitHub again after the runners: a newer release published meanwhile stops the upload', async () => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { artifacts: artifacts(head), afterDispatch: { latest: 'v2.0.5' } } });
    gh.allowPublishing();
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/the latest release on acme\/tars is v2\.0\.5/);
    expect(writes().filter(a => a[0] === 'release')).toEqual([]);
  });

  it('reads back what GitHub serves: a digest that is not the file\'s is said', async () => {
    const { dir, head } = co();
    gh.setState({ ...released(head), workflow: { artifacts: artifacts(head) }, serveAfterUpload: { digests: { [`Tars-${VERSION}-x64.AppImage`]: sha256('tampered') } } });
    gh.allowPublishing();
    const { code, out } = await releaseLinux(dir);
    expect(code).toBe(1);
    expect(out).toMatch(/GitHub serves Tars-2\.0\.4-x64\.AppImage with sha256:/);
  });

  it('--build refuses to run off Linux', async () => {
    const { dir } = co();
    for (const platform of ['darwin', 'win32'] as const) {
      const lines: string[] = [];
      const code = await main(['--build'], { cwd: dir, log: (l: string) => lines.push(l), platform, arch: 'x64', build: async () => { throw new Error('built'); } });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(new RegExp(`--build runs on Linux.*this is ${platform}`));
    }
  });

  it('--build on Linux builds its own architecture without anything that publishes, then checks it', async () => {
    const { dir } = co();
    for (const arch of ARCHES) {
      fs.rmSync(path.join(dir, 'release'), { recursive: true, force: true });
      const seen: { labels: string[]; env: Record<string, string | undefined> }[] = [];
      const saved = { ...process.env };
      process.env.GH_TOKEN = 'secret';
      process.env.CI = 'true';
      try {
        const lines: string[] = [];
        const code = await main(['--build'], {
          cwd: dir, log: (l: string) => lines.push(l), platform: 'linux', arch,
          npmCommand: (command: string, args: string[]) => ({ command, args }),
          build: async (steps: { label: string }[], { root, env }: { root: string; env: Record<string, string | undefined> }) => {
            seen.push({ labels: steps.map(s => s.label), env });
            linuxBuild(path.join(root, 'release'), VERSION, arch);
          },
        });
        expect(code, lines.join('\n')).toBe(0);
      } finally {
        process.env = saved;
      }
      expect(seen[0].labels.at(-1)).toBe(`electron-builder --linux AppImage --${arch} --publish never`);
      expect(seen[0].env).not.toHaveProperty('GH_TOKEN');
      expect(seen[0].env).not.toHaveProperty('CI');
      expect(writes()).toEqual([]);
    }
  });
});
