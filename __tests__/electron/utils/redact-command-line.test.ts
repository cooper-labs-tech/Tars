import { describe, it, expect } from 'vitest';
import { redactCommandLine } from '../../../electron/utils/redact-command-line';

/**
 * A process's command line as the window shows it (lot 3 item D, #546): the program and what it works on, never a
 * secret it was handed. redactSecrets was written for logs and messages; command lines carry secrets in flags, and the
 * Audit's gate of #546 (M1, reports/AUDIT-PR546.md) found eleven common forms it left in clear.
 *
 * How it fails, written before the code (28/10). The Audit's table first, each value fake but realistic:
 * C1. A URL with an empty user keeps its password: `redis-cli -u redis://:S3cretPassw0rd9@cache:6379`.
 * C2. MySQL's attached `-p` keeps it: `mysql -uroot -pS3cretPassw0rd9 shop`.
 * C3. `--password` followed by a space keeps it: `pg_dump --password S3cretPassw0rd9 shop`.
 * C4. curl's user and password keep it: `curl -u admin:S3cretPassw0rd9 https://x`.
 * C5. `sshpass -p` keeps it: `sshpass -p S3cretPassw0rd9 ssh deploy@host`.
 * C6. `docker login -p` keeps it: `docker login -u me -p S3cretPassw0rd9 registry.example`.
 * C7. OpenSSL's `-pass pass:` keeps it: `openssl enc -aes-256-cbc -pass pass:S3cretPassw0rd9 -in f`.
 * C8. A Stripe live key stays: `stripe --api-key sk_live_<24 letters and digits>`.
 * C9. A Hugging Face token stays: `python up.py --token hf_9v8BmYYN3mN1xpxz7p96E9YQL9d6JU1Jdk`.
 * C10. An AWS secret access key stays: `aws ... --secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, and so it does
 *     with no flag before it.
 * C11. A `--token` with no known prefix stays: `vercel deploy --token NEh73v9aNrkm2fSt6f0fBS9J`.
 * And from the orchestrator's decision on the gate (task t-2be3810b):
 * C12. A flag whose name says password, pass, secret, token, key or auth keeps its value, attached with `=` or after a
 *     space (`--client-secret=`, `--auth-token x`, `--apikey x`, `-pass x`); a restricted live key (`rk_live_`) stays.
 * C13. What redactSecrets already masks comes back in clear (a `sk-ant-` key, a URL's password with a user, a
 *     `Bearer` header, `OPENAI_API_KEY=`).
 * C14. A secret is kept in part: the window shows none of it, not its first and last four characters.
 * C15. The command line no longer says what runs: the program, its other flags, its paths and its host stay.
 * C16. A value that is no secret is masked: `--port 5432`, `--keyboard-layout us`, `docker run -p 8080:80`,
 *     `docker run -u 1000:1000`, a 40-character git commit, a long absolute path, `mysql -p` alone (it prompts).
 * C17. The flag after a secret-named switch is taken for its value: `--no-auth --verbose` keeps `--verbose`.
 * And from the Audit's re-check at 5a250033, sixteen more forms in clear (a list of shapes trails the next CLI):
 * C18 to C20. camelCase flags: `--accessToken <v>`, `--authToken <v>`, `--privateKey <v>`.
 * C21, C22. Flag names outside the list: `--pwd <v>`, `--credentials <v>`.
 * C23, C24. OpenSSL: `-passin pass:<v>`, `-k <v>`.
 * C25. MSSQL: `sqlcmd -P <v>`.
 * C26. Docker's environment: `docker run -e DB_PASS=<v>`.
 * C27. An HTTP header: `Authorization: Basic <base64 of user:password>`.
 * C28 to C32. Vendor prefixes: SendGrid `SG.`, Shopify `shpat_`, DigitalOcean `dop_v1_`, PyPI `pypi-`, Docker Hub
 *     `dckr_pat_`.
 * C33. A bare `-p`: `twine upload -p <v>`.
 * So, the orchestrator's decision, mask by default:
 * C34. An argument of eight characters or more that is not a flag, a path or a number shows: a key of no known shape,
 *     a git commit, a URL (a webhook's path is its secret), a hostname-and-user.
 * C35. What says what runs is masked: the program, a path (absolute, home, relative with a file name), a file name, a
 *     flag (`--dangerously-skip-permissions`, `-aes-256-cbc`), a number (`8080:80`, `1.2.3`), a word under eight.
 * C36. `--name=value` and `NAME=value` lose their name, or keep a value under eight after a name that says secret
 *     (`DB_PASS=pw12`, `--password=short`).
 * And the orchestrator's refinement, so the owner's window stays readable:
 * C37. A subcommand of eight letters or more (checkout, playwright, typecheck) is masked: an argument made only of
 *     lower-case letters and hyphens stays, whatever its length (`git checkout <commit>` reads `git checkout
 *     [redacted]`).
 * C38. That makes a lower-case password stay where its place says secret: `--password longlowercaseword` is masked.
 */

