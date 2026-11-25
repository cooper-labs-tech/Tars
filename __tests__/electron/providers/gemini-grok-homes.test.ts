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
 *
 * Written before the code, on the Audit's read of 85bc5c575, red there:
 * 7. gemini handed GEMINI_CLI_HOME when Tars's own environment names none: gemini 0.70.0's launcher reads
 *    $GEMINI_CLI_HOME/settings.json, the home itself, where the CLI reads $GEMINI_CLI_HOME/.gemini, so a user's
 *    advanced.autoConfigureMemory: false in ~/.gemini/settings.json is lost, and gemini relaunches with a heap ceiling of
 *    half the RAM (measured isolated on 25/11: --max-old-space-size=12288 of 24 GB with GEMINI_CLI_HOME=$HOME, none
 *    without). Named, the value is handed; named by nobody, an rc file's is taken off the line (`env -u`). grok's one
 *    binary reads the same with GROK_HOME unset or set to ~/.grok (`grok inspect`, measured): it is handed always.
 * 8. A value that is not an absolute folder taken for a home (a relative one is read from wherever the CLI runs): it is
 *    taken as unset (I-1). A value with a space, a quote, a `;` or a `$` reaching the line unquoted.
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

  it("7: gemini's line takes an rc file's GEMINI_CLI_HOME off when Tars names none, and grok's hands its default", async () => {
    const os = await import('os');
    const g = await gemini();
    expect(line(g)).toMatch(/^env -u GEMINI_CLI_HOME '\/opt\/bin\/cli'/);
    expect(oneShot(g)).toMatch(/^env -u GEMINI_CLI_HOME '\/opt\/bin\/cli'/);
    expect(Object.keys(g.getPtyEnvVars('a1', '/p', []))).not.toContain('GEMINI_CLI_HOME');
    expect(g.configDir).toBe(`${os.homedir()}/.gemini`);
    expect(line(await grok())).toContain(`env GROK_HOME='${os.homedir()}/.grok'`);
  });

  it('8: a relative home is taken as unset; a value with a space, a quote, a ; or a $ is quoted whole', async () => {
    const os = await import('os');
    const { geminiCliHome } = await import('../../../electron/providers/gemini-provider');
    const { grokHome } = await import('../../../electron/providers/grok-provider');
    expect(geminiCliHome({ GEMINI_CLI_HOME: 'rel/home' }, '/home/me')).toBe('/home/me');
    expect(grokHome({ GROK_HOME: './grok' }, '/home/me')).toBe('/home/me/.grok');
    process.env.GEMINI_CLI_HOME = 'rel/home';
    expect(line(await gemini())).toMatch(/^env -u GEMINI_CLI_HOME /);
    vi.resetModules();
    const odd = "/srv/a b'c;$x";
    process.env.GEMINI_CLI_HOME = odd;
    process.env.GROK_HOME = odd;
    expect(line(await gemini())).toContain(`env GEMINI_CLI_HOME='/srv/a b'\\''c;$x' '/opt/bin/cli'`);
    expect(line(await grok())).toContain(`env GROK_HOME='/srv/a b'\\''c;$x' '/opt/bin/cli'`);
    expect(os.homedir()).not.toBe(odd);
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
