import { redactSecrets } from './redact-secrets';

/**
 * A process's command line with its secrets out, as the window shows it (lot 3 item D, #546; its failures:
 * __tests__/electron/utils/redact-command-line.test.ts). Through the API a process carries no arguments at all: this is
 * for the window, where the owner reads what runs.
 *
 * Masked by default (the orchestrator's decision on the Audit's re-check of #546, after 27 forms a list of shapes had
 * missed): the program, the paths, the file names, the flags, the numbers and every argument under eight characters
 * stay; any other argument is masked whole. A secret shorter than that is caught where its place says so: after a flag
 * or a name that says password, pass, secret, token, key, auth or credential, in a URL's password, after `curl -u`,
 * `sshpass -p`, mysql's `-p` or `docker login -p`. A secret is masked whole: four characters kept at each end leave
 * eight of a fifteen-character password.
 */

const MASK = '[redacted]';
const LONG = 8;

/** Where a secret's place says so, whatever its length or shape. */
const RULES: Array<[RegExp, string]> = [
  // A URL's password, with or without a user (redis://:pw@host).
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, `$1${MASK}@`],
  // Keys by their vendor's prefix: Stripe's live keys, Hugging Face, SendGrid, Shopify, DigitalOcean, PyPI, Docker Hub.
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{20,}/g, MASK],
  [/\bSG\.[\w-]{16,}\.[\w-]{16,}/g, MASK],
  [/\b(?:shpat|shpss|shpca)_[A-Za-z0-9]{16,}/g, MASK],
  [/\bdop_v1_[A-Za-z0-9]{32,}/g, MASK],
  [/\bpypi-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bdckr_pat_[A-Za-z0-9_-]{10,}/g, MASK],
  // MySQL's and MariaDB's password, attached to -p (a lone -p prompts for it).
  [/(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump)\b.*?\s-p)(?=\S)\S+/g, `$1${MASK}`],
  // sshpass's password, attached or spaced.
  [/(\bsshpass\s+-p)(\s*)(?=[^\s-])\S+/g, `$1$2${MASK}`],
  // docker or podman login's -p.
  [/(\b(?:docker|podman)\b.*?\blogin\b.*?\s-p)(\s+|=)\S+/g, `$1$2${MASK}`],
  // curl's user and password.
  [/(\bcurl\b.*?\s(?:-u|--user)(?:\s+|=)?[^\s:]*:)\S+/g, `$1${MASK}`],
];

/** The words a flag's or a variable's name says a secret with, its parts split at -, _, . and camelCase. */
const SECRET_WORDS = new Set([
  'pass', 'password', 'passwd', 'passphrase', 'passin', 'passout', 'pwd', 'secret', 'secrets', 'token', 'tokens',
  'key', 'keys', 'apikey', 'auth', 'authorization', 'credential', 'credentials',
]);
function namesSecret(name: string): boolean {
  return name.replace(/^-+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s._-]+/).some(w => SECRET_WORDS.has(w.toLowerCase()));
}

/** A flag: `--name`, a lower-case `-name` (openssl's `-aes-256-cbc`), or one letter. */
const FLAG = /^(?:--[A-Za-z][\w.-]*|-[a-z][a-z0-9-]*|-[A-Za-z])$/;
/** A number: a port, a mapping, a version, a size. */
const NUMBER = /^\d+(?:[.:,x/-]\d+)*$/;
/** A path: absolute, from home, relative, a drive; or a relative path ending in a file name. */
const PATH = /^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)|^[\w.-]+(?:\/[\w.-]+)*\/[\w-]+(?:\.[a-z0-9]+)+$/;
/** A file or a host name: words joined by dots, lower-case after the first. */
const FILE_NAME = /^[A-Za-z0-9_-]+(?:\.[a-z0-9-]+)+$/;

/** An argument by the default rule: kept when short or when it says what runs, else masked. */
function byDefault(arg: string): string {
  if (arg.length < LONG || NUMBER.test(arg) || PATH.test(arg) || FILE_NAME.test(arg)) return arg;
  return MASK;
}

export function redactCommandLine(command: string): string {
  if (!command) return command;
  // What the logs' rules catch (a vendor key, a bearer token, NAME_TOKEN=value), first, its four characters at each
  // end dropped: masked whole.
  let out = redactSecrets(command).replace(/\S{4}\[redacted\]\S{4}/g, MASK);
  for (const [pattern, to] of RULES) out = out.replace(pattern, to);
  const words = out.split(/(\s+)/);
  let afterSecretFlag = false;
  let first = true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || /^\s+$/.test(w)) continue;
    const secretFlagBefore = afterSecretFlag;
    afterSecretFlag = false;
    // The program, and what a rule above masked already.
    if (first) { first = false; continue; }
    if (w.includes(MASK)) continue;
    if (secretFlagBefore && !w.startsWith('-')) { words[i] = MASK; continue; }
    const assigned = /^(--?[A-Za-z][\w.-]*|[A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(w);
    if (assigned) {
      words[i] = `${assigned[1]}=${namesSecret(assigned[1]) ? MASK : byDefault(assigned[2])}`;
      continue;
    }
    if (FLAG.test(w)) { afterSecretFlag = namesSecret(w); continue; }
    words[i] = byDefault(w);
  }
  return words.join('');
}
