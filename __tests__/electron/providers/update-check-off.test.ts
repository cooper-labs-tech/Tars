import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * No CLI's own update flow runs in a terminal Tars starts (27/11): Tars types tasks into these terminals, a bracketed
 * paste then Enter, and whatever the CLI draws at that moment takes them. Measured on the owner's codex 0.163 in a
 * throwaway home (reports/cli-update-prompts, codex-start-probe.mjs): with a newer codex on record it draws "Update
 * available" and a menu whose first entry, "Update now", runs npm install -g; a typed task's Enter picks it (Backend-3
 * on 0.163, the #601 stack on 0.170). The others, read in their published code: gemini 0.71 installs a newer version
 * itself (its update command, detached, through a shell) unless its settings say no, and has no environment switch;
 * grok, opencode and pi each read one variable that turns their check off. Tars's own updates of claude and Amp stay
 * as they are (services/cli-updater.ts, the owner's choice in Settings).
 *
 * How it fails, written before the code:
 * 1. A codex agent's line, started anew, resumed or forked, still checks for an update at start: no
 *    `-c check_for_update_on_startup=false` (the 0.163 key, read in its binary; codex ignores a key it does not know).
 * 2. A gemini agent starts without Tars's system settings, or with settings that leave the check or the
 *    self-install on (general.enableAutoUpdateNotification, general.enableAutoUpdate).
 * 3. Those settings written into the user's own ~/.gemini/settings.json, or anywhere but Tars's folder.
 * 4. An administrator's gemini system settings lost: Tars's file replaces theirs, so a policy they set is gone; or
 *    Tars's value wins where theirs says otherwise. And an administrator's file that cannot be read is skipped
 *    silently, as if there were none.
 * 5. grok, opencode or pi started without the variable that turns their check off (GROK_DISABLE_AUTOUPDATER,
 *    OPENCODE_DISABLE_AUTOUPDATE, PI_SKIP_VERSION_CHECK), in the terminal's environment.
 * 6. On macOS and Linux the switch only in the environment: the terminal runs a login shell, whose rc files run after
 *    it and can set it back (`export OPENCODE_DISABLE_AUTOUPDATE=0`). It goes on the line, before the binary, as
 *    codex's CODEX_HOME does.
 * 7. On Windows an `env` word on the line: there the line's first word is the binary itself (platform/launch.ts) and
 *    nothing is sourced, so the environment is where it goes.
 * 8. A switch handed to a binary that does not read it (a claude variable on grok), which looks like coverage and is
 *    none; or a CLI Tars runs that nobody classified.
 */

import { CodexProvider } from '../../../electron/providers/codex-provider';
import { GeminiProvider } from '../../../electron/providers/gemini-provider';
import { GrokProvider } from '../../../electron/providers/grok-provider';
import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { PiProvider } from '../../../electron/providers/pi-provider';
import { managedCliEnv } from '../../../electron/providers/cli-provider';
import { getAllProviders } from '../../../electron/providers';
import { DATA_DIR } from '../../../electron/constants';

/** The argv a POSIX shell makes of a line: single and double quotes, and backslash escapes. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue; }
    if (quote === '"') { if (ch === '"') quote = null; else if (ch === '\\' && i + 1 < line.length) cur += line[++i]; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; had = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; had = true; continue; }
    if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** The `env NAME=value` words a line starts with, and the binary after them. */
function leadingEnv(line: string): { env: Record<string, string>; binary: string | undefined } {
  const argv = words(line);
  const env: Record<string, string> = {};
  if (argv[0] !== 'env') return { env, binary: argv[0] };
  let i = 1;
  for (; i < argv.length && /^[A-Z_][A-Z0-9_]*=/.test(argv[i]); i++) {
    const eq = argv[i].indexOf('=');
    env[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
  }
  return { env, binary: argv[i] };
}

const asPlatform = <T>(platform: NodeJS.Platform, fn: () => T): T => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
};

const ENV_SWITCH: Record<string, [string, string]> = {
  grok: ['GROK_DISABLE_AUTOUPDATER', '1'],
  opencode: ['OPENCODE_DISABLE_AUTOUPDATE', '1'],
  pi: ['PI_SKIP_VERSION_CHECK', '1'],
};
const PROMPT = "fix it, it's \"quoted\"";

let codexBin = '';
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-update-off-'));
  codexBin = path.join(dir, 'codex');
  fs.writeFileSync(codexBin, "#!/bin/sh\necho 'Codex CLI'\n", { mode: 0o755 });
});

const adminBefore = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
afterEach(() => {
  if (adminBefore === undefined) delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  else process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = adminBefore;
});

describe('codex', () => {
  const provider = new CodexProvider();
  const check = ['-c', 'check_for_update_on_startup=false'];
  /** How many times the line passes the switch: once, never twice (#625 adds the same switch on the 2.0.7 train). */
  const checksOff = (argv: string[]) => argv.filter((w, i) => w === check[0] && argv[i + 1] === check[1]).length;

  it('1: every interactive line switches its update check off, once: a start, a resume, a fork, with a model', () => {
    for (const extra of [{}, { model: 'gpt-6-luna', effort: 'low' }, { resumeSessionId: '019a0000-0000-7000-8000-000000000001' }, { resumeSessionId: '019a0000-0000-7000-8000-000000000001', forkSession: true }]) {
      expect(checksOff(words(provider.buildInteractiveCommand({ binaryPath: codexBin, prompt: PROMPT, ...extra }))), JSON.stringify(extra)).toBe(1);
    }
  });

  it('1, 7: on Windows too, where the line starts with the binary', () => {
    const argv = asPlatform('win32', () => words(provider.buildInteractiveCommand({ binaryPath: codexBin, prompt: PROMPT })));
    expect(argv[0]).toBe(codexBin);
    expect(checksOff(argv)).toBe(1);
  });
});

