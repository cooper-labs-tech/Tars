import * as fs from 'fs';
import * as path from 'path';

/**
 * Scrubbing a trace before it leaves the machine (native traces, the upload to a back-office). Every string of a
 * session, in its messages, system prompts, tool sets and params, goes through scrubText; keys, numbers, booleans and
 * the structure stay. What is replaced becomes `<REDACTED:kind>`, counted by kind in the upload's report.
 *
 * What it catches, in this order:
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
 * 8. The user's home path, as `~`, in each spelling given (only that folder, not one whose name merely starts alike).
 *
 * What it cannot catch: a secret with no known shape, no telling name and not held by Tars or a .env file (a password
 * in prose, a key in a YAML file under an innocent name); a secret shorter than its rule's floor; one split across
 * two strings, encoded (base64, hex) or inside an image; personal data (names, e-mail addresses, IP addresses,
 * other people's paths). And it applies to what is uploaded only: the endpoint the agent talked to, and the local
 * store, saw the session as it was.
 */

export const SCRUB_VERSION = 'tars-scrub-1';

export interface ScrubContext {
  /** The user's home folder, in every spelling it may appear in (a Windows home with \\ and with /). */
  homeDirs: string[];
  knownSecrets: string[];
  envValues: string[];
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

function replaceAll(text: string, re: RegExp, kind: string, counts: Record<string, number>): string {
  return text.replace(re, () => { counts[kind] = (counts[kind] ?? 0) + 1; return `<REDACTED:${kind}>`; });
}

function replaceExact(text: string, values: string[], kind: string, counts: Record<string, number>): string {
  let out = text;
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    if (!v || !out.includes(v)) continue;
    const parts = out.split(v);
    counts[kind] = (counts[kind] ?? 0) + parts.length - 1;
    out = parts.join(`<REDACTED:${kind}>`);
  }
  return out;
}

/** One string, scrubbed. */
export function scrubText(text: string, ctx: ScrubContext, counts: Record<string, number>): string {
  let out = replaceExact(text, ctx.knownSecrets.filter(s => typeof s === 'string' && s.length >= 8), 'known_secret', counts);
  out = replaceExact(out, ctx.envValues.filter(s => typeof s === 'string' && s.length >= 8), 'env_value', counts);
  for (const [re, kind] of SHAPES) out = replaceAll(out, re, kind, counts);
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/gi, (_m, a: string, _p: string, b: string) => {
    counts.url_password = (counts.url_password ?? 0) + 1;
    return `${a}<REDACTED:url_password>${b}`;
  });
  out = out.replace(/\b(Bearer|Basic)\s+(?!<REDACTED)[A-Za-z0-9._~+/=-]{16,}/g, (_m, scheme: string) => {
    counts.bearer = (counts.bearer ?? 0) + 1;
    return `${scheme} <REDACTED:bearer>`;
  });
  out = out.replace(NAMED, (m, head: string, quote: string, value: string) => {
    if (value.startsWith('<REDACTED')) return m;
    counts.named_secret = (counts.named_secret ?? 0) + 1;
    return `${head}${quote}<REDACTED:named_secret>${quote}`;
  });
  for (const home of [...ctx.homeDirs].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`${escapeRe(home)}(?=$|[\\\\/\\s"'):;,\\]}])`, 'g');
    out = out.replace(re, () => { counts.home_path = (counts.home_path ?? 0) + 1; return '~'; });
  }
  return out;
}

/** Any JSON value, every string in it scrubbed, an object property named like a secret masked whole. */
export function scrubValue(value: unknown, ctx: ScrubContext, counts: Record<string, number>): unknown {
  if (typeof value === 'string') return scrubText(value, ctx, counts);
  if (Array.isArray(value)) return value.map(v => scrubValue(v, ctx, counts));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length >= 6 && NAME_ONLY.test(k) && !v.startsWith('<REDACTED')) {
        counts.named_secret = (counts.named_secret ?? 0) + 1;
        out[k] = '<REDACTED:named_secret>';
      } else {
        out[k] = scrubValue(v, ctx, counts);
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
