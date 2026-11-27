import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scrubText, scrubValue, newMaskSession, maskCountsOf, MASK_TYPES, SCRUB_VERSION, type ScrubContext,
} from '../../electron/services/trace-scrub';
import { personNamesOf, usablePersonName } from '../../electron/services/trace-person-names';

/**
 * Masking personal data in a trace before it leaves the machine (trace feature B3, 27/11): e-mail addresses, IP
 * addresses, the names Tars knows, home paths and phone numbers become typed placeholders numbered per session,
 * `<EMAIL_n>`, `<IP_n>`, `<PERSON_n>`, `<HOME_n>`, `<PHONE_n>`, beside `<SECRET_n>` for what the secret rules catch
 * (trace-scrub.test.ts). The format is the trace reader's, pinned: same value, same number, everywhere in a session;
 * numbering starts again in each session; each session carries `maskingVersion` and `maskCounts`.
 *
 * The names Tars knows (trace-person-names.ts): the authors and committers of the project's git history, the
 * account's own name as git and the system have it (user.name, the full name, the login name). Not used: GitHub
 * handles, co-authors named in commit messages, names typed in chats or channels, agents' names, the Claude
 * accounts' labels, an address book (Tars has none).
 *
 * How it fails, written before the code:
 *
 * False negatives, personal data that passes:
 * N1. An e-mail address: plain, with a plus, dots or a subdomain, in capitals, with Unicode letters, in angle
 *     brackets, in a URL's user part, in a JSON string.
 * N2. An IP address: IPv4, public or private, with a port; IPv6 full, compressed, with a zone.
 * N3. A known name: a git author's or committer's, the account's own; in another case, with other spacing or a line
 *     break between its parts, decomposed (NFD, as macOS writes file names) or composed; a part of it alone (a given
 *     name, a family name).
 * N4. A home path: the account's own in each spelling (`/`, `\`, the doubled `\\` of a JSON string in a tool's
 *     output, another case); another user's on macOS, Linux or Windows; a Windows name with a space; a `file://`
 *     URL; a WSL path; a home outside the usual roots (a sandbox's).
 * N5. A phone number: international, with spaces, dashes, dots or parentheses, or none; North American, as
 *     (555) 123-4567 or 202-555-0123; national with a trunk 0 (06 12 34 56 78, 020 7946 0958); a bare national
 *     0612345678; in a tel: link.
 *
 * False positives, each must stay as it is:
 * P1. Timestamps: epoch seconds and milliseconds, ISO date-times, dates (2026-11-27, 27.11.2026), clock times.
 * P2. Ports and addresses that name nobody: :31415, localhost:3000, 127.0.0.1, 0.0.0.0, ::1, 255.255.255.255.
 * P3. Versions: 1.2.3, v1.2.3.4, version 10.0.19045.1, 120.0.6099.109, node@22.12.0, a build 10.0.26100.
 * P4. Hashes and ids: a git sha, a sha256, a uuid, t-a4c75e35, tr_ ids, #664, a numeric id in a URL path, a long
 *     digit run in an id (id=1732700000123).
 * P5. Numbers: counts written with spaces or commas (12 345 678, 1,234,567.89), decimals, token counts, a diff stat.
 * P6. Code: std::vector, a::b, @Component, @types/node, a git remote git@host:org/repo.git, a folder called Users
 *     inside a project (src/components/Users/List.tsx), /Users/Shared, C:\Users\Public, ~, $HOME, a MAC address.
 * P7. Names: a word that is no known name; a known name inside a longer word (Adaline for Ada); a bot's or a
 *     service's name in the history (dependabot[bot], GitHub); a name too short to tell from a word.
 *
 * Overlaps:
 * O1. A secret holding an e-mail, an IP or a phone number is one `<SECRET_n>`, never cut in parts; a .env value that
 *     is an e-mail is a secret; a URL's password is a secret and its user part an e-mail only with a domain.
 * O2. A placeholder is never masked again: `<SECRET_1>` holds a digit, `<PHONE_2>` a name-like word.
 * O3. A home path holding the login name is one `<HOME_n>`, not a home with a `<PERSON_n>` in it; an e-mail holding
 *     a known name is one `<EMAIL_n>`.
 *
 * Numbering:
 * U1. The same value gets two numbers within a session, or two values one number; numbers do not start at 1.
 * U2. A number reused across sessions: a second session goes on from the first's numbers, which links them.
 * U3. Spellings of one value take two numbers: an e-mail's case, a phone's separators, a home's slashes and case.
 *
 * Split values:
 * S1. A value split across chunks: a streamed answer is stored whole (trace-store.ts), so it is masked whole; a
 *     session sent in several batches carries the same numbers in each (trace-upload.test.ts, 42).
 * S2. Not caught, and said in the notice: a value cut across two strings (two messages, two parts of one), encoded
 *     (base64, URL-encoded), or in an image; full-width digits; a name Tars does not know; a home written ~alice.
 *
 * Unicode:
 * X1. A name next to an accented letter is cut (JavaScript's \b knows ASCII only); an e-mail with Unicode letters is
 *     missed; NFD and NFC spellings of one name differ.
 *
 * The report:
 * R1. maskCounts lacks a type or counts values rather than placeholders inserted; the version is not a string.
 *
 * Added before their code, after the Audit's NO-MERGE at 38ccde8cb (27/11):
 * T1. (M1.) The names take time with their number: one pattern of 2000 names over a 1 MB session took 10.9 s (5.7 s
 *     at 1500), as the Audit measured, and the upload builds every session that way.
 * C1. (M3.) Another person's name is masked by its parts, so a word that is also a given or a family name goes:
 *     "Will this compile?", "Mark as done.", a class Price. Only the account's own name is masked by its parts (and
 *     its login as written); anyone else's whole only, as "First Last" or "Last, First", both under one number; a
 *     name of one word that is not the account's is not masked. The account's own name stays its own when the git
 *     history has it too.
 * H1. (L1.) A home path in a JSON string written with escaped slashes (`\/Users\/name\/`) passes, or takes another
 *     number than the same home written plainly.
 * I1. (L1.) An IPv4-mapped IPv6 address (::ffff:192.0.2.128) is masked in two pieces, its IPv4 tail left or cut.
 * F1. (L2.) A version or a word taken for an address or a phone number: 1.0.0.0, "build 0612345678", a word pair in
 *     hex letters (add::bad, dead::beef), a package spec's version (@scope/tool@1.0.0.1, vendor/lib@1.2.3.4).
 * F2. (The Audit's NO-MERGE at 46d1a56dd.) An address after a user's name passes: deploy@10.0.0.5,
 *     deploy@10.20.30.40, git@10.1.2.3:team/app.git (a private network's plan is what the masking is for). After `@`
 *     only a package spec's left side is a version: it starts with `@`, or holds a `/` with no `:` after the address.
 *     So pkg@1.2.3.4 is masked: a bare name cannot be told from a user's, and npm's versions have three parts.
 * The numbering kept from one build of a session to the next (M2) is trace-upload.test.ts's 46.
 */

