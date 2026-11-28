import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCliBinary } from '../platform';

/**
 * The exact version of the harness a traced session runs, read from the binary Tars launched (the agent's own CLI
 * path, else its provider's), once per binary file and modification time: an upgrade in place is read again.
 *
 * - **An npm package** says its own version: the package.json nearest the binary's real file, when its `bin` lists
 *   that file. Read, never run. A package.json that does not list it (a project's own, above a script) is not the
 *   harness's.
 * - **Anything else** is asked `--version` (core/version-probe.ts, which the quit ends) in a throwaway folder made for
 *   that one probe and removed after it: it runs there (its working folder, never Tars's own: the Audit's M1 on #677),
 *   with its own HOME, temporary, XDG and npm folders, npm's prefix inside it (an update prompt cannot install
 *   anything globally), and nothing of the owner's environment but the PATH the terminals get and, on Windows, the
 *   system's own variables. Never the owner's configuration.
 *
 * A probe that fails gives null and is not kept: the next session asks again. Two sessions at once share one probe.
 * A version longer than the back-office takes (MAX_VERSION_CHARS) is left out, never cut: a cut version is another one.
 */

/** The longest harness version the back-office takes. */
export const MAX_VERSION_CHARS = 40;

export interface HarnessVersionDeps {
  /** Runs `<binary> --version` in `cwd` (core/version-probe.ts probeVersion). */
  probe(binary: string, env: NodeJS.ProcessEnv, timeoutMs: number, cwd: string): Promise<{ stdout: string; stderr: string }>;
  /** The PATH the agents' terminals get (buildFullPath with the configured CLI folders). */
  path(): string;
  platform?: NodeJS.Platform;
  /** Where the probes' throwaway folders are made (os.tmpdir()). */
  tmpRoot?: string;
  /** The environment the system's own variables are taken from on Windows (process.env). */
  env?: NodeJS.ProcessEnv;
}

const PROBE_TIMEOUT_MS = 10_000;
/** A version: digits and dots, then a pre-release or build suffix (amp's -gce258b, kimi's rc2, goose's -beta.3+abc). */
const VERSION = /(?:^|[^0-9A-Za-z.])v?(\d+(?:\.\d+)+(?:[-+.]?[0-9A-Za-z]+(?:[.+-][0-9A-Za-z]+)*)?)/;

/** The version in a `--version` answer: the first line that holds one, the version alone. */
export function versionIn(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = VERSION.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * A probe's environment: every folder a CLI could write to inside `sandbox`, the terminals' PATH, and on Windows the
 * system's own variables (a process started without SystemRoot fails), nothing else of `from`.
 */
export function isolatedProbeEnv(sandbox: string, o: { path: string; platform: NodeJS.Platform; from: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const home = path.join(sandbox, 'home');
  const tmp = path.join(sandbox, 'tmp');
  const env: Record<string, string> = {
    PATH: o.path,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    CODEX_HOME: path.join(home, '.codex'),
    npm_config_prefix: path.join(sandbox, 'npm-prefix'),
    npm_config_cache: path.join(sandbox, 'npm-cache'),
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
  if (o.platform === 'win32') {
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) {
      const value = o.from[name] ?? o.from[name.toUpperCase()];
      if (value) env[name] = value;
    }
  }
  // No NODE_ENV, nor anything else of Tars's own environment: the renderer's types would ask for one.
  return env as NodeJS.ProcessEnv;
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The file a name starts: as given when it is a path, else the first on the PATH; null when there is none. */
function locate(binary: string, pathValue: string, platform: NodeJS.Platform): { run: string; file: string } | null {
  if (platform === 'win32') {
    const cli = resolveCliBinary(binary, { PATH: pathValue, Path: pathValue }, 'win32');
    if (!cli.ok) return null;
    // A node shim's script is the npm package's file; the shim itself is what is run.
    const file = cli.via === 'npm-shim-node' && cli.prefixArgs.length ? cli.prefixArgs[cli.prefixArgs.length - 1] : cli.file;
    return isExecutableFile(file, platform) ? { run: binary, file } : null;
  }
  if (binary.includes('/')) {
    if (!path.isAbsolute(binary)) return null;
    return isExecutableFile(binary, platform) ? { run: binary, file: binary } : null;
  }
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, binary);
    if (isExecutableFile(candidate, platform)) return { run: candidate, file: candidate };
  }
  return null;
}

/** The version of the npm package whose `bin` lists this file: the nearest package.json, and only that one. */
function packageVersionOf(real: string): string | null {
  let dir = path.dirname(real);
  for (let up = 0; up < 6; up++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown; bin?: unknown };
        const bins = typeof pkg.bin === 'string' ? [pkg.bin]
          : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin as Record<string, unknown>).filter((b): b is string => typeof b === 'string') : [];
        const listed = bins.some((b) => {
          try { return fs.realpathSync(path.resolve(dir, b)) === real; } catch { return false; }
        });
        return listed && typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || path.basename(dir) === 'node_modules') return null;
    dir = parent;
  }
  return null;
}

export function harnessVersions(deps: HarnessVersionDeps): { of(binary: string): Promise<string | null> } {
  const platform = deps.platform ?? process.platform;
  const known = new Map<string, Promise<string | null>>();

  async function probe(run: string): Promise<string | null> {
    const root = deps.tmpRoot ?? os.tmpdir();
    let sandbox: string | undefined;
    try {
      sandbox = fs.mkdtempSync(path.join(root, 'tars-version-probe-'));
      const env = isolatedProbeEnv(sandbox, { path: deps.path(), platform, from: deps.env ?? process.env });
      // Its working folder too: a CLI that reads or writes where it runs finds only this.
      const work = path.join(sandbox, 'work');
      for (const d of [env.HOME!, env.TMPDIR!, env.npm_config_prefix!, work]) fs.mkdirSync(d, { recursive: true });
      const out = await deps.probe(run, env, PROBE_TIMEOUT_MS, work);
      return versionIn(out.stdout) ?? versionIn(out.stderr);
    } catch (err) {
      console.error(`[traces] ${path.basename(run)} --version gave no version: ${(err as Error).message}`);
      return null;
    } finally {
      if (sandbox) {
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (err) {
          console.error(`[traces] the version probe's folder ${sandbox} was not removed: ${(err as Error).message}`);
        }
      }
    }
  }

  return {
    async of(binary: string): Promise<string | null> {
      let found: { run: string; file: string } | null;
      let key: string;
      let real: string;
      try {
        found = locate(binary.trim(), deps.path(), platform);
        if (!found) return null;
        real = fs.realpathSync(found.file);
        const st = fs.statSync(real);
        key = `${real}\0${st.mtimeMs}\0${st.size}`;
      } catch {
        return null;
      }
      const held = known.get(key);
      if (held) return held;
      const run = found.run;
      const reading = Promise.resolve().then(() => packageVersionOf(real) ?? probe(run)).then((version) => {
        // A probe that failed is asked again by the next session; a version is kept for this file as it is.
        if (version === null) {
          known.delete(key);
          return null;
        }
        // One the back-office would refuse is left out, never cut (and not asked again for this file).
        if (version.length > MAX_VERSION_CHARS) {
          console.error(`[traces] ${path.basename(run)}'s version is ${version.length} characters, over ${MAX_VERSION_CHARS}: not kept`);
          return null;
        }
        return version;
      });
      known.set(key, reading);
      return reading;
    },
  };
}
