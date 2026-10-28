import { redactSecrets } from './redact-secrets';

/**
 * A process's command line with its secrets out, as the window shows it (lot 3 item D, #546; its failures:
 * __tests__/electron/utils/redact-command-line.test.ts). redactSecrets was written for logs and messages; a command
 * line carries its secrets in flags, which it left in clear (the Audit's gate of #546, M1). Through the API a process
 * carries no arguments at all: this is for the window, where the owner reads what runs.
 *
 * A secret here is masked whole: four characters kept at each end leave eight of a fifteen-character password.
 */

const MASK = '[redacted]';

/** A flag whose name says it carries a secret: one of its dash- or underscore-separated words, `apikey` too. */
const SECRET_FLAG = /^--?(?:[a-z0-9]+[-_])*(?:api)?(?:pass(?:word|wd|phrase)?|secrets?|tokens?|keys?|auth(?:orization)?)(?:[-_][a-z0-9]+)*$/i;

/** Each rule: what it matches, and what to put in its place. */
const RULES: Array<[RegExp, string]> = [
  // A URL's password, with or without a user (redis://:pw@host).
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, `$1${MASK}@`],
  // Prefixed keys redactSecrets does not know.
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{20,}/g, MASK],
  // MySQL's and MariaDB's password, attached to -p (a lone -p prompts for it).
  [/(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mariadb|mariadb-dump)\b.*?\s-p)(?=\S)\S+/g, `$1${MASK}`],
  // sshpass's password, attached or spaced.
  [/(\bsshpass\s+-p)(\s*)(?=[^\s-])\S+/g, `$1$2${MASK}`],
  // docker or podman login's -p.
  [/(\b(?:docker|podman)\b.*?\blogin\b.*?\s-p)(\s+|=)\S+/g, `$1$2${MASK}`],
  // curl's user and password.
  [/(\bcurl\b.*?\s(?:-u|--user)(?:\s+|=)?[^\s:]*:)\S+/g, `$1${MASK}`],
];

/** A 40-character run of an AWS secret access key's alphabet, mixed case and a digit: not a commit, not a path. */
function awsSecret(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !run.startsWith('/');
}

export function redactCommandLine(command: string): string {
  if (!command) return command;
  // What the logs' rules catch (a vendor key, a bearer token, NAME_TOKEN=value), first, its four characters at each
  // end dropped: masked whole.
  let out = redactSecrets(command).replace(/\S{4}\[redacted\]\S{4}/g, MASK);
  for (const [pattern, to] of RULES) out = out.replace(pattern, to);
  out = out.replace(/(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, run => (awsSecret(run) ? MASK : run));
  // The value after a flag named for a secret, `--x=value` or `--x value` (never the next flag).
  const words = out.split(/(\s+)/);
  for (let i = 0; i < words.length; i++) {
    const eq = words[i].indexOf('=');
    if (eq > 0 && SECRET_FLAG.test(words[i].slice(0, eq)) && eq < words[i].length - 1) {
      words[i] = `${words[i].slice(0, eq + 1)}${MASK}`;
    } else if (SECRET_FLAG.test(words[i]) && i + 2 < words.length && words[i + 2] && !words[i + 2].startsWith('-')) {
      words[i + 2] = MASK;
      i += 2;
    }
  }
  return words.join('');
}
