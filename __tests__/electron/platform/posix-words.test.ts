import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { posixWords, PosixWordsError } from '../../../electron/platform/posix-words';

/**
 * The provider's POSIX command line, read back into argv, to start the CLI
 * without a shell on Windows.
 *
 * The grammar is closed, pinned by what the 21 providers emit (read on
 * 2026-09-25 from every buildInteractiveCommand and the helpers in
 * cli-provider.ts, and held by exec-into-cli.test.ts): words separated by
 * spaces; a word is a run of single-quoted text (anything but ', newlines
 * included), the escape \' (from '\''), double-quoted plain text ("Edit",
 * from orchestratorToolFlags) and bare safe characters (flags, effort levels,
 * `-p`). Nothing else is a word.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. A quoted prompt is split, trimmed or altered: quotes, '\'' runs,
 *    newlines, %, ^, &, |, ", backslashes, $, unicode, 20 KB.
 * 2. The binary path (spaces, a quote, parentheses) is altered.
 * 3. Adjacent segments are not concatenated into one word ('it'\''s').
 * 4. An empty quoted word ('') is dropped instead of kept as "".
 * 5. Shell syntax outside quotes is guessed at instead of refused with a
 *    typed error: ; && || | & ( ) $ $( ` < > >> 2>&1, a newline or a tab
 *    between words, a backslash other than \', a glob or ~ or #, a
 *    leading VAR=value, a leading keyword (exec, eval, if, ...).
 * 6. An unterminated ' or " is accepted.
 * 7. $ or ` or \ inside double quotes is accepted (expansion, not text).
 * 8. The error does not say which code or where (index).
 * 9. A provider's real command, with every option Tars can set, does not
 *    round-trip: the words differ from bash's own reading of the line.
 *    A line may hand its CLI a home ahead of the binary, on macOS and Linux:
 *    codex's `env CODEX_HOME=<home>` (the Audit's L4 on #465), grok's
 *    `env GROK_HOME=<home>` and gemini's `env GEMINI_CLI_HOME=<home>` or
 *    `env -u GEMINI_CLI_HOME` (#645). That prefix in another form, or ahead of
 *    another provider's binary, fails too.
 */

let tmpDir: string;
vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

