import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scrubValue, envValuesFrom, projectEnvValues, SCRUB_VERSION, type ScrubContext } from '../../electron/services/trace-scrub';

/**
 * Scrubbing a trace before it leaves the machine (native traces, the upload to a back-office): what an agent's
 * session holds of the user's keys, tokens, .env values and home path is replaced by a typed placeholder, in every
 * string of the session, its keys and structure kept.
 *
 * How it fails, written before the code (19/11):
 * 1. A known secret (a settings' key, an endpoint's key, Tars's own tokens) passes because it has no known shape.
 * 2. A value from the project's .env file passes; or a harmless value from it (true, 3000, localhost) is masked
 *    everywhere it appears, wrecking the trace.
 * 3. A key with a known shape passes: OpenAI, Anthropic, GitHub, Slack, AWS, Google, Stripe, npm, Hugging Face,
 *    a JWT, a PEM private key, Tars's endpoint and reader tokens.
 * 4. A secret in key=value or JSON form (`password=...`, `"apiKey": "..."`, `TOKEN: ...`) passes; the name is lost
 *    with the value.
 * 5. Credentials in a URL pass; a Bearer or Basic credential passes.
 * 6. The user's home path stays, on macOS, Linux or Windows spelling; another path that merely starts alike is cut.
 * 7. The structure changes: object keys, numbers, booleans, arrays.
 * 8. The report does not say what was replaced, by kind, or which version of the rules ran.
 * 9. Ordinary code and prose are mangled: a variable named token_count, a sha, a uuid, a long word.
 *
 * Since trace feature B3 (27/11), in the trace reader's pinned format: what these rules catch becomes `<SECRET_n>`,
 * numbered per session, the same value under the same number (trace-scrub-personal.test.ts, U1 and U2); a home path
 * becomes `<HOME_n>`, the account's and anyone else's, each home its own number, so 6 now reads: another home that
 * merely starts alike is another home, never the account's. The counts by kind stay.
 *
 * Added before its code (the Audit on #679 at d07407c7e, 27/11):
 * 10. A URL's password with no user before it (Redis's own form, `redis://:password@host:port`) passes, with any host
 *     but a dotted one (which the e-mail rule happened to take); or a URL with a port and no credentials is changed.
 */

