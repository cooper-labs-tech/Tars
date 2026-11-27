import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

/**
 * Scrubbing a trace before it leaves the machine (native traces, the upload to a back-office). Every string of a
 * session, in its messages, system prompts, tool sets and params, goes through scrubText; keys, numbers, booleans and
 * the structure stay.
 *
 * What is replaced becomes a typed placeholder numbered per session, in the trace reader's pinned format (trace
 * feature B3, 27/11): `<SECRET_n>`, `<HOME_n>`, `<EMAIL_n>`, `<IP_n>`, `<PHONE_n>`, `<PERSON_n>`. The same value takes
 * the same number everywhere in a session (a MaskSession, one per session's upload), and numbering starts again in
 * each session, so a number links nothing across sessions. A placeholder is never masked again. What was replaced is
 * counted by kind (the window's preview) and by type (`maskCounts`, sent with each session with `maskingVersion`).
 *
 * The secrets, in this order, each a `<SECRET_n>`:
 * 1. `known_secret`: the exact values Tars holds as secrets (the settings' keys, the endpoints' keys, its own tokens),
 *    8 characters or more, whatever their shape.
 * 2. `env_value`: the exact values of the project's .env-like files (`.env`, `.env.*` but examples, samples and
 *    templates), 8 characters or more, mixing two of digits, capitals and small letters (so a hostname or a word
 *    is left alone, and so is a secret of small letters only).
 * 3. `private_key`: PEM private key blocks.
 * 4. Keys by shape: `openai_key`, `anthropic_key`, `github_token`, `slack_token`, `aws_access_key`, `google_key`,
 *    `stripe_key`, `npm_token`, `huggingface_token`, `jwt`, `tars_token` (the endpoint and reader tokens).
 * 5. `url_password`: the password in `scheme://user:password@host`.
 * 6. `bearer`: the credential after `Bearer` or `Basic`.
 * 7. `named_secret`: a value 6 characters or more after a name that says it is one (key, secret, token, password,
 *    passwd, pwd, credential, private key, access key, auth) and `=` or `:`, quoted or not, the name kept; and an
 *    object property so named.
 *
 * Then personal data, in this order, so a home path holding a login name is one `<HOME_n>` and an e-mail holding a
 * name one `<EMAIL_n>`:
 * 8. `home`: a home path, up to and with the user's name: the account's own in each spelling given (only that folder,
 *    not one whose name merely starts alike), and anyone's under /Users, /home or a drive's \Users (a Windows name
 *    with a space when a separator follows it), not /Users/Shared or \Users\Public and their kin.
 * 9. `email`: an address with a dotted domain, Unicode letters included; not `git@host:` (a git remote over ssh).
 * 10. `ip`: IPv4 and IPv6 addresses, not the loopback, unspecified or broadcast ones, nor a four-part version written
 *     after v, version or build.
 * 11. `phone`: a number as people write one: international (+, 8 to 15 digits), North American ((555) 201-4567,
 *     202-555-0123), national with a trunk 0 and one separator throughout (06 12 34 56 78, 020 7946 0958), or a bare
 *     national 0612345678. Never a timestamp, a port, a version, a hash, an id or a count (the false positives
 *     trace-scrub-personal.test.ts lists).
 * 12. `person`: the names Tars knows (trace-person-names.ts): a whole name in any case and spacing, and each part of
 *     three letters or more as written; in NFC and NFD; never inside a longer word.
 *
 * What it cannot catch: a secret with no known shape, no telling name and not held by Tars or a .env file (a password
 * in prose, a key in a YAML file under an innocent name); a secret shorter than its rule's floor; a secret or personal
 * data cut across two strings, encoded (base64, hex, URL-encoded) or inside an image; a name Tars does not know; a
 * phone number written another way, or in full-width digits; a home written ~name. And it applies to what is
 * uploaded only: the endpoint the agent talked to, and the local store, saw the session as it was.
 */

/** The rules' version, sent with each session as its `maskingVersion`. */
export const SCRUB_VERSION = 'tars-scrub-2';

export interface ScrubContext {
  /** The user's home folder, in every spelling it may appear in (a Windows home with \\ and with /). */
  homeDirs: string[];
  knownSecrets: string[];
  envValues: string[];
  /** The names Tars knows for the session's project (trace-person-names.ts); none when not given. */
  personNames?: string[];
}

