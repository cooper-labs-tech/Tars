import { describe, it, expect } from 'vitest';
import { redactSecrets, containsSecret } from '../../electron/utils/redact-secrets';

/**
 * Agent output leaves this machine twice: into a Telegram chat, and into the
 * prompt sent to a Hermes gateway that can live anywhere on a tailnet. Both
 * took the raw PTY buffer, stripped ANSI, and sent it. An agent's environment
 * holds ANTHROPIC_API_KEY, and for every provider except the local ones that is
 * the user's real vendor key, so one `env`, one verbose curl or one stack trace
 * that prints its config was enough.
 *
 * The tests below use keys shaped like the real ones but made of obvious filler,
 * so nothing here is a live credential.
 */

/**
 * The fixtures are assembled from parts on purpose.
 *
 * Written as literals they are shaped exactly like real credentials, and
 * GitHub's push protection blocks the whole push on one of them, which is the
 * scanner doing its job. Nothing here is a live secret either way.
 */
const j = (...parts: string[]) => parts.join('');
const FILLER = 'A'.repeat(40);
const JWT = j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.payload', '.sig');
const KEY = j('sk-', 'ant-', 'api03-', FILLER);

describe('redactSecrets', () => {
  it('takes the key out of an env dump, which is the reported path', () => {
    const out = redactSecrets(`ANTHROPIC_API_KEY=${KEY}\nHOME=/Users/you`);
    expect(out).not.toContain(KEY);
    expect(out).toContain('ANTHROPIC_API_KEY=');
    // The path beside it is untouched, so the dump is still readable.
    expect(out).toContain('HOME=/Users/you');
  });

  it('leaves enough of the value to tell which key it was', () => {
    const out = redactSecrets(KEY);
    expect(out).toContain('[redacted]');
    expect(out.startsWith('sk-a')).toBe(true);
  });

  it('catches the vendor prefixes on their own, mid sentence', () => {
    const samples = [
      KEY,
      j('sk-', 'proj-', 'B'.repeat(28)),
      j('AIza', 'C'.repeat(31)),
      j('ghp', '_', 'D'.repeat(30)),
      j('xox', 'b-', '111111111-', 'E'.repeat(16)),
      j('sk-', 'or-', 'v1-', 'F'.repeat(26)),
      j('AKIA', 'IOSFODNN7EXAMPLE'),
    ];
    for (const s of samples) {
      const out = redactSecrets(`the call failed with ${s} in the header`);
      expect(out, s).not.toContain(s);
    }
  });

  it('takes out a Discord bot token, all three parts of it', () => {
    // The bot's id in base64, a timestamp, then the signature: what Settings > Discord holds.
    const token = j('MTA5ODc2NTQzMjEwOTg3NjU0', '.', 'GaBcDe', '.', 'G'.repeat(38));
    const out = redactSecrets(`login failed for ${token} (401)`);
    expect(out).not.toContain(token);
    expect(out).toContain('login failed for');
    expect(out).toContain('[redacted]');
  });

  it('takes out a Discord token for a bot id of any length, and either signature length', () => {
    // QA, gate of #193. Bot ids of 17, 19 and 20 digits read as 23, 26 and 27
    // base64 characters; ids made since 2022 have 19. Older signatures have 27
    // characters, newer ones 38. Written where no other rule would catch them.
    const tokens = [
      j('OTg3NjU0MzIxMDk4NzY1NDM', '.', 'GaBcDe', '.', 'h'.repeat(27)),
      j('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', '.', 'GxYz12', '.', 'k'.repeat(38)),
      j('MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', '.', 'G_-abc', '.', 'Q'.repeat(27)),
    ];
    for (const token of tokens) {
      for (const line of [`login failed for ${token} (401)`, `> Authorization: Bot ${token}`]) {
        const out = redactSecrets(line);
        expect(out, line.slice(0, 40)).not.toContain(token);
        expect(out).toContain('[redacted]');
      }
    }
  });

  it('catches a bearer token and an api-key header from a verbose curl', () => {
    const curl = [
      `> Authorization: Bearer ${JWT}`,
      '> x-api-key: 7bQ2xLmR9vTkA4pZ0nWy',
    ].join('\n');
    const out = redactSecrets(curl);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('7bQ2xLmR9vTkA4pZ0nWy');
    // The header names survive, so the trace still says what it was doing.
    expect(out).toContain('Authorization: Bearer');
    expect(out).toContain('x-api-key:');
  });

  it('catches a settings file printed into the terminal', () => {
    const json = '{"deepSeekApiKey":"ds3Kq8ZmR2vX7bTnL4pWyE","defaultProjectPath":"/Users/you/proj"}';
    const out = redactSecrets(json);
    expect(out).not.toContain('ds3Kq8ZmR2vX7bTnL4pWyE');
    expect(out).toContain('/Users/you/proj');
  });

  it('catches a telegram bot token, which is itself a credential', () => {
    const token = j('123456789', ':', 'AA', 'F'.repeat(33));
    expect(redactSecrets(`token=${token}`)).not.toContain(token);
  });

  it('treats a run of one repeated character as a hand-written placeholder', () => {
    // This is deliberate: `API_KEY=xxxxxxxxxxxx` in a README or a template is
    // not a secret, and redacting it makes the redaction read as noise.
    expect(redactSecrets('API_KEY=xxxxxxxxxxxxxxxx')).toBe('API_KEY=xxxxxxxxxxxxxxxx');
  });

  it('takes the password out of a URL, as a database command line carries it (the Audit\'s L2 on #537)', () => {
    const out = redactSecrets('psql postgres://app:hunter2secret@db.local:5432/x && git clone https://me:tok@github.com/o/r');
    expect(out).not.toContain('hunter2secret');
    expect(out).not.toContain(':tok@');
    expect(out).toContain('postgres://app:');
    expect(out).toContain('@db.local:5432/x');
  });

  it('leaves ordinary output alone', () => {
    const prose = [
      'Reading src/app/usage/page.tsx',
      'The API key is set in Settings, under AI Providers.',
      'export API_KEY=not-set',
      'TOKEN=undefined',
      'GITHUB_TOKEN=/Users/you/.config/gh/hosts.yml',
      'password: xxxxxxxx',
    ].join('\n');
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not choke on an empty or huge buffer', () => {
    expect(redactSecrets('')).toBe('');
    const big = 'line of ordinary output\n'.repeat(5000);
    expect(redactSecrets(big)).toBe(big);
  });

  it('redacts every occurrence, not only the first', () => {
    const out = redactSecrets(`${KEY} and again ${KEY}`);
    expect(out).not.toContain(KEY);
    expect(out.match(/\[redacted\]/g)?.length).toBe(2);
  });

  it('containsSecret answers the same question without rewriting', () => {
    expect(containsSecret(`ANTHROPIC_API_KEY=${KEY}`)).toBe(true);
    expect(containsSecret('nothing to see here')).toBe(false);
  });
});

