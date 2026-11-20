import '../setup/home-guard';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { makeUnreadable } from '../setup/file-access';

/**
 * `npm run lint:design`, run on throwaway trees laid out like src/ and never on
 * the repository's own, so the violations the Frontend still has to fix cannot
 * decide whether the guard itself works.
 *
 * Each rule is planted in each kind of file the lint reads and must turn it
 * red, the files whose job is raw appearance must not, and every way grep can
 * fail to search must turn it red too. Reading that as "nothing found" is how
 * this script printed five green ticks over a src/ that did not exist.
 *
 * The lint is scripts/design-lint.mjs, the Node port of the grep script it
 * replaced, run by the node running these tests: the same checks, lines and
 * exit codes, on every platform, with no bash or grep to find.
 */

const SCRIPT = path.join(__dirname, '../../scripts/design-lint.mjs');
const made: string[] = [];
/** What gives each locked file or folder back its reads, before the trees go. */
const unlocks: Array<() => void> = [];

afterAll(() => {
  for (const unlock of unlocks) unlock();
  for (const dir of made) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/**
 * Makes a file impossible to read, or a folder impossible to list: mode 000 on
 * POSIX, and on Windows, where chmod only sets the read-only flag, its data
 * denied to this account (file-access.ts). afterAll lifts it before the tree is
 * removed.
 */
function lockAgainstReading(target: string, { folder = false } = {}) {
  unlocks.push(makeUnreadable(target, folder ? 0o755 : 0o644));
  // The witness: a lock that does not lock would let this case pass for the wrong reason.
  expect(() => (folder ? fs.readdirSync(target) : fs.readFileSync(target))).toThrow();
}

/** One line per rule, as text: grep reads characters, not syntax. */
const EVERYTHING_BANNED = [
  'export const radius = <div style={{ borderRadius: 4 }} />;',
  "export const shadow = 'shadow-lg';",
  "export const gradient = 'bg-gradient-to-r';",
  "export const ping = 'animate-ping';",
  "export const palette = 'bg-red-500';",
  "export const hex = '#1a1a1a';",
].join('\n') + '\n';

const RULES = [
  'no inline border-radius',
  'no drop shadows',
  'no gradients',
  'no decorative ping',
  'no raw tailwind palette',
  'no hardcoded hex colour',
];

/**
 * A tree that passes: a component, a constant and a stylesheet written with
 * tokens, and everything banned in the two places allowed to define raw
 * appearance.
 */
function cleanTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-design-lint-'));
  made.push(root);
  write(root, 'src/components/Card.tsx', 'export const Card = () => <div className="bg-card text-foreground border-border" />;\n');
  write(root, 'src/lib/badges.ts', "export const badge = 'bg-primary/10 text-primary';\n");
  write(root, 'src/app/page.css', '.page { @apply bg-background text-foreground; }\n');
  write(root, 'src/components/ui/index.ts', EVERYTHING_BANNED);
  write(root, 'src/app/icon.tsx', EVERYTHING_BANNED);
  return root;
}

/** The lint, run from `root` as `npm run lint:design` runs it from the repository. */
function lint(root: string, script = SCRIPT): Promise<{ status: number | null; output: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [script], { cwd: root, encoding: 'utf8' }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ status, output: `${stdout}${stderr}` });
    });
  });
}

/** A copy of the script with one exact edit, placed in `root`. */
function editedScript(root: string, from: string, to: string): string {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  expect(source.split(from)).toHaveLength(2);
  const copy = path.join(root, 'design-lint.edited.mjs');
  fs.writeFileSync(copy, source.replace(from, to));
  return copy;
}