const HOME = '/Users/someone';
const ctx = (over: Partial<ScrubContext> = {}): ScrubContext => ({ homeDirs: [HOME], knownSecrets: [], envValues: [], ...over });
const scrub = (v: unknown, c: ScrubContext = ctx()) => { const counts: Record<string, number> = {}; return { out: scrubValue(v, c, counts), counts }; };

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('scrubbing a trace', () => {
  it('1: a known secret goes whatever its shape', () => {
    const { out, counts } = scrub('use plainword9secret here and plainword9secret there', ctx({ knownSecrets: ['plainword9secret'] }));
    expect(out).toBe('use <SECRET_1> here and <SECRET_1> there');
    expect(counts.known_secret).toBe(2);
  });

  it('2: the .env values go; harmless ones stay', () => {
    const values = envValuesFrom('# comment\nDATABASE_URL=postgres://app:Pa55word@db.internal:5432/app\nPORT=3000\nDEBUG=true\nHOST=localhost\nexport STRIPE_HOOK="whsec_abcdef123456"\nNAME=project-a\n');
    expect(values).toContain('postgres://app:Pa55word@db.internal:5432/app');
    expect(values).toContain('whsec_abcdef123456');
    for (const harmless of ['3000', 'true', 'localhost']) expect(values).not.toContain(harmless);
    const { out } = scrub('connect to postgres://app:Pa55word@db.internal:5432/app on port 3000 (debug true)', ctx({ envValues: values }));
    expect(out).toBe('connect to <SECRET_1> on port 3000 (debug true)');
  });

  it('2: the project\'s .env-like files are read, examples and samples are not', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-'));
    fs.writeFileSync(path.join(dir, '.env'), 'A_SECRET=from-dot-env-1\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'B_SECRET=from-env-local-2\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'C_SECRET=example-value-3\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'D=not-an-env-4\n');
    expect(projectEnvValues(dir).sort()).toEqual(['from-dot-env-1', 'from-env-local-2']);
    expect(projectEnvValues(path.join(dir, 'missing'))).toEqual([]);
  });

  it('3: keys with a known shape go', () => {
    const samples: Array<[string, string]> = [
      ['sk-proj-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4', 'openai_key'],
      ['sk-ant-api03-' + 'x'.repeat(40), 'anthropic_key'],
      ['ghp_' + 'A'.repeat(36), 'github_token'],
      ['github_pat_' + 'B'.repeat(50), 'github_token'],
      ['xoxb-1234567890-abcdefghij', 'slack_token'],
      ['AKIAABCDEFGHIJKLMNOP', 'aws_access_key'],
      ['AIza' + 'C'.repeat(35), 'google_key'],
      ['sk_live_' + 'D'.repeat(24), 'stripe_key'],
      ['npm_' + 'E'.repeat(36), 'npm_token'],
      ['hf_' + 'F'.repeat(34), 'huggingface_token'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv', 'jwt'],
      ['tep_' + 'a'.repeat(48), 'tars_token'],
      ['trd_' + 'b'.repeat(64), 'tars_token'],
    ];
    for (const [secret, kind] of samples) {
      const { out, counts } = scrub(`value: ${secret} end`);
      expect(out, kind).toBe('value: <SECRET_1> end');
      expect(counts[kind], kind).toBe(1);
    }
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(scrub(`key:\n${pem}\nafter`).out).toBe('key:\n<SECRET_1>\nafter');
  });

  it('4: secrets by name keep their name', () => {
    expect(scrub('password=hunter2hunter').out).toBe('password=<SECRET_1>');
    expect(scrub('export API_KEY="abcdef123456"').out).toBe('export API_KEY="<SECRET_1>"');
    expect(scrub('{"apiKey": "zzzzzzzz9999", "name": "x"}').out).toBe('{"apiKey": "<SECRET_1>", "name": "x"}');
    expect(scrub('SLACK_TOKEN: abcdef-ghijkl').out).toBe('SLACK_TOKEN: <SECRET_1>');
    expect(scrub({ client_secret: 'abcdefgh12345' }).out).toEqual({ client_secret: '<SECRET_1>' });
  });

  it('5: URL credentials and Bearer or Basic credentials go', () => {
    expect(scrub('git clone https://user:s3cr3tpass@host.example.com/r.git').out).toBe('git clone https://user:<SECRET_1>@host.example.com/r.git');
    expect(scrub('Authorization: Bearer abcdefghijklmnop1234').out).toBe('Authorization: Bearer <SECRET_1>');
    expect(scrub('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="').out).toBe('curl -H "Authorization: Basic <SECRET_1>"');
  });

  it('10: a URL\'s password with no user before it goes too, the host as before; a URL with a port and no credentials stays', () => {
    const cases: Array<[string, string]> = [
      ['redis://:hunter2pass@localhost:6379', 'redis://:<SECRET_1>@localhost:6379'],
      ['redis://:hunter2pass@redis:6379', 'redis://:<SECRET_1>@redis:6379'],
      ['redis://:hunter2pass@10.0.0.12:6379', 'redis://:<SECRET_1>@<IP_1>:6379'],
      ['amqp://:hunter2pass@127.0.0.1', 'amqp://:<SECRET_1>@127.0.0.1'],
      ['redis://:hunter2pass@cache.example.com:6379/0', 'redis://:<SECRET_1>@cache.example.com:6379/0'],
    ];
    for (const [given, masked] of cases) {
      const { out, counts } = scrub(given);
      expect(out, given).toBe(masked);
      expect(counts.url_password, given).toBe(1);
    }
    for (const kept of ['http://localhost:3000/api', 'https://example.com:9000/path?a=b', 'postgres://db.internal:5432/app', 'ws://[::1]:8080/socket']) {
      expect(scrub(kept).out, kept).toBe(kept);
    }
  });

  it('6: the home path becomes <HOME_n>, in every spelling; another home is another number', () => {
    const c = ctx({ homeDirs: ['/Users/someone', 'C:\\Users\\someone'] });
    expect(scrub('/Users/someone/projects/a and /Users/someone', c).out).toBe('<HOME_1>/projects/a and <HOME_1>');
    expect(scrub('C:\\Users\\someone\\code\\x', c).out).toBe('<HOME_1>\\code\\x');
    expect(scrub('/Users/someone/a and /Users/someone2/other', c).out).toBe('<HOME_1>/a and <HOME_2>/other');
    expect(scrub('/home/someone/x', ctx({ homeDirs: ['/home/someone'] })).out).toBe('<HOME_1>/x');
  });

  it('7: the structure stays', () => {
    const v = { role: 'tool', n: 3, ok: true, list: ['ghp_' + 'A'.repeat(36), 4], nested: { 'password=': 'x' } };
    const { out } = scrub(v);
    expect(out).toEqual({ role: 'tool', n: 3, ok: true, list: ['<SECRET_1>', 4], nested: { 'password=': 'x' } });
  });

  it('8: the version of the rules is named', () => {
    expect(SCRUB_VERSION).toMatch(/^tars-scrub-\d+$/);
  });

  it('9: ordinary code is left alone', () => {
    const code = 'const token_count = 42; // sha 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b, id 0f8fad5b-d9cb-469f-a165-70867728950e, internationalization';
    expect(scrub(code).out).toBe(code);
    expect(scrub('the password is not set').out).toBe('the password is not set');
  });
});
