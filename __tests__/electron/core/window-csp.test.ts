import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The window's Content Security Policy (electron/core/window-csp.ts), and where it is served
 * (electron/core/window-manager.ts). Written before the code: every way it can fail, then a test for each.
 *
 * The hashes of a page's inline scripts:
 *   H1. a hash is computed over the wrong text (with its attributes, its tags, or a CR LF the browser reads as
 *       LF), so Next's own bootstrap is refused and the page never comes alive;
 *   H2. a script with a src, which is the bundle's file, is hashed and its text allowed inline too; or a script
 *       whose only "src" is part of another attribute (data-src) is taken for a file and left unhashed;
 *   H3. an upper-case tag, or several scripts, are missed;
 *   H4. the same script twice is listed twice (harmless, but the header grows with every repeat).
 * The policy:
 *   P1. the packaged policy lets a script run that the bundle does not carry: 'unsafe-inline', 'unsafe-eval',
 *       a scheme or a host in script-src, or anything but sha256 sources (a "hash" that closes the directive
 *       and opens another, `'sha256-x'; script-src *`);
 *   P2. one of object-src, base-uri, frame-ancestors, form-action is missing or allows something, or a
 *       directive has no default to fall back to (default-src missing);
 *   P3. a directive takes a whole scheme (https:, http:) or any host (*);
 *   P4. the window loses what it needs: the local API's pictures (its port), the marketplace's lists, data:
 *       and blob: pictures, the manifest;
 *   P5. a port that is not a port goes into the header as written;
 *   P6. development: next dev's inline scripts, eval or refresh socket are refused (next dev breaks), or the
 *       development policy differs from the packaged one anywhere else, so a picture or a connection the
 *       packaged build refuses works in development and nobody sees it before a release;
 *   P7. the header carries a line break, which no header may.
 * Where it is served:
 *   S1. the packaged app:// handler serves a page without the policy, or with another page's hashes, or the
 *       page-route fallback (/agents served from agents/index.html) without it;
 *   S2. the policy is set on a script, a stylesheet or a picture, where it means nothing;
 *   S3. development: next dev's pages get no policy, a sub-resource gets one, another origin's response gets
 *       one, or a policy next dev sent under another spelling of the header's name stays beside ours.
 */

const handlers = vi.hoisted(() => ({
  app: undefined as undefined | ((request: Request) => Promise<Response>),
  headers: undefined as undefined | ((details: unknown, callback: (response: unknown) => void) => void),
}));
const appPath = vi.hoisted(() => ({ value: '' }));

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => appPath.value, getPath: () => '/mock' },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn() },
  protocol: {
    handle: vi.fn((scheme: string, fn: (request: Request) => Promise<Response>) => {
      if (scheme === 'app') handlers.app = fn;
    }),
    registerSchemesAsPrivileged: vi.fn(),
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn((fn: (details: unknown, callback: (response: unknown) => void) => void) => {
          handlers.headers = fn;
        }),
      },
    },
  },
  shell: { openExternal: vi.fn() },
}));

import { inlineScriptHashes, windowCsp } from '../../../electron/core/window-csp';
import { setupProtocolHandler } from '../../../electron/core/window-manager';
import { API_PORT } from '../../../electron/constants';

/** The CSP specification's own example: <script>alert('Hello, world.');</script>. */
const HELLO = "'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='";
/** sha256 of "a\nb". */
const A_LF_B = "'sha256-fhj3NzEbLcOy8mndeDlrA1HxT7Zu+oefdoyyMYGIPHg='";

const directivesOf = (policy: string) =>
  new Map(policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/);
    return [name, sources] as const;
  }));