const HOME = '/Users/someone';
const ctx = (over: Partial<ScrubContext> = {}): ScrubContext => ({ homeDirs: [HOME], knownSecrets: [], envValues: [], personNames: [], ...over });
/** One session's scrub of each value in turn: the numbering is shared, as in one session's upload. */
const session = (c: ScrubContext = ctx()) => {
  const counts: Record<string, number> = {};
  const s = newMaskSession();
  return { text: (t: string) => scrubText(t, c, counts, s), value: (v: unknown) => scrubValue(v, c, counts, s), counts };
};
const one = (t: string, c: ScrubContext = ctx()) => session(c).text(t);

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('masking personal data', () => {
  it('N1: e-mail addresses go', () => {
    expect(one('write to ada.quill+tars@mail.example.co.uk today')).toBe('write to <EMAIL_1> today');
    expect(one('From: Someone <SOMEONE@EXAMPLE.ORG>')).toBe('From: Someone <<EMAIL_1>>');
    expect(one('{"author":"bram@sub.example.net"}')).toBe('{"author":"<EMAIL_1>"}');
    expect(one('contact josé.müller@exemple.fr, then')).toBe('contact <EMAIL_1>, then');
    expect(one('https://cleo@host.example.com/repo')).toBe('https://<EMAIL_1>/repo');
  });

  it('N2: IP addresses go, IPv4 and IPv6', () => {
    expect(one('ssh into 203.0.113.42 and 192.168.1.20:8080')).toBe('ssh into <IP_1> and <IP_2>:8080');
    expect(one('peer 10.0.0.7, host 100.64.12.9')).toBe('peer <IP_1>, host <IP_2>');
    expect(one('v6 2001:db8:85a3:0:0:8a2e:370:7334 and fe80::1ff:fe23:4567:890a%en0 and 2001:db8::1')).toBe('v6 <IP_1> and <IP_2> and <IP_3>');
  });

  it('N3: the names Tars knows go, in any case, spacing or Unicode form, whole, and the account\'s own by part', () => {
    const c = ctx({ personNames: ['Ada Quill', 'José Müller'], ownNames: ['Bram Okafor'] });
    const s = session(c);
    expect(s.text('Ada Quill wrote it; ada  quill\nreviewed; ADA QUILL merged')).toBe('<PERSON_1> wrote it; <PERSON_1>\nreviewed; <PERSON_1> merged');
    // NFD, as macOS writes a file name, and NFC, as a commit's author is typed.
    expect(s.text('by José Müller and by José Müller'.normalize('NFD'))).toBe('by <PERSON_2> and by <PERSON_2>');
    expect(s.text('by José Müller')).toBe('by <PERSON_2>');
    // A part alone of the account's own name: the given name, the family name.
    expect(s.text('ask Bram, or Okafor')).toBe('ask <PERSON_3>, or <PERSON_4>');
    expect(s.counts.person).toBe(8);
  });

  it('N4: home paths go, the account\'s own and anyone else\'s, on every system', () => {
    const s = session(ctx({ homeDirs: ['/Users/someone', 'C:\\Users\\someone', 'C:/Users/someone'] }));
    expect(s.text('/Users/someone/projects/a and /Users/someone')).toBe('<HOME_1>/projects/a and <HOME_1>');
    expect(s.text('C:\\Users\\someone\\code and C:/Users/someone/code')).toBe('<HOME_2>\\code and <HOME_2>/code');
    expect(s.text('"C:\\\\Users\\\\someone\\\\x"')).toBe('"<HOME_2>\\\\x"');
    expect(s.text('/users/someone/x')).toBe('<HOME_1>/x');
    expect(s.text('then /Users/ada/notes, /home/bram/src and D:\\Users\\Jo Smith\\Desktop')).toBe('then <HOME_3>/notes, <HOME_4>/src and <HOME_5>\\Desktop');
    expect(s.text('file:///Users/ada/notes.md and /mnt/c/Users/ada/x')).toBe('file://<HOME_3>/notes.md and /mnt/c<HOME_3>/x');
    expect(one('/tmp/dorothy-e2e-abc/.tars and /tmp/dorothy-e2e-abcd', ctx({ homeDirs: ['/tmp/dorothy-e2e-abc'] }))).toBe('<HOME_1>/.tars and /tmp/dorothy-e2e-abcd');
  });

  it('N5: phone numbers go, in the forms people write them', () => {
    const s = session();
    expect(s.text('call +33 6 12 34 56 78 or +33612345678')).toBe('call <PHONE_1> or <PHONE_1>');
    expect(s.text('US: +1 (555) 201-4567, (555) 201-4567, 202-555-0123, 202.555.0123')).toBe('US: <PHONE_2>, <PHONE_3>, <PHONE_4>, <PHONE_4>');
    expect(s.text('FR 06 12 34 56 78, 06.12.34.56.78, 0612345678; UK 020 7946 0958, +44 20 7946 0958')).toBe('FR <PHONE_5>, <PHONE_5>, <PHONE_5>; UK <PHONE_6>, <PHONE_7>');
    expect(s.text('<a href="tel:+441632960961">phone</a>')).toBe('<a href="tel:<PHONE_8>">phone</a>');
  });

  it('P1 to P7: what names nobody stays as it is', () => {
    const c = ctx({ personNames: ['Ada Quill', 'dependabot[bot]', 'GitHub', 'Al'] });
    const kept = [
      // P1 timestamps
      'at 1732700000 or 1732700000123 ms', '2026-11-27T12:34:56.789Z', 'on 2026-11-27 and 27.11.2026 and 11/27/2026', 'at 12:34:56', 'took 00:01:02.345',
      // P2 ports and addresses that name nobody
      'on :31415 and localhost:3000', 'http://127.0.0.1:31415/api', 'bind 0.0.0.0:8080', 'loopback ::1', 'mask 255.255.255.255',
      // P3 versions
      'version 1.2.3', 'v1.2.3.4', 'version 10.0.19045.1', 'Chrome 120.0.6099.109', 'node@22.12.0 and react@19.0.0', 'build 10.0.26100',
      // P4 hashes and ids
      'sha 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b', 'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'id 0f8fad5b-d9cb-469f-a165-70867728950e', 'task t-a4c75e35 and tr_mif0a1b2c3d4e5f6a7b8', 'PR #664', 'GET /api/items/0612345678',
      'id=1732700000123', 'uuid 550e8400-e29b-41d4-a716-446655440000',
      // P5 numbers
      '12 345 678 tokens', '1,234,567.89 USD', 'pi 3.14159265358979', '+1234 -567 lines', 'cost 0.0612345678 USD',
      // P6 code
      'std::vector<int> and a::b', '@Component and @types/node', 'git@github.com:org/repo.git', 'src/components/Users/List.tsx',
      '/Users/Shared/file and C:\\Users\\Public\\x', '~/projects and $HOME/x', 'mac aa:bb:cc:dd:ee:ff',
      // P7 names
      'Adaline wrote a quilled note', 'dependabot[bot] bumped it; GitHub merged it', 'Al said so',
    ];
    for (const t of kept) expect(one(t, c), t).toBe(t);
  });

  it('O1: a secret holding personal data is one secret; a URL\'s password is a secret', () => {
    const s = session(ctx({ knownSecrets: ['ada@mail.example.com:203.0.113.9'], envValues: ['owner@corp.example.com'] }));
    expect(s.text('creds ada@mail.example.com:203.0.113.9 and owner@corp.example.com')).toBe('creds <SECRET_1> and <SECRET_2>');
    expect(s.text('git clone https://ada:s3cr3tpass@host.example.com/r.git')).toBe('git clone https://ada:<SECRET_3>@host.example.com/r.git');
    expect(s.text('password=+33612345678')).toBe('password=<SECRET_4>');
  });

  it('O2 and O3: a placeholder is never masked again; one path or address is one placeholder', () => {
    const c = ctx({ personNames: ['Secret Phone'], ownNames: ['someone'], knownSecrets: ['plainword9secret'] });
    const s = session(c);
    expect(s.text('plainword9secret then <PHONE_2> as text')).toBe('<SECRET_1> then <PHONE_2> as text');
    expect(s.text('/Users/someone/x and someone@example.com and someone')).toBe('<HOME_1>/x and <EMAIL_1> and <PERSON_1>');
    // A key by its shape after a telling name: one secret under one number, the name rule not masking the placeholder
    // again (found by the mutation bench: no test had a rule meet a placeholder an earlier rule wrote).
    const key = `sk-proj-${'a1B2c3D4e5F6g7H8i9J0k1L2'}`;
    expect(one(`export API_KEY=${key} and again ${key}`)).toBe('export API_KEY=<SECRET_1> and again <SECRET_1>');
  });

  it('U1 and U3: one value, one number, in every spelling; another value, another number', () => {
    const s = session();
    expect(s.text('a@example.com, B@example.com, A@EXAMPLE.COM')).toBe('<EMAIL_1>, <EMAIL_2>, <EMAIL_1>');
    expect(s.text('+33 6 12 34 56 78 / +33-6-12-34-56-78 / +33.6.12.34.56.78')).toBe('<PHONE_1> / <PHONE_1> / <PHONE_1>');
    expect(s.text('/Users/ada/x C:\\Users\\Ada\\y C:/Users/ada/z')).toBe('<HOME_1>/x <HOME_2>\\y <HOME_2>/z');
    expect(s.value({ to: 'a@example.com', cc: ['c@example.com', 'a@example.com'] })).toEqual({ to: '<EMAIL_1>', cc: ['<EMAIL_3>', '<EMAIL_1>'] });
  });

  it('U2: numbering starts again in each session, and says nothing across them', () => {
    const first = session();
    expect(first.text('a@example.com b@example.com')).toBe('<EMAIL_1> <EMAIL_2>');
    const second = session();
    expect(second.text('b@example.com c@example.com')).toBe('<EMAIL_1> <EMAIL_2>');
    // With no session given, each call is a session of its own.
    expect(scrubText('b@example.com', ctx(), {})).toBe('<EMAIL_1>');
  });

  it('X1: Unicode around a name, in an address, and in its two normal forms', () => {
    const c = ctx({ ownNames: ['Zoë Ødegård'] });
    expect(one('«Zoë Ødegård» écrit; Zoë, Ødegård', c)).toBe('«<PERSON_1>» écrit; <PERSON_2>, <PERSON_3>');
    expect(one('éZoë is a word', c)).toBe('éZoë is a word');
    expect(one('Zoë Ødegård'.normalize('NFD'), c)).toBe('<PERSON_1>');
  });

  it('S2: what it cannot catch stays, as the notice says', () => {
    // A value cut across two strings, encoded, or a name Tars does not know.
    expect(scrubValue(['ada@', 'example.com'], ctx(), {})).toEqual(['ada@', 'example.com']);
    expect(one('ada%40example.com and YWRhQGV4YW1wbGUuY29t')).toBe('ada%40example.com and YWRhQGV4YW1wbGUuY29t');
    expect(one('Unknown Person wrote it', ctx({ personNames: ['Ada Quill'] }))).toBe('Unknown Person wrote it');
  });

  it('T1: 2000 names over a 1 MB session take well under a second and a half', () => {
    const letters = (i: number) => [0, 1, 2].map(k => String.fromCharCode(97 + Math.floor(i / 26 ** k) % 26)).join('');
    const names = Array.from({ length: 2000 }, (_, i) => `Fn${letters(i)} Ln${letters(i)}`);
    const filler = 'the build ran, the tests passed and the module was merged into the branch after review. ';
    let text = '';
    for (let i = 0; text.length < 1024 * 1024; i++) text += `${filler.repeat(24)}${names[(i * 37) % names.length]} wrote it. `;
    const c = ctx({ personNames: names });
    const t0 = performance.now();
    const out = one(text, c);
    const ms = performance.now() - t0;
    expect(out).not.toMatch(/Fn[a-z]{3} Ln[a-z]{3}/);
    expect(out).toContain('<PERSON_1> wrote it.');
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(1500);
  }, 120_000);

  it('C1: another person\'s name goes whole only, as First Last or Last, First; the account\'s own by its parts too', () => {
    const s = session(ctx({ personNames: ['Will Pruitt', 'Mark Price', 'Solo'], ownNames: ['Cleo Marsh', 'cleom'] }));
    expect(s.text('Will this compile? Mark as done.')).toBe('Will this compile? Mark as done.');
    expect(s.text('class Price { static of(n) {} } then Price.of(1); Solo mode')).toBe('class Price { static of(n) {} } then Price.of(1); Solo mode');
    expect(s.text('Will Pruitt reviewed; Pruitt, Will merged; Price, Mark approved')).toBe('<PERSON_1> reviewed; <PERSON_1> merged; <PERSON_2> approved');
    expect(s.text('Cleo Marsh wrote; Marsh, Cleo signed; cleom and Cleo alone')).toBe('<PERSON_3> wrote; <PERSON_3> signed; <PERSON_4> and <PERSON_5> alone');
  });

  it('H1 and I1: a home in a JSON string with escaped slashes; an IPv4-mapped IPv6 address, whole', () => {
    const s = session();
    expect(s.text('{"cwd":"\\/Users\\/someonex\\/proj","home":"\\/home\\/bram\\/x"}')).toBe('{"cwd":"<HOME_1>\\/proj","home":"<HOME_2>\\/x"}');
    // The account's own, escaped, is the same home as written plainly.
    expect(s.text('/Users/someone/a and \\/Users\\/someone\\/b')).toBe('<HOME_3>/a and <HOME_3>\\/b');
    expect(s.text('from ::ffff:192.0.2.128 and ::FFFF:192.0.2.128, then 192.0.2.128')).toBe('from <IP_1> and <IP_1>, then <IP_2>');
  });

  it('F1: versions and words read as addresses or phone numbers stay', () => {
    for (const t of ['release 1.0.0.0 and 2.0.0.0', '@scope/tool@1.0.0.1 and @scope/lib@10.20.30.40, vendor/lib@1.2.3.4',
      'build 0612345678, Build 0612345678, version 0612345678', 'add::bad and dead::beef']) {
      expect(one(t), t).toBe(t);
    }
    expect(one('ssh root@203.0.113.5, then 10.1.0.0 and 172.16.0.1; call 0612345678')).toBe('ssh root@<IP_1>, then <IP_2> and <IP_3>; call <PHONE_1>');
  });

  it('F2: an address after a user\'s name goes, on a private network too; only a package spec\'s version stays', () => {
    const s = session();
    expect(s.text('ssh deploy@10.0.0.5 and ssh deploy@10.20.30.40')).toBe('ssh deploy@<IP_1> and ssh deploy@<IP_2>');
    expect(s.text('git clone git@10.1.2.3:team/app.git')).toBe('git clone git@<IP_3>:team/app.git');
    expect(s.text('pkg@1.2.3.4 and user@10.0.0.5')).toBe('pkg@<IP_4> and user@<IP_1>');
    // A left side with a / and a : after the address is a user's host, not a package spec.
    expect(s.text('scp ./dist/app@10.9.8.7:/srv')).toBe('scp ./dist/app@<IP_5>:/srv');
  });

  it('R1: the counts are placeholders inserted, by type, every type present, and the version is named', () => {
    const s = session(ctx({ personNames: ['Ada Quill'], knownSecrets: ['plainword9secret'] }));
    s.text('Ada Quill <ada@example.com> on 203.0.113.9, +33 6 12 34 56 78, /Users/someone/x, plainword9secret, ada@example.com');
    expect(maskCountsOf(s.counts)).toEqual({ SECRET: 1, EMAIL: 2, IP: 1, PERSON: 1, HOME: 1, PHONE: 1 });
    expect(maskCountsOf({})).toEqual({ SECRET: 0, EMAIL: 0, IP: 0, PERSON: 0, HOME: 0, PHONE: 0 });
    expect([...MASK_TYPES]).toEqual(['SECRET', 'EMAIL', 'IP', 'PERSON', 'HOME', 'PHONE']);
    expect(typeof SCRUB_VERSION).toBe('string');
    expect(SCRUB_VERSION).not.toBe('tars-scrub-1');
  });
});

