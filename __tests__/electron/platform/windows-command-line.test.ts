import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  buildWindowsCommandLine, quoteWindowsArg, readWindowsCommandLine, WindowsCommandLineError, WINDOWS_COMMAND_LINE_MAX,
} from '../../../electron/platform/windows-command-line';

/**
 * argv to one Windows command line, quoted by us so node-pty receives a
 * string it will not re-quote.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. An argument with a space or tab is not quoted and splits.
 * 2. An empty argument disappears.
 * 3. An embedded " ends the quoted run (not escaped as \").
 * 4. Backslashes before a " or before the closing quote are not doubled,
 *    so the quote is eaten (C:\dir\ inside quotes).
 * 5. Backslashes elsewhere are doubled and the path comes back altered.
 * 6. An argument already wrapped in quotes ("fix it") is taken as
 *    pre-quoted (node-pty's rule) and loses its quotes or splits.
 * 7. A newline in an argument is not kept inside the quoted run.
 * 8. %, ^, &, |, <, > are escaped or expanded: nothing between us and
 *    CreateProcess reads them, so they must pass through untouched.
 * 9. The program (argv[0]) is quoted with the argument rules; it is parsed
 *    differently (up to the next ", no escapes), so a " in it or an empty
 *    one must be refused.
 * 10. A line longer than CreateProcess accepts (32767 with its NUL) is
 *    returned, to fail later with an opaque error; or a NUL is let through.
 * 11. The round trip through a real Windows parser (the C runtime of a
 *    process started with exactly this line) does not give the argv back.
 *
 * And reading a line back (2026-10-17): the sleep and the stall passes find an
 * agent's CLI on Windows by the command line Windows reports for each process.
 * 12. A line is not split as the program it started splits it: the program's
 *    quotes (no escapes there), a quote escaped by a backslash, backslashes
 *    before a quote or not, two quotes inside quotes, an empty argument, a run
 *    of spaces and tabs, a quote never closed; or what buildWindowsCommandLine
 *    wrote does not read back as the argv it was given.
 */

describe('quoting table', () => {
  const TABLE: Array<[string, string]> = [
    ['abc', 'abc'],
    ['', '""'],
    ['a b', '"a b"'],
    ['a\tb', '"a\tb"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', 'a\\b'],
    ['a\\', 'a\\'],
    ['a b\\', '"a b\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['"fix it"', '"\\"fix it\\""'],
    ['line1\nline2', '"line1\nline2"'],
    ['%PATH%^&|<>', '%PATH%^&|<>'],
    ['C:\\Program Files (x86)\\x\\', '"C:\\Program Files (x86)\\x\\\\"'],
  ];
  it.each(TABLE)('1-8. %j', (arg, quoted) => {
    expect(quoteWindowsArg(arg)).toBe(quoted);
  });

  it('9. the program: quoted when it has a space, never escaped', () => {
    expect(buildWindowsCommandLine(['C:\\Program Files (x86)\\n\\node.exe', 'a b'])).toBe('"C:\\Program Files (x86)\\n\\node.exe" "a b"');
    expect(buildWindowsCommandLine(['C:\\n\\node.exe'])).toBe('C:\\n\\node.exe');
  });

  it.each([[[]], [['']], [['C:\\a"b.exe']], [['a\0b.exe']]])('9. refuses the program in %j', (argv) => {
    expect(() => buildWindowsCommandLine(argv as string[])).toThrow(WindowsCommandLineError);
  });

  it('10. refuses a NUL in an argument', () => {
    try { buildWindowsCommandLine(['x.exe', 'a\0b']); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(WindowsCommandLineError);
      expect((e as WindowsCommandLineError).code).toBe('nul');
    }
  });

  it('10. accepts exactly the limit, refuses one more', () => {
    expect(WINDOWS_COMMAND_LINE_MAX).toBe(32766);
    const fill = (n: number) => buildWindowsCommandLine(['x.exe', 'a'.repeat(n - 'x.exe '.length)]);
    expect(fill(WINDOWS_COMMAND_LINE_MAX)).toHaveLength(WINDOWS_COMMAND_LINE_MAX);
    try { fill(WINDOWS_COMMAND_LINE_MAX + 1); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(WindowsCommandLineError);
      expect((e as WindowsCommandLineError).code).toBe('too-long');
      expect((e as WindowsCommandLineError).length).toBe(WINDOWS_COMMAND_LINE_MAX + 1);
    }
  });
});

const ROUND_TRIP: string[] = [
  '', ' ', 'a b', 'a"b', '"fix it"', '""', '"', '\\', '\\"', 'trailing\\', 'trail space\\', 'a\\"b', 'a\\\\"b',
  '\\\\server\\share\\', 'line1\nline2\r\n', '%PATH% %% ^caret & amp && | < > 2>&1', "it's", "'\\''", 'tab\there',
  'unicode é 日本語 😀', 'C:\\Program Files (x86)\\x\\', '--x="y z"', '-', '--', '/c', 'x\\\\\\',
  `${'multi "line" prompt\n with %VAR% & \'quotes\'\\\n'.repeat(120)}`,
];

/** CommandLineToArgvW / MSVC 2008+ rules, for hosts without a Windows parser. */
function msvcrtParse(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  // Program: up to the next quote, or whitespace, no escapes.
  let prog = '';
  if (line[0] === '"') { i = 1; while (i < line.length && line[i] !== '"') prog += line[i++]; i++; } else {
    while (i < line.length && line[i] !== ' ' && line[i] !== '\t') prog += line[i++];
  }
  args.push(prog);
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let inQuotes = false;
    while (i < line.length && (inQuotes || (line[i] !== ' ' && line[i] !== '\t'))) {
      let bs = 0;
      while (line[i] === '\\') { bs++; i++; }
      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(bs / 2));
        if (bs % 2 === 1) { arg += '"'; i++; continue; }
        if (inQuotes && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
        inQuotes = !inQuotes; i++; continue;
      }
      arg += '\\'.repeat(bs);
      if (i < line.length && (inQuotes || (line[i] !== ' ' && line[i] !== '\t'))) arg += line[i++];
    }
    args.push(arg);
  }
  return args;
}