beforeAll(() => {
  // Inside the throwaway HOME that home-isolation.ts sets (on win32 os.tmpdir() is under the
  // account home, which its guard refuses, and os.homedir() is mocked here).
  tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.HOME!), 'tars posix words (x86) '));
  fs.writeFileSync(path.join(tmpDir, 'mcp.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'instructions.md'), '');
});
afterAll(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** The reference quoting every provider uses for a value. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const ADVERSARIAL: Array<[string, string]> = [
  ['quotes', `don't "stop" at the first failure's end`],
  ["'\\'' runs", `a'\\''b '' ''' \\' '\\\\'`],
  ['newlines and CR', 'line1\nline2\r\n\n  indented\n'],
  ['cmd metacharacters', '%PATH% %% ^caret & amp && | pipe || < > >> 2>&1 (paren) !bang!'],
  ['shell metacharacters', '$HOME ${x} $(whoami) `id` ; rm -rf / # comment ~ * ? [a] {b,c}'],
  ['backslashes', 'C:\\Users\\x\\ trailing\\\\ \\"quoted\\" \\\\server\\share\\'],
  ['double quotes', '"fix it" and ""empty"" and "unbalanced'],
  ['unicode', 'é à ç ü 日本語 emoji 😀 zero\u200bwidth rtl\u202eabc'],
  ['leading dash', '--dangerously-skip-permissions -rf'],
  ['only spaces around', '   padded   '],
  ['20 KB', `${'Lorem ipsum dolor sit amet, it\'s "fine" %X% & more.\n'.repeat(400)}`.slice(0, 20_000)],
];

describe('the closed grammar', () => {
  it('1. a single-quoted prompt comes back exactly', () => {
    for (const [label, prompt] of ADVERSARIAL) {
      expect([label, posixWords(`'bin' -- ${q(prompt)}`)]).toEqual([label, ['bin', '--', prompt]]);
    }
  });

  it('2. a binary path with spaces, a quote and parentheses', () => {
    const bin = "C:\\Program Files (x86)\\o'neil\\claude.exe";
    expect(posixWords(`${q(bin)} --verbose`)).toEqual([bin, '--verbose']);
  });

  it('3. adjacent segments make one word', () => {
    expect(posixWords(`'it'\\''s' --a='b'"c"d`)).toEqual(["it's", '--a=bcd']);
  });

  it('4. an empty quoted word is kept', () => {
    expect(posixWords(`'bin' '' ""`)).toEqual(['bin', '', '']);
  });

  it('double-quoted plain words, as orchestratorToolFlags writes them', () => {
    expect(posixWords(`'claude' --disallowed-tools "Edit" "Write" "NotebookEdit" "Task"`))
      .toEqual(['claude', '--disallowed-tools', 'Edit', 'Write', 'NotebookEdit', 'Task']);
  });

  it('several spaces between words, and around the line', () => {
    expect(posixWords(`  'bin'   -p    --x  `)).toEqual(['bin', '-p', '--x']);
  });
});

describe('everything outside the grammar is refused with a typed error', () => {
  const REFUSED: Array<[string, string, string]> = [
    ['empty', '', 'empty'],
    ['blank', '   ', 'empty'],
    [';', `'bin' ; rm x`, 'operator'],
    [';;', `'bin';`, 'operator'],
    ['&&', `'bin' && x`, 'operator'],
    ['||', `'bin' || x`, 'operator'],
    ['|', `'bin' | tee`, 'operator'],
    ['&', `'bin' &`, 'operator'],
    ['( )', `('bin')`, 'operator'],
    ['$(', `'bin' $(id)`, 'expansion'],
    ['$VAR', `'bin' $HOME`, 'expansion'],
    ['${', `'bin' \${x}`, 'expansion'],
    ['backtick', "'bin' `id`", 'expansion'],
    ['<', `'bin' < in`, 'redirection'],
    ['>', `'bin' > out`, 'redirection'],
    ['>>', `'bin' >> out`, 'redirection'],
    ['2>&1', `'bin' 2>&1`, 'redirection'],
    ['newline between words', `'bin'\n'x'`, 'whitespace'],
    ['tab between words', `'bin'\t'x'`, 'whitespace'],
    ['backslash escape', `'bin' a\\ b`, 'escape'],
    ['backslash-newline', `'bin' \\\n'x'`, 'escape'],
    ['glob *', `'bin' *.ts`, 'special'],
    ['glob ?', `'bin' a?`, 'special'],
    ['brace', `'bin' {a,b}`, 'special'],
    ['tilde', `'bin' ~/x`, 'special'],
    ['comment', `'bin' #x`, 'special'],
    ['history', `'bin' !x`, 'special'],
    ['leading assignment', `FOO=bar 'bin'`, 'assignment'],
    ['leading assignment of a quoted value', `FOO='bar' 'bin'`, 'assignment'],
    ['leading exec', `exec 'bin'`, 'keyword'],
    ['leading eval', `eval 'bin'`, 'keyword'],
    ['leading if', `if 'bin'`, 'keyword'],
    ['unterminated single', `'bin' 'oops`, 'unterminated-quote'],
    ['unterminated double', `'bin' "oops`, 'unterminated-quote'],
    ['$ in double quotes', `'bin' "$HOME"`, 'expansion'],
    ['backtick in double quotes', "'bin' \"`id`\"", 'expansion'],
    ['backslash in double quotes', `'bin' "a\\"b"`, 'escape'],
    ['unicode bare', `'bin' é`, 'unsupported-char'],
  ];

  it.each(REFUSED)('5, 6, 7. %s', (_label, line, code) => {
    let caught: unknown;
    try { posixWords(line); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PosixWordsError);
    expect((caught as PosixWordsError).code).toBe(code);
  });

  it('8. says where', () => {
    try { posixWords(`'bin' --ok ; x`); expect.unreachable(); } catch (e) {
      expect((e as PosixWordsError).index).toBe(11);
      expect((e as PosixWordsError).message).toMatch(/index 11/);
    }
  });
});

/** A bash to read the lines with, as the oracle: /bin/bash, or Git for Windows'. */
function findBash(): string | undefined {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
    : ['/bin/bash'];
  return candidates.find((c) => fs.existsSync(c));
}
const bash = findBash();

/**
 * bash's own words for a line: printf each as NUL-terminated. The line goes
 * in on stdin, not as `-c`: Git for Windows' MSYS runtime re-parses a native
 * parent's command line (single quotes included) and cuts it at about 8 KB,
 * so a `-c` argument reaches bash altered there.
 */
function bashWords(command: string): string[] {
  const out = execFileSync(bash!, ['-s'], {
    input: `printf '%s\\0' ${command}\n`,
    encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').slice(0, -1);
}

async function commandOf(providerId: string, prompt: string, binaryPath: string): Promise<string> {
  const { getProvider } = await import('../../../electron/providers');
  return getProvider(providerId as never).buildInteractiveCommand({
    binaryPath,
    prompt,
    model: 'some-model',
    verbose: true,
    permissionMode: 'bypass',
    effort: 'high',
    secondaryProjectPath: tmpDir,
    obsidianVaultPaths: [tmpDir],
    mcpConfigPath: path.join(tmpDir, 'mcp.json'),
    systemPromptFile: path.join(tmpDir, 'instructions.md'),
    skills: ['one', 'two'],
    // With the skills directive suppressed, the last word is the prompt as given.
    isSuperAgent: true,
    chrome: true,
    orchestratorMode: true,
    resumeSessionId: '0b8e4f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b',
    forkSession: true,
  });
}

/**
 * The home variable a provider's line may hand its CLI ahead of the binary, on macOS and Linux: codex's Tars's home
 * (`env CODEX_HOME=<home>`, the Audit's L4 on #465), grok's always (`env GROK_HOME=<home>`, grok-provider.ts, #645),
 * gemini's the GEMINI_CLI_HOME Tars's environment names (`env GEMINI_CLI_HOME=<home>`), else the variable taken off the
 * line (`env -u GEMINI_CLI_HOME`, gemini-provider.ts homeOnLine, #645).
 */
const HOME_AHEAD: Record<string, string> = { codex: 'CODEX_HOME', gemini: 'GEMINI_CLI_HOME', grok: 'GROK_HOME' };

/**
 * How many of a line's first words hand its CLI that home (0 when none), their form asserted. Another provider's
 * `env`, or one naming another variable, is not taken off, so its first word is not its binary and case 9 fails.
 */
function homeAhead(id: string, all: string[]): number {
  const name = HOME_AHEAD[id];
  if (all[0] !== 'env' || !name) return 0;
  if (id === 'gemini' && all[1] === '-u') {
    expect([id, all[2]]).toEqual([id, name]);
    return 3;
  }
  expect([id, all[1]?.startsWith(`${name}=`)]).toEqual([id, true]);
  return 2;
}

describe('9. every provider round-trips', () => {
  it('covers the 21 providers', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    expect(getAllProviders()).toHaveLength(21);
  });

  it('first word the binary, last word the prompt, the rest from the grammar, for every adversarial prompt', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    const bin = path.join(tmpDir, "fake cli (x86)'s");
    for (const provider of getAllProviders()) {
      for (const [label, prompt] of ADVERSARIAL) {
        const all = posixWords(await commandOf(provider.id, prompt, bin));
        const words = all.slice(homeAhead(provider.id, all));
        if (provider.taskTypedAfterLaunch) {
          // Amp's line never carries the task: it is typed in once its TUI runs (core/typed-task.ts, 2.0.4).
          expect([provider.id, label, words[0], words.includes(prompt)]).toEqual([provider.id, label, bin, false]);
        } else {
          expect([provider.id, label, words[0], words.at(-1)]).toEqual([provider.id, label, bin, prompt]);
        }
      }
    }
  });

  it.skipIf(!bash)('agrees with bash word for word, every provider, every prompt (oracle: a real bash)', async () => {
    const { getAllProviders } = await import('../../../electron/providers');
    const bin = path.join(tmpDir, "fake cli (x86)'s");
    const mismatches: string[] = [];
    for (const provider of getAllProviders()) {
      for (const [label, prompt] of ADVERSARIAL) {
        // The 20 KB prompt goes through bash once, for claude: one bash per
        // provider and prompt is slow enough already.
        if (label === '20 KB' && provider.id !== 'claude') continue;
        const command = await commandOf(provider.id, prompt, bin);
        // Git for Windows' bash drops every CR from a script it reads
        // (measured: 'c\rd' comes back cd), so there the comparison is made
        // without them. The first round trip above holds CR exactly on every
        // host, and /bin/bash does here on macOS and Linux.
        const ours = posixWords(command).map((w) => (process.platform === 'win32' ? w.replace(/\r/g, '') : w));
        const theirs = bashWords(command);
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) mismatches.push(`${provider.id} / ${label}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);
});