describe('inlineScriptHashes', () => {
  it('H1: hashes the script text alone, as the CSP specification does', () => {
    expect(inlineScriptHashes("<p>x</p><script>alert('Hello, world.');</script>")).toEqual([HELLO]);
    expect(inlineScriptHashes(`<script id="_R_" data-x="1">alert('Hello, world.');</script >`)).toEqual([HELLO]);
  });

  it('H1: reads CR LF and a lone CR as LF, as the HTML parser does', () => {
    expect(inlineScriptHashes('<script>a\r\nb</script>')).toEqual([A_LF_B]);
    expect(inlineScriptHashes('<script>a\rb</script>')).toEqual([A_LF_B]);
  });

  it('H2: leaves a script with a src unhashed, and hashes one whose src is only part of another attribute', () => {
    expect(inlineScriptHashes('<script src="/_next/static/chunks/a.js" async></script>')).toEqual([]);
    expect(inlineScriptHashes('<script async\nsrc="/a.js"></script>')).toEqual([]);
    expect(inlineScriptHashes(`<script data-src="/a.js">alert('Hello, world.');</script>`)).toEqual([HELLO]);
  });

  it('H3: finds every script, whatever the case of its tag', () => {
    expect(inlineScriptHashes(`<SCRIPT>alert('Hello, world.');</SCRIPT><script>a\nb</script>`)).toEqual([HELLO, A_LF_B]);
  });

  it('H4: lists a script carried twice once', () => {
    expect(inlineScriptHashes('<script>a\nb</script><script>a\r\nb</script>')).toEqual([A_LF_B]);
  });
});

