import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hermesDesktopConfigPath, tailscaleCandidates, tasmaniaTokenPath } from '../../../electron/platform';
import type { FsProbe } from '../../../electron/platform';
import { moveTestHome } from '../../setup/test-home';

/**
 * Where three integrations live on each platform. Each looked only where
 * macOS puts it:
 *
 * - Hermes Desktop's connection.json, which Settings > Hermes imports. Hermes
 *   Desktop is Electron and ships for Windows; its userData is
 *   `app.getPath('appData')/Hermes` (apps/desktop/electron/product-identity.ts
 *   in NousResearch/hermes-agent), which is %APPDATA%\Hermes on Windows, the
 *   path its own e2e spec names (apps/desktop/e2e/at-rest-connection-token.spec.ts).
 * - the tailscale CLI, which Settings > Hermes runs for the tailnet name. On
 *   Windows it is tailscale.exe in the install folder, `C:\Program Files\Tailscale`
 *   by default (tailscale.com/kb/1189/install-windows-msi), and is often not on
 *   the PATH Tars inherited.
 * - Tasmania's Control API token. Tasmania (mbaril010/tasmania) is a macOS app:
 *   its README requires macOS and its only maker is darwin. There is nothing to
 *   find on Windows, so Tars says so instead of guessing a folder.
 *
 * How it can fail, written before the code:
 * 1. win32: Hermes Desktop's connection.json in %APPDATA%\Hermes is not found
 *    (still looked for under ~/Library/Application Support);
 * 2. win32: with no APPDATA, the default %USERPROFILE%\AppData\Roaming is not
 *    used, or a relative APPDATA is trusted;
 * 3. win32: tailscale.exe in %ProgramFiles%\Tailscale, off the PATH, is not found;
 * 4. win32: tailscale.exe on the PATH is not found first, or is listed twice;
 * 5. win32: a bare `tailscale` is handed to execFile, which on Windows also
 *    searches the current directory, or a non-exe (the sh shim, a .cmd) is;
 * 6. win32: no Tailscale installed gives a candidate anyway (a guessed path),
 *    or a ProgramFiles that is unset or relative is used;
 * 7. win32: Tasmania resolves to a token path at all, or its message does not
 *    say why (a macOS app, no Windows build);
 * 8. win32: a Tasmania request is still sent to localhost:3999 unauthenticated;
 * 9. darwin/linux: any of the three differs from before, to the byte (pinned
 *    with POSIX path semantics in integration-paths-posix.test.ts);
 * 10. darwin: a token file in the home is not read, or an absent one is not
 *    the clean null it was;
 * 11. the real import handler on win32 does not read the file from %APPDATA%,
 *    or an absent install is not the clean "not found" answer.
 */

const W = path.win32;

/** An in-memory disk, so the win32 rules run on any host: file names, or names to contents. */
function memFs(files: string[] | Record<string, string>): FsProbe {
  const entries = Array.isArray(files) ? files.map((f) => [f, ''] as const) : Object.entries(files);
  const byName = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p) => byName.has(p.toLowerCase()),
    readFile: (p) => {
      const text = byName.get(p.toLowerCase());
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
  };
}

describe('Hermes Desktop connection.json', () => {
  it('1. win32: under %APPDATA%\\Hermes', () => {
    expect(hermesDesktopConfigPath({ platform: 'win32', home: 'C:\\Users\\n', env: { APPDATA: 'D:\\Roam' } }))
      .toBe('D:\\Roam\\Hermes\\connection.json');
  });

  it('2. win32: the default roaming folder when APPDATA is unset or not absolute', () => {
    for (const env of [{}, { APPDATA: 'Roam' }, { APPDATA: '' }]) {
      expect(hermesDesktopConfigPath({ platform: 'win32', home: 'C:\\Users\\n', env }), JSON.stringify(env))
        .toBe('C:\\Users\\n\\AppData\\Roaming\\Hermes\\connection.json');
    }
  });
});

describe('the tailscale CLI', () => {
  const PF = 'C:\\Program Files';
  const INSTALLED = `${PF}\\Tailscale\\tailscale.exe`;

  it('3. win32: tailscale.exe in the install folder, off the PATH', () => {
    const env = { ProgramFiles: PF, PATH: 'C:\\Windows\\System32' };
    expect(tailscaleCandidates({ platform: 'win32', env, fs: memFs([INSTALLED]) })).toEqual([INSTALLED]);
  });

  it('4. win32: the PATH first, then the install folder, once each', () => {
    const onPath = 'D:\\tools\\tailscale.exe';
    const env = { ProgramFiles: PF, PATH: `D:\\tools;${PF}\\Tailscale` };
    expect(tailscaleCandidates({ platform: 'win32', env, fs: memFs([onPath, INSTALLED]) })).toEqual([onPath, INSTALLED]);
    const both = { ProgramFiles: PF, PATH: `${PF}\\Tailscale` };
    expect(tailscaleCandidates({ platform: 'win32', env: both, fs: memFs([INSTALLED]) })).toEqual([INSTALLED]);
  });

  it('5. win32: never a bare name, never a shim or a script', () => {
    const env = { ProgramFiles: PF, PATH: 'D:\\npm' };
    const shims = memFs(['D:\\npm\\tailscale', 'D:\\npm\\tailscale.cmd', `${PF}\\Tailscale\\tailscale`]);
    expect(tailscaleCandidates({ platform: 'win32', env, fs: shims })).toEqual([]);
    // An npm shim the resolver reads through to node.exe and a script: node is not tailscale.
    const nodeShim = memFs({
      'D:\\npm\\tailscale.cmd': '@"%~dp0\\node.exe"  "%~dp0\\node_modules\\ts\\cli.js" %*\r\n',
      'D:\\npm\\node.exe': '',
      'D:\\npm\\node_modules\\ts\\cli.js': '',
    });
    expect(tailscaleCandidates({ platform: 'win32', env, fs: nodeShim })).toEqual([]);
  });

  it('6. win32: nothing installed, or no usable ProgramFiles: no candidate at all', () => {
    expect(tailscaleCandidates({ platform: 'win32', env: { ProgramFiles: PF, PATH: 'C:\\x' }, fs: memFs([]) })).toEqual([]);
    for (const env of [{}, { ProgramFiles: 'Program Files' }]) {
      expect(tailscaleCandidates({ platform: 'win32', env, fs: memFs([INSTALLED, 'Program Files\\Tailscale\\tailscale.exe']) }), JSON.stringify(env)).toEqual([]);
    }
  });

});

