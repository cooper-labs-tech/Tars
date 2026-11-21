import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What Tars hands every agent it runs, in every project.
 *
 * ~/.tars/CLAUDE.md is mounted into every agent through --add-dir, whatever
 * project it is working in. It used to be a copy of whatever CLAUDE.md sat
 * next to the application, which packaged is nothing, and run from a clone is
 * Tars's own development rules: draw the frame in design/tars-redesign.pen
 * before writing TSX, never touch electron/, open the pull request against
 * cooper-labs-tech/Tars, run npm run e2e:guard. Two hundred and fifty lines of one
 * project's rules, delivered to agents working on someone else's.
 *
 * So the assertions are about what actually lands in the destination file when
 * a CLAUDE.md is sitting exactly where the old code looked for it.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-instr-'));
const dataDir = path.join(home, '.tars');

/**
 * app.getAppPath() run from a clone IS the repository, which is Nexarion434's case
 * and the whole bug: the repository's own CLAUDE.md really is sitting exactly
 * where the old code looked. Pointed at the real one rather than a stand-in,
 * so the assertions are against the document that actually leaked.
 */
let appPath = process.cwd();
const REPO_CLAUDE_MD = path.join(process.cwd(), 'CLAUDE.md');

vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: dataDir, dataPath: (f: string) => path.join(dataDir, f) };
});

vi.mock('electron', () => ({
  app: { getPath: () => home, getAppPath: () => appPath },
  Notification: class { on() {} show() {} },
  shell: { openExternal: vi.fn() },
}));

let utils: typeof import('../../../electron/utils');

const dest = () => path.join(dataDir, 'CLAUDE.md');