describe.concurrent('what the lint reads', () => {
  it('passes a clean tree, counting every file it read, whatever the exempt files hold', async ({ expect }) => {
    const run = await lint(cleanTree());

    expect(run.output).toContain('5 files read under src/');
    for (const rule of RULES) expect(run.output).toContain(`✓ ${rule}`);
    expect(run.status).toBe(0);
  });

  it('turns every rule red on what the exempt files hold, once it is anywhere else', async ({ expect }) => {
    // The witness for the case above: without it, a clean pass could mean the
    // banned lines match nothing at all.
    const root = cleanTree();
    write(root, 'src/components/Widgets/index.ts', EVERYTHING_BANNED);

    const run = await lint(root);

    for (const rule of RULES) expect(run.output).toContain(`✗ ${rule}`);
    expect(run.status).toBe(1);
  });

  const planted = {
    tsx: { file: 'src/components/Planted.tsx', line: (classes: string) => `export const Planted = () => <div className="${classes}" />;` },
    ts: { file: 'src/lib/planted.ts', line: (classes: string) => `export const planted = '${classes}';` },
    css: { file: 'src/app/planted.css', line: (classes: string) => `.planted { @apply ${classes}; }` },
  };

  it.for([
    ['no inline border-radius', 'tsx', 'export const Planted = () => <div style={{ borderRadius: 4 }} />;'],
    ['no drop shadows', 'tsx', planted.tsx.line('shadow-lg')],
    ['no drop shadows', 'ts', planted.ts.line('shadow-md')],
    ['no drop shadows', 'css', planted.css.line('shadow-2xl')],
    ['no gradients', 'tsx', planted.tsx.line('bg-gradient-to-r')],
    ['no gradients', 'ts', planted.ts.line('bg-gradient-to-b')],
    ['no gradients', 'css', planted.css.line('bg-gradient-to-l')],
    ['no decorative ping', 'tsx', planted.tsx.line('animate-ping')],
    ['no decorative ping', 'ts', planted.ts.line('animate-ping')],
    ['no decorative ping', 'css', planted.css.line('animate-ping')],
    ['no raw tailwind palette', 'tsx', planted.tsx.line('text-slate-400')],
    ['no raw tailwind palette', 'ts', planted.ts.line('bg-green-500/15')],
    ['no raw tailwind palette', 'css', planted.css.line('border-red-600')],
    ['no hardcoded hex colour', 'tsx', "export const Planted = () => <div style={{ color: '#fff' }} />;"],
    ['no hardcoded hex colour', 'tsx', planted.tsx.line('bg-[#1a1a1a]')],
    ['no hardcoded hex colour', 'ts', "export const planted = { background: '#F3F1EE', text: '#1E1E1E' };"],
    ['no hardcoded hex colour', 'css', '.planted { border: 1px solid #121212; }'],
  ] as const)('turns "%s" red when it is planted in a .%s file', async ([rule, kind, line], { expect }) => {
    const root = cleanTree();
    write(root, planted[kind].file, `// planted\n${line}\n`);

    const run = await lint(root);

    expect(run.output).toContain(`✗ ${rule}\n    ${planted[kind].file}:2:`);
    expect(run.output.match(/✗/g)).toHaveLength(1);
    expect(run.status).toBe(1);
  });

  it('reads a line that only mentions an exempt path', async ({ expect }) => {
    // The exemptions used to be matched anywhere in grep's output line, so a
    // violation beside the words "src/components/ui/" was set aside with them.
    const root = cleanTree();
    write(root, 'src/lib/notes.ts', "export const from = 'src/components/ui/ and app/icon.tsx'; export const c = 'bg-gradient-to-r';\n");

    const run = await lint(root);

    expect(run.output).toContain('✗ no gradients\n    src/lib/notes.ts:1:');
    expect(run.status).toBe(1);
  });

  it('leaves the token system its hex values, and nothing else', async ({ expect }) => {
    // globals.css is where each colour is written out once and given a name.
    // The witness that this exempts a file and not the rule: the same line, in
    // the stylesheet next to it, is a violation.
    const root = cleanTree();
    write(root, 'src/app/globals.css', ':root { --bg: #121212; --text: #F5F4F2; }\n');

    expect((await lint(root)).status).toBe(0);

    write(root, 'src/app/theme.css', ':root { --bg: #121212; }\n');
    const run = await lint(root);

    expect(run.output).toContain('✗ no hardcoded hex colour\n    src/app/theme.css:1:');
    expect(run.status).toBe(1);
  });

  it('reads no colour in a comment, and every colour in the code beside it', async ({ expect }) => {
    // "(React #418)" is an error number, and a hex in a comment paints nothing.
    const root = cleanTree();
    write(root, 'src/components/Notes.tsx', [
      '// hydration failed (React #418), and the client re-rendered',
      '/**',
      ' * @see #1a1a1a, the old card colour',
      ' */',
      'export const Notes = () => <div className="bg-card" />;',
    ].join('\n') + '\n');

    expect((await lint(root)).status).toBe(0);

    write(root, 'src/components/Notes.tsx', "export const Notes = () => <div style={{ color: '#1a1a1a' }} />;\n");
    const run = await lint(root);

    expect(run.output).toContain('✗ no hardcoded hex colour\n    src/components/Notes.tsx:1:');
    expect(run.status).toBe(1);
  });

  it('reads an HTML entity and a number of no colour length as what they are', async ({ expect }) => {
    const root = cleanTree();
    write(root, 'src/components/Entities.tsx', [
      'export const Bullet = () => <span>&#8226;</span>;',
      "export const five = '#12345';",
      "export const seven = '#1234567';",
    ].join('\n') + '\n');

    expect((await lint(root)).status).toBe(0);
  });

  it('reads a file that holds a NUL byte as text, and shows the line', async ({ expect }) => {
    const root = cleanTree();
    write(root, 'src/lib/separators.ts', `export const sep = '${String.fromCharCode(0)}';\nexport const c = 'bg-red-500';\n`);

    const run = await lint(root);

    expect(run.output).toContain('✗ no raw tailwind palette\n    src/lib/separators.ts:2:');
    expect(run.status).toBe(1);
  });
});

