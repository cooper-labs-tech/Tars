import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decide } from '../../scripts/scope-checks.mjs';

/**
 * Which checks a change actually needs.
 *
 * The end to end suite is three minutes of the roughly four a review round
 * costs, and it was run after every change including ones that could not have
 * moved a pixel. The saving is only worth having if the decision is safe, and
 * safe here has a direction: a file nobody has classified must run the suite,
 * never skip it. A skip that is wrong hides a visual regression, which costs
 * incomparably more than the three minutes it saved.
 *
 * So the assertions below are mostly about what still runs.
 *
 * The CLI matrix (e2e/cli-matrix.spec.ts) is a Playwright project of its own since 19/10, out of the default suite:
 * 27 minutes for its two shells, which nearly doubled `npm run e2e`. It runs at every release gate, and here when a
 * diff touches what a delegation between two CLIs goes through. The ways that decision can fail, written before it:
 * 1. a diff to a provider, an MCP server, the hooks, the state mod or the delivery and ledger code skips the matrix,
 *    and a CLI pair breaks unseen until the release gate;
 * 2. a diff to MCP servers or hooks alone, which skips the surfaces, skips the matrix with them;
 * 3. a diff to the matrix itself, its stand-ins or the suite's configuration skips it;
 * 4. no diff to reason about rules the matrix out, where it rules nothing out for the surfaces;
 * 5. a diff that touches none of it (a page, a document, a unit test, another spec, a design file) runs it for
 *    nothing;
 * 6. it runs the matrix without saying which file called for it;
 * 7. a diff to a file on a delegation's way that no list names (the task routes, the queue of a second task, the
 *    PTY, the agent's identity, the hooks' installer) skips it. A list of what reaches a delegation is never whole:
 *    the first one missed eleven such files (the Audit's M1 on #464). So the rule names what cannot reach one, as
 *    the surfaces' rule does, and a path it has never heard of runs the matrix.
 */

const runs = (files: string[]) => decide(files).runE2E;
const matrix = (files: string[]) => decide(files).runMatrix;

describe('changes that cannot reach a rendered surface', () => {
  it.each([
    ['a round of unit tests', ['__tests__/electron/services/agent-watch.test.ts']],
    ['an MCP server bundle', ['mcp-orchestrator/src/tools/agents.ts']],
    ['several MCP servers at once', ['mcp-vault/src/index.ts', 'mcp-x/src/tools/post.ts']],
    ['the shell hooks', ['hooks/session-start.sh', 'hooks/on-stop.sh']],
    ['build tooling', ['scripts/sandbox.sh', 'scripts/scope-checks.mjs']],
    ['documentation', ['README.md', 'SPECS.md', 'CLAUDE.md']],
    ['agent prompt text', ['electron/resources/super-agent-instructions.md']],
    ['CI configuration', ['.github/workflows/ci.yml']],
    ['the landing site', ['landing/src/app/page.tsx']],
    ['a Hermes plugin, installed on the Hermes server', ['hermes-plugins/tars-relay/relay_core.py', 'hermes-plugins/tars-relay/dashboard/plugin_api.py']],
  ])('skips the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(false);
  });

  it('names every file it skipped, and why', () => {
    const decision = decide(['__tests__/a.test.ts', 'hooks/on-stop.sh']);

    expect(decision.skipped.map(s => s.file)).toEqual(['__tests__/a.test.ts', 'hooks/on-stop.sh']);
    for (const entry of decision.skipped) expect(entry.why.length).toBeGreaterThan(0);
  });
});

