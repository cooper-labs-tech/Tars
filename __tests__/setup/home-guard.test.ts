import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { homeOutsideRun } from './home-guard';
import { guardedFirst, homeWrites, hoistedHomeWrites } from './home-writers';

/**
 * No test file writes under os.homedir() unless HOME is the throwaway one the run made.
 *
 * The repo's setup files move HOME into the run's temporary folder (tmpdir-run.ts,
 * tmpdir-isolation.ts, home-isolation.ts). A file run without them writes into the owner's
 * real home:
 * - On 20/11 a test run with a vitest config of an agent's own deleted the owner's
 *   ~/.codex/config.toml.
 * - mcp-config-where-read.test.ts removes ~/.config, ~/.opencode and ~/.pi in a beforeEach.
 * - mcp-server-runtime.test.ts deletes ~/.tars/mcp-servers-runtime.json.
 * So every file that writes under the home imports `./setup/home-guard` first. It throws, before
 * anything else of the file runs, unless HOME lies inside the run's temporary folder. The sweep
 * at the end finds such files by reading them.
 *
 * How the guard can fail, written on 2026-11-20 before the code:
 * G1. It lets a HOME pass that the setup files never moved: the owner's own, with no run folder
 *     recorded at all (no setup ran).
 * G2. It lets a throwaway HOME outside the run's folder pass (HOME=/tmp/x with no setup).
 * G3. It lets a HOME pass that only reads as inside: the run folder itself, a sibling whose name
 *     starts like it (tars-vitest-run-ab, tars-vitest-run-abc), a `..` that climbs out, a
 *     link inside the run folder that leads out, or a `..` after such a link (added from #609's
 *     Audit, L1: the kernel resolves the link first).
 * G4. It refuses the HOME the repo's setup makes, which breaks npm test. On macOS it must also
 *     take the run folder named through /var or through /private/var.
 * G5. It refuses a folder that is not a run folder of the repo's (a TMPDIR of the agent's own),
 *     or its message does not say how to run the file instead.
 * G6. It runs after the file's other imports, or after a vi.hoisted block, which run first.
 * G7. It reads a home a test file mocks (vi.mock('os') with a homedir set after the imports), and
 *     the file stops before it starts. Found by QA's suite run of 20/11 04:15, in two files.
 *     Tested in home-guard-mocked-os.test.ts, which has the same shape.
 *
 * How the sweep can fail:
 * D1. It misses a write whose path names the home: rmSync(path.join(os.homedir(), dir)).
 * D2. It misses a write through a name made from the home, one or two hops away:
 *     `const home = () => os.homedir()` then rmSync(path.join(home(), '.tars'));
 *     `const file = () => path.join(os.homedir(), ...)` then writeFileSync(file(), ...).
 * D3. It misses process.env.HOME, process.env['HOME'], a bare homedir() import, or a template
 *     string `${process.env.HOME}/.tars-private`.
 * D4. It counts as guarded a file that imports the guard after another import, or names it only
 *     in a comment.
 * D5. It raises a false alarm on the home's name inside a string or a comment
 *     ('tars-home-roots-'), on a write under os.tmpdir(), or on a read under the home.
 * D6. It reads no file (a wrong folder or pattern) and passes vacuously, or it misses the two files
 *     known to write under the home (mcp-config-where-read, mcp-server-runtime).
 * D7. It accepts a write under the home inside vi.hoisted, which runs before every import, so
 *     before the guard.
 */

const run = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vitest-run-')));