describe.concurrent('a lint that could not search', () => {
  it('fails when there is no src/ to read', async ({ expect }) => {
    const root = cleanTree();
    fs.rmSync(path.join(root, 'src'), { recursive: true });

    const run = await lint(root);

    // grep on macOS answers 1 here, silently; GNU grep answers 2.
    expect(run.output).toMatch(/nothing was checked|could not read everything under src\//);
    expect(run.output).not.toContain('✓');
    expect(run.status).toBe(1);
  });

  it('fails when src/ holds nothing it reads', async ({ expect }) => {
    const root = cleanTree();
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    write(root, 'src/README.md', 'bg-red-500\n');

    const run = await lint(root);

    expect(run.output).toContain('✗ no .ts, .tsx or .css file under src/: nothing was checked');
    expect(run.output).not.toContain('✓');
    expect(run.status).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)('fails when grep cannot open a file, even one holding the only violation', async ({ expect }) => {
    const root = cleanTree();
    write(root, 'src/components/Locked.tsx', 'export const Locked = () => <div className="shadow-lg" />;\n');
    lockAgainstReading(path.join(root, 'src/components/Locked.tsx'));

    const run = await lint(root);

    expect(run.output).toContain('✗ could not read everything under src/ (grep exited 2)');
    expect(run.output).not.toContain('✓');
    expect(run.status).toBe(1);
  });

  it.skipIf(process.getuid?.() === 0)('fails when grep cannot open a folder, even one holding the only violation', async ({ expect }) => {
    const root = cleanTree();
    write(root, 'src/components/locked/Shadow.tsx', 'export const Shadow = () => <div className="shadow-lg" />;\n');
    lockAgainstReading(path.join(root, 'src/components/locked'), { folder: true });

    const run = await lint(root);

    expect(run.output).toContain('✗ could not read everything under src/ (grep exited 2)');
    expect(run.output).not.toContain('✓');
    expect(run.status).toBe(1);
  });

  it('fails when a rule is a pattern grep cannot parse', async ({ expect }) => {
    const root = cleanTree();
    const script = editedScript(root, 'String.raw`shadow-(sm|md|lg|xl|2xl)`', 'String.raw`shadow-(sm|md|lg|xl|2xl`');

    const run = await lint(root, script);

    expect(run.output).toContain('✗ no drop shadows: grep could not search (exit 2)');
    expect(run.status).toBe(1);
  });

  it('fails when the exemptions are a pattern grep cannot parse', async ({ expect }) => {
    // Only lines found reach the exemptions, so something has to be found.
    const root = cleanTree();
    write(root, 'src/lib/planted.ts', "export const c = 'animate-ping';\n");
    const script = editedScript(root, 'String.raw`^src/components/ui/`', 'String.raw`^src/components/(ui/`');

    const run = await lint(root, script);

    expect(run.output).toContain('✗ no decorative ping: grep could not search (exit 2)');
    expect(run.status).toBe(1);
  });
});
