import { describe, it, expect } from 'vitest';
import { toReport, type ReportFacts } from '../../../electron/services/error-reports/report';

/**
 * An error report from Windows keeps the home folder and the user name out,
 * as one from macOS does (error-report-shape.test.ts, #221).
 *
 * The report's scrub knew a home spelled one way, `/Users/somebody`, and took
 * the user name as what follows its last `/`. A Windows home is
 * `C:\Users\somebody`, and it reaches an error in more than one spelling.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. The user name is never taken out on its own: split on `/`, the whole
 *    `C:\Users\somebody` is taken for it, so `somebody@DESKTOP-1` or
 *    `DESKTOP-1\somebody` in a message leaves the name.
 * 2. The home spelled with forward slashes, as a file URL and an ES module's
 *    stack frame write it (`file:///C:/Users/somebody/...`), leaves whole.
 * 3. The home with its backslashes doubled, as a path quoted in JSON
 *    (`"C:\\Users\\somebody"` in a JSON.parse message), leaves whole.
 * 4. The home URL-encoded (`C%3A%5CUsers%5Csomebody`) leaves whole.
 * 5. Any case: `c:\users\SOMEBODY` leaves.
 * 6. Over-correction: a macOS or Linux home gets other spellings, and its
 *    reports change (error-report-shape.test.ts holds them as they were);
 *    here, a POSIX home's user name is still the part after its last `/`.
 * And from the Audit's Medium on #433 (2.0.4):
 * 7. A home with a space or an accent, as a file URL writes it
 *    (`file:///C:/Users/Ana%20L%C3%BAcia/...`, encodeURI of the forward
 *    spelling), leaves whole: the other encodings did not match it.
 * 8. The home's 8.3 short form, which TEMP, TMP and os.tmpdir() often hold
 *    (`C:\Users\ANALC~1\AppData\Local\Temp`) and the paths made under
 *    them carry (the launch folder, the CLI updater's scratch,
 *    save-worktree-work), leaves whole, in any of the home's spellings.
 * 9. Over-correction: a temp folder elsewhere (`C:\Windows\Temp`,
 *    `D:\Temp`) or a sibling that is no short form (`C:\Users\Public`) is
 *    taken for the home, and those paths are rewritten as ~.
 */

const facts = (home: string, tempDirs?: string[]): ReportFacts => ({
  installId: '3b1f6c2e-5d7a-4e8b-9c0d-1a2b3c4d5e6f',
  release: 'tars@1.9.1',
  home,
  os: { name: 'Windows', version: '10.0.26200' },
  electron: '44.4.4',
  ...(tempDirs ? { tempDirs } : {}),
});

const HOME = 'C:\\Users\\somebody';

/** The report of one error with this message and this frame file name, as JSON. */
function reported(message: string, filename: string, home = HOME, tempDirs?: string[]): string {
  const report = toReport({
    exception: { values: [{ type: 'Error', value: message, stacktrace: { frames: [{ filename, function: 'startAgent', lineno: 1, colno: 1, in_app: true }] } }] },
  }, facts(home, tempDirs));
  expect(report).not.toBeNull();
  return JSON.stringify(report);
}

describe('an error report from Windows', () => {
  it('1. takes the user name out on its own', () => {
    const text = reported('ssh: somebody@DESKTOP-1 refused, and DESKTOP-1\\somebody has no key', 'C:\\Program Files\\Tars\\resources\\app.asar\\electron\\dist\\main.js');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('<user>@DESKTOP-1');
  });

  it('2. writes the home as ~ when it is spelled with forward slashes', () => {
    const text = reported('ENOENT: no such file C:/Users/somebody/projects/acme/notes.md', 'file:///C:/Users/somebody/AppData/Local/Programs/Tars/resources/app.asar/electron/dist/main.js');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('~/projects/acme/notes.md');
    expect(text).toContain('~/AppData/Local/Programs/Tars');
  });

  it('3. writes the home as ~ when its backslashes are doubled, as JSON quotes it', () => {
    const text = reported('Unexpected token in JSON at position 3: {"cwd":"C:\\\\Users\\\\somebody\\\\acme"}', 'C:\\Users\\somebody\\AppData\\Local\\Programs\\Tars\\main.js');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('~\\\\\\\\acme');
  });

  it('4. writes the home as ~ when it is URL-encoded', () => {
    const text = reported('GET app://-/open?path=C%3A%5CUsers%5Csomebody%5Cacme failed', 'app:///main.js');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('path=~%5Cacme');
  });

  it('5. whatever the case it is written in', () => {
    const text = reported('EPERM: c:\\users\\SOMEBODY\\.dorothy\\agents.json', 'C:\\USERS\\SomeBody\\x.js');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('~\\\\.dorothy');
  });

  it('6. leaves a POSIX home to what it was: its user name is what follows its last slash', () => {
    const text = reported('ssh: somebody@host refused in /Users/somebody/acme', '/Users/somebody/x.js', '/Users/somebody');
    expect(text).not.toMatch(/somebody/i);
    expect(text).toContain('<user>@host');
    expect(text).toContain('~/acme');
  });

  it('7. writes the home as ~ in a file URL, a space or an accent in it', () => {
    const home = 'C:\\Users\\Ana Lúcia';
    const text = reported('ENOENT: C:/Users/Ana%20L%C3%BAcia/projects/acme/notes.md', 'file:///C:/Users/Ana%20L%C3%BAcia/AppData/Local/Programs/Tars/resources/app.asar/electron/dist/main.js', home);
    expect(text).not.toMatch(/L%C3%BAcia|Lúcia/i);
    expect(text).toContain('~/projects/acme/notes.md');
    expect(text).toContain('~/AppData/Local/Programs/Tars');
  });

  it('8. writes the home\'s 8.3 short form as ~, as the temp folders spell it', () => {
    const home = 'C:\\Users\\Ana Lúcia';
    const temp = ['C:\\Users\\ANALC~1\\AppData\\Local\\Temp'];
    const text = reported(
      'EPERM: C:\\Users\\ANALC~1\\AppData\\Local\\Temp\\tars-launch-1\\cmd.txt, and "C:\\\\Users\\\\ANALC~1\\\\x"',
      'C:/Users/ANALC~1/AppData/Local/Temp/tars-cli-update/npm.js', home, temp,
    );
    expect(text).not.toMatch(/ANALC/i);
    expect(text).toContain('~\\\\AppData\\\\Local\\\\Temp\\\\tars-launch-1');
    expect(text).toContain('~/AppData/Local/Temp/tars-cli-update');
  });

  it('9. takes no other folder for the home: a temp elsewhere, or a sibling that is no short form', () => {
    const temp = ['C:\\Windows\\Temp', 'D:\\Temp', 'C:\\Users\\Public\\Temp'];
    const text = reported('EBUSY C:\\Windows\\Temp\\a, D:\\Temp\\b, C:\\Users\\Public\\c', 'C:/Users/Public/x.js', HOME, temp);
    expect(text).toContain('C:\\\\Windows\\\\Temp\\\\a');
    expect(text).toContain('D:\\\\Temp\\\\b');
    expect(text).toContain('C:\\\\Users\\\\Public\\\\c');
    expect(text).toContain('C:/Users/Public/x.js');
  });
});
