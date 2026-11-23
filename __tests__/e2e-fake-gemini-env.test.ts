import { describe, it, expect } from 'vitest';
import { geminiInherited } from '../e2e/fake-clis.mjs';

/**
 * What the stand-in gemini (e2e/fake-clis.mjs) hands an MCP server of its environment, against gemini 0.70.0.
 *
 * The CLI matrix believes the stand-in: if it hands a server what the real gemini withholds, a cell is green that a
 * user would see red. Two sources: the probe Backend-5 ran on the real gemini 0.70.0 on 2026-11-23
 * (reports/cli-matrix/gemini-mcp-token-2026-11-23/real-gemini-probe, `gemini -p` starting stand-in servers that
 * recorded what they got), and the rule in its bundle (environmentSanitization, `shouldRedactEnvironmentVariable`,
 * read by QA the same day; identical in every chunk of the bundle).
 *
 * How it can fail, written by QA on 2026-11-23 before the code:
 * 1. A name like TOKEN reaches a server with no allow-list (the probe, none/inherit: no CLAUDE_MGR_API_TOKEN), or a
 *    name of gemini's own list (PASSWD, CREDS, PRIVATE, CERT) does.
 * 2. A name the settings allow is withheld (the probe, allowed/inherit: the token), or the allow-list is read
 *    case-sensitively (0.70.0 upper-cases both sides).
 * 3. A name starting GEMINI_CLI_ is withheld (the probe: GEMINI_CLI_TARS_PROBE, the token's value, reached every
 *    server), or a plain name is (TARS_PROBE_PLAIN reached every server).
 * 4. A value shaped like a secret (a JWT, a PEM key, a GitHub, Google, AWS, Stripe or Slack key, credentials in a URL)
 *    reaches a server because its name is allowed: 0.70.0 checks the value before the allow-list.
 * 5. One of the twelve names 0.70.0 always withholds (DATABASE_URL, CLIENT_ID...) reaches a server.
 * 6. A name the settings block reaches a server (security.environmentVariableRedaction.blocked).
 * 7. Stricter than gemini, which the matrix would read as Tars's fault: a GIT_CONFIG_ name, or one of the platform's
 *    own (PATH, HOME, TMPDIR...), withheld; or Tars's own names (CLAUDE_MGR_API_URL, CLAUDE_AGENT_ID) withheld.
 * Not modelled, on purpose: 0.70.0's strict mode under GitHub Actions (GITHUB_SHA set, or SURFACE=Github), which
 * withholds every name not allowed; nobody runs Tars there, and the CI runs specs that use this stand-in.
 */

const TOKEN = 'edac41'.padEnd(64, '7');
const ALLOWED = { security: { environmentVariableRedaction: { allowed: ['CLAUDE_MGR_API_TOKEN'] } } };
const PROBE = {
  CLAUDE_MGR_API_TOKEN: TOKEN, CLAUDE_MGR_API_TOKEN_FILE: '/probe/token-file', GEMINI_CLI_TARS_PROBE: TOKEN,
  TARS_PROBE_PLAIN: 'plain-value', PATH: '/usr/bin:/bin', HOME: '/home/probe',
};

describe('the stand-in gemini hands an MCP server what gemini 0.70.0 does', () => {
  it('1: with no allow-list, the token and the names like it are withheld (the probe, none/inherit)', () => {
    const got = geminiInherited({ ...PROBE, DB_PASSWD: 'x', AWS_CREDS: 'x', MY_PRIVATE: 'x', SSL_CERT_FILE: 'x' }, {});
    expect(Object.keys(got).sort()).toEqual(['GEMINI_CLI_TARS_PROBE', 'HOME', 'PATH', 'TARS_PROBE_PLAIN']);
  });

  it('2: a name the settings allow reaches it, the allow-list read in any case (the probe, allowed/inherit)', () => {
    expect(geminiInherited(PROBE, ALLOWED).CLAUDE_MGR_API_TOKEN).toBe(TOKEN);
    const lower = { security: { environmentVariableRedaction: { allowed: ['claude_mgr_api_token'] } } };
    expect(geminiInherited(PROBE, lower).CLAUDE_MGR_API_TOKEN).toBe(TOKEN);
    expect(geminiInherited(PROBE, ALLOWED).CLAUDE_MGR_API_TOKEN_FILE, 'a name not allowed').toBeUndefined();
  });

  it('3: GEMINI_CLI_ names and plain names reach it (the probe, every server)', () => {
    const got = geminiInherited(PROBE, {});
    expect(got.GEMINI_CLI_TARS_PROBE).toBe(TOKEN);
    expect(got.TARS_PROBE_PLAIN).toBe('plain-value');
  });

  it('4: a value shaped like a secret is withheld even under an allowed name', () => {
    const shaped = [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0YXJzIn0.c2lnbmF0dXJl',
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN CERTIFICATE-----',
      `ghp_${'a'.repeat(36)}`,
      `AIzaSy${'b'.repeat(33)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `sk_live_${'c'.repeat(24)}`,
      'xoxb-123-abc',
      'https://user:pass@example.com/',
    ];
    for (const value of shaped) {
      expect(geminiInherited({ ...PROBE, CLAUDE_MGR_API_TOKEN: value }, ALLOWED).CLAUDE_MGR_API_TOKEN, value).toBeUndefined();
      expect(geminiInherited({ PLAIN_NAME: value }, {}).PLAIN_NAME, value).toBeUndefined();
    }
    expect(geminiInherited({ GEMINI_CLI_X: shaped[0] }, {}).GEMINI_CLI_X, 'GEMINI_CLI_ comes before the values').toBe(shaped[0]);
  });

  it('5: the twelve names gemini always withholds are withheld', () => {
    const never = ['CLIENT_ID', 'DB_URI', 'CONNECTION_STRING', 'AWS_DEFAULT_REGION', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID',
      'SLACK_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID', 'DATABASE_URL', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_ACCOUNT', 'FIREBASE_PROJECT_ID'];
    expect(geminiInherited(Object.fromEntries(never.map((k) => [k, 'x'])), {})).toEqual({});
  });

  it('6: a name the settings block is withheld', () => {
    const blocked = { security: { environmentVariableRedaction: { blocked: ['tars_probe_plain'] } } };
    expect(geminiInherited(PROBE, blocked).TARS_PROBE_PLAIN).toBeUndefined();
  });

  it("7: no stricter than gemini: GIT_CONFIG_ names, the platform's own and Tars's own reach it", () => {
    const env = { GIT_CONFIG_KEY_0: 'user.name', PATH: '/bin', HOME: '/h', TMPDIR: '/t', CLAUDE_MGR_API_URL: 'http://127.0.0.1:31415',
      CLAUDE_AGENT_ID: 'dddd4444-0000-4000-8000-0000000000a1', CLAUDE_PROJECT_PATH: '/Users/someone/project', TARS_CHATS_READ: '1' };
    expect(geminiInherited(env, {})).toEqual(env);
  });
});