describe('changes that can', () => {
  it.each([
    ['a renderer component', ['src/components/Overseer/MessageCard.tsx']],
    ['a shared ui primitive', ['src/components/ui/index.ts']],
    ['the token system', ['src/app/globals.css']],
    ['a hook the pages read', ['src/hooks/useAgents.ts']],
    ['data that is rendered', ['src/data/changelog.ts']],
    ['a Pencil frame', ['design/tars-redesign.pen']],
    ['a public asset', ['public/icon.svg']],
    ['the window itself', ['electron/core/window-manager.ts']],
    ['the renderer contract', ['electron/preload.ts']],
    ['a service behind a page', ['electron/services/overseer.ts']],
    ['an IPC handler', ['electron/handlers/ipc-handlers.ts']],
    ['the build configuration', ['next.config.ts']],
    ['the dependency set', ['package.json']],
    ['the suite itself', ['e2e/surfaces.mjs']],
    ['the suite configuration', ['playwright.config.ts']],
  ])('runs the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(true);
  });

  /**
   * electron/ is the one people assume is safe, and it is not: the suite boots
   * the real app against a seeded home, so what a page shows arrives through
   * real main process code.
   */
  it('runs the suite for electron, which is not the renderer but reaches it', () => {
    expect(runs(['electron/services/usage-ledger.ts'])).toBe(true);
    expect(runs(['electron/core/agent-manager.ts'])).toBe(true);
  });
});

describe('anything it has never heard of', () => {
  it.each([
    ['a brand new top level directory', ['packages/design-system/Button.tsx']],
    ['a config nobody classified', ['vite.config.ts']],
    ['a file with no directory at all', ['weird-thing.ts']],
    ['an unexpected extension', ['src/theme.scss']],
  ])('runs the suite for %s', (_name, files) => {
    expect(runs(files as string[])).toBe(true);
  });

  it('runs the suite when there is no diff to reason about', () => {
    // No files means the comparison failed, not that nothing changed.
    expect(runs([])).toBe(true);
    expect(decide([]).reason).toMatch(/nothing can be ruled out/);
  });
});

describe('a mixed change', () => {
  it('runs the suite when a single file in it can reach the renderer', () => {
    const files = [
      '__tests__/a.test.ts',
      'hooks/on-stop.sh',
      'scripts/sandbox.sh',
      'README.md',
      'src/app/page.tsx',
    ];

    const decision = decide(files);

    expect(decision.runE2E).toBe(true);
    // And it says which one forced it, so the decision can be argued with.
    expect(decision.forcing.map(f => f.file)).toEqual(['src/app/page.tsx']);
  });

  it('does not let a safe majority outvote one risky file', () => {
    const safe = Array.from({ length: 40 }, (_, i) => `__tests__/t${i}.test.ts`);

    expect(runs([...safe, 'electron/preload.ts'])).toBe(true);
  });
});

describe('a file moved out of the renderer', () => {
  /**
   * Git reports a rename as the new path alone, so a component moved from
   * src/ into scripts/ arrived here looking like a change to tooling and the
   * suite was skipped, while src/ had just lost a file and every page that
   * imported it. The collector asks git not to detect renames, so both halves
   * arrive, and the half that matters is the one that left.
   */
  it.each([
    ['into build tooling', ['src/components/Card.tsx', 'scripts/Card.tsx']],
    ['into the tests', ['src/hooks/useAgents.ts', '__tests__/useAgents.ts']],
    ['into the landing site', ['src/components/Hero.tsx', 'landing/src/Hero.tsx']],
    ['into an MCP bundle', ['src/lib/format.ts', 'mcp-vault/src/format.ts']],
    ['into the shell hooks', ['src/lib/notify.ts', 'hooks/notify.ts']],
  ])('runs the suite when a renderer file is moved %s', (_name, files) => {
    expect(runs(files as string[])).toBe(true);
  });

  it('names the departure as the reason, not the arrival', () => {
    const decision = decide(['src/components/Card.tsx', 'scripts/Card.tsx']);

    expect(decision.forcing.map(f => f.file)).toEqual(['src/components/Card.tsx']);
    expect(decision.skipped.map(f => f.file)).toEqual(['scripts/Card.tsx']);
  });

  it('still skips a move that never involved the renderer', () => {
    // hooks/ to scripts/ is two exempt places: nothing was lost by src/.
    expect(runs(['hooks/notify.sh', 'scripts/notify.sh'])).toBe(false);
  });
});

describe('root dotfiles', () => {
  it.each([
    ['.gitignore'], ['.gitattributes'], ['.editorconfig'],
    ['.nvmrc'], ['.eslintignore'], ['.prettierignore'],
  ])('skips the suite for %s, which builds nothing', (file) => {
    expect(runs([file])).toBe(false);
  });

  /**
   * The rule used to exempt any root dotfile, which is a guess about a
   * category rather than a fact about a file. These are build inputs: each
   * would change every screenshot while looking like configuration.
   */
  it.each([
    ['.postcssrc'], ['.postcssrc.json'], ['.browserslistrc'],
    ['.babelrc'], ['.swcrc'], ['.env.production'],
  ])('runs the suite for %s, which is a build input', (file) => {
    expect(runs([file])).toBe(true);
  });
});