describe('the names Tars knows', () => {
  const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  it('N3, P7: the authors and committers of the project\'s history, bots and services left out', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-names-'));
    git(dir, ['init', '-q']);
    const commit = (file: string, author: string, committer: string) => {
      fs.writeFileSync(path.join(dir!, file), file);
      git(dir!, ['add', file]);
      git(dir!, ['commit', '-q', '-m', file], {
        GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: committer, GIT_COMMITTER_EMAIL: 'c@example.invalid',
      });
    };
    commit('a', 'Ada Quill', 'Bram Okafor');
    commit('b', 'dependabot[bot]', 'GitHub');
    commit('c', 'José Müller', 'Ada Quill');
    const names = await personNamesOf(dir, { login: () => undefined, fullName: async () => undefined });
    expect([...names.others].sort()).toEqual(['Ada Quill', 'Bram Okafor', 'José Müller']);
    expect(names.own).toEqual([]);
    // C1: the account's own name is its own, even when the history has it too.
    const mine = await personNamesOf(dir, { login: () => undefined, fullName: async () => 'Ada Quill' });
    expect(mine.own).toEqual(['Ada Quill']);
    expect([...mine.others].sort()).toEqual(['Bram Okafor', 'José Müller']);
  });

  it('N3: the account\'s own name, as git and the system have it; a folder that is no repository gives none of git\'s', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-names-'));
    const names = await personNamesOf(dir, { login: () => 'cleom', fullName: async () => 'Cleo Marsh' });
    expect([...names.own].sort()).toEqual(['Cleo Marsh', 'cleom']);
    expect(names.others).toEqual([]);
  });

  it('P7: a name is used only when it can be told from a word', () => {
    for (const ok of ['Ada Quill', 'cleom', 'Zoë Ødegård', 'Bram']) expect(usablePersonName(ok), ok).toBe(true);
    for (const no of ['', 'Al', 'GitHub', 'github-actions[bot]', 'Renovate Bot', 'root', 'admin', 'user', 'runner', 'ubuntu', '12345', 'a@b.co', 'Claude', 'Unknown']) {
      expect(usablePersonName(no), no).toBe(false);
    }
  });
});
