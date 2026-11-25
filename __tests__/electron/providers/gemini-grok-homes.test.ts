import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { pinPlatform } from './win-fake-disk';

/**
 * gemini's and grok's own homes, where Tars writes their settings, hooks, MCP servers and trust, and which it hands to
 * the CLI it starts, as it does codex's CODEX_HOME (codex-cli.ts, codexHome; codex-provider.ts).
 *
 * Measured, isolated, on 24/11: gemini 0.70.0 takes its home from GEMINI_CLI_HOME before HOME (its paths.ts
 * homedir()), its folder being $GEMINI_CLI_HOME/.gemini; grok 1.0.92 takes GROK_HOME in place of ~/.grok (`grok mcp add`
 * wrote $GROK_HOME/config.toml, its docs and logs went there too), and only reads the overlay GROK_CONFIG_PATH names
 * (`grok mcp add` still wrote ~/.grok/config.toml, the overlay unchanged).
 *
 * How it fails, written before the code (25/11):
 * 1. gemini's folder taken as ~/.gemini whatever GEMINI_CLI_HOME says: Tars's settings, hooks, MCP servers and trust
 *    land where that gemini never reads them, and it runs without any of them.
 * 2. grok's taken as ~/.grok whatever GROK_HOME says, the same.
 * 3. The home not handed to the CLI Tars starts: an rc file of the agent's shell that sets another sends it elsewhere,
 *    as it did codex (the Audit's L4 on #465). On macOS and Linux in the line, which no rc file runs after.
 * 4. On Windows, where the line's first word is the binary itself and nothing is sourced (platform/launch.ts), the
 *    home not in the terminal's environment.
 * 5. A blank variable taken as a folder: it names none, and the default stands.
 * 6. GROK_CONFIG_PATH, or GROK_CONFIG, taken for grok's home, or handed on: each is a read-only overlay (a file, a
 *    JSON text; GROK_CONFIG wins over GROK_CONFIG_PATH, QA's measure on 1.0.92), and is left to the user.
 */

const saved = { ...process.env };
let unpin: () => void = () => undefined;

beforeEach(() => {
  vi.resetModules();
  delete process.env.GEMINI_CLI_HOME;
  delete process.env.GROK_HOME;
  delete process.env.GROK_CONFIG_PATH;
  delete process.env.GROK_CONFIG;
  unpin = pinPlatform('linux');
});
afterEach(() => {
  unpin();
  process.env = { ...saved };
});

const gemini = async () => new (await import('../../../electron/providers/gemini-provider')).GeminiProvider();
const grok = async () => new (await import('../../../electron/providers/grok-provider')).GrokProvider();
const line = (p: { buildInteractiveCommand(x: never): string }) => p.buildInteractiveCommand({ binaryPath: '/opt/bin/cli', prompt: 'go' } as never);
const oneShot = (p: { buildOneShotCommand(x: never): string }) => p.buildOneShotCommand({ binaryPath: '/opt/bin/cli', prompt: 'go' } as never);

describe('the homes as each CLI reads them (1, 2, 5, 6)', () => {
  it('gemini: GEMINI_CLI_HOME, else the home folder; its folder .gemini under it', async () => {
    const { geminiCliHome } = await import('../../../electron/providers/gemini-provider');
    expect(geminiCliHome({ GEMINI_CLI_HOME: '/srv/gem' }, '/home/me')).toBe('/srv/gem');
    expect(geminiCliHome({}, '/home/me')).toBe('/home/me');
    expect(geminiCliHome({ GEMINI_CLI_HOME: '  ' }, '/home/me')).toBe('/home/me');
    process.env.GEMINI_CLI_HOME = '/srv/gem';
    expect((await gemini()).configDir).toBe('/srv/gem/.gemini');
  });

  it('grok: GROK_HOME in place of ~/.grok, and never GROK_CONFIG_PATH', async () => {
    const { grokHome } = await import('../../../electron/providers/grok-provider');
    expect(grokHome({ GROK_HOME: '/srv/grok' }, '/home/me')).toBe('/srv/grok');
    expect(grokHome({}, '/home/me')).toBe('/home/me/.grok');
    expect(grokHome({ GROK_HOME: '' }, '/home/me')).toBe('/home/me/.grok');
    expect(grokHome({ GROK_CONFIG_PATH: '/srv/overlay.toml' }, '/home/me')).toBe('/home/me/.grok');
    process.env.GROK_HOME = '/srv/grok';
    expect((await grok()).configDir).toBe('/srv/grok');
  });
});

describe('the home handed to the CLI Tars starts (3, 4, 6)', () => {
  it('on macOS and Linux, on the line ahead of the binary, its one-shot line too', async () => {
    process.env.GEMINI_CLI_HOME = '/srv/gem';
    process.env.GROK_HOME = '/srv/grok';
    expect(line(await gemini())).toMatch(/^env GEMINI_CLI_HOME='\/srv\/gem' '\/opt\/bin\/cli'/);
    expect(oneShot(await gemini())).toMatch(/^env GEMINI_CLI_HOME='\/srv\/gem' '\/opt\/bin\/cli'/);
    expect(line(await grok())).toMatch(/^env GROK_HOME='\/srv\/grok' '\/opt\/bin\/cli'/);
    expect(oneShot(await grok())).toMatch(/^env GROK_HOME='\/srv\/grok' '\/opt\/bin\/cli'/);
  });

  it('the default home handed too, so an rc file sends neither elsewhere', async () => {
    const os = await import('os');
    expect(line(await gemini())).toContain(`env GEMINI_CLI_HOME='${os.homedir()}'`);
    expect(line(await grok())).toContain(`env GROK_HOME='${os.homedir()}/.grok'`);
  });

  it("on Windows, in the terminal's environment, the line starting with the binary", async () => {
    unpin();
    unpin = pinPlatform('win32');
    process.env.GEMINI_CLI_HOME = 'C:\\srv\\gem';
    process.env.GROK_HOME = 'C:\\srv\\grok';
    const g = await gemini();
    const k = await grok();
    expect(line(g)).toMatch(/^'\/opt\/bin\/cli'/);
    expect(line(k)).toMatch(/^'\/opt\/bin\/cli'/);
    expect(g.getPtyEnvVars('a1', '/p', [])).toMatchObject({ GEMINI_CLI_HOME: 'C:\\srv\\gem' });
    expect(k.getPtyEnvVars('a1', '/p', [])).toMatchObject({ GROK_HOME: 'C:\\srv\\grok' });
  });

  it("GROK_CONFIG and GROK_CONFIG_PATH are the user's: never taken for grok's home, set or changed for the grok Tars starts", async () => {
    process.env.GROK_CONFIG_PATH = '/srv/overlay.toml';
    process.env.GROK_CONFIG = '{"models":{"default":"x"}}';
    const k = await grok();
    expect(k.configDir).not.toContain('/srv');
    expect(line(k)).not.toMatch(/GROK_CONFIG/);
    expect(Object.keys(k.getPtyEnvVars('a1', '/p', [])).filter((n) => n.startsWith('GROK_CONFIG'))).toEqual([]);
  });
});