/** The placeholder types, in the order of `maskCounts`. */
export const MASK_TYPES = ['SECRET', 'EMAIL', 'IP', 'PERSON', 'HOME', 'PHONE'] as const;
export type MaskType = typeof MASK_TYPES[number];

/** One session's numbering: per type, each value's number, in the order the values were met. */
export interface MaskSession { numbers: Map<MaskType, Map<string, number>> }

export function newMaskSession(): MaskSession {
  return { numbers: new Map() };
}

/** The kinds counted, by the type of their placeholder: every secret rule's kind is a SECRET. */
const TYPE_OF_KIND: Record<string, MaskType> = { email: 'EMAIL', ip: 'IP', person: 'PERSON', home: 'HOME', phone: 'PHONE' };

/** The counts by kind, as `maskCounts`: placeholders inserted, by type, every type present. */
export function maskCountsOf(counts: Record<string, number>): Record<MaskType, number> {
  const out = Object.fromEntries(MASK_TYPES.map(t => [t, 0])) as Record<MaskType, number>;
  for (const [kind, n] of Object.entries(counts)) out[TYPE_OF_KIND[kind] ?? 'SECRET'] += n;
  return out;
}

const SHAPES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, 'private_key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic_key'],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, 'openai_key'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'github_token'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'github_token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'slack_token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'aws_access_key'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'google_key'],
  [/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, 'stripe_key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm_token'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'huggingface_token'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt'],
  [/\b(?:tep|trd)_[0-9a-f]{40,}/g, 'tars_token'],
];

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|credential|private[_-]?key|access[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]*';
const NAMED = new RegExp(`(\\b${SECRET_NAME}"?\\s*[:=]\\s*)(["']?)([^\\s"',;}]{6,})\\2`, 'gi');
const NAME_ONLY = new RegExp(`^${SECRET_NAME}$`, 'i');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A placeholder this scrubber writes: never masked again, whatever a later rule would read in it. */
const PLACEHOLDER = /<(?:SECRET|EMAIL|IP|PERSON|HOME|PHONE)_\d+>/g;
const IS_PLACEHOLDER = /^<(?:SECRET|EMAIL|IP|PERSON|HOME|PHONE)_\d+>$/;

/** `fn` on the text between placeholders only. */
function outside(text: string, fn: (part: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** The placeholder of a value in this session: its number if it was met, else the next. Counted under its kind. */
function placeholder(type: MaskType, key: string, kind: string, session: MaskSession, counts: Record<string, number>): string {
  let numbers = session.numbers.get(type);
  if (!numbers) { numbers = new Map(); session.numbers.set(type, numbers); }
  let n = numbers.get(key);
  if (n === undefined) { n = numbers.size + 1; numbers.set(key, n); }
  counts[kind] = (counts[kind] ?? 0) + 1;
  return `<${type}_${n}>`;
}

function replaceShape(text: string, re: RegExp, kind: string, session: MaskSession, counts: Record<string, number>): string {
  return outside(text, part => part.replace(re, m => placeholder('SECRET', m, kind, session, counts)));
}

function replaceExact(text: string, values: string[], kind: string, session: MaskSession, counts: Record<string, number>): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    if (!v || !out.includes(v)) continue;
    out = outside(out, (part) => {
      const pieces = part.split(v);
      return pieces.reduce((acc, piece, i) => (i === 0 ? piece : acc + placeholder('SECRET', v, kind, session, counts) + piece), '');
    });
  }
  return out;
}

// ── Personal data ─────────────────────────────────────────────────────────────

/** A stretch of one string to mask: where, the value's key in the session's numbering, its kind and type. */
interface Span { start: number; end: number; key: string; kind: string; type: MaskType }
type Finder = (part: string) => Span[];

/** Every span the finders give, the first and then the longest kept where two overlap, each replaced in order. */
function maskSpans(text: string, finders: Finder[], session: MaskSession, counts: Record<string, number>): string {
  return outside(text, (part) => {
    if (!part) return part;
    const spans = finders.flatMap(f => f(part)).sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    let out = '';
    let at = 0;
    for (const s of spans) {
      if (s.start < at || s.end <= s.start) continue;
      out += part.slice(at, s.start) + placeholder(s.type, s.key, s.kind, session, counts);
      at = s.end;
    }
    return out + part.slice(at);
  });
}