const SECRET = 'S3cretPassw0rd9';
const V = 'Ab3dEf6hIj9kLm2n';
// Vendor shapes built at run time, as the live keys below: push protection refuses one written whole.
const k = (...parts: string[]) => parts.join('');
// Live-key shapes built at run time: GitHub's push protection refuses one written whole, even a fake.
const live = (kind: 'sk' | 'rk', rest: string) => [kind, 'live', rest].join('_');

describe('a command line as the window shows it', () => {
  it('C1 to C11. the Audit\'s eleven forms keep no secret', () => {
    for (const [line, secret] of [
      [`redis-cli -u redis://:${SECRET}@cache:6379`, SECRET],
      [`mysql -uroot -p${SECRET} shop`, SECRET],
      [`pg_dump --password ${SECRET} shop`, SECRET],
      [`curl -u admin:${SECRET} https://x`, SECRET],
      [`sshpass -p ${SECRET} ssh deploy@host`, SECRET],
      [`docker login -u me -p ${SECRET} registry.example`, SECRET],
      [`openssl enc -aes-256-cbc -pass pass:${SECRET} -in f`, SECRET],
      [`stripe --api-key ${live('sk', '9xS5rWptLtB0JQampvxShrUp')}`, '9xS5rWptLtB0JQampvxShrUp'],
      ['python up.py --token hf_9v8BmYYN3mN1xpxz7p96E9YQL9d6JU1Jdk', '9v8BmYYN3mN1xpxz7p96E9YQL9d6JU1Jdk'],
      ['aws s3 cp f s3://b --secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
      ['vercel deploy --token NEh73v9aNrkm2fSt6f0fBS9J', 'NEh73v9aNrkm2fSt6f0fBS9J'],
    ]) {
      expect(redactCommandLine(line), line).not.toContain(secret);
    }
  });

  it('C10. an AWS secret key with no flag before it', () => {
    const line = 'node sync.js AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(redactCommandLine(line)).not.toContain('K7MDENG');
  });

  it('C12. every flag named for a secret, attached or spaced; a restricted live key', () => {
    for (const line of [
      `app --client-secret=${SECRET}`, `app --auth-token ${SECRET}`, `app --apikey ${SECRET}`, `app -pass ${SECRET}`,
      `app --db-password=${SECRET}`, `app --access-key ${SECRET}`, `app --passphrase ${SECRET}`, `app --TOKEN ${SECRET}`,
      `stripe listen ${live('rk', `${SECRET}abcdef`)}`,
    ]) {
      expect(redactCommandLine(line), line).not.toContain(SECRET);
    }
  });

  it('C13. what redactSecrets masks stays masked', () => {
    for (const [line, secret] of [
      ['claude --key sk-ant-api03-9xS5rWptLtB0JQampvxShrUpQ', 'sk-ant-api03-9xS5rWptLtB0JQampvxShrUpQ'],
      [`psql postgres://app:${SECRET}@db/x`, SECRET],
      ['curl -H "Authorization: Bearer 9xS5rWptLtB0JQampvxShrUp" x', '9xS5rWptLtB0JQampvxShrUp'],
      [`env OPENAI_API_KEY=${SECRET} node a.js`, SECRET],
    ]) {
      expect(redactCommandLine(line), line).not.toContain(secret);
    }
  });

  it('C14. a secret is masked whole, not its ends kept', () => {
    const out = redactCommandLine(`pg_dump --password ${SECRET} shop`);
    expect(out).toBe('pg_dump --password [redacted] shop');
    expect(redactCommandLine(`curl -u admin:${SECRET} https://x`)).toBe('curl -u admin:[redacted] [redacted]');
    expect(redactCommandLine(`redis-cli -u redis://:${SECRET}@cache:6379`)).toBe('redis-cli -u redis://:[redacted]@cache:6379');
  });

  it('C15. the program, its other flags, its paths and its host stay', () => {
    expect(redactCommandLine(`mysql -uroot -p${SECRET} -h db.internal shop`)).toBe('mysql -uroot -p[redacted] -h db.internal shop');
    expect(redactCommandLine(`sshpass -p ${SECRET} ssh deploy@host`)).toBe('sshpass -p [redacted] ssh [redacted]');
    expect(redactCommandLine(`docker login -u me -p ${SECRET} registry.example`)).toBe('docker login -u me -p [redacted] registry.example');
    expect(redactCommandLine(`openssl enc -aes-256-cbc -pass pass:${SECRET} -in f`)).toBe('openssl enc -aes-256-cbc -pass [redacted] -in f');
  });

  it('C16. a value that is no secret stays', () => {
    for (const line of [
      'postgres -D /var/db --port 5432', 'setxkbmap --keyboard-layout us', 'docker run -p 8080:80 nginx', 'docker run -u 1000:1000 alpine',
      'node /Users/someone/Library/Application/Support/Tars/x.js',
      'mysql -p shop', 'next dev --turbopack', '/bin/zsh -l',
    ]) {
      expect(redactCommandLine(line), line).toBe(line);
    }
  });

  it('C17. a switch named for a secret does not take the next flag', () => {
    expect(redactCommandLine('server --no-auth --verbose')).toBe('server --no-auth --verbose');
  });

  it('C18 to C33. the Audit\'s sixteen further forms keep no secret', () => {
    for (const line of [
      `cli --accessToken ${V}`, `cli --authToken ${V}`, `cli --privateKey ${V}`, `cli --pwd ${V}`, `cli --credentials ${V}`,
      `openssl rsa -passin pass:${V} -in key.pem`, `openssl enc -k ${V} -in f`, `sqlcmd -S db -P ${V}`,
      `docker run -e DB_PASS=${V} app`, `curl -H "Authorization: Basic ${V}" x`,
      `mailer ${k('SG', '.', V, '.', V)}`, `shop ${k('shpat', '_', V, V)}`, `doctl ${k('dop', '_v1_', V, V)}`,
      `twine upload -u __token__ ${k('pypi', '-', V, V)}`, `docker login ${k('dckr', '_pat_', V)}`, `twine upload -p ${V}`,
    ]) {
      expect(redactCommandLine(line), line).not.toContain(V);
    }
  });

  it('C34. by default, an argument of eight characters or more that is not a flag, a path or a number is masked', () => {
    expect(redactCommandLine('deploy-tool run Xk9pQ2mZ7vB4')).toBe('deploy-tool run [redacted]');
    expect(redactCommandLine('curl https://hooks.example.com/services/T0/B0/XYZ')).toBe('curl [redacted]');
  });

  it('C35. the program, paths, file names, flags, numbers and short words stay', () => {
    for (const line of [
      '/Users/x/.local/bin/claude --dangerously-skip-permissions', 'node server.js --port 3000', 'npx vitest run e2e/x.spec.ts',
      'openssl enc -aes-256-cbc -in ~/notes.txt -out ./notes.enc', 'docker run -p 8080:80 nginx', 'tool --version 1.2.3',
      'psql -h db.internal -U app shop',
    ]) {
      expect(redactCommandLine(line), line).toBe(line);
    }
  });

  it('C36. a name before = is kept, its value masked by the same rule, always after a name that says secret', () => {
    expect(redactCommandLine(`app --region=eu-1 --zone=eu-west-1a --session=${V} DEBUG=1 HOME=/Users/x`)).toBe('app --region=eu-1 --zone=[redacted] --session=[redacted] DEBUG=1 HOME=/Users/x');
    expect(redactCommandLine('app DB_PASS=pw12 --password=short')).toBe('app DB_PASS=[redacted] --password=[redacted]');
  });

  it('C37. a subcommand of lower-case letters and hyphens stays, whatever its length', () => {
    expect(redactCommandLine('git checkout 4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39')).toBe('git checkout [redacted]');
    for (const line of ['npx playwright test', 'npm run typecheck', 'pnpm install --frozen-lockfile', 'tool run-the-long-subcommand']) {
      expect(redactCommandLine(line), line).toBe(line);
    }
    // Mixed case, digits or symbols of eight or more: still masked.
    expect(redactCommandLine('tool Checkout2 run_this_long abc.DEF.ghi')).toBe('tool [redacted] [redacted] [redacted]');
  });

  it('C38. a lower-case password where its place says secret is still masked', () => {
    expect(redactCommandLine('pg_dump --password longlowercaseword shop')).toBe('pg_dump --password [redacted] shop');
    expect(redactCommandLine('app --api-key=correct-horse-battery DB_PASS=staplestaple')).toBe('app --api-key=[redacted] DB_PASS=[redacted]');
  });
});