describe('windowCsp, packaged', () => {
  const policy = windowCsp({ apiPort: 31415, scriptHashes: [HELLO, A_LF_B] });
  const directives = directivesOf(policy);

  it('P1: runs the bundle\'s files and the page\'s own inline scripts, nothing else', () => {
    expect(directives.get('script-src')).toEqual(["'self'", HELLO, A_LF_B]);
  });

  it('P1: drops anything offered as a hash that is not one', () => {
    const forged = directivesOf(windowCsp({ apiPort: 31415, scriptHashes: [HELLO, "'sha256-x'; script-src *", "'unsafe-inline'", 'https://cdn.example'] }));
    expect(forged.get('script-src')).toEqual(["'self'", HELLO]);
    expect([...forged.keys()].filter((name) => name === 'script-src')).toHaveLength(1);
  });

  it('P2: takes no plugin, base URL, form target or frame parent, and defaults to nothing', () => {
    for (const name of ['default-src', 'object-src', 'base-uri', 'frame-ancestors', 'form-action', 'worker-src']) {
      expect(directives.get(name), name).toEqual(["'none'"]);
    }
  });

  it('P3: no directive takes a whole scheme or any host', () => {
    for (const [name, sources] of directives) {
      for (const source of sources) expect(source, `${name} ${source}`).not.toMatch(/^(\*|https?:|wss?:|file:|app:|local-file:)$/);
    }
  });

  it('P4: keeps what the window loads: the API\'s pictures, data: and blob: pictures, the marketplace, the manifest', () => {
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'http://127.0.0.1:31415']);
    expect(directives.get('connect-src')).toEqual(["'self'", 'https://raw.githubusercontent.com']);
    expect(directives.get('font-src')).toEqual(["'self'"]);
    expect(directives.get('manifest-src')).toEqual(["'self'"]);
    expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('P4: follows the port the API answers on', () => {
    expect(directivesOf(windowCsp({ apiPort: 31499 })).get('img-src')).toContain('http://127.0.0.1:31499');
  });

  it('P5: leaves out a port that is not one', () => {
    for (const apiPort of [Number.NaN, 0, -1, 70000, 3.5]) {
      expect(directivesOf(windowCsp({ apiPort })).get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    }
  });

  it('P7: is one line', () => {
    expect(policy).not.toMatch(/[\r\n]/);
  });
});

describe('windowCsp, development', () => {
  const packaged = directivesOf(windowCsp({ apiPort: 31415 }));
  const dev = directivesOf(windowCsp({ apiPort: 31415, devOrigin: 'http://localhost:3100' }));

  it('P6: takes next dev\'s inline scripts, eval and refresh socket', () => {
    expect(dev.get('script-src')).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
    expect(dev.get('connect-src')).toEqual(["'self'", 'https://raw.githubusercontent.com', 'ws://localhost:3100']);
  });

  it('P6: differs from the packaged policy there and nowhere else', () => {
    expect([...dev.keys()]).toEqual([...packaged.keys()]);
    for (const [name, sources] of packaged) {
      if (name === 'script-src' || name === 'connect-src') continue;
      expect(dev.get(name), name).toEqual(sources);
    }
  });

  it('P6: hands no socket to an origin that is not an http one', () => {
    expect(directivesOf(windowCsp({ apiPort: 31415, devOrigin: 'not a url' })).get('connect-src')).toEqual(["'self'", 'https://raw.githubusercontent.com']);
  });
});

describe('where the policy is served', () => {
  let root: string;
  const page = `<!DOCTYPE html><html><head><script>alert('Hello, world.');</script><script src="/_next/static/chunks/a.js"></script></head><body></body></html>`;
  const routePage = '<html><body><script>a\nb</script></body></html>';

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'window-csp-'));
    fs.mkdirSync(path.join(root, 'out', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out', '_next', 'static', 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'index.html'), page);
    fs.writeFileSync(path.join(root, 'out', 'agents', 'index.html'), routePage);
    fs.writeFileSync(path.join(root, 'out', '_next', 'static', 'chunks', 'a.js'), 'window.a = 1;');
    appPath.value = root;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('packaged', () => {
    beforeEach(async () => {
      const electron = await import('electron');
      (electron.app as unknown as { isPackaged: boolean }).isPackaged = true;
      handlers.app = undefined;
      setupProtocolHandler();
    });

    const get = (url: string) => handlers.app!({ url } as Request);

    it('S1: serves a page with the policy and that page\'s own hashes', async () => {
      const response = await get('app://-/index.html');
      const policy = response.headers.get('content-security-policy');
      expect(policy).toBe(windowCsp({ apiPort: API_PORT, scriptHashes: [HELLO] }));
      expect(await response.text()).toBe(page);
    });

    it('S1: serves the root and a page route with theirs', async () => {
      expect((await get('app://-/')).headers.get('content-security-policy')).toBe(windowCsp({ apiPort: API_PORT, scriptHashes: [HELLO] }));
      expect((await get('app://-/agents/')).headers.get('content-security-policy')).toBe(windowCsp({ apiPort: API_PORT, scriptHashes: [A_LF_B] }));
      expect((await get('app://-/agents')).headers.get('content-security-policy')).toBe(windowCsp({ apiPort: API_PORT, scriptHashes: [A_LF_B] }));
    });

    it('S2: sets nothing on a script', async () => {
      const response = await get('app://-/_next/static/chunks/a.js');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toBeNull();
    });
  });

  describe('development', () => {
    const DEV = 'http://localhost:3100';

    beforeEach(async () => {
      const electron = await import('electron');
      (electron.app as unknown as { isPackaged: boolean }).isPackaged = false;
      process.env.DOROTHY_DEV_URL = DEV;
      handlers.headers = undefined;
      setupProtocolHandler();
    });

    afterEach(() => {
      delete process.env.DOROTHY_DEV_URL;
    });

    const received = (details: Record<string, unknown>) =>
      new Promise<{ responseHeaders?: Record<string, string[]> }>((resolve) => handlers.headers!(details, resolve as (response: unknown) => void));

    it('S3: sets the development policy on next dev\'s pages, over any it sent', async () => {
      const response = await received({ url: `${DEV}/agents`, resourceType: 'mainFrame', responseHeaders: { 'content-security-policy': ["default-src *"], 'Content-Type': ['text/html'] } });
      expect(response.responseHeaders?.['Content-Security-Policy']).toEqual([windowCsp({ apiPort: API_PORT, devOrigin: DEV })]);
      expect(response.responseHeaders?.['content-security-policy']).toBeUndefined();
      expect(response.responseHeaders?.['Content-Type']).toEqual(['text/html']);
    });

    it('S3: leaves a sub-resource and another origin as they came', async () => {
      const script = await received({ url: `${DEV}/_next/static/chunks/a.js`, resourceType: 'script', responseHeaders: { 'Content-Type': ['text/javascript'] } });
      expect(script.responseHeaders).toBeUndefined();
      const other = await received({ url: 'http://localhost:3999/', resourceType: 'mainFrame', responseHeaders: {} });
      expect(other.responseHeaders).toBeUndefined();
    });
  });
});