describe('11. round trip', () => {
  it('through the MSVC rules (every host)', () => {
    for (const arg of ROUND_TRIP) {
      const line = buildWindowsCommandLine(['C:\\Program Files (x86)\\n\\node.exe', arg, 'after']);
      expect(msvcrtParse(line)).toEqual(['C:\\Program Files (x86)\\n\\node.exe', arg, 'after']);
    }
  });

  let dir: string;
  let echo: string;
  beforeAll(() => {
    // Inside the throwaway HOME that home-isolation.ts sets: on win32 os.tmpdir() is under the
    // account home, which its guard refuses, and os.homedir() reads USERPROFILE, which it does not move.
    dir = fs.mkdtempSync(path.join(process.env.HOME!, 'tars cmdline (x86) '));
    echo = path.join(dir, 'echo argv.js');
    fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  // The real parser: a node.exe started with exactly our line. libuv passes a
  // lone argv0 through verbatim with windowsVerbatimArguments, so the child's
  // C runtime is the only thing that splits it.
  it.runIf(process.platform === 'win32')('through a real Windows process started with exactly our line', () => {
    const line = buildWindowsCommandLine([process.execPath, echo, ...ROUND_TRIP]);
    const child = spawnSync(process.execPath, [], { argv0: line, windowsVerbatimArguments: true, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(ROUND_TRIP);
  });

  it.runIf(process.platform === 'win32')('the same line through node-pty\'s own quoting would have split "fix it" (the bug avoided)', async () => {
    const { argsToCommandLine } = await import('node-pty/lib/windowsPtyAgent.js' as string) as { argsToCommandLine: (f: string, a: string[]) => string };
    const theirs = argsToCommandLine(process.execPath, [echo, '"fix it"', 'a\nb']);
    const child = spawnSync(process.execPath, [], { argv0: theirs, windowsVerbatimArguments: true, encoding: 'utf8' });
    expect(JSON.parse(child.stdout)).not.toEqual(['"fix it"', 'a\nb']);
  });
});

describe('12. reading a command line back', () => {
  it('gives back the argv buildWindowsCommandLine was given', () => {
    for (const arg of ROUND_TRIP) {
      const argv = ['C:\\Program Files (x86)\\n\\node.exe', arg, 'after'];
      expect(readWindowsCommandLine(buildWindowsCommandLine(argv))).toEqual(argv);
    }
  });

  it.each([
    ['"C:\\Program Files\\x.exe"  a\t"b c"  d""e "f""g"', ['C:\\Program Files\\x.exe', 'a', 'b c', 'de', 'f"g']],
    ['x.exe h\\\\"i j" k\\"l m\\\\\\"n', ['x.exe', 'h\\i j', 'k"l', 'm\\"n']],
    ['x.exe a\\\\b\\ ""', ['x.exe', 'a\\\\b\\', '']],
    ['C:\\a\\b.exe', ['C:\\a\\b.exe']],
    ['"C:\\a b\\c.exe" "unclosed arg', ['C:\\a b\\c.exe', 'unclosed arg']],
    ['"C:\\a\\" b', ['C:\\a\\', 'b']],
    ['', []],
  ])('%j', (line, argv) => {
    expect(readWindowsCommandLine(line)).toEqual(argv);
    if (line) expect(msvcrtParse(line)).toEqual(argv);
  });
});