describe('the home guard', () => {
  it('G1, G2. refuses a home the setup did not move: none recorded, or outside the run folder', () => {
    const r = run();
    expect(homeOutsideRun(os.userInfo().homedir, undefined)).toMatch(/no run folder/);
    expect(homeOutsideRun(fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-')), r)).toMatch(/not inside the run's temporary folder/);
  });

  it('G3. refuses the run folder itself, a sibling named like it, a `..` out of it and a link out of it', () => {
    const r = run();
    const sibling = `${r}x`;
    fs.mkdirSync(sibling);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    fs.symlinkSync(out, path.join(r, 'linked-home'));
    // #609's Audit, L1: a `..` after a link lands where the link leads, then one up. Written out:
    // path.join would drop `link/..` as text.
    // One folder down, so that as text it stays inside (`<run>/home`), while the kernel lands in `out`.
    fs.mkdirSync(path.join(out, 'sub'));
    fs.mkdirSync(path.join(r, 'home'));
    fs.symlinkSync(path.join(out, 'sub'), path.join(r, 'home', 'up-link'));
    expect(homeOutsideRun([r, 'home', 'up-link', '..'].join(path.sep), r)).not.toBeNull();
    expect(homeOutsideRun(r, r)).not.toBeNull();
    expect(homeOutsideRun(path.join(sibling, 'home'), r)).not.toBeNull();
    expect(homeOutsideRun([r, 'home', '..', '..', 'home'].join(path.sep), r)).not.toBeNull();
    expect(homeOutsideRun(path.join(r, 'linked-home'), r)).not.toBeNull();
  });

  it('G4. takes the home the setup makes, this run\'s own, and a run folder named through /var or /private/var', () => {
    const r = run();
    const home = fs.mkdtempSync(path.join(r, 'tars-vitest-file-'));
    expect(homeOutsideRun(path.join(home, 'tars-vitest-home-x'), r)).toBeNull();
    expect(homeOutsideRun(os.homedir(), (globalThis as Record<symbol, string | undefined>)[Symbol.for('tars.test.runTmpdir')])).toBeNull();
    if (process.platform === 'darwin' && r.startsWith('/private/')) {
      expect(homeOutsideRun(path.join(r.slice('/private'.length), 'h'), r)).toBeNull();
      expect(homeOutsideRun(path.join(r, 'h'), r.slice('/private'.length))).toBeNull();
    }
  });

  it('G5. refuses a folder that is not a run folder of the repo\'s, and says how to run the file', () => {
    const notARun = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tmp-')));
    const why = homeOutsideRun(path.join(notARun, 'home'), notARun);
    expect(why).toMatch(/tars-vitest-run-/);
    expect(why).toMatch(/npm test|vitest -c vitest\.config\.mts/);
  });
});

describe('the sweep\'s reading of a test file', () => {
  it('D1. flags a write whose path names the home', () => {
    expect(homeWrites("fs.rmSync(path.join(os.homedir(), dir), { recursive: true });")).toHaveLength(1);
  });

  it('D2. flags a write through a name made from the home, one or two hops away', () => {
    expect(homeWrites("const home = () => os.homedir();\nfs.rmSync(path.join(home(), '.tars', 'x.json'), { force: true });")).toHaveLength(1);
    expect(homeWrites("const file = () => path.join(os.homedir(), '.config', 'o.json');\nfs.writeFileSync(file(), '{}');")).toHaveLength(1);
    expect(homeWrites("const root = os.homedir();\nconst dir = path.join(root, '.pi');\nconst f = path.join(dir, 'mcp.json');\nfs.unlinkSync(f);")).toHaveLength(1);
    // Helpers defined before what they use, as arrow functions often are: only a reading to a fixed point finds them.
    expect(homeWrites("const f = () => path.join(dir(), 'mcp.json');\nconst dir = () => path.join(root(), '.pi');\nconst root = () => os.homedir();\nfs.unlinkSync(f());")).toHaveLength(1);
  });

  it('D3. flags process.env.HOME, process.env[\'HOME\'], a bare homedir() and a template string', () => {
    expect(homeWrites("fs.mkdirSync(path.join(process.env.HOME!, 'x'));")).toHaveLength(1);
    expect(homeWrites("fs.mkdirSync(path.join(process.env['HOME']!, 'x'));")).toHaveLength(1);
    expect(homeWrites("import { homedir } from 'node:os';\nfs.rmSync(path.join(homedir(), '.codex'));")).toHaveLength(1);
    expect(homeWrites('fs.writeFileSync(`${process.env.HOME}/.tars-private/bridge-token`, "t");')).toHaveLength(1);
  });

  it('D4. counts a file as guarded only when the guard is its first import', () => {
    expect(guardedFirst("/** header */\nimport '../setup/home-guard';\nimport * as fs from 'node:fs';")).toBe(true);
    expect(guardedFirst("// @vitest-environment node\nimport './setup/home-guard';\nimport { it } from 'vitest';")).toBe(true);
    expect(guardedFirst("import * as fs from 'node:fs';\nimport '../setup/home-guard';")).toBe(false);
    expect(guardedFirst("// import '../setup/home-guard';\nimport * as fs from 'node:fs';")).toBe(false);
    expect(guardedFirst("import * as fs from 'node:fs';")).toBe(false);
  });

  it('D5. raises no alarm on the home\'s name in a string or a comment, a write under tmpdir, or a read under the home', () => {
    expect(homeWrites("const home = os.homedir();\nfs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-roots-'));")).toEqual([]);
    expect(homeWrites("// fs.rmSync(path.join(os.homedir(), '.config'))\nfs.rmSync(path.join(os.tmpdir(), 'x'));")).toEqual([]);
    expect(homeWrites("const s = 'fs.rmSync(os.homedir())';\nfs.readFileSync(path.join(os.homedir(), '.tars', 'a.json'));")).toEqual([]);
  });

  it('D7. flags a write under the home inside vi.hoisted', () => {
    expect(hoistedHomeWrites("const x = vi.hoisted(() => { fs.mkdirSync(path.join(os.homedir(), '.tars')); return 1; });\nimport '../setup/home-guard';")).toHaveLength(1);
    expect(hoistedHomeWrites("const x = vi.hoisted(() => ({ fail: false }));\nfs.mkdirSync(path.join(os.homedir(), '.tars'));")).toEqual([]);
  });
});

describe('every test file that writes under the home', () => {
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const files = walk(root);
  const writers = files.map(file => ({ file: path.relative(root, file), source: fs.readFileSync(file, 'utf8') }))
    .map(f => ({ ...f, writes: homeWrites(f.source) }))
    .filter(f => f.writes.length > 0);

  it('D6. are read: hundreds of files, the two known ones among the writers', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(writers.map(w => w.file)).toEqual(expect.arrayContaining([
      path.join('electron', 'providers', 'mcp-config-where-read.test.ts'),
      path.join('electron', 'mcp-server-runtime.test.ts'),
    ]));
  });

  it('G6, D4. import the guard before anything else', () => {
    const unguarded = writers.filter(w => !guardedFirst(w.source)).map(w => `${w.file}: ${w.writes[0]}`);
    expect(unguarded, `these write under the home with no guard first: import '<relative>/setup/home-guard' as their first import`).toEqual([]);
  });

  it('D7. write nothing under the home inside vi.hoisted', () => {
    const hoisted = files.flatMap(file => hoistedHomeWrites(fs.readFileSync(file, 'utf8')).map(w => `${path.relative(root, file)}: ${w}`));
    expect(hoisted).toEqual([]);
  });
});