describe('the Tasmania Control API token', () => {
  it('7. win32: no path, and a reason that says why', () => {
    const where = tasmaniaTokenPath({ platform: 'win32', home: 'C:\\Users\\n' });
    expect(where.ok).toBe(false);
    if (!where.ok) expect(where.detail).toMatch(/macOS.*no Windows build/);
  });
});

// ── The real consumers, on real files in the sandbox home ─────────────────────

const HOST = process.platform;
const as = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true });

describe('the Tasmania client', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    vi.resetModules();
    globalThis.fetch = (async () => { calls++; return new Response('{"status":"running"}', { status: 200 }); }) as typeof fetch;
  });
  afterEach(() => { as(HOST); globalThis.fetch = realFetch; });

  it('8. win32: nothing is sent, and the refusal says why', async () => {
    as('win32');
    const client = await import('../../../electron/services/tasmania-client');
    expect(client.getAuthToken()).toBeNull();
    await expect(client.tasmaniaFetch('/api/status')).rejects.toThrow(/macOS.*no Windows build/);
    expect((await client.getTasmaniaStatus()).status).toBe('stopped');
    expect(calls).toBe(0);
  });

  it('10. darwin: the token file in the home is read; without it, null, as before', async () => {
    as('darwin');
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Tasmania', '.control-api-token');
    fs.rmSync(file, { force: true });
    const client = await import('../../../electron/services/tasmania-client');
    expect(client.getAuthToken()).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'tok-123\n');
    try {
      expect(client.getAuthToken()).toBe('tok-123');
      await client.tasmaniaFetch('/api/status');
      expect(calls).toBe(1);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, fn); } },
}));

describe.runIf(HOST === 'win32')('11. the Hermes Desktop import, on this Windows machine', () => {
  const config = () => W.join(process.env.APPDATA!, 'Hermes', 'connection.json');
  const call = (channel: string) => handlers.get(channel)!({});
  // %APPDATA% in the suite's throwaway home, with the rest of the profile
  // (test-home.ts), before the handlers read it: never the machine's own
  // Hermes Desktop folder, which afterEach removes.
  let restoreProfile = () => {};
  // The handlers' module graph is large: loaded once, with the time it takes.
  beforeAll(async () => {
    restoreProfile = moveTestHome(os.homedir());
    vi.resetModules();
    handlers.clear();
    (await import('../../../electron/handlers/hermes-handlers')).registerHermesHandlers();
  }, 120_000);
  afterEach(() => { fs.rmSync(W.dirname(config()), { recursive: true, force: true }); });
  afterAll(() => restoreProfile());

  it('reads %APPDATA%\\Hermes\\connection.json', async () => {
    fs.mkdirSync(W.dirname(config()), { recursive: true });
    fs.writeFileSync(config(), JSON.stringify({ mode: 'remote', remote: { url: 'https://hermes.example.ts.net' } }));
    expect((await call('hermes:connection:get') as { desktopConfigAvailable: boolean }).desktopConfigAvailable).toBe(true);
    const imported = await call('hermes:connection:import') as { success: boolean; connection?: { mode: string; url?: string } };
    expect(imported.success).toBe(true);
    expect(imported.connection).toMatchObject({ mode: 'remote', url: 'https://hermes.example.ts.net' });
  });

  it('without Hermes Desktop: the clean "not found" answer', async () => {
    expect((await call('hermes:connection:get') as { desktopConfigAvailable: boolean }).desktopConfigAvailable).toBe(false);
    expect(await call('hermes:connection:import')).toEqual({ success: false, error: 'No Hermes Desktop configuration found on this machine.' });
  });
});

describe.runIf(HOST === 'win32')('3, 6. tailscale.exe on this Windows machine, real files', () => {
  it('found in a sandbox ProgramFiles, off the PATH; absent, nothing', () => {
    const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-ts-pf-'));
    try {
      const env = { ProgramFiles: pf, PATH: pf };
      expect(tailscaleCandidates({ platform: 'win32', env })).toEqual([]);
      fs.mkdirSync(W.join(pf, 'Tailscale'));
      fs.writeFileSync(W.join(pf, 'Tailscale', 'tailscale.exe'), '');
      expect(tailscaleCandidates({ platform: 'win32', env })).toEqual([W.join(pf, 'Tailscale', 'tailscale.exe')]);
    } finally {
      fs.rmSync(pf, { recursive: true, force: true });
    }
  });
});