function spansOf(re: RegExp, part: string, take: (m: RegExpMatchArray) => { start?: number; end?: number; key: string } | null, kind: string, type: MaskType): Span[] {
  const out: Span[] = [];
  for (const m of part.matchAll(re)) {
    const t = take(m);
    if (t) out.push({ start: t.start ?? m.index!, end: t.end ?? m.index! + m[0].length, key: t.key, kind, type });
  }
  return out;
}

/** A home's key: one home in every spelling (slashes, doubled backslashes, case). */
const homeKey = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase();
/** Folders under Users or home that hold no person's name. */
const NOT_A_PERSON_HOME = /^(?:shared|public|default|default user|all users|guest|\$.*|%.*|\{.*)$/i;
const HOME_NAME = '[^\\\\/\\s"\'<>:|?*,;()\\[\\]{}\\x00-\\x1f]+';
/** A drive's Users folder: a name with spaces only when a separator follows it. */
const WIN_HOME = new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]+Users[\\\\/]+(${HOME_NAME}(?: ${HOME_NAME})*(?=[\\\\/])|${HOME_NAME})`, 'gi');
/** /Users and /home at a path's root (after a WSL drive, the Data volume or /var too), never inside another folder. */
const UNIX_HOME = new RegExp(`(?:(?<=/mnt/[a-z])|(?<=/Volumes/Data)|(?<=/var)|(?<![\\w.~\\-]))/(?:Users|home)/(${HOME_NAME})`, 'gi');

function homeFinders(ctx: ScrubContext): Finder[] {
  const exact = [...new Set(ctx.homeDirs.filter(h => typeof h === 'string' && h.length > 1))].sort((a, b) => b.length - a.length)
    .map(home => new RegExp(`${escapeRe(home)}(?=$|[\\\\/\\s"'):;,\\]}])`, 'g'));
  // A name's trailing dots end a sentence, not the name.
  const named = (m: RegExpMatchArray) => {
    const name = m[1].replace(/\.+$/, '');
    if (!name || NOT_A_PERSON_HOME.test(name)) return null;
    const end = m.index! + m[0].length - (m[1].length - name.length);
    return { end, key: homeKey(m[0].slice(0, m[0].length - (m[1].length - name.length))) };
  };
  return [
    part => exact.flatMap(re => spansOf(re, part, m => ({ key: homeKey(m[0]) }), 'home', 'HOME')),
    part => spansOf(WIN_HOME, part, named, 'home', 'HOME'),
    part => spansOf(UNIX_HOME, part, named, 'home', 'HOME'),
  ];
}

const EMAIL = /(?<![\p{L}\p{N}._%+\-])([\p{L}\p{N}._%+\-]+)@((?:[\p{L}\p{N}](?:[\p{L}\p{N}\-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,})(?![\p{L}\p{N}\-])/gu;
const emailFinder: Finder = part => spansOf(EMAIL, part, (m) => {
  // git@host:org/repo is a remote over ssh, no person's address.
  if (m[1] === 'git' && part[m.index! + m[0].length] === ':') return null;
  return { key: m[0].normalize('NFC').toLowerCase() };
}, 'email', 'EMAIL');

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.\\-])(?<!\\b(?:v|version|ver|build)\\s?)${OCTET}(?:\\.${OCTET}){3}(?![\\w\\-]|\\.\\d)`, 'gi');
const IPV6 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[\w.]+)?(?![\w:])/gi;
const ipFinders: Finder[] = [
  part => spansOf(IPV4, part, (m) => (/^127\./.test(m[0]) || m[0] === '0.0.0.0' || m[0] === '255.255.255.255' ? null : { key: m[0] }), 'ip', 'IP'),
  part => spansOf(IPV6, part, (m) => {
    const addr = m[0].split('%')[0];
    if (!net.isIPv6(addr) || addr === '::1' || addr === '::') return null;
    // Not a::b in code: three groups or more, or one of three digits or more.
    const groups = addr.split(':').filter(Boolean);
    if (groups.length < 3 && !groups.some(g => g.length >= 3)) return null;
    return { key: addr.toLowerCase() };
  }, 'ip', 'IP'),
];

/** Before a phone number: not a word, a decimal, a sign, a path, an anchor, an address or an id going on. */
const PHONE_BEFORE = '(?<![\\w.+/#@\\-])';
const PHONE_AFTER = '(?![\\w\\-]|\\.\\d)';
const PHONE_SEP = '[ .\\-\\u00a0]';
const PHONE_INTL = new RegExp(`${PHONE_BEFORE}\\+\\d{1,3}(?:${PHONE_SEP}?(?:\\(\\d{1,4}\\)|\\d{1,5})){1,6}${PHONE_AFTER}`, 'g');
const PHONE_NANP = new RegExp(`${PHONE_BEFORE}(?:\\([2-9]\\d{2}\\)[ \\u00a0]?\\d{3}[ .\\-]\\d{4}|[2-9]\\d{2}([.\\-])\\d{3}\\1\\d{4})${PHONE_AFTER}`, 'g');
const PHONE_TRUNK = new RegExp(`${PHONE_BEFORE}0\\d{1,4}(${PHONE_SEP})\\d{2,4}(?:\\1\\d{2,4}){1,3}${PHONE_AFTER}`, 'g');
const PHONE_BARE = new RegExp(`${PHONE_BEFORE}0[1-9]\\d{8,9}${PHONE_AFTER}`, 'g');
const digitsOf = (s: string): string => s.replace(/\D/g, '');
const phoneFinders: Finder[] = [
  // International: 8 to 15 digits, and 10 or more when written with no separator (a diff's +1234 is no number).
  part => spansOf(PHONE_INTL, part, (m) => {
    const d = digitsOf(m[0]);
    const spaced = /[ .\- ()]/.test(m[0]);
    return d.length >= 8 && d.length <= 15 && (spaced || d.length >= 10) ? { key: `+${d}` } : null;
  }, 'phone', 'PHONE'),
  part => spansOf(PHONE_NANP, part, m => ({ key: digitsOf(m[0]) }), 'phone', 'PHONE'),
  part => spansOf(PHONE_TRUNK, part, (m) => {
    const d = digitsOf(m[0]);
    return d.length >= 9 && d.length <= 11 ? { key: d } : null;
  }, 'phone', 'PHONE'),
  part => spansOf(PHONE_BARE, part, m => ({ key: m[0] }), 'phone', 'PHONE'),
];

/**
 * Names that are no person's, which a git history or an account may still give: services, bots, generic accounts and
 * words. A name is used only with three letters or more (Al and Bo cannot be told from a word).
 */
const NOT_PERSONS = new Set(['github', 'gitlab', 'bitbucket', 'github actions', 'github-actions', 'gitlab ci', 'copilot', 'claude', 'codex',
  'dependabot', 'renovate', 'unknown', 'root', 'admin', 'administrator', 'user', 'users', 'nobody', 'system', 'jenkins', 'runner', 'ubuntu',
  'vagrant', 'ec2-user', 'guest', 'test', 'tester', 'build', 'builder', 'docker', 'node', 'app', 'www-data', 'daemon', 'git', 'sandbox', 'dev',
  'developer', 'owner', 'default', 'local', 'localhost', 'author', 'committer', 'anonymous', 'travis', 'circleci', 'vercel', 'netlify',
  'actions-user', 'web-flow', 'semantic-release-bot', 'snyk-bot', 'pre-commit-ci']);
/** Particles of a name, never masked alone. */
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'del', 'della', 'dos', 'das', 'des', 'bin', 'ibn', 'ben', 'the', 'and']);

/** Whether a name can be masked: a person's, told from a word. */
export function usablePersonName(name: string): boolean {
  const n = name.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!n || n.includes('@')) return false;
  if ((n.match(/\p{L}/gu) ?? []).length < 3) return false;
  if (/\[bot\]$/i.test(n) || /(?:^|\s)bot$/i.test(n)) return false;
  return !NOT_PERSONS.has(n.toLowerCase());
}

const NAME_EDGE_BEFORE = '(?<![\\p{L}\\p{M}\\p{N}_])';
const NAME_EDGE_AFTER = '(?![\\p{L}\\p{M}\\p{N}_])';

function personFinders(ctx: ScrubContext): Finder[] {
  const names = [...new Set((ctx.personNames ?? []).filter(n => typeof n === 'string' && usablePersonName(n)).map(n => n.normalize('NFC').trim().replace(/\s+/g, ' ')))];
  const forms = (s: string) => [...new Set([s, s.normalize('NFD')])];
  const whole = names.filter(n => n.includes(' '));
  // A part of a whole name, and a name of one word, as written: case kept, three letters or more.
  const parts = [...new Set(names.flatMap(n => n.split(' ')))]
    .filter(p => (p.match(/\p{L}/gu) ?? []).length >= 3 && !PARTICLES.has(p.toLowerCase()) && !NOT_PERSONS.has(p.toLowerCase()));
  const alternation = (list: string[], spaced: boolean) => list.flatMap(forms).sort((a, b) => b.length - a.length)
    .map(f => (spaced ? f.split(' ').map(escapeRe).join('\\s+') : escapeRe(f))).join('|');
  const finders: Finder[] = [];
  const key = (m: RegExpMatchArray) => ({ key: m[0].normalize('NFC').toLowerCase().replace(/\s+/g, ' ') });
  if (whole.length) {
    const re = new RegExp(`${NAME_EDGE_BEFORE}(?:${alternation(whole, true)})${NAME_EDGE_AFTER}`, 'giu');
    finders.push(part => spansOf(re, part, key, 'person', 'PERSON'));
  }
  if (parts.length) {
    const re = new RegExp(`${NAME_EDGE_BEFORE}(?:${alternation(parts, false)})${NAME_EDGE_AFTER}`, 'gu');
    finders.push(part => spansOf(re, part, key, 'person', 'PERSON'));
  }
  return finders;
}

/** The personal-data finders of a context, compiled once per context (one per session's upload). */
const compiled = new WeakMap<ScrubContext, Finder[][]>();
function personalFinders(ctx: ScrubContext): Finder[][] {
  let f = compiled.get(ctx);
  if (!f) {
    // In this order: a home before the name in it, an e-mail before the name in it.
    f = [homeFinders(ctx), [emailFinder], ipFinders, phoneFinders, personFinders(ctx)];
    compiled.set(ctx, f);
  }
  return f;
}

/** One string, scrubbed. Without a session, the string is a session of its own. */
export function scrubText(text: string, ctx: ScrubContext, counts: Record<string, number>, session: MaskSession = newMaskSession()): string {
  let out = replaceExact(text, ctx.knownSecrets.filter(s => typeof s === 'string' && s.length >= 8), 'known_secret', session, counts);
  out = replaceExact(out, ctx.envValues.filter(s => typeof s === 'string' && s.length >= 8), 'env_value', session, counts);
  for (const [re, kind] of SHAPES) out = replaceShape(out, re, kind, session, counts);
  out = outside(out, part => part.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi,
    (_m, a: string, p: string, b: string) => `${a}${placeholder('SECRET', p, 'url_password', session, counts)}${b}`));
  out = outside(out, part => part.replace(/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    (_m, scheme: string, credential: string) => `${scheme} ${placeholder('SECRET', credential, 'bearer', session, counts)}`));
  out = outside(out, part => part.replace(NAMED,
    (_m, head: string, quote: string, value: string) => `${head}${quote}${placeholder('SECRET', value, 'named_secret', session, counts)}${quote}`));
  for (const finders of personalFinders(ctx)) out = maskSpans(out, finders, session, counts);
  return out;
}

/** Any JSON value, every string in it scrubbed, an object property named like a secret masked whole. */
export function scrubValue(value: unknown, ctx: ScrubContext, counts: Record<string, number>, session: MaskSession = newMaskSession()): unknown {
  if (typeof value === 'string') return scrubText(value, ctx, counts, session);
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, counts, session));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length >= 6 && NAME_ONLY.test(k) && !IS_PLACEHOLDER.test(v)) {
        out[k] = placeholder('SECRET', v, 'named_secret', session, counts);
      } else {
        out[k] = scrubValue(v, ctx, counts, session);
      }
    }
    return out;
  }
  return value;
}

/** The values of a .env-like file worth masking: 8 characters or more, not a boolean or a number, unquoted. */
export function envValuesFrom(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v.length < 8 || /^-?\d+(\.\d+)?$/.test(v)) continue;
    // A word (localhost, production, project-a) is not a secret, and masking it everywhere would wreck the trace: a
    // value is kept as one when it mixes two of digits, capitals and small letters.
    if ([/\d/, /[A-Z]/, /[a-z]/].filter(re => re.test(v)).length < 2) continue;
    out.push(v);
  }
  return [...new Set(out)];
}

/** The values of the .env-like files at a project's root (64 KiB each at most), examples and templates left out. */
export function projectEnvValues(projectPath: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(projectPath); } catch { return []; }
  const values: string[] = [];
  for (const name of names) {
    if (!/^\.env(\..+)?$/.test(name) || /\.(example|sample|template|dist)$/i.test(name)) continue;
    const file = path.join(projectPath, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      values.push(...envValuesFrom(fs.readFileSync(file, 'utf8')));
    } catch { /* unreadable: skipped */ }
  }
  return [...new Set(values)];
}