describe('gemini', () => {
  const provider = new GeminiProvider();
  const tarsFile = path.join(DATA_DIR, 'gemini', 'system-settings.json');

  it('2, 3, 6: its line on macOS and Linux names Tars\'s system settings before the binary, and so does its environment', () => {
    delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    const env = provider.getPtyEnvVars('agent-1', os.tmpdir(), []);
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(tarsFile);
    const { env: onLine, binary } = asPlatform('darwin', () => leadingEnv(provider.buildInteractiveCommand({ binaryPath: '/opt/gemini', prompt: PROMPT })));
    expect(onLine.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(tarsFile);
    expect(binary).toBe('/opt/gemini');
    const written = JSON.parse(fs.readFileSync(tarsFile, 'utf8'));
    expect(written.general).toMatchObject({ enableAutoUpdate: false, enableAutoUpdateNotification: false });
    expect(path.resolve(tarsFile).startsWith(path.resolve(DATA_DIR) + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(os.homedir(), '.gemini', 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gemini', 'settings.json'), 'utf8')).general : undefined).toBeUndefined();
  });

  it('7: on Windows, the environment only', () => {
    const { env: onLine, binary } = asPlatform('win32', () => leadingEnv(provider.buildInteractiveCommand({ binaryPath: 'C:\\gemini\\gemini.cmd', prompt: PROMPT })));
    expect(onLine).toEqual({});
    expect(binary).toBe('C:\\gemini\\gemini.cmd');
  });

  it('4: an administrator\'s system settings are kept, and theirs win where both say something', () => {
    const admin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-admin-')), 'settings.json');
    fs.writeFileSync(admin, JSON.stringify({ general: { enableAutoUpdate: true }, tools: { sandbox: 'docker' } }));
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = admin;
    const env = provider.getPtyEnvVars('agent-1', os.tmpdir(), []);
    expect(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(tarsFile);
    const written = JSON.parse(fs.readFileSync(tarsFile, 'utf8'));
    expect(written.tools).toEqual({ sandbox: 'docker' });
    expect(written.general).toEqual({ enableAutoUpdate: true, enableAutoUpdateNotification: false });
  });

  it('4: an administrator\'s file that cannot be read stops the launch, saying why', () => {
    const admin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-admin-')), 'settings.json');
    fs.mkdirSync(admin);
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = admin;
    expect(() => provider.getPtyEnvVars('agent-1', os.tmpdir(), [])).toThrow(/system settings/);
  });
});

describe('grok, opencode and pi', () => {
  const providers = { grok: new GrokProvider(), opencode: new OpenCodeProvider(), pi: new PiProvider() };

  for (const [name, provider] of Object.entries(providers)) {
    const [variable, value] = ENV_SWITCH[name];

    it(`5: ${name} gets ${variable}=${value} in its terminal's environment`, () => {
      expect(managedCliEnv(provider.binaryName)).toEqual({ [variable]: value });
    });

    it(`6: ${name}'s line on macOS and Linux sets it before the binary`, () => {
      for (const platform of ['darwin', 'linux'] as const) {
        const { env, binary } = asPlatform(platform, () => leadingEnv(provider.buildInteractiveCommand({ binaryPath: `/opt/${name}`, prompt: PROMPT })));
        expect(env, platform).toEqual({ [variable]: value });
        expect(binary, platform).toBe(`/opt/${name}`);
      }
    });

    it(`7: ${name}'s line on Windows starts with the binary`, () => {
      const { env, binary } = asPlatform('win32', () => leadingEnv(provider.buildInteractiveCommand({ binaryPath: `C:\\${name}\\${name}.exe`, prompt: PROMPT })));
      expect(env).toEqual({});
      expect(binary).toBe(`C:\\${name}\\${name}.exe`);
    });
  }
});

describe('every CLI Tars runs is classified', () => {
  it('8: each binary has its own switch, or a reason it needs none here, and none gets another\'s', () => {
    const elsewhere: Record<string, string> = {
      claude: 'DISABLE_AUTOUPDATER in managedCliEnv (cli-provider.ts), for the claude binary and the providers that re-point it',
      codex: '-c check_for_update_on_startup=false on its line',
      gemini: 'its system settings, Tars\'s file, named on its line and in its environment',
      qwen: 'general.enableAutoUpdate=false in the per-agent system settings (services/qwen-code.ts)',
      amp: 'amp.updates.mode "disabled" in the managed settings file (amp-provider.ts)',
    };
    const binaries = [...new Set(getAllProviders().map((p) => p.binaryName))].sort();
    const unclassified = binaries.filter((b) => !(b in ENV_SWITCH) && !(b in elsewhere));
    expect(unclassified, 'a CLI nobody classified: measure its update check and add its switch').toEqual([]);
    for (const binary of binaries) {
      const env = managedCliEnv(binary);
      if (binary in ENV_SWITCH) expect(env, binary).toEqual({ [ENV_SWITCH[binary][0]]: ENV_SWITCH[binary][1] });
      else if (binary !== 'claude') expect(env, binary).toEqual({});
    }
  });
});