describe('the classification itself', () => {
  it('treats a path prefix as a prefix, not a substring', () => {
    // A directory that merely starts with the same letters is not the same
    // directory, and must not inherit its exemption.
    expect(runs(['src/hooks/useAgents.ts'])).toBe(true);
    expect(runs(['src/scripts/loader.ts'])).toBe(true);
    expect(runs(['electron/resources/local-agent-runner.js'])).toBe(true);
  });

  it('exempts documentation only at the repository root', () => {
    expect(runs(['README.md'])).toBe(false);
    // A markdown file inside the renderer is content the app can display.
    expect(runs(['src/content/guide.md'])).toBe(true);
  });
});

describe('the screenshot references', () => {
  /**
   * The roadmap had it that the skip was decided "without knowing anything
   * about e2e/__screenshots__". Measured on 17/09 against origin/main
   * (2f734fb), it is not so: every change to a reference runs the suite,
   * because ALWAYS_RUNS has held `e2e/` since this file was written. These keep
   * it that way. A reference that changed is the suite's own expectation, and
   * only a run says whether the app still meets it.
   */
  it.each([
    ['a re-recorded reference', ['e2e/__screenshots__/agents.png']],
    ['a reference beside changes that cannot reach the renderer', ['__tests__/a.test.ts', 'hooks/on-stop.sh', 'e2e/__screenshots__/dashboard.png']],
    ['a new folder of references', ['e2e/__screenshots__/rooms/']],
  ])('runs the suite for %s', (_name, files) => {
    const decision = decide(files as string[]);
    const reference = (files as string[]).find(file => file.startsWith('e2e/__screenshots__/'));

    expect(decision.runE2E).toBe(true);
    expect(decision.forcing).toContainEqual({ file: reference, why: 'the suite itself' });
  });
});

/**
 * The command itself, as `npm run e2e:auto` runs it, in real git checkouts of a
 * local origin. A fake npx comes first on the PATH: it writes down that the
 * suite was started, and starts nothing. The tests run side by side, since each
 * spends its time waiting on git.
 */
const SCRIPT = path.join(__dirname, '../../scripts/scope-checks.mjs');
/** What a run that rules nothing out starts: the default suite, then the CLI matrix with its variable. */
const EVERYTHING = 'playwright test\nplaywright test --project=matrix E2E_MATRIX=1';
const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, env: gitEnv })).stdout.trim();

