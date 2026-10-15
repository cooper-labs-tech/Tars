import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasPosixModes } from '../../setup/platform-limits';
import { toReport, reportFingerprint, keepErrorsOnly, type ReportFacts } from '../../../electron/services/error-reports/report';
import { ReportBudget } from '../../../electron/services/error-reports/budget';

/**
 * What an error report is allowed to carry, and how many leave (Sentry, step 1
 * of PLAN-RELAIS-SENTRY.md; the design's part B1).
 *
 * Error reports are off unless the user turns them on in Settings. When on,
 * only this leaves: the error's type and message and its stack (function,
 * file, line, column), Tars's version, the system's name and version, the
 * Electron version, the process it came from, and a random id for the
 * installation. The report is BUILT from those fields, not scrubbed from the
 * SDK's event: whatever the SDK or a renderer adds (breadcrumbs, request,
 * user, extra, contexts, the host name) is not copied, so it cannot leak by
 * being forgotten in a deny list.
 *
 * How it fails, written before the code (2026-09-28):
 * 1. The home folder travels: in the message, a frame's file name, its
 *    absolute path, its module, a file:// URL, the real path of a /var folder.
 * 2. A secret travels: an API key, a bearer token, a bot token in a message.
 * 3. Something that is not an error's shape travels: breadcrumbs (console
 *    lines, clicks, fetches), the request and its body, the user's email or
 *    address, extra, tags, the host name, device names, source lines around a
 *    frame, a frame's local variables, the modules list, the SDK's own data.
 * 4. A conversation or a prompt travels, wherever the SDK put it.
 * 4b. A conversation or a prompt travels inside the error's own message,
 *    quoted, the way an error names the input it choked on (JSON.parse, a
 *    CLI's refusal): quoted text that reads as words (a space in it, more than
 *    24 characters) is replaced by its length. A quoted name (a module, a
 *    channel, a short id) is kept: it is what says where it broke.
 * 5. An event with no exception leaves: a message, a console capture, a log.
 * 6. A huge message or a deep stack leaves whole.
 * 7. Over-correction: the type, the message, the functions, the lines, the
 *    release, the system and the install id are dropped, and the report is
 *    useless.
 * 8. The same error is sent more than once a day, or more than 20 reports a
 *    day leave, from one installation, across restarts too.
 * 9. A budget file that is corrupt, or missing, stops reports for good or
 *    throws in the main process.
 * 10. An envelope item that is not an error event (a session, an attachment,
 *     a replay, a feedback, a client report, a log, a span) leaves.
 * 11. (the Audit's gate of #221) The home folder is only rewritten before
 *     `/`, a space, `:`, a quote or `)`: `cwd /Users/x, exit 1`, `/Users/x;`,
 *     `/users/x` (another case), `%2FUsers%2Fx` (URL-encoded) and a bare
 *     `x@Host.local` leave the full path, or the user name.
 * 12. (QA's gate of #221) The home folder behind /private, the name macOS
 *     also gives it, leaves as `/private~`: the shorter name was replaced
 *     first, inside the longer one.
 * 13. A path URL-encoded twice (`%252F`, a URL inside a URL's query) leaves
 *     whole, with the user name in it.
 * 14. The machine's name leaves: "MacBook-Pro-de-Somebody.local" carries its
 *     owner's first name, and the user name rule does not see a name inside
 *     a word joined by dashes.
 * 14b. Over-correction: a short, generic machine name ("Mac" of "Mac.lan",
 *     measured on this machine) masks that word wherever it appears.
 */

const HOME = '/Users/somebody';
const FACTS: ReportFacts = {
  installId: '3b1f6c2e-5d7a-4e8b-9c0d-1a2b3c4d5e6f',
  release: 'tars@1.9.1',
  home: HOME,
  host: 'MacBook-Pro-de-Somebody.local',
  os: { name: 'macOS', version: '26.0' },
  electron: '44.4.4',
};
const PROMPT = 'please refactor the billing module for Acme Corp';
const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

function sdkEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'a'.repeat(32),
    timestamp: 1_790_000_000,
    platform: 'node',
    level: 'error',
    server_name: 'Somebodys-MacBook-Pro.local',
    environment: 'production',
    release: 'something-else',
    message: `console said ${PROMPT}`,
    logentry: { message: PROMPT },
    exception: {
      values: [{
        type: 'Error',
        value: `ENOENT: no such file ${HOME}/clients/acme/notes.md with ${KEY}`,
        module: `${HOME}/tars/electron/dist/services/x`,
        mechanism: { type: 'onuncaughtexception', handled: false, data: { secret: PROMPT } },
        stacktrace: {
          frames: [{
            filename: `file://${HOME}/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/main.js`,
            abs_path: `${HOME}/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/main.js`,
            module: 'main',
            function: 'startAgent',
            lineno: 42,
            colno: 7,
            in_app: true,
            context_line: `const prompt = "${PROMPT}";`,
            pre_context: [PROMPT],
            post_context: [PROMPT],
            vars: { prompt: PROMPT, token: KEY },
          }, {
            filename: '/private/var/folders/xy/T/tars-x/run.js',
            function: 'Object.<anonymous>',
            lineno: 1,
            colno: 1,
            in_app: false,
          }],
        },
      }],
    },
    breadcrumbs: [{ category: 'console', message: PROMPT }, { category: 'fetch', data: { url: `http://127.0.0.1:31415/api?token=${KEY}` } }],
    request: { url: 'app://-/chat', data: PROMPT, headers: { Authorization: `Bearer ${KEY}` }, cookies: { a: 'b' } },
    user: { id: 'demo', email: 'demo@example.com', ip_address: '10.0.0.2', username: 'somebody' },
    extra: { prompt: PROMPT },
    tags: { 'event.process': 'renderer', project: 'acme' },
    contexts: {
      device: { name: 'Somebodys-MacBook-Pro', model: 'Mac15,3' },
      culture: { timezone: 'Asia/Dubai' },
      app: { app_name: 'Tars', app_version: '1.9.1', app_memory: 1 },
      trace: { trace_id: 'b'.repeat(32) },
      conversation: { text: PROMPT },
    },
    modules: { 'some-module': '1.0.0' },
    debug_meta: { images: [{ code_file: `${HOME}/x` }] },
    sdkProcessingMetadata: { prompt: PROMPT },
    fingerprint: [PROMPT],
    ...overrides,
  };
}