beforeEach(async () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  appPath = process.cwd();
  vi.resetModules();
  utils = await import('../../../electron/utils');
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the instructions Tars publishes for its agents', () => {
  it('come from the bundled resource, which ships with the app', () => {
    const source = utils.getAgentInstructionsPath();

    expect(fs.existsSync(source), `missing: ${source}`).toBe(true);
    // Under electron/resources, which build.files ships and asarUnpack
    // unpacks. A file anywhere else would not reach a packaged install.
    expect(source).toContain(path.join('electron', 'resources'));
  });

  it('are written where every agent mounts them', () => {
    utils.ensureAgentInstructions();

    expect(fs.existsSync(dest())).toBe(true);
    const written = fs.readFileSync(dest(), 'utf-8');
    expect(written).toBe(fs.readFileSync(utils.getAgentInstructionsPath(), 'utf-8'));
    expect(written).toContain('Autonomy');
  });

  it('are not the repository rules, though its CLAUDE.md is sitting right there', () => {
    // The precondition of the bug, asserted rather than assumed: running from
    // a clone, the file the old code read really is where it looked.
    expect(fs.existsSync(REPO_CLAUDE_MD)).toBe(true);
    const repoRules = fs.readFileSync(REPO_CLAUDE_MD, 'utf-8');

    utils.ensureAgentInstructions();

    const written = fs.readFileSync(dest(), 'utf-8');
    expect(written).not.toBe(repoRules);

    // The repository's file quotes the generic instructions as well as its
    // own rules, so a shared line is not a leak. Everything else in it is:
    // check line by line that none of it arrived by any route.
    const shipped = new Set(
      fs.readFileSync(utils.getAgentInstructionsPath(), 'utf-8').split('\n').map(l => l.trim()),
    );
    const repoOnly = repoRules
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 30 && !shipped.has(l));

    expect(repoOnly.length, 'nothing repository-specific to check').toBeGreaterThan(50);
    for (const line of repoOnly) {
      expect(written, `leaked: ${line.slice(0, 70)}`).not.toContain(line);
    }
  });

  it('carry nothing that only makes sense inside the Tars repository', () => {
    utils.ensureAgentInstructions();
    const written = fs.readFileSync(dest(), 'utf-8');

    // Paths, commands and rules that exist in one repository and nowhere else.
    // An agent on someone's Figma project must not be told any of them.
    for (const marker of [
      'tars-redesign.pen',
      'electron/core/pty-manager.ts',
      'cooper-labs-tech/Tars',
      'lint:design',
      'e2e:guard',
      'mcp-orchestrator',
      'DOROTHY_API_PORT',
      'Frontend Agent',
      'Backend Agent',
    ]) {
      expect(written, `leaked: ${marker}`).not.toContain(marker);
    }
  });

  it('repair a file that already holds the wrong document', () => {
    // Nexarion434's machine: the leak is already on disk from an earlier launch.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dest(), fs.readFileSync(REPO_CLAUDE_MD, 'utf-8'));

    utils.ensureAgentInstructions();

    expect(fs.readFileSync(dest(), 'utf-8')).not.toContain('cooper-labs-tech/Tars');
  });

  it('tell the agent that its own project comes first', () => {
    utils.ensureAgentInstructions();

    // The document is about how to work, not about a codebase. Saying so is
    // what stops it being read as rules that override the real project's.
    expect(fs.readFileSync(dest(), 'utf-8')).toMatch(/take precedence/i);
  });

  it('do not stop the app starting when the resource is not there', async () => {
    // A broken install: the bundle has no resources directory at all. This
    // runs at startup, so it has to warn and carry on, never throw.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-empty-'));
    appPath = empty;
    vi.resetModules();
    const broken = await import('../../../electron/utils');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => broken.ensureAgentInstructions()).not.toThrow();

    // And it says so rather than writing something invented in its place.
    expect(warn).toHaveBeenCalled();
    expect(fs.existsSync(dest())).toBe(false);
    warn.mockRestore();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('a machine that already has the wrong document', () => {
  /** Nexarion434's install: the repository's rules are on disk from an earlier run. */
  function pollute(): string[] {
    fs.mkdirSync(dataDir, { recursive: true });
    const repoRules = fs.readFileSync(REPO_CLAUDE_MD, 'utf-8');
    fs.writeFileSync(dest(), repoRules);
    const markers = [
      'tars-redesign.pen',
      'electron/core/pty-manager.ts',
      'cooper-labs-tech/Tars',
      'lint:design',
      'e2e:guard',
      'DOROTHY_API_PORT',
      'Frontend Agent',
      'Backend Agent',
    ];
    // The precondition, asserted: this really is the polluted file.
    for (const m of markers) expect(repoRules, `not actually polluted: ${m}`).toContain(m);
    return markers;
  }

  it('is cleaned up by a launch that can read the resource', () => {
    const markers = pollute();

    utils.ensureAgentInstructions();

    const written = fs.readFileSync(dest(), 'utf-8');
    for (const m of markers) expect(written, `survived: ${m}`).not.toContain(m);
  });

  it('is cleaned up by a launch that cannot, because no rules beat another project\'s', async () => {
    const markers = pollute();

    // Same machine, broken bundle. Returning early here left the pollution in
    // place on exactly the installs this exists to repair.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-empty-'));
    appPath = empty;
    vi.resetModules();
    const broken = await import('../../../electron/utils');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => broken.ensureAgentInstructions()).not.toThrow();

    expect(fs.existsSync(dest()), 'the stale file survived').toBe(false);
    // Belt and braces: nothing of it anywhere, not even partially rewritten.
    if (fs.existsSync(dest())) {
      const left = fs.readFileSync(dest(), 'utf-8');
      for (const m of markers) expect(left, `survived: ${m}`).not.toContain(m);
    }
    warn.mockRestore();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('is left alone only when there was never anything to clean', async () => {
    // Nothing on disk and no resource: it must not invent a file, and must
    // not blow up trying to remove one that is not there.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-empty-'));
    appPath = empty;
    vi.resetModules();
    const broken = await import('../../../electron/utils');

    expect(() => broken.ensureAgentInstructions()).not.toThrow();

    expect(fs.existsSync(dest())).toBe(false);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
