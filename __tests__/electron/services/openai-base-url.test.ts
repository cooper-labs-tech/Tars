import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { isValidOpenAIBaseUrl as mainProcess } from '../../../electron/providers/cli-provider';
import { isValidOpenAIBaseUrl as renderer } from '../../../src/lib/validateUrl';

/**
 * The base URL a user types for a custom OpenAI-compatible vendor.
 *
 * Whatever it names gets called with the stored vendor key attached, so the
 * check is a security boundary rather than a formatting nicety. It started as
 * "parses, and is http or https", which accepted 169.254.169.254 - the address
 * every major cloud parks its instance metadata service on. It also accepted
 * credentials embedded in the URL, which would then travel to that host and
 * into logs.
 *
 * The rule lives in two files because the renderer cannot import from
 * electron/. Both are run against the same table here, so the copies cannot
 * drift into disagreeing about what is safe.
 */

const CASES: { url: string; ok: boolean; why: string }[] = [
  // Real vendors.
  { url: 'https://api.openai.com/v1', ok: true, why: 'a hosted vendor' },
  { url: 'https://api.together.xyz/v1', ok: true, why: 'another hosted vendor' },
  { url: 'http://api.example.com/v1', ok: true, why: 'plain http is allowed, some self-hosted setups have no TLS' },

  // Self-hosted inference is the point of this provider, so these must pass.
  { url: 'http://127.0.0.1:1234/v1', ok: true, why: 'LM Studio on loopback' },
  { url: 'http://localhost:8000/v1', ok: true, why: 'vLLM on loopback' },
  { url: 'http://192.168.1.50:11434/v1', ok: true, why: 'a box on the LAN' },
  { url: 'http://10.0.0.5:8080', ok: true, why: 'a private range host' },

  // The attack this check exists for.
  { url: 'http://169.254.169.254/latest/meta-data/', ok: false, why: 'AWS instance metadata' },
  { url: 'http://169.254.169.254/computeMetadata/v1/', ok: false, why: 'GCP instance metadata' },
  { url: 'https://169.254.169.254', ok: false, why: 'metadata over https is still metadata' },
  { url: 'http://metadata.google.internal/computeMetadata/v1/', ok: false, why: 'the same service by name' },
  { url: 'http://[fe80::1]/v1', ok: false, why: 'IPv6 link-local' },

  // Credentials would be sent to the host and logged.
  { url: 'http://user:pass@169.254.169.254/', ok: false, why: 'credentials plus metadata' },
  { url: 'https://user:pass@api.example.com/v1', ok: false, why: 'credentials belong in the API key field' },

  // Not usable at all.
  { url: 'file:///etc/passwd', ok: false, why: 'not a fetchable scheme' },
  { url: 'ftp://example.com', ok: false, why: 'not a fetchable scheme' },
  { url: 'not a url', ok: false, why: 'does not parse' },
  { url: 'api.openai.com/v1', ok: false, why: 'a bare host does not parse as a URL' },
  { url: '', ok: false, why: 'empty' },
  { url: '   ', ok: false, why: 'blank' },
];

describe('the custom OpenAI base URL check', () => {
  for (const { url, ok, why } of CASES) {
    it(`${ok ? 'accepts' : 'rejects'} ${JSON.stringify(url)} (${why})`, () => {
      expect(mainProcess(url)).toBe(ok);
    });
  }

  it('rejects undefined', () => {
    expect(mainProcess(undefined)).toBe(false);
  });
});

describe('the two copies agree', () => {
  for (const { url } of CASES) {
    it(`agrees on ${JSON.stringify(url)}`, () => {
      expect(renderer(url)).toBe(mainProcess(url));
    });
  }

  it('agrees on undefined', () => {
    expect(renderer(undefined)).toBe(mainProcess(undefined));
  });
});