describe('the report built from an event', () => {
  it('1, 2. writes the home folder as ~ and hides the secrets, in the message and in every frame', () => {
    const report = toReport(sdkEvent(), FACTS)!;
    const text = JSON.stringify(report);

    expect(text).not.toContain(HOME);
    expect(text).not.toContain('somebody');
    expect(text).not.toContain(KEY);
    expect(report.exception.values[0].value).toBe('ENOENT: no such file ~/clients/acme/notes.md with sk-a[redacted]6789');
    expect(report.exception.values[0].stacktrace!.frames[0].filename)
      .toBe('~/Applications/Tars.app/Contents/Resources/app.asar/electron/dist/main.js');
  });

  it.each([
    ['followed by a comma', `cwd ${HOME}, exit 1`, 'cwd ~, exit 1'],
    ['followed by a semicolon', `${HOME};rm`, '~;rm'],
    ['at the end', `in ${HOME}`, 'in ~'],
    ['in another case', `open /users/SOMEBODY/notes.md`, 'open ~/notes.md'],
    ['URL-encoded', `GET /file?p=%2FUsers%2Fsomebody%2Fnotes.md`, 'GET /file?p=~%2Fnotes.md'],
    ['URL-encoded in lower case', `p=%2fusers%2fsomebody%2fx`, 'p=~%2fx'],
    ['the user name at a host', `ssh somebody@Somebodys-Mac.local failed`, 'ssh <user>@Somebodys-Mac.local failed'],
  ])('11. takes the home folder out %s', (_what, value, expected) => {
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'Error', value }] } }), FACTS)!;
    expect(report.exception.values[0].value).toBe(expected);
  });

  it.each([
    ['12. behind /private', `open /private${HOME}/notes.md`, 'open ~/notes.md'],
    ['12. behind /private, in another case', `open /PRIVATE/users/somebody`, 'open ~'],
    ['13. URL-encoded twice', `GET /a?u=%2Fb%3Fp%3D%252FUsers%252Fsomebody%252Fnotes.md`, 'GET /a?u=%2Fb%3Fp%3D~%252Fnotes.md'],
    ['14. the machine\'s name', 'connect ECONNREFUSED MacBook-Pro-de-Somebody.local:5000', 'connect ECONNREFUSED <host>:5000'],
    ['14. the machine\'s short name, in another case', 'bonjour name macbook-pro-de-somebody, again', 'bonjour name <host>, again'],
  ])('takes the machine out: %s', (_what, value, expected) => {
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'Error', value }] } }), FACTS)!;
    expect(report.exception.values[0].value).toBe(expected);
  });

  it('14b. masks a generic machine name only whole', () => {
    const value = 'not on Mac OS, on Mac.lan';
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'Error', value }] } }), { ...FACTS, host: 'Mac.lan' })!;
    expect(report.exception.values[0].value).toBe('not on Mac OS, on <host>');
  });

  it('14. leaves a longer name that only starts like the machine\'s', () => {
    const value = 'MacBook-Pro-de-Somebody-2.local and MacBook-Pro';
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'Error', value }] } }), FACTS)!;
    expect(report.exception.values[0].value).toBe(value);
  });

  it('11. leaves a longer name that only starts like the home folder or the user', () => {
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'Error', value: '/Users/somebodyelse/x and somebodyelse' }] } }), FACTS)!;
    expect(report.exception.values[0].value).toBe('/Users/somebodyelse/x and somebodyelse');
  });

  it('1. writes a temp folder of this machine without its random part', () => {
    const report = toReport(sdkEvent(), FACTS)!;
    expect(report.exception.values[0].stacktrace!.frames[1].filename).toBe('<tmp>/tars-x/run.js');
  });

  it('3, 4. carries nothing but the fields it names, and no conversation anywhere', () => {
    const report = toReport(sdkEvent(), FACTS)!;
    const text = JSON.stringify(report);

    expect(Object.keys(report).sort()).toEqual(
      ['contexts', 'event_id', 'exception', 'level', 'platform', 'release', 'tags', 'timestamp', 'user'].sort());
    expect(report.contexts).toEqual({
      os: { name: 'macOS', version: '26.0' },
      runtime: { name: 'Electron', version: '44.4.4' },
    });
    expect(report.user).toEqual({ id: FACTS.installId });
    expect(report.tags).toEqual({ process: 'renderer' });
    expect(Object.keys(report.exception.values[0]).sort()).toEqual(['mechanism', 'stacktrace', 'type', 'value']);
    expect(report.exception.values[0].mechanism).toEqual({ type: 'onuncaughtexception', handled: false });
    expect(Object.keys(report.exception.values[0].stacktrace!.frames[0]).sort())
      .toEqual(['colno', 'filename', 'function', 'in_app', 'lineno']);
    for (const absent of [PROMPT, 'Acme Corp', 'demo@example.com', '10.0.0.2', 'MacBook', 'Asia/Dubai', 'some-module', 'Bearer', 'cookies']) {
      expect(text, absent).not.toContain(absent);
    }
  });

  it('4b. replaces quoted words in the message by their length, and keeps a quoted name', () => {
    const value = `Unexpected token in "${PROMPT}" after 'answer the user about their invoices', see \`${PROMPT}\`; `
      + `Cannot find module 'discord.js' for "agent:start" in “${PROMPT}”`;
    const report = toReport(sdkEvent({ exception: { values: [{ type: 'SyntaxError', value }] } }), FACTS)!;
    const out = report.exception.values[0].value!;

    expect(out).not.toContain('refactor');
    expect(out).not.toContain('invoices');
    expect(out).toContain(`"[${PROMPT.length} characters]"`);
    expect(out).toContain("'[36 characters]'");
    expect(out).toContain("Cannot find module 'discord.js' for \"agent:start\"");
  });

  it('5. is no report for an event without an exception', () => {
    expect(toReport(sdkEvent({ exception: undefined }), FACTS)).toBeNull();
    expect(toReport(sdkEvent({ exception: { values: [] } }), FACTS)).toBeNull();
    expect(toReport(sdkEvent({ type: 'transaction' }), FACTS)).toBeNull();
    expect(toReport(null, FACTS)).toBeNull();
    expect(toReport('an error', FACTS)).toBeNull();
  });

  it('6. cuts a huge message, keeps the last 50 frames, and at most 5 linked errors', () => {
    const frames = Array.from({ length: 200 }, (_, i) => ({ filename: 'app:///x.js', function: `f${i}`, lineno: i, colno: 1, in_app: true }));
    const values = Array.from({ length: 12 }, () => ({ type: 'Error', value: 'x'.repeat(10_000), stacktrace: { frames } }));
    const report = toReport(sdkEvent({ exception: { values } }), FACTS)!;

    expect(report.exception.values).toHaveLength(5);
    expect(report.exception.values[0].value!.length).toBeLessThanOrEqual(1_000);
    expect(report.exception.values[0].stacktrace!.frames).toHaveLength(50);
    // Sentry orders frames oldest first: the ones kept are those nearest the throw.
    expect(report.exception.values[0].stacktrace!.frames.at(-1)!.function).toBe('f199');
  });

  it('7. keeps what says where it broke', () => {
    const report = toReport(sdkEvent({ tags: {} }), FACTS)!;

    expect(report).toMatchObject({
      event_id: 'a'.repeat(32), level: 'error', platform: 'node', release: 'tars@1.9.1', tags: { process: 'main' },
    });
    expect(report.exception.values[0]).toMatchObject({ type: 'Error' });
    expect(report.exception.values[0].stacktrace!.frames[0]).toMatchObject({ function: 'startAgent', lineno: 42, colno: 7, in_app: true });
  });

  it('builds the same report from its own output, so the transport may shape it again', () => {
    const once = toReport(sdkEvent(), FACTS)!;
    expect(toReport(once, FACTS)).toEqual(once);
  });

  it('names the same error the same way, whatever its event id, time or process', () => {
    const a = toReport(sdkEvent(), FACTS)!;
    const b = toReport(sdkEvent({ event_id: 'c'.repeat(32), timestamp: 1_790_009_999, tags: {} }), FACTS)!;
    const other = toReport(sdkEvent({ exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] } }), FACTS)!;
    expect(reportFingerprint(a)).toBe(reportFingerprint(b));
    expect(reportFingerprint(a)).not.toBe(reportFingerprint(other));
  });
});

