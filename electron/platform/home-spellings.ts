/**
 * How a home folder is written where it has to be found again: an error
 * report takes it out of every path and message it carries (the scrub of
 * electron/services/error-reports/report.ts).
 *
 * A macOS or Linux home has one spelling, `/Users/somebody`. A Windows home,
 * `C:\Users\somebody`, reaches an error in several: with forward slashes (a
 * file URL, an ES module's stack frame), with its backslashes doubled (a path
 * quoted in JSON), URL-encoded. And its user name is what follows its last
 * backslash, where the scrub took what follows the last `/`, which on Windows
 * was the whole path. Held by error-report-windows-home.test.ts.
 */

/**
 * A Windows home's 8.3 short form (`C:\\Users\\ANALC~1` for `C:\\Users\\Ana Lucia`),
 * as the user's own temp folders spell it: TEMP, TMP and os.tmpdir() often
 * hold it, and every path made under them carries it (the Audit's Medium on
 * #433). Taken from a temp folder only when it sits beside the home, in the
 * same parent, and its last part is an 8.3 name; never derived from the name.
 */
export function windowsShortHomes(home: string, tempDirs: readonly string[]): string[] {
  if (!home.includes('\\')) return [];
  const parent = home.slice(0, home.lastIndexOf('\\')).toLowerCase();
  const found = new Set<string>();
  for (const dir of tempDirs) {
    const m = /^([A-Za-z]:\\(?:[^\\]+\\)*?)([^\\]{1,6}~\d+)(?=\\|$)/.exec(dir);
    if (!m || m[1].slice(0, -1).toLowerCase() !== parent) continue;
    const short = `${m[1]}${m[2]}`;
    if (short.toLowerCase() !== home.toLowerCase()) found.add(short);
  }
  return [...found];
}

/** One Windows path's spellings beside itself: forward, doubled, URL-encoded, and as a file URL writes it. */
function spellingsOf(home: string): string[] {
  const forward = home.replace(/\\/g, '/');
  const uri = encodeURI(forward);
  return [forward, home.replace(/\\/g, '\\\\'), encodeURIComponent(home), encodeURIComponent(forward), uri, `/${uri}`];
}

/**
 * The other spellings of a Windows home, its short form's included (from
 * `tempDirs`); none for a POSIX one, whose scrub stays as it was.
 */
export function windowsHomeSpellings(home: string, tempDirs: readonly string[] = []): string[] {
  if (!home.includes('\\')) return [];
  const shorts = windowsShortHomes(home, tempDirs);
  return [...new Set([...spellingsOf(home), ...shorts.flatMap(short => [short, ...spellingsOf(short)])])].filter(s => s !== home);
}

/** The user name a home ends with: its last part, after a `/` or, on Windows, a `\`. */
export function homeUserName(home: string): string {
  return home.split(home.includes('\\') ? /[\\/]/ : '/').filter(Boolean).pop() ?? '';
}