/**
 * A private key (the Audit's L1 on #588): since 2.0.7 a permission question holds a file's new content, and a teammate
 * reads its first 2,000 characters through get_agent, which an RSA 2048 key (about 1,700) or an ed25519 one (about
 * 400) fits in. How it fails, written before the code:
 * 1. A PEM private key block is no shape the rules know: it reads whole.
 * 2. Its four first and last characters are kept, as for a token: a key's body is masked whole, its BEGIN and END
 *    lines kept so the reader knows what it was.
 * 3. A block cut before its END (a view's 2,000 characters of a longer key) is left: it is masked to the end.
 * 4. Each kind is missed but one: RSA, EC, DSA, OPENSSH, a plain or ENCRYPTED PRIVATE KEY, a PGP PRIVATE KEY BLOCK.
 * 5. What is between two keys, or a public key or a certificate, is masked too: only a private key's body goes.
 */
describe('a private key', () => {
  const body = j('MIIEowIBAAKCAQEA', 'q'.repeat(60), '\n', 'r'.repeat(64), '\n', 's'.repeat(40));
  const block = (kind: string) => j('-----BEGIN ', kind, '-----\n', body, '\n-----END ', kind, '-----');
  const KINDS = ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'];

  it('1, 2, 4. masks the body of every kind whole, keeping its BEGIN and END lines', () => {
    for (const kind of KINDS) {
      const out = redactSecrets(`a key:\n${block(kind)}\nend of file`);
      expect(out, kind).toBe(j('a key:\n-----BEGIN ', kind, '-----\n[redacted]\n-----END ', kind, '-----\nend of file'));
    }
  });

  it('3. masks a block cut before its END to the end of the text', () => {
    const cut = block('RSA PRIVATE KEY').slice(0, 90);
    const out = redactSecrets(`config:\n${cut}`);
    expect(out).toBe('config:\n-----BEGIN RSA PRIVATE KEY-----\n[redacted]');
  });

  it('5. keeps what lies between two keys, a public key and a certificate', () => {
    const pub = j('-----BEGIN PUBLIC KEY-----\n', 'MFkwEwYHKoZIzj0CAQYI', '\n-----END PUBLIC KEY-----');
    const cert = j('-----BEGIN CERTIFICATE-----\n', 'MIIBszCCAVmgAwIBAgIU', '\n-----END CERTIFICATE-----');
    const out = redactSecrets([block('EC PRIVATE KEY'), 'between', pub, cert, block('OPENSSH PRIVATE KEY')].join('\n'));
    expect(out).toContain('\nbetween\n');
    expect(out).toContain(pub);
    expect(out).toContain(cert);
    expect(out).not.toContain('q'.repeat(60));
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
  });
});