describe('the envelope handed to the network', () => {
  const header = { event_id: 'a'.repeat(32), sent_at: '2026-09-28T00:00:00.000Z', sdk: { name: 'sentry.javascript.electron', version: '7.20.0' }, trace: { trace_id: 'b'.repeat(32), public_key: 'k', release: 'x' } };

  it('10. keeps error events only, reshaped, and drops every other item', () => {
    const envelope = [header, [
      [{ type: 'event' }, sdkEvent()],
      [{ type: 'attachment', filename: 'screenshot.png' }, 'bytes'],
      [{ type: 'session' }, { sid: 'x' }],
      [{ type: 'replay_event' }, {}],
      [{ type: 'feedback' }, { message: PROMPT }],
      [{ type: 'client_report' }, {}],
      [{ type: 'log' }, { items: [{ body: PROMPT }] }],
      [{ type: 'span' }, {}],
    ]] as const;

    const kept = keepErrorsOnly(envelope as never, FACTS)!;

    expect(kept[0]).toEqual({ event_id: 'a'.repeat(32), sent_at: '2026-09-28T00:00:00.000Z', sdk: { name: 'sentry.javascript.electron', version: '7.20.0' } });
    expect(kept[1]).toHaveLength(1);
    expect(kept[1][0][0]).toEqual({ type: 'event' });
    expect(JSON.stringify(kept)).not.toContain(PROMPT);
    expect(JSON.stringify(kept)).not.toContain(HOME);
  });

  it('10. is nothing when no error event is in it', () => {
    expect(keepErrorsOnly([header, [[{ type: 'session' }, {}]]] as never, FACTS)).toBeNull();
    expect(keepErrorsOnly([header, [[{ type: 'event' }, sdkEvent({ exception: undefined })]]] as never, FACTS)).toBeNull();
  });
});

describe('how many reports leave', () => {
  let dir: string;
  let file: string;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-report-budget-'));
    file = path.join(dir, 'error-reports.json');
    now = Date.UTC(2026, 8, 28, 10, 0, 0);
  });

  it('8. sends the same error once a day', () => {
    const budget = new ReportBudget(file, clock);
    expect(budget.admit('fp-1')).toBe(true);
    expect(budget.admit('fp-1')).toBe(false);
    now += 23 * 3_600_000;
    expect(budget.admit('fp-1')).toBe(false);
    now += 2 * 3_600_000;
    expect(budget.admit('fp-1')).toBe(true);
  });

  it('8. sends at most 20 reports a day', () => {
    const budget = new ReportBudget(file, clock);
    const admitted = Array.from({ length: 30 }, (_, i) => budget.admit(`fp-${i}`)).filter(Boolean);
    expect(admitted).toHaveLength(20);
    now += 24 * 3_600_000;
    expect(budget.admit('fp-100')).toBe(true);
  });

  it('8. counts across a restart, with the same install id', () => {
    const first = new ReportBudget(file, clock);
    for (let i = 0; i < 20; i++) first.admit(`fp-${i}`);
    const id = first.installId;

    const again = new ReportBudget(file, clock);
    expect(again.admit('fp-new')).toBe(false);
    expect(again.admit('fp-0')).toBe(false);
    expect(again.installId).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('9. starts afresh from a corrupt or missing file, without throwing, and writes it for its user only', () => {
    fs.writeFileSync(file, '{ not json');
    const budget = new ReportBudget(file, clock);
    expect(budget.admit('fp-1')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).installId).toBe(budget.installId);
    if (hasPosixModes()) expect(fs.statSync(file).mode & 0o077).toBe(0);

    const inMissingDir = new ReportBudget(path.join(dir, 'gone', 'error-reports.json'), clock);
    expect(inMissingDir.admit('fp-1')).toBe(true);
  });
});
