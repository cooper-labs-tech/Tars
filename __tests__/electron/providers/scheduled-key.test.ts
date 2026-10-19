import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * A scheduled task on a key provider hands `claude -p` its key, or does not run (the Audit's M1 on #458, 2.0.4).
 *
 * Measured on Claude Code 2.1.302 against a stand-in of the vendor (dbe-key-providers-1810/measure-print): `claude -p`
 * with ANTHROPIC_API_KEY empty or unset, and a subscription signed in, sends the subscription's OAuth token as a
 * Bearer to the vendor's URL; with ANTHROPIC_AUTH_TOKEN the key and ANTHROPIC_API_KEY empty, the key; with
 * ANTHROPIC_AUTH_TOKEN empty, the OAuth token again. Each of these scripts points ANTHROPIC_BASE_URL at the vendor,
 * and read the key with jq, which macOS ships only from 15 (Tars runs on 13) and a minimal Linux has not.
 *
 * The ways it fails, each script run here by bash with no jq on its PATH:
 * 1. jq absent: the key reads empty, and claude runs against the vendor, on the subscription's token.
 * 2. The key removed from Settings after the task was scheduled, or the settings unreadable: the same.
 * 3. The key handed as ANTHROPIC_API_KEY, or a shell's ANTHROPIC_API_KEY left set beside it.
 * 4. The key in claude's arguments, or written into the script, which stays on disk.
 * 5. A refusal that says nothing: the task's log must say why it did not run, and claude must not start.
 */

import { getProvider } from '../../../electron/providers';

const KEY = 'sk-e2e-scheduled-0123456789abcdef0123';
/** Each key provider's scheduled script and the setting its key is read from, the vendor's own or OpenRouter's. */
const SCRIPTS: Array<[provider: string, setting: string]> = [
  ['deepseek', 'deepSeekApiKey'], ['moonshot', 'moonshotApiKey'], ['zhipu', 'zhipuApiKey'], ['minimax', 'minimaxApiKey'],
  ['openrouter', 'openRouterApiKey'], ['mimo', 'openRouterApiKey'], ['qwen', 'openRouterApiKey'], ['nvidia', 'openRouterApiKey'],
  ['nous-portal', 'openRouterApiKey'], ['ollama-cloud', 'ollamaCloudApiKey'],
];

const home = os.homedir();
const settingsFile = path.join(home, '.dorothy', 'app-settings.json');
let bin: string;
let claude: string;
let record: string;

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sched-bin-'));
  // node, and nothing else of the machine's: no jq. A script, not a link: the suite's guard reads a link's target.
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  record = path.join(bin, 'claude.record');
  claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\n{ echo "AUTH=\${ANTHROPIC_AUTH_TOKEN-<unset>}"; echo "API=\${ANTHROPIC_API_KEY-<unset>}"; echo "BASE=\${ANTHROPIC_BASE_URL-<unset>}"; echo "ARGS=$*"; } > '${record}'\n`, { mode: 0o755 });
});

beforeEach(() => {
  fs.rmSync(record, { force: true });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
});

/** The script of `provider` for a task scheduled while the settings were `scheduledWith`, run once they are `runWith`. */
function runScript(provider: string, scheduledWith: Record<string, unknown>, runWith: Record<string, unknown> | null, env: Record<string, string> = {}) {
  fs.writeFileSync(settingsFile, JSON.stringify(scheduledWith, null, 2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sched-'));
  const log = path.join(dir, 'task.log');
  const script = getProvider(provider as never).buildScheduledScript!({
    binaryPath: claude, binaryDir: bin, projectPath: dir, prompt: 'the task', autonomous: true,
    mcpConfigPath: path.join(dir, 'mcp.json'), logPath: log, homeDir: home,
  });
  const file = path.join(dir, 'task.sh');
  fs.writeFileSync(file, script, { mode: 0o700 });
  if (runWith === null) fs.rmSync(settingsFile, { force: true });
  else fs.writeFileSync(settingsFile, JSON.stringify(runWith, null, 2));
  const run = spawnSync('/bin/bash', [file], { env: { PATH: `${bin}:/bin`, HOME: home, ...env }, encoding: 'utf8' });
  const ran = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : null;
  return { script, ran, status: run.status, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

describe('a scheduled task on a key provider', () => {
  it('runs where no jq is', () => {
    expect(spawnSync('/bin/bash', ['-c', 'command -v jq'], { env: { PATH: `${bin}:/bin` } }).status).not.toBe(0);
    expect(execFileSync('/bin/bash', ['-c', 'command -v node'], { env: { PATH: `${bin}:/bin` }, encoding: 'utf8' }).trim()).toBe(path.join(bin, 'node'));
  });

  for (const [provider, setting] of SCRIPTS) {
    it(`${provider}: 1, 3, 4. hands claude the key as the auth token, the API key emptied, with no jq, in no argument`, () => {
      const r = runScript(provider, { [setting]: KEY }, { [setting]: KEY }, { ANTHROPIC_API_KEY: 'sk-ant-api03-the-shell-key' });
      expect(r.ran, r.log).not.toBeNull();
      expect(r.ran).toContain(`AUTH=${KEY}\n`);
      expect(r.ran).toContain('API=\n');
      expect(r.ran).toMatch(/BASE=https:\/\/\S+/);
      expect(r.ran!.split('\n').find(l => l.startsWith('ARGS='))).not.toContain(KEY);
      expect(r.script).not.toContain(KEY);
    });

    it(`${provider}: 2, 5. does not start claude when the key is gone or the settings unreadable, and says why`, () => {
      for (const after of [{ [setting]: '' }, {}, null]) {
        const r = runScript(provider, { [setting]: KEY }, after);
        expect(r.ran, JSON.stringify(after)).toBeNull();
        expect(r.status).not.toBe(0);
        expect(r.log).toMatch(new RegExp(`Not run: no ${setting}`));
      }
    });
  }
});