/** The eight bytes every PNG starts with, and a header chunk: binary, with NULs, as a reference is. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PNG_RERECORDED = Buffer.concat([PNG, Buffer.from([0, 0, 0x05, 0xa0])]);

function write(dir: string, file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

async function commitAll(dir: string, message: string) {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', message);
}

const made: string[] = [];

/** `npm run e2e:auto` in `cwd`. `suite` is how npx was called, or null if the suite was never started. */
async function e2eAuto(cwd: string, env: Record<string, string> = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-scope-npx-'));
  made.push(bin);
  const calls = path.join(bin, 'calls');
  // With E2E_MATRIX when it is set: without it the matrix's project does not exist (playwright.config.ts).
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "$*\${E2E_MATRIX:+ E2E_MATRIX=$E2E_MATRIX}" >> "${calls}"\n`, { mode: 0o755 });
  // On Windows the script runs npx as node <npm's bin>\npx-cli.js (scripts/npm-command.mjs), found
  // through npm_execpath: the same fake, in JavaScript. macOS and Linux still take `npx` off the PATH.
  fs.writeFileSync(path.join(bin, 'npx-cli.js'), `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + (process.env.E2E_MATRIX ? ' E2E_MATRIX=' + process.env.E2E_MATRIX : '') + '\\n');\n`);
  const childEnv: NodeJS.ProcessEnv = { ...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
  delete childEnv.SCOPE_BASE;
  // Every spelling: a worker can hold NPM_EXECPATH, and Windows would hand the child that one, the real npm.
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'npm_execpath') delete childEnv[key];
  childEnv.npm_execpath = path.join(bin, 'npm-cli.js');
  const { stdout, stderr } = await run(process.execPath, [SCRIPT], { cwd, env: { ...childEnv, ...env } });
  return {
    output: `${stdout}${stderr}`,
    suite: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim() : null,
  };
}

/**
 * An origin whose main moved on after `clone` was made: the clone's main and
 * origin/main both still point at `stale`, while origin's main is at `fresh`,
 * one renderer change later, pushed by a teammate. The clone also has a branch
 * `fresh` at that commit, got from the teammate and not from origin, which is
 * what `gh pr checkout` or a pull from anywhere but origin leaves behind: a
 * branch holding the newer main while main and origin/main do not.
 *
 * Built once and never written again: each test works in a copy of the clone.
 */
let upstream: { teammate: string; clone: string; stale: string; fresh: string };

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-scope-origin-'));
  made.push(root);
  const origin = path.join(root, 'origin.git');
  await git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const teammate = path.join(root, 'teammate');
  await git(root, 'init', '-q', '-b', 'main', teammate);
  write(teammate, 'src/components/Card.tsx', 'export const width = 1;\n');
  write(teammate, '__tests__/card.test.ts', '// the first test\n');
  write(teammate, 'e2e/__screenshots__/agents.png', PNG);
  await commitAll(teammate, 'the main the clone was made from');
  await git(teammate, 'remote', 'add', 'origin', origin);
  await git(teammate, 'push', '-q', '-u', 'origin', 'main');
  const clone = path.join(root, 'clone');
  await git(root, 'clone', '-q', origin, clone);
  write(teammate, 'src/components/Card.tsx', 'export const width = 2;\n');
  await commitAll(teammate, 'a renderer change merged since');
  await git(teammate, 'push', '-q', 'origin', 'main');
  await git(clone, 'fetch', '-q', teammate, '+refs/heads/main:refs/heads/fresh');
  upstream = { teammate, clone, stale: await git(clone, 'rev-parse', 'HEAD'), fresh: await git(teammate, 'rev-parse', 'HEAD') };
  expect(await git(clone, 'rev-parse', 'main', 'origin/main', 'fresh')).toBe(`${upstream.stale}\n${upstream.stale}\n${upstream.fresh}`);
});

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the clone, on a new branch `feature` cut from `from`, for one test to change as it likes. */
async function cloneBehindOrigin(from: 'main' | 'fresh') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-scope-'));
  made.push(root);
  const dir = path.join(root, 'clone');
  fs.cpSync(upstream.clone, dir, { recursive: true });
  await git(dir, 'checkout', '-q', '-b', 'feature', from);
  return { ...upstream, root, dir };
}

// 30 s, not vitest's 5: these cases run git and scope-checks.mjs for real, several at
// once, and under a gate's load (01/10, load average 140) two were cut off at 5 s while
// three others passed between 4.9 and 5.0 s (27 full-suite reports of 28/09 to 01/10).
// Quiet, the slowest is 2.2 s.
describe.concurrent('the base a branch is compared against', { timeout: 30_000 }, () => {
  it('fetches origin/main before comparing, and names the commit it compared against', async ({ expect }) => {
    const repo = await cloneBehindOrigin('fresh');
    write(repo.dir, '__tests__/feature.test.ts', '// a test, and nothing else\n');
    await commitAll(repo.dir, 'a test');

    const run = await e2eAuto(repo.dir);

    // Against the stale main, the renderer change merged since counted as this
    // branch's own: two files, and the suite ran for a change to a test.
    expect(run.output).toContain(`Base: ${repo.fresh.slice(0, 12)} (origin/main, fetched just now)`);
    expect(run.output).toContain(`1 changed file(s) against ${repo.fresh.slice(0, 12)}`);
    expect(run.suite).toBeNull();
    expect(await git(repo.dir, 'rev-parse', 'origin/main')).toBe(repo.fresh);
  });

  it('runs the suite for a branch that undoes a renderer change its stale base never had', async ({ expect }) => {
    const repo = await cloneBehindOrigin('fresh');
    write(repo.dir, 'src/components/Card.tsx', 'export const width = 1;\n');
    write(repo.dir, '__tests__/feature.test.ts', '// and a test\n');
    await commitAll(repo.dir, 'put the old width back');

    const run = await e2eAuto(repo.dir);

    // Against the stale main, Card.tsx is what it was, the test is all that is
    // left, and the suite was skipped over a change to the renderer.
    expect(run.output).toContain('src/components/Card.tsx: can reach the renderer');
    expect(run.suite).toBe('playwright test');
  });

  it('runs the whole suite, and says why, when origin cannot be fetched', async ({ expect }) => {
    const repo = await cloneBehindOrigin('main');
    write(repo.dir, '__tests__/feature.test.ts', '// a test, and nothing else\n');
    await commitAll(repo.dir, 'a test');
    await git(repo.dir, 'remote', 'set-url', 'origin', path.join(repo.root, 'gone.git'));

    const run = await e2eAuto(repo.dir);

    // Against the main this clone holds, only a test changed, and the suite was
    // skipped on a base nobody could say was current.
    expect(run.output).toContain('could not fetch origin/main');
    expect(run.output).toContain('Nothing can be ruled out: running the whole end to end suite, then the CLI matrix.');
    expect(run.suite).toBe(EVERYTHING);
  });

  it('takes SCOPE_BASE as it is, without fetching', async ({ expect }) => {
    const repo = await cloneBehindOrigin('main');
    write(repo.dir, '__tests__/feature.test.ts', '// a test, and nothing else\n');
    await commitAll(repo.dir, 'a test');
    await git(repo.dir, 'remote', 'set-url', 'origin', path.join(repo.root, 'gone.git'));

    const run = await e2eAuto(repo.dir, { SCOPE_BASE: 'main' });

    expect(run.output).toContain(`Base: ${repo.stale.slice(0, 12)} (SCOPE_BASE=main, not fetched)`);
    expect(run.output).not.toContain('could not fetch');
    expect(run.suite).toBeNull();
  });

  it('runs the whole suite when SCOPE_BASE names no commit', async ({ expect }) => {
    const repo = await cloneBehindOrigin('main');
    write(repo.dir, 'src/components/Card.tsx', 'export const width = 3;\n');
    await commitAll(repo.dir, 'a renderer change');
    write(repo.dir, '__tests__/feature.test.ts', '// a test, not committed yet\n');

    const run = await e2eAuto(repo.dir, { SCOPE_BASE: 'mian' });

    // A base git could not find read as "nothing committed": the uncommitted
    // test was all that got classified, and the renderer change was skipped.
    expect(run.output).toContain('SCOPE_BASE=mian is not a commit git can find');
    expect(run.suite).toBe(EVERYTHING);
  });

  it('runs the whole suite when git cannot compare the branch with its base', async ({ expect }) => {
    const repo = await cloneBehindOrigin('main');
    // An origin that is another project: its main shares no commit with this branch.
    const other = path.join(repo.root, 'other');
    await git(repo.root, 'init', '-q', '-b', 'main', other);
    write(other, 'README.md', 'another project\n');
    await commitAll(other, 'unrelated');
    await git(repo.dir, 'remote', 'set-url', 'origin', other);
    write(repo.dir, '__tests__/feature.test.ts', '// a test, not committed yet\n');

    const run = await e2eAuto(repo.dir);

    expect(run.output).toContain('could not list the changes');
    expect(run.suite).toBe(EVERYTHING);
  });

  it('runs the CLI matrix alone for a change to an MCP server, which skips the surfaces', async ({ expect }) => {
    const repo = await cloneBehindOrigin('fresh');
    write(repo.dir, 'mcp-orchestrator/src/tools/agents.ts', 'export const delegated = 1;\n');
    await commitAll(repo.dir, 'an MCP server change');

    const run = await e2eAuto(repo.dir);

    expect(run.output).toContain('SKIPPING the end to end suite.');
    expect(run.output).toContain('Running the CLI matrix: 1 changed file(s) can reach a delegation.');
    expect(run.output).toContain('mcp-orchestrator/src/tools/agents.ts: can reach a delegation, or is unclassified');
    expect(run.suite).toBe('playwright test --project=matrix E2E_MATRIX=1');
  });

  it('leaves the CLI matrix out, and says why, for a renderer change', async ({ expect }) => {
    const repo = await cloneBehindOrigin('fresh');
    write(repo.dir, 'src/components/Card.tsx', 'export const width = 4;\n');
    await commitAll(repo.dir, 'a renderer change');

    const run = await e2eAuto(repo.dir);

    expect(run.output).toContain('Leaving the CLI matrix out: all 1 changed file(s) cannot reach a delegation.');
    expect(run.output).toMatch(/src\/components\/Card\.tsx: the renderer/);
    expect(run.suite).toBe('playwright test');
  });
});

describe.concurrent('a reference change, as git reports it', { timeout: 30_000 }, () => {
  it.for([
    ['re-recorded and committed', async (dir: string) => {
      write(dir, 'e2e/__screenshots__/agents.png', PNG_RERECORDED);
      await commitAll(dir, 're-record');
    }],
    ['deleted and committed', async (dir: string) => {
      await git(dir, 'rm', '-q', 'e2e/__screenshots__/agents.png');
      await git(dir, 'commit', '-q', '-m', 'drop');
    }],
    ['re-recorded and not committed', async (dir: string) => {
      write(dir, 'e2e/__screenshots__/agents.png', PNG_RERECORDED);
    }],
    ['recorded for a new surface, untracked', async (dir: string) => {
      write(dir, 'e2e/__screenshots__/rooms/new-room.png', PNG);
    }],
    ['moved out of e2e/ and staged', async (dir: string) => {
      fs.mkdirSync(path.join(dir, '__tests__', 'fixtures'), { recursive: true });
      await git(dir, 'mv', 'e2e/__screenshots__/agents.png', '__tests__/fixtures/agents.png');
    }],
  ] as const)('runs the suite for a reference %s', async ([, change], { expect }) => {
    const repo = await cloneBehindOrigin('fresh');
    await change(repo.dir);

    const run = await e2eAuto(repo.dir);

    expect(run.output).toContain(`Base: ${repo.fresh.slice(0, 12)}`);
    expect(run.output).toMatch(/e2e\/__screenshots__\/\S+: the suite itself/);
    expect(run.suite).toBe('playwright test');
  });
});

describe('the CLI matrix, a project of its own', () => {
  it.each([
    ['a provider', ['electron/providers/codex-provider.ts']],
    ['an MCP server', ['mcp-orchestrator/src/tools/agents.ts']],
    ["the MCP servers' shared client", ['mcp-shared/src/tars-api.ts']],
    ['a shell hook', ['hooks/on-stop.sh']],
    ['the state mod', ['mods/tars-state/hooks.mjs']],
    ['the delegation routes', ['electron/services/api-routes/agent-routes.ts']],
    ['the hooks routes', ['electron/services/api-routes/hooks-routes.ts']],
    ['the bus routes', ['electron/services/api-routes/bus-routes.ts']],
    ['the bus', ['electron/services/bus-delivery.ts']],
    ["the bus's IPC", ['electron/handlers/bus-handlers.ts']],
    ['the task requests', ['electron/core/task-requests.ts']],
    ['typing into a terminal', ['electron/core/pty-manager.ts']],
    ["an agent's token", ['electron/core/agent-tokens.ts']],
    ['the MCP configuration each CLI gets', ['electron/services/mcp-orchestrator.ts']],
    ["a terminal's answer", ['electron/services/terminal-answer.ts']],
    ['the task ledger', ['electron/services/task-ledger.ts']],
    ['the usage ledger', ['electron/services/usage-ledger.ts']],
    ['the task banner', ['electron/services/task-banner.ts']],
    ['the state mod service', ['electron/services/state-mod.ts']],
    ['the delegation over ACP', ['electron/services/acp/delegate.ts']],
    ['the matrix itself', ['e2e/cli-matrix.spec.ts']],
    ['its live twin', ['e2e/cli-matrix.live.spec.ts']],
    ['its stand-ins', ['e2e/fake-clis.mjs', 'e2e/fake-codex.mjs']],
    ['the suite configuration', ['playwright.config.ts']],
  ])('1, 3. runs the matrix for %s', (_name, files) => {
    expect(matrix(files as string[])).toBe(true);
  });

  it.each([
    ['a page', ['src/app/usage/page.tsx']],
    ['a public asset', ['public/icon.svg']],
    ['documentation', ['README.md', 'OPERATIONS.md']],
    ['agent prompt text, which the stand-ins never read', ['electron/resources/agent-instructions.md']],
    ["the tray's pictures", ['electron/resources/trayTemplate@2x.png', 'electron/resources/tray.ico']],
    ['unit tests', ['__tests__/electron/providers/codex-provider.test.ts']],
    ['another spec', ['e2e/usage-pages.spec.ts']],
    ["the surfaces' reference pictures", ['e2e/__screenshots__/agents.png']],
    ['a design file', ['design/tars-redesign.pen']],
    ["the README's pictures", ['screenshots/dashboard.png']],
    ['build tooling', ['scripts/sandbox.sh', 'scripts/scope-checks.mjs']],
    ['CI configuration', ['.github/workflows/ci.yml']],
    ['the landing site', ['landing/src/app/page.tsx']],
    ['a Hermes plugin', ['hermes-plugins/tars-relay/relay_core.py']],
  ])('5. leaves the matrix out for %s', (_name, files) => {
    expect(matrix(files as string[])).toBe(false);
  });

  it.each([
    ['the task routes, which delegate_task waits on', ['electron/services/api-routes/task-routes.ts']],
    ['the queue that holds a second task', ['electron/core/one-task.ts']],
    ['the watch of turns and interruptions', ['electron/services/task-watch.ts']],
    ["an agent's terminal", ['electron/core/agent-pty.ts']],
    ['the agent manager', ['electron/core/agent-manager.ts']],
    ["the API server, which names the caller", ['electron/services/api-server.ts']],
    ["the hooks' installer", ['electron/services/hooks-manager.ts']],
    ['the field model behind every typed task', ['electron/core/input-draft.ts']],
    ['the agent guide', ['electron/services/agent-guide.ts']],
    ["codex's turns", ['electron/services/codex-sessions.ts']],
    ["qwen code's settings and hooks", ['electron/services/qwen-code.ts']],
    ['the window, which the matrix types through', ['electron/core/window-manager.ts']],
    ['any other service of the main process, which the matrix launches whole', ['electron/services/overseer.ts']],
    ['a service born tomorrow', ['electron/services/a-service-born-tomorrow.ts']],
    ['a folder born tomorrow', ['a-folder-born-tomorrow/index.ts']],
    ['the dependency set, node-pty and electron among it', ['package.json', 'package-lock.json']],
    ['the launcher the matrix starts the app with', ['e2e/fixture.mjs']],
    ['the ports it takes', ['e2e/ports.mjs']],
  ])('7. runs the matrix for %s: no list has to name it', (_name, files) => {
    expect(matrix(files as string[])).toBe(true);
  });

  it('7. names every file that leaves the matrix out, and why', () => {
    const decision = decide(['README.md', 'src/app/usage/page.tsx']);

    expect(decision.matrixSkipped.map(s => s.file)).toEqual(['README.md', 'src/app/usage/page.tsx']);
    for (const entry of decision.matrixSkipped) expect(entry.why.length).toBeGreaterThan(0);
  });

  it('2. runs it for MCP servers or hooks alone, though the surfaces are skipped', () => {
    const decision = decide(['mcp-orchestrator/src/index.ts', 'hooks/on-stop.sh']);

    expect(decision.runE2E).toBe(false);
    expect(decision.runMatrix).toBe(true);
  });

  it('4. runs it when there is no diff to reason about', () => {
    expect(matrix([])).toBe(true);
  });

  it('6. names the files that called for it, and why', () => {
    const decision = decide(['electron/providers/codex-provider.ts', 'README.md', 'hooks/on-stop.sh']);

    expect(decision.matrixForcing.map(f => f.file)).toEqual(['electron/providers/codex-provider.ts', 'hooks/on-stop.sh']);
    for (const entry of decision.matrixForcing) expect(entry.why.length).toBeGreaterThan(0);
  });
});
